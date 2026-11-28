"""Protected storage of uploaded documents (B6).

Documents the user uploads (data/uploads) are written through this module. While protection is on they are stored
encrypted under the same path and file name, so nothing that refers to a document by its path (database rows, the
vector store's "source" field) changes. A protected file starts with the magic bytes SLLMENC; every reader here
accepts protected and plain files, so old plain documents keep working until the migration has protected them.

Code that needs a real file for a library (PDF, Word, OCR) uses `plain_path()`: a temporary decrypted copy in the
engine's scratch folder (data/tmp) that is removed afterwards. It is wiped at every engine start, too.
"""
import contextlib
import hashlib
import logging
import os
import shutil
import tempfile
from typing import Iterator

from app.core import crypto
from app.core.config import settings
from app.core.protection import protection

logger = logging.getLogger(__name__)


def _files_key() -> bytes:
    return protection.sub_key("files")


def is_protected(path: str) -> bool:
    return crypto.is_encrypted_file(path)


def temp_dir() -> str:
    path = os.path.abspath(settings.TEMP_DIR)
    os.makedirs(path, exist_ok=True)
    return path


def wipe_temp():
    """Remove decrypted scratch copies left behind by a crash."""
    shutil.rmtree(os.path.abspath(settings.TEMP_DIR), ignore_errors=True)


def size(path: str) -> int:
    """Size of the document itself (not of the protected file on disk)."""
    n = os.path.getsize(path)
    return crypto.plain_size(n) if is_protected(path) else n


def _write_key(workspace_id=None) -> bytes:
    """The key a new document is protected with: the shared workspace's own files key (services/household.py) for a
    document of a shared workspace, else the PC's files key."""
    if workspace_id is not None:
        from app.services import household
        key = household.files_key_for_write(workspace_id)
        if key is not None:
            return key
    return _files_key()


def _read_key(path: str) -> bytes:
    """The key a protected file needs, chosen by the key id in its header: the PC's files key, or the files key of a
    shared workspace. An unknown id gives the PC's key, and reading then fails with WrongKey."""
    key = _files_key()
    kid = crypto.file_key_id(path)
    if kid and kid != crypto.key_id(key):
        from app.services import household
        return household.files_key_by_id(kid) or key
    return key


def open_write(path: str, workspace_id=None):
    """Writer for a new document: protected if protection is on. Use as a context manager. workspace_id: the
    workspace the document belongs to (a shared workspace's documents are protected with its own key)."""
    if protection.writes_protected():
        return crypto.create_encrypted(path, _write_key(workspace_id))
    return open(path, "wb")


def write_bytes(path: str, data: bytes, workspace_id=None):
    with open_write(path, workspace_id) as f:
        f.write(data)


def write_text(path: str, text: str, workspace_id=None):
    write_bytes(path, text.encode("utf-8"), workspace_id)


def iter_bytes(path: str, block: int = 1 << 20) -> Iterator[bytes]:
    if is_protected(path):
        yield from crypto.iter_decrypted(path, _read_key(path))
        return
    with open(path, "rb") as f:
        while True:
            data = f.read(block)
            if not data:
                return
            yield data


def read_bytes(path: str) -> bytes:
    return b"".join(iter_bytes(path))


def read_text(path: str, encoding: str = "utf-8-sig", errors: str = "replace") -> str:
    return read_bytes(path).decode(encoding, errors)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    for block in iter_bytes(path):
        h.update(block)
    return h.hexdigest()


@contextlib.contextmanager
def plain_path(path: str):
    """A path to the readable content of the document: the file itself if it is plain, else a temporary decrypted
    copy (same extension) that is deleted afterwards."""
    if not is_protected(path):
        yield path
        return
    folder = tempfile.mkdtemp(dir=temp_dir())
    try:
        copy = os.path.join(folder, os.path.basename(path))
        with open(copy, "wb") as out:
            for block in iter_bytes(path):
                out.write(block)
        yield copy
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def protect_file(path: str) -> bool:
    """Encrypt a plain file in place. The result is read back and compared before the plain file is replaced, so a
    failure at any point leaves the original untouched. Returns False if the file was already protected."""
    if is_protected(path):
        return False
    key = _files_key()
    tmp = path + ".protecting"
    try:
        h_plain, h_back = hashlib.sha256(), hashlib.sha256()
        with open(path, "rb") as src, crypto.create_encrypted(tmp, key) as out:
            for block in iter(lambda: src.read(1 << 20), b""):
                h_plain.update(block)
                out.write(block)
        for block in crypto.iter_decrypted(tmp, key):
            h_back.update(block)
        if h_plain.digest() != h_back.digest():
            raise crypto.CorruptData("The protected copy does not match the original.")
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
        return True
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def unprotect_file(path: str) -> bool:
    """The reverse of protect_file (used when protection is switched off)."""
    if not is_protected(path):
        return False
    key = _read_key(path)
    tmp = path + ".unprotecting"
    try:
        h_plain, h_back = hashlib.sha256(), hashlib.sha256()
        with open(tmp, "wb") as out:
            for block in crypto.iter_decrypted(path, key):
                h_plain.update(block)
                out.write(block)
        with open(tmp, "rb") as back:
            for block in iter(lambda: back.read(1 << 20), b""):
                h_back.update(block)
        if h_plain.digest() != h_back.digest():
            raise crypto.CorruptData("The unprotected copy does not match.")
        os.replace(tmp, path)
        return True
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def rekey_file(path: str, new_key: bytes) -> bool:
    """Protect a protected file again with another key (a shared workspace's new key version, after a member left).
    Like protect_file: the new copy is read back and compared before it replaces the file, so a failure at any point
    leaves the old file, which still opens. Returns False if the file already uses new_key or is not protected."""
    if not is_protected(path) or crypto.file_key_id(path) == crypto.key_id(new_key):
        return False
    old_key = _read_key(path)
    tmp = path + ".rekeying"
    try:
        h_plain, h_back = hashlib.sha256(), hashlib.sha256()
        with crypto.create_encrypted(tmp, new_key) as out:
            for block in crypto.iter_decrypted(path, old_key):
                h_plain.update(block)
                out.write(block)
        for block in crypto.iter_decrypted(tmp, new_key):
            h_back.update(block)
        if h_plain.digest() != h_back.digest():
            raise crypto.CorruptData("The copy with the new key does not match the original.")
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
        return True
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def file_response(path: str, media_type: str, filename: str):
    """HTTP response with the document: the plain file as before, a protected file decrypted while it is sent."""
    from fastapi.responses import FileResponse, StreamingResponse
    from urllib.parse import quote
    if not is_protected(path):
        return FileResponse(path, media_type=media_type, filename=filename)
    # Verify the whole file first: a changed file must give an error, not a half-sent download.
    for _ in iter_bytes(path):
        pass
    return StreamingResponse(iter_bytes(path), media_type=media_type, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "Content-Length": str(size(path)),
    })
