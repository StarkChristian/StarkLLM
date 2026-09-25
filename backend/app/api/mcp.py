import logging
from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, HTTPException
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


class MCPToolExecuteRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any] = {}
    workspace_id: Optional[int] = None


@router.get("/config")
def get_mcp_config(current_user: models.User = Depends(get_current_user)):
    """Retrieve current MCP host configuration, active tools, and status."""
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
    """Update MCP host settings (enable/disable host, toggle individual tools)."""
    try:
        updated = mcp_service.update_config(req.dict(exclude_unset=True))
        return {"status": "success", "config": updated}
    except Exception as e:
        logger.error(f"Failed to update MCP configuration: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tools")
def list_mcp_tools(current_user: models.User = Depends(get_current_user)):
    """List active read-only tool schemas formatted for MCP clients."""
    return {"tools": mcp_service.get_active_tools()}


@router.post("/execute")
def execute_mcp_tool(
    req: MCPToolExecuteRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Execute a read-only MCP tool with user-confirmed arguments.
    Strictly verifies permissions and tool enablement.
    """
    cfg = mcp_service.get_config()
    if not cfg.get("enabled", True):
        raise HTTPException(status_code=400, detail="MCP Host is disabled in settings.")

    tool_name = req.tool_name.strip()
    if not mcp_service.is_tool_enabled(tool_name):
        raise HTTPException(
            status_code=403,
            detail=f"Tool '{tool_name}' is not enabled or not recognized."
        )

    args = req.arguments or {}
    logger.info(f"Executing MCP Tool '{tool_name}' for user {current_user.id} with args: {args}")

    try:
        if tool_name == "list_workspace_files":
            ws_id = args.get("workspace_id") or req.workspace_id
            if not ws_id:
                # Fallback to first workspace owned by user
                ws = db.query(models.Workspace).filter(models.Workspace.user_id == current_user.id).first()
                if not ws:
                    return {"success": False, "error": "No workspace available for user"}
                ws_id = ws.id
            result = mcp_service.execute_list_workspace_files(
                db=db, user_id=current_user.id, workspace_id=int(ws_id)
            )
            return {"success": "error" not in result, "tool_name": tool_name, "result": result}

        elif tool_name == "search_local_kb":
            query = args.get("query", "")
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
            filename = args.get("filename", "")
            locator = args.get("locator")
            ws_id = args.get("workspace_id") or req.workspace_id
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
        logger.error(f"Error executing MCP tool {tool_name}: {e}", exc_info=True)
        return {"success": False, "tool_name": tool_name, "error": str(e)}
