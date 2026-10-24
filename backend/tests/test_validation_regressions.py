"""Validation and data-lifecycle regressions found by the S03/S05/S08/S09/S10 scenarios against the shipped code."""
import os
import sys

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import search, workspaces
from app.api.chat import TruncateRequest
from app.api.prompts import PromptCreate, PromptUpdate
from app.db import models
from app.db.session import Base


@pytest.fixture()
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'v.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    user = models.User(username="owner", hashed_password="x")
    session.add(user)
    session.commit()
    session.user = user
    yield session
    session.close()


@pytest.mark.parametrize("title,content", [("", "x"), ("t", ""), ("  ", "x"), ("t", "   ")])
def test_empty_prompt_templates_are_rejected(title, content):
    with pytest.raises(ValidationError):
        PromptCreate(title=title, content=content)


def test_valid_prompt_template_and_partial_update():
    assert PromptCreate(title="Weekly report", content="Summarise {x}").title == "Weekly report"
    assert PromptUpdate(title="New").content is None
    with pytest.raises(ValidationError):
        PromptUpdate(content="")


def test_negative_keep_count_is_rejected():
    assert TruncateRequest(chat_id=1, keep_count=0).keep_count == 0
    with pytest.raises(ValidationError):
        TruncateRequest(chat_id=1, keep_count=-1)


@pytest.mark.parametrize("wildcard", ["%", "_", "%%"])
def test_search_wildcards_are_matched_literally(db, wildcard):
    ws = models.Workspace(name="Project plan", user_id=db.user.id)
    db.add(ws)
    db.commit()
    assert search.global_search(q=wildcard, db=db, current_user=db.user)["workspaces"] == []
    assert len(search.global_search(q="roject", db=db, current_user=db.user)["workspaces"]) == 1


def test_workspace_has_no_duplicate_route_definitions():
    seen = {}
    for r in workspaces.router.routes:
        for m in r.methods:
            seen.setdefault((r.path, m), 0)
            seen[(r.path, m)] += 1
    assert not {k: v for k, v in seen.items() if v > 1}, "the same route is registered twice"


def test_deleting_a_workspace_removes_its_rows_and_files(db, tmp_path):
    ws = models.Workspace(name="Temp", user_id=db.user.id)
    db.add(ws)
    db.commit()
    f = tmp_path / "upload.txt"
    f.write_text("hello")
    db.add(models.Document(workspace_id=ws.id, filename="upload.txt", filepath=str(f), file_type="txt"))
    chat = models.Chat(workspace_id=ws.id, title="c")
    db.add(chat)
    db.commit()
    db.add(models.Message(chat_id=chat.id, role="user", content="hi"))
    db.commit()
    workspaces.delete_workspace(ws.id, db=db, current_user=db.user)
    assert not f.exists()
    assert db.query(models.Document).count() == 0
    assert db.query(models.Chat).count() == 0 and db.query(models.Message).count() == 0
    assert db.query(models.Workspace).count() == 0
