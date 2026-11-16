"""The engine answers only requests addressed to this PC, and changes only come from StarkLLM's own pages or programs
on the PC: protection against DNS rebinding (a web page that reaches 127.0.0.1 through the browser)."""
from fastapi.testclient import TestClient

from app.main import app, _host_name

client = TestClient(app)


def test_host_names():
    assert _host_name("127.0.0.1:18000") == "127.0.0.1"
    assert _host_name("localhost") == "localhost"
    assert _host_name("[::1]:8000") == "::1"
    assert _host_name("http://evil.example:80/x") == "evil.example"


def test_a_foreign_host_name_is_refused():
    assert client.get("/health", headers={"host": "127.0.0.1:18000"}).status_code == 200
    assert client.get("/health", headers={"host": "localhost:5173"}).status_code == 200
    r = client.get("/health", headers={"host": "rebind.attacker.example"})
    assert r.status_code == 403 and "this PC" in r.json()["detail"]


def test_changes_from_another_web_site_are_refused_but_reading_and_local_pages_work():
    def blocked(r):
        return r.status_code == 403 and "other web sites" in r.json().get("detail", "")
    evil = {"origin": "https://attacker.example"}
    assert blocked(client.post("/api/v1/auth/desktop-session", headers=evil))
    assert not blocked(client.post("/api/v1/auth/desktop-session", headers={"origin": "http://127.0.0.1:15173"}))
    assert not blocked(client.post("/api/v1/auth/desktop-session"))  # programs on the PC send no Origin
    assert client.get("/health", headers=evil).status_code == 200  # reading is answered; CORS keeps it from the page
