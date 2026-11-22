"""Recordings as documents (docs/roadmap-2026-12.md, R3): a meeting, a lecture or a voice memo becomes a text with
times, written by the Whisper model StarkLLM already uses for dictation, on this PC (no service, no bot in a call).
The text is indexed like every document: the user asks about it, searches it, has it summarized.

  [00:00:04] Good morning, let's start with the budget.
  [00:00:11] The budget for December is 4,200 euros ...

Passages are about two minutes or 1,200 characters long, each starting with its time, so an answer can say where
in the recording something was said.
"""
import logging
import os
import threading
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

# audio files, and video files for their sound (Whisper reads them with its own decoder, PyAV)
RECORDING_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".wma", ".webm", ".mp4", ".mov", ".mkv"}
MAX_HOURS = 4
MAX_BYTES = 500 * 1024 * 1024

# The speech model for recordings: larger than the one for dictation (base), because a meeting is long and every
# date and amount counts. Measured on the test meetings of 2.5.0 (22 Nov 2026, CPU int8): base heard "die Zember" and
# "erneutende Zember" for "Dezember" / "am 9. Dezember"; large-v3-turbo wrote both meetings without an error, at about
# 0.6 x the recording time on a 16-core CPU. Downloaded once (about 1.6 GB) at the first recording, refused while
# fully offline: then the dictation model writes the recording down. STARKLLM_RECORDING_MODEL=base keeps the small one.
RECORDING_MODEL = os.environ.get("STARKLLM_RECORDING_MODEL", "large-v3-turbo")
_load_lock = threading.Lock()


def _recording_model():
    """(model, name) of the large speech model, or (None, "") when it cannot be had (offline, no space)."""
    name = RECORDING_MODEL
    if not name or name == "base":
        return None, ""
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # the native libraries could not load: the dictation model will say so too
        logger.warning(f"Recording: faster_whisper not available: {e}")
        return None, ""
    # half of the processor for a long background job: the PC stays usable
    threads = max(1, (os.cpu_count() or 2) // 2)
    try:
        return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True), name
    except Exception:
        pass
    try:
        from app.core import netguard
        with netguard.external("speech_model_download", "huggingface.co",
                               purpose="One-time download of the speech model for recordings (about 1.6 GB)"):
            return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads), name
    except Exception as e:
        logger.warning(f"Recording: the model {name} is not available ({e}); the dictation model writes it down")
        return None, ""


class RecordingError(ValueError):
    pass


def stamp(seconds: float) -> str:
    """12.3 -> "00:00:12"; 4000 -> "01:06:40"."""
    s = max(0, int(seconds or 0))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def passages(segments: Iterable[Dict], max_chars: int = 1200, max_seconds: float = 120) -> List[Dict]:
    """Whisper's segments [{start, end, text}] -> passages [{start, end, text}] where every line starts with its time."""
    out: List[Dict] = []
    cur: Optional[Dict] = None
    for seg in segments:
        text = " ".join(str(seg.get("text") or "").split())
        if not text:
            continue
        line = f"[{stamp(seg.get('start', 0))}] {text}"
        if cur and (len(cur["text"]) + len(line) + 1 > max_chars or float(seg.get("start", 0)) - cur["start"] >= max_seconds):
            out.append(cur)
            cur = None
        if cur is None:
            cur = {"start": float(seg.get("start", 0)), "end": float(seg.get("end", 0)), "text": line}
        else:
            cur["text"] += "\n" + line
            cur["end"] = float(seg.get("end", cur["end"]))
    if cur:
        out.append(cur)
    return out


def transcribe(path: str, language: Optional[str] = None, model=None) -> Dict:
    """The whole recording -> {"language", "duration", "passages", "model"}. model: a Whisper model (tests); by
    default the large model for recordings, else the dictation model (voice_service.model)."""
    if model is not None:
        return _transcribe_with(model, path, language, "given")
    with _load_lock:  # one large model in memory at a time; it is released after the recording
        big, name = _recording_model()
        if big is not None:
            try:
                return _transcribe_with(big, path, language, name)
            finally:
                del big
    from app.services.voice_service import voice_service
    return _transcribe_with(voice_service.model, path, language, "base")


def _transcribe_with(model, path: str, language: Optional[str], name: str) -> Dict:
    if model is None:
        raise RecordingError("The speech model is not available on this PC (it is downloaded once, while online).")
    code = (language or "").lower().split("-")[0] or None
    # the voice activity filter skips silence: faster, and no invented words in quiet parts
    segments, info = model.transcribe(path, beam_size=5, language=code, vad_filter=True)
    duration = float(getattr(info, "duration", 0) or 0)
    if duration > MAX_HOURS * 3600:
        raise RecordingError(f"The recording is longer than {MAX_HOURS} hours.")
    found = []
    for seg in segments:  # a generator: the work happens here
        found.append({"start": seg.start, "end": seg.end, "text": seg.text})
    logger.warning(f"Recording written down: {len(found)} segments, {duration:.0f} s, language {getattr(info, 'language', '?')}, speech model {name}")
    return {"language": getattr(info, "language", None), "duration": duration, "passages": passages(found), "model": name}
