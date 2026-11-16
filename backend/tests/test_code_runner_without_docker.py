"""Without Docker the chat's Python runner is off (owner decision 2026-11-16): it would run with the user's rights on the
PC itself, and its memory/time limits only exist on Linux. The desktop app starts the engine without Docker with
STARKLLM_CODE_RUNNER=off (desktop/native-engine.js nativeEnv); the web UI hides the "Run" button (/api/v1/version)."""
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.system import CODE_RUNNER_OFF, ExecuteCodeRequest, code_runner_enabled, execute_code


@pytest.mark.parametrize("value", ["off", "OFF", "0", "false", "no", " off "])
def test_off_values_switch_the_runner_off(monkeypatch, value):
    monkeypatch.setenv("STARKLLM_CODE_RUNNER", value)
    assert code_runner_enabled() is False


@pytest.mark.parametrize("value", [None, "", "on", "1"])
def test_the_docker_engine_keeps_the_runner(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("STARKLLM_CODE_RUNNER", raising=False)
    else:
        monkeypatch.setenv("STARKLLM_CODE_RUNNER", value)
    assert code_runner_enabled() is True


def test_execute_code_refuses_without_running_anything(monkeypatch, tmp_path):
    monkeypatch.setenv("STARKLLM_CODE_RUNNER", "off")
    marker = tmp_path / "ran.txt"
    code = f"open({str(marker)!r}, 'w').write('x')"
    with pytest.raises(HTTPException) as e:
        execute_code(ExecuteCodeRequest(code=code), current_user=object())
    assert e.value.status_code == 403
    assert e.value.detail == CODE_RUNNER_OFF
    assert not marker.exists()


def test_version_reports_the_runner(monkeypatch):
    from app.main import version
    monkeypatch.setenv("STARKLLM_CODE_RUNNER", "off")
    assert version()["code_runner"] is False
    monkeypatch.delenv("STARKLLM_CODE_RUNNER", raising=False)
    assert version()["code_runner"] is True
