import os
import logging
from faster_whisper import WhisperModel
import subprocess
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Voice model registry
# Maps a voice identifier (sent by the frontend) → relative ONNX model path
# inside the container (/app/<path>).
# ---------------------------------------------------------------------------
VOICE_MODELS = {
    "en_US-lessac-medium":   "app/en_US-lessac-medium.onnx",
    "de_DE-thorsten-medium": "app/de_DE-thorsten-medium.onnx",
}
DEFAULT_VOICE = "en_US-lessac-medium"


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
                self._model = WhisperModel("base", device="cpu", compute_type="int8")
            except Exception as e:
                logger.error(f"Error initializing WhisperModel: {e}")
                raise
        return self._model

    def transcribe(self, audio_path: str) -> str:
        segments, info = self.model.transcribe(audio_path, beam_size=5)
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
        model_path = VOICE_MODELS.get(voice or DEFAULT_VOICE)
        if model_path is None:
            logger.warning(f"Warning: unknown voice '{voice}', falling back to default.")
            model_path = VOICE_MODELS[DEFAULT_VOICE]

        logger.info(f"TTS: voice={voice or DEFAULT_VOICE}, model={model_path}")

        # Pass text via stdin to avoid shell escaping issues (apostrophes, etc.)
        cmd = [
            "piper",
            "--model", model_path,
            "--output_file", output_path,
        ]
        subprocess.run(cmd, input=text.encode("utf-8"), check=True)


voice_service = VoiceService()

