import os
import re
import logging
from faster_whisper import WhisperModel
from app.core import netguard
import subprocess
import sys
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Voice model registry
# Maps a voice identifier (sent by the frontend) → ONNX model path. The built-in voices sit next to this code
# (backend/app/); they are found from here, not from the working directory: the engine without Docker runs in the
# user's StarkLLM folder, the container in /app.
# ---------------------------------------------------------------------------
_APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE_MODELS = {
    "en_US-lessac-medium":   os.path.join(_APP_DIR, "en_US-lessac-medium.onnx"),
    "de_DE-thorsten-medium": os.path.join(_APP_DIR, "de_DE-thorsten-medium.onnx"),
}
DEFAULT_VOICE = "en_US-lessac-medium"
# More voices: put a Piper voice (<name>.onnx and <name>.onnx.json, named like "fr_FR-siwis-medium") into the folder
# STARKLLM_VOICES_DIR; it is offered for texts in its language (docs/adding-a-language.md).
VOICES_DIR = os.getenv("STARKLLM_VOICES_DIR", "")


def _voice_language(voice_id: str) -> str:
    """"fr_FR-siwis-medium" -> "fr"."""
    return voice_id.split("_", 1)[0].lower()


def voice_models() -> dict:
    """Voice id -> model path: the built-in voices and the ones found in VOICES_DIR."""
    models = dict(VOICE_MODELS)
    if VOICES_DIR and os.path.isdir(VOICES_DIR):
        for name in sorted(os.listdir(VOICES_DIR)):
            stem = name[:-5] if name.endswith(".onnx") else None
            if stem and re.fullmatch(r"[a-z]{2,3}_[A-Z]{2}-[\w]+-\w+", stem) and os.path.exists(os.path.join(VOICES_DIR, name + ".json")):
                models.setdefault(stem, os.path.join(VOICES_DIR, name))
    return models


def available_voices() -> list:
    """[{"id", "language"}] of the voices whose files are here, the default voice first."""
    found = [{"id": vid, "language": _voice_language(vid)} for vid, path in voice_models().items() if os.path.exists(path)]
    return sorted(found, key=lambda v: (v["id"] != DEFAULT_VOICE, v["id"]))


def voice_for_language(language: Optional[str]) -> str:
    """The voice for a language code ("de", "fr-FR"); the default voice when there is none."""
    code = (language or "").lower().split("-")[0].split("_")[0]
    return next((v["id"] for v in available_voices() if v["language"] == code), DEFAULT_VOICE)


def piper_command() -> list:
    """Piper through the Python that runs the engine. The `piper` program of the Docker image is the same module, but
    the engine without Docker has no Scripts folder and its Python is not on PATH."""
    return [sys.executable, "-m", "piper"]


class VoiceService:
    def __init__(self):
        # Force CPU to avoid CUDA library errors in slim docker image
        # The model is downloaded on first use, so load it lazily: the backend
        # must start even when the model cannot be fetched (e.g. offline).
        self._model = None

    @property
    def model(self):
        if self._model is None:
            logger.info("Initializing WhisperModel on CPU...")
            try:
                try:
                    # the model is on this PC after its first download: then nothing is fetched at all
                    self._model = WhisperModel("base", device="cpu", compute_type="int8", local_files_only=True)
                except Exception:
                    # first use: a one-time download from huggingface.co, recorded, and refused while fully offline
                    with netguard.external("speech_model_download", "huggingface.co",
                                           purpose="One-time download of the speech recognition model"):
                        self._model = WhisperModel("base", device="cpu", compute_type="int8")
            except Exception as e:
                logger.error(f"Error initializing WhisperModel: {e}")
                raise
        return self._model

    def transcribe(self, audio_path: str, language: Optional[str] = None) -> str:
        """Speech to text. The language is found by the model itself (the "base" model knows about 100 languages);
        a code like "de" (a hint from the user) makes short recordings safer."""
        code = (language or "").lower().split("-")[0] or None
        segments, info = self.model.transcribe(audio_path, beam_size=5, language=code)
        text = " ".join([segment.text for segment in segments])
        return text.strip()

    def synthesize(self, text: str, output_path: str, voice: Optional[str] = None) -> None:
        """
        Synthesise speech using Piper TTS.

        :param text:        The text to speak.
        :param output_path: Absolute path for the output .wav file.
        :param voice:       Optional voice key from VOICE_MODELS.
                            Defaults to DEFAULT_VOICE if None or unrecognised.
        """
        # Resolve model path – fall back to default if voice is unknown
        models = voice_models()
        model_path = models.get(voice or DEFAULT_VOICE)
        if model_path is None:
            logger.warning(f"Warning: unknown voice '{voice}', falling back to default.")
            model_path = models[DEFAULT_VOICE]

        logger.info(f"TTS: voice={voice or DEFAULT_VOICE}, model={model_path}")

        # Pass text via stdin to avoid shell escaping issues (apostrophes, etc.)
        cmd = piper_command() + [
            "--model", model_path,
            "--output_file", output_path,
        ]
        subprocess.run(cmd, input=text.encode("utf-8"), check=True)


# EU AI Act, Art. 50(2): synthetic audio is marked as AI-generated in a machine-readable way. A WAV file carries
# the mark in a RIFF LIST/INFO chunk, which players ignore and tools (exiftool, ffprobe) show.
AI_MARK = "AI-generated speech: StarkLLM text-to-speech (Piper), made on this PC"


def mark_ai_generated(path: str) -> None:
    def sub(tag: bytes, text: str) -> bytes:
        data = text.encode("utf-8") + b"\0"
        if len(data) % 2:
            data += b"\0"
        return tag + len(data).to_bytes(4, "little") + data

    with open(path, "rb") as f:
        wav = f.read()
    if len(wav) < 12 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    info = b"INFO" + sub(b"ISFT", "StarkLLM") + sub(b"ICMT", AI_MARK)
    chunk = b"LIST" + len(info).to_bytes(4, "little") + info
    body = wav[12:] + chunk
    with open(path, "wb") as f:
        f.write(b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WAVE" + body)


voice_service = VoiceService()


def _self_test() -> int:
    """`python -m app.services.voice_service`: speaks a German sentence with Piper and reads it back with Whisper. CI
    runs it from the engine package for Windows (no Docker), started in another folder than the code."""
    import tempfile

    sentence = "Guten Tag, hier spricht StarkLLM."
    voices = [v["id"] for v in available_voices()]
    print("voices:", ", ".join(voices))
    if "de_DE-thorsten-medium" not in voices:
        print("the German voice is missing")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "sample.wav")
        voice_service.synthesize(sentence, wav, voice_for_language("de"))
        mark_ai_generated(wav)
        print("speech:", os.path.getsize(wav), "bytes")
        heard = voice_service.transcribe(wav, "de")
    print("heard:", heard)
    # the small Whisper model mishears a word now and then ("Udentag hier spricht ..."): most words must come back
    words = [w for w in ("guten", "tag", "hier", "spricht") if w in heard.lower()]
    return 0 if len(words) >= 3 else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    raise SystemExit(_self_test())
