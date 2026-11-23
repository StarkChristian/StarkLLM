"""The session of a paired phone (owner, 22 Nov 2026): only the desktop app gets it, and a new password ends it."""
import os
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import auth
from app.api.auth import UserCreate, ChangePasswordRequest
from app.db.models import User
from app.db.session import Base


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(auth.settings, "SECRET_KEY", "b" * 64)
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _user(db, name="anna"):
    auth.register(UserCreate(username=name, password="secret123"), db=db)
    return db.query(User).filter(User.username == name).first()


def test_only_the_desktop_app_gets_a_phone_session(db):
    anna = _user(db)
    with pytest.raises(HTTPException) as e:
        auth.phone_session(x_desktop_key="nope", current_user=anna)
    assert e.value.status_code == 403
    tok = auth.phone_session(x_desktop_key=auth.desktop_key(auth.settings.SECRET_KEY), current_user=anna)["access_token"]
    assert auth.get_current_user(token=tok, db=db).username == "anna"


def test_a_new_password_ends_the_phone_session_but_not_the_normal_one(db):
    anna = _user(db)
    phone = auth.phone_session(x_desktop_key=auth.desktop_key(auth.settings.SECRET_KEY), current_user=anna)["access_token"]
    auth.change_password(ChangePasswordRequest(new_password="another456"), current_user=anna, db=db)
    with pytest.raises(HTTPException) as e:
        auth.get_current_user(token=phone, db=db)
    assert e.value.status_code == 401
    window = auth.create_access_token(data={"sub": "anna"})
    assert auth.get_current_user(token=window, db=db).username == "anna"
