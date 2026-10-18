import requests
import json
import logging
from typing import Generator, List
from app.core.config import settings

logger = logging.getLogger(__name__)

RECOMMENDED_MODELS = [
    {
        "name": "llama3.2:3b",
        "title": "Llama 3.2 (3B)",
        "tagline": "Ultra-fast & lightweight — suitable for all systems",
        "category": "General / Fast",
        "size": "2.0 GB",
        "min_ram": "4 GB",
        "recommended_ram": "8 GB",
        "description": "Meta's compact model for fast chat, email drafting, and lightweight local document analysis."
    },
    {
        "name": "deepseek-r1:8b",
        "title": "DeepSeek R1 (8B)",
        "tagline": "Advanced reasoning & step-by-step problem solving",
        "category": "Reasoning / Math",
        "size": "4.9 GB",
        "min_ram": "8 GB",
        "recommended_ram": "16 GB",
        "description": "Open-weight reasoning powerhouse, exceptional for mathematics, complex logic, and analytical tasks."
    },
    {
        "name": "qwen2.5-coder:7b",
        "title": "Qwen 2.5 Coder (7B)",
        "tagline": "Professional coding, debugging & synthesis",
        "category": "Coding",
        "size": "4.7 GB",
        "min_ram": "8 GB",
        "recommended_ram": "16 GB",
        "description": "Top-tier local model for software engineering with deep support for Python, JavaScript, Go, Rust, and more."
    },
    {
        "name": "mistral:7b",
        "title": "Mistral (7B)",
        "tagline": "Stable, precise & ideal for RAG and documents",
        "category": "General / RAG",
        "size": "4.1 GB",
        "min_ram": "8 GB",
        "recommended_ram": "16 GB",
        "description": "Popular Mistral model with deep comprehension of extended contexts and knowledge base integration."
    },
    {
        "name": "phi3.5:mini",
        "title": "Phi 3.5 Mini (3.8B)",
        "tagline": "Compact efficiency from Microsoft",
        "category": "Compact",
        "size": "2.2 GB",
        "min_ram": "4 GB",
        "recommended_ram": "8 GB",
        "description": "Dense Microsoft model delivering exceptional reasoning, writing, and fast inference."
    },
    {
        "name": "nomic-embed-text:latest",
        "title": "Nomic Embed Text",
        "tagline": "High-precision vector embedding engine",
        "category": "Embedding",
        "size": "274 MB",
        "min_ram": "2 GB",
        "recommended_ram": "4 GB",
        "description": "Official high-accuracy model for semantic chunk embeddings and knowledge base vector indexing."
    }
]

class LLMService:
    def __init__(self):
        self.base_url = settings.OLLAMA_BASE_URL
        
    def get_available_models(self) -> List[str]:
        url = f"{self.base_url}/api/tags"
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            models = response.json().get("models", [])
            return [m["name"] for m in models]
        except Exception as e:
            logger.error(f"Error fetching Ollama models: {e}")
            return []

    def get_detailed_models(self) -> List[dict]:
        """Fetch full model metadata from Ollama (size, modified, parameters, etc.)."""
        url = f"{self.base_url}/api/tags"
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            models = response.json().get("models", [])
            return models
        except Exception as e:
            logger.error(f"Error fetching detailed Ollama models: {e}")
            return []

    def get_recommended_catalog(self) -> List[dict]:
        """Return curated list of recommended models with installation status."""
        installed = set(self.get_available_models())
        catalog = []
        for item in RECOMMENDED_MODELS:
            is_installed = any(
                item["name"] == m or item["name"].split(":")[0] == m.split(":")[0]
                for m in installed
            )
            catalog.append({
                **item,
                "is_installed": is_installed
            })
        return catalog

    def pull_model_stream(self, model_name: str) -> Generator[str, None, None]:
        """Stream progress of model download from Ollama."""
        url = f"{self.base_url}/api/pull"
        payload = {"name": model_name, "stream": True}
        try:
            with requests.post(url, json=payload, stream=True, timeout=1800) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        yield line.decode("utf-8") + "\n"
        except requests.exceptions.RequestException as e:
            logger.error(f"Error streaming pull for model {model_name}: {e}")
            yield json.dumps({"error": str(e)}) + "\n"

    def delete_model(self, model_name: str) -> bool:
        """Delete an installed model from Ollama."""
        url = f"{self.base_url}/api/delete"
        payload = {"name": model_name}
        try:
            response = requests.delete(url, json=payload, timeout=30)
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"Error deleting Ollama model {model_name}: {e}")
            return False

    def generate_chat(
        self,
        model: str,
        messages: list[dict],
        stream: bool = False,
        options: dict = None,
        provider: str = "ollama",
        api_key: str = None,
        base_url: str = None
    ):
        # OpenAI-Compatible endpoint (Cloud APIs or LM Studio / vLLM)
        if provider == "openai_compatible" or (base_url and "ollama" not in base_url.lower() and not base_url.endswith("/api")):
            target_base = base_url or "https://api.openai.com/v1"
            if stream:
                return self._stream_openai_compatible(target_base, api_key, model, messages, options)
            else:
                return self._generate_openai_compatible(target_base, api_key, model, messages, options)

        # Default: Local Ollama
        url = f"{self.base_url}/api/chat"
        payload = {
            "model": model,
            "messages": messages,
            "stream": stream
        }
        
        if options:
            payload["options"] = options
        
        if stream:
            return self._stream_response(url, payload)
        else:
            try:
                response = requests.post(url, json=payload, timeout=150)
                if response.status_code == 404:
                    raise ValueError(f"Model '{payload.get('model')}' not found in Ollama. Please ensure it is pulled (e.g. ollama run {payload.get('model')}).")
                response.raise_for_status()
                return response.json()
            except requests.exceptions.RequestException as e:
                logger.error(f"LLM API Error: {e}")
                raise

    def _stream_openai_compatible(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: list[dict],
        options: dict = None
    ) -> Generator[str, None, None]:
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json"
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "model": model,
            "messages": messages,
            "stream": True
        }
        if options:
            if "temperature" in options: payload["temperature"] = options["temperature"]
            if "top_p" in options: payload["top_p"] = options["top_p"]
            if "max_tokens" in options: payload["max_tokens"] = options["max_tokens"]

        try:
            with requests.post(url, json=payload, headers=headers, stream=True, timeout=180) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        line_str = line.decode("utf-8").strip()
                        if line_str.startswith("data: "):
                            data_str = line_str[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                                choices = chunk.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    content = delta.get("content", "")
                                    if content:
                                        yield content
                            except Exception:
                                pass
        except requests.exceptions.RequestException as e:
            logger.error(f"OpenAI-Compatible Streaming API Error: {e}")
            yield f"\n\n[API Error: {str(e)}]"

    def _generate_openai_compatible(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: list[dict],
        options: dict = None
    ) -> dict:
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "model": model,
            "messages": messages,
            "stream": False
        }
        if options:
            if "temperature" in options: payload["temperature"] = options["temperature"]
            if "top_p" in options: payload["top_p"] = options["top_p"]
            if "max_tokens" in options: payload["max_tokens"] = options["max_tokens"]

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=180)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {"message": {"content": content}}
        except requests.exceptions.RequestException as e:
            logger.error(f"OpenAI-Compatible API Error: {e}")
            raise

    def _stream_response(self, url: str, payload: dict) -> Generator[str, None, None]:
        try:
            with requests.post(url, json=payload, stream=True, timeout=150) as response:
                if response.status_code == 404:
                    yield f"\n\nError: Model '{payload.get('model')}' not found in Ollama. Please ensure it is pulled (e.g. ollama run {payload.get('model')})."
                    return
                response.raise_for_status()
                for line in response.iter_lines():
                    if line:
                        data = json.loads(line)
                        if "message" in data and "content" in data["message"]:
                            yield data["message"]["content"]
        except requests.exceptions.RequestException as e:
            logger.error(f"LLM Streaming API Error: {e}")
            raise

    def generate_embeddings(self, model: str, prompt: str) -> list[float]:
        url = f"{self.base_url}/api/embeddings"
        payload = {
            "model": model,
            "prompt": prompt
        }
        try:
            response = requests.post(url, json=payload)
            response.raise_for_status()
            return response.json().get("embedding", [])
        except requests.exceptions.RequestException as e:
            logger.error(f"LLM Embeddings API Error: {e}")
            raise

    def generate_embeddings_batch(self, model: str, prompts: List[str]) -> List[List[float]]:
        url = f"{self.base_url}/api/embed"
        payload = {
            "model": model,
            "input": prompts
        }
        try:
            response = requests.post(url, json=payload)
            response.raise_for_status()
            return response.json().get("embeddings", [])
        except requests.exceptions.RequestException as e:
            logger.error(f"LLM Batch Embeddings API Error: {e}")
            logger.warning("Falling back to single embedding generation...")
            return [self.generate_embeddings(model, p) for p in prompts]

llm_service = LLMService()
