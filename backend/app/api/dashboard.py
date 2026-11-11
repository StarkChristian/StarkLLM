"""
Dashboard aggregate stats endpoint.
Returns all summary statistics in a single request to avoid N+1 frontend queries.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user

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

import httpx
from fastapi import HTTPException

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
    headers = {"User-Agent": "Mozilla/5.0"}
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, timeout=5.0)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to fetch market data: {str(e)}")


import time as _time

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
    }

    # Probe Ollama
    ollama_url = app_settings.OLLAMA_BASE_URL
    t0 = _time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            tags_resp = await client.get(f"{ollama_url}/api/tags")
            tags_resp.raise_for_status()
            latency = round((_time.monotonic() - t0) * 1000)
            result["ollama"]["status"] = "online"
            result["ollama"]["latency_ms"] = latency
            result["ollama"]["error"] = None

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

    except httpx.ConnectError:
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


def _dates_cached(text: str):
    """find_dates for a page text, computed once per text (the home page is opened often, letters rarely change)."""
    from app.services.dates_service import find_dates
    import hashlib
    from datetime import date
    # a date without a year ("bis zum 15.12.") is read relative to today when the letter has no date of its own
    key = date.today().isoformat() + hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()
    if key not in _DATES_CACHE:
        if len(_DATES_CACHE) > 20000:
            _DATES_CACHE.clear()
        _DATES_CACHE[key] = find_dates(text)
    return _DATES_CACHE[key]


def document_dates(db, user_id: int, workspace_id: int = None, include_kb: bool = True, past_days: int = HOME_PAST_DAYS):
    """Newest documents and the dates found in them (deadlines, payments, appointments), oldest date first.
    workspace_id limits the search to one workspace (and the knowledge base when include_kb). Used by the home page
    and by the chat, which hands these dates to the model for questions like "what is due in the next two weeks?"."""
    from datetime import date, timedelta
    from app.services.dates_service import find_dates, letter_date, replaced_letters, sender
    from app.services.document_checks import findings
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
    items.sort(key=lambda i: i["added"] or "", reverse=True)
    items = items[:HOME_SCAN]

    today = date.today()
    first = today - timedelta(days=past_days)
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

    # a corrected letter ("ersetzt die Abrechnung vom 20.10.2026") replaces the earlier one from the same sender: the
    # earlier letter's dates and amounts are no longer valid and are not shown
    replaced = set()
    letters = []
    for pages in pages_of:
        full = "\n".join(text for _, text in sorted(pages.items()))
        letters.append((sender(full), letter_date(full)))
        for when in replaced_letters(full):
            replaced.add((sender(full), when))
    dates = []
    for item, pages, letter in zip(items, pages_of, letters):
        if letter[1] and letter in replaced:
            item["replaced"] = True
            continue
        full = "\n".join(text for _, text in sorted(pages.items()))
        if any(f["kind"] in ("scam_signs", "ai_instructions") for f in findings([{"file": item["filename"], "text": full}])):
            item["suspicious"] = True  # a scam's "deadline" is not something to do
            continue
        for page, text in sorted(pages.items()):
            for f in _dates_cached(text):
                if f.date < first.isoformat():
                    continue
                dates.append({**f.__dict__, "page": page, "passed": f.date < today.isoformat(),
                              "scope": item["scope"], "document_id": item["id"], "workspace_id": item["workspace_id"],
                              "filename": item["filename"]})
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


def _ics_text(value: str) -> str:
    return (value or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_fold(line: str) -> str:
    """iCalendar lines are at most 75 octets; longer ones continue on lines that start with a space."""
    out, current = [], ""
    for ch in line:
        if len((current + ch).encode()) > 73:
            out.append(current)
            current = " "
        current += ch
    out.append(current)
    return "\r\n".join(out)


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
        day = d["date"].replace("-", "")
        title = f"{names.get(d['kind'], 'Date')}: {d['filename']}" + (f" ({d['amount']})" if d.get("amount") else "")
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
