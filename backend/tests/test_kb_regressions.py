"""Knowledge Base regressions found by running the S02/S05/S06 scenarios against the shipped code."""
import os
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import knowledge_base as kb_api
from app.core.config import settings
from app.db.models import User
from app.db.session import Base
from app.services.kb_service import SUPPORTED_EXTENSIONS
from app.services.rag_service import rag_service


@pytest.fixture()
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'kb.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    user = User(username="owner", hashed_password="x")
    session.add(user)
    session.commit()
    session.user = user
    yield session
    session.close()


def register(db, path):
    return kb_api.register_folder(kb_api.FolderCreate(folder_path=str(path), folder_name=None), db=db, current_user=db.user)


def test_a_folder_inside_the_kb_directory_can_be_registered(db, tmp_path, monkeypatch):
    root = tmp_path / "kb_data"
    (root / "docs").mkdir(parents=True)
    monkeypatch.setattr(settings, "KB_DATA_DIR", str(root))
    assert register(db, root / "docs").folder_path == str(root / "docs")


@pytest.mark.parametrize("outside", ["/etc", "/app/data", "/proc"])
def test_folders_outside_the_kb_directory_are_refused(db, tmp_path, monkeypatch, outside):
    monkeypatch.setattr(settings, "KB_DATA_DIR", str(tmp_path / "kb_data"))
    with pytest.raises(HTTPException) as e:
        register(db, outside)
    assert e.value.status_code == 403


def test_a_dot_dot_escape_is_refused(db, tmp_path, monkeypatch):
    root = tmp_path / "kb_data"
    root.mkdir()
    monkeypatch.setattr(settings, "KB_DATA_DIR", str(root))
    with pytest.raises(HTTPException) as e:
        register(db, str(root) + "/../..")
    assert e.value.status_code == 403


def test_a_regular_file_is_not_a_folder(db, tmp_path, monkeypatch):
    root = tmp_path / "kb_data"
    root.mkdir()
    (root / "notes.txt").write_text("hello")
    monkeypatch.setattr(settings, "KB_DATA_DIR", str(root))
    with pytest.raises(HTTPException) as e:
        register(db, root / "notes.txt")
    assert e.value.status_code == 400


def test_folder_selection_filter_is_a_valid_chroma_expression():
    assert rag_service._build_where_filter({"folder_id": {"$in": [1, 2]}}) == {"folder_id": {"$in": [1, 2]}}
    assert rag_service._build_where_filter({"folder_id": [1, 2]}) == {"folder_id": {"$in": [1, 2]}}
    assert rag_service._build_where_filter({"folder_id": 3}) == {"folder_id": {"$eq": 3}}
    assert rag_service._build_where_filter({"a": 1, "folder_id": {"$in": [1]}}) == {"$and": [{"a": {"$eq": 1}}, {"folder_id": {"$in": [1]}}]}


def test_the_kb_scan_knows_the_data_formats_the_indexer_supports():
    assert {".csv", ".json", ".xlsx", ".xml", ".log", ".markdown"} <= SUPPORTED_EXTENSIONS


def test_kb_config_needs_login_and_has_no_personal_path():
    import inspect
    assert "current_user" in inspect.signature(kb_api.get_kb_config).parameters
    assert "chris" not in inspect.getsource(kb_api).lower()
