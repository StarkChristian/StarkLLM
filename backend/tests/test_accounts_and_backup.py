"""Accounts, administrator-only backup/restore and authenticated model routes.

Found by running the S01/S02/S10 scenarios against a fresh install: empty usernames and 1-character passwords were accepted,
'Alice' and 'alice' were two accounts, any logged-in user could download or overwrite the data of ALL users, and the model
list/pull/delete routes needed no token at all.
"""
import io
import os
import sqlite3
import sys
import zipfile

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import auth, system
from app.api.auth import UserCreate, UpdateGenerationSettingsRequest
from app.api.models_router import router as models_router
from app.db.models import User
from app.db.session import Base


@pytest.fixture()
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.mark.parametrize("name,pw", [("", "ValidPass123"), ("   ", "ValidPass123"), ("x" * 300, "ValidPass123"), ("alice", "a"), ("alice", "")])
def test_invalid_registrations_are_rejected(name, pw):
    with pytest.raises(ValidationError):
        UserCreate(username=name, password=pw)


def test_username_is_trimmed():
    assert UserCreate(username="  alice  ", password="secret1").username == "alice"


def test_usernames_are_unique_ignoring_case_and_whitespace(db):
    db.add(User(username="Alice", hashed_password="x"))
    db.commit()
    assert auth._find_user(db, "alice").username == "Alice"
    assert auth._find_user(db, "  ALICE ").username == "Alice"
    assert auth._find_user(db, "bob") is None


@pytest.mark.parametrize("field,value", [("temperature", 9.0), ("temperature", -1.0), ("top_p", 2.0), ("max_tokens", 0)])
def test_out_of_range_generation_settings_are_rejected(field, value):
    with pytest.raises(ValidationError):
        UpdateGenerationSettingsRequest(**{field: value})


def test_only_the_first_account_is_administrator(db):
    first, second = User(username="owner", hashed_password="x"), User(username="guest", hashed_password="x")
    db.add_all([first, second])
    db.commit()
    assert system.require_admin(current_user=first, db=db) is first
    with pytest.raises(HTTPException) as e:
        system.require_admin(current_user=second, db=db)
    assert e.value.status_code == 403


def _db_file(tmp_path, tables):
    p = tmp_path / "starkllm.db"
    con = sqlite3.connect(p)
    for t in tables:
        con.execute(f"create table {t} (id integer)")
    con.commit()
    con.close()
    return str(p)


def test_a_valid_backup_database_passes(tmp_path):
    system._validate_backup_db(_db_file(tmp_path, ["users", "workspaces"]))


def test_garbage_or_incomplete_databases_are_rejected(tmp_path):
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"this is not a database" * 50)
    with pytest.raises(HTTPException) as e:
        system._validate_backup_db(str(garbage))
    assert e.value.status_code == 400
    incomplete = tmp_path / "incomplete"
    incomplete.mkdir()
    with pytest.raises(HTTPException) as e:
        system._validate_backup_db(_db_file(incomplete, ["users"]))
    assert e.value.status_code == 400


def test_every_model_route_requires_a_logged_in_user():
    deps = {d.dependency for d in models_router.dependencies}
    assert auth.get_current_user in deps


def test_voice_routes_require_a_logged_in_user():
    from app.api.voice import router as voice_router
    assert auth.get_current_user in {d.dependency for d in voice_router.dependencies}
