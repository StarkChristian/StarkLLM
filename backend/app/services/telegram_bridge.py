"""Telegram bridge: ask StarkLLM from the phone (roadmap phase 3).

The bridge only makes outgoing HTTPS requests to Telegram (long polling, getUpdates), so the PC opens no port and
stays unreachable from the internet. It is off until the user enters the token of their own bot in Settings.

Pairing: Settings shows a 6-digit code (valid 10 minutes); sending it to the bot (or "/start <code>") pairs that
Telegram chat with the StarkLLM user who switched the bridge on. Only paired chats get answers; any other chat gets
one short "this bot is private" reply. Questions go through StarkLLM's normal chat (documents of the first
workspace and the knowledge base) and are stored as a chat named "Telegram" there. Questions and answers pass
through Telegram's servers; the Settings page says so before the user switches it on.

State lives in data/telegram.json (token, owner, paired chats, current StarkLLM chat per Telegram chat).
"""
import json
import logging
import os
import secrets
import threading
import time
from typing import Callable, Optional

import httpx

logger = logging.getLogger(__name__)
# httpx logs every request URL at INFO, and Telegram's URLs contain the bot token: keep it out of the engine log
logging.getLogger("httpx").setLevel(logging.WARNING)

API = "https://api.telegram.org"
STATE_FILE = os.path.join(os.path.abspath("data"), "telegram.json")
CODE_TTL_S = 10 * 60
MAX_WRONG_CODES = 5
TELEGRAM_LIMIT = 4096  # characters per message

HELP = (
    "Ask me anything about your documents.\n"
    "/new starts a new conversation.\n"
    "Answers come from StarkLLM on your PC; questions and answers pass through Telegram."
)


def load_state(path: Optional[str] = None) -> dict:
    path = path or STATE_FILE
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict, path: Optional[str] = None) -> None:
    path = path or STATE_FILE
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)  # the token is a secret
    except OSError:
        pass


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list:
    """Telegram allows 4096 characters per message: split at paragraph or line ends where possible."""
    text = text.strip() or "(empty answer)"
    parts = []
    while len(text) > limit:
        cut = text.rfind("\n\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    parts.append(text)
    return parts


def new_pairing_code(state: dict, now: Optional[float] = None) -> str:
    code = f"{secrets.randbelow(1_000_000):06d}"
    state["pairing"] = {"code": code, "expires": (time.time() if now is None else now) + CODE_TTL_S}
    return code


def code_from(text: str) -> Optional[str]:
    """The pairing code in "/start 123456" or "123456"."""
    words = text.strip().split()
    if words and words[0].startswith("/start"):
        words = words[1:]
    return words[0] if len(words) == 1 and words[0].isdigit() and len(words[0]) == 6 else None


class TelegramBridge:
    """answer(owner_user_id, chat_id_or_None, question) -> (answer_text, starkllm_chat_id, sources)"""

    def __init__(self, answer: Callable, state_file: Optional[str] = None, client: Optional[httpx.Client] = None):
        self.answer = answer
        self.state_file = state_file  # None: STATE_FILE
        self.client = client or httpx.Client(timeout=40)
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.last_error = ""

    # ---- Telegram API
    def call(self, method: str, token: str, **params):
        r = self.client.post(f"{API}/bot{token}/{method}", json=params, timeout=params.get("timeout", 0) + 15)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("description") or f"Telegram {method} failed (HTTP {r.status_code})")
        return data["result"]

    def check_token(self, token: str) -> dict:
        """getMe: the bot's name, or an error for a wrong token."""
        return self.call("getMe", token)

    def send(self, token: str, chat_id: int, text: str):
        for part in split_message(text):
            self.call("sendMessage", token, chat_id=chat_id, text=part, disable_web_page_preview=True)

    # ---- one update
    def handle(self, update: dict, now: Optional[float] = None) -> None:
        msg = update.get("message") or {}
        text = (msg.get("text") or "").strip()
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if not chat_id or not text:
            return
        with self.lock:
            state = load_state(self.state_file)
        token = state.get("token")
        if not token:
            return
        paired = {str(c["chat_id"]): c for c in state.get("chats", [])}
        key = str(chat_id)

        if key not in paired:
            self._pair_or_refuse(state, chat, text, now)
            return
        if text.startswith("/start") or text.startswith("/help"):
            self.send(token, chat_id, HELP)
            return
        if text.startswith("/new"):
            with self.lock:
                state = load_state(self.state_file)
                for c in state.get("chats", []):
                    if str(c["chat_id"]) == key:
                        c["starkllm_chat_id"] = None
                save_state(state, self.state_file)
            self.send(token, chat_id, "New conversation started.")
            return

        try:
            self.call("sendChatAction", token, chat_id=chat_id, action="typing")
        except Exception:  # only a hint
            pass
        try:
            reply, starkllm_chat_id, sources = self.answer(state["owner_user_id"], paired[key].get("starkllm_chat_id"), text)
        except Exception as e:
            logger.warning(f"Telegram bridge: answer failed: {e}")
            self.send(token, chat_id, f"StarkLLM could not answer: {e}")
            return
        if sources:
            reply += "\n\nSources: " + "; ".join(sources[:5])
        self.send(token, chat_id, reply)
        with self.lock:
            state = load_state(self.state_file)
            for c in state.get("chats", []):
                if str(c["chat_id"]) == key:
                    c["starkllm_chat_id"] = starkllm_chat_id
            save_state(state, self.state_file)

    def _pair_or_refuse(self, state: dict, chat: dict, text: str, now: Optional[float]):
        token, chat_id = state["token"], chat["id"]
        now = time.time() if now is None else now
        code = code_from(text)
        pairing = state.get("pairing") or {}
        wrong = state.setdefault("wrong_codes", {})
        tries = wrong.get(str(chat_id), 0)
        if code and tries < MAX_WRONG_CODES and pairing.get("code") == code and pairing.get("expires", 0) > now:
            name = " ".join(x for x in [chat.get("first_name"), chat.get("last_name")] if x) or chat.get("username") or str(chat_id)
            with self.lock:
                state = load_state(self.state_file)
                state.setdefault("chats", []).append({"chat_id": chat_id, "name": name, "starkllm_chat_id": None, "paired_at": int(now)})
                state.pop("pairing", None)
                state.get("wrong_codes", {}).pop(str(chat_id), None)
                save_state(state, self.state_file)
            self.send(token, chat_id, "Paired with StarkLLM on your PC.\n\n" + HELP)
            return
        if code:
            with self.lock:
                state = load_state(self.state_file)
                state.setdefault("wrong_codes", {})[str(chat_id)] = tries + 1
                save_state(state, self.state_file)
            if tries + 1 >= MAX_WRONG_CODES:
                return  # stop answering a chat that guesses codes
            self.send(token, chat_id, "This code is not valid. Create a new code in StarkLLM: Settings > Telegram.")
            return
        if tries == 0:
            with self.lock:
                state = load_state(self.state_file)
                state.setdefault("wrong_codes", {})[str(chat_id)] = 0.5  # told once
                save_state(state, self.state_file)
            self.send(token, chat_id, "This bot is private. To pair it, send the code shown in StarkLLM: Settings > Telegram.")

    # ---- polling loop
    def poll_once(self, timeout: int = 25) -> int:
        state = load_state(self.state_file)
        token = state.get("token")
        if not token or not state.get("enabled"):
            return 0
        updates = self.call("getUpdates", token, offset=state.get("offset", 0), timeout=timeout, allowed_updates=["message"])
        for u in updates:
            try:
                self.handle(u)
            except Exception as e:
                logger.warning(f"Telegram bridge: update {u.get('update_id')} failed: {e}")
            with self.lock:
                st = load_state(self.state_file)
                st["offset"] = u["update_id"] + 1
                save_state(st, self.state_file)
        return len(updates)

    def run(self):
        delay = 1
        while not self.stop_event.is_set():
            try:
                self.poll_once()
                self.last_error = ""
                delay = 1
            except Exception as e:
                self.last_error = str(e)
                logger.warning(f"Telegram bridge: {e}")
                self.stop_event.wait(delay)
                delay = min(delay * 2, 60)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name="telegram-bridge", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    @property
    def running(self) -> bool:
        return bool(self.thread and self.thread.is_alive() and not self.stop_event.is_set())
