import base64
from app.services.llm_service import llm_service, LLMBackendError
from app.core.config import settings
import os

class VisionService:
    def __init__(self):
        self.vision_model = settings.DEFAULT_VISION_MODEL

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
            response = llm_service.generate_chat(self.vision_model, messages, stream=False)
        except LLMBackendError as e:
            if e.kind == "empty_answer":
                return ""  # nothing to describe (e.g. a blank PDF page); the caller skips empty descriptions
            raise
        return response.get("message", {}).get("content", "")

vision_service = VisionService()
