"""The one place where StarkLLM's engine may reach the network (roadmap phase 3, "provable privacy").

Every outgoing connection of the engine goes through this module:

* it is recorded locally (time, destination host, purpose, bytes, feature) in ``data/network_log.jsonl``, so Settings can
  show it and the user can export it. The log holds hosts only, never a path, a query or a body: a search term or a
  file name never lands in it;
* the "fully offline" switch (``data/privacy.json`` or ``STARKLLM_OFFLINE=1``) makes every connection except the ones
  to this PC (the local Ollama, the engine itself) fail before anything is sent.

Code must not use ``requests``, ``httpx``, ``urllib`` or a socket directly: a test greps the code for that
(``backend/tests/test_network_layer.py``). Libraries that bring their own client (web search, the YouTube transcript
library, model downloads of faster-whisper) are wrapped in :func:`external`, which records and blocks the same way.
As a second line of defence :func:`install` puts a check into ``socket`` itself: in offline mode no Python code can
open a connection or resolve a name outside this PC, and in online mode a connection that did not come through this
module is recorded as "unattributed" so it is visible. Clients written in other languages (the search library uses a
Rust client) do not pass through ``socket``; for them the guard in :func:`external` is the barrier, and the Docker run
without network (docs/verify-privacy.md) is the proof.
"""
import contextlib
import contextvars
import ipaddress
import json
import logging
import os
import socket
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, Iterator, List, Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

DATA_DIR = "data"
LOG_FILE = "network_log.jsonl"
STATE_FILE = "privacy.json"
MAX_LOG_BYTES = 4 * 1024 * 1024  # the log is trimmed to its newest MAX_KEEP lines when it grows past this
MAX_KEEP = 5000

# Feature keys the panel shows (the UI translates them); the text is the English default of the purpose.
FEATURES: Dict[str, str] = {
    "model_download": "Download of an AI model by the local Ollama",
    "ollama_cloud_model": "A cloud model of Ollama (it runs on Ollama's servers, not on this PC)",
    "web_search": "Web search the user switched on for a question",
    "web_import": "Import of a web page the user entered",
    "youtube_import": "Import of a YouTube transcript the user entered",
    "github_import": "Import of a GitHub repository the user entered",
    "market_prices": "Live prices in the dashboard widget the user switched on",
    "cloud_llm": "Chat with the online AI provider the user configured",
    "speech_model_download": "One-time download of the speech recognition model",
    "ocr_language_pack": "Download of one OCR language file the user asked for in Settings",
    "reranker_model_download": "One-time download of the search reranker model the user asked for in Settings",
    "unattributed": "A connection that did not go through StarkLLM's network layer",
}


class OfflineBlocked(requests.exceptions.ConnectionError):
    """Raised instead of connecting while the fully offline switch is on. It is a ConnectionError (and so an OSError)
    on purpose: every caller that already handles an unreachable server handles this too."""

    def __init__(self, host: str, feature: str = ""):
        self.host = host
        self.feature = feature
        super().__init__(f"Fully offline mode is on: the connection to {host or 'the internet'} was blocked.")


# ---------------------------------------------------------------------------------------------------------------
# state: the offline switch
# ---------------------------------------------------------------------------------------------------------------
_lock = threading.RLock()
_state: Optional[Dict] = None


def _state_path() -> str:
    return os.path.join(DATA_DIR, STATE_FILE)


def _log_path() -> str:
    return os.path.join(DATA_DIR, LOG_FILE)


def _env_offline() -> bool:
    return os.getenv("STARKLLM_OFFLINE", "").strip().lower() in ("1", "true", "yes", "on")


def _load_state() -> Dict:
    global _state
    with _lock:
        if _state is None:
            data = {}
            try:
                with open(_state_path(), encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                pass
            offline = bool(isinstance(data, dict) and data.get("offline"))
            set_by = data.get("set_by") if offline and isinstance(data.get("set_by"), int) else None
            _state = {"offline": offline, "set_by": set_by}
            if _env_offline() and not _state["offline"]:
                # the desktop app starts the engine offline when the user left the switch on: that sticks. Nobody
                # signed in did it, so set_by stays None (only the administrator or the desktop app turn it off).
                _state["offline"] = True
                _save_state()
        return _state


def _save_state() -> None:
    try:
        os.makedirs(DATA_DIR or ".", exist_ok=True)
        tmp = _state_path() + ".tmp"
        saved = {"offline": bool(_state["offline"])}
        if _state["offline"] and _state.get("set_by") is not None:
            saved["set_by"] = _state["set_by"]
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(saved, f)
        os.replace(tmp, _state_path())
    except OSError as e:
        logger.warning("could not save the offline switch: %s", e)


def is_offline() -> bool:
    return _load_state()["offline"]


def offline_set_by() -> Optional[int]:
    """The id of the account that turned the switch on; None when it is off, or when it came from STARKLLM_OFFLINE or
    the desktop app on this PC."""
    state = _load_state()
    return state.get("set_by") if state["offline"] else None


def set_offline(value: bool, set_by: Optional[int] = None) -> bool:
    """Turns the fully offline switch on or off and returns the new state. STARKLLM_OFFLINE=1 at start turns it on.
    set_by is the account that turns it on (None: the desktop app or the environment). Turning on a switch that is
    already on keeps who turned it on first, so a second account cannot take it over and then turn it off."""
    with _lock:
        state = _load_state()
        if value and not state["offline"]:
            state["set_by"] = set_by
        elif not value:
            state["set_by"] = None
        state["offline"] = bool(value)
        _save_state()
    return is_offline()


def reset_for_tests() -> None:
    global _state, _local_counts
    with _lock:
        _state = None
        _local_counts = {}
        _names.clear()
        _this_pc_cache.update(ips=set(), at=0.0)


# ---------------------------------------------------------------------------------------------------------------
# where a connection goes
# ---------------------------------------------------------------------------------------------------------------
_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_this_pc_cache: Dict = {"ips": set(), "at": 0.0}
_names: Dict[str, str] = {}  # ip -> the name it was resolved from, to say a host instead of a number in the log


def _ollama_host() -> str:
    try:
        from app.core.config import settings
        return (urlparse(settings.OLLAMA_BASE_URL).hostname or "").lower()
    except Exception:  # never fail a request because of the log
        return ""


def _this_pc_names() -> set:
    names = {"localhost", "host.docker.internal", "ip6-localhost", "127.0.0.1", "::1", "0.0.0.0", ""}
    names.add(_ollama_host())
    try:
        names.add(socket.gethostname().lower())
    except OSError:
        pass
    return names


def _this_pc_ips() -> set:
    """Addresses of this PC as the engine sees them: loopback and what the local Ollama name resolves to (inside Docker,
    host.docker.internal is the PC)."""
    now = time.monotonic()
    if now - _this_pc_cache["at"] < 60 and _this_pc_cache["ips"]:
        return _this_pc_cache["ips"]
    ips = set()
    for name in ("host.docker.internal", _ollama_host()):
        if not name:
            continue
        try:
            for info in _real_getaddrinfo(name, None):
                ips.add(info[4][0])
        except OSError:
            pass
    _this_pc_cache.update(ips=ips, at=now)
    return ips


def classify(host: str) -> str:
    """"this_pc" (never counted as outgoing), "lan" (another device on the local network) or "internet"."""
    h = (host or "").strip("[]").lower()
    if h in _this_pc_names() or h.endswith(".localhost"):
        return "this_pc"
    try:
        ip = ipaddress.ip_address(h.split("%")[0])
    except ValueError:
        return "lan" if h.endswith((".local", ".lan", ".internal", ".home.arpa")) else "internet"
    if ip.is_loopback or h in _this_pc_ips():
        return "this_pc"
    if ip.is_private or ip.is_link_local:
        return "lan"
    return "internet"


# ---------------------------------------------------------------------------------------------------------------
# the log
# ---------------------------------------------------------------------------------------------------------------
_local_counts: Dict[str, int] = {}
_ctx: contextvars.ContextVar = contextvars.ContextVar("starkllm_network_ctx", default=None)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _append(entry: Dict) -> None:
    with _lock:
        try:
            os.makedirs(DATA_DIR or ".", exist_ok=True)
            path = _log_path()
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if os.path.getsize(path) > MAX_LOG_BYTES:
                keep = _read_lines(path)[-MAX_KEEP:]
                with open(path, "w", encoding="utf-8") as f:
                    f.write("\n".join(json.dumps(e, ensure_ascii=False) for e in keep) + "\n")
        except OSError as e:
            logger.warning("could not write the network log: %s", e)


def _read_lines(path: str) -> List[Dict]:
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return out


def record(feature: str, host: str, *, purpose: str = "", scheme: str = "", port: Optional[int] = None, method: str = "",
           outcome: str = "ok", bytes_out: Optional[int] = 0, bytes_in: Optional[int] = None, status: Optional[int] = None,
           error: str = "", via: str = "", entry_id: str = "") -> Dict:
    """Writes one line of the log and returns the entry. Connections to this PC are only counted, not listed."""
    zone = classify(host)
    if zone == "this_pc":
        with _lock:
            _local_counts[feature] = _local_counts.get(feature, 0) + 1
        return {"id": "", "local": True}
    entry = {
        "id": entry_id or uuid.uuid4().hex[:12], "time": _now(), "source": "engine", "feature": feature,
        "purpose": purpose or FEATURES.get(feature, ""), "host": host, "port": port, "scheme": scheme, "method": method,
        "zone": zone, "outcome": outcome, "bytes_out": bytes_out, "bytes_in": bytes_in, "status": status,
        "error": error[:200], "via": via,
    }
    _append(entry)
    return entry


def entries(limit: int = 1000) -> List[Dict]:
    """The newest entries first. A line that is written again later with the same id (a stream that finished) replaces
    the earlier one."""
    with _lock:
        by_id: Dict[str, Dict] = {}
        order: List[str] = []
        for e in _read_lines(_log_path()):
            if e.get("id") not in by_id:
                order.append(e.get("id"))
            by_id[e.get("id")] = e
    return [by_id[i] for i in reversed(order)][:limit]


def clear_log() -> None:
    with _lock:
        try:
            open(_log_path(), "w").close()
        except OSError:
            pass
        _local_counts.clear()


def local_counts() -> Dict[str, int]:
    with _lock:
        return dict(_local_counts)


def status() -> Dict:
    return {"offline": is_offline(), "set_by": offline_set_by(), "local_requests": local_counts(),
            "log_entries": len(entries(100000))}


# ---------------------------------------------------------------------------------------------------------------
# the wrapper
# ---------------------------------------------------------------------------------------------------------------
def _host_port(url: str):
    p = urlparse(url)
    return (p.hostname or "").lower(), p.port or (443 if p.scheme == "https" else 80), p.scheme


def _body_size(kw: Dict) -> int:
    try:
        if kw.get("json") is not None:
            return len(json.dumps(kw["json"]))
        data = kw.get("data")
        if data is not None:
            return len(data) if hasattr(data, "__len__") else 0
    except (TypeError, ValueError):
        pass
    return 0


def _in_flight(feature: str, host: str):
    token = _ctx.set((feature, host))
    return token


def _count_stream(resp, entry: Dict) -> None:
    """A streamed answer (chat, model download) is counted while it is read; the finished entry replaces the first."""
    if not isinstance(resp, requests.Response) or not entry.get("id"):
        return
    total = {"n": 0}

    def finish():
        if entry.get("bytes_in") != total["n"]:
            entry["bytes_in"] = total["n"]
            _append(entry)

    def wrap(name):
        orig = getattr(resp, name, None)
        if orig is None:
            return

        def counted(*a, **k):
            try:
                for chunk in orig(*a, **k):
                    total["n"] += len(chunk)
                    yield chunk
            finally:
                finish()
        setattr(resp, name, counted)

    wrap("iter_lines")
    wrap("iter_content")


def request(method: str, url: str, *, feature: str, purpose: str = "", via: str = "", **kw):
    """requests.<method>(url, **kw) with the recording and the offline rule. ``via`` names a destination that a local
    service contacts for us (the local Ollama pulling a model from its registry)."""
    host, port, scheme = _host_port(url)
    shown = via or host  # where the data really goes
    if via:
        port = None
    if is_offline() and classify(shown) != "this_pc":
        record(feature, shown, purpose=purpose, scheme=scheme, port=port, method=method, outcome="blocked", bytes_out=0,
               error="offline mode")
        raise OfflineBlocked(shown, feature)
    token = _in_flight(feature, shown)
    started = record(feature, shown, purpose=purpose, scheme=scheme, port=port, method=method, bytes_out=_body_size(kw),
                     bytes_in=None, via="local Ollama" if via else "")
    try:
        fn = getattr(requests, method.lower(), None) or (lambda u, **k: requests.request(method, u, **k))
        resp = fn(url, **kw)
    except Exception as e:
        if started.get("id"):
            started.update(outcome="error", error=f"{type(e).__name__}: {e}"[:200])
            _append(started)
        raise
    finally:
        _ctx.reset(token)
    if started.get("id"):
        started["status"] = getattr(resp, "status_code", None)
        # redirects to another host are connections of their own
        for r in getattr(resp, "history", None) or []:
            nxt = getattr(r, "headers", {}).get("Location", "") if hasattr(r, "headers") else ""
            nh = urlparse(nxt).hostname
            if nh and nh.lower() != host:
                record(feature, nh.lower(), purpose=(purpose or FEATURES.get(feature, "")) + " (redirect)",
                       scheme=urlparse(nxt).scheme, method="GET", bytes_in=None)
        if kw.get("stream"):
            _count_stream(resp, started)
        else:
            try:
                started["bytes_in"] = int(resp.headers.get("Content-Length") or len(resp.content))
            except Exception:
                started["bytes_in"] = None
        _append(started)
    return resp


def get(url, *, feature, purpose="", via="", **kw):
    return request("GET", url, feature=feature, purpose=purpose, via=via, **kw)


def post(url, *, feature, purpose="", via="", **kw):
    return request("POST", url, feature=feature, purpose=purpose, via=via, **kw)


def delete(url, *, feature, purpose="", via="", **kw):
    return request("DELETE", url, feature=feature, purpose=purpose, via=via, **kw)


@contextlib.contextmanager
def external(feature: str, host: str, *, purpose: str = "", scheme: str = "https", port: int = 443) -> Iterator[Dict]:
    """For a library that makes its own connection (web search, YouTube transcripts, model downloads): refuses while
    offline, otherwise records the connection (its size is not known) and lets the library run."""
    if is_offline() and classify(host) != "this_pc":
        record(feature, host, purpose=purpose, scheme=scheme, port=port, outcome="blocked", error="offline mode")
        raise OfflineBlocked(host, feature)
    entry = record(feature, host, purpose=purpose, scheme=scheme, port=port, bytes_out=None, bytes_in=None)
    token = _in_flight(feature, host)
    try:
        yield entry
    except Exception as e:
        if entry.get("id"):
            entry.update(outcome="error", error=f"{type(e).__name__}: {e}"[:200])
            _append(entry)
        raise
    finally:
        _ctx.reset(token)


def is_cloud_model(name: str) -> bool:
    """Ollama's ":cloud" models run on Ollama's servers although the app talks to the local Ollama."""
    n = (name or "").lower()
    return bool(n) and (n.endswith(":cloud") or n.endswith("-cloud") or ":cloud" in n.split("/")[-1] or "-cloud" in n.split(":")[-1])


def check_model(name: str) -> None:
    """Called before a model is used: a cloud model is a connection to the internet and obeys the offline switch."""
    if not is_cloud_model(name):
        return
    if is_offline():
        record("ollama_cloud_model", "ollama.com", scheme="https", outcome="blocked", error="offline mode")
        raise OfflineBlocked("ollama.com", "ollama_cloud_model")
    record("ollama_cloud_model", "ollama.com", scheme="https", via="local Ollama", bytes_out=None)


# ---------------------------------------------------------------------------------------------------------------
# second line of defence: the socket layer
# ---------------------------------------------------------------------------------------------------------------
def _guard_address(sock, address) -> None:
    if sock.family not in (socket.AF_INET, socket.AF_INET6) or not isinstance(address, tuple):
        return
    host = str(address[0])
    if classify(host) == "this_pc":
        return
    name = _names.get(host, host)
    if is_offline():
        record("unattributed", name, purpose="Blocked at the socket layer", port=address[1], outcome="blocked",
               error="offline mode")
        raise OfflineBlocked(name, "unattributed")
    if _ctx.get() is None:
        record("unattributed", name, purpose=FEATURES["unattributed"], port=address[1])


def _guarded_connect(self, address):
    _guard_address(self, address)
    return _real_connect(self, address)


def _guarded_connect_ex(self, address):
    try:
        _guard_address(self, address)
    except OfflineBlocked:
        return 111  # ECONNREFUSED: what connect_ex reports instead of raising
    return _real_connect_ex(self, address)


def _guarded_getaddrinfo(host, *args, **kwargs):
    name = host.decode() if isinstance(host, bytes) else host
    if name is not None and is_offline() and classify(str(name)) != "this_pc":
        try:
            ipaddress.ip_address(str(name).strip("[]"))  # a number needs no lookup; connect() decides about it
        except ValueError:
            record("unattributed", str(name), purpose="Name lookup blocked (DNS)", outcome="blocked", error="offline mode")
            raise OfflineBlocked(str(name), "dns")
    result = _real_getaddrinfo(host, *args, **kwargs)
    if name and not is_offline():
        for info in result:
            _names.setdefault(info[4][0], str(name))
    return result


_installed = False


def install() -> None:
    """Puts the checks into socket. Safe to call more than once."""
    global _installed
    if _installed:
        return
    socket.socket.connect = _guarded_connect
    socket.socket.connect_ex = _guarded_connect_ex
    socket.getaddrinfo = _guarded_getaddrinfo
    _installed = True


def uninstall() -> None:
    global _installed
    socket.socket.connect = _real_connect
    socket.socket.connect_ex = _real_connect_ex
    socket.getaddrinfo = _real_getaddrinfo
    _installed = False
