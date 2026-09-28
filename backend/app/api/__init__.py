from fastapi import APIRouter
from app.api import workspaces, documents, chat, voice, auth, knowledge_base, dashboard, search, prompts, system, mcp

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(workspaces.router, prefix="/workspaces", tags=["workspaces"])
api_router.include_router(documents.router, prefix="/documents", tags=["documents"])
api_router.include_router(chat.router, prefix="/chat", tags=["chat"])
api_router.include_router(voice.router, prefix="/voice", tags=["voice"])
api_router.include_router(knowledge_base.router, prefix="/knowledge-base", tags=["knowledge-base"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(search.router, prefix="/search", tags=["search"])
api_router.include_router(prompts.router, prefix="/prompts", tags=["prompts"])
api_router.include_router(system.router, prefix="/system", tags=["system"])
api_router.include_router(mcp.router, prefix="/mcp", tags=["mcp"])


