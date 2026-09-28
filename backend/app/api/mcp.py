import logging
from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user
from app.services.mcp_service import mcp_service, TOOL_SCHEMAS

router = APIRouter()
logger = logging.getLogger(__name__)


class MCPConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    tools: Optional[Dict[str, bool]] = None
    servers: Optional[List[Dict[str, Any]]] = None


class CreatePendingCallRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any] = {}
    workspace_id: Optional[int] = None


class CancelPendingCallRequest(BaseModel):
    call_id: str


class MCPToolExecuteRequest(BaseModel):
    call_id: str
    arguments: Optional[Dict[str, Any]] = None


@router.get("/config")
def get_mcp_config(current_user: models.User = Depends(get_current_user)):
    """Retrieve current local tools configuration, active tools, and status."""
    cfg = mcp_service.get_config()
    return {
        "config": cfg,
        "available_tools": TOOL_SCHEMAS,
        "active_tools": mcp_service.get_active_tools()
    }


@router.post("/config")
def update_mcp_config(
    req: MCPConfigUpdate,
    current_user: models.User = Depends(get_current_user)
):
    """Update local tools settings (enable/disable host, toggle individual tools)."""
    try:
        updated = mcp_service.update_config(req.dict(exclude_unset=True))
        return {"status": "success", "config": updated}
    except Exception as e:
        logger.error(f"Failed to update local tools configuration: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tools")
def list_mcp_tools(current_user: models.User = Depends(get_current_user)):
    """List active read-only tool schemas formatted for local tools."""
    return {"tools": mcp_service.get_active_tools()}


@router.post("/create-pending")
def create_pending_tool_call(
    req: CreatePendingCallRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Execution Gate: Registers a pending tool call emitted by the assistant.
    Validates tool enablement and returns a single-use call_id.
    """
    cfg = mcp_service.get_config()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=400, detail="Local tools host is disabled in settings.")

    tool_name = req.tool_name.strip()
    if not mcp_service.is_tool_enabled(tool_name):
        raise HTTPException(
            status_code=403,
            detail=f"Tool '{tool_name}' is not enabled or not recognized."
        )

    # Validate workspace ownership if workspace_id provided
    ws_id = req.workspace_id
    if ws_id:
        ws = db.query(models.Workspace).filter(
            models.Workspace.id == ws_id,
            models.Workspace.user_id == current_user.id
        ).first()
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found or unauthorized.")
    else:
        # Default to first workspace owned by user
        ws = db.query(models.Workspace).filter(models.Workspace.user_id == current_user.id).first()
        ws_id = ws.id if ws else 0

    call_id = mcp_service.create_pending_call(
        user_id=current_user.id,
        workspace_id=ws_id,
        tool_name=tool_name,
        arguments=req.arguments or {}
    )

    return {"status": "pending", "call_id": call_id, "tool_name": tool_name}


@router.post("/cancel")
def cancel_pending_tool_call(
    req: CancelPendingCallRequest,
    current_user: models.User = Depends(get_current_user)
):
    """
    Execution Gate: Cancels and drops a pending tool call.
    """
    cancelled = mcp_service.cancel_pending_call(current_user.id, req.call_id)
    return {"status": "cancelled" if cancelled else "not_found", "call_id": req.call_id}


@router.post("/execute")
def execute_mcp_tool(
    req: MCPToolExecuteRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Execution Gate: Executes a read-only tool ONLY if a valid, unexpired server-side
    pending call_id exists for this user. Consumes the call_id (one-time execution).
    No arbitrary execution from JWT + body alone without a server-registered pending call.
    """
    if not req.call_id or not req.call_id.strip():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Execution Gate Violation: call_id is required. Tool calls must originate from verified assistant output."
        )

    # Consume single-use pending call token from memory store
    pending = mcp_service.consume_pending_call(current_user.id, req.call_id.strip())
    if not pending:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Execution Gate Violation: Invalid, expired, or already executed tool call ID."
        )

    cfg = mcp_service.get_config()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=400, detail="Local tools host is disabled in settings.")

    tool_name = pending.get("tool_name", "").strip()
    if not mcp_service.is_tool_enabled(tool_name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Tool '{tool_name}' is not enabled or not recognized."
        )

    # Use confirmed/edited arguments if provided by the user in UI, else use original
    args = req.arguments if req.arguments is not None else pending.get("original_arguments", {})
    workspace_id = pending.get("workspace_id")

    logger.info(f"Execution Gate: Authorized execution of '{tool_name}' for user {current_user.id} (call_id: {req.call_id})")

    try:
        if tool_name == "list_workspace_files":
            raw_ws_id = args.get("workspace_id") or workspace_id
            resolved_ws_id = None
            if raw_ws_id:
                try:
                    resolved_ws_id = int(raw_ws_id)
                except (ValueError, TypeError):
                    ws = db.query(models.Workspace).filter(
                        models.Workspace.user_id == current_user.id,
                        models.Workspace.name == str(raw_ws_id)
                    ).first()
                    if ws:
                        resolved_ws_id = ws.id
            if not resolved_ws_id:
                ws = db.query(models.Workspace).filter(models.Workspace.user_id == current_user.id).first()
                if ws:
                    resolved_ws_id = ws.id
                else:
                    return {"success": False, "error": "No workspace available for user"}

            result = mcp_service.execute_list_workspace_files(
                db=db, user_id=current_user.id, workspace_id=resolved_ws_id
            )
            return {"success": "error" not in result, "tool_name": tool_name, "result": result}

        elif tool_name == "search_local_kb":
            query = str(args.get("query", "")).strip()
            folder_ids = args.get("folder_ids")
            n_results = args.get("n_results", 5)
            result = mcp_service.execute_search_local_kb(
                user_id=current_user.id,
                query=query,
                folder_ids=folder_ids,
                n_results=n_results
            )
            return {"success": "error" not in result, "tool_name": tool_name, "result": result}

        elif tool_name == "fetch_cited_chunk":
            filename = str(args.get("filename", "")).strip()
            locator = args.get("locator")
            ws_id = args.get("workspace_id") or workspace_id
            result = mcp_service.execute_fetch_cited_chunk(
                db=db,
                user_id=current_user.id,
                filename=filename,
                locator=locator,
                workspace_id=int(ws_id) if ws_id else None
            )
            return {"success": result.get("found", False), "tool_name": tool_name, "result": result}

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported tool: {tool_name}")

    except Exception as e:
        logger.error(f"Error executing tool {tool_name}: {e}", exc_info=True)
        return {"success": False, "tool_name": tool_name, "error": str(e)}
