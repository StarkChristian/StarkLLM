"""StarkLLM as an MCP server for other programs on this PC (Claude Desktop, VS Code, Cursor, ...).

Streamable HTTP transport, JSON responses only: POST /mcp with one JSON-RPC message. Same key and switch as the
OpenAI-compatible API (Settings > Other apps). Read-only tools; nothing can be changed or deleted.

Not to be confused with app/api/mcp.py: those are tools StarkLLM's own model can call.
"""
import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, Response

from app.core.config import settings
from app.services import connections_service, document_access

router = APIRouter()
logger = logging.getLogger(__name__)

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

TOOLS = [
    {
        "name": "search_documents",
        "description": "Search the user's letters and documents in StarkLLM (all workspaces and the knowledge base). "
                       "Returns the best matching passages with file name and page.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "What to look for, in any language."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 6}},
            "required": ["query"]},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "ask_documents",
        "description": "Ask a question about the user's documents. StarkLLM's local model answers from the documents "
                       "only, names the files, and adds warnings when a letter looks like a scam.",
        "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "upcoming_dates",
        "description": "Deadlines, payments and appointments found in the user's letters, from today on.",
        "inputSchema": {"type": "object", "properties": {
            "days": {"type": "integer", "minimum": 1, "maximum": 366, "default": 30}}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "list_documents",
        "description": "The user's documents in StarkLLM: file name, workspace, type and when it was added.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    },
]


def _result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def _text(value: Any, is_error: bool = False) -> Dict:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=1)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _call(name: str, args: Dict, user_id: int) -> Dict:
    if name == "search_documents":
        hits = document_access.search(user_id, str(args.get("query") or ""), int(args.get("limit") or 6))
        for h in hits:
            h.pop("_raw", None)
        return _text(hits or "No matching passages.")
    if name == "ask_documents":
        out = document_access.ask(user_id, str(args.get("question") or ""))
        text = out["answer"]
        if out["sources"]:
            text += "\n\nSources: " + ", ".join(out["sources"])
        if out["warnings"]:
            from app.services.document_checks import note
            text = "WARNING: " + " ".join(note(w) for w in out["warnings"]) + "\n\n" + text
        return _text(text)
    if name == "upcoming_dates":
        return _text(document_access.dates(user_id, int(args.get("days") or 30)))
    if name == "list_documents":
        return _text(document_access.documents(user_id))
    return _text(f"Unknown tool: {name}", is_error=True)


@router.get("/mcp")
def mcp_get():
    # no server-initiated stream; clients fall back to plain POST requests
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/mcp")
async def mcp_post(request: Request, authorization: Optional[str] = Header(default=None)):
    try:
        key = connections_service.check(authorization)
    except PermissionError as e:
        return JSONResponse({"error": str(e)}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
    try:
        msg = await request.json()
    except ValueError:
        return JSONResponse(_error(None, -32700, "Parse error"), status_code=400)
    if isinstance(msg, list):
        return JSONResponse(_error(None, -32600, "Batches are not supported"), status_code=400)
    method, msg_id, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if msg_id is None:  # a notification ("notifications/initialized") needs no answer
        return Response(status_code=202)
    user_id = key.get("user_id") or document_access.default_user_id()

    if method == "initialize":
        asked = params.get("protocolVersion")
        return JSONResponse(_result(msg_id, {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "StarkLLM", "version": settings.VERSION},
            "instructions": "StarkLLM holds the user's private letters and documents on this PC. Use search_documents "
                            "or ask_documents for questions about them, upcoming_dates for deadlines. Read only.",
        }))
    if method == "ping":
        return JSONResponse(_result(msg_id, {}))
    if method == "tools/list":
        return JSONResponse(_result(msg_id, {"tools": TOOLS}))
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            import asyncio
            return JSONResponse(_result(msg_id, await asyncio.to_thread(_call, name, args, user_id)))
        except Exception as e:
            logger.error(f"MCP tool {name} failed: {e}", exc_info=True)
            return JSONResponse(_result(msg_id, _text(f"StarkLLM could not run {name}: {e}", is_error=True)))
    return JSONResponse(_error(msg_id, -32601, f"Method not found: {method}"))
