"""StarkLLM is advertised as local-first. These checks keep two things that used to contact third parties from doing so
without the user's decision: the market-price widget (CoinGecko / Yahoo Finance) and the Google Fonts import."""
import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import dashboard

REPO = Path(__file__).resolve().parents[2]


def test_market_prices_make_no_request_without_consent(monkeypatch):
    class Boom:
        def __init__(self, *a, **k):
            raise AssertionError("an external HTTP client was created without consent")
    monkeypatch.setattr(dashboard.httpx, "AsyncClient", Boom)
    with pytest.raises(HTTPException) as e:
        asyncio.run(dashboard.get_market_prices("GC=F", consent=0, current_user=None))
    assert e.value.status_code == 403


def test_market_prices_need_a_logged_in_user():
    import inspect
    dep = inspect.signature(dashboard.get_market_prices).parameters["current_user"].default
    assert dep.dependency.__name__ == "get_current_user"


def test_the_widget_is_off_until_the_user_turns_it_on():
    src = (REPO / "frontend/src/components/MarketPricesWidget.jsx").read_text(encoding="utf-8")
    assert "starkllm_market_prices_consent" in src and "if (!consent) return undefined;" in src


def test_the_stylesheet_does_not_import_web_fonts():
    css = (REPO / "frontend/src/index.css").read_text(encoding="utf-8")
    assert "fonts.googleapis.com" not in css and "@import url('http" not in css
