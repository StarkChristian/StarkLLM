from fastapi import APIRouter
from app.api import (
    workspaces, documents, chat, voice, auth, knowledge_base,
    dashboard, search, prompts, system, mcp, models_router, memory_router, studio,
    connections, ocr, protection, backup, privacy, watch_folders, tax_pack, meetings, reranker,
)

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(workspaces.router, prefix="/workspaces", tags=["workspaces"])
api_router.include_router(documents.router, prefix="/documents", tags=["documents"])
api_router.include_router(studio.router, prefix="/studio", tags=["studio"])
api_router.include_router(chat.router, prefix="/chat", tags=["chat"])
api_router.include_router(models_router.router, prefix="/chat", tags=["models"])
api_router.include_router(memory_router.router, prefix="/chat", tags=["memory"])
api_router.include_router(voice.router, prefix="/voice", tags=["voice"])
api_router.include_router(knowledge_base.router, prefix="/knowledge-base", tags=["knowledge-base"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(search.router, prefix="/search", tags=["search"])
api_router.include_router(prompts.router, prefix="/prompts", tags=["prompts"])
api_router.include_router(system.router, prefix="/system", tags=["system"])
api_router.include_router(protection.router, prefix="/system/protection", tags=["protection"])
api_router.include_router(backup.router, prefix="/system/backup", tags=["backup"])
api_router.include_router(mcp.router, prefix="/mcp", tags=["mcp"])
api_router.include_router(connections.router, prefix="/connections", tags=["connections"])
api_router.include_router(ocr.router, prefix="/ocr", tags=["ocr"])
api_router.include_router(reranker.router, prefix="/reranker", tags=["reranker"])
api_router.include_router(privacy.router, prefix="/privacy", tags=["privacy"])
api_router.include_router(watch_folders.router, prefix="/watch-folders", tags=["watch-folders"])
api_router.include_router(tax_pack.router, prefix="/taxpack", tags=["tax package"])
api_router.include_router(meetings.router, prefix="/meetings", tags=["meetings"])
