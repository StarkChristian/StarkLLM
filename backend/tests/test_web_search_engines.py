"""Web search engines and regions (MSI 2.5.0 rounds 10-11: non-English questions failed more often)."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.chat import search_regions, search_query, wikipedia_search, wiki_keywords, WEB_SEARCH_ENGINES


def test_a_question_in_another_language_asks_for_that_language_first():
    assert search_regions("Spanish") == ["es-es", "wt-wt"]
    assert search_regions("German") == ["de-de", "wt-wt"]
    assert search_regions("English") == ["us-en"]
    assert search_regions(None) == ["us-en"]


def test_the_query_leaves_out_spanish_and_french_marks():
    assert search_query("¿Cuántos habitantes tiene Aquisgrán?") == "Cuántos habitantes tiene Aquisgrán?"
    assert search_query("Le prix « exact »\n?") == "Le prix exact ?"


def test_one_engine_at_a_time_duckduckgo_first():
    assert [h for _, h in WEB_SEARCH_ENGINES] == ["duckduckgo.com", "startpage.com", "mojeek.com"]


def test_only_engines_the_library_knows():
    """an unknown name makes the library ask several engines at once (MSI §43: "mullvad_brave" was removed)"""
    import importlib, pkgutil
    try:
        engines = importlib.import_module("ddgs.engines")
    except ImportError:
        return
    known = {m.name for m in pkgutil.iter_modules(engines.__path__)}
    assert all(b in known for b, _ in WEB_SEARCH_ENGINES)


def test_wikipedia_is_asked_in_the_question_language_and_gives_results():
    seen = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"query": {"pages": [
                {"index": 2, "title": "Mehrwertsteuer", "fullurl": "https://de.wikipedia.org/wiki/Mehrwertsteuer",
                 "extract": "Der allgemeine Steuersatz betraegt 19 Prozent."},
                {"index": 1, "title": "Umsatzsteuer (Deutschland)",
                 "fullurl": "https://de.wikipedia.org/wiki/Umsatzsteuer_(Deutschland)", "extract": "19 und 7 Prozent."},
                {"index": 3, "title": "Leer", "extract": ""}]}}

    def get(url, **kw):
        seen.update(url=url, **kw)
        return Resp()

    out = wikipedia_search("Wie hoch ist die Mehrwertsteuer?", "de", get=get)
    assert seen["url"] == "https://de.wikipedia.org/w/api.php" and seen["params"]["gsrsearch"] == "Mehrwertsteuer"
    assert "StarkLLM" in seen["headers"]["User-Agent"]
    assert [r["title"] for r in out] == ["Umsatzsteuer (Deutschland)", "Mehrwertsteuer"]
    assert wikipedia_search("x", "../evil", get=get) and seen["url"].startswith("https://en.wikipedia.org/")


def test_wikipedia_gets_the_words_of_the_question():
    assert wiki_keywords("What is the current VAT rate in Germany?") == "VAT rate Germany"
    assert wiki_keywords("Wie hoch ist die Mehrwertsteuer in Deutschland?") == "Mehrwertsteuer Deutschland"
    assert wiki_keywords("Quel est le taux de TVA en Allemagne ?") == "taux TVA Allemagne"
    assert wiki_keywords("Wie?") == "Wie"
