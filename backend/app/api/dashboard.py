"""
Dashboard aggregate stats endpoint.
Returns all summary statistics in a single request to avoid N+1 frontend queries.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user
from app.services.deadlines_service import ics_text as _ics_text, ics_fold as _ics_fold
from app.core import netguard
import asyncio
import re
import requests
from app.core.protection import protection

router = APIRouter()


@router.get("/stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return workspace count, document count, KB stats and chat count in one query."""
    user_id = current_user.id

    # Workspace count
    workspace_count = (
        db.query(func.count(models.Workspace.id))
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # Document count (across all workspaces)
    doc_count = (
        db.query(func.count(models.Document.id))
        .join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id, models.Document.status == models.DocStatus.INDEXED)
        .scalar()
    )

    # Chat count (across all workspaces)
    chat_count = (
        db.query(func.count(models.Chat.id))
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # Message count
    message_count = (
        db.query(func.count(models.Message.id))
        .join(models.Chat, models.Message.chat_id == models.Chat.id)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # KB folders count
    kb_folder_count = (
        db.query(func.count(models.KnowledgeBaseFolder.id))
        .filter(models.KnowledgeBaseFolder.user_id == user_id)
        .scalar()
    )

    # KB documents count (indexed ones)
    kb_doc_count = (
        db.query(func.count(models.KnowledgeBaseDocument.id))
        .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
        .filter(
            models.KnowledgeBaseFolder.user_id == user_id,
            models.KnowledgeBaseDocument.status == "indexed",
        )
        .scalar()
    )

    return {
        "workspaces": workspace_count or 0,
        "documents": doc_count or 0,
        "chats": chat_count or 0,
        "messages": message_count or 0,
        "kb_folders": kb_folder_count or 0,
        "kb_documents": kb_doc_count or 0,
    }

from fastapi import HTTPException


def _fetch_market_json(feature: str, url: str, headers: dict = None) -> dict:
    resp = netguard.get(url, feature=feature, headers=headers or {}, timeout=5.0)
    resp.raise_for_status()
    return resp.json()


@router.get("/market-prices")
async def get_market_prices(symbol: str, consent: int = 0, current_user: models.User = Depends(get_current_user)):
    """Proxy Yahoo Finance API to avoid frontend CORS issues.

    This is the only dashboard call that leaves the PC, so it only runs after the user switched live prices on
    in the widget (the widget then sends consent=1). Without consent nothing is requested from the internet."""
    if consent != 1:
        raise HTTPException(status_code=403, detail="Live market prices are off. Turn them on in the dashboard widget to allow this external request.")
    if symbol not in ["GC=F", "BZ=F"]:
        raise HTTPException(status_code=400, detail="Invalid symbol")

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        return await asyncio.to_thread(_fetch_market_json, "market_prices", url, {"User-Agent": "Mozilla/5.0"})
    except netguard.OfflineBlocked as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch market data: {str(e)}")


@router.get("/crypto-prices")
async def get_crypto_prices(ids: str, consent: int = 0, current_user: models.User = Depends(get_current_user)):
    """CoinGecko prices for the dashboard widget, fetched by the engine so that the request is recorded in the network
    activity list and refused in fully offline mode (the browser used to ask CoinGecko directly)."""
    if consent != 1:
        raise HTTPException(status_code=403, detail="Live market prices are off. Turn them on in the dashboard widget to allow this external request.")
    wanted = [i for i in ids.split(",") if re.fullmatch(r"[a-z0-9-]{1,40}", i)]
    if not wanted or len(wanted) > 30:
        raise HTTPException(status_code=400, detail="Invalid ids")
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={','.join(wanted)}&vs_currencies=usd&include_24hr_change=true"
    try:
        return await asyncio.to_thread(_fetch_market_json, "market_prices", url)
    except netguard.OfflineBlocked as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch market data: {str(e)}")


import time as _time

# Ollama before 0.17.1 has the "Bleeding Llama" flaw (CVE-2026-7482: memory of the server readable over its API;
# research notes, SecurityWeek, May 2026). StarkLLM installs a current Ollama itself, but an Ollama the user
# installed earlier stays old; the status says so.
MIN_OLLAMA = "0.17.1"


def _version_tuple(v: str):
    try:
        parts = tuple(int(p) for p in str(v).lstrip("v").split("-")[0].split(".")[:3])
        return parts if len(parts) == 3 and parts != (0, 0, 0) else None
    except ValueError:
        return None


def ollama_outdated(version: str) -> bool:
    """True only for a real version below MIN_OLLAMA; unknown or development versions are not flagged."""
    have = _version_tuple(version)
    return bool(have) and have < _version_tuple(MIN_OLLAMA)


@router.get("/system-status")
async def get_system_status(
    current_user: models.User = Depends(get_current_user),
):
    """
    Lightweight health probe of all local services.
    Returns status for: backend, Ollama, text model, embedding model.
    This endpoint is NOT auth-gated for health data but IS token-gated to prevent abuse.
    """
    from app.core.config import settings as app_settings

    result = {
        "backend": {"status": "online", "latency_ms": 0, "error": None},
        "ollama": {"status": "unknown", "latency_ms": None, "url": app_settings.OLLAMA_BASE_URL, "error": None},
        "text_model": {
            "name": app_settings.DEFAULT_TEXT_MODEL,
            "status": "unknown",
            "error": None
        },
        "embedding_model": {
            "name": app_settings.DEFAULT_EMBEDDING_MODEL,
            "status": "unknown",
            "error": None
        },
        "available_models": [],
        # protection at rest: locked = the key has not reached the engine, protected data cannot be read
        "protection": {"enabled": protection.enabled, "locked": protection.locked},
    }

    # Probe Ollama
    ollama_url = app_settings.OLLAMA_BASE_URL
    t0 = _time.monotonic()
    try:
        def probe_ollama():
            tags = netguard.get(f"{ollama_url}/api/tags", feature="ollama", timeout=4.0)
            tags.raise_for_status()
            latency_ms = round((_time.monotonic() - t0) * 1000)
            try:
                version = netguard.get(f"{ollama_url}/api/version", feature="ollama", timeout=4.0).json().get("version", "")
            except Exception:
                version = ""
            return tags, latency_ms, version

        tags_resp, latency, version = await asyncio.to_thread(probe_ollama)
        result["ollama"]["status"] = "online"
        result["ollama"]["latency_ms"] = latency
        result["ollama"]["error"] = None
        result["ollama"]["version"] = version or None
        result["ollama"]["min_version"] = MIN_OLLAMA
        result["ollama"]["outdated"] = ollama_outdated(version)

        models_raw = tags_resp.json().get("models", [])
        available = [m.get("name", "") for m in models_raw]
        result["available_models"] = available

        # Check if configured models are present
        text_model = app_settings.DEFAULT_TEXT_MODEL
        embed_model = app_settings.DEFAULT_EMBEDDING_MODEL

        def _model_present(name: str, available: list[str]) -> bool:
            """Exact match; a name without a tag means ':latest' (Ollama's own rule).
            'qwen2.5:7b' must NOT be satisfied by 'qwen2.5vl:7b'."""
            norm = lambda n: n if ":" in n else n + ":latest"
            return norm(name) in {norm(a) for a in available}

        text_model_present = _model_present(text_model, available)
        embed_model_present = _model_present(embed_model, available)

        result["text_model"]["status"] = "online" if text_model_present else "missing"
        result["text_model"]["error"] = None if text_model_present else f"Model '{text_model}' is missing. Run 'ollama pull {text_model}' in your terminal."

        result["embedding_model"]["status"] = "online" if embed_model_present else "missing"
        result["embedding_model"]["error"] = None if embed_model_present else f"Model '{embed_model}' is missing. Run 'ollama pull {embed_model}' in your terminal."

    except requests.exceptions.ConnectionError:
        result["ollama"]["status"] = "offline"
        result["ollama"]["error"] = "Ollama is unreachable. Ensure Ollama is installed and running (e.g. 'ollama serve')."
        result["text_model"]["status"] = "offline"
        result["text_model"]["error"] = "Cannot check model (Ollama is offline)."
        result["embedding_model"]["status"] = "offline"
        result["embedding_model"]["error"] = "Cannot check model (Ollama is offline)."
    except Exception as e:
        result["ollama"]["status"] = "degraded"
        result["ollama"]["error"] = f"Ollama connection error: {str(e)}"
        result["text_model"]["status"] = "unknown"
        result["embedding_model"]["status"] = "unknown"

    return result



# ---------------------------------------------------------------- the document home (overview page)

HOME_RECENT = 8
HOME_SCAN = 5000        # documents searched for dates (all of a household; the text is read once per collection)
HOME_PAST_DAYS = 14     # dates that passed lately stay visible, marked as passed
HOME_DATES = 20


def _pages_by_document(collection):
    """All indexed text of a collection, joined per document and page: ({source: {page: text}}, {document_id: {...}})."""
    got = collection.get(include=["documents", "metadatas"])
    parts_source, parts_id = {}, {}
    for text, meta in zip(got.get("documents") or [], got.get("metadatas") or []):
        meta = meta or {}
        try:
            page = int(meta["page"]) + 1 if meta.get("page") is not None else 1
        except (TypeError, ValueError):
            page = 1
        entry = (meta.get("chunk") or meta.get("chunk_index") or 0, text or "")
        if meta.get("source"):
            parts_source.setdefault(meta["source"], {}).setdefault(page, []).append(entry)
        if meta.get("document_id") is not None:
            parts_id.setdefault(meta["document_id"], {}).setdefault(page, []).append(entry)

    def join(parts):
        return {doc: {p: "\n\n".join(t for _, t in sorted(items, key=lambda x: x[0])) for p, items in pages.items()}
                for doc, pages in parts.items()}
    return join(parts_source), join(parts_id)


def _pages_by_where(collection, where: dict) -> dict:
    """Indexed text of one document, joined per page (1-based)."""
    try:
        got = collection.get(where=where, include=["documents", "metadatas"])
    except Exception:
        return {}
    parts = {}
    for text, meta in zip(got.get("documents") or [], got.get("metadatas") or []):
        meta = meta or {}
        try:
            page = int(meta["page"]) + 1 if meta.get("page") is not None else 1
        except (TypeError, ValueError):
            page = 1
        parts.setdefault(page, []).append((meta.get("chunk") or meta.get("chunk_index") or 0, text or ""))
    return {p: "\n\n".join(t for _, t in sorted(items, key=lambda x: x[0])) for p, items in parts.items()}


_DATES_CACHE: dict = {}


def _dates_cached(text: str, order_hint=None):
    """find_dates for a page text, computed once per text (the home page is opened often, letters rarely change).
    order_hint: how the whole document writes slash dates, when the page alone does not show it."""
    from app.services.dates_service import find_dates
    import hashlib
    from datetime import date
    # a date without a year ("bis zum 15.12.") is read relative to today when the letter has no date of its own
    key = date.today().isoformat() + str(order_hint) + hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()
    if key not in _DATES_CACHE:
        if len(_DATES_CACHE) > 20000:
            _DATES_CACHE.clear()
        _DATES_CACHE[key] = find_dates(text, order_hint=order_hint)
    return _DATES_CACHE[key]


def date_choices(db, user_id: int) -> dict:
    """The user's readings of ambiguous dates: {(scope, document_id, "03/04/2026"): "dmy" | "mdy"}."""
    return {(c.scope, c.document_id, c.literal): c.reading
            for c in db.query(models.DateChoice).filter(models.DateChoice.user_id == user_id).all()}


def documents_with_pages(db, user_id: int, workspace_id: int = None, include_kb: bool = True):
    """The user's indexed documents, newest first, each with its indexed text per page: (items, pages_of).
    workspace_id limits it to one workspace (and the knowledge base when include_kb)."""
    from app.services.rag_service import rag_service

    q = (db.query(models.Document, models.Workspace)
         .join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
         .filter(models.Workspace.user_id == user_id, models.Document.status == models.DocStatus.INDEXED))
    if workspace_id is not None:
        q = q.filter(models.Workspace.id == workspace_id)
    ws_docs = q.order_by(models.Document.created_at.desc()).limit(HOME_SCAN).all()
    kb_docs = []
    if include_kb:
        kb_docs = (
            db.query(models.KnowledgeBaseDocument)
            .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
            .filter(models.KnowledgeBaseFolder.user_id == user_id, models.KnowledgeBaseDocument.status == "indexed")
            .order_by(models.KnowledgeBaseDocument.indexed_at.desc())
            .limit(HOME_SCAN)
            .all()
        )

    items = []
    for doc, ws in ws_docs:
        items.append({"scope": "ws", "id": doc.id, "workspace_id": ws.id, "workspace": ws.name, "filename": doc.filename,
                      "file_type": doc.file_type, "added": doc.created_at.isoformat() if doc.created_at else None,
                      "_where": ("ws", ws.id, {"source": doc.filepath})})
    for doc in kb_docs:
        added = doc.indexed_at or doc.created_at
        items.append({"scope": "kb", "id": doc.id, "workspace_id": None, "workspace": None, "filename": doc.file_name,
                      "file_type": doc.file_type, "added": added.isoformat() if added else None,
                      "_where": ("kb", None, {"document_id": doc.id})})
    # newest first; at the same time stamp the later row first (Windows clocks tick in steps of about 15 ms, so two
    # documents added together can carry the same time on the engine without Docker)
    items.sort(key=lambda i: (i["added"] or "", i["id"]), reverse=True)
    items = items[:HOME_SCAN]

    # one read per collection, not one per document: the home page stayed limited to the newest 60 documents, and a
    # household with more letters lost their deadlines (long test with 120 letters: 65 of 127 dates missing)
    pages_by_collection = {}
    pages_of = []
    for item in items:
        scope, ws_id, where = item.pop("_where")
        key = (scope, ws_id)
        if key not in pages_by_collection:
            try:
                col = (rag_service.get_or_create_kb_collection(user_id) if scope == "kb"
                       else rag_service.get_or_create_collection(ws_id, user_id))
                pages_by_collection[key] = _pages_by_document(col)
            except Exception:
                pages_by_collection[key] = ({}, {})
        by_source, by_doc_id = pages_by_collection[key]
        field, value = next(iter(where.items()))
        pages_of.append((by_doc_id if field == "document_id" else by_source).get(value, {}))
    return items, pages_of


def replaced_documents(pages_of) -> list:
    """For each document: True when a later letter of the same sender says it replaces it
    ("ersetzt die Abrechnung vom 20.10.2026")."""
    from app.services.dates_service import letter_date, replaced_letters, sender
    from app.services.facts_service import is_long_document
    replaced, letters = set(), []
    for pages in pages_of:
        if is_long_document(pages):
            letters.append((None, None))  # a book is no letter: reading all of it on every home page cost seconds
            continue
        full = "\n".join(text for _, text in sorted(pages.items()))
        letters.append((sender(full), letter_date(full)))
        for when in replaced_letters(full):
            replaced.add((sender(full), when))
    return [bool(letter[1] and letter in replaced) for letter in letters]


def _describe_letter(item: dict, facts: dict, pages: dict):
    """Sender, kind and first page of a letter, for the chat's list of all letters (services/payments_overview.py)."""
    item["sender"] = (facts.get("sender") or {}).get("value")
    item["letter_kind"] = (facts.get("type") or {}).get("value")
    item["first_page"] = min(pages) if pages else 1


def document_dates(db, user_id: int, workspace_id: int = None, include_kb: bool = True, past_days: int = HOME_PAST_DAYS):
    """Newest documents and the dates found in them (deadlines, payments, appointments), oldest date first.
    workspace_id limits the search to one workspace (and the knowledge base when include_kb). Used by the home page
    and by the chat, which hands these dates to the model for questions like "what is due in the next two weeks?"."""
    from datetime import date, timedelta
    from app.services.document_checks import findings
    from app.services.facts_service import is_long_document, is_machine_document

    items, pages_of = documents_with_pages(db, user_id, workspace_id, include_kb)
    today = date.today()
    first = today - timedelta(days=past_days)

    # a corrected letter ("ersetzt die Abrechnung vom 20.10.2026") replaces the earlier one from the same sender: the
    # earlier letter's dates and amounts are no longer valid and are not shown
    # The same rules as the deadlines list (deadlines_service): only letters have dates (a log file's timestamps are
    # none), and a letter, its copy and the photo of it are one date, read from the oldest of them.
    from app.services.deadlines_service import counts_as_letter, same_deadline, _norm_ref
    from app.services.facts_service import document_facts_cached
    dates, seen_fp = [], {}
    choices = date_choices(db, user_id)
    replaced = replaced_documents(pages_of)
    order = sorted(range(len(items)), key=lambda i: (items[i]["added"] or "", items[i]["scope"], items[i]["id"]))
    for i in order:
        item, pages = items[i], pages_of[i]
        if replaced[i]:
            item["replaced"] = True
            continue
        if is_long_document(pages):
            continue  # a book, manual or report (N30/N31: four books made the home page take 9 s, and got scam badges)
        if is_machine_document(pages, item["filename"]):
            continue  # a log, table, JSON or note: its timestamps and dates are not deadlines
        full = "\n".join(text for _, text in sorted(pages.items()))
        kinds = {f["kind"] for f in findings([{"file": item["filename"], "text": full}])}
        if kinds & {"ai_instructions", "hidden_text"}:
            item["ai_note"] = True  # the note is ignored: the letter's own dates and amounts stay (MSI §43)
        if "scam_signs" in kinds:
            item["suspicious"] = True  # a scam's "deadline" is not something to do
            facts = document_facts_cached(pages, item["filename"])
            _describe_letter(item, facts, pages)
            item["is_letter"] = bool(facts.get("letter"))
            item["asked_amount"] = next((a.get("value") for a in facts.get("amounts", []) if a.get("value")), None)
            item["excerpt"] = (pages.get(item["first_page"]) or "")[:700]
            continue
        facts = document_facts_cached(pages, item["filename"])
        _describe_letter(item, facts, pages)
        if not counts_as_letter({"facts": facts, "file_type": item.get("file_type")}):
            continue
        item["is_letter"] = True
        fp = facts.get("fingerprint")
        if fp and fp in seen_fp:
            item["duplicate"] = True
            continue  # the same text as an earlier document: its dates are already there
        if fp:
            seen_fp[fp] = i
        refs = {_norm_ref(r["value"]) for r in facts.get("references", [])}
        from app.services.dates_service import choose_reading, date_order_evidence
        hint = date_order_evidence(full)
        for page, text in sorted(pages.items()):
            for f in _dates_cached(text, hint):
                d = choose_reading({**f.__dict__}, choices.get((item["scope"], item["id"], f.literal)))
                latest = max([d["date"], *(d.get("readings") or {}).values()])  # an open date counts by its later reading
                if latest < first.isoformat():
                    continue
                entry = {**d, "page": page, "passed": latest < today.isoformat(),
                         "scope": item["scope"], "document_id": item["id"], "workspace_id": item["workspace_id"],
                         "filename": item["filename"]}
                reading = {"kind": d["kind"], "date": d["date"], "amount": d.get("amount"), "case": facts.get("case"), "refs": refs,
                           "notice": bool(d.get("notice"))}
                if any(same_deadline(reading, x["_reading"]) for x in dates):
                    continue  # the photo of a letter, read slightly differently
                dates.append({**entry, "_reading": reading})
    for d in dates:
        d.pop("_reading")
    dates.sort(key=lambda d: (d["date"], d["filename"]))
    return today, items, dates


@router.get("/home")
def get_document_home(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The newest documents (workspaces and knowledge-base folders) and the deadlines and payment dates in them.
    Dates come from fixed rules over the indexed text, so each one is in the document, with its sentence and page."""
    today, items, dates = document_dates(db, current_user.id)
    return {"today": today.isoformat(), "recent": items[:HOME_RECENT], "dates": dates[:HOME_DATES]}


INBOX_NEW_DAYS = 30  # documents without a decision count as new when added in the last 30 days (older ones were
                     # there before the inbox existed; they are in their cases, not in the list of new letters)
CASE_KINDS = ("deadline", "payment", "appointment")
# (user id, scope, document id) -> whether the document is a letter (facts_service: "letter"). Filled by
# document_inbox, read by the sidebar count, which runs every 30 s and should not read every document's text.
_IS_LETTER: dict = {}


def _next_date(facts: dict, today: str):
    # an ambiguous date ("03/04/2026") is never "next": the user has to choose how to read it first
    upcoming = [d for d in facts.get("dates", []) if d.get("kind") in CASE_KINDS and not d.get("ambiguous") and d["value"] >= today]
    return min(upcoming, key=lambda d: d["value"]) if upcoming else None


def document_inbox(db, user_id: int) -> dict:
    """Every indexed document with its facts (facts_service) and the user's decision; the new ones first; and the
    documents grouped into cases by sender."""
    from datetime import date, datetime, timedelta
    from app.services.facts_service import document_facts_cached

    items, pages_of = documents_with_pages(db, user_id)
    reviews = {(r.scope, r.document_id): r for r in
               db.query(models.DocumentReview).filter(models.DocumentReview.user_id == user_id).all()}
    today = date.today().isoformat()
    recent = (datetime.utcnow() - timedelta(days=INBOX_NEW_DAYS)).isoformat()
    choices = date_choices(db, user_id)
    docs = []
    for item, pages, is_replaced in zip(items, pages_of, replaced_documents(pages_of)):
        facts = document_facts_cached(pages, item["filename"])
        if any(d.get("ambiguous") for d in facts.get("dates", [])):  # the user's choice is not part of the cached facts
            from app.services.dates_service import choose_reading
            facts = {**facts, "dates": [choose_reading(d, choices.get((item["scope"], item["id"], d.get("literal"))))
                                        for d in facts["dates"]]}
        review = reviews.get((item["scope"], item["id"]))
        # only real signs of a scam make a letter "suspicious"; a note to AI assistants or hidden text alone is ignored
        # and the letter stays a normal bill with its date, shown with a calm "check before paying" (2.6.1)
        warned = set(facts.get("warnings") or [])
        suspicious = "scam_signs" in warned
        ai_note = not suspicious and bool(warned & {"ai_instructions", "hidden_text"})
        _IS_LETTER[(user_id, item["scope"], item["id"])] = bool(facts.get("letter"))
        # a note, manual, spreadsheet or photo is listed under all documents, but not among the new letters
        status = review.status if review else ("new" if facts.get("letter") and (item["added"] or "") >= recent else "done")
        docs.append({**item, "facts": facts, "status": status, "title": review.title if review else None,
                     "case": (review.case_key if review and review.case_key else facts.get("case")),
                     "replaced": is_replaced, "suspicious": suspicious, "ai_note": ai_note,
                     "next": None if is_replaced or suspicious else _next_date(facts, today)})

    # the same letter twice (a photo and the PDF, or added twice): the same text after OCR noise is removed
    first_of = {}
    for doc in sorted(docs, key=lambda d: d["added"] or ""):
        fp = doc["facts"].get("fingerprint")
        if not fp:
            continue
        if fp in first_of:
            doc["duplicate_of"] = {"scope": first_of[fp]["scope"], "id": first_of[fp]["id"], "filename": first_of[fp]["filename"]}
        else:
            first_of[fp] = doc

    cases = {}
    for doc in docs:
        key = doc["case"]
        if not key:
            continue
        c = cases.setdefault(key, {"key": key, "name": None, "documents": [], "references": [], "next": None,
                                   "suspicious": 0, "latest": None})
        c["documents"].append({"scope": doc["scope"], "id": doc["id"]})
        sender = doc["facts"].get("sender")
        if sender and not c["name"]:
            c["name"] = sender["value"]  # docs are newest first: the newest letter names the case
        for r in doc["facts"].get("references", []):
            if r["value"] not in [x["value"] for x in c["references"]]:
                c["references"].append({"kind": r["kind"], "value": r["value"]})
        if doc["next"] and (not c["next"] or doc["next"]["value"] < c["next"]["value"]):
            c["next"] = {**doc["next"], "filename": doc["filename"]}
        c["suspicious"] += 1 if doc["suspicious"] else 0
        c["latest"] = max(filter(None, [c["latest"], doc["added"]]), default=None)
    ordered = sorted(cases.values(), key=lambda c: ((c["next"] or {}).get("value") or "9999", -(len(c["documents"]))))
    return {"today": today, "documents": docs, "cases": ordered, "new_count": sum(1 for d in docs if d["status"] == "new")}


@router.get("/inbox")
def get_inbox(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The document inbox: every document with its facts, each fact with the page and line it was read from, the
    user's decision (new or done, own title, case) and the cases (letters of one sender). Made by rules on this PC."""
    return document_inbox(db, current_user.id)


@router.get("/inbox/count")
def get_inbox_count(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """How many documents are new in the inbox, for the number next to "Inbox" in the sidebar. Reads only the
    database (the same rule as document_inbox: a letter with no decision added in the last INBOX_NEW_DAYS days, or
    marked new). Whether a document is a letter comes from the last inbox build; an unknown one builds it once."""
    from datetime import datetime, timedelta
    recent = datetime.utcnow() - timedelta(days=INBOX_NEW_DAYS)
    reviews = {(r.scope, r.document_id): r.status for r in
               db.query(models.DocumentReview).filter(models.DocumentReview.user_id == current_user.id).all()}
    ws = (db.query(models.Document.id, models.Document.created_at)
          .join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
          .filter(models.Workspace.user_id == current_user.id, models.Document.status == models.DocStatus.INDEXED).all())
    kb = (db.query(models.KnowledgeBaseDocument.id, models.KnowledgeBaseDocument.indexed_at, models.KnowledgeBaseDocument.created_at)
          .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
          .filter(models.KnowledgeBaseFolder.user_id == current_user.id, models.KnowledgeBaseDocument.status == "indexed").all())
    rows = [("ws", i, added) for i, added in ws] + [("kb", i, indexed or created) for i, indexed, created in kb]
    undecided = [(scope, i) for scope, i, added in rows if (scope, i) not in reviews and added and added >= recent]
    if any((current_user.id, scope, i) not in _IS_LETTER for scope, i in undecided):
        return {"new_count": document_inbox(db, current_user.id)["new_count"]}
    new = sum(1 for scope, i, _ in rows if reviews.get((scope, i)) == "new")
    new += sum(1 for scope, i in undecided if _IS_LETTER[(current_user.id, scope, i)])
    return {"new_count": new}


class DateChoiceIn(BaseModel):
    literal: str = Field(..., max_length=20)  # the date as written in the document, "03/04/2026"
    reading: Optional[str] = Field(None, pattern="^(dmy|mdy)$")  # day first, month first; none: choose again


class ReviewIn(BaseModel):
    status: Optional[str] = Field(None, pattern="^(new|done)$")
    title: Optional[str] = Field(None, max_length=200)
    case: Optional[str] = Field(None, max_length=120)


def _owns(db, user_id: int, scope: str, document_id: int) -> bool:
    if scope == "ws":
        return db.query(models.Document).join(models.Workspace, models.Document.workspace_id == models.Workspace.id) \
            .filter(models.Document.id == document_id, models.Workspace.user_id == user_id).first() is not None
    if scope == "kb":
        return db.query(models.KnowledgeBaseDocument) \
            .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id) \
            .filter(models.KnowledgeBaseDocument.id == document_id, models.KnowledgeBaseFolder.user_id == user_id).first() is not None
    return False


def _review(db, user_id: int, scope: str, document_id: int):
    r = db.query(models.DocumentReview).filter_by(user_id=user_id, scope=scope, document_id=document_id).first()
    if not r:
        r = models.DocumentReview(user_id=user_id, scope=scope, document_id=document_id, status="new")
        db.add(r)
    return r


@router.post("/inbox/{scope}/{document_id}")
def set_review(
    scope: str,
    document_id: int,
    body: ReviewIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Mark a document done or new, give it the user's own title, or put it into another case. Only what is sent
    changes; an empty title or case goes back to StarkLLM's suggestion."""
    if not _owns(db, current_user.id, scope, document_id):
        raise HTTPException(status_code=404, detail="Document not found")
    r = _review(db, current_user.id, scope, document_id)
    sent = body.model_dump(exclude_unset=True)
    if "status" in sent and sent["status"]:
        r.status = sent["status"]
    if "title" in sent:
        r.title = (sent["title"] or "").strip() or None
    if "case" in sent:
        r.case_key = (sent["case"] or "").strip().lower() or None
    db.commit()
    return {"scope": scope, "id": document_id, "status": r.status, "title": r.title, "case": r.case_key}


@router.post("/inbox/{scope}/{document_id}/date")
def set_date_choice(
    scope: str,
    document_id: int,
    body: DateChoiceIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The user says how an ambiguous date of a document ("03/04/2026") is read: day first or month first. Without a
    reading the choice is taken back. Only then does the date count for the deadline list, reminders and calendar."""
    if not _owns(db, current_user.id, scope, document_id):
        raise HTTPException(status_code=404, detail="Document not found")
    rows = [c for c in db.query(models.DateChoice).filter(
        models.DateChoice.user_id == current_user.id, models.DateChoice.scope == scope,
        models.DateChoice.document_id == document_id).all() if c.literal == body.literal]
    if not body.reading:
        for c in rows:
            db.delete(c)
    elif rows:
        rows[0].reading = body.reading
    else:
        db.add(models.DateChoice(user_id=current_user.id, scope=scope, document_id=document_id, literal=body.literal,
                                 reading=body.reading))
    db.commit()
    return {"scope": scope, "id": document_id, "literal": body.literal, "reading": body.reading}


@router.post("/inbox/done")
def set_all_done(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Mark every new document done (for a start with many letters already in StarkLLM)."""
    inbox = document_inbox(db, current_user.id)
    changed = 0
    for doc in inbox["documents"]:
        if doc["status"] == "new":
            _review(db, current_user.id, doc["scope"], doc["id"]).status = "done"
            changed += 1
    db.commit()
    return {"done": changed}


def dates_calendar(today, dates, stamp: str) -> str:
    """The upcoming dates as an iCalendar file: all-day events for deadlines, payments and changes, timed events for
    appointments, each with a reminder (3 days before a deadline or payment, 1 day before an appointment)."""
    import hashlib
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StarkLLM//Document dates//EN", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:StarkLLM"]
    names = {"deadline": "Deadline", "payment": "Payment", "appointment": "Appointment", "change": "Change"}
    for d in dates:
        if d.get("passed"):
            continue
        if d.get("ambiguous"):
            continue  # no calendar entry or reminder for a date the user has not read for us
        day = d["date"].replace("-", "")
        title = f"{'Last day to give notice' if d.get('notice') else names.get(d['kind'], 'Date')}: {d['filename']}" + (f" ({d['amount']})" if d.get("amount") else "")
        uid = hashlib.sha256(f"{d['filename']}|{d['date']}|{d['kind']}".encode()).hexdigest()[:24] + "@starkllm.local"
        lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}"]
        if d["kind"] == "appointment" and d.get("time"):
            hh, mm = d["time"].split(":")
            lines += [f"DTSTART:{day}T{hh}{mm}00", "DURATION:PT1H"]
            alarm = "-P1D"
        else:
            lines += [f"DTSTART;VALUE=DATE:{day}", "DURATION:P1D", "TRANSP:TRANSPARENT"]
            alarm = "-P3D"
        lines += [_ics_fold(f"SUMMARY:{_ics_text(title)}"), _ics_fold(f"DESCRIPTION:{_ics_text(d.get('text', ''))}"),
                  "BEGIN:VALARM", "ACTION:DISPLAY", f"TRIGGER:{alarm}", _ics_fold(f"DESCRIPTION:{_ics_text(title)}"),
                  "END:VALARM", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


@router.get("/dates.ics")
def get_dates_calendar(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The deadlines, payments and appointments of the home page as a calendar file (Outlook, Google, Apple, phone).
    Made on this PC; nothing is sent anywhere."""
    from datetime import datetime, timezone
    from fastapi.responses import Response
    today, _, dates = document_dates(db, current_user.id, past_days=0)
    body = dates_calendar(today, dates, datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="StarkLLM-dates.ics"'})


# ---------------------------------------------------------------- deadlines, reminders, calendar (inbox step B5)

def _deadlines(db, user_id: int):
    """(today, deadlines with their reminders) for the user's inbox letters."""
    from app.services.deadlines_service import add_done, add_reminders, build_deadlines
    inbox = document_inbox(db, user_id)
    rows = db.query(models.DeadlineReminder).filter(models.DeadlineReminder.user_id == user_id).all()
    done = db.query(models.DeadlineDone).filter(models.DeadlineDone.user_id == user_id).all()
    deadlines = add_reminders(build_deadlines(inbox, inbox["today"]), rows, inbox["today"])
    return inbox["today"], add_done(deadlines, done)


@router.get("/deadlines")
def get_deadlines(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Every deadline, payment and appointment of the inbox letters, oldest first, each with the sentence it was read
    from, its page and line, what is due, and the reminders the user set. State: overdue, today, soon (within a
    week) or upcoming. Deadlines the user marked done are in the list with done=true (so the mark can be undone) and
    are not counted. Found by fixed rules in the document text; no model is asked."""
    today, deadlines = _deadlines(db, current_user.id)
    open_ones = [d for d in deadlines if not d["done"]]
    counts = {s: sum(1 for d in open_ones if d["state"] == s) for s in ("overdue", "today", "soon", "upcoming")}
    counts["done"] = len(deadlines) - len(open_ones)
    return {"today": today, "deadlines": deadlines, "counts": counts,
            "reminders_due": sum(1 for d in deadlines if d["reminder_active"])}


class RemindersIn(BaseModel):
    key: str = Field(..., max_length=120)
    days_before: list[int] = Field(default_factory=list, max_length=20)


class AckIn(BaseModel):
    key: str = Field(..., max_length=120)


class DoneIn(BaseModel):
    key: str = Field(..., max_length=120)
    done: bool = True


def _checked_key(db, user_id: int, key: str) -> dict:
    from app.services.deadlines_service import parse_key
    parts = parse_key(key)
    if not parts:
        raise HTTPException(status_code=422, detail="Not a deadline key")
    if not _owns(db, user_id, parts["scope"], parts["document_id"]):
        raise HTTPException(status_code=404, detail="Document not found")
    return parts


def _group(db, user_id: int, key: str):
    """(the deadline's own key parts, the parts of every key in its duplicate group). A letter, its copy and the photo
    of it are one deadline: reminders and the done mark belong to the whole group, whichever document's key is sent."""
    from app.services.deadlines_service import parse_key
    _checked_key(db, user_id, key)
    _, deadlines = _deadlines(db, user_id)
    found = next((d for d in deadlines if key in d["keys"]), None)
    keys = found["keys"] if found else [key]
    return parse_key(found["key"] if found else key), [parse_key(k) for k in keys]


def _group_rows(db, model, user_id: int, group: list):
    from sqlalchemy import and_, or_
    return db.query(model).filter(model.user_id == user_id, or_(*[
        and_(model.scope == g["scope"], model.document_id == g["document_id"], model.due_date == g["due"], model.kind == g["kind"])
        for g in group])).all()


@router.put("/deadlines/reminders")
def set_deadline_reminders(
    body: RemindersIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Set the reminders of one deadline: remind me N days before (0 = on the day). The list replaces the earlier
    one; an empty list removes the reminders. Stored on this PC; the dashboard shows a reminder from its day."""
    from app.services.deadlines_service import MAX_REMINDER_DAYS, MAX_REMINDERS, clean_offsets
    offsets = clean_offsets(body.days_before)
    if offsets is None:
        raise HTTPException(status_code=422, detail=f"Reminders: up to {MAX_REMINDERS}, each 0 to {MAX_REMINDER_DAYS} days before")
    own, group = _group(db, current_user.id, body.key)
    kept = {}
    for row in _group_rows(db, models.DeadlineReminder, current_user.id, group):
        if row.days_before in offsets and row.days_before not in kept:
            kept[row.days_before] = row
        else:
            db.delete(row)
    for days in offsets:
        if days not in kept:
            db.add(models.DeadlineReminder(user_id=current_user.id, scope=own["scope"], document_id=own["document_id"],
                                           due_date=own["due"], kind=own["kind"], days_before=days))
    db.commit()
    return {"key": body.key, "reminders": offsets}


@router.post("/deadlines/reminders/ack")
def acknowledge_deadline_reminders(
    body: AckIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The user saw the reminder: it leaves the dashboard. Reminders for later days of the same deadline stay."""
    from datetime import date, timedelta
    own, group = _group(db, current_user.id, body.key)
    today, due = date.today(), date.fromisoformat(own["due"])
    changed = 0
    for r in _group_rows(db, models.DeadlineReminder, current_user.id, group):
        if due - timedelta(days=r.days_before) <= today and not r.acknowledged:
            r.acknowledged = 1
            changed += 1
    db.commit()
    return {"key": body.key, "acknowledged": changed}


@router.put("/deadlines/done")
def set_deadline_done(
    body: DoneIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Mark one deadline done (a paid invoice) or take the mark back. Independent of the letter, which stays in the
    inbox; a done deadline leaves the dashboard and the calendar file. Stored on this PC."""
    own, group = _group(db, current_user.id, body.key)
    rows = _group_rows(db, models.DeadlineDone, current_user.id, group)
    if body.done and not rows:
        db.add(models.DeadlineDone(user_id=current_user.id, scope=own["scope"], document_id=own["document_id"],
                                   due_date=own["due"], kind=own["kind"]))
    elif not body.done:
        for row in rows:
            db.delete(row)
    db.commit()
    return {"key": body.key, "done": body.done}


@router.get("/deadlines.ics")
def get_deadlines_calendar(
    key: list[str] = Query(default=[]),
    lang: str = Query("en", pattern="^(en|de|es|fr|it|tr)$"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The deadlines as a calendar file (RFC 5545) for Outlook, Google, Apple or a phone: the ones named with `key`
    (one or several), else every deadline from today on; deadlines marked done are left out. All-day events, each with an alarm (the reminders the user
    set, else 3 days before). Made on this PC; nothing is sent anywhere."""
    from datetime import datetime, timezone
    from fastapi.responses import Response
    from app.services.deadlines_service import deadlines_calendar
    today, deadlines = _deadlines(db, current_user.id)
    deadlines = [d for d in deadlines if not d["done"]]
    if key:
        chosen = [d for d in deadlines if d["key"] in set(key)]
        if not chosen:
            raise HTTPException(status_code=404, detail="Deadline not found")
        name = "StarkLLM-deadline.ics" if len(chosen) == 1 else "StarkLLM-deadlines.ics"
    else:
        chosen = [d for d in deadlines if d["state"] != "overdue"]
        name = "StarkLLM-deadlines.ics"
    body = deadlines_calendar(chosen, datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"), lang)
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
