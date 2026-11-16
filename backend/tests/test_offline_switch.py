"""Windows test of 2.1.0 (N1): "Fully offline" could be switched on by any account but off only by the administrator,
so an ordinary account that switched it on was stuck offline (no update checks, no model downloads).

Now: every signed-in account may turn it on, and the engine keeps who did (set_by). Turning it off is for the
administrator (first account) and for the account that turned it on. When it came from STARKLLM_OFFLINE or the
desktop app (set_by None), the administrator or the desktop app on this PC (X-Desktop-Key) turn it off."""
import json
import os
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import auth, privacy  # noqa: E402
from app.api.privacy import OfflineSwitch, put_offline, put_offline_desktop  # noqa: E402
from app.core import netguard  # noqa: E402
from app.db.models import User  # noqa: E402
from app.db.session import Base  # noqa: E402

MESSAGE = 'Only the administrator of this StarkLLM, or the account that turned "Fully offline" on, can turn it off.'


@pytest.fixture
def net(tmp_path, monkeypatch):
    monkeypatch.setattr(netguard, "DATA_DIR", str(tmp_path))
    monkeypatch.delenv("STARKLLM_OFFLINE", raising=False)
    monkeypatch.setattr(auth.settings, "SECRET_KEY", "a" * 64)
    netguard.reset_for_tests()
    yield netguard
    netguard.reset_for_tests()


@pytest.fixture
def users(tmp_path, net):
    """A fresh database: admin is the first account, bob and carol are ordinary accounts."""
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    made = []
    for name in ("admin", "bob", "carol"):
        u = User(username=name, hashed_password="x")
        db.add(u)
        db.commit()
        db.refresh(u)
        made.append(u)
    yield db, made
    db.close()


def switch(db, user, enabled):
    return put_offline(OfflineSwitch(enabled=enabled), current_user=user, db=db)


def refused(db, user):
    with pytest.raises(HTTPException) as e:
        switch(db, user, False)
    return e.value


def key():
    return auth.desktop_key(auth.settings.SECRET_KEY)


def test_every_account_can_turn_it_on_and_who_did_is_kept(users, tmp_path):
    db, (admin, bob, carol) = users
    status = switch(db, bob, True)
    assert status["offline"] is True and status["set_by"] == bob.id
    assert json.loads((tmp_path / "privacy.json").read_text()) == {"offline": True, "set_by": bob.id}
    netguard.reset_for_tests()  # a restart of the engine keeps who turned it on
    assert netguard.offline_set_by() == bob.id


def test_the_account_that_turned_it_on_can_turn_it_off(users):
    db, (admin, bob, carol) = users
    switch(db, bob, True)
    status = switch(db, bob, False)
    assert status["offline"] is False and status["set_by"] is None
    assert netguard.is_offline() is False


def test_another_ordinary_account_cannot_turn_it_off(users):
    db, (admin, bob, carol) = users
    switch(db, bob, True)
    e = refused(db, carol)
    assert e.status_code == 403 and e.detail == MESSAGE
    assert "backup" not in e.detail.lower()
    assert netguard.is_offline() is True and netguard.offline_set_by() == bob.id


def test_turning_it_on_again_does_not_take_it_over(users):
    db, (admin, bob, carol) = users
    switch(db, bob, True)
    switch(db, carol, True)  # already on: bob stays the one who turned it on
    assert netguard.offline_set_by() == bob.id
    assert refused(db, carol).status_code == 403


def test_the_administrator_can_always_turn_it_off(users):
    db, (admin, bob, carol) = users
    switch(db, bob, True)
    assert switch(db, admin, False)["offline"] is False


def test_turning_it_off_when_it_is_off_is_no_error(users):
    db, (admin, bob, carol) = users
    assert switch(db, carol, False)["offline"] is False


@pytest.mark.parametrize("how", ["environment", "desktop"])
def test_switched_on_by_the_environment_or_the_desktop_app_only_the_admin_or_the_desktop_app_turn_it_off(users, monkeypatch, how):
    db, (admin, bob, carol) = users
    if how == "environment":
        monkeypatch.setenv("STARKLLM_OFFLINE", "1")  # the desktop app started the engine offline
        netguard.reset_for_tests()
    else:
        put_offline_desktop(OfflineSwitch(enabled=True), x_desktop_key=key())
    assert netguard.is_offline() is True and netguard.offline_set_by() is None
    for user in (bob, carol):
        assert refused(db, user).detail == MESSAGE
    assert switch(db, admin, False)["offline"] is False
    switch(db, bob, True)
    assert netguard.offline_set_by() == bob.id
    monkeypatch.delenv("STARKLLM_OFFLINE", raising=False)
    put_offline_desktop(OfflineSwitch(enabled=False), x_desktop_key=key())  # and the desktop app always can
    assert netguard.is_offline() is False


def test_the_desktop_app_can_turn_it_on_and_off_with_its_key(net):
    assert put_offline_desktop(OfflineSwitch(enabled=True), x_desktop_key=key())["offline"] is True
    assert netguard.offline_set_by() is None
    assert put_offline_desktop(OfflineSwitch(enabled=False), x_desktop_key=key())["offline"] is False


@pytest.mark.parametrize("sent", ["", "nope", "a" * 64, "ä"])
def test_the_desktop_endpoint_refuses_a_wrong_or_missing_key(net, sent):
    with pytest.raises(HTTPException) as e:
        put_offline_desktop(OfflineSwitch(enabled=True), x_desktop_key=sent)
    assert e.value.status_code == 403
    assert netguard.is_offline() is False


def test_the_desktop_endpoint_refuses_the_public_fallback_secret(net, monkeypatch):
    monkeypatch.setattr(auth.settings, "SECRET_KEY", "starkllm_research_beta_secure_fallback_key_2026_change_in_production")
    with pytest.raises(HTTPException) as e:
        put_offline_desktop(OfflineSwitch(enabled=True), x_desktop_key=key())
    assert e.value.status_code == 403


def test_backup_and_restore_keep_their_own_message(users):
    from app.api.system import require_admin
    db, (admin, bob, carol) = users
    assert require_admin(current_user=admin, db=db) is admin
    with pytest.raises(HTTPException) as e:
        require_admin(current_user=bob, db=db)
    assert e.value.status_code == 403 and e.value.detail == "Only the instance administrator may use backup/restore."


def test_the_desktop_route_reads_the_header(net):
    """Through the real app: the route exists at /api/v1/privacy/offline/desktop and takes X-Desktop-Key."""
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    url = "/api/v1/privacy/offline/desktop"
    assert client.put(url, json={"enabled": True}).status_code == 403
    assert client.put(url, json={"enabled": True}, headers={"X-Desktop-Key": "wrong"}).status_code == 403
    r = client.put(url, json={"enabled": True}, headers={"X-Desktop-Key": key()})
    assert r.status_code == 200 and r.json()["offline"] is True
    assert client.put(url, json={"enabled": False}, headers={"X-Desktop-Key": key()}).json()["offline"] is False
    assert privacy.OFF_NOT_ALLOWED == MESSAGE
