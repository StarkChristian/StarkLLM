import os
import sys
from datetime import timedelta
import pytest

# Ensure backend root is on python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api.auth import create_access_token, get_password_hash, verify_password
from app.core.config import settings
from app.services.rag_service import rag_service, HTMLTextExtractor
from jose import jwt


def test_password_hashing():
    pw = "SuperSecurePassword123!"
    hashed = get_password_hash(pw)
    assert hashed != pw
    assert verify_password(pw, hashed) is True
    assert verify_password("WrongPassword!", hashed) is False


def test_jwt_token_creation_and_decode():
    username = "test_developer"
    token = create_access_token({"sub": username}, expires_delta=timedelta(minutes=30))
    assert isinstance(token, str)
    assert len(token) > 20

    payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    assert payload.get("sub") == username
    assert "exp" in payload


def test_html_text_extractor():
    parser = HTMLTextExtractor()
    html_content = """
    <html>
        <head><title>Ignore Me</title><style>.hidden { display: none; }</style></head>
        <body>
            <h1>StarkLLM Private AI</h1>
            <script>console.log("malicious or irrelevant script");</script>
            <p>Welcome to <strong>secure</strong>, local-first RAG.</p>
        </body>
    </html>
    """
    parser.feed(html_content)
    extracted = parser.get_data()
    assert "StarkLLM Private AI" in extracted
    assert "Welcome to secure, local-first RAG." in extracted
    assert "console.log" not in extracted
    assert ".hidden" not in extracted


def test_rag_recursive_chunking():
    short_text = "This is a single sentence for local RAG."
    chunks = rag_service._chunk_text_recursive(short_text, chunk_size=200, overlap=20)
    assert len(chunks) == 1
    assert chunks[0] == short_text

    long_text = ("StarkLLM is a high performance local AI system for technical users. " * 30).strip()
    chunks = rag_service._chunk_text_recursive(long_text, chunk_size=250, overlap=30)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 350


def test_rag_where_filter_builder():
    single_filter = {"user_id": 42}
    built_single = rag_service._build_where_filter(single_filter)
    assert built_single == {"user_id": {"$eq": 42}}

    list_filter = {"folder_id": [1, 2, 3]}
    built_list = rag_service._build_where_filter(list_filter)
    assert built_list == {"folder_id": {"$in": [1, 2, 3]}}

    multi_filter = {"user_id": 42, "is_active": True}
    built_multi = rag_service._build_where_filter(multi_filter)
    assert "$and" in built_multi
    assert len(built_multi["$and"]) == 2

    empty_filter = {}
    assert rag_service._build_where_filter(empty_filter) is None


def test_rag_context_compression():
    chunks = [
        {"content": "StarkLLM runs on local hardware with zero telemetry. It keeps data private."},
        {"content": "It keeps data private. Windows users can organize workflows into Workspaces."}
    ]
    compressed = rag_service._compress_context(chunks)
    assert len(compressed) == 2
    # The duplicate sentence "It keeps data private." should only appear once
    all_text = " ".join(c["content"] for c in compressed)
    assert all_text.count("It keeps data private.") == 1
