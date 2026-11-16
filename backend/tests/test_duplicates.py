"""B4: a letter uploaded twice is kept once."""
def test_the_same_file_twice_is_kept_once(tmp_path, monkeypatch):
    # B4: a letter uploaded again (or from phone and scanner) would be read twice and show its dates twice
    import uuid
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api import documents as docs_api
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.core.config import settings
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))
    monkeypatch.setattr(docs_api, "_index_document_background", lambda *a, **k: None)
    name = f"dup_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        db.add(ws)
        db.commit()
        ws_id = ws.id
    finally:
        db.close()
    client = TestClient(app)
    h = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    first = client.post(f"/api/v1/documents/{ws_id}/upload", files={"file": ("Brief.txt", b"Bitte zahlen Sie 10,00 EUR.")}, headers=h).json()
    again = client.post(f"/api/v1/documents/{ws_id}/upload", files={"file": ("Brief (1).txt", b"Bitte zahlen Sie 10,00 EUR.")}, headers=h).json()
    other = client.post(f"/api/v1/documents/{ws_id}/upload", files={"file": ("Brief2.txt", b"Bitte zahlen Sie 20,00 EUR.")}, headers=h).json()
    assert again["duplicate"] is True and again["id"] == first["id"] and again["filename"] == "Brief.txt"
    assert "duplicate" not in first and "duplicate" not in other and other["id"] != first["id"]
    assert len(list(tmp_path.iterdir())) == 2  # the second copy was not kept
