"""
watch_service.py — watched folders for letters (2.7, plan option 8).

The user picks folders (the scanner's output folder, Downloads\\Letters) and a workspace for each. New PDFs, pictures
and Word files that appear there go into that workspace's inbox through the same steps as an upload
(api/documents.add_file_from_disk: a copy, encrypted while protection is on, the same-bytes check, then the indexing
with OCR, facts, deadlines and the checks).

Rules:
* A file is imported once it has kept its size and time for WATCH_STABLE_SECONDS (a scanner may still be writing it)
  and can be opened.
* Files whose bytes were imported (or seen) before are skipped (sha256 per folder, and the workspace's own same-bytes
  check). Temporary files (~$x.docx, .part, .crdownload: other extensions are not looked at) and hidden files are
  skipped.
* The user's file is never deleted. It is moved only when the user turned on "Move imported files into an 'imported'
  subfolder" (off by default); then into <folder>\\imported, never over another file.
* Only the folder itself is watched, not its subfolders (so the "imported" subfolder is never read again).
* Watching runs while the engine runs (it starts and stops with StarkLLM). The first look after the start is the
  catch-up: files that arrived while StarkLLM was closed are imported then.
* Nothing is read or imported while protection is locked or being switched on or off.

The polling follows the knowledge base watcher (kb_service: folder_files, mtime polling, a thread that stops with
the engine); the inbox flow is separate from the knowledge base.
"""
import hashlib
import logging
import os
import shutil
import threading
import time
from typing import Optional

from app.core.config import settings
from app.core.protection import ProtectionLocked, protection
from app.db import models
from app.services.kb_service import folder_files

logger = logging.getLogger(__name__)

# PDF, pictures and Word, as the upload takes them
LETTER_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".docx"}
IMPORTED_SUBFOLDER = "imported"
MAX_BYTES = 100 * 1024 * 1024          # as the upload
HISTORY_LIMIT = 200
IMPORTED = ("imported", "duplicate")   # in the inbox: such a file may be moved into the "imported" subfolder

FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4
FILE_ATTRIBUTE_TEMPORARY = 0x100


def skip_reason(name: str, st=None) -> Optional[str]:
    """Why a file of a watched folder is not a letter to import: None, "temporary" or "hidden"."""
    lower = name.lower()
    if os.path.splitext(lower)[1] not in LETTER_EXTENSIONS:
        return "type"
    if name.startswith("~") or lower.startswith(".~lock"):
        return "temporary"            # Word's "~$Brief.docx" while it is open, LibreOffice's lock file
    if name.startswith("."):
        return "hidden"
    attributes = getattr(st, "st_file_attributes", 0) if st is not None else 0
    if attributes & FILE_ATTRIBUTE_TEMPORARY:
        return "temporary"
    if attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM):
        return "hidden"
    return None


def is_network_path(path: str) -> bool:
    """A shared folder of another computer (\\\\server\\share, or a drive letter mapped to one)."""
    if path.startswith("\\\\") or path.startswith("//"):
        return True
    if os.name == "nt":
        try:
            import ctypes
            drive = os.path.splitdrive(os.path.abspath(path))[0]
            if drive:
                return ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == 4   # DRIVE_REMOTE
        except Exception:
            return False
    return False


def normalized(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def data_folder() -> str:
    """StarkLLM's own data folder (the upload folder is in it): never watched, its copies would come back as letters."""
    return normalized(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)))


def _inside(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def check_folder(path: str) -> str:
    """The folder as it is stored, or ValueError with what is wrong (shown to the user)."""
    raw = (path or "").strip().strip('"')
    if not raw or not (os.path.isabs(raw) or raw.startswith("\\\\")):
        raise ValueError("Please enter the full path of a folder on this PC.")
    full = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(full):
        raise ValueError("This folder was not found on this PC.")
    if _inside(normalized(full), data_folder()):
        raise ValueError("This is StarkLLM's own data folder. Please choose another folder.")
    return full


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _readable(path: str) -> bool:
    """The writer is done with it: it can be opened (on Windows a file being written is often locked)."""
    try:
        with open(path, "rb") as f:
            f.read(1)
        return True
    except OSError:
        return False


def move_to_imported(folder_path: str, path: str) -> str:
    """Moves the file into <folder>\\imported; a name that is taken gets " (2)", " (3)" ... Never overwrites."""
    target_dir = os.path.join(folder_path, IMPORTED_SUBFOLDER)
    os.makedirs(target_dir, exist_ok=True)
    base, ext = os.path.splitext(os.path.basename(path))
    target = os.path.join(target_dir, base + ext)
    n = 2
    while os.path.exists(target):
        target = os.path.join(target_dir, f"{base} ({n}){ext}")
        n += 1
    shutil.move(path, target)
    return target


def folder_label(path: str) -> str:
    return os.path.basename(os.path.normpath(path or "")) or (path or "")


def migration_running() -> bool:
    try:
        return (protection.state().get("migration") or {}).get("state") == "running"
    except Exception:
        return False


class FolderWatcher:
    def __init__(self, clock=time.time):
        self.clock = clock
        self._lock = threading.RLock()
        self._pending: dict = {}      # (folder_id, path) -> (size, mtime_ns, first seen with this size)
        self._done: dict = {}         # (folder_id, path) -> (size, mtime_ns) of a file that was dealt with
        self._known: dict = {}        # folder_id -> {(name, size, mtime_ns): status} of the history (no hashing)
        self._missing: set = set()    # folders whose missing path was logged already
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # -- the history ---------------------------------------------------------------------------------------------
    def _record(self, db, folder, name, status, *, digest=None, st=None, error=None, document_id=None, moved=False):
        row = models.WatchedImport(
            user_id=folder.user_id, folder_id=folder.id, workspace_id=folder.workspace_id, document_id=document_id,
            file_name=name, sha256=digest, file_size=getattr(st, "st_size", None), mtime_ns=getattr(st, "st_mtime_ns", None),
            status=status, error=error, moved=1 if moved else 0,
            announced=0 if status in ("imported", "failed") else 1)
        db.add(row)
        db.commit()
        if st is not None:
            self._known_files(db, folder.id)[(name, st.st_size, st.st_mtime_ns)] = status
        return row

    def _known_files(self, db, folder_id: int) -> dict:
        """{(name, size, mtime_ns): status} of the folder's history: a file seen before is not even hashed again.
        A failed one is not tried again by itself either (the history offers "Try again")."""
        if folder_id not in self._known:
            rows = db.query(models.WatchedImport).filter(models.WatchedImport.folder_id == folder_id).all()
            self._known[folder_id] = {(r.file_name, r.file_size, r.mtime_ns): r.status for r in rows
                                      if r.file_size is not None}
        return self._known[folder_id]

    def _seen(self, db, folder_id: int, digest: str) -> Optional[str]:
        """The status of these bytes in the folder's history, or None."""
        row = db.query(models.WatchedImport.status).filter(
            models.WatchedImport.folder_id == folder_id, models.WatchedImport.sha256 == digest).first()
        return row[0] if row else None

    def forget_folder(self, folder_id: int):
        with self._lock:
            for store in (self._pending, self._done):
                for key in [k for k in store if k[0] == folder_id]:
                    store.pop(key, None)
            self._known.pop(folder_id, None)
            self._missing.discard(folder_id)

    def forget_file(self, folder_id: int):
        """A failed import is to be tried again: the folder's files are looked at anew."""
        self.forget_folder(folder_id)

    # -- adding a folder -----------------------------------------------------------------------------------------
    def candidates(self, folder_path: str) -> dict:
        return {p: st for p, st in folder_files(folder_path, LETTER_EXTENSIONS, recursive=False).items()
                if skip_reason(os.path.basename(p), st) is None and st.st_size > 0}

    def mark_existing(self, db, folder) -> int:
        """The files in the folder when it is added, if they are not to be imported: remembered, not imported."""
        count = 0
        with self._lock:
            for path, st in self.candidates(folder.folder_path).items():
                try:
                    digest = _sha256(path)
                except OSError:
                    continue
                self._record(db, folder, os.path.basename(path), "existing", digest=digest, st=st)
                self._done[(folder.id, path)] = (st.st_size, st.st_mtime_ns)
                count += 1
        return count

    # -- looking at the folders ----------------------------------------------------------------------------------
    def poll_once(self, folder_id: Optional[int] = None) -> dict:
        """One look at the active folders (or one): imports what is ready. Returns counts (for tests and the log)."""
        counts = {"imported": 0, "duplicate": 0, "failed": 0, "skipped": 0, "waiting": 0}
        if protection.locked or migration_running():
            return counts
        from app.db.session import SessionLocal
        with self._lock:
            db = SessionLocal()
            try:
                query = db.query(models.WatchedFolder).filter(models.WatchedFolder.is_active == 1)
                if folder_id is not None:
                    query = query.filter(models.WatchedFolder.id == folder_id)
                for folder in query.all():
                    try:
                        self._poll_folder(db, folder, counts)
                    except ProtectionLocked:
                        break
                    except Exception as e:
                        db.rollback()
                        logger.error(f"Watched folder {folder.id}: {e}", exc_info=True)
            finally:
                db.close()
        return counts

    def _poll_folder(self, db, folder, counts: dict):
        path = folder.folder_path
        if not path or not os.path.isdir(path):
            if folder.id not in self._missing:
                self._missing.add(folder.id)
                logger.warning(f"Watched folder {folder.id} cannot be read (moved, renamed, or on a drive that is not "
                               "connected). It is checked again when it comes back.")
            return
        self._missing.discard(folder.id)
        workspace = db.query(models.Workspace).filter(models.Workspace.id == folder.workspace_id,
                                                      models.Workspace.user_id == folder.user_id).first()
        if workspace is None:
            return
        now = self.clock()
        present = set()
        known = self._known_files(db, folder.id)
        for file_path, st in self.candidates(path).items():
            key = (folder.id, file_path)
            present.add(key)
            signature = (st.st_size, st.st_mtime_ns)
            if self._done.get(key) == signature:
                continue
            name = os.path.basename(file_path)
            seen = known.get((name, st.st_size, st.st_mtime_ns))
            if seen is not None:                                     # in the history already: no hashing needed
                self._done[key] = signature
                if seen in IMPORTED:
                    self._move_if_wanted(db, folder, file_path, None)
                continue
            pending = self._pending.get(key)
            if pending is None or pending[:2] != signature:
                self._pending[key] = (*signature, now)               # new or still growing: wait until it stays
                counts["waiting"] += 1
                continue
            if now - pending[2] < settings.WATCH_STABLE_SECONDS or not _readable(file_path):
                counts["waiting"] += 1
                continue
            self._pending.pop(key, None)
            self._done[key] = signature
            counts[self._import(db, folder, file_path, st)] += 1
        for store in (self._pending, self._done):                    # files that went away
            for key in [k for k in store if k[0] == folder.id and k not in present]:
                store.pop(key, None)

    def _import(self, db, folder, file_path: str, st) -> str:
        from app.api.documents import add_file_from_disk
        name = os.path.basename(file_path)
        if st.st_size > MAX_BYTES:
            self._record(db, folder, name, "failed", st=st,
                         error=f"too_large: {st.st_size // (1024 * 1024)} MB")
            return "failed"
        try:
            digest = _sha256(file_path)
        except OSError as e:
            self._record(db, folder, name, "failed", st=st, error=f"unreadable: {e.strerror or e}")
            return "failed"
        seen = self._seen(db, folder.id, digest)
        if seen is not None:                           # these bytes came from this folder before: nothing to do
            if seen in IMPORTED:
                self._move_if_wanted(db, folder, file_path, None)
            return "skipped"
        try:
            doc, duplicate = add_file_from_disk(db, folder.workspace_id, folder.user_id, file_path, name)
        except ProtectionLocked:
            self._done.pop((folder.id, file_path), None)              # tried again once StarkLLM is unlocked
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Watched folder {folder.id}: import failed: {e}", exc_info=True)
            self._record(db, folder, name, "failed", digest=digest, st=st, error=f"import: {e}")
            return "failed"
        status = "duplicate" if duplicate else "imported"
        row = self._record(db, folder, name, status, digest=digest, st=st, document_id=doc.id)
        self._move_if_wanted(db, folder, file_path, row)
        logger.info(f"Watched folder {folder.id}: {status} as document {doc.id}")
        return status

    def _move_if_wanted(self, db, folder, file_path: str, row):
        """Only when the user turned it on; an error is noted in the history, the file then stays where it is."""
        if not folder.move_imported or not os.path.exists(file_path):
            return
        try:
            move_to_imported(folder.folder_path, file_path)
            if row is not None:
                row.moved = 1
                db.commit()
            self._done.pop((folder.id, file_path), None)
        except OSError as e:
            logger.warning(f"Watched folder {folder.id}: could not move an imported file: {e}")
            if row is not None:
                row.error = f"move: {e.strerror or e}"
                db.commit()

    # -- the thread ----------------------------------------------------------------------------------------------
    def _loop(self):
        logger.info("Watched folders: started (the first look imports what arrived while StarkLLM was closed)")
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as e:
                logger.error(f"Watched folders: {e}", exc_info=True)
            self._stop.wait(max(1, settings.WATCH_INTERVAL_SECONDS))
        logger.info("Watched folders: stopped")

    def start(self):
        if os.environ.get("STARKLLM_WATCH_FOLDERS", "on") == "off":
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="Watched-Folders", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)


watcher = FolderWatcher()


def notices(db, user_id: int) -> dict:
    """Imports and failures not announced yet, per folder ("3 letters imported from Scans"); marks them announced."""
    rows = (db.query(models.WatchedImport, models.WatchedFolder)
            .join(models.WatchedFolder, models.WatchedImport.folder_id == models.WatchedFolder.id)
            .filter(models.WatchedImport.user_id == user_id, models.WatchedImport.announced == 0).all())
    imported, failed = {}, {}
    for row, folder in rows:
        target = imported if row.status == "imported" else failed if row.status == "failed" else None
        if target is not None:
            label = folder_label(folder.folder_path)
            target[label] = target.get(label, 0) + 1
        row.announced = 1
    db.commit()
    as_list = lambda d: [{"folder": k, "count": v} for k, v in sorted(d.items())]  # noqa: E731
    return {"imported": as_list(imported), "failed": as_list(failed)}
