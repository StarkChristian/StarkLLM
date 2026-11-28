"""Watched folders for letters (2.7, plan option 8): new files in a folder go into a workspace's inbox like an upload.
The stable-size wait, duplicates, the filters, the catch-up at the start, the optional move, protection at rest and
the Settings API."""
import os
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import documents as docs_api
from app.api.auth import create_access_token, get_password_hash
from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.db import models
from app.db.session import SessionLocal, engine
from app.main import app
from app.services import vault, watch_service
from app.services.watch_service import FolderWatcher

client = TestClient(app)
PDF = b"%PDF-1.4\n" + b"Finanzamt Rheinstadt, Bescheid 2025, Nachzahlung 412,00 EUR\n" * 20


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "data" / "uploads"))
    monkeypatch.setattr(settings, "WATCH_STABLE_SECONDS", 4)
    indexed = []
    monkeypatch.setattr(docs_api, "_index_document_background", lambda *a, **k: indexed.append(a))
    scans = tmp_path / "Scans"
    scans.mkdir()
    name = f"watch_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        db.add(ws)
        db.commit()
        user_id, ws_id = user.id, ws.id
    finally:
        db.close()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    yield SimpleNamespace(tmp=tmp_path, scans=scans, user_id=user_id, ws_id=ws_id, headers=headers, indexed=indexed)
    db = SessionLocal()
    try:   # rows of this test go, so no other test meets them (some are protected)
        folders = [f.id for f in db.query(models.WatchedFolder.id).filter(models.WatchedFolder.user_id == user_id)]
        db.query(models.WatchedImport).filter(models.WatchedImport.user_id == user_id).delete(synchronize_session=False)
        db.query(models.WatchedFolder).filter(models.WatchedFolder.user_id == user_id).delete(synchronize_session=False)
        db.query(models.Document).filter(models.Document.workspace_id == ws_id).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
    for folder_id in folders:
        watch_service.watcher.forget_folder(folder_id)


def _add(env, path=None, **options):
    body = {"folder_path": str(path or env.scans), "workspace_id": env.ws_id, **options}
    return client.post("/api/v1/watch-folders/", json=body, headers=env.headers)


def _docs(env):
    db = SessionLocal()
    try:
        return [(d.filename, d.filepath) for d in db.query(models.Document).filter(models.Document.workspace_id == env.ws_id)
                .order_by(models.Document.id)]
    finally:
        db.close()


def _history(env):
    return client.get("/api/v1/watch-folders/history", headers=env.headers).json()


def _settle(watcher, clock, folder_id, rounds=2):
    """Two looks some seconds apart: what has kept its size is imported."""
    counts = []
    for _ in range(rounds):
        counts.append(watcher.poll_once(folder_id))
        clock.now += 5
    return counts


# -- the stable-size wait ------------------------------------------------------------------------------------------
def test_a_file_is_imported_only_after_it_stopped_growing(env):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    scan = env.scans / "Scan_0001.pdf"
    scan.write_bytes(PDF[:40])                      # the scanner starts writing
    assert w.poll_once(folder["id"])["waiting"] == 1
    clock.now += 2
    with open(scan, "ab") as f:
        f.write(PDF[40:])                           # still writing: the size changed
    assert w.poll_once(folder["id"])["waiting"] == 1
    clock.now += 2                                  # unchanged, but only for 2 s
    assert w.poll_once(folder["id"])["imported"] == 0
    assert _docs(env) == []
    clock.now += 3                                  # unchanged for 5 s now
    assert w.poll_once(folder["id"])["imported"] == 1
    docs = _docs(env)
    assert [d[0] for d in docs] == ["Scan_0001.pdf"]
    assert vault.read_bytes(docs[0][1]) == PDF      # the whole file, not the part written first
    assert len(env.indexed) == 1                    # the same indexing as an upload (OCR, facts, deadlines, checks)
    assert scan.read_bytes() == PDF                 # the user's file is untouched
    assert w.poll_once(folder["id"])["imported"] == 0


def test_an_empty_file_waits(env):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    (env.scans / "Scan_0002.pdf").write_bytes(b"")
    _settle(w, clock, folder["id"], rounds=3)
    assert _docs(env) == []


# -- duplicates ----------------------------------------------------------------------------------------------------
def test_the_same_bytes_are_not_imported_twice(env):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    (env.scans / "Brief.pdf").write_bytes(PDF)
    _settle(w, clock, folder["id"])
    (env.scans / "Brief (1).pdf").write_bytes(PDF)      # the same letter again, under another name
    counts = _settle(w, clock, folder["id"])
    assert sum(c["imported"] for c in counts) == 0 and sum(c["skipped"] for c in counts) == 1
    assert [d[0] for d in _docs(env)] == ["Brief.pdf"]
    # after a restart nothing comes back either
    w2 = FolderWatcher(clock=clock)
    counts = _settle(w2, clock, folder["id"])
    assert sum(c["imported"] for c in counts) == 0
    assert len(_docs(env)) == 1


def test_a_letter_that_was_uploaded_by_hand_is_a_duplicate(env):
    up = client.post(f"/api/v1/documents/{env.ws_id}/upload", files={"file": ("Steuer.pdf", PDF)}, headers=env.headers)
    assert up.status_code == 200
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    (env.scans / "Scan_0003.pdf").write_bytes(PDF)
    counts = _settle(w, clock, folder["id"])
    assert sum(c["duplicate"] for c in counts) == 1
    assert [d[0] for d in _docs(env)] == ["Steuer.pdf"]
    hist = _history(env)
    assert [(h["file_name"], h["status"], h["document_id"]) for h in hist] == [("Scan_0003.pdf", "duplicate", up.json()["id"])]
    assert len(os.listdir(settings.UPLOAD_DIR)) == 1     # no second copy was kept


# -- filters -------------------------------------------------------------------------------------------------------
def test_temporary_hidden_and_other_files_are_skipped(env):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    for name in ["~$Brief.docx", ".~lock.Brief.docx#", ".versteckt.pdf", "Notiz.txt", "Scan.pdf.part",
                 "Brief.pdf.crdownload", "Scan.tmp", "desktop.ini"]:
        (env.scans / name).write_bytes(PDF)
    (env.scans / "Unterordner").mkdir()
    (env.scans / "Unterordner" / "Alt.pdf").write_bytes(PDF + b"1")   # subfolders are not watched
    (env.scans / "Foto.JPG").write_bytes(b"\xff\xd8\xff" + PDF)
    (env.scans / "Antwort.docx").write_bytes(b"PK\x03\x04" + PDF)
    _settle(w, clock, folder["id"])
    assert sorted(d[0] for d in _docs(env)) == ["Antwort.docx", "Foto.JPG"]


def test_hidden_and_temporary_attributes_of_windows_are_skipped():
    assert watch_service.skip_reason("Brief.pdf", SimpleNamespace(st_file_attributes=0x2)) == "hidden"
    assert watch_service.skip_reason("Brief.pdf", SimpleNamespace(st_file_attributes=0x4)) == "hidden"
    assert watch_service.skip_reason("Brief.pdf", SimpleNamespace(st_file_attributes=0x100)) == "temporary"
    assert watch_service.skip_reason("Brief.pdf", SimpleNamespace(st_file_attributes=0x20)) is None   # "archive"
    assert watch_service.skip_reason("~WRL0001.tmp") == "type"
    assert watch_service.skip_reason("Scan.TIFF") is None


# -- the catch-up at the start -------------------------------------------------------------------------------------
def test_files_that_arrived_while_starkllm_was_closed_are_imported_at_the_start(env):
    (env.scans / "Alt_2024.pdf").write_bytes(PDF + b"old")
    folder = _add(env).json()
    assert folder["existing_files"] == 1                 # there before: remembered, not imported
    clock = Clock()
    w = FolderWatcher(clock=clock)
    _settle(w, clock, folder["id"])
    assert _docs(env) == []
    # StarkLLM is closed (no watcher); a letter is scanned meanwhile
    (env.scans / "Scan_0004.pdf").write_bytes(PDF + b"new")
    started = FolderWatcher(clock=clock)                 # the next start: its first looks are the catch-up
    _settle(started, clock, folder["id"])
    assert [d[0] for d in _docs(env)] == ["Scan_0004.pdf"]
    assert (env.scans / "Alt_2024.pdf").exists() and (env.scans / "Scan_0004.pdf").exists()


def test_the_files_already_in_the_folder_can_be_imported_too(env):
    (env.scans / "Alt_2024.pdf").write_bytes(PDF + b"old")
    folder = _add(env, import_existing=True).json()
    assert folder["existing_files"] == 0
    clock = Clock()
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    assert [d[0] for d in _docs(env)] == ["Alt_2024.pdf"]


def test_the_watcher_thread_does_the_catch_up_when_it_starts(env, monkeypatch):
    monkeypatch.setattr(settings, "WATCH_STABLE_SECONDS", 0)
    monkeypatch.setattr(settings, "WATCH_INTERVAL_SECONDS", 1)
    folder = _add(env).json()
    (env.scans / "Scan_0005.pdf").write_bytes(PDF + b"5")
    w = FolderWatcher()
    calls = []
    original = w.poll_once
    monkeypatch.setattr(w, "poll_once", lambda folder_id=None: calls.append(1) or original(folder["id"]))
    w.start()
    try:
        import time
        for _ in range(50):
            if _docs(env):
                break
            time.sleep(0.1)
    finally:
        w.stop()
    assert [d[0] for d in _docs(env)] == ["Scan_0005.pdf"] and calls


# -- never delete; move only when asked ----------------------------------------------------------------------------
def test_files_stay_where_they_are_by_default(env):
    folder = _add(env).json()
    assert folder["move_imported"] is False
    clock = Clock()
    (env.scans / "Scan_0006.pdf").write_bytes(PDF + b"6")
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    assert (env.scans / "Scan_0006.pdf").read_bytes() == PDF + b"6"
    assert not (env.scans / "imported").exists()


def test_imported_files_are_moved_into_the_imported_subfolder_when_turned_on(env):
    folder = _add(env, move_imported=True).json()
    (env.scans / "imported").mkdir()
    (env.scans / "imported" / "Brief.pdf").write_bytes(b"an older file of the user")
    clock = Clock()
    w = FolderWatcher(clock=clock)
    (env.scans / "Brief.pdf").write_bytes(PDF + b"7")
    _settle(w, clock, folder["id"])
    assert not (env.scans / "Brief.pdf").exists()
    assert (env.scans / "imported" / "Brief.pdf").read_bytes() == b"an older file of the user"   # never overwritten
    assert (env.scans / "imported" / "Brief (2).pdf").read_bytes() == PDF + b"7"
    assert [d[0] for d in _docs(env)] == ["Brief.pdf"]
    assert _history(env)[0]["moved"] is True
    # a later copy of the same letter is moved too, and not imported again
    (env.scans / "Brief nochmal.pdf").write_bytes(PDF + b"7")
    _settle(w, clock, folder["id"])
    assert (env.scans / "imported" / "Brief nochmal.pdf").exists() and len(_docs(env)) == 1
    # turning it off: the next file stays
    client.patch(f"/api/v1/watch-folders/{folder['id']}", json={"move_imported": False}, headers=env.headers)
    (env.scans / "Neu.pdf").write_bytes(PDF + b"8")
    _settle(w, clock, folder["id"])
    assert (env.scans / "Neu.pdf").exists() and len(_docs(env)) == 2


def test_files_that_were_there_before_are_not_moved(env):
    (env.scans / "Alt.pdf").write_bytes(PDF + b"old")
    folder = _add(env, move_imported=True).json()
    clock = Clock()
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    assert (env.scans / "Alt.pdf").exists() and _docs(env) == []


# -- errors in the history, notices --------------------------------------------------------------------------------
def test_failures_are_in_the_history_and_can_be_tried_again(env, monkeypatch):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)

    def broken(*a, **k):
        raise RuntimeError("disk full")
    working = docs_api.add_file_from_disk
    monkeypatch.setattr(docs_api, "add_file_from_disk", broken)
    (env.scans / "Scan_0009.pdf").write_bytes(PDF + b"9")
    _settle(w, clock, folder["id"])
    hist = _history(env)
    assert hist[0]["status"] == "failed" and "disk full" in hist[0]["error"]
    _settle(w, clock, folder["id"])
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    assert len(_history(env)) == 1                       # not tried again and again, also not after a restart
    notices = client.post("/api/v1/watch-folders/notices", headers=env.headers).json()
    assert notices == {"imported": [], "failed": [{"folder": "Scans", "count": 1}]}
    monkeypatch.setattr(docs_api, "add_file_from_disk", working)
    assert client.post(f"/api/v1/watch-folders/history/{hist[0]['id']}/retry", headers=env.headers).status_code == 200
    w.forget_folder(folder["id"])
    _settle(w, clock, folder["id"])
    assert [h["status"] for h in _history(env)] == ["imported"]


def test_a_file_that_is_too_large_is_noted_once(env, monkeypatch):
    monkeypatch.setattr(watch_service, "MAX_BYTES", 100)
    folder = _add(env).json()
    clock = Clock()
    (env.scans / "Riesig.pdf").write_bytes(PDF)
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    _settle(FolderWatcher(clock=clock), clock, folder["id"])      # and after a restart
    hist = _history(env)
    assert [(h["status"], h["error"].split(":")[0]) for h in hist] == [("failed", "too_large")]
    assert _docs(env) == []


def test_the_notice_counts_letters_per_folder_once(env):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    for i in range(3):
        (env.scans / f"Scan_10{i}.pdf").write_bytes(PDF + bytes([i]))
    _settle(w, clock, folder["id"])
    first = client.post("/api/v1/watch-folders/notices", headers=env.headers).json()
    assert first == {"imported": [{"folder": "Scans", "count": 3}], "failed": []}
    again = client.post("/api/v1/watch-folders/notices", headers=env.headers).json()
    assert again == {"imported": [], "failed": []}


# -- protection at rest --------------------------------------------------------------------------------------------
@pytest.fixture()
def protected(tmp_path):
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    yield
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def test_imported_letters_are_stored_encrypted_with_protection_on(env, protected):
    folder = _add(env).json()
    clock = Clock()
    (env.scans / "Steuerbescheid Mueller.pdf").write_bytes(PDF + b"secret")
    _settle(FolderWatcher(clock=clock), clock, folder["id"])
    (name, path), = _docs(env)
    assert name == "Steuerbescheid Mueller.pdf"
    assert vault.is_protected(path) and b"Finanzamt" not in open(path, "rb").read()
    assert "Mueller" not in os.path.basename(path)       # the stored copy carries nothing of the name
    assert vault.read_bytes(path) == PDF + b"secret"
    with engine.connect() as con:   # what is on disk: the folder's path and the file names are protected too
        raw_path = con.execute(text("SELECT folder_path FROM watched_folders WHERE id = :i"), {"i": folder["id"]}).scalar()
        raw_names = [r[0] for r in con.execute(text("SELECT file_name FROM watched_imports WHERE folder_id = :i"),
                                               {"i": folder["id"]})]
    assert raw_path and "Scans" not in raw_path
    assert raw_names and all("Mueller" not in n for n in raw_names)


def test_nothing_is_imported_while_protection_is_locked(env, protected):
    folder = _add(env).json()
    clock = Clock()
    w = FolderWatcher(clock=clock)
    (env.scans / "Scan_0011.pdf").write_bytes(PDF + b"11")
    key = protection.key
    protection.clear_key()
    _settle(w, clock, folder["id"])
    protection.set_key(key)
    assert _docs(env) == []
    _settle(w, clock, folder["id"])                      # unlocked: the letter comes in
    assert [d[0] for d in _docs(env)] == ["Scan_0011.pdf"]


# -- the Settings API ----------------------------------------------------------------------------------------------
def test_folders_are_checked_when_they_are_added(env):
    assert _add(env, path=env.tmp / "gibt-es-nicht").status_code == 400
    assert _add(env, path="Scans").status_code == 400                            # not a full path
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    assert _add(env, path=settings.UPLOAD_DIR).status_code == 400                # StarkLLM's own data
    ok = _add(env)
    assert ok.status_code == 200 and ok.json()["network"] is False and ok.json()["folder_name"] == "Scans"
    assert _add(env).status_code == 409
    listed = client.get("/api/v1/watch-folders/", headers=env.headers).json()
    assert [(f["folder_name"], f["workspace_id"], f["available"]) for f in listed] == [("Scans", env.ws_id, True)]
    assert client.post("/api/v1/watch-folders/", json={"folder_path": str(env.scans), "workspace_id": 999999},
                       headers=env.headers).status_code == 404
    assert client.delete(f"/api/v1/watch-folders/{ok.json()['id']}", headers=env.headers).status_code == 200
    assert client.get("/api/v1/watch-folders/", headers=env.headers).json() == []
    assert env.scans.exists()                                                     # removing only stops watching


def test_network_paths_are_recognised():
    assert watch_service.is_network_path("\\\\nas\\Scans")
    assert watch_service.is_network_path("//nas/Scans")
    assert not watch_service.is_network_path("/home/user/Scans")


def test_deleting_the_workspace_stops_watching(env):
    folder = _add(env).json()
    assert client.delete(f"/api/v1/workspaces/{env.ws_id}", headers=env.headers).status_code == 200
    db = SessionLocal()
    try:
        assert db.query(models.WatchedFolder).filter(models.WatchedFolder.id == folder["id"]).first() is None
    finally:
        db.close()
