"""Layered summaries of large documents (services/summaries.py, roadmap phase 2)."""
import json

from app.services import summaries as S


def chunk(text, page=None, order=0, section=""):
    return {"text": text, "page": page, "order": order, "section": section}


def test_sections_follow_the_table_of_contents_with_the_front_matter_first():
    chunks = [chunk("x" * 1000, p) for p in range(1, 41)]
    toc = [("CHAPTER 1. Loomings", 5), ("CHAPTER 2. The Carpet-Bag", 12), ("CHAPTER 3. The Spouter-Inn", 20)]
    s = S.plan_sections(chunks, toc)
    titles = [x["title"] for x in s]
    assert titles[0] == "Beginning" and s[0]["pages"] == [1, 4]
    assert "CHAPTER 2. The Carpet-Bag" in titles
    # chapter 3 runs from page 20 to the end: 21 pages * 1000 characters, split into parts of at most 12,000
    ch3 = [x for x in s if x["title"].startswith("CHAPTER 3")]
    assert len(ch3) > 1 and all(len(x["text"]) <= S.SECTION_MAX_CHARS for x in ch3)
    assert ch3[0]["title"].endswith("(1/%d)" % len(ch3))


def test_sections_from_chapter_labels_pages_or_plain_size():
    epub = [chunk("a" * 3000, None, i, "Chapter 1") for i in range(3)] + [chunk("b" * 3000, None, 3 + i, "Chapter 2") for i in range(3)]
    assert [x["title"] for x in S.plan_sections(epub)] == ["Chapter 1", "Chapter 2"]
    pages = [chunk("p" * 1000, p) for p in range(1, 26)]
    assert [x["title"] for x in S.plan_sections(pages)][:3] == ["Pages 1-10", "Pages 11-20", "Pages 21-25"]
    plain = [chunk("t" * 4000, None, i) for i in range(10)]
    assert all(len(x["text"]) <= S.SECTION_MAX_CHARS for x in S.plan_sections(plain))


def test_small_sections_join_the_one_before():
    chunks = [chunk("a" * 5000, None, 0, "One"), chunk("tiny", None, 1, "Two"), chunk("c" * 5000, None, 2, "Three")]
    s = S.plan_sections(chunks)
    assert [x["title"] for x in s] == ["One", "Three"] and "tiny" in s[0]["text"]


def test_only_large_documents_are_summarized():
    assert not S.is_large([chunk("x" * 1000, p) for p in range(1, 10)])
    assert S.is_large([chunk("x" * 100, p) for p in range(1, 40)])
    assert S.is_large([chunk("x" * 70_000)])


def test_build_writes_sections_parts_and_the_whole_and_reuses_an_unfinished_run(monkeypatch):
    calls = []

    def fake_ask(instruction, text, max_words, stop=None):
        calls.append(instruction[:40])
        return f"summary {len(calls)}"

    monkeypatch.setattr(S, "_ask", fake_ask)
    chunks = [chunk("x" * 3000, p) for p in range(1, 121)]   # 12 windows of 10 pages ... split into 30 sections
    seen = []
    data = S.build(chunks, name="moby-dick.pdf", progress=lambda d, t: seen.append((d, t)))
    n = len(data["sections"])
    assert n >= 12 and len(data["parts"]) == (n + S.GROUP - 1) // S.GROUP and data["document"]
    assert seen[-1][0] == seen[-1][1]
    assert data["parts"][0]["pages"][0] == 1
    # an interrupted run: the section summaries already written are not asked again
    before = len(calls)
    partial = {"sections": data["sections"][:5]}
    S.build(chunks, name="moby-dick.pdf", previous=partial)
    assert len(calls) - before == (n - 5) + len(data["parts"]) + 1


def test_whole_document_questions_are_recognised():
    whole = ["Summarize the whole of Moby-Dick in five sentences.", "How does Moby-Dick end?", "Who are the three mates of the Pequod?",
             "Name the harpooneers of the Pequod.", "List the characters Alice meets in Wonderland.",
             "Fasse den Roman Effi Briest in fünf Sätzen zusammen.", "Wie endet der Roman Effi Briest?",
             "Welche Rolle spielen die Briefe von Crampas in Effi Briest?", "Worum geht es in dem Buch?"]
    specific = ["What does Ahab nail to the mainmast?", "Wie heißt Effis Ehemann in Effi Briest?",
                "In Alice's Adventures in Wonderland, what is written on the little bottle?", "Wie hoch ist die Miete?"]
    assert all(S.is_whole_document_question(q) for q in whole), [q for q in whole if not S.is_whole_document_question(q)]
    assert not any(S.is_whole_document_question(q) for q in specific), [q for q in specific if S.is_whole_document_question(q)]


def test_the_document_named_in_the_question_is_picked():
    docs = [{"name": "moby-dick.pdf"}, {"name": "alice.pdf"}, {"name": "effi-briest.pdf"}]
    assert [d["name"] for d in S.pick(docs, "How does Moby-Dick end?")] == ["moby-dick.pdf"]
    assert [d["name"] for d in S.pick(docs, "Wie endet der Roman Effi Briest?")] == ["effi-briest.pdf"]
    assert S.pick(docs, "How does it end?") == []
    assert [d["name"] for d in S.pick(docs[:1], "How does it end?")] == ["moby-dick.pdf"]


def test_context_has_the_whole_document_first_and_the_last_sections_for_the_ending():
    data = {"document": "The whole story.", "parts": [{"titles": ["CHAPTER 1", "CHAPTER 10"], "pages": [1, 50], "summary": "Part one."}],
            "sections": [{"title": f"CHAPTER {i}", "pages": [i * 5, i * 5 + 4], "summary": f"Section {i}."} for i in range(1, 11)]}
    text, labels = S.build_context([("moby-dick.pdf", data)], "How does Moby-Dick end?")
    assert text.startswith("[Summary of moby-dick.pdf, the whole document (pages 1-54)]\nThe whole story.")
    assert "Section 10." in text and "Section 8." in text and "Section 7." not in text
    assert labels == ["moby-dick.pdf (summary of the whole document)"]
    text, _ = S.build_context([("moby-dick.pdf", data)], "Summarize Moby-Dick.")
    assert "Section 10." not in text and "Part one." in text


def test_stored_next_to_the_upload_through_the_vault(tmp_path, monkeypatch):
    from app.services import vault
    written = {}
    monkeypatch.setattr(vault, "write_text", lambda p, t: (written.__setitem__(p, t), open(p, "w", encoding="utf-8").write(t)))
    f = tmp_path / "book.pdf"
    f.write_bytes(b"%PDF")
    S.save(str(f), {"version": S.VERSION, "document": "x", "sections": [], "parts": []})
    assert any(p.endswith("book.pdf.summaries.json.part") for p in written), "written through the vault (protection at rest)"
    assert S.load(str(f))["document"] == "x"
    S.remove(str(f))
    assert not (tmp_path / "book.pdf.summaries.json").exists()


def test_gentle_pace_rests_after_each_call_and_waits_on_battery_and_for_a_hot_card(monkeypatch):
    slept = []
    monkeypatch.delenv("STARKLLM_SUMMARY_PACE", raising=False)
    monkeypatch.setattr(S, "_sleep", lambda seconds, stop=None: slept.append(round(seconds, 1)))
    # a laptop on mains power rests as long as the call took, a PC without a battery a third of it
    monkeypatch.setattr(S, "_gpu_temperature", lambda: None)
    monkeypatch.setattr(S, "_power", lambda: "mains")
    S._rest(6.0)
    monkeypatch.setattr(S, "_power", lambda: "none")
    S._rest(6.0)
    assert slept == [6.0, 1.8]
    # on battery it waits until the PC is plugged in
    slept.clear()
    power = iter(["battery", "battery", "mains"])
    monkeypatch.setattr(S, "_power", lambda: next(power))
    S._rest(2.0)
    assert slept == [S.BATTERY_CHECK_S, S.BATTERY_CHECK_S, 2.0]
    # a hot graphics card gets a break until it is cool again
    slept.clear()
    temps = iter([84, 78, 69])
    monkeypatch.setattr(S, "_power", lambda: "none")
    monkeypatch.setattr(S, "_gpu_temperature", lambda: next(temps))
    S._rest(10.0)
    assert slept == [3.0, S.GPU_CHECK_S, S.GPU_CHECK_S]
    # a card below the limit is not waited for
    slept.clear()
    monkeypatch.setattr(S, "_gpu_temperature", lambda: 79)
    S._rest(10.0)
    assert slept == [3.0]


def test_full_pace_does_not_rest(monkeypatch):
    slept = []
    monkeypatch.setenv("STARKLLM_SUMMARY_PACE", "full")
    monkeypatch.setattr(S, "_sleep", lambda seconds, stop=None: slept.append(seconds))
    monkeypatch.setattr(S, "_power", lambda: "battery")
    S._rest(5.0)
    assert slept == []


def test_power_and_temperature_are_unknown_without_windows_or_nvidia(monkeypatch):
    if S.os.name != "nt":
        assert S._power() == "none"
    monkeypatch.setattr(S.shutil, "which", lambda name: None)
    assert S._gpu_temperature() is None


def test_the_overview_of_the_first_retrieved_document_with_summaries(tmp_path, monkeypatch):
    import uuid
    from app.db import models
    from app.db.session import SessionLocal
    from app.main import app  # noqa: F401  (creates the database)
    db = SessionLocal()
    try:
        user = models.User(username=f"ov-{uuid.uuid4().hex[:8]}", hashed_password="x")
        db.add(user); db.commit()
        ws = models.Workspace(name="Books", user_id=user.id); db.add(ws); db.commit()
        book, note = tmp_path / "effi-briest.pdf", tmp_path / "note.txt"
        db.add_all([models.Document(filename="effi-briest.pdf", filepath=str(book), workspace_id=ws.id, status="indexed", summary_status="done"),
                    models.Document(filename="note.txt", filepath=str(note), workspace_id=ws.id, status="indexed", summary_status="small")])
        db.commit(); ws_id = ws.id
    finally:
        db.close()
    monkeypatch.setattr(S, "load", lambda p: {"document": "Effi marries Baron Innstetten.\nNames: Innstetten (husband), Rollo (dog)",
                                              "sections": [{"pages": [1, 284]}]} if p == str(book) else None)
    text = S.overview_for(ws_id, [str(note), str(book)])
    assert text.startswith("[Summary of effi-briest.pdf, the whole document (pages 1-284); written by StarkLLM, not a quote") and "Rollo (dog)" in text
    assert S.overview_for(ws_id, [str(note)]) == "" and S.overview_for(ws_id, []) == ""


def test_every_summary_request_names_the_language_of_the_document(monkeypatch):
    # a small model wrote English summaries of a German novel (eval/large-docs, qwen2.5:3b)
    asked = []
    monkeypatch.setattr(S, "_ask", lambda instruction, text, max_words, stop=None: asked.append(instruction) or "s")
    text = "Effi Briest war die Tochter des Ritterschaftsrats von Briest. Sie und ihre Mutter saßen im Garten, und die Sonne schien auf das Haus. " * 30
    S.build([chunk(text, p) for p in range(1, 31)], name="effi-briest.pdf")
    assert asked and all(a.endswith("Write in German.") for a in asked)
def test_after_a_restart_the_progress_starts_at_the_saved_sections(monkeypatch):
    # N43: the status fell from 44 % to 2 % and climbed again while the saved sections were taken over
    monkeypatch.setattr(S, "_ask", lambda instruction, text, max_words, stop=None: "s")
    chunks = [chunk("x" * 3000, p) for p in range(1, 61)]
    first = S.build(chunks, name="moby-dick.pdf")
    seen = []
    S.build(chunks, name="moby-dick.pdf", previous={"sections": first["sections"][:8]}, progress=lambda d, t: seen.append(d))
    assert seen[0] == 8 and seen == sorted(seen)
def test_the_workspace_in_use_goes_first(monkeypatch):
    # N28: the queue went by document number, so an old workspace's big book came before the books being asked about
    assert S._choose({7: 4, 52: 6, 53: 6}, None) == 7
    assert S._choose({7: 4, 52: 6, 53: 6}, 6) == 52
    assert S._choose({7: 4}, 6) == 7
    assert S._choose({}, 6) is None
    monkeypatch.setattr(S, "_active_workspace", None)
    S.note_chat(6)
    assert S._workspace_in_use() == 6
    monkeypatch.setattr(S, "_active_since", S.time.time() - S.ACTIVE_FOR_S - 1)
    assert S._workspace_in_use() is None


def test_a_build_steps_aside_for_the_workspace_in_use_and_keeps_its_progress(monkeypatch):
    monkeypatch.setattr(S, "_ask", lambda instruction, text, max_words, stop=None: "s")
    chunks = [chunk("x" * 3000, p) for p in range(1, 61)]
    saved, asked = [], iter([False, False, True])
    try:
        S.build(chunks, name="big-book.pdf", save=lambda r: saved.append(len(r["sections"])), yield_to=lambda: next(asked))
        assert False, "should have stepped aside"
    except S.Yielded:
        pass
    assert saved == [3]  # the three sections written before are kept for the next run
    # it steps aside only for a waiting document of another workspace that is in use
    monkeypatch.setattr(S, "_pending", {52: 6})
    monkeypatch.setattr(S, "_workspace_in_use", lambda: 6)
    assert S._should_yield(4) and not S._should_yield(6)
    monkeypatch.setattr(S, "_workspace_in_use", lambda: None)
    assert not S._should_yield(4)
