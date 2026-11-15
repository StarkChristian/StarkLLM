"""Roadmap phase 3, "provable privacy": every outgoing connection of the engine goes through app/core/netguard.py, is
recorded there, and is refused while the app is fully offline.

The most important test is the first one: it fails when somebody adds code that opens a connection on its own."""
import http.server
import json
import os
import re
import socket
import sys
import threading
import uuid
from pathlib import Path

import pytest
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core import netguard  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app"
NETGUARD = APP / "core" / "netguard.py"

# Code that talks to a network by itself. Only netguard.py may do this (it is the wrapper).
FORBIDDEN = [
    (r"\brequests\.(get|post|put|patch|delete|head|options|request|Session|session)\s*\(", "requests client"),
    (r"\bimport\s+httpx\b|\bfrom\s+httpx\b", "httpx"),
    (r"\burllib\.request\b|\burlopen\s*\(|\bfrom\s+urllib\s+import\s+request\b", "urllib.request"),
    (r"\bhttp\.client\b|\bHTTPSConnection\b|\bHTTPConnection\b", "http.client"),
    (r"\baiohttp\b|\bwebsockets?\b\s*\.\s*connect|\bsmtplib\b|\bftplib\b|\bimaplib\b|\bpoplib\b|\btelnetlib\b", "other network client"),
    (r"\bsocket\.(create_connection|socket)\s*\(", "raw socket"),
    (r"\bimport\s+primp\b|\bimport\s+openai\b|\bfrom\s+openai\b|\bgoogle\.cloud\b|\bvertexai\b", "a hosted-AI client"),
]
# Libraries with their own client: every use has to sit inside netguard.external(...) (checked below).
OWN_CLIENT = [r"\bDDGS\s*\(", r"\bYouTubeTranscriptApi\s*\(", r"WhisperModel\s*\((?![^)]*local_files_only)"]
# Files that may mention a pattern, and why. Keep this list short and explained.
ALLOWED = {
    # resolves the name host.docker.internal once for the launcher endpoint: a lookup of this PC, no connection
    ("main.py", "raw socket"): "import socket as _socket (name lookup of the Docker host only)",
    # a list of module names the user's code is not allowed to import
    ("system.py", "other network client"): "list of forbidden modules for the code runner",
    ("system.py", "raw socket"): "list of forbidden modules for the code runner",
}


def _python_files():
    return [p for p in APP.rglob("*.py") if p != NETGUARD]


def _code(path: Path) -> str:
    """Source without comments and docstring-ish lines, so a sentence about requests.get( does not count."""
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


def test_no_code_bypasses_the_network_layer():
    found = []
    for path in _python_files():
        text = _code(path)
        for pattern, label in FORBIDDEN:
            for m in re.finditer(pattern, text):
                line = text[: m.start()].count("\n") + 1
                if (path.name, label) in ALLOWED:
                    continue
                found.append(f"{path.relative_to(APP)}:{line}: {label}: {m.group(0)!r}")
    assert not found, ("Outgoing connections must go through app.core.netguard (record + offline switch). Found:\n  "
                       + "\n  ".join(found))


def test_libraries_with_their_own_client_run_inside_the_guard():
    problems = []
    for path in _python_files():
        text = _code(path)
        for pattern in OWN_CLIENT:
            for m in re.finditer(pattern, text):
                before = text[max(0, m.start() - 1500): m.start()]
                if "netguard.external(" not in before and "local_files_only" not in text[m.start(): m.start() + 200]:
                    problems.append(f"{path.relative_to(APP)}: {m.group(0)} is not inside netguard.external(...)")
    assert not problems, "\n".join(problems)


def test_the_guard_can_find_a_violation(tmp_path):
    """The scan itself works: a file with a direct client is reported (so the test above cannot pass by being blind)."""
    bad = "import requests\nrequests.get('https://example.org')\nimport urllib.request\n"
    hits = [label for pattern, label in FORBIDDEN if re.search(pattern, bad)]
    assert "requests client" in hits and "urllib.request" in hits


def test_the_wrapper_is_the_only_place_with_a_client():
    assert "requests." in NETGUARD.read_text(encoding="utf-8")


@pytest.fixture
def net(tmp_path, monkeypatch):
    monkeypatch.setattr(netguard, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("STARKLLM_OFFLINE", raising=False)
    netguard.reset_for_tests()
    netguard.install()
    yield netguard
    netguard.reset_for_tests()


class FakeResponse:
    status_code = 200
    headers = {"Content-Length": "123"}
    history = []
    content = b"x" * 123

    def raise_for_status(self):
        pass

    def json(self):
        return {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def spies(monkeypatch):
    """Counts everything that could carry data out: HTTP adapter sends, real connects and real name lookups."""
    calls = {"send": 0, "connect": 0, "lookup": 0}
    import requests.adapters as adapters

    def send(self, *a, **k):
        calls["send"] += 1
        raise AssertionError("an HTTP request was sent")
    monkeypatch.setattr(adapters.HTTPAdapter, "send", send)
    real_connect, real_lookup = netguard._real_connect, netguard._real_getaddrinfo

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and netguard.classify(str(address[0])) != "this_pc":
            calls["connect"] += 1
        return real_connect(self, address)

    def lookup(host, *a, **k):
        import ipaddress
        try:
            ipaddress.ip_address(str(host))  # a number is not looked up in any DNS
        except ValueError:
            if netguard.classify(str(host)) != "this_pc":
                calls["lookup"] += 1
        return real_lookup(host, *a, **k)
    monkeypatch.setattr(netguard, "_real_connect", connect)
    monkeypatch.setattr(netguard, "_real_getaddrinfo", lookup)
    return calls


# ------------------------------------------------------------------------------------------------ recording
def test_a_connection_is_recorded_with_host_purpose_and_size_but_no_path_or_query(net, monkeypatch):
    monkeypatch.setattr(requests, "get", lambda url, **kw: FakeResponse())
    net.get("https://www.example.org/private/path?q=my+secret+question", feature="web_import", timeout=5)
    [e] = net.entries()
    assert (e["host"], e["feature"], e["bytes_in"], e["outcome"], e["scheme"]) == ("www.example.org", "web_import", 123, "ok", "https")
    assert e["purpose"] and e["time"] and e["zone"] == "internet" and e["source"] == "engine"
    assert "secret" not in json.dumps(e) and "private" not in json.dumps(e)


def test_the_request_size_counts_and_a_failure_is_recorded(net, monkeypatch):
    def boom(url, **kw):
        raise requests.exceptions.ConnectTimeout("slow")
    monkeypatch.setattr(requests, "post", boom)
    with pytest.raises(requests.exceptions.ConnectTimeout):
        net.post("https://api.example.com/v1/chat", feature="cloud_llm", json={"prompt": "x" * 100})
    [e] = net.entries()
    assert e["outcome"] == "error" and "ConnectTimeout" in e["error"] and e["bytes_out"] > 100


def test_a_streamed_answer_is_counted_while_it_is_read(net, monkeypatch):
    class Stream(requests.Response):
        def __init__(self):
            super().__init__()
            self.status_code = 200

        def iter_lines(self, *a, **k):
            yield b"12345"
            yield b"678"
    monkeypatch.setattr(requests, "post", lambda url, **kw: Stream())
    r = net.post("https://api.example.com/v1/chat", feature="cloud_llm", json={}, stream=True)
    assert [l for l in r.iter_lines()] == [b"12345", b"678"]
    [e] = net.entries()
    assert e["bytes_in"] == 8


def test_connections_to_this_pc_are_counted_not_listed(net, monkeypatch):
    monkeypatch.setattr(requests, "get", lambda url, **kw: FakeResponse())
    net.get("http://host.docker.internal:11434/api/tags", feature="ollama")
    net.get("http://127.0.0.1:8000/health", feature="ollama")
    assert net.entries() == [] and net.local_counts() == {"ollama": 2}


def test_a_model_pull_is_listed_as_a_connection_of_the_local_ollama_to_its_registry(net, monkeypatch):
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse())
    net.post("http://host.docker.internal:11434/api/pull", feature="model_download", via="registry.ollama.ai", json={})
    [e] = net.entries()
    assert e["host"] == "registry.ollama.ai" and e["via"] == "local Ollama" and e["feature"] == "model_download"


def test_a_redirect_to_another_host_is_listed_too(net, monkeypatch):
    class Hop:
        headers = {"Location": "https://cdn.other.example/file"}

    class Redirected(FakeResponse):
        history = [Hop()]
    monkeypatch.setattr(requests, "get", lambda url, **kw: Redirected())
    net.get("https://short.example/abc", feature="web_import")
    assert {e["host"] for e in net.entries()} == {"short.example", "cdn.other.example"}


def test_the_log_is_kept_in_the_data_folder_and_can_be_cleared(net, monkeypatch, tmp_path):
    monkeypatch.setattr(requests, "get", lambda url, **kw: FakeResponse())
    net.get("https://a.example/", feature="web_import")
    assert (tmp_path / "network_log.jsonl").read_text().count("\n") >= 1
    net.clear_log()
    assert net.entries() == []


def test_the_log_is_trimmed(net, monkeypatch):
    monkeypatch.setattr(net, "MAX_LOG_BYTES", 2000)
    monkeypatch.setattr(net, "MAX_KEEP", 5)
    for i in range(40):
        net.record("web_import", f"h{i}.example")
    assert len(net.entries(100)) <= 40 and net.entries(1)[0]["host"] == "h39.example"
    assert os.path.getsize(net._log_path()) < 4000


def test_a_library_with_its_own_client_is_recorded(net):
    with net.external("web_search", "duckduckgo.com"):
        pass
    [e] = net.entries()
    assert e["host"] == "duckduckgo.com" and e["feature"] == "web_search" and e["bytes_out"] is None


# ------------------------------------------------------------------------------------------------ offline
def test_offline_state_is_saved_and_starts_on_with_the_environment(net, monkeypatch, tmp_path):
    assert net.is_offline() is False
    net.set_offline(True)
    assert json.loads((tmp_path / "privacy.json").read_text()) == {"offline": True}
    net.reset_for_tests()
    assert net.is_offline() is True  # read back from the file after a restart
    net.set_offline(False)
    net.reset_for_tests()
    monkeypatch.setenv("STARKLLM_OFFLINE", "1")
    assert net.is_offline() is True  # the desktop app starts the engine offline
    monkeypatch.delenv("STARKLLM_OFFLINE")
    net.set_offline(False)  # and it can be turned off afterwards
    assert net.is_offline() is False


def test_offline_every_feature_is_refused_and_nothing_leaves_this_pc(net, spies, tmp_path):
    """The exit test of phase 3: with the switch on, every outgoing path is tried and none of them sends anything."""
    from app.api import dashboard
    from app.services.llm_service import llm_service
    import asyncio
    net.set_offline(True)
    attempts = []

    def attempt(name, fn):
        with pytest.raises(Exception) as e:
            fn()
        attempts.append(name)
        assert isinstance(e.value, net.OfflineBlocked) or "offline" in str(e.value).lower(), (name, e.value)

    for feature in ("web_import", "github_import", "youtube_import", "cloud_llm", "market_prices", "unknown_feature"):
        attempt(feature, lambda f=feature: net.get("https://example.org/x", feature=f))
        attempt(feature + "-post", lambda f=feature: net.post("https://example.org/x", feature=f, json={"a": 1}))
    attempt("lan", lambda: net.get("http://192.168.1.20:1234/v1/models", feature="cloud_llm"))
    for feature, host in (("web_search", "duckduckgo.com"), ("youtube_import", "www.youtube.com"),
                          ("speech_model_download", "huggingface.co")):
        def use(f=feature, h=host):
            with net.external(f, h):
                raise AssertionError("the library ran although the app is offline")
        attempt(feature + "-lib", use)
    attempt("cloud-model", lambda: net.check_model("gpt-oss:120b-cloud"))
    attempt("cloud-model2", lambda: net.check_model("qwen3-coder:480b:cloud"))
    attempt("market", lambda: asyncio.run(dashboard.get_market_prices("GC=F", consent=1, current_user=None)))
    attempt("crypto", lambda: asyncio.run(dashboard.get_crypto_prices("bitcoin", consent=1, current_user=None)))
    attempt("cloud-model-chat", lambda: llm_service.generate_chat("gpt-oss:120b-cloud", [{"role": "user", "content": "hi"}]))
    attempt("chat-cloud", lambda: llm_service.generate_chat("m", [{"role": "user", "content": "hi"}], provider="openai_compatible",
                                                           base_url="https://api.openai.com/v1", api_key="k"))
    attempt("chat-cloud-stream", lambda: list(llm_service.generate_chat(
        "m", [{"role": "user", "content": "hi"}], stream=True, provider="openai_compatible",
        base_url="https://api.deepseek.com/v1", api_key="k")))
    attempt("socket", lambda: socket.create_connection(("93.184.216.34", 80), timeout=1))
    attempt("dns", lambda: socket.getaddrinfo("example.org", 443))
    # the local Ollama is asked to pull a model from its registry: refused before Ollama is even contacted
    pulled = list(llm_service.pull_model_stream("llama3.2:3b"))
    assert "offline" in pulled[0].lower()

    assert len(attempts) >= 25
    assert spies == {"send": 0, "connect": 0, "lookup": 0}, spies
    leaving = [e for e in net.entries(1000) if e["outcome"] != "blocked"]
    assert leaving == [], leaving
    assert len(net.entries(1000)) >= 20  # the attempts are in the log as blocked


def test_offline_still_lets_the_engine_talk_to_the_local_ollama(net):
    """A fake Ollama on this PC answers while the switch is on: the switch blocks the internet, not the product."""
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"models": [{"name": "qwen2.5:7b"}]}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        net.set_offline(True)
        r = net.get(f"http://127.0.0.1:{srv.server_port}/api/tags", feature="ollama", timeout=5)
        assert r.json()["models"][0]["name"] == "qwen2.5:7b"
        assert net.local_counts()["ollama"] == 1 and net.entries() == []
    finally:
        srv.shutdown()


def test_the_socket_layer_blocks_a_library_that_does_not_use_the_wrapper(net, spies):
    """A library that opens a socket by itself cannot reach the internet while offline."""
    net.set_offline(True)
    with pytest.raises(OSError):
        socket.create_connection(("1.1.1.1", 443), timeout=1)
    s = socket.socket()
    assert s.connect_ex(("8.8.8.8", 53)) != 0
    s.close()
    assert spies["connect"] == 0
    assert [e["outcome"] for e in net.entries()] == ["blocked", "blocked"][: len(net.entries())] and net.entries()


def test_a_connection_outside_the_layer_is_listed_as_unattributed_when_online(net, monkeypatch):
    monkeypatch.setattr(netguard, "_real_connect", lambda self, address: None)  # nothing is really opened
    s = socket.socket()
    s.connect(("93.184.216.34", 443))
    s.close()
    [e] = net.entries()
    assert e["feature"] == "unattributed" and e["host"] == "93.184.216.34"


def test_a_connection_inside_the_layer_is_not_listed_twice(net, monkeypatch):
    monkeypatch.setattr(netguard, "_real_connect", lambda self, address: None)

    def fake_get(url, **kw):
        s = socket.socket()
        s.connect(("93.184.216.34", 443))  # what requests does inside the call
        s.close()
        return FakeResponse()
    monkeypatch.setattr(requests, "get", fake_get)
    net.get("https://example.org/", feature="web_import")
    assert [e["feature"] for e in net.entries()] == ["web_import"]


def test_cloud_model_names():
    assert netguard.is_cloud_model("gpt-oss:120b-cloud") and netguard.is_cloud_model("qwen3-coder:480b:cloud")
    assert not netguard.is_cloud_model("qwen2.5:7b") and not netguard.is_cloud_model("cloudy:7b") and not netguard.is_cloud_model("")


def test_classification_of_destinations():
    c = netguard.classify
    assert c("localhost") == c("127.0.0.1") == c("::1") == c("host.docker.internal") == "this_pc"
    assert c("192.168.0.5") == c("10.0.0.2") == c("printer.local") == "lan"
    assert c("api.openai.com") == c("93.184.216.34") == "internet"


def test_the_telemetry_of_the_libraries_is_off_by_default():
    import app.core.config  # noqa: F401
    for name in ("ANONYMIZED_TELEMETRY", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK", "RAGAS_DO_NOT_TRACK"):
        assert os.environ.get(name) not in (None, "", "0", "false", "False") or name == "ANONYMIZED_TELEMETRY" and os.environ[name] == "False"


# ------------------------------------------------------------------------------------------------ the API
@pytest.fixture
def two_users(net):
    from fastapi.testclient import TestClient
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.main import app
    db = SessionLocal()
    made = []
    try:
        for _ in range(2):
            name = f"priv_{uuid.uuid4().hex[:8]}"
            u = models.User(username=name, hashed_password=get_password_hash("x" * 12))
            db.add(u)
            db.commit()
            made.append({"Authorization": f"Bearer {create_access_token({'sub': name})}"})
    finally:
        db.close()
    return TestClient(app), made


def test_api_needs_a_login_and_shows_status_and_log(two_users, monkeypatch):
    client, (h1, h2) = two_users
    assert client.get("/api/v1/privacy/status").status_code == 401
    assert client.get("/api/v1/privacy/network-log").status_code == 401
    monkeypatch.setattr(requests, "get", lambda url, **kw: FakeResponse())
    netguard.get("https://a.example/", feature="web_import")
    body = client.get("/api/v1/privacy/network-log", headers=h2).json()
    assert body["status"]["offline"] is False and body["entries"][0]["host"] == "a.example"
    assert "web_search" in body["features"]


def test_api_turning_offline_on_is_open_to_every_user_turning_it_off_is_for_the_admin(two_users):
    client, (admin, other) = two_users
    assert client.put("/api/v1/privacy/offline", json={"enabled": True}, headers=other).json()["offline"] is True
    assert client.put("/api/v1/privacy/offline", json={"enabled": False}, headers=other).status_code == 403
    assert netguard.is_offline() is True


def test_api_export_as_csv_and_json_without_formula_injection(two_users, monkeypatch):
    client, (h1, h2) = two_users
    netguard.record("web_import", "=HYPERLINK(evil).example")
    csv_text = client.get("/api/v1/privacy/network-log/export?format=csv", headers=h2).text
    assert csv_text.splitlines()[0].startswith("time,source,feature,purpose,host") and "'=HYPERLINK" in csv_text
    rows = client.get("/api/v1/privacy/network-log/export?format=json", headers=h2).json()
    assert rows[0]["host"].startswith("=HYPERLINK")
    assert client.delete("/api/v1/privacy/network-log", headers=h2).json() == {"ok": True}
    assert client.get("/api/v1/privacy/network-log", headers=h2).json()["entries"] == []


# ------------------------------------------------------------------------------------------------ the code runner
def test_a_code_snippet_cannot_open_a_connection_even_through_an_allowed_library():
    from app.api.system import ExecuteCodeRequest, execute_code
    code = "import pandas as pd\npd.read_csv('http://example.org/a.csv')\n"
    out = execute_code(ExecuteCodeRequest(code=code, timeout_seconds=10), current_user=None)
    assert out["exit_code"] != 0 and "no network access" in out["output"], out
    ok = execute_code(ExecuteCodeRequest(code="print(2 + 2)"), current_user=None)
    assert ok["exit_code"] == 0 and ok["stdout"].strip() == "4"
    blocked = execute_code(ExecuteCodeRequest(code="import _socket"), current_user=None)
    assert blocked["exit_code"] == 126
