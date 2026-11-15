"""Protection at rest: the state (on/off), the data key and the encrypted column type.

The data key is created and wrapped by the desktop app (Windows key store, see docs/encryption-design.md) and handed
to the engine after it started, in memory only (`POST /api/v1/system/protection/unlock`); a server without the desktop
app may start with the environment variable STARKLLM_DATA_KEY. The engine never writes the key to disk.

State file (data/protection/state.json) holds no secret:
    {"version": 1, "enabled": true, "key_id": "9f3a01bc", "enabled_at": "...", "migration": {...}}
`enabled` means: new data is written protected. Old data may still be plain until the migration has finished;
every reader accepts both, so a migration can stop at any point (crash, power loss) without losing anything.
"""
import base64
import json
import logging
import os
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import String
from sqlalchemy.types import TypeDecorator

from app.core import crypto
from app.core.config import settings

logger = logging.getLogger(__name__)


LABEL_CACHE_SIZE = 200_000
LABEL_CACHE_MAX_TOKEN = 600      # token length: a name or title, not a message


class ProtectionLocked(Exception):
    """Protected data is needed but the key has not been handed to the engine."""


class ProtectionState:
    """Process-wide state. One instance (`protection`) is used by the whole engine; tests create their own."""

    def __init__(self, directory: Optional[str] = None):
        self._dir = directory
        self._key: Optional[bytes] = None
        self._lock = threading.RLock()
        self._state_cache = None
        self._env_loaded = False
        self._label_cache = OrderedDict()      # protected token -> text, for short values (names, titles); in memory only

    # --- locations -----------------------------------------------------------------------------------------------
    @property
    def directory(self) -> str:
        return self._dir or os.path.abspath(settings.PROTECTION_DIR)

    def set_directory(self, directory: Optional[str]):
        with self._lock:
            self._dir, self._state_cache = directory, None

    @property
    def state_path(self) -> str:
        return os.path.join(self.directory, "state.json")

    # --- state file ----------------------------------------------------------------------------------------------
    def state(self) -> dict:
        with self._lock:
            if self._state_cache is None:
                try:
                    with open(self.state_path, "r", encoding="utf-8") as f:
                        self._state_cache = json.load(f)
                except (OSError, ValueError):
                    self._state_cache = {"version": 1, "enabled": False}
            return dict(self._state_cache)

    def save_state(self, **changes) -> dict:
        with self._lock:
            state = self.state()
            state.update(changes)
            os.makedirs(self.directory, exist_ok=True)
            tmp = self.state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            os.replace(tmp, self.state_path)       # atomic: a crash leaves the old or the new file, never half
            self._state_cache = state
            return dict(state)

    # --- key -----------------------------------------------------------------------------------------------------
    def _load_env_key(self):
        if self._env_loaded:
            return
        self._env_loaded = True
        raw = os.environ.get("STARKLLM_DATA_KEY", "").strip()
        if raw:
            try:
                self.set_key(base64.b64decode(raw, validate=True))
            except Exception as e:
                logger.error("STARKLLM_DATA_KEY is not usable: %s", e)

    def set_key(self, key: bytes):
        """Hand the data key to the engine. Refused if protection was set up with a different key."""
        if len(key) != crypto.KEY_LEN:
            raise ValueError("The data key must be 32 bytes.")
        with self._lock:
            known = self.state().get("key_id")
            if self.state().get("enabled") and known and crypto.key_id(key) != known:
                raise crypto.WrongKey("This is not the key this data was protected with.")
            self._key = bytes(key)

    def clear_key(self):
        with self._lock:
            self._key = None
            self._label_cache.clear()          # decrypted short texts must not outlive the key
            crypto.forget_cached_keys()

    @property
    def key(self) -> Optional[bytes]:
        self._load_env_key()
        return self._key

    def sub_key(self, purpose: str) -> bytes:
        key = self.key
        if key is None:
            raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
        return crypto.derive_key(key, purpose)

    # --- queries -------------------------------------------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return bool(self.state().get("enabled"))

    @property
    def locked(self) -> bool:
        """Protection is on but the key is not available (yet): protected data cannot be read."""
        return self.enabled and self.key is None

    def writes_protected(self) -> bool:
        """New data is written protected. A locked engine refuses to write instead of storing plain text."""
        if not self.enabled:
            return False
        if self.key is None:
            raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
        return True

    def status(self) -> dict:
        s = self.state()
        return {"enabled": bool(s.get("enabled")), "locked": self.locked, "key_id": s.get("key_id"),
                "enabled_at": s.get("enabled_at"), "migration": s.get("migration") or {"state": "idle"},
                "key_available": self.key is not None}

    def mark_enabled(self, enabled: bool):
        """Switch writing of protected data on or off (the key must be available to switch it on)."""
        with self._lock:
            if enabled:
                if self.key is None:
                    raise ProtectionLocked("No key: protection cannot be switched on.")
                self.save_state(enabled=True, key_id=crypto.key_id(self.key),
                                enabled_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            else:
                self.save_state(enabled=False)

    # --- stored values -------------------------------------------------------------------------------------------
    def seal_text(self, value, context: str):
        """Value for the database: protected if protection is on, else plain (escaped if it looks like a token)."""
        if value is None or not isinstance(value, str):
            return value
        if self.writes_protected():
            return crypto.encrypt_text(self.sub_key("fields"), value, context)
        if value.startswith((crypto.TOKEN_PREFIX, crypto.PLAIN_ESCAPE)):
            return crypto.PLAIN_ESCAPE + value
        return value

    def open_text(self, value, context: str):
        """The text behind a database value, protected or plain."""
        if value is None or not isinstance(value, str):
            return value
        if value.startswith(crypto.PLAIN_ESCAPE):
            return value[len(crypto.PLAIN_ESCAPE):]
        if not crypto.is_token(value):
            return value
        if self.key is None:
            raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
        short = len(value) <= LABEL_CACHE_MAX_TOKEN
        if short:                                          # names and titles are read again and again (lists, search)
            hit = self._label_cache.get((value, context))
            if hit is not None:
                return hit
        text = crypto.decrypt_text(self.sub_key("fields"), value, context)
        if short:
            with self._lock:
                self._label_cache[(value, context)] = text
                if len(self._label_cache) > LABEL_CACHE_SIZE:
                    self._label_cache.popitem(last=False)
        return text


protection = ProtectionState()


_RAISE = object()


class ProtectedText(TypeDecorator):
    """A text column that is stored protected while protection is on. Reads accept protected and plain values, so
    turning protection on or off, or stopping in the middle of it, never makes a row unreadable.

    The column cannot be searched with SQL (LIKE) any more; code that searched it filters in Python when
    protection is on (see api/search.py). While the key is missing, a column given `locked_value` reads as that value
    instead of failing (the user's profile fields: the account must still load so the unlock screen can be reached)."""
    impl = String
    cache_ok = True

    def __init__(self, context: str = "", locked_value=_RAISE, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.context = context
        self.locked_value = locked_value        # shown instead of an error while the key is missing (profile fields)

    def process_bind_param(self, value, dialect):
        return protection.seal_text(value, self.context)

    def process_result_value(self, value, dialect):
        try:
            return protection.open_text(value, self.context)
        except ProtectionLocked:
            if self.locked_value is _RAISE:
                raise
            return self.locked_value
