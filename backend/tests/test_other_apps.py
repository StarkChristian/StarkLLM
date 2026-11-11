"""Other programs on the PC (Settings > Other apps): the OpenAI-compatible API at /v1 and the MCP server at /mcp.

Before, /v1 answered any program on the PC without a key, and its "starkllm-rag" model never added document text."""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.auth import create_access_token, get_password_hash
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services import connections_service

client = TestClient(app)


@pytest.fixture
def user(tmp_path, monkeypatch):
    monkeypatch.setattr(connections_service, "CONFIG_PATH", str(tmp_path / "connections.json"))
    name = f"apps_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        u = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(u)
        db.commit()
        ws = models.Workspace(name="My documents", user_id=u.id)
        db.add(ws)
        db.commit()
        db.add(models.Document(workspace_id=ws.id, filename="Steuerbescheid.pdf", filepath=str(tmp_path / "s.pdf"),
                               file_type="pdf", status="indexed"))
        db.commit()
        uid = u.id
    finally:
        db.close()
    return {"id": uid, "headers": {"Authorization": f"Bearer {create_access_token({'sub': name})}"}}


def _key(user):
    client.put("/api/v1/connections", json={"enabled": True}, headers=user["headers"])
    return client.post("/api/v1/connections/keys", json={"name": "VS Code"}, headers=user["headers"]).json()


def test_off_by_default_and_a_key_is_needed(user):
    assert client.get("/api/v1/connections", headers=user["headers"]).json() == {"enabled": False, "keys": []}
    r = client.get("/v1/models")
    assert r.status_code == 401 and "turned off" in r.json()["detail"]
    key = _key(user)["key"]
    assert client.get("/v1/models").status_code == 401  # on, but no key
    assert client.get("/v1/models", headers={"Authorization": "Bearer sk-stark-wrong"}).status_code == 401
    assert client.get("/v1/models", headers={"Authorization": f"Bearer {key}"}).status_code == 200


def test_keys_are_kept_only_as_hashes_and_can_be_deleted(user):
    made = _key(user)
    assert made["key"].startswith("sk-stark-") and len(made["key"]) > 40
    stored = open(connections_service.CONFIG_PATH).read()
    assert made["key"] not in stored and connections_service._hash(made["key"]) in stored
    listed = client.get("/api/v1/connections", headers=user["headers"]).json()["keys"]
    assert [k["name"] for k in listed] == ["VS Code"] and "key" not in listed[0] and "hash" not in listed[0]
    assert client.delete(f"/api/v1/connections/keys/{made['id']}", headers=user["headers"]).json() == {"ok": True}
    assert client.get("/v1/models", headers={"Authorization": f"Bearer {made['key']}"}).status_code == 401


def test_turning_it_off_closes_access_for_existing_keys(user):
    key = _key(user)["key"]
    client.put("/api/v1/connections", json={"enabled": False}, headers=user["headers"])
    assert client.get("/v1/models", headers={"Authorization": f"Bearer {key}"}).status_code == 401


def _rpc(key, method, params=None, msg_id=1):
    body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if msg_id is not None:
        body["id"] = msg_id
    return client.post("/mcp", json=body, headers={"Authorization": f"Bearer {key}"})


def test_mcp_handshake_and_tools(user):
    assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).status_code == 401
    key = _key(user)["key"]
    init = _rpc(key, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}}).json()
    assert init["result"]["serverInfo"]["name"] == "StarkLLM" and init["result"]["protocolVersion"] == "2025-06-18"
    assert _rpc(key, "notifications/initialized", msg_id=None).status_code == 202
    tools = {t["name"] for t in _rpc(key, "tools/list").json()["result"]["tools"]}
    assert tools == {"search_documents", "ask_documents", "upcoming_dates", "list_documents"}
    listed = _rpc(key, "tools/call", {"name": "list_documents", "arguments": {}}).json()["result"]
    assert listed["isError"] is False and "Steuerbescheid.pdf" in listed["content"][0]["text"]
    dates = _rpc(key, "tools/call", {"name": "upcoming_dates", "arguments": {"days": 30}}).json()["result"]
    assert '"today"' in dates["content"][0]["text"]
    assert _rpc(key, "no/such").json()["error"]["code"] == -32601
