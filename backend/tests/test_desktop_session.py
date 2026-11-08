"""One person on their own PC should not have to sign up (roadmap phase 1, easy install)."""
import os
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import auth
from app.api.auth import UserCreate
from app.db.models import User
from app.db.session import Base


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(auth.settings, "SECRET_KEY", "a" * 64)
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def key():
    return auth.desktop_key(auth.settings.SECRET_KEY)


def test_a_fresh_install_gets_a_local_session_without_sign_up(db):
    t1 = auth.desktop_session(x_desktop_key=key(), db=db)
    assert t1["access_token"]
    assert [u.username for u in db.query(User).all()] == ["local"]
    t2 = auth.desktop_session(x_desktop_key=key(), db=db)
    assert db.query(User).count() == 1, "the same local user is reused"
    assert t2["access_token"]


def test_a_wrong_key_is_refused(db):
    with pytest.raises(HTTPException) as e:
        auth.desktop_session(x_desktop_key="nope", db=db)
    assert e.value.status_code == 403
    assert db.query(User).count() == 0


def test_the_public_fallback_secret_never_allows_a_desktop_session(db, monkeypatch):
    monkeypatch.setattr(auth.settings, "SECRET_KEY", "starkllm_research_beta_secure_fallback_key_2026_change_in_production")
    with pytest.raises(HTTPException) as e:
        auth.desktop_session(x_desktop_key=auth.desktop_key(auth.settings.SECRET_KEY), db=db)
    assert e.value.status_code == 403


def test_existing_accounts_keep_the_login(db):
    auth.register(UserCreate(username="alice", password="secret123"), db=db)
    with pytest.raises(HTTPException) as e:
        auth.desktop_session(x_desktop_key=key(), db=db)
    assert e.value.status_code == 409


def test_nobody_can_register_as_local(db):
    with pytest.raises(HTTPException) as e:
        auth.register(UserCreate(username="Local", password="secret123"), db=db)
    assert e.value.status_code == 400
