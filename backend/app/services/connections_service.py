"""Access for other programs on this PC (OpenAI-compatible API at /v1, MCP server at /mcp).

Off by default. When the user turns it on in Settings and creates a key, a program on this PC can search the user's
documents and ask questions about them with that key. Keys are stored only as SHA-256 hashes; the key itself is
shown once. The engine listens on 127.0.0.1 only, so programs on other computers cannot connect.
"""
import hashlib
import json
import os
import secrets
import threading
import time
from typing import Dict, List, Optional

from app.core.config import settings

DATA_DIR = getattr(settings, "DATA_DIR", None) or "data"
CONFIG_PATH = os.path.join(DATA_DIR, "connections.json")
KEY_PREFIX = "sk-stark-"
_lock = threading.Lock()


def _load() -> Dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("enabled", False)
                data.setdefault("keys", [])
                return data
    except (OSError, ValueError):
        pass
    return {"enabled": False, "keys": []}


def _save(data: Dict) -> None:
    os.makedirs(os.path.dirname(CONFIG_PATH) or ".", exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, CONFIG_PATH)


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def public(entry: Dict) -> Dict:
    return {k: entry.get(k) for k in ("id", "name", "prefix", "created", "last_used")}


def state() -> Dict:
    data = _load()
    return {"enabled": bool(data["enabled"]), "keys": [public(k) for k in data["keys"]]}


def set_enabled(enabled: bool) -> Dict:
    with _lock:
        data = _load()
        data["enabled"] = bool(enabled)
        _save(data)
    return state()


def create_key(name: str, user_id: int) -> Dict:
    """A new key; the full key is returned only here."""
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    entry = {"id": secrets.token_hex(6), "name": (name or "").strip()[:60] or "Key", "prefix": key[:13] + "…",
             "hash": _hash(key), "user_id": user_id, "created": int(time.time()), "last_used": None}
    with _lock:
        data = _load()
        data["keys"].append(entry)
        _save(data)
    return {**public(entry), "key": key}


def delete_key(key_id: str) -> bool:
    with _lock:
        data = _load()
        before = len(data["keys"])
        data["keys"] = [k for k in data["keys"] if k.get("id") != key_id]
        _save(data)
        return len(data["keys"]) < before


def check(authorization: Optional[str]) -> Dict:
    """The key entry for an "Authorization: Bearer <key>" header. Raises PermissionError with a reason."""
    data = _load()
    if not data["enabled"]:
        raise PermissionError("Access for other apps is turned off. Turn it on in StarkLLM: Settings > Other apps.")
    token = (authorization or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if not token:
        raise PermissionError("Missing API key. Create one in StarkLLM: Settings > Other apps.")
    digest = _hash(token)
    for entry in data["keys"]:
        if secrets.compare_digest(entry.get("hash", ""), digest):
            now = int(time.time())
            if not entry.get("last_used") or now - entry["last_used"] > 60:
                with _lock:
                    fresh = _load()
                    for e in fresh["keys"]:
                        if e.get("id") == entry.get("id"):
                            e["last_used"] = now
                    _save(fresh)
            return entry
    raise PermissionError("Unknown API key.")


def list_keys() -> List[Dict]:
    return [public(k) for k in _load()["keys"]]
