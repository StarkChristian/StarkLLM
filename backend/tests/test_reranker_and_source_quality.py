"""2.7, options 4 and 5: the optional multilingual reranker (services/reranker.py) and the honest "no good source"
(services/source_quality.py). No network and no real model: downloads use a fake fetcher, scoring a fake scorer."""
import hashlib
import os

import pytest

from app.core import netguard
from app.services import reranker, source_quality
from app.services.rag_service import RAGService


@pytest.fixture
def model_dir(tmp_path, monkeypatch):
    folder = tmp_path / "reranker"
    monkeypatch.delenv("STARKLLM_MULTILINGUAL_RERANKER_DIR", raising=False)
    monkeypatch.setattr(reranker, "model_dir", lambda: str(folder))
    payloads = {"model.onnx": b"onnx-bytes" * 10, "tokenizer.json": b'{"tok": 1}'}
    files = tuple({"name": n, "path": "x/" + n, "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
                  for n, b in payloads.items())
    monkeypatch.setattr(reranker, "FILES", files)
    monkeypatch.setattr(reranker, "DOWNLOAD_BYTES", sum(f["size"] for f in files))
    reranker.reset()
    yield folder, payloads
    reranker.reset()


def fake_fetch(payloads, corrupt=None):
    def fetch(url, dest, expected, progress):
        data = payloads[expected["name"]]
        if expected["name"] == corrupt:
            data = b"X" * len(data)
        if len(data) != expected["size"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise RuntimeError("the downloaded file does not match the expected model (size or checksum)")
        with open(dest, "wb") as f:
            f.write(data)
        progress(len(data))
    return fetch


def test_without_the_model_nothing_changes(model_dir):
    assert not reranker.installed()
    assert reranker.score("question", ["a passage"]) is None
    st = reranker.status()
    assert st["installed"] is False and st["download_bytes"] == reranker.DOWNLOAD_BYTES


def test_the_real_model_is_pinned_and_its_size_is_shown():
    # the size the Settings page shows before the download, and the files checked against their SHA-256
    assert reranker.REVISION and len(reranker.REVISION) == 40
    assert all(len(f["sha256"]) == 64 and f["size"] > 0 for f in reranker.FILES)
    assert 300_000_000 < reranker.DOWNLOAD_BYTES < 400_000_000
    assert "{path}" in reranker.URL and reranker.REVISION in reranker.URL


def test_download_installs_the_checked_files(model_dir):
    folder, payloads = model_dir
    reranker.download(fetch=fake_fetch(payloads))
    assert reranker.installed()
    assert reranker.status()["download"]["state"] == "idle"
    assert (folder / "model.onnx").read_bytes() == payloads["model.onnx"]


def test_a_corrupt_download_is_not_used(model_dir):
    folder, payloads = model_dir
    with pytest.raises(RuntimeError):
        reranker.download(fetch=fake_fetch(payloads, corrupt="tokenizer.json"))
    assert not reranker.installed()
    st = reranker.status()["download"]
    assert st["state"] == "failed" and "checksum" in st["error"]


def test_the_download_goes_through_the_network_layer_and_is_refused_offline(model_dir, tmp_path, monkeypatch):
    monkeypatch.setattr(netguard, "DATA_DIR", str(tmp_path))
    netguard.reset_for_tests()
    netguard.set_offline(True)
    try:
        with pytest.raises(netguard.OfflineBlocked):
            reranker.download()
        entries = netguard.entries()
        assert entries and entries[0]["feature"] == "reranker_model_download" and entries[0]["outcome"] == "blocked"
        assert entries[0]["host"] == "huggingface.co"
    finally:
        netguard.set_offline(False)
        netguard.reset_for_tests()
    assert not reranker.installed()


def test_remove_deletes_the_model(model_dir):
    folder, payloads = model_dir
    reranker.download(fetch=fake_fetch(payloads))
    reranker.remove()
    assert not reranker.installed() and not folder.exists()


def test_a_bundled_model_cannot_be_removed(monkeypatch, tmp_path):
    monkeypatch.setenv("STARKLLM_MULTILINGUAL_RERANKER_DIR", str(tmp_path))
    with pytest.raises(ValueError):
        reranker.remove()


# ---- the time budget -----------------------------------------------------------------------------------------
def test_all_candidates_while_fast_fewer_when_slower_none_when_too_slow(model_dir, monkeypatch):
    monkeypatch.setattr(reranker, "BUDGET_S", 1.5)
    reranker.reset()
    assert reranker.plan(30) == 30                      # nothing measured yet
    reranker._stats["per_candidate_s"] = 0.02           # 30 x 20 ms = 0.6 s
    assert reranker.plan(30) == 30
    reranker._stats["per_candidate_s"] = 0.1            # 15 fit into 1.5 s
    assert reranker.plan(30) == 15
    reranker._stats["per_candidate_s"] = 0.5            # not even MIN_CANDIDATES: switched off
    assert reranker.plan(30) == 0
    assert reranker.status()["auto_off"] is True
    # measured again now and then, with the smallest number
    plans = [reranker.plan(30) for _ in range(reranker.PROBE_EVERY)]
    assert plans.count(reranker.MIN_CANDIDATES) == 1 and plans.count(0) == reranker.PROBE_EVERY - 1


def test_scoring_is_timed_and_a_slow_pc_switches_it_off(model_dir, monkeypatch):
    folder, payloads = model_dir
    reranker.download(fetch=fake_fetch(payloads))

    class Slow:
        def scores(self, query, passages):
            return [0.5] * len(passages)

    monkeypatch.setattr(reranker, "_load", lambda: Slow())
    clock = iter([0.0, 20 * 0.2])  # 20 passages took 4 s
    monkeypatch.setattr(reranker.time, "perf_counter", lambda: next(clock))
    assert reranker.score("q", ["p"] * 30) == [0.5] * 20   # at most MAX_CANDIDATES
    assert reranker.status()["last_ms"] == 4000
    assert reranker.score("q", ["p"] * 30) is None     # 0.2 s per passage: 7 fit into 1.5 s, fewer than 8
    assert reranker.status()["skipped_slow"] == 1


# ---- the second stage in the search -----------------------------------------------------------------------------
def _cands(n):
    return [{"id": f"c{i}", "content": f"passage {i}", "metadata": {"source": f"/data/uploads/abcd1234_f{i}.pdf"}}
            for i in range(n)]


def test_reranker_order_is_fused_with_the_first_stage(monkeypatch):
    svc = RAGService.__new__(RAGService)
    svc.ranker = None
    cands = _cands(6)
    # the reranker likes the last candidate best and the first stage's best one least
    monkeypatch.setattr(reranker, "score", lambda q, texts: [0.1, 0.5, 0.4, 0.3, 0.2, 0.9][:len(texts)])
    out = svc._rerank_or_truncate(cands, "question", 3)
    assert [c["id"] for c in out][0] in ("c1", "c5")
    assert all("_rerank_score" in c for c in out)
    # the passage text goes with the uploaded file name, not the stored one with its hash prefix
    seen = {}
    monkeypatch.setattr(reranker, "score", lambda q, texts: seen.setdefault("t", texts) and [0.5] * len(texts))
    svc._rerank_or_truncate(_cands(2), "question", 2)
    assert seen["t"][0].startswith("f0.pdf\n")


def test_candidates_the_budget_left_out_follow_in_first_stage_order(monkeypatch):
    svc = RAGService.__new__(RAGService)
    svc.ranker = None
    monkeypatch.setattr(reranker, "score", lambda q, texts: [0.2, 0.9])  # only two scored
    out = svc._rerank_or_truncate(_cands(5), "question", 5)
    assert [c["id"] for c in out][2:] == ["c2", "c3", "c4"]


def test_without_the_reranker_the_order_is_as_before(monkeypatch):
    svc = RAGService.__new__(RAGService)
    svc.ranker = None
    monkeypatch.setattr(reranker, "score", lambda q, texts: None)
    out = svc._rerank_or_truncate(_cands(6), "question", 3)
    assert [c["id"] for c in out] == ["c0", "c1", "c2"]
    assert not any("_rerank_score" in c for c in out)


def test_the_first_stage_brings_more_candidates_only_with_the_reranker(monkeypatch):
    svc = RAGService.__new__(RAGService)
    monkeypatch.setattr(reranker, "ready", lambda: False)
    assert svc._pool_size(5) == 15
    monkeypatch.setattr(reranker, "ready", lambda: True)
    assert svc._pool_size(5) == reranker.MAX_CANDIDATES == 20
    assert svc._pool_size(40) == 40


# ---- "no good source" --------------------------------------------------------------------------------------------
def test_threshold_with_the_reranker():
    weak = source_quality.assess([{"_rerank_score": source_quality.RERANK_WEAK - 0.01}, {"_rerank_score": 0.05}])
    assert weak["weak"] and weak["signal"] == "reranker"
    good = source_quality.assess([{"_rerank_score": 0.05}, {"_rerank_score": source_quality.RERANK_WEAK_NO_WORDS + 0.01}])
    assert not good["weak"]
    # the reranker decides when it scored, even if the similarity looks poor
    assert not source_quality.assess([{"_rerank_score": 0.9, "_vector_sim": 0.1}])["weak"]


def test_a_middling_score_is_weak_only_when_the_passages_share_no_word_with_the_question():
    s = (source_quality.RERANK_WEAK + source_quality.RERANK_WEAK_NO_WORDS) / 2
    rent = [{"_rerank_score": s, "content": "Die Kaltmiete beträgt 950 EUR."}]
    assert source_quality.assess(rent, "Wann läuft mein Reisepass ab?")["weak"]
    assert source_quality.assess(rent, "Wann läuft mein Reisepass ab?")["shared_words"] is False
    passport = [{"_rerank_score": s, "content": "Reisepass gültig bis 2031."}]
    assert not source_quality.assess(passport, "Wann läuft mein Reisepass ab?")["weak"]
    # inflected forms meet by their first letters; a question without content words decides by the score alone
    assert source_quality.shares_words("Wie viele Urlaubstage habe ich?", [{"content": "Resturlaub: 11 Tage"}])
    assert source_quality.shares_words("How many days off do I have?", [{"content": "x"}]) is None
    assert not source_quality.assess([{"_rerank_score": s, "content": "x"}], "How many days off do I have?")["weak"]


def test_without_the_reranker_only_a_low_similarity_without_shared_words_is_weak():
    low = source_quality.VECTOR_WEAK_NO_WORDS - 0.05
    msg = "When does my passport expire?"
    assert source_quality.assess([{"_vector_sim": low, "content": "The rent is 950 GBP."}], msg)["weak"]
    assert not source_quality.assess([{"_vector_sim": low, "content": "Passport number 123."}], msg)["weak"]
    assert not source_quality.assess([{"_vector_sim": low + 0.1, "content": "The rent is 950 GBP."}], msg)["weak"]
    # keyword-only passages (no similarity) and no passages: no notice
    assert not source_quality.assess([{"content": "x"}], msg)["weak"]
    assert not source_quality.assess([], msg)["weak"]


@pytest.mark.parametrize("message", [
    "When does my passport expire?", "Wann läuft mein Reisepass ab?", "Quand mon passeport expire-t-il ?",
    "¿Cuándo caduca mi pasaporte?", "Quando scade il mio passaporto?", "Pasaportumun süresi ne zaman doluyor?",
    "Bis wann muss die Stromrechnung bezahlt sein?", "Quanto pago per la bolletta?",
])
def test_questions_about_own_papers_get_the_notice(message):
    weak = [{"_rerank_score": 0.01, "content": "x"}]
    w = source_quality.no_good_source(weak, message, strict_document_mode=False)
    assert w and w["kind"] == "no_good_source" and w["signal"] == "reranker"


@pytest.mark.parametrize("message", [
    "What is the capital of France?", "How do I bake bread?", "Schreib mir ein Gedicht über den Herbst.",
    "Which programming system is best?", "Merci beaucoup !",
])
def test_general_messages_get_no_notice(message):
    assert source_quality.no_good_source([{"_rerank_score": 0.01}], message, strict_document_mode=False) is None


def test_no_notice_when_the_passages_answer_or_for_whole_documents_named_files_and_overviews():
    msg = "What is my deposit?"
    strong = [{"_rerank_score": 0.9}]
    weak = [{"_rerank_score": 0.01}]
    assert source_quality.no_good_source(strong, msg, strict_document_mode=True) is None
    assert source_quality.no_good_source(weak, msg, strict_document_mode=True)
    assert source_quality.no_good_source(weak, msg, strict_document_mode=True, whole_document=True) is None
    assert source_quality.no_good_source(weak, msg, strict_document_mode=True, named_files=True) is None
    assert source_quality.no_good_source(weak, msg, strict_document_mode=True, overview=True) is None
    assert source_quality.no_good_source([], msg, strict_document_mode=True) is None


def test_the_chat_leaves_weak_passages_out_and_tells_the_model():
    from app.api import chat
    src = open(chat.__file__, encoding="utf-8").read()
    assert "source_quality.no_good_source(" in src and "missing_section += NO_GOOD_SOURCE_NOTE" in src
    assert "do not guess" in chat.NO_GOOD_SOURCE_NOTE
    # the notice goes to the app, not into the safety checks of the prompt (document_checks.note would fail on it)
    assert '_safety_section([w for w in warnings if w.get("kind") != "no_good_source"])' in src
    assert chat._safety_section([]) == ""


def test_the_network_feature_is_documented():
    assert "reranker_model_download" in netguard.FEATURES
    doc = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "privacy-network.md")
    if os.path.exists(doc):
        assert "reranker_model_download" in open(doc, encoding="utf-8").read()
