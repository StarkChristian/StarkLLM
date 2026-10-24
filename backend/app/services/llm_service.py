import requests
import json
import logging
import re
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

class ModelNotFoundError(Exception):
    """The requested model is not installed in Ollama."""


class LLMBackendError(requests.exceptions.RequestException):
    """Ollama could not answer. str(e) is a message the user can act on: no internal URLs, no raw HTTP text.

    kind: out_of_memory | timeout | unreachable | server_error;  http_status: what an API endpoint should answer with.
    """

    def __init__(self, message: str, kind: str = "server_error", http_status: int = 502):
        super().__init__(message)
        self.kind = kind
        self.http_status = http_status


_OUT_OF_MEMORY = re.compile(
    r"more system memory|out of memory|signal: killed|unable to allocate|cudamalloc|insufficient memory|failed to allocate|cannot allocate",
    re.I,
)
REQUEST_TIMEOUT_SECONDS = 150


def _ollama_error_text(response) -> str:
    """The 'error' text Ollama put in the body of a failed response (best effort, short)."""
    try:
        body = response.json()
    except ValueError:
        return (response.text or "").strip()[:300]
    if isinstance(body, dict):
        return str(body.get("error") or body)[:300]
    return str(body)[:300]


def explain_ollama_error(model: str, detail: str, status: int | None = None) -> LLMBackendError:
    if _OUT_OF_MEMORY.search(detail or ""):
        return LLMBackendError(
            f"Not enough free memory to run model '{model}'. Close other programs, or choose a smaller model "
            f"(for example run 'ollama pull qwen2.5:3b' and select it in the chat), then try again.",
            "out_of_memory", 503,
        )
    where = f" (HTTP {status})" if status else ""
    return LLMBackendError(f"Ollama could not answer with model '{model}'{where}" + (f": {detail}" if detail else "") + ".", "server_error", 502)


def _transport_error(model: str, e: requests.exceptions.RequestException) -> LLMBackendError | None:
    if isinstance(e, requests.exceptions.Timeout):
        return LLMBackendError(
            f"Model '{model}' did not answer within {REQUEST_TIMEOUT_SECONDS} seconds. It may still be loading, or this computer is too slow "
            f"for it. Try again, or choose a smaller model.", "timeout", 504,
        )
    if isinstance(e, requests.exceptions.ConnectionError):
        return LLMBackendError("Could not reach Ollama. Make sure Ollama is installed and running on this computer, then try again.", "unreachable", 502)
    return None

def _openai_compatible_error(e: requests.exceptions.RequestException) -> LLMBackendError:
    """Message for an OpenAI-compatible service (cloud API, LM Studio, vLLM) that did not answer; never includes the API key."""
    status = getattr(getattr(e, "response", None), "status_code", None)
    if status in (401, 403):
        return LLMBackendError("The service rejected the API key (HTTP %s). Check the key in the model settings." % status, "auth", 502)
    if status == 404:
        return LLMBackendError("The service does not know this model or address (HTTP 404). Check the model name and base URL.", "not_found", 502)
    if status == 429:
        return LLMBackendError("The service is rate limiting this key (HTTP 429). Wait a moment and try again.", "rate_limit", 502)
    if isinstance(e, requests.exceptions.Timeout):
        return LLMBackendError("The service did not answer in time. Try again.", "timeout", 504)
    if isinstance(e, requests.exceptions.ConnectionError):
        return LLMBackendError("Could not reach the service. Check the base URL and your internet connection.", "unreachable", 502)
    return LLMBackendError("The service could not answer" + (f" (HTTP {status})" if status else "") + ".", "server_error", 502)


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
                response = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
                if response.status_code == 404:
                    raise ModelNotFoundError(f"Model '{payload.get('model')}' not found in Ollama. Please ensure it is pulled (e.g. ollama pull {payload.get('model')}).")
                if response.status_code >= 400:
                    raise explain_ollama_error(payload.get("model"), _ollama_error_text(response), response.status_code)
                return response.json()
            except LLMBackendError as e:
                logger.error(f"LLM API Error ({e.kind}): {e}")
                raise
            except requests.exceptions.RequestException as e:
                logger.error(f"LLM API Error: {e}")
                friendly = _transport_error(payload.get("model"), e)
                if friendly:
                    raise friendly from e
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
            raise _openai_compatible_error(e) from e

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
            raise _openai_compatible_error(e) from e

    def _stream_response(self, url: str, payload: dict) -> Generator[str, None, None]:
        try:
            with requests.post(url, json=payload, stream=True, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                if response.status_code == 404:
                    raise ModelNotFoundError(f"Model '{payload.get('model')}' not found in Ollama. Please ensure it is pulled (e.g. ollama pull {payload.get('model')}).")
                if response.status_code >= 400:
                    raise explain_ollama_error(payload.get("model"), _ollama_error_text(response), response.status_code)
                for line in response.iter_lines():
                    if line:
                        data = json.loads(line)
                        if data.get("error"):
                            # Ollama reports a runner crash (often out of memory) as an error line inside a 200 stream
                            raise explain_ollama_error(payload.get("model"), str(data["error"])[:300])
                        if "message" in data and "content" in data["message"]:
                            yield data["message"]["content"]
        except LLMBackendError as e:
            logger.error(f"LLM Streaming API Error ({e.kind}): {e}")
            raise
        except requests.exceptions.RequestException as e:
            logger.error(f"LLM Streaming API Error: {e}")
            friendly = _transport_error(payload.get("model"), e)
            if friendly:
                raise friendly from e
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
