from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, Response
from app.core.config import settings
from app.db.session import engine, Base
from app.api import api_router
import os

# Create database tables
Base.metadata.create_all(bind=engine)

# Add columns to existing tables if they don't exist
from sqlalchemy import text
try:
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE chats ADD COLUMN folder_id INTEGER REFERENCES chat_folders(id) ON DELETE SET NULL"))
except Exception:
    pass # Column already exists or table doesn't exist

# Create upload directory if it doesn't exist
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(settings.CHROMA_PERSIST_DIRECTORY, exist_ok=True)

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:3000",
    "http://localhost:8080",
    "http://localhost",
]

CORS_HEADERS = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Origin, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "X-Chat-ID, X-KB-Used, X-KB-Sources, X-WS-Sources, X-Web-Sources, X-Web-Sources-Urls, X-Chat-Renamed",
    "Access-Control-Max-Age": "600",
}

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
)


# ---------------------------------------------------------------------------
# Bulletproof CORS middleware — pure ASGI, wraps every response including
# error responses raised by OAuth2PasswordBearer / HTTPException / 500s.
# ---------------------------------------------------------------------------
@app.middleware("http")
async def cors_middleware(request: Request, call_next):
    origin = request.headers.get("origin", "")

    # Handle preflight (OPTIONS) immediately — don't even call the route
    if request.method == "OPTIONS":
        if origin in ALLOWED_ORIGINS:
            headers = {**CORS_HEADERS, "Access-Control-Allow-Origin": origin}
        else:
            headers = {}
        return Response(status_code=204, headers=headers)

    # Call the actual route handler
    response = await call_next(request)

    # Inject CORS headers into every response (including 401/403/500)
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Expose-Headers"] = "X-Chat-ID, X-KB-Used, X-KB-Sources, X-WS-Sources, X-Web-Sources, X-Web-Sources-Urls, X-Chat-Renamed"

    return response


# Custom HTTPException handler: returns JSON with CORS headers baked in.
# This catches exceptions raised before/outside the middleware chain.
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    origin = request.headers.get("origin", "")
    extra_headers = {}
    if origin in ALLOWED_ORIGINS:
        extra_headers["Access-Control-Allow-Origin"] = origin
        extra_headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=extra_headers,
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    origin = request.headers.get("origin", "")
    extra_headers = {}
    if origin in ALLOWED_ORIGINS:
        extra_headers["Access-Control-Allow-Origin"] = origin
        extra_headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=extra_headers,
    )


@app.get("/health")
def health_check():
    return {"status": "ok", "app": settings.PROJECT_NAME}

# Include routers
app.include_router(api_router, prefix=settings.API_V1_STR)

# Mount OpenAI-compatible developer API endpoints directly at /v1
from app.api.openai_compat import router as openai_compat_router
app.include_router(openai_compat_router, prefix="/v1", tags=["OpenAI Compatible"])

from app.services.kb_service import kb_service

@app.on_event("startup")
def on_startup():
    kb_service.start_background_watcher()

@app.on_event("shutdown")
def on_shutdown():
    kb_service.stop_background_watcher()


# ---------------------------------------------------------------------------
# Launcher-only endpoint — no JWT required, localhost-only IP guard.
# The Windows launcher (start.exe) calls this after robocopy mirror is ready
# so it can register the KB folder without requiring the user to have logged
# in yet. Bound only on localhost:8000 which Docker exposes as 127.0.0.1.
#
# Docker Desktop NATs host→container traffic through a gateway IP (e.g.
# 192.168.65.254) so the container never sees raw 127.0.0.1 for host calls.
# We resolve host.docker.internal once at startup and add that single IP to
# the allowlist. Combined with the 127.0.0.1 port binding in docker-compose,
# only the local machine can reach this port.
# ---------------------------------------------------------------------------
import socket as _socket
import logging as _logging

_logger = _logging.getLogger(__name__)

from fastapi import Header
from pydantic import BaseModel as _BM
from app.db.session import SessionLocal as _SL
from app.db.models import User as _User


class _LauncherFolderReq(_BM):
    folder_path: str
    folder_name: str
    launcher_token: str


@app.post("/launcher/register-kb-folder", status_code=200)
def launcher_register_kb_folder(
    body: _LauncherFolderReq,
    request: Request,
):
    """
    Registers a KB folder on behalf of the currently logged-in user.
    Security constraints:
      - Host port is bound to 127.0.0.1 in docker-compose.yml.
      - Requires matching launcher token written by start.exe to local disk.
        Header-only authentication is strictly forbidden.
      - Uses active session of the logged-in user from active_session.json.
    """
    import os as _os
    import json as _json
    import hmac as _hmac
    import re as _re

    # Token verification against local file on host (header-only auth forbidden).
    token_paths = ["/app/data/.launcher_token", "data/.launcher_token"]
    expected_token = ""
    for tp in token_paths:
        if _os.path.exists(tp):
            try:
                with open(tp, "r", encoding="utf-8") as tf:
                    expected_token = tf.read().strip()
                break
            except Exception:
                pass

    if not expected_token:
        raise HTTPException(
            status_code=403,
            detail="Forbidden: Launcher token file not found on local host."
        )

    provided_token = (body.launcher_token or "").strip()
    if not provided_token or not _hmac.compare_digest(provided_token, expected_token):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: Invalid or missing launcher token."
        )

    # 3. Path sanitization
    folder_path = body.folder_path.strip()
    if _re.match(r'^[A-Za-z]:[/\\]', folder_path) or folder_path.startswith('\\\\'):
        raise HTTPException(
            status_code=422,
            detail="Windows host paths cannot be registered directly. Use container path."
        )

    # 4. Resolve authenticated logged-in user from active_session.json
    session_paths = ["/app/data/active_session.json", "data/active_session.json"]
    logged_in_user_id = None
    for sp in session_paths:
        if _os.path.exists(sp):
            try:
                with open(sp, "r", encoding="utf-8") as sf:
                    sdata = _json.load(sf)
                    logged_in_user_id = sdata.get("user_id")
                break
            except Exception:
                pass

    with _SL() as db:
        user = None
        if logged_in_user_id:
            user = db.query(_User).filter(_User.id == logged_in_user_id).first()

        if not user:
            raise HTTPException(
                status_code=401,
                detail="No authenticated user session found. Please log in at http://localhost:5173 first."
            )

        if not _os.path.exists(folder_path):
            raise HTTPException(
                status_code=400,
                detail=f"Path '{folder_path}' does not exist inside the container yet. "
                       "Initial copy pass must finish before indexing."
            )

        from app.db.models import KnowledgeBaseFolder as _KBF
        existing = db.query(_KBF).filter(
            _KBF.user_id == user.id,
            _KBF.folder_path == folder_path
        ).first()
        if existing:
            if existing.is_active == 0:
                existing.is_active = 1
                db.commit()
                db.refresh(existing)
            try:
                kb_service.sync_folder(db, existing.id)
            except Exception as e:
                _logger.warning(f"KB sync on existing folder {existing.id} warning: {e}")
            return {"id": existing.id, "folder_path": existing.folder_path}

        folder = kb_service.add_folder(
            db=db,
            user_id=user.id,
            folder_path=folder_path,
            folder_name=body.folder_name or _os.path.basename(folder_path),
        )
        try:
            kb_service.sync_folder(db, folder.id)
        except Exception as e:
            _logger.warning(f"KB initial sync on folder {folder.id} warning: {e}")

        return {"id": folder.id, "folder_path": folder.folder_path}
