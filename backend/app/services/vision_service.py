import base64
import logging
import os
import threading
import time

from app.services.llm_service import llm_service, LLMBackendError, ModelNotFoundError
from app.core.config import settings

logger = logging.getLogger(__name__)

PULL_RETRY_SECONDS = 300

class VisionService:
    def __init__(self):
        self.vision_model = settings.DEFAULT_VISION_MODEL
        self._pull_lock = threading.Lock()
        self._pull_failed = None  # (message, time) of the last failed download

    def _download_model(self):
        """The desktop app installs only the text and embedding models, so the vision model is downloaded the
        first time an image or scanned page needs it (found on Windows, 8 Nov 2026: every image failed
        with "model 'llava' not found"). One download at a time; after a failed download the next try waits 5 minutes."""
        with self._pull_lock:
            if self._pull_failed and time.monotonic() - self._pull_failed[1] < PULL_RETRY_SECONDS:
                raise ModelNotFoundError(self._pull_failed[0])
            installed = llm_service.get_available_models()
            if any(m == self.vision_model or m == f"{self.vision_model}:latest" for m in installed):
                return
            logger.info(f"Vision: downloading model '{self.vision_model}' for image indexing")
            try:
                llm_service.pull_model(self.vision_model)
            except Exception as e:
                message = (
                    f"The image model '{self.vision_model}' is not installed and could not be downloaded ({e}). "
                    f"Run 'ollama pull {self.vision_model}', then re-index the file."
                )
                self._pull_failed = (message, time.monotonic())
                raise ModelNotFoundError(message) from e
            self._pull_failed = None
            logger.info(f"Vision: model '{self.vision_model}' installed")

    def generate_image_description(self, image_path: str, prompt: str = None) -> str:
        """
        Takes an image path and uses the vision model to generate a highly detailed textual description
        to be embedded into the vector database. Allows for an optional custom prompt.
        """
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image not found at {image_path}")
            
        with open(image_path, "rb") as img_file:
            img_b64 = base64.b64encode(img_file.read()).decode("utf-8")
            
        default_prompt = "Describe this image in detail. Focus on the main subjects, actions, text, and overall context."
        
        messages = [
            {
                "role": "user",
                "content": prompt if prompt else default_prompt,
                "images": [img_b64]
            }
        ]
        
        try:
            try:
                response = llm_service.generate_chat(self.vision_model, messages, stream=False)
            except ModelNotFoundError:
                self._download_model()
                response = llm_service.generate_chat(self.vision_model, messages, stream=False)
        except LLMBackendError as e:
            if e.kind == "empty_answer":
                return ""  # nothing to describe (e.g. a blank page); callers skip empty descriptions
            raise
        return response.get("message", {}).get("content", "")

vision_service = VisionService()
