"""An Ollama older than MIN_OLLAMA (Bleeding Llama, CVE-2026-7482) is flagged in the status; unknown or
development versions are not, so nobody is warned without reason."""
from app.api.dashboard import MIN_OLLAMA, ollama_outdated


def test_old_versions_are_flagged():
    assert ollama_outdated("0.12.3")
    assert ollama_outdated("0.17.0")
    assert ollama_outdated("v0.9.6")


def test_current_and_unknown_versions_are_not():
    assert not ollama_outdated(MIN_OLLAMA)
    assert not ollama_outdated("0.40.15")
    assert not ollama_outdated("1.0.0")
    assert not ollama_outdated("")
    assert not ollama_outdated("0.0.0")
    assert not ollama_outdated("garbage")
    assert not ollama_outdated("0.18.0-rc1")
