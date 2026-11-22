"""Recordings as documents (docs/roadmap-2026-12.md, R3): a meeting, a lecture or a voice memo becomes a text with
times, written by the Whisper model StarkLLM already uses for dictation, on this PC (no service, no bot in a call).
The text is indexed like every document: the user asks about it, searches it, has it summarized.

  [00:00:04] Good morning, let's start with the budget.
  [00:00:11] The budget for December is 4,200 euros ...

Passages are about two minutes or 1,200 characters long, each starting with its time, so an answer can say where
in the recording something was said.
"""
import logging
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

# audio files, and video files for their sound (Whisper reads them with its own decoder, PyAV)
RECORDING_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".wma", ".webm", ".mp4", ".mov", ".mkv"}
MAX_HOURS = 4
MAX_BYTES = 500 * 1024 * 1024


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
    """The whole recording -> {"language", "duration", "passages"}. model: the Whisper model (voice_service.model)."""
    if model is None:
        from app.services.voice_service import voice_service
        model = voice_service.model
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
    logger.info(f"Recording: {len(found)} segments, {duration:.0f} s, language {getattr(info, 'language', '?')}")
    return {"language": getattr(info, "language", None), "duration": duration, "passages": passages(found)}
