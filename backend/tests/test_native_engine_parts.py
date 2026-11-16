"""The engine without Docker (serve_native.py, Windows engine package) finds what the Docker image has built in."""
import os
import subprocess
import sys
from pathlib import Path

import serve_native
from app.services import voice_service as V

BACKEND_DIR = Path(__file__).resolve().parents[1]


def test_bundled_reranker_model_is_used(tmp_path):
    env = {}
    assert serve_native.use_bundled_models(str(tmp_path), env) is False, "no model folder: nothing set"
    (tmp_path / "models" / "ms-marco-TinyBERT-L-2-v2").mkdir(parents=True)
    assert serve_native.use_bundled_models(str(tmp_path), env) is True
    assert env["STARKLLM_RERANKER_DIR"] == str(tmp_path / "models")
    mine = {"STARKLLM_RERANKER_DIR": "/elsewhere"}
    assert serve_native.use_bundled_models(str(tmp_path), mine) is False and mine["STARKLLM_RERANKER_DIR"] == "/elsewhere"


def test_built_in_voices_do_not_depend_on_the_working_directory(tmp_path):
    # the engine without Docker runs in the user's StarkLLM folder, not in the code folder
    code = "import json; from app.services import voice_service as V; print(json.dumps([v['id'] for v in V.available_voices()]))"
    env = {**os.environ, "PYTHONPATH": str(BACKEND_DIR), "SQLITE_URL": f"sqlite:///{tmp_path / 'db.sqlite'}"}
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    voices = r.stdout.strip().splitlines()[-1]
    assert "en_US-lessac-medium" in voices and "de_DE-thorsten-medium" in voices
    for path in V.VOICE_MODELS.values():
        assert os.path.isabs(path) and os.path.isfile(path), path


def test_piper_runs_through_the_engine_python():
    # no `piper` program on PATH in the Windows package: the module of the same Python is used
    assert V.piper_command() == [sys.executable, "-m", "piper"]
