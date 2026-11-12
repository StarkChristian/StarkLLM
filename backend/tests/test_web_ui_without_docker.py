"""Roadmap phase 2 (StarkLLM without Docker): the backend serves the built web UI itself.

In Docker, nginx serves the UI and passes /api/ to the backend. Without Docker there is no nginx, so with
STARKLLM_STATIC_DIR set the backend answers UI files and UI routes on the API port, while every API path keeps its
meaning. Runs in a separate Python process, because the UI routes are added when app.main is imported.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

PROBE = r"""
import json, sys
from fastapi.testclient import TestClient
from app.main import app
c = TestClient(app)
out = {}
for path in ["/", "/settings", "/chat/42", "/assets/app.js", "/health", "/api/v1/version",
             "/api/v1/does-not-exist", "/v1/does-not-exist", "/../secret.txt", "/assets/../../secret.txt"]:
    r = c.get(path)
    out[path] = {"status": r.status_code, "body": r.text[:200], "cache": r.headers.get("cache-control", "")}
print(json.dumps(out))
"""


def _probe(tmp_path, static_dir):
    env = {**os.environ, "SQLITE_URL": f"sqlite:///{tmp_path / 'db.sqlite'}", "PYTHONPATH": str(BACKEND_DIR)}
    if static_dir is None:
        env.pop("STARKLLM_STATIC_DIR", None)
    else:
        env["STARKLLM_STATIC_DIR"] = str(static_dir)
    r = subprocess.run([sys.executable, "-c", PROBE], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-2000:]
    return json.loads(r.stdout.strip().splitlines()[-1])


def _built_ui(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>StarkLLM</title><div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log('ui')")
    (tmp_path / "secret.txt").write_text("not part of the UI")
    return dist


def test_backend_serves_the_web_ui_and_keeps_the_api(tmp_path):
    out = _probe(tmp_path, _built_ui(tmp_path))
    for route in ["/", "/settings", "/chat/42"]:
        assert out[route]["status"] == 200 and "<title>StarkLLM</title>" in out[route]["body"], route
        assert out[route]["cache"] == "no-store", "the app page must not be cached across updates"
    assert out["/assets/app.js"]["status"] == 200 and "console.log('ui')" in out["/assets/app.js"]["body"]
    assert "immutable" in out["/assets/app.js"]["cache"]
    # the API keeps priority and unknown API paths are not answered with the UI
    assert json.loads(out["/health"]["body"])["status"] == "ok"
    assert "version" in json.loads(out["/api/v1/version"]["body"])
    assert out["/api/v1/does-not-exist"]["status"] == 404
    assert out["/v1/does-not-exist"]["status"] == 404
    # nothing outside the UI folder
    for path in ["/../secret.txt", "/assets/../../secret.txt"]:
        assert "not part of the UI" not in out[path]["body"], path


def test_without_static_dir_nothing_changes(tmp_path):
    out = _probe(tmp_path, None)
    assert out["/"]["status"] == 404
    assert out["/settings"]["status"] == 404
    assert json.loads(out["/health"]["body"])["status"] == "ok"
