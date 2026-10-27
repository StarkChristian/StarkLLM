import os
import re
import json
import asyncio
import logging
import urllib.parse
from fastapi import APIRouter, Depends, HTTPException, Response, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_, select, exists
from app.db.session import get_db
from app.db import models
from app.services.llm_service import llm_service, ModelNotFoundError, LLMBackendError
from app.services.rag_service import rag_service, source_display_name
from app.services.memory_service import memory_service
from app.services.mcp_service import mcp_service
from app.core.config import settings
from app.api.auth import get_current_user
from app.api.deps import get_workspace_or_404, get_chat_or_404, get_message_or_404
from pydantic import BaseModel, Field, field_validator
from typing import Optional
try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None

router = APIRouter()
logger = logging.getLogger(__name__)


def _sources_json(kb_used: bool, kb: list, ws: list, web_titles: list, web_urls: list) -> Optional[str]:
    """The source chips of one answer, stored with the message so they come back when the chat is reopened."""
    if not (kb or ws or web_titles):
        return None
    web = [{"title": t, "url": web_urls[i] if i < len(web_urls) else ""} for i, t in enumerate(web_titles)]
    return json.dumps({"kb_used": bool(kb_used), "kb": list(kb), "ws": list(ws), "web": web}, ensure_ascii=False)


def _message_out(m) -> dict:
    """A stored message in the shape the chat view uses for a live answer (including its source chips)."""
    out = {"role": m.role, "content": m.content, "timestamp": m.created_at.isoformat() if m.created_at else None,
           "id": m.id, "feedback": m.feedback}
    if m.role == "assistant" and not (m.content or "").strip():
        out["content"] = "*[No answer was generated]*"  # an empty answer would otherwise look like it is still loading
    if getattr(m, "sources", None):
        try:
            src = json.loads(m.sources)
            out.update(kbUsed=bool(src.get("kb_used")), kbSources=src.get("kb") or [],
                       wsSources=src.get("ws") or [], webSources=src.get("web") or [])
        except (ValueError, AttributeError):
            pass
    return out


def _build_citation_label(r: dict) -> tuple[str, str]:
    """
    Constructs honest, verifiable citation labels for LLM context and UI headers.
    PDF: includes 1-indexed page number ('doc.pdf (Page 4)')
    DOCX: includes section heading or chunk locator ('doc.docx (Section: 'Overview', Chunk 1)')
    TXT/MD: includes chunk locator ('notes.md (Chunk 2)')
    """
    meta = r.get("metadata", {}) or {}
    filename = source_display_name(meta) or "unknown file"
    locator = meta.get("locator")
    if not locator:
        if "page" in meta and meta["page"] is not None:
            try:
                page_val = int(meta["page"]) + 1
                locator = f"Page {page_val}"
            except (ValueError, TypeError):
                locator = f"Page {meta['page']}"
        elif meta.get("section"):
            chunk_part = f" Chunk {meta['chunk']}" if meta.get("chunk") else ""
            locator = f"Section: '{meta['section']}'{chunk_part}"
        elif meta.get("chunk"):
            locator = f"Chunk {meta['chunk']}"
        elif r.get("id") and "_c" in str(r.get("id")):
            c_part = str(r.get("id")).split("_c")[-1]
            if c_part.isdigit():
                locator = f"Chunk {int(c_part) + 1}"

    if locator:
        label = f"{filename} ({locator})"
    else:
        label = filename
    return label, label


# Regex to strip fenced ```tool_call ... ``` blocks from retrieved document chunks.
# These blocks must never reach the LLM prompt as they could be misinterpreted as
# assistant-emitted tool calls. Assistant output is not affected (it is never
# passed through this function).
_TOOL_FENCE_RE = re.compile(
    r"```(?:tool_call)[\s\S]*?```",
    re.IGNORECASE,
)

def _strip_tool_fences(text: str) -> str:
    """Remove fenced tool_call blocks from retrieved document text before LLM prompt injection."""
    return _TOOL_FENCE_RE.sub("[tool_call block redacted from document]", text).strip()


class ChatRequest(BaseModel):
    workspace_id: int
    chat_id: Optional[int] = None
    message: str = Field(..., max_length=100_000)
    stream: bool = True
    use_knowledge_base: bool = False  # toggle: query personal KB in addition to workspace
    use_web_search: bool = False      # toggle: query web via DDG
    use_hybrid_search: Optional[bool] = None
    use_query_rewriting: Optional[bool] = None
    use_context_compression: Optional[bool] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    provider: Optional[str] = "ollama"

    @field_validator("message")
    @classmethod
    def _message_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Message must not be empty")
        return v
    api_key: Optional[str] = None
    base_url: Optional[str] = None


# Model management routes moved to models_router.py


class TruncateRequest(BaseModel):
    chat_id: int
    keep_count: int = Field(..., ge=0)


class RenameChatRequest(BaseModel):
    title: str


class PinChatRequest(BaseModel):
    is_pinned: bool


class SavePartialRequest(BaseModel):
    chat_id: int
    content: str


@router.post("/save-partial")
def save_partial_message(
    req: SavePartialRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Save a partial assistant message when generation is stopped by the user."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == req.chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    # Only save if there is actual content
    content = req.content.strip() if req.content else ""
    if not content:
        content = "*[Generation stopped]*"

    ast_msg = models.Message(
        chat_id=chat_obj.id,
        role="assistant",
        content=content,
    )
    db.add(ast_msg)
    db.commit()
    db.refresh(ast_msg)
    return {"status": "saved", "message_id": ast_msg.id}


@router.post("/")
async def chat(
    req: ChatRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    try:
        ws = (
            db.query(models.Workspace)
            .filter(
                models.Workspace.id == req.workspace_id,
                models.Workspace.user_id == current_user.id,
            )
            .first()
        )
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        # ---- Create or fetch chat session
        chat_renamed = False
        if req.chat_id:
            chat_obj = (
                db.query(models.Chat)
                .filter(
                    models.Chat.id == req.chat_id,
                    models.Chat.workspace_id == req.workspace_id,
                )
                .first()
            )
            if not chat_obj:
                raise HTTPException(status_code=404, detail="Chat not found")
            if not chat_obj.title or chat_obj.title in ("New Chat", "Untitled Chat"):
                chat_obj.title = req.message[:50]
                db.commit()
                db.refresh(chat_obj)
                chat_renamed = True
        else:
            chat_obj = models.Chat(
                workspace_id=req.workspace_id, title=req.message[:50]
            )
            db.add(chat_obj)
            db.commit()
            db.refresh(chat_obj)

        # ---- Persist user message
        user_msg = models.Message(
            chat_id=chat_obj.id, role="user", content=req.message
        )
        db.add(user_msg)
        db.commit()

        # ---- Determine active model early for routing
        model_name = req.model if req.model else (current_user.default_model if current_user.default_model else settings.DEFAULT_TEXT_MODEL)

        # ---- Intent Classification (Routing)
        is_rag_intent = False
        if not getattr(req, "use_web_search", False):
            _msg_lower = req.message.lower()
            # Keyword heuristic — catches document/file-related queries instantly
            _rag_keywords = [
                # Explicit document references
                "document", "pdf", "file", "uploaded", "upload", "attachment",
                "attached", "report", "paper", "article", "knowledge base",
                "notebook", "spreadsheet", "slide", "presentation", "chapter",
                # Action verbs for documents
                "summarize", "summary", "extract", "outline", "analyze",
                "quote", "cite", "reference", "highlight", "paraphrase",
                # Relational phrases
                "what does", "according to", "says about", "mentioned in",
                "written in", "stated in", "described in", "found in",
                "based on the", "from the doc", "from my", "in my",
                # File extensions
                ".pdf", ".docx", ".doc", ".txt", ".csv", ".xlsx", ".xls",
                ".md", ".pptx", ".epub", ".rtf", ".json", ".xml",
                # Contextual clues about prior uploads
                "the author", "the table", "the chart", "the graph",
                "page ", "paragraph", "section", "conclusion",
            ]
            _keyword_hit = any(kw in _msg_lower for kw in _rag_keywords)

            if _keyword_hit:
                is_rag_intent = True
                logger.info(f"Intent Classification: RAG (keyword match)")
            else:
                logger.info(f"Intent Classification: GENERAL (no keyword match)")
        else:
            is_rag_intent = True  # Web search behaves like RAG intent

        matched_filepaths = []

        # ---- Do we have any documents the question could be about?
        # Retrieval must not depend on English trigger words in the message: as soon as the user has indexed
        # documents (workspace, or personal KB when toggled) we retrieve and let the model decide.
        ws_indexed_docs = (
            db.query(models.Document)
            .filter(models.Document.workspace_id == req.workspace_id,
                    models.Document.status == models.DocStatus.INDEXED)
            .count()
        )
        kb_docs = []
        if req.use_knowledge_base:
            kb_docs = (
                db.query(models.KnowledgeBaseDocument)
                .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
                .filter(models.KnowledgeBaseFolder.user_id == current_user.id,
                        models.KnowledgeBaseDocument.status == "indexed")
                .order_by(models.KnowledgeBaseDocument.indexed_at.desc())
                .all()
            )
        docs_available = ws_indexed_docs > 0 or len(kb_docs) > 0

        # ---- Concurrent Data Fetching (RAG, Web, Memory)
        async def fetch_rag():
            if not (is_rag_intent or matched_filepaths or docs_available):
                logger.info("Skipped RAG vector search: GENERAL intent and no indexed documents.")
                return [], [], "", ""
            try:
                import json
                rag_filters = None
                use_kb_for_this_request = req.use_knowledge_base

                if use_kb_for_this_request and ws.active_kb_dir_ids:
                    try:
                        active_ids = json.loads(ws.active_kb_dir_ids)
                        if isinstance(active_ids, list):
                            if len(active_ids) == 0:
                                use_kb_for_this_request = False
                            else:
                                rag_filters = {"folder_id": {"$in": active_ids}}
                    except Exception as e:
                        logger.warning(f"Failed to parse active_kb_dir_ids for workspace {ws.id}: {e}")

                ws_res, kb_res = await asyncio.to_thread(
                    rag_service.query_merged,
                    workspace_id=req.workspace_id,
                    user_id=current_user.id,
                    query_text=req.message,
                    use_kb=use_kb_for_this_request,
                    n_results=5,
                    filters=rag_filters,
                    preferred_sources=matched_filepaths,
                    use_hybrid_search=req.use_hybrid_search,
                    use_query_rewriting=False if getattr(req, "use_web_search", False) else req.use_query_rewriting,
                    use_context_compression=req.use_context_compression,
                )
                
                ws_ctx = "\n\n".join(f"[Document: {_build_citation_label(r)[0]}]\n{_strip_tool_fences(r['content'])}" for r in ws_res)
                kb_ctx = "\n\n".join(f"[Personal KB Document: {_build_citation_label(r)[0]}]\n{_strip_tool_fences(r['content'])}" for r in kb_res)
                
                logger.info(f"DEBUG: RAG merged → {len(ws_res)} workspace ({len(ws_ctx)} chars) + {len(kb_res)} KB ({len(kb_ctx)} chars) result(s)")
                return ws_res, kb_res, ws_ctx, kb_ctx
            except Exception as e:
                logger.error(f"Error querying RAG: {e}", exc_info=True)
                return [], [], "", ""

        async def fetch_web():
            if not getattr(req, "use_web_search", False):
                return [], [], ""
            logger.info(f"Web Search enabled for query: {req.message}")
            try:
                def do_web_search():
                    if DDGS is None:
                        logger.warning("DDGS library not available. Skipping web search.")
                        return []
                    results = []
                    with DDGS() as ddgs:
                        for r in ddgs.text(req.message, max_results=5):
                            results.append({
                                'title': r.get('title', 'Unknown'),
                                'href': r.get('href', ''),
                                'body': r.get('body', '')
                            })
                    return results

                web_res = await asyncio.to_thread(do_web_search)
                w_sources = []
                w_urls = []
                w_ctx = ""
                if web_res:
                    parts = []
                    for idx, r in enumerate(web_res, 1):
                        title = r.get('title', 'Unknown')
                        url = r.get('href', '')
                        snippet = r.get('body', '')
                        parts.append(f"[Source {idx}: {title}]\nURL: {url}\nContent: {snippet}")
                        w_sources.append(title)
                        w_urls.append(url)
                    w_ctx = "\n\n".join(parts)
                    logger.info(f"Web Search found {len(web_res)} results.")
                return w_sources, w_urls, w_ctx
            except Exception as e:
                logger.error(f"Web Search failed: {e}")
                return [], [], ""

        async def fetch_memory():
            try:
                return await asyncio.to_thread(
                    memory_service.retrieve_memory_context, req.message, req.workspace_id
                )
            except Exception as e:
                logger.error(f"Error querying memory: {e}", exc_info=True)
                return ""

        # Execute concurrently
        (rag_data, web_data, memory_context) = await asyncio.gather(
            fetch_rag(), fetch_web(), fetch_memory()
        )
        
        # Unpack RAG
        ws_results, kb_results, ws_context, kb_context = rag_data
        
        ws_sources = []
        for r in (ws_results or []):
            if r.get("metadata"):
                _, ui_lbl = _build_citation_label(r)
                if ui_lbl not in ws_sources:
                    ws_sources.append(ui_lbl)

        kb_sources = []
        for r in (kb_results or []):
            if r.get("metadata"):
                _, ui_lbl = _build_citation_label(r)
                if ui_lbl not in kb_sources:
                    kb_sources.append(ui_lbl)

        # Unpack Web
        web_sources, web_source_urls, web_context = web_data

        # ---- Lightweight file list for the system prompt (max 10 most recent)
        MAX_FILES_SHOWN = 10
        ws_doc_total = 0
        ws_file_list = "  (file list unavailable)"
        try:
            ws_doc_total = (
                db.query(models.Document)
                .filter(models.Document.workspace_id == req.workspace_id)
                .count()
            )
            ws_doc_recent = (
                db.query(models.Document)
                .filter(models.Document.workspace_id == req.workspace_id)
                .order_by(models.Document.created_at.desc())
                .limit(MAX_FILES_SHOWN)
                .all()
            )
            ws_filenames = [d.filename for d in ws_doc_recent]
            ws_overflow = ws_doc_total - len(ws_filenames)
            ws_file_list = "\n".join(f"  - {f}" for f in ws_filenames)
            if ws_overflow > 0:
                ws_file_list += f"\n  ... and {ws_overflow} more file(s)"
        except Exception as e:
            logger.warning(f"Could not fetch workspace file list: {e}")
            ws_file_list = "  (file list unavailable)"

        # ---- Lightweight KB file list for the system prompt
        kb_file_list = ""
        if req.use_knowledge_base:
            try:
                kb_filenames = [d.file_name for d in kb_docs[:MAX_FILES_SHOWN]]
                kb_overflow = len(kb_docs) - len(kb_filenames)
                kb_file_list = "\n".join(f"  - {f}" for f in kb_filenames)
                if kb_overflow > 0:
                    kb_file_list += f"\n  ... and {kb_overflow} more KB file(s)"
            except Exception as e:
                logger.warning(f"Could not fetch KB file list: {e}")

        # ---- Build system prompt
        kb_section = ""
        kb_file_list_section = ""
        if req.use_knowledge_base:
            kb_section = f"""
--- Personal Knowledge Base ---
{kb_context if kb_context else "No relevant content found in your Knowledge Base for this query."}
"""
            if kb_file_list:
                kb_file_list_section = f"""
--- Available files in Personal KB ---
{kb_file_list}
"""

        web_section = ""
        if getattr(req, "use_web_search", False) and web_context:
            web_section = f"""
--- Web Search Results ---
{web_context}
"""

        custom_instructions_section = ""
        if current_user.profile_context or current_user.custom_instructions:
            parts = []
            if current_user.profile_context:
                parts.append(f"User Profile / Context:\n{current_user.profile_context}")
            if current_user.custom_instructions:
                parts.append(f"Custom Instructions:\n{current_user.custom_instructions}")
            custom_content = "\n\n".join(parts)
            custom_instructions_section = f"""
═══════════════════════════════════════
USER CUSTOM INSTRUCTIONS & PERSONA
═══════════════════════════════════════
{custom_content}
"""
        if is_rag_intent or matched_filepaths:
            mode_instructions = f"""
═══════════════════════════════════════
STRICT DOCUMENT RAG MODE
═══════════════════════════════════════
- The user is asking a question about their documents, files, or data.
- You MUST answer STRICTLY based on the 'Retrieved Workspace Context' provided below.
- IF the provided context DOES NOT contain the exact information needed to answer the question, you MUST refuse to answer. Reply with: "I could not find the answer in the provided documents." (or natural equivalent in the requested language). Do NOT attempt to answer from your outside knowledge. Do NOT guess.
- You MUST explicitly cite the source filename for every claim you make (e.g., "According to [report.pdf]...").
- Do NOT hallucinate facts, numbers, or details that are not explicitly written in the context.
- If passages disagree (for example an old and a new version of the same contract or manual), answer with the current, valid one first. A passage that says it was replaced, superseded or is no longer valid is outdated: mention its value only as outdated, never as an equal alternative.
- When asked to summarize a document, cover its key terms (parties, duration, amounts, deadlines, liabilities) and add nothing that is not in the passages.

═══════════════════════════════════════
RAG — DOCUMENT CONTEXT
═══════════════════════════════════════
The sections below contain EXACT TEXT retrieved from the user's documents.
Each chunk is prefixed with [Document: <filename>] so you know which file it came from.

--- Available files in this workspace ---
{ws_file_list if ws_file_list else "  (no files uploaded yet)"}{kb_file_list_section}
--- Retrieved Workspace Context ---
{ws_context if ws_context else "No relevant documents found in this workspace for this query."}
{kb_section}
"""
        elif docs_available:
            mode_instructions = f"""
═══════════════════════════════════════
DOCUMENT-AWARE MODE
═══════════════════════════════════════
- The user has indexed documents. Passages that may be relevant to the current message were retrieved below; they can also be irrelevant.
- If the passages contain the answer, answer from them and name the source filename (e.g., "According to [report.pdf]...").
- If passages disagree (for example an old and a new version of the same contract or manual), answer with the current, valid one first. A passage that says it was replaced, superseded or is no longer valid is outdated: mention its value only as outdated, never as an equal alternative.
- When asked to summarize a document, cover its key terms (parties, duration, amounts, deadlines, liabilities) and add nothing that is not in the passages.
- If the message asks for facts about the user's own company, files, people, products, contracts or data that only their documents could contain, and the passages do not contain the answer, reply that you could not find it in the provided documents (in the user's language). Do NOT guess and do NOT answer from general knowledge in that case.
- For greetings, chit-chat, general knowledge, coding or writing tasks that have nothing to do with the documents, answer normally and do not mention the documents.

--- Available files in this workspace ---
{ws_file_list if ws_file_list else "  (no files uploaded yet)"}{kb_file_list_section}
--- Retrieved Workspace Context ---
{ws_context if ws_context else "No relevant documents found in this workspace for this query."}
{kb_section}
"""
        else:
            mode_instructions = f"""
═══════════════════════════════════════
GENERAL CONVERSATION MODE
═══════════════════════════════════════
- The user is engaging in casual chat, greetings, or asking a general knowledge question.
- No personal documents were required or retrieved for this query.
- Use your own internal knowledge to be helpful, accurate, and conversational.
"""

        # ---- MCP Tools Section (Read-Only Local Host)
        mcp_section = ""
        active_tools = mcp_service.get_active_tools()
        if active_tools:
            tool_descs = []
            for t in active_tools:
                props = t["parameters"].get("properties", {})
                tool_descs.append(f"- `{t['name']}`: {t['description']}\n  Parameters: {json.dumps(props)}")
            tools_str = "\n".join(tool_descs)
            mcp_section = f"""
═══════════════════════════════════════
LOCAL MCP TOOLS (READ-ONLY)
═══════════════════════════════════════
You have access to the following local Model Context Protocol (MCP) tools:
{tools_str}

If you need to list workspace files, search the Knowledge Base, or inspect a specific cited document chunk that was not provided above, output a tool call block EXACTLY in this format:
```tool_call
{{"name": "<tool_name>", "arguments": {{<arguments>}}}}
```
The user will confirm the tool call in the UI before it runs.
"""

        # ---- Workspace custom system prompt (overrides default identity block when set)
        workspace_persona_section = ""
        if ws.system_prompt and ws.system_prompt.strip():
            workspace_persona_section = f"""
═══════════════════════════════════════
WORKSPACE PERSONA / CUSTOM SYSTEM PROMPT
═══════════════════════════════════════
{ws.system_prompt.strip()}
"""

        system_prompt = f"""You are StarkLLM, a premium private AI assistant with Retrieval-Augmented Generation (RAG) capabilities.
{custom_instructions_section}
{workspace_persona_section}
{mcp_section}
═══════════════════════════════════════
CORE IDENTITY & BEHAVIOR
═══════════════════════════════════════
- You are knowledgeable, precise, and articulate.
- Always detect the language of the user's message and respond in that SAME language.
- Never mix languages unless the user explicitly writes in a mixed style.

═══════════════════════════════════════
LONG-TERM MEMORY & USER PREFERENCES
═══════════════════════════════════════
{memory_context if memory_context else "No relevant memory context found."}

**CRITICAL INSTRUCTIONS FOR MEMORY:**
- The above facts are the user's established preferences and background.
- You MUST actively use these facts to personalize your responses, even for general questions.
- For example, if the memory says the user prefers Python, and they ask "Python or Java?", you must favor Python based on their preference.
- Do not explicitly announce "According to my memory..." — just use the information naturally.

═══════════════════════════════════════
LANGUAGE & WRITING QUALITY
═══════════════════════════════════════
- Write in a clear, natural, well-structured way at all times.
- Use well-formed paragraphs with logical flow. Avoid one-sentence dumps.
- Do not repeat the question or pad the answer with filler phrases.
- Respond natively in the user's language.
- For RTL languages (Arabic/Persian), maintain natural RTL prose and punctuation.
- For German, use correct Hochdeutsch.
- Technical terms (e.g. React, API, Python, Docker) may appear in their Latin script naturally within non-English sentences — this is acceptable and expected.

═══════════════════════════════════════
WEB SEARCH RESULTS (LIVE DATA)
═══════════════════════════════════════
{web_section if web_section else "Web Search is disabled for this query."}

**CRITICAL INSTRUCTIONS FOR WEB SEARCH:**
- If Web Search Results are present above, you MUST treat them as REAL, LIVE, UP-TO-DATE DATA retrieved from the internet just now specifically for this query.
- You MUST use this data to answer the user's question. Summarize it naturally, cite source names when relevant.
- NEVER say "I don't have access to real-time data", "I cannot browse the internet", or "my knowledge cutoff is..." when web search results ARE provided above. That is INCORRECT — the data IS right there.
- If the user asks about current prices, news, weather, or any real-time topic and web results are provided, extract the relevant information and present it clearly.
- Example: If the user asks "What is the Bitcoin price?" and the web results contain pricing data, you MUST report that price — do NOT deflect.

{mode_instructions}
"""
        logger.info(
            f"DEBUG: System prompt built. WS context: {len(ws_context)} chars, "
            f"KB context: {len(kb_context)} chars, "
            f"Memory: {len(memory_context)} chars, "
            f"File list: {ws_doc_total} total file(s)"
        )

        # ---- Assemble message history (last 20 messages)
        history = (
            db.query(models.Message)
            .filter(models.Message.chat_id == chat_obj.id)
            .order_by(models.Message.created_at.desc())
            .limit(20)
            .all()
        )
        history.reverse()

        # Trigger background memory extraction every 5 messages
        total_messages = db.query(models.Message).filter(models.Message.chat_id == chat_obj.id).count()
        if total_messages % 5 == 0 and total_messages > 0:
            formatted_history = "\n".join([f"{msg.role.capitalize()}: {msg.content}" for msg in history])
            background_tasks.add_task(memory_service.summarize_and_store_conversation, formatted_history, req.workspace_id)

        messages = [{"role": "system", "content": system_prompt}]
        for msg in history:
            messages.append({"role": msg.role, "content": msg.content})

        # ---- Generate response
        options = {}
        # Start with global user settings as defaults
        if current_user.temperature is not None:
            options["temperature"] = current_user.temperature
        if current_user.top_p is not None:
            options["top_p"] = current_user.top_p
        if current_user.max_tokens is not None:
            options["num_predict"] = current_user.max_tokens

        # Override with request-specific settings if provided
        if req.temperature is not None:
            options["temperature"] = req.temperature
        if req.top_p is not None:
            options["top_p"] = req.top_p
        if req.max_tokens is not None:
            options["num_predict"] = req.max_tokens
            
        model_name = req.model if req.model else (current_user.default_model if current_user.default_model else settings.DEFAULT_TEXT_MODEL)

        kb_used = bool(req.use_knowledge_base and kb_results)
        sources_json = _sources_json(kb_used, kb_sources, ws_sources, web_sources, web_source_urls)

        if req.stream:
            def generate():
                full_response = ""
                try:
                    for chunk in llm_service.generate_chat(
                        model_name,
                        messages,
                        stream=True,
                        options=options,
                        provider=req.provider or "ollama",
                        api_key=req.api_key,
                        base_url=req.base_url
                    ):
                        full_response += chunk
                        yield chunk
                    if not full_response.strip():
                        raise LLMBackendError(f"Model '{model_name}' returned an empty answer. Try again, or choose another model.", "empty_answer")
                except Exception as e:
                    full_response = full_response if full_response.strip() else ""
                    yield f"\n\nError generating response: {str(e)}"
                finally:
                    if full_response:
                        from app.db.session import SessionLocal
                        local_db = SessionLocal()
                        try:
                            # Check if the frontend already saved a partial message
                            existing = (
                                local_db.query(models.Message)
                                .filter(
                                    models.Message.chat_id == chat_obj.id,
                                    models.Message.role == "assistant",
                                )
                                .order_by(models.Message.created_at.desc())
                                .first()
                            )
                            # Get the last user message to compare ordering
                            last_user = (
                                local_db.query(models.Message)
                                .filter(
                                    models.Message.chat_id == chat_obj.id,
                                    models.Message.role == "user",
                                )
                                .order_by(models.Message.created_at.desc())
                                .first()
                            )
                            # Only save if no assistant message exists after the last user message
                            if not existing or (last_user and existing.created_at < last_user.created_at):
                                ast_msg = models.Message(
                                    chat_id=chat_obj.id,
                                    role="assistant",
                                    content=full_response,
                                    sources=sources_json,
                                )
                                local_db.add(ast_msg)
                                local_db.commit()
                            else:
                                logger.info("Skipping duplicate save — assistant message already exists (likely saved by /save-partial).")
                        except Exception as save_err:
                            logger.error(f"Failed to save assistant message: {save_err}")
                        finally:
                            local_db.close()

            return StreamingResponse(
                generate(),
                media_type="text/plain",
                headers={
                    "X-Chat-ID": str(chat_obj.id),
                    "X-KB-Used": "true" if kb_used else "false",
                    "X-KB-Sources": urllib.parse.quote("|".join(kb_sources)),
                    "X-WS-Sources": urllib.parse.quote("|".join(ws_sources)),
                    "X-Web-Sources": urllib.parse.quote(",".join(web_sources)),
                    "X-Web-Sources-Urls": urllib.parse.quote(",".join(web_source_urls)),
                    "X-Chat-Renamed": "true" if chat_renamed else "false",
                    "Access-Control-Expose-Headers": "X-Chat-ID,X-KB-Used,X-KB-Sources,X-WS-Sources,X-Web-Sources,X-Web-Sources-Urls,X-Chat-Renamed",
                },
            )
        else:
            try:
                llm_response = await asyncio.to_thread(
                    llm_service.generate_chat,
                    model_name,
                    messages,
                    False,
                    options,
                    req.provider or "ollama",
                    req.api_key,
                    req.base_url
                )
                content = llm_response.get("message", {}).get("content", "")
            except Exception as e:
                # An error must not be stored as the assistant's answer (it would be replayed into later prompts)
                # and must not come back as HTTP 200.
                logger.error(f"LLM error: {e}")
                if isinstance(e, ModelNotFoundError):
                    raise HTTPException(status_code=404, detail=str(e))
                if isinstance(e, LLMBackendError):
                    raise HTTPException(status_code=e.http_status, detail=str(e))
                raise HTTPException(status_code=502, detail=f"The language model backend (Ollama) failed: {e}")
            if not (content or "").strip():
                # never save (or return as a success) an answer without text
                raise HTTPException(status_code=502, detail=f"Model '{model_name}' returned an empty answer. Try again, or choose another model.")

            ast_msg = models.Message(
                chat_id=chat_obj.id, role="assistant", content=content, sources=sources_json
            )
            db.add(ast_msg)
            db.commit()
            # Set headers on the Response object for non-streaming paths
            kb_used_val = "true" if kb_used else "false"
            response.headers["X-Chat-ID"] = str(chat_obj.id)
            response.headers["X-KB-Used"] = kb_used_val
            response.headers["X-KB-Sources"] = urllib.parse.quote("|".join(kb_sources))
            response.headers["X-WS-Sources"] = urllib.parse.quote("|".join(ws_sources))
            response.headers["X-Web-Sources"] = urllib.parse.quote(",".join(web_sources))
            response.headers["X-Web-Sources-Urls"] = urllib.parse.quote(",".join(web_source_urls))
            response.headers["X-Chat-Renamed"] = "true" if chat_renamed else "false"
            response.headers["Access-Control-Expose-Headers"] = "X-Chat-ID,X-KB-Used,X-KB-Sources,X-WS-Sources,X-Web-Sources,X-Web-Sources-Urls,X-Chat-Renamed"
            
            return {"response": content, "chat_id": chat_obj.id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Chat endpoint error", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class ChatSummarizeRequest(BaseModel):
    model: Optional[str] = None


@router.post("/session/{chat_id}/summarize")
async def summarize_chat(
    chat_id: int,
    req: ChatSummarizeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Generate a concise on-demand summary of a chat session using the LLM."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    history = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat_id)
        .order_by(models.Message.created_at.asc())
        .all()
    )
    if not history:
        return {"summary": "This chat has no messages to summarize."}

    # Build a compact transcript (skip empty content)
    lines = []
    for msg in history:
        content = (msg.content or "").strip()
        if content:
            role_label = "User" if msg.role == "user" else "Assistant"
            # Truncate very long messages to keep context manageable
            lines.append(f"{role_label}: {content[:800]}")

    transcript = "\n".join(lines)

    summarize_messages = [
        {
            "role": "system",
            "content": (
                "You are a summarization assistant. "
                "When given a conversation transcript, produce a concise summary "
                "of 3–6 bullet points covering the main topics, decisions, and outcomes. "
                "Be factual. Do not add opinions or filler."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Please summarize the following conversation:\n\n{transcript}"
            ),
        },
    ]

    model_name = req.model if req.model else settings.DEFAULT_TEXT_MODEL
    try:
        result = await asyncio.to_thread(
            llm_service.generate_chat,
            model_name,
            summarize_messages,
            False,
            {},
        )
        summary = result.get("message", {}).get("content", "").strip()
    except Exception as e:
        logger.error(f"Summarize chat error: {e}")
        raise HTTPException(status_code=500, detail=f"LLM summarization failed: {str(e)}")

    if not summary:
        raise HTTPException(status_code=500, detail="LLM returned an empty summary.")

    return {"summary": summary, "chat_id": chat_id, "title": chat_obj.title}


@router.post("/summarize/{workspace_id}")
async def trigger_summarization(
    workspace_id: int,
    chat_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    try:
        get_workspace_or_404(db, workspace_id, current_user.id)
        chat_obj = (
            db.query(models.Chat)
            .filter(
                models.Chat.id == chat_id,
                models.Chat.workspace_id == workspace_id,
            )
            .first()
        )
        if not chat_obj:
            raise HTTPException(status_code=404, detail="Chat not found")

        history = (
            db.query(models.Message)
            .filter(models.Message.chat_id == chat_obj.id)
            .order_by(models.Message.created_at.asc())
            .all()
        )
        if not history:
            return {"status": "No history to summarize"}

        formatted_history = "\n".join(
            [f"{msg.role.capitalize()}: {msg.content}" for msg in history]
        )
        memory_service.summarize_and_store_conversation(formatted_history, workspace_id)
        return {"status": "Memory updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("trigger_summarization error", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{workspace_id}")
def list_chats(
    workspace_id: int,
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all chat sessions for a workspace, newest first. Optionally search by title or message content."""
    get_workspace_or_404(db, workspace_id, current_user.id)

    query = db.query(models.Chat).filter(models.Chat.workspace_id == workspace_id)

    if q:
        search_pattern = f"%{q}%"
        
        # Subquery to check if there is a matching message
        content_match_exists = select(1).where(
            and_(
                models.Message.chat_id == models.Chat.id,
                models.Message.content.ilike(search_pattern)
            )
        ).exists()

        chats_with_match = (
            db.query(models.Chat, content_match_exists.label("content_match"))
            .filter(models.Chat.workspace_id == workspace_id)
            .filter(
                or_(
                    models.Chat.title.ilike(search_pattern),
                    content_match_exists
                )
            )
            .order_by(models.Chat.is_pinned.desc(), models.Chat.created_at.desc())
            .all()
        )
        
        return [
            {
                "id": c.Chat.id,
                "title": c.Chat.title or "Untitled Chat",
                "created_at": c.Chat.created_at,
                "is_pinned": bool(c.Chat.is_pinned),
                "folder_id": c.Chat.folder_id,
                "content_match": bool(c.content_match)
            }
            for c in chats_with_match
        ]

    chats = query.order_by(models.Chat.is_pinned.desc(), models.Chat.created_at.desc()).all()
    return [
        {
            "id": c.id,
            "title": c.title or "Untitled Chat",
            "created_at": c.created_at,
            "is_pinned": bool(c.is_pinned),
            "folder_id": c.folder_id,
            "content_match": False
        }
        for c in chats
    ]


class ChatFolderCreate(BaseModel):
    name: str

class ChatFolderUpdate(BaseModel):
    name: str

@router.get("/folders/{workspace_id}")
def list_folders(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    get_workspace_or_404(db, workspace_id, current_user.id)
    folders = db.query(models.ChatFolder).filter(
        models.ChatFolder.workspace_id == workspace_id
    ).order_by(models.ChatFolder.created_at.desc()).all()
    return [{"id": f.id, "name": f.name} for f in folders]


@router.post("/folders/{workspace_id}")
def create_folder(
    workspace_id: int,
    req: ChatFolderCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    get_workspace_or_404(db, workspace_id, current_user.id)
    folder = models.ChatFolder(workspace_id=workspace_id, name=req.name)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return {"id": folder.id, "name": folder.name}


@router.put("/folders/{folder_id}")
def update_folder(
    folder_id: int,
    req: ChatFolderUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    folder = db.query(models.ChatFolder).join(models.Workspace).filter(
        models.ChatFolder.id == folder_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    folder.name = req.name
    db.commit()
    db.refresh(folder)
    return {"id": folder.id, "name": folder.name}


@router.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    folder = db.query(models.ChatFolder).join(models.Workspace).filter(
        models.ChatFolder.id == folder_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
        
    db.delete(folder)
    db.commit()
    return {"status": "success"}


class MoveChatRequest(BaseModel):
    folder_id: Optional[int] = None

@router.put("/session/{chat_id}/move")
def move_chat(
    chat_id: int,
    req: MoveChatRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    chat = db.query(models.Chat).join(models.Workspace).filter(
        models.Chat.id == chat_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
        
    if req.folder_id is not None:
        folder = db.query(models.ChatFolder).filter(
            models.ChatFolder.id == req.folder_id,
            models.ChatFolder.workspace_id == chat.workspace_id
        ).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found or does not belong to this workspace")
            
    chat.folder_id = req.folder_id
    db.commit()
    return {"status": "success"}


@router.get("/session/{chat_id}")
def get_session(
    chat_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return messages for a specific chat (ownership enforced via workspace)."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    messages = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat_id)
        .order_by(models.Message.created_at.asc())
        .all()
    )
    return {
        "chat_id": chat_obj.id,
        "title": chat_obj.title or "Untitled Chat",
        "messages": [_message_out(m) for m in messages],
    }


@router.post("/sessions/{workspace_id}")
def create_chat(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Create a new empty chat session in the given workspace."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    chat_obj = models.Chat(workspace_id=workspace_id, title="New Chat")
    db.add(chat_obj)
    db.commit()
    db.refresh(chat_obj)
    return {"id": chat_obj.id, "title": chat_obj.title, "created_at": chat_obj.created_at}


@router.delete("/session/{chat_id}")
def delete_chat(
    chat_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete a chat session and all its messages (ownership enforced)."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    db.query(models.Message).filter(models.Message.chat_id == chat_id).delete()
    db.delete(chat_obj)
    db.commit()
    return {"status": "deleted"}


@router.patch("/session/{chat_id}")
def rename_chat(
    chat_id: int,
    req: RenameChatRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Rename a chat session (ownership enforced)."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    if not req.title.strip():
        raise HTTPException(status_code=400, detail="Title cannot be empty")

    chat_obj.title = req.title.strip()
    db.commit()
    return {"status": "success", "title": chat_obj.title}


@router.patch("/session/{chat_id}/pin")
def pin_chat(
    chat_id: int,
    req: PinChatRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Toggle the pinned state of a chat session."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    chat_obj.is_pinned = 1 if req.is_pinned else 0
    db.commit()
    return {"status": "success", "is_pinned": bool(chat_obj.is_pinned)}


@router.post("/truncate")
def truncate_chat(
    req: TruncateRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Retains the first `keep_count` messages and deletes the rest."""
    chat_obj = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == req.chat_id,
            models.Workspace.user_id == current_user.id,
        )
        .first()
    )
    if not chat_obj:
        raise HTTPException(status_code=404, detail="Chat not found")

    messages = (
        db.query(models.Message)
        .filter(models.Message.chat_id == req.chat_id)
        .order_by(models.Message.created_at.asc())
        .all()
    )

    if req.keep_count < len(messages):
        msgs_to_delete = messages[req.keep_count:]
        for msg in msgs_to_delete:
            db.delete(msg)
        db.commit()

    return {"status": "success", "kept": req.keep_count, "deleted": max(0, len(messages) - req.keep_count)}

# Memory CRUD routes moved to memory_router.py


# --- Message Feedback (Reactions) ---

class DirectMessageCreate(BaseModel):
    chat_id: int
    content: str
    role: Optional[str] = "user"


@router.post("/message")
def create_direct_message(
    req: DirectMessageCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    chat_obj = get_chat_or_404(db, req.chat_id, current_user.id)
    msg = models.Message(
        chat_id=chat_obj.id,
        role=req.role or "user",
        content=req.content,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return {
        "id": msg.id,
        "chat_id": msg.chat_id,
        "role": msg.role,
        "content": msg.content,
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
        "feedback": msg.feedback,
    }


@router.get("/messages/{chat_id}")
def get_chat_messages(
    chat_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    chat_obj = get_chat_or_404(db, chat_id, current_user.id)
    messages = (
        db.query(models.Message)
        .filter(models.Message.chat_id == chat_obj.id)
        .order_by(models.Message.created_at.asc())
        .all()
    )
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "feedback": m.feedback,
        }
        for m in messages
    ]


class MessageFeedbackRequest(BaseModel):
    feedback: Optional[str] = None  # 'positive', 'negative', or None to clear


@router.patch("/message/{message_id}/feedback")
@router.post("/message/{message_id}/feedback", include_in_schema=False)
@router.patch("/messages/{message_id}/feedback", include_in_schema=False)
@router.post("/messages/{message_id}/feedback", include_in_schema=False)
def set_message_feedback(
    message_id: int,
    req: MessageFeedbackRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Set or clear feedback (thumbs up/down) for a message (ownership enforced)."""
    msg = get_message_or_404(db, message_id, current_user.id)
    if req.feedback not in (None, "positive", "negative"):
        raise HTTPException(status_code=400, detail="feedback must be 'positive', 'negative', or null")
    msg.feedback = req.feedback
    db.commit()
    return {"message_id": message_id, "feedback": msg.feedback}


# --- Message Edit ---

class MessageEditRequest(BaseModel):
    content: str


@router.patch("/message/{message_id}/content")
@router.put("/message/{message_id}/content", include_in_schema=False)
@router.post("/message/{message_id}/content", include_in_schema=False)
@router.patch("/messages/{message_id}/content", include_in_schema=False)
@router.put("/messages/{message_id}/content", include_in_schema=False)
@router.post("/messages/{message_id}/content", include_in_schema=False)
@router.patch("/message/{message_id}/edit", include_in_schema=False)
@router.post("/message/{message_id}/edit", include_in_schema=False)
@router.patch("/messages/{message_id}/edit", include_in_schema=False)
@router.post("/messages/{message_id}/edit", include_in_schema=False)
def edit_message_content(
    message_id: int,
    req: MessageEditRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Edit the text content of a user message (ownership enforced)."""
    msg = get_message_or_404(db, message_id, current_user.id)
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    msg.content = req.content.strip()
    db.commit()
    return {"message_id": message_id, "content": msg.content}
