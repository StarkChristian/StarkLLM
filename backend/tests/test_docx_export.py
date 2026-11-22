"""Chats as Word documents (R1 of docs/roadmap-2026-12.md): the Markdown of answers becomes Word formatting."""
import io

from docx import Document

from app.services.docx_export import chat_to_docx

ANSWER = """## Your electricity bill

The bill is **€ 84.20**, due on *15 December*. Pay it with the reference `INV-2291`.

1. Check the meter reading
2. Pay before the date
   - by transfer
   - or by direct debit

| Month | Amount |
| --- | --- |
| October | € 80.10 |
| November | € 84.20 |

> The supplier raised the price in October.

```
total = 80.10 + 84.20
```

More at [the supplier](https://example.com/prices).
"""


def _doc(messages, **kw):
    return Document(io.BytesIO(chat_to_docx("Bills", messages, **kw)))


def _all_text(doc):
    parts = [p.text for p in doc.paragraphs]
    for t in doc.tables:
        for row in t.rows:
            parts.extend(c.text for c in row.cells)
    return "\n".join(parts)


def test_markdown_becomes_word_formatting():
    doc = _doc([{"role": "user", "content": "What does the bill say?"},
                {"role": "assistant", "content": ANSWER, "sources": ["bill.pdf, page 1"]}])
    text = _all_text(doc)
    # no Markdown symbols left
    for raw in ("**", "## ", "| ---", "```", "](http"):
        assert raw not in text, raw
    headings = [p for p in doc.paragraphs if p.style.name.startswith("Heading")]
    assert [h.text for h in headings] == ["Bills", "Your electricity bill"]
    bold = [r.text for p in doc.paragraphs for r in p.runs if r.bold]
    assert "€ 84.20" in bold
    italic = [r.text for p in doc.paragraphs for r in p.runs if r.italic]
    assert "15 December" in italic
    code = [r.text for p in doc.paragraphs for r in p.runs if r.font.name == "Consolas"]
    assert "INV-2291" in code and any("total = 80.10" in c for c in code)
    assert len(doc.tables) == 1
    assert [c.text for c in doc.tables[0].rows[2].cells] == ["November", "€ 84.20"]
    bullets = [p.text for p in doc.paragraphs if p.style.name.startswith("List Bullet")]
    assert bullets == ["by transfer", "or by direct debit"]
    assert "1. Check the meter reading" in text
    assert "The supplier raised the price in October." in text
    assert "Sources: bill.pdf, page 1" in text
    # the link is a real link to an http address
    rels = [r.target_ref for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
    assert rels == ["https://example.com/prices"]


def test_labels_in_the_users_language_and_only_chat_messages():
    doc = _doc([{"role": "system", "content": "Uploading…"}, {"role": "user", "content": "Hallo"},
                {"role": "assistant", "content": "Guten Tag"}],
               labels={"user": "Sie", "assistant": "StarkLLM", "sources": "Quellen", "exported": "Aus StarkLLM exportiert"},
               date_text="22.11.2026")
    text = _all_text(doc)
    assert "Uploading" not in text
    assert "Sie" in text and "Aus StarkLLM exportiert · 22.11.2026" in text


def test_odd_input_does_not_break_the_file():
    nasty = "a\x00b\x07c | not | a table\n**unclosed bold\n[link](javascript:alert(1))\n" + "x" * 5000
    doc = _doc([{"role": "assistant", "content": nasty}])
    text = _all_text(doc)
    assert "abc" in text
    rels = [r.target_ref for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
    assert rels == []  # only http(s) and mailto become links
    assert "javascript:alert(1)" in text  # shown as text


def test_the_route_needs_a_user_and_returns_a_docx():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    r = client.post("/api/v1/chat/export/docx", json={"title": "x", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code in (401, 403)


def test_a_signed_in_user_gets_the_word_file():
    import uuid
    from fastapi.testclient import TestClient
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.main import app
    name = f"export_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        db.add(models.User(username=name, hashed_password=get_password_hash("x" * 12)))
        db.commit()
    finally:
        db.close()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    r = TestClient(app).post("/api/v1/chat/export/docx", headers=headers, json={
        "title": "Bills", "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "**Hello**", "sources": ["a.pdf"]}],
        "labels": {"user": "You"}})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    doc = Document(io.BytesIO(r.content))
    assert "Hello" in _all_text(doc)
