"""N23 (2.2.1 test): under the engine without Docker the watcher logged the Docker-era advice "use start.exe to
mirror it into /kb_data" every 30 s for a folder that was not there."""
from app.services import kb_service


def test_without_docker_the_message_names_the_folder_and_no_docker_advice(monkeypatch):
    real = kb_service.os.path.exists
    monkeypatch.setattr(kb_service.os.path, "exists", lambda p: False if p == "/.dockerenv" else real(p))
    msg = kb_service.missing_folder_message(3, r"D:\\Scans")
    assert "D:" in msg and "start.exe" not in msg and "container" not in msg


def test_in_docker_the_message_explains_the_mirror(monkeypatch):
    real = kb_service.os.path.exists
    monkeypatch.setattr(kb_service.os.path, "exists", lambda p: True if p == "/.dockerenv" else real(p))
    msg = kb_service.missing_folder_message(3, "/kb_data/x")
    assert "Docker container" in msg and "start.exe" not in msg
