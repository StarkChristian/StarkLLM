"""Meeting assistant (2.8, option 13 of the approved plan): record a meeting on this PC, write it down with times,
summarize it, and turn what was agreed into tasks the user confirms one by one.

Recording. The page records the microphone (on Windows, if the user wants, also the sound of this PC, so an online call
is captured without a bot joining it) and sends a part every PART_SECONDS. Each part is a file of its own, written
through the vault (encrypted while protection is on) under a temporary name and then renamed, so a part on disk is
always whole. A crash of the page, the app or the PC loses at most the part that was being recorded (less than a
minute). After a restart the session is still there and can be written down or discarded (`unfinished`).

    data/uploads/meetings/<session>/meta.json             who, which workspace, when, consent
    data/uploads/meetings/<session>/part-000000.part      the parts, in order (one MediaRecorder stream, cut in time)
    data/uploads/meetings/<prefix>.webm                   the whole recording after Stop (the session folder goes)
    data/uploads/<prefix>_Meeting 2026-11-28 14.05.txt    the document: one line per sentence, "[00:12:30] ..."

Everything is under the upload folder, so the protection switch, the migration and the backup treat the audio like
every document. The text is the document; the audio is kept beside it until the user deletes it ("keep the text").

Summary. The local model reads the transcript in windows and names decisions, open points and tasks, each with the
time it was said. Nothing it says is taken on trust (`check_summary`): an item must point to a line of the transcript;
a task's owner is kept only if that name was said there, a due date only if those words were said there. A date that
is said ("by 15 December") gets its day; a weekday or "next week" stays words, no date is made up. Tasks are only
proposals until the user adds each one (api/meetings.py).
"""
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from datetime import date, datetime
from typing import Callable, Dict, List, Optional, Tuple

from app.core.config import settings
from app.services import vault

logger = logging.getLogger(__name__)

PART_SECONDS = 15                      # the page sends a part this often; a crash loses at most one part
MAX_PART_BYTES = 25 * 1024 * 1024      # a part of 15 s is far smaller (Opus: about 60 KB; WAV 16 kHz: 0.5 MB)
MAX_PARTS = 4 * 3600 // PART_SECONDS + 60   # four hours, as for recordings
ACTIVE_SECONDS = 90                    # a session whose last part is younger is still recording (another window)
AUDIO_TYPES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/wav": ".wav"}
_SID = re.compile(r"^[0-9a-f]{32}$")
_PART = re.compile(r"^part-(\d{6})\.part$")


class MeetingError(ValueError):
    pass


# ------------------------------------------------------------------------------------------------ live recording

def meetings_dir() -> str:
    return os.path.join(os.path.abspath(settings.UPLOAD_DIR), "meetings")


def _session_dir(sid: str) -> str:
    if not _SID.match(sid or ""):
        raise MeetingError("Not a recording")
    return os.path.join(meetings_dir(), sid)


def start_session(user_id: int, workspace_id: int, mime: str = "audio/webm", system_audio: bool = False,
                  language: Optional[str] = None) -> str:
    """A new recording session; the caller has checked the consent and the workspace."""
    sid = secrets.token_hex(16)
    folder = _session_dir(sid)
    os.makedirs(folder, exist_ok=True)
    base = (mime or "audio/webm").split(";")[0].strip().lower()
    meta = {"user_id": int(user_id), "workspace_id": int(workspace_id), "mime": base if base in AUDIO_TYPES else "audio/webm",
            "system_audio": bool(system_audio), "language": (language or None),
            "started": datetime.now().isoformat(timespec="seconds"), "consent": datetime.now().isoformat(timespec="seconds")}
    vault.write_text(os.path.join(folder, "meta.json"), json.dumps(meta))
    return sid


def session_meta(sid: str) -> Dict:
    path = os.path.join(_session_dir(sid), "meta.json")
    if not os.path.exists(path):
        raise MeetingError("Not a recording")
    return json.loads(vault.read_text(path))


def save_part(sid: str, index: int, data: bytes) -> Dict:
    """Store part `index` of a session. Written under a temporary name and renamed: a part on disk is always whole.
    Sending the same part again (a retry after a network hiccup) replaces it."""
    folder = _session_dir(sid)
    if not os.path.isdir(folder):
        raise MeetingError("Not a recording")
    if not isinstance(index, int) or index < 0 or index >= MAX_PARTS:
        raise MeetingError("The recording is too long")
    if not data:
        raise MeetingError("The part is empty")
    if len(data) > MAX_PART_BYTES:
        raise MeetingError("The part is too large")
    final = os.path.join(folder, f"part-{index:06d}.part")
    tmp = final[:-5] + ".tmp"
    with vault.open_write(tmp) as f:
        f.write(data)
    os.replace(tmp, final)
    return session_info(sid)


def parts(sid: str) -> List[str]:
    """The whole parts of a session in order. A ".tmp" left by a crash in the middle of writing is not one."""
    folder = _session_dir(sid)
    if not os.path.isdir(folder):
        return []
    names = sorted(n for n in os.listdir(folder) if _PART.match(n))
    return [os.path.join(folder, n) for n in names]


def session_info(sid: str) -> Dict:
    meta = session_meta(sid)
    found = parts(sid)
    last = max((os.path.getmtime(p) for p in found), default=os.path.getmtime(os.path.join(_session_dir(sid), "meta.json")))
    return {"id": sid, "workspace_id": meta["workspace_id"], "started": meta["started"], "parts": len(found),
            "bytes": sum(vault.size(p) for p in found), "seconds": len(found) * PART_SECONDS,
            "system_audio": meta.get("system_audio", False), "active": time.time() - last < ACTIVE_SECONDS}


def unfinished(user_id: int) -> List[Dict]:
    """Recordings of this user that were never stopped (the app or the PC stopped first): they can be written down
    or discarded. Sessions without a single part that are no longer active are removed."""
    out = []
    root = meetings_dir()
    if not os.path.isdir(root):
        return out
    for sid in sorted(os.listdir(root)):
        if not _SID.match(sid) or not os.path.isdir(os.path.join(root, sid)):
            continue
        try:
            info = session_info(sid)
            if session_meta(sid)["user_id"] != user_id:
                continue
        except Exception as e:  # locked, or a folder without meta: left alone
            logger.warning(f"Meeting session {sid} cannot be read: {e}")
            continue
        if info["parts"] == 0:
            if not info["active"]:
                discard(sid)
            continue
        out.append(info)
    return out


def discard(sid: str) -> None:
    shutil.rmtree(_session_dir(sid), ignore_errors=True)


def audio_extension(sid: str) -> str:
    return AUDIO_TYPES.get(session_meta(sid).get("mime"), ".webm")


def assemble(sid: str, dest: str) -> int:
    """The parts one after the other into one file (the parts are pieces of one recorder stream, so together they are
    the recording). Encrypted while protection is on. Returns the size of the recording."""
    found = parts(sid)
    if not found:
        raise MeetingError("Nothing was recorded")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    total = 0
    with vault.open_write(dest) as out:
        for p in found:
            for block in vault.iter_bytes(p):
                out.write(block)
                total += len(block)
    return total


# ------------------------------------------------------------------------------------------------ the transcript

_LINE = re.compile(r"^\[(\d{2,}):([0-5]\d):([0-5]\d)\]\s?(.*)$")


def stamp_seconds(value) -> Optional[int]:
    """"00:12:30", "[00:12:30]", "12:30" -> seconds; None when it is not a time."""
    m = re.fullmatch(r"\s*\[?\s*(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)\s*\]?\s*", str(value or ""))
    if not m:
        return None
    return int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))


def transcript_lines(text: str) -> List[Dict]:
    """The timed lines of a transcript: [{"seconds", "stamp", "text"}]."""
    out = []
    for raw in (text or "").splitlines():
        m = _LINE.match(raw.strip())
        if m:
            secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
            out.append({"seconds": secs, "stamp": f"{int(m.group(1)):02d}:{m.group(2)}:{m.group(3)}", "text": m.group(4).strip()})
    return out


def is_transcript(text: str) -> bool:
    """A text whose lines are "[hh:mm:ss] ..." (a meeting written down here): searched by passages with their time."""
    lines = [l for l in (text or "").splitlines() if l.strip()]
    if len(lines) < 1:
        return False
    timed = sum(1 for l in lines if _LINE.match(l.strip()))
    return timed >= max(1, int(0.8 * len(lines)))


def transcript_passages(text: str) -> List[Dict]:
    from app.services.recordings import passages
    return passages({"start": l["seconds"], "end": l["seconds"], "text": l["text"]} for l in transcript_lines(text))


def transcript_text(heard: Dict) -> str:
    """recordings.transcribe's result -> the document text, one timed line per segment."""
    return "\n".join(p["text"] for p in heard.get("passages", [])).strip() + "\n"


# ------------------------------------------------------------------------------------------------ summary

SUMMARY_INSTRUCTION = """You get part of the transcript of a meeting. Every line starts with the time it was said, [hh:mm:ss].
Answer with JSON only, in this form:
{"decisions": [{"text": "...", "time": "hh:mm:ss"}],
 "open_points": [{"text": "...", "time": "hh:mm:ss"}],
 "tasks": [{"text": "what is to be done", "owner": "the name of the person who will do it, as said", "due": "the deadline, copied word for word from the line", "time": "hh:mm:ss"}]}
Rules:
- Only what was said in the transcript. "time" is the time of the line where it was said.
- A task's "owner" is null unless a name was said for it. Never guess a name. Not "I", "we" or "you".
- A task's "due" is null unless a deadline was said for it. Copy the words exactly ("by 15 December", "bis Freitag"). Never make up a date.
- Decisions are what was decided; open points are questions left open or things still to be clarified.
- Write the texts in the language of the transcript. Leave a list empty when there is nothing for it."""

WINDOW_CHARS = 6000
CONTEXT_LINES = 1          # an owner or a date may be said in the line before or after the task
_PRONOUNS = {"i", "me", "we", "us", "you", "he", "she", "they", "someone", "somebody", "everyone", "team", "all",
             "ich", "wir", "du", "sie", "er", "ihr", "jemand", "alle", "man",
             "yo", "nosotros", "usted", "ustedes", "tú", "alguien", "todos",
             "je", "nous", "vous", "tu", "il", "elle", "on", "quelqu'un", "tous",
             "io", "noi", "lei", "tu", "voi", "qualcuno", "tutti",
             "ben", "biz", "siz", "sen", "o", "onlar", "birisi", "herkes",
             "null", "none", "n/a", "na", "tbd", "unknown", "unassigned", "-", ""}


def windows(lines: List[Dict], max_chars: int = WINDOW_CHARS) -> List[List[Dict]]:
    out, cur, size = [], [], 0
    for l in lines:
        row = len(l["text"]) + 12
        if cur and size + row > max_chars:
            out.append(cur)
            cur, size = [], 0
        cur.append(l)
        size += row
    if cur:
        out.append(cur)
    return out


def _json_of(answer: str) -> Dict:
    """The JSON object in a model's answer (it may be wrapped in ``` or have words around it); {} when there is none."""
    text = (answer or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^\w\s'’./:-]", " ", str(s or "").casefold()).split())


def _words(s: str) -> set:
    return {w for w in re.findall(r"\w+", str(s or "").casefold()) if len(w) >= 4}


def _said_in(phrase: str, context: str) -> bool:
    p, c = _norm(phrase), _norm(context)
    if not p:
        return False
    return re.search(rf"(?<!\w){re.escape(p)}(?!\w)", c) is not None


def _source_line(item: Dict, lines: List[Dict]) -> Optional[int]:
    """The index of the line an item was said in: the line at its time, else the line around that time (or anywhere,
    without a time) with the most words in common. None when nothing in the transcript fits: the item is left out."""
    if not lines:
        return None
    secs = stamp_seconds(item.get("time"))
    words = _words(item.get("text"))
    if secs is not None:
        exact = [i for i, l in enumerate(lines) if l["seconds"] == secs]
        if exact:
            return max(exact, key=lambda i: len(words & _words(lines[i]["text"])))
        near = [i for i, l in enumerate(lines) if abs(l["seconds"] - secs) <= 60]
    else:
        near = list(range(len(lines)))
    scored = [(len(words & _words(lines[i]["text"])), -abs(lines[i]["seconds"] - (secs or 0)), i) for i in near]
    scored = [s for s in scored if s[0] >= 1]
    return max(scored)[2] if scored else None


def _context(lines: List[Dict], i: int) -> str:
    lo, hi = max(0, i - CONTEXT_LINES), min(len(lines), i + CONTEXT_LINES + 1)
    return "\n".join(l["text"] for l in lines[lo:hi])


def _owner(raw, context: str) -> Optional[str]:
    """The owner as said in the transcript, or None: a name that was not said near the task is not kept."""
    name = " ".join(str(raw or "").split()).strip(" .,:;")
    if not name or name.casefold() in _PRONOUNS or len(name) > 60:
        return None
    if _said_in(name, context):
        m = re.search(rf"(?<!\w){re.escape(name)}(?!\w)", context, re.IGNORECASE)
        return m.group(0) if m else name
    first = name.split()[0]
    if first.casefold() not in _PRONOUNS and len(first) >= 2 and _said_in(first, context):
        m = re.search(rf"(?<!\w){re.escape(first)}(?!\w)", context, re.IGNORECASE)
        return m.group(0) if m else first
    return None


# "December 15", "Dec 15th" (without a year); the other spoken forms come from dates_service
def _said_date(text: str, reference: date) -> Optional[str]:
    """The day of a deadline as said ("by 15 December", "bis zum 9. Dezember", "until 2026-12-15"), ISO; None when
    the words name no day by themselves ("Friday", "next week", "end of the month")."""
    from app.services import dates_service as ds
    from app.services.locale_rules import month_number
    text = text or ""
    for i, p in enumerate(ds.DATE_PATTERNS):
        m = p.search(text)
        if not m:
            continue
        if i == 2 and int(m.group("a")) <= 12 and int(m.group("b")) <= 12:
            return None  # 03/04/2026 said or written without a rule: day or month first is not known
        d = ds._parse(m)
        if d:
            return d.isoformat()
    m = ds.NO_YEAR.search(text)
    if m:
        d = ds._without_year(int(m.group("d")), int(m.group("m")), reference)
        return d.isoformat() if d else None
    m = ds.NO_YEAR_NAMED.search(text)
    if m:
        d = ds._without_year(int(m.group("d")), month_number(m.group("mn")), reference)
        return d.isoformat() if d else None
    m = re.search(rf"(?<![\w])(?P<mn>{ds._MONTH_NAMES})\.?\s+(?:the\s+)?(?P<d>\d{{1,2}})(?:st|nd|rd|th|\.)?(?!\s*\d)(?![\w])",
                  text, re.IGNORECASE)
    if m:
        d = ds._without_year(int(m.group("d")), month_number(m.group("mn")), reference)
        return d.isoformat() if d else None
    return None


def _clean_text(value, limit=400) -> str:
    return " ".join(str(value or "").split())[:limit]


def check_summary(raw: Dict, lines: List[Dict], meeting_day: date) -> Dict:
    """What the model said, kept only as far as the transcript says it (see the module text). Returns
    {"decisions": [...], "open_points": [...], "tasks": [...]}; every item has "time" (hh:mm:ss of its line) and "quote"
    (that line); a task has "owner", "due_text" and "due_date" (ISO) or None for each, and "status": "proposed"."""
    out = {"decisions": [], "open_points": [], "tasks": []}
    for kind in ("decisions", "open_points", "tasks"):
        items = raw.get(kind) if isinstance(raw, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, str):
                item = {"text": item}
            if not isinstance(item, dict):
                continue
            text = _clean_text(item.get("text"))
            if not text:
                continue
            i = _source_line({"text": text, "time": item.get("time")}, lines)
            if i is None:
                logger.info(f"Meeting summary: an item without a line in the transcript was left out ({kind})")
                continue
            line = lines[i]
            entry = {"text": text, "time": line["stamp"], "seconds": line["seconds"], "quote": line["text"]}
            if kind == "tasks":
                context = _context(lines, i)
                due_text = _clean_text(item.get("due"), 80)
                if due_text.casefold() in _PRONOUNS or not _said_in(due_text, context):
                    due_text = ""
                entry.update({"owner": _owner(item.get("owner"), context), "due_text": due_text or None,
                              "due_date": _said_date(due_text, meeting_day) if due_text else None,
                              "status": "proposed"})
            if any(_norm(e["text"]) == _norm(text) and e["time"] == entry["time"] for e in out[kind]):
                continue
            out[kind].append(entry)
    for kind in out:
        out[kind].sort(key=lambda e: e["seconds"])
    for n, task in enumerate(out["tasks"]):
        task["index"] = n
    return out


def _ask_model(window_text: str) -> str:
    from app.services import untrusted
    from app.services.llm_service import llm_service
    messages = [{"role": "system", "content": "You write meeting minutes. You only report what is in the transcript.\n"
                 + untrusted.UNTRUSTED_RULE},
                {"role": "user", "content": f"{SUMMARY_INSTRUCTION}\n\n{untrusted.data_block(window_text)}"}]
    result = llm_service.generate_chat(model=settings.DEFAULT_TEXT_MODEL, messages=messages, stream=False,
                                       options={"temperature": 0.1, "num_predict": 1500})
    return ((result or {}).get("message") or {}).get("content", "")


def summarize(text: str, meeting_day: date, ask: Callable[[str], str] = None) -> Dict:
    """The summary of a transcript: the model per window of lines, every answer checked against the lines."""
    ask = ask or _ask_model
    lines = transcript_lines(text)
    if not lines:
        raise MeetingError("The transcript is empty")
    merged = {"decisions": [], "open_points": [], "tasks": []}
    for part in windows(lines):
        body = "\n".join(f"[{l['stamp']}] {l['text']}" for l in part)
        checked = check_summary(_json_of(ask(body)), part, meeting_day)
        for kind in merged:
            merged[kind].extend(checked[kind])
    for kind in merged:
        merged[kind].sort(key=lambda e: e["seconds"])
    for n, task in enumerate(merged["tasks"]):
        task["index"] = n
    return merged


# ------------------------------------------------------------------------------------------------ after Stop

_jobs_lock = threading.Lock()
_running: set = set()


def transcribe_meeting(meeting_id: int, transcribe: Callable = None) -> None:
    """Background job after Stop: write the recording down (as recordings do, with times, on this PC), store the
    text as the meeting's document and index it like every document."""
    from app.api import documents as docs_api
    from app.db import models
    from app.db.session import SessionLocal
    from app.services import recordings
    transcribe = transcribe or recordings.transcribe
    with _jobs_lock:
        if meeting_id in _running:
            return
        _running.add(meeting_id)
    db = SessionLocal()
    try:
        m = db.get(models.MeetingRecording, meeting_id)
        doc = db.get(models.Document, m.document_id) if m else None
        if not m or not doc:
            return
        ws = db.get(models.Workspace, doc.workspace_id)
        doc.status = models.DocStatus.EXTRACTING
        m.status = "transcribing"
        db.commit()
        doc_id, workspace_id, user_id, path, audio, language = doc.id, doc.workspace_id, ws.user_id, doc.filepath, m.audio_path, m.language
    finally:
        db.close()
    try:
        if not audio or not os.path.exists(audio):
            raise MeetingError("The recording is no longer on this PC.")
        with vault.plain_path(audio) as readable:
            heard = transcribe(readable, language=language)
        text = transcript_text(heard)
        if not transcript_lines(text):
            raise MeetingError("No speech was heard in the recording. Is the right microphone chosen?")
        vault.write_text(path, text)
        db = SessionLocal()
        try:
            m = db.get(models.MeetingRecording, meeting_id)
            if m:
                m.duration = float(heard.get("duration") or 0)
                m.language = heard.get("language") or m.language
                m.status = "ready"
                db.commit()
        finally:
            db.close()
        docs_api._index_document_background(doc_id, workspace_id, user_id, path)
    except Exception as e:
        logger.error(f"Meeting {meeting_id} could not be written down: {e}", exc_info=True)
        docs_api._set_doc_status(doc_id, models.DocStatus.FAILED, error_message=str(e)[:300] or "The meeting could not be written down.")
        db = SessionLocal()
        try:
            m = db.get(models.MeetingRecording, meeting_id)
            if m:
                m.status = "failed"
                db.commit()
        finally:
            db.close()
    finally:
        with _jobs_lock:
            _running.discard(meeting_id)


def resume(document_id: int) -> bool:
    """Called at the start for a document whose indexing was cut off and whose file is missing: when it is a meeting
    whose recording is still there, it is written down again (True)."""
    from app.db import models
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        m = db.query(models.MeetingRecording).filter(models.MeetingRecording.document_id == document_id).first()
        if not m or not m.audio_path or not os.path.exists(m.audio_path):
            return False
        meeting_id = m.id
    finally:
        db.close()
    threading.Thread(target=transcribe_meeting, args=(meeting_id,), daemon=True).start()
    return True


def remove_audio(path: Optional[str]) -> None:
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError as e:
            logger.warning(f"Meeting audio could not be removed: {e}")
