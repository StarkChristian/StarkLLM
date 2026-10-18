import time
import uuid
import json
import logging
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.llm_service import llm_service
from app.services.rag_service import rag_service
from app.core.config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


class ChatMessage(BaseModel):
    role: str
    content: str
    name: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: str = "starkllm-default"
    messages: List[ChatMessage]
    stream: Optional[bool] = False
    temperature: Optional[float] = 0.7
    top_p: Optional[float] = 1.0
    max_tokens: Optional[int] = None


@router.get("/models")
async def list_models():
    """
    OpenAI-compatible models list endpoint.
    Allows external dev tools (VSCode Continue, Cursor, Obsidian, curl)
    to query available local models via http://localhost:8000/v1/models.
    """
    raw_models = llm_service.get_available_models()
    model_list = [
        {
            "id": "starkllm-default",
            "object": "model",
            "created": 1700000000,
            "owned_by": "starkllm"
        },
        {
            "id": "starkllm-rag",
            "object": "model",
            "created": 1700000000,
            "owned_by": "starkllm"
        }
    ]
    for m in raw_models:
        model_list.append({
            "id": m,
            "object": "model",
            "created": 1700000000,
            "owned_by": "ollama"
        })
    return {"object": "list", "data": model_list}


@router.post("/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """
    OpenAI-compatible chat completions endpoint (both streaming and non-streaming).
    Enables external IDE extensions and custom scripts to use StarkLLM seamlessly.
    """
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages array cannot be empty")

    # Resolve target model
    target_model = req.model
    use_rag = False
    available = llm_service.get_available_models()

    if target_model == "starkllm-rag":
        use_rag = True
        target_model = available[0] if available else "llama3.2:3b"
    elif target_model == "starkllm-default":
        target_model = available[0] if available else "llama3.2:3b"

    # Convert messages
    formatted_messages = [{"role": m.role, "content": m.content} for m in req.messages]

    # If RAG is requested, enrich system context
    if use_rag:
        user_queries = [m.content for m in req.messages if m.role == "user"]
        if user_queries:
            last_query = user_queries[-1]
            try:
                # Query RAG default workspace or relevant knowledge
                kb_chunks = rag_service.query_knowledge_base(last_query, top_k=3)
                if kb_chunks:
                    context_str = "\n\n".join([f"--- Context snippet ---\n{c}" for c in kb_chunks])
                    system_prompt = (
                        f"You are StarkLLM with local RAG capabilities. "
                        f"Use the following knowledge context to answer:\n\n{context_str}"
                    )
                    formatted_messages.insert(0, {"role": "system", "content": system_prompt})
            except Exception as e:
                logger.warning(f"Failed to retrieve RAG context for completions: {e}")

    options = {
        "temperature": req.temperature,
        "top_p": req.top_p,
    }
    if req.max_tokens:
        options["num_predict"] = req.max_tokens

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created_ts = int(time.time())

    # Non-streaming response
    if not req.stream:
        try:
            res = llm_service.generate_chat(
                model=target_model,
                messages=formatted_messages,
                stream=False,
                options=options
            )
            content = res.get("message", {}).get("content", "")
            prompt_len = sum(len(m["content"]) for m in formatted_messages) // 4
            completion_len = len(content) // 4
            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created_ts,
                "model": req.model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": content
                        },
                        "finish_reason": "stop"
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt_len,
                    "completion_tokens": completion_len,
                    "total_tokens": prompt_len + completion_len
                }
            }
        except Exception as e:
            logger.error(f"Error generating chat completion: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # Streaming mode (SSE)
    def sse_generator():
        try:
            token_gen = llm_service.generate_chat(
                model=target_model,
                messages=formatted_messages,
                stream=True,
                options=options
            )
            for token in token_gen:
                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": req.model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "content": token
                            },
                            "finish_reason": None
                        }
                    ]
                }
                yield f"data: {json.dumps(chunk)}\n\n"

            # Final finish chunk
            finish_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": req.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop"
                    }
                ]
            }
            yield f"data: {json.dumps(finish_chunk)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error(f"Error in streaming completion: {e}")
            err_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": req.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": f"\n\n[Generation Error: {str(e)}]"
                        },
                        "finish_reason": "error"
                    }
                ]
            }
            yield f"data: {json.dumps(err_chunk)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")
