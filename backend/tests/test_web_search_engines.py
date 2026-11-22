"""Web search engines and regions (MSI 2.5.0 rounds 10-11: non-English questions failed more often)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.chat import search_regions, search_query, WEB_SEARCH_ENGINES


def test_a_question_in_another_language_asks_for_that_language_first():
    assert search_regions("Spanish") == ["es-es", "wt-wt"]
    assert search_regions("German") == ["de-de", "wt-wt"]
    assert search_regions("English") == ["us-en"]
    assert search_regions(None) == ["us-en"]


def test_the_query_leaves_out_spanish_and_french_marks():
    assert search_query("¿Cuántos habitantes tiene Aquisgrán?") == "Cuántos habitantes tiene Aquisgrán?"
    assert search_query("Le prix « exact »\n?") == "Le prix exact ?"


def test_one_engine_at_a_time_duckduckgo_first():
    assert [h for _, h in WEB_SEARCH_ENGINES] == ["duckduckgo.com", "leta.mullvad.net", "mojeek.com"]
