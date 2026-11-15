"""Names and titles stored protected (B6 follow-up): workspace and folder names, chat titles, file names, prompt
titles. They must be unreadable on disk, still listed and searched, and part of the migration."""
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api.auth import create_access_token, get_password_hash
from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services import label_search

LOCK = "\U0001F512"


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    os.makedirs(settings.UPLOAD_DIR)
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    name = f"lab_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user); db.commit()
        ws = models.Workspace(name="Müller Steuern 2025", user_id=user.id); db.add(ws); db.commit()
        folder = models.ChatFolder(workspace_id=ws.id, name="Vermieter Post"); db.add(folder); db.commit()
        chat = models.Chat(workspace_id=ws.id, title="Kündigung Wohnung", folder_id=folder.id); db.add(chat); db.commit()
        doc = models.Document(workspace_id=ws.id, filename="Bescheid_ÄNDERUNG.pdf", filepath="/nowhere/x.pdf",
                              file_type="pdf", error_message="could not read Bescheid_ÄNDERUNG.pdf")
        db.add(doc); db.commit()
        tpl = models.PromptTemplate(user_id=user.id, title="Mahnung beantworten", content="Sehr geehrte", tags="post,miete")
        db.add(tpl); db.commit()
        ids = dict(user=user.id, ws=ws.id, folder=folder.id, chat=chat.id, doc=doc.id, tpl=tpl.id)
    finally:
        db.close()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    yield type("W", (), {"ids": ids, "headers": headers, "client": TestClient(app), "tmp": tmp_path})
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def raw(sql, **params):
    db = SessionLocal()
    try:
        return db.execute(text(sql), params).scalar()
    finally:
        db.close()


def test_labels_are_stored_protected_and_read_back(world):
    i = world.ids
    for sql, plain in [
        ("select name from workspaces where id=:i", "Müller"), ("select name from chat_folders where id=:i", "Vermieter"),
        ("select title from chats where id=:i", "Kündigung"), ("select filename from documents where id=:i", "Bescheid"),
        ("select error_message from documents where id=:i", "Bescheid"), ("select title from prompt_templates where id=:i", "Mahnung"),
        ("select tags from prompt_templates where id=:i", "miete"),
    ]:
        key = {"i": i["ws"] if "workspaces" in sql else i["folder"] if "folders" in sql else i["chat"] if "chats" in sql
               else i["doc"] if "documents" in sql else i["tpl"]}
        value = raw(sql, **key)
        assert value.startswith(crypto.TOKEN_PREFIX) and plain not in value, sql
    db = SessionLocal()
    try:
        assert db.get(models.Workspace, i["ws"]).name == "Müller Steuern 2025"
        assert db.get(models.Chat, i["chat"]).title == "Kündigung Wohnung"
        assert db.get(models.Document, i["doc"]).filename == "Bescheid_ÄNDERUNG.pdf"
        assert db.get(models.PromptTemplate, i["tpl"]).tags == "post,miete"
    finally:
        db.close()


def test_locked_engine_lists_labels_as_locked_instead_of_failing(world):
    protection.clear_key()
    db = SessionLocal()
    try:
        assert db.get(models.Workspace, world.ids["ws"]).name == LOCK
        assert db.get(models.Chat, world.ids["chat"]).title == LOCK
        assert db.get(models.Document, world.ids["doc"]).error_message is None
    finally:
        db.close()


def test_global_search_finds_protected_names_titles_and_files(world):
    def search(q):
        r = world.client.get("/api/v1/search/global", params={"q": q}, headers=world.headers)
        assert r.status_code == 200, r.text
        return r.json()
    assert [w["name"] for w in search("müller")["workspaces"]] == ["Müller Steuern 2025"]       # case-insensitive, non-ASCII
    assert [c["title"] for c in search("KÜNDIGUNG")["chats"]] == ["Kündigung Wohnung"]
    assert [d["name"] for d in search("änderung")["documents"]] == ["Bescheid_ÄNDERUNG.pdf"]
    assert search("gibtesnicht") == {"chats": [], "workspaces": [], "documents": []} or not any(search("gibtesnicht").values())


def test_chat_list_search_and_citation_lookup_with_protected_names(world):
    wid = world.ids["ws"]
    hit = world.client.get(f"/api/v1/chat/sessions/{wid}", params={"q": "wohnung"}, headers=world.headers).json()
    assert [c["title"] for c in hit] == ["Kündigung Wohnung"]
    assert world.client.get(f"/api/v1/chat/sessions/{wid}", params={"q": "zzz"}, headers=world.headers).json() == []
    exact = world.client.get(f"/api/v1/documents/{wid}/documents/lookup", params={"filename": "Bescheid_ÄNDERUNG.pdf (Page 3)"},
                             headers=world.headers)
    assert exact.status_code == 200 and exact.json()["filename"] == "Bescheid_ÄNDERUNG.pdf"
    part = world.client.get(f"/api/v1/documents/{wid}/documents/lookup", params={"filename": "bescheid_änder"}, headers=world.headers)
    assert part.status_code == 200
    assert world.client.get(f"/api/v1/documents/{wid}/documents/lookup", params={"filename": "nope.pdf"}, headers=world.headers).status_code == 404


def test_new_upload_gets_an_opaque_name_on_disk_and_keeps_its_name_in_the_app(world, monkeypatch):
    from app.api import documents as docs_api
    monkeypatch.setattr(docs_api, "_index_document_background", lambda *a, **k: None)
    r = world.client.post(f"/api/v1/documents/{world.ids['ws']}/upload", files={"file": ("Kündigung Frau Müller.txt", b"Hallo Welt")},
                          headers=world.headers).json()
    assert r["filename"] == "Kündigung Frau Müller.txt"
    on_disk = os.path.basename(r["filepath"])
    assert "Kündigung" not in on_disk and "Müller" not in on_disk and on_disk.endswith(".txt")
    assert os.listdir(settings.UPLOAD_DIR) == [on_disk]


def test_upload_keeps_the_readable_disk_name_while_protection_is_off(world, monkeypatch):
    from app.api import documents as docs_api
    monkeypatch.setattr(docs_api, "_index_document_background", lambda *a, **k: None)
    protection.mark_enabled(False)
    r = world.client.post(f"/api/v1/documents/{world.ids['ws']}/upload", files={"file": ("Brief.txt", b"Hallo")}, headers=world.headers).json()
    assert os.path.basename(r["filepath"]).endswith("_Brief.txt")


def test_labels_are_decrypted_once_and_the_cache_dies_with_the_key(world, monkeypatch):
    calls = {"n": 0}
    real = crypto.decrypt_text

    def counting(*a, **k):
        calls["n"] += 1
        return real(*a, **k)
    monkeypatch.setattr(crypto, "decrypt_text", counting)
    protection._label_cache.clear()
    for _ in range(3):
        world.client.get("/api/v1/search/global", params={"q": "müller"}, headers=world.headers)
    first = calls["n"]
    world.client.get("/api/v1/search/global", params={"q": "müller"}, headers=world.headers)
    assert calls["n"] == first and first > 0                    # a repeated search decrypts nothing
    protection.clear_key()
    assert len(protection._label_cache) == 0


def test_label_search_helpers():
    assert label_search.contains("Ärger mit dem Amt", "ärger") and not label_search.contains(None, "x")
    rows = ["a1", "b2", "A3", "c4"]
    assert label_search.filter_rows(rows, lambda s: s, "A", 2) == ["a1", "A3"]
    pairs = [(1, "Steuer 2025"), (2, "Miete"), (3, "STEUERBESCHEID"), (4, None)]
    assert label_search.matching_ids(pairs, "steuer") == [1, 3]
    assert label_search.matching_ids(pairs, "steuer", 1) == [1]
    assert label_search.matching_ids(pairs, "nope") == []


def test_summary_works_while_locked(world):
    protection.clear_key()
    r = world.client.get("/api/v1/system/protection/summary", headers=world.headers)
    assert r.status_code == 200 and r.json()["locked"] is True
