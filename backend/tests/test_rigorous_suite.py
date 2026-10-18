import os
import sys
import pytest
import tempfile
from fastapi.testclient import TestClient

# Ensure backend root is on python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.main import app
from app.api.auth import create_access_token, get_password_hash, verify_password
from app.services.rag_service import rag_service
from app.services.llm_service import llm_service
from app.core.config import settings

client = TestClient(app)

@pytest.fixture(scope="session")
def auth_headers():
    token = create_access_token({"sub": "admin"})
    return {"Authorization": f"Bearer {token}"}


class TestSecurityAndAuth:
    def test_password_hash_and_verification(self):
        pwd = "StarkLLM_Rigorous_Password_2026!"
        hashed = get_password_hash(pwd)
        assert hashed != pwd
        assert verify_password(pwd, hashed) is True
        assert verify_password("wrong_password", hashed) is False

    def test_unauthenticated_request_rejected(self):
        res = client.get("/api/v1/workspaces")
        assert res.status_code == 401

    def test_authenticated_token_accepted(self, auth_headers):
        res = client.get("/api/v1/workspaces", headers=auth_headers)
        assert res.status_code == 200
        assert isinstance(res.json(), list)


class TestWorkspaceAndPersona:
    def test_create_and_update_workspace_persona(self, auth_headers):
        # Create a workspace
        create_res = client.post(
            "/api/v1/workspaces",
            headers=auth_headers,
            json={"name": "Test Persona Workspace", "description": "Automated verification"}
        )
        assert create_res.status_code in (200, 201)
        ws = create_res.json()
        ws_id = ws["id"]

        # Update workspace persona (custom system prompt)
        custom_prompt = "You are a Senior Security Architect specializing in zero-knowledge cryptography."
        update_res = client.put(
            f"/api/v1/workspaces/{ws_id}",
            headers=auth_headers,
            json={"name": "Test Persona Workspace Updated", "custom_system_prompt": custom_prompt}
        )
        assert update_res.status_code == 200
        updated = update_res.json()
        assert updated.get("custom_system_prompt") == custom_prompt

        # Clean up
        client.delete(f"/api/v1/workspaces/{ws_id}", headers=auth_headers)


class TestDataConnectorsAndRAG:
    def test_raw_note_ingestion_and_retrieval(self, auth_headers):
        # Create temp workspace
        ws = client.post(
            "/api/v1/workspaces",
            headers=auth_headers,
            json={"name": "Note RAG Test WS"}
        ).json()
        ws_id = ws["id"]

        try:
            # Ingest raw note
            note_content = (
                "StarkLLM incorporates FlashRank cross-encoders to re-rank semantic passages "
                "with ultra-low latency on CPU. This guarantees maximum precision in private RAG."
            )
            note_res = client.post(
                f"/api/v1/documents/{ws_id}/ingest-note",
                headers=auth_headers,
                json={"title": "FlashRank Architecture Note", "content": note_content}
            )
            assert note_res.status_code == 200
            doc = note_res.json()
            assert doc["title"] == "FlashRank Architecture Note"
            assert doc["doc_type"] == "note"

            # Query workspace documents
            docs_list = client.get(f"/api/v1/documents/{ws_id}", headers=auth_headers)
            assert docs_list.status_code == 200
            assert any(d["title"] == "FlashRank Architecture Note" for d in docs_list.json())

        finally:
            client.delete(f"/api/v1/workspaces/{ws_id}", headers=auth_headers)


class TestCodeExecutionSandbox:
    def test_successful_python_execution(self, auth_headers):
        code = "print(2 ** 10)\nprint('Sandbox Execution Verified')"
        res = client.post(
            "/api/v1/system/execute-code",
            headers=auth_headers,
            json={"language": "python", "code": code}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["exit_code"] == 0
        assert "1024" in data["output"]
        assert "Sandbox Execution Verified" in data["output"]
        assert "execution_time_ms" in data

    def test_syntax_error_handled(self, auth_headers):
        bad_code = "def invalid_syntax(:\n    pass"
        res = client.post(
            "/api/v1/system/execute-code",
            headers=auth_headers,
            json={"language": "python", "code": bad_code}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["exit_code"] != 0
        assert "SyntaxError" in data["output"]

    def test_infinite_loop_timeout_protection(self, auth_headers):
        timeout_code = "import time\nwhile True:\n    time.sleep(0.1)"
        res = client.post(
            "/api/v1/system/execute-code",
            headers=auth_headers,
            json={"language": "python", "code": timeout_code, "timeout_seconds": 2}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["exit_code"] != 0
        assert "timed out" in data["output"].lower()


class TestMessageFeedbackAndEditing:
    def test_feedback_and_edit_flow(self, auth_headers):
        # Create workspace and session
        ws = client.post("/api/v1/workspaces", headers=auth_headers, json={"name": "Feedback WS"}).json()
        ws_id = ws["id"]

        try:
            chat = client.post(f"/api/v1/chat/sessions/{ws_id}", headers=auth_headers).json()
            chat_id = chat["id"]

            # Post a message directly into chat
            msg_res = client.post(
                "/api/v1/chat/message",
                headers=auth_headers,
                json={"chat_id": chat_id, "content": "Initial prompt for testing"}
            )
            # Fetch messages
            msgs_res = client.get(f"/api/v1/chat/messages/{chat_id}", headers=auth_headers)
            msgs = msgs_res.json()
            assert len(msgs) > 0
            target_msg = msgs[0]
            msg_id = target_msg["id"]

            # Test Feedback (thumbs up)
            fb_res = client.post(
                f"/api/v1/chat/messages/{msg_id}/feedback",
                headers=auth_headers,
                json={"feedback": "positive"}
            )
            assert fb_res.status_code == 200
            assert fb_res.json().get("feedback") == "positive"

            # Test Feedback (thumbs down)
            fb_neg = client.post(
                f"/api/v1/chat/messages/{msg_id}/feedback",
                headers=auth_headers,
                json={"feedback": "negative"}
            )
            assert fb_neg.status_code == 200
            assert fb_neg.json().get("feedback") == "negative"

            # Test Message Editing
            edit_res = client.post(
                f"/api/v1/chat/messages/{msg_id}/edit",
                headers=auth_headers,
                json={"content": "Edited content for test"}
            )
            assert edit_res.status_code == 200
            assert edit_res.json().get("content") == "Edited content for test"

        finally:
            client.delete(f"/api/v1/workspaces/{ws_id}", headers=auth_headers)


class TestLocalOpenAIServer:
    def test_v1_models_endpoint(self, auth_headers):
        res = client.get("/v1/models", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "data" in data
        assert isinstance(data["data"], list)

    def test_v1_chat_completions_mock_or_stream(self, auth_headers):
        # Test validation on request payload
        payload = {
            "model": "starkllm-local",
            "messages": [{"role": "user", "content": "Ping"}]
        }
        res = client.post("/v1/chat/completions", headers=auth_headers, json=payload)
        # Should either return 200 (if Ollama/backend available) or a handled response
        assert res.status_code in (200, 500, 502, 503)


class TestGlobalSearchEndpoint:
    def test_global_search_returns_structured_results(self, auth_headers):
        res = client.get("/api/v1/search/global?q=test", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "workspaces" in data
        assert "chats" in data
        assert "documents" in data
        assert isinstance(data["workspaces"], list)
        assert isinstance(data["chats"], list)
        assert isinstance(data["documents"], list)
