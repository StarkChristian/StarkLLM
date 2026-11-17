"""The engine must start even when the speech recognition libraries cannot load (2.2.0 test: Smart App Control
blocked ctranslate2, and the import in voice_service took the whole engine down)."""
import os
import subprocess
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_voice_modules_do_not_load_faster_whisper_at_import():
    code = ("import sys; import app.services.voice_service, app.api.voice; "
            "print(sorted(m for m in ('faster_whisper', 'ctranslate2', 'av') if m in sys.modules))")
    r = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout.strip().splitlines()[-1] == "[]"


def test_a_failing_speech_library_only_fails_voice_input(monkeypatch):
    import builtins
    from app.services.voice_service import VoiceService

    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name == "faster_whisper":
            raise ImportError("DLL load failed while importing _ext: An Application Control policy has blocked this file.")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    service = VoiceService()
    try:
        service.model
    except ImportError as e:
        assert "Application Control" in str(e)
    else:
        raise AssertionError("expected the import error")
