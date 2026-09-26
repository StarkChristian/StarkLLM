import os
import json
import time
import uuid
import logging
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from app.core.config import settings
from app.db import models
from app.services.rag_service import rag_service

logger = logging.getLogger(__name__)

CONFIG_PATH = os.path.join(settings.DATA_DIR if hasattr(settings, "DATA_DIR") else "data", "mcp_config.json")

# Default read-only tool schemas
TOOL_SCHEMAS = [
    {
        "name": "list_workspace_files",
        "description": "List all uploaded documents and files in the current workspace (read-only, tenant-isolated).",
        "parameters": {
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "integer",
                    "description": "Optional workspace ID. Defaults to current active workspace."
                }
            },
            "required": []
        }
    },
    {
        "name": "search_local_kb",
        "description": "Search the local personal Knowledge Base using hybrid semantic and keyword retrieval (read-only). Returns citations with canonical locators.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query or concept to look up in the Knowledge Base."
                },
                "folder_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Optional list of KB folder IDs to restrict search to."
                },
                "n_results": {
                    "type": "integer",
                    "description": "Maximum number of passages to return (default 5, max 10)."
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "fetch_cited_chunk",
        "description": "Fetch the exact text passage for a specific document citation locator from Chroma vector store (read-only, no raw filesystem access).",
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "The exact source filename (e.g. 'report.pdf' or 'notes.md')."
                },
                "locator": {
                    "type": "string",
                    "description": "The citation locator string (e.g. 'Page 4', 'Chunk 2', or 'Section: Overview')."
                },
                "workspace_id": {
                    "type": "integer",
                    "description": "Optional workspace ID if searching workspace-scoped documents."
                }
            },
            "required": ["filename"]
        }
    }
]


def _build_locator_for_meta(meta: dict, doc_id: str = "") -> str:
    """Matches the exact citation locator formatting used in rag_service and chat.py."""
    locator = meta.get("locator")
    if locator:
        return str(locator)
    if "page" in meta and meta["page"] is not None:
        try:
            page_val = int(meta["page"]) + 1
            return f"Page {page_val}"
        except (ValueError, TypeError):
            return f"Page {meta['page']}"
    elif meta.get("section"):
        chunk_part = f" Chunk {meta['chunk']}" if meta.get("chunk") else ""
        return f"Section: '{meta['section']}'{chunk_part}"
    elif meta.get("chunk"):
        return f"Chunk {meta['chunk']}"
    elif doc_id and "_c" in str(doc_id):
        c_part = str(doc_id).split("_c")[-1]
        if c_part.isdigit():
            return f"Chunk {int(c_part) + 1}"
    return "Chunk 1"


class MCPService:
    def __init__(self):
        self._ensure_config()
        # In-memory pending execution gate: call_id -> dict
        self._pending_calls: Dict[str, Dict[str, Any]] = {}
        self._pending_ttl = 600  # 10 minutes TTL

    def _get_default_config(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "tools": {
                "list_workspace_files": True,
                "search_local_kb": True,
                "fetch_cited_chunk": True
            },
            "servers": [
                {
                    "id": "builtin-local",
                    "name": "StarkLLM Builtin (In-Process)",
                    "type": "in-process",
                    "status": "connected",
                    "read_only": True
                }
            ]
        }

    def _ensure_config(self):
        try:
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
            if not os.path.exists(CONFIG_PATH):
                with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                    json.dump(self._get_default_config(), f, indent=2)
        except Exception as e:
            logger.warning(f"Failed to initialize local tools config file: {e}")

    def get_config(self) -> Dict[str, Any]:
        try:
            if os.path.exists(CONFIG_PATH):
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"Error reading local tools config: {e}")
        return self._get_default_config()

    def update_config(self, new_config: Dict[str, Any]) -> Dict[str, Any]:
        current = self.get_config()
        if "enabled" in new_config:
            current["enabled"] = bool(new_config["enabled"])
        if "tools" in new_config and isinstance(new_config["tools"], dict):
            for k, v in new_config["tools"].items():
                if k in current.get("tools", {}):
                    current["tools"][k] = bool(v)
        if "servers" in new_config and isinstance(new_config["servers"], list):
            current["servers"] = new_config["servers"]

        try:
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(current, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving local tools config: {e}")
            raise RuntimeError(f"Could not persist config: {e}")
        return current

    def get_active_tools(self) -> List[Dict[str, Any]]:
        cfg = self.get_config()
        if not cfg.get("enabled", True):
            return []
        enabled_map = cfg.get("tools", {})
        return [t for t in TOOL_SCHEMAS if enabled_map.get(t["name"], True)]

    def is_tool_enabled(self, tool_name: str) -> bool:
        cfg = self.get_config()
        if not cfg.get("enabled", True):
            return False
        return cfg.get("tools", {}).get(tool_name, False)

    # -----------------------------------------------------------------------
    # Execution Gate (Pending Call Registry)
    # -----------------------------------------------------------------------

    def create_pending_call(
        self, user_id: int, workspace_id: int, tool_name: str, arguments: dict
    ) -> str:
        """
        Creates a pending execution gate entry server-side.
        Returns a single-use call_id.
        """
        self._cleanup_expired_pending()
        call_id = f"call_{uuid.uuid4().hex[:16]}"
        self._pending_calls[call_id] = {
            "call_id": call_id,
            "user_id": user_id,
            "workspace_id": workspace_id,
            "tool_name": tool_name,
            "original_arguments": arguments,
            "created_at": time.time()
        }
        logger.info(f"Execution Gate: Registered pending call {call_id} for tool '{tool_name}' (user {user_id})")
        return call_id

    def cancel_pending_call(self, user_id: int, call_id: str) -> bool:
        """Cancels and removes a pending tool call."""
        pending = self._pending_calls.get(call_id)
        if pending and pending.get("user_id") == user_id:
            del self._pending_calls[call_id]
            logger.info(f"Execution Gate: Cancelled pending call {call_id}")
            return True
        return False

    def consume_pending_call(
        self, user_id: int, call_id: str
    ) -> Optional[Dict[str, Any]]:
        """
        Validates, consumes (one-time use), and returns the pending call record.
        Returns None if missing, expired, or unauthorized.
        """
        self._cleanup_expired_pending()
        pending = self._pending_calls.get(call_id)
        if not pending:
            logger.warning(f"Execution Gate: Attempt to execute unknown/expired call_id: {call_id}")
            return None
        if pending.get("user_id") != user_id:
            logger.warning(f"Execution Gate: call_id {call_id} unauthorized for user {user_id}")
            return None
        # Consume single-use token
        del self._pending_calls[call_id]
        return pending

    def _cleanup_expired_pending(self):
        now = time.time()
        expired = [
            cid for cid, item in self._pending_calls.items()
            if now - item.get("created_at", 0) > self._pending_ttl
        ]
        for cid in expired:
            self._pending_calls.pop(cid, None)

    # -----------------------------------------------------------------------
    # Tool Implementations (Strictly Read-Only, Tenant-Isolated)
    # -----------------------------------------------------------------------

    def execute_list_workspace_files(
        self, db: Session, user_id: int, workspace_id: int
    ) -> Dict[str, Any]:
        """Read-only: lists files uploaded in the specified workspace for this user only."""
        ws = db.query(models.Workspace).filter(
            models.Workspace.id == workspace_id,
            models.Workspace.user_id == user_id
        ).first()
        if not ws:
            return {"error": f"Workspace {workspace_id} not found or unauthorized", "files": []}

        docs = db.query(models.Document).filter(
            models.Document.workspace_id == workspace_id
        ).order_by(models.Document.created_at.desc()).all()

        files_info = []
        for d in docs:
            files_info.append({
                "id": d.id,
                "filename": d.filename,
                "file_type": getattr(d, "file_type", "") or os.path.splitext(d.filename)[-1].replace(".", ""),
                "file_size": getattr(d, "file_size", 0),
                "created_at": str(d.created_at) if hasattr(d, "created_at") else None
            })

        return {
            "workspace_id": workspace_id,
            "workspace_name": ws.name,
            "total_files": len(files_info),
            "files": files_info
        }

    def execute_search_local_kb(
        self, user_id: int, query: str, folder_ids: Optional[List[int]] = None, n_results: int = 5
    ) -> Dict[str, Any]:
        """Read-only: queries user's local Knowledge Base vector index with canonical locators."""
        if not query or not query.strip():
            return {"error": "Query string cannot be empty", "results": []}

        n_results = max(1, min(int(n_results), 10))
        filters = None
        if folder_ids:
            filters = {"folder_id": {"$in": folder_ids}}

        try:
            kb_results = rag_service.query_kb(
                user_id=user_id,
                query_text=query.strip(),
                n_results=n_results,
                filters=filters
            )

            results_out = []
            for r in kb_results:
                meta = r.get("metadata", {}) or {}
                fn = meta.get("file_name") or os.path.basename(meta.get("source") or meta.get("file_path") or "document")
                locator = _build_locator_for_meta(meta, str(r.get("id", "")))
                label = f"{fn} ({locator})"
                results_out.append({
                    "filename": fn,
                    "locator": locator,
                    "label": label,
                    "snippet": r.get("content", ""),
                    "score": r.get("score")
                })

            return {
                "query": query,
                "total_results": len(results_out),
                "results": results_out
            }
        except Exception as e:
            logger.error(f"Local tools search_local_kb error: {e}", exc_info=True)
            return {"error": f"Failed to search Knowledge Base: {str(e)}", "results": []}

    def execute_fetch_cited_chunk(
        self, db: Session, user_id: int, filename: str, locator: Optional[str] = None, workspace_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Read-only: finds and returns a specific chunk matching the filename and locator.
        Operates strictly on Chroma vector stores for this user. Rejects raw filesystem path traversal.
        """
        if not filename or not filename.strip():
            return {"error": "Filename must be specified", "found": False}

        # Sanitize filename: strictly strip directories/paths to avoid any path traversal
        clean_fn = os.path.basename(filename.strip()).lower()
        if not clean_fn or clean_fn in (".", ".."):
            return {"error": "Invalid filename", "found": False}

        candidates = []

        # 1. Search user's Knowledge Base collection in Chroma
        try:
            kb_coll = rag_service.get_or_create_kb_collection(user_id)
            if kb_coll and kb_coll.count() > 0:
                all_kb = kb_coll.get()
                for cid, doc, meta in zip(all_kb.get("ids", []), all_kb.get("documents", []), all_kb.get("metadatas", [])):
                    meta = meta or {}
                    fn = os.path.basename(meta.get("file_name") or meta.get("source") or meta.get("file_path") or "").lower()
                    if clean_fn in fn or fn in clean_fn:
                        loc = _build_locator_for_meta(meta, str(cid))
                        candidates.append({
                            "source_type": "knowledge_base",
                            "filename": meta.get("file_name") or fn,
                            "locator": loc,
                            "content": doc,
                            "metadata": meta,
                            "id": cid
                        })
        except Exception as e:
            logger.warning(f"Could not inspect KB collection: {e}")

        # 2. Search Workspace collection if workspace_id is provided and verified
        if workspace_id:
            ws = db.query(models.Workspace).filter(
                models.Workspace.id == workspace_id,
                models.Workspace.user_id == user_id
            ).first()
            if ws:
                try:
                    ws_coll = rag_service.get_or_create_collection(workspace_id, user_id)
                    if ws_coll and ws_coll.count() > 0:
                        all_ws = ws_coll.get()
                        for cid, doc, meta in zip(all_ws.get("ids", []), all_ws.get("documents", []), all_ws.get("metadatas", [])):
                            meta = meta or {}
                            fn = os.path.basename(meta.get("file_name") or meta.get("source") or meta.get("file_path") or "").lower()
                            if clean_fn in fn or fn in clean_fn:
                                loc = _build_locator_for_meta(meta, str(cid))
                                candidates.append({
                                    "source_type": "workspace",
                                    "filename": meta.get("file_name") or fn,
                                    "locator": loc,
                                    "content": doc,
                                    "metadata": meta,
                                    "id": cid
                                })
                except Exception as e:
                    logger.warning(f"Could not inspect workspace collection: {e}")

        if not candidates:
            return {
                "found": False,
                "filename": filename,
                "locator": locator,
                "message": f"No indexed chunks found for '{filename}'"
            }

        # Filter by locator if specified
        if locator:
            loc_lower = locator.strip().lower()
            matched = [c for c in candidates if loc_lower in c["locator"].lower() or c["locator"].lower() in loc_lower]
            if matched:
                return {
                    "found": True,
                    "filename": matched[0]["filename"],
                    "locator": matched[0]["locator"],
                    "content": matched[0]["content"],
                    "source_type": matched[0]["source_type"],
                    "total_matches": len(matched)
                }

        first = candidates[0]
        return {
            "found": True,
            "filename": first["filename"],
            "locator": first["locator"],
            "content": first["content"],
            "source_type": first["source_type"],
            "total_matches": len(candidates)
        }


mcp_service = MCPService()
