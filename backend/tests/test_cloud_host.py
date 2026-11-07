"""The chat says where a request goes when it leaves this PC (cloud model provider)."""
import json

import pytest

from app.services.llm_service import cloud_host


@pytest.mark.parametrize(
    "provider,base_url,expected",
    [
        ("ollama", None, None),
        ("ollama", "http://host.docker.internal:11434", None),
        ("openai_compatible", "https://api.deepseek.com/v1", "api.deepseek.com"),
        ("openai_compatible", "https://openrouter.ai/api/v1", "openrouter.ai"),
        ("openai_compatible", None, "api.openai.com"),
        ("openai_compatible", "http://localhost:1234/v1", None),
        ("openai_compatible", "http://127.0.0.1:1234/v1", None),
        ("openai_compatible", "http://192.168.1.20:8000/v1", None),
        ("openai_compatible", "http://10.0.0.5:8000/v1", None),
        ("openai_compatible", "http://gpu-box.local:8000/v1", None),
        # a base URL that is not Ollama is routed to the OpenAI-compatible client even with provider "ollama"
        ("ollama", "https://api.groq.com/openai/v1", "api.groq.com"),
    ],
)
def test_cloud_host(provider, base_url, expected):
    assert cloud_host(provider, base_url) == expected
