from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Float, Boolean, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.session import Base
from app.core.protection import ProtectedText


# ---------------------------------------------------------------------------
# Existing models
# ---------------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    profile_context = Column(ProtectedText("users.profile_context", locked_value=None), nullable=True)
    custom_instructions = Column(ProtectedText("users.custom_instructions", locked_value=None), nullable=True)
    default_model = Column(String, nullable=True)
    temperature = Column(Float, nullable=True)
    top_p = Column(Float, nullable=True)
    max_tokens = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    workspaces = relationship("Workspace", back_populates="user")
    knowledge_base_folders = relationship(
        "KnowledgeBaseFolder", back_populates="user", cascade="all, delete-orphan"
    )


class Workspace(Base):
    __tablename__ = "workspaces"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(ProtectedText("workspaces.name", locked_value="\U0001F512"), index=True)
    active_kb_dir_ids = Column(String, nullable=True)  # JSON-encoded list of integer folder IDs
    system_prompt = Column(ProtectedText("workspaces.system_prompt"), nullable=True)       # Custom workspace-level system prompt
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="workspaces")
    chats = relationship("Chat", back_populates="workspace")
    documents = relationship("Document", back_populates="workspace")
    chat_folders = relationship("ChatFolder", back_populates="workspace", cascade="all, delete-orphan")


class ChatFolder(Base):
    __tablename__ = "chat_folders"
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(ProtectedText("chat_folders.name", locked_value="\U0001F512"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="chat_folders")
    chats = relationship("Chat", back_populates="folder")


class Chat(Base):
    __tablename__ = "chats"
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id"))
    folder_id = Column(Integer, ForeignKey("chat_folders.id", ondelete="SET NULL"), nullable=True)
    title = Column(ProtectedText("chats.title", locked_value="\U0001F512"))
    is_pinned = Column(Integer, default=0, nullable=False)  # 0 = unpinned, 1 = pinned
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="chats")
    folder = relationship("ChatFolder", back_populates="chats")
    messages = relationship("Message", back_populates="chat")


class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    chat_id = Column(Integer, ForeignKey("chats.id"))
    role = Column(String)  # 'user', 'assistant', 'system'
    content = Column(ProtectedText("messages.content"))
    feedback = Column(String, nullable=True)  # 'positive', 'negative', or None
    # JSON {"kb_used", "kb", "ws", "web": [{"title", "url"}]}: the source chips of an answer, shown again when the
    # chat is reopened (they used to exist only in the headers of the live response).
    sources = Column(ProtectedText("messages.sources"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    chat = relationship("Chat", back_populates="messages")


# Workspace document status constants
class DocStatus:
    UPLOADING  = "uploading"
    EXTRACTING = "extracting"
    CHUNKING   = "chunking"
    EMBEDDING  = "embedding"
    INDEXED    = "indexed"
    FAILED     = "failed"


class Document(Base):
    __tablename__ = "documents"
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id"))
    filename = Column(ProtectedText("documents.filename", locked_value="\U0001F512"))
    filepath = Column(String)
    file_type = Column(String)
    status = Column(String, default=DocStatus.INDEXED, nullable=False)
    error_message = Column(ProtectedText("documents.error_message", locked_value=None), nullable=True)
    # layered summaries of large documents (services/summaries.py): None, queued, "<done>/<total>", done, small, failed
    summary_status = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="documents")

class PromptTemplate(Base):
    __tablename__ = "prompt_templates"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(ProtectedText("prompt_templates.title", locked_value="\U0001F512"), index=True)
    content = Column(ProtectedText("prompt_templates.content"))
    tags = Column(ProtectedText("prompt_templates.tags", locked_value=None), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User")


# ---------------------------------------------------------------------------
# Knowledge Base models v2 — Full lifecycle tracking
# Richer models that track per-document indexing state, chunk counts,
# and error messages.  Designed to back the "My Knowledge Base" UI feature.
# ---------------------------------------------------------------------------

# Document status constants
class KBDocStatus:
    PENDING  = "pending"
    INDEXING = "indexing"
    INDEXED  = "indexed"
    FAILED   = "failed"


class KnowledgeBaseFolder(Base):
    """
    A local folder registered by a user for personal KB indexing.

    `folder_path` is the **full absolute path** on the host machine (passed
    into the container via a bind-mount or exposed through the API).
    `folder_name` is the human-readable label shown in the UI.
    `is_active` lets users temporarily pause indexing without deleting the row.
    """
    __tablename__ = "knowledge_base_folders"

    id               = Column(Integer, primary_key=True, index=True)
    user_id          = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    folder_path      = Column(String, nullable=False)          # full path on host / volume
    folder_name      = Column(String, nullable=False)          # display label
    is_active        = Column(Integer, default=1, nullable=False)  # 1=active, 0=paused (SQLite bool)
    last_indexed_at  = Column(DateTime, nullable=True)
    created_at       = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    user      = relationship("User", back_populates="knowledge_base_folders")
    documents = relationship(
        "KnowledgeBaseDocument",
        back_populates="folder",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return (
            f"<KnowledgeBaseFolder id={self.id} user_id={self.user_id} "
            f"name={self.folder_name!r}>"
        )


class KnowledgeBaseDocument(Base):
    """
    A single file inside a KnowledgeBaseFolder.

    Lifecycle:  pending → indexing → indexed
                                   ↘ failed (error_message populated)

    `chunk_count` is updated after successful indexing so the UI can show
    how many ChromaDB chunks were created for this file.
    `status` is one of the KBDocStatus constants.
    All queries MUST filter on folder.user_id (via join) for data isolation.
    """
    __tablename__ = "knowledge_base_documents"

    id            = Column(Integer, primary_key=True, index=True)
    folder_id     = Column(
        Integer, ForeignKey("knowledge_base_folders.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    file_path     = Column(String, nullable=False, index=True)   # absolute path
    file_name     = Column(String, nullable=False)
    file_type     = Column(String, nullable=False)               # pdf, docx, png, …
    file_size     = Column(Integer, nullable=False)              # bytes
    last_modified = Column(DateTime, nullable=False)             # mtime as datetime
    status        = Column(String, default=KBDocStatus.PENDING, nullable=False)
    chunk_count   = Column(Integer, default=0, nullable=False)
    error_message = Column(ProtectedText("knowledge_base_documents.error_message", locked_value=None), nullable=True)  # set on failure
    indexed_at    = Column(DateTime, nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    folder = relationship("KnowledgeBaseFolder", back_populates="documents")

    def __repr__(self) -> str:
        return (
            f"<KnowledgeBaseDocument id={self.id} folder_id={self.folder_id} "
            f"name={self.file_name!r} status={self.status!r}>"
        )


class DocumentReview(Base):
    """What the user decided about a document in the inbox (docs/document-inbox-design.md, B4): done or still new,
    their own title, the case it belongs to. StarkLLM only suggests; nothing is renamed or moved on disk.
    scope "ws" is a workspace document (documents.id), "kb" a knowledge-base file (knowledge_base_documents.id)."""
    __tablename__ = "document_reviews"
    __table_args__ = (UniqueConstraint("user_id", "scope", "document_id", name="uq_document_review"),)

    id          = Column(Integer, primary_key=True, index=True)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    scope       = Column(String, nullable=False)                 # "ws" or "kb"
    document_id = Column(Integer, nullable=False)
    status      = Column(String, default="new", nullable=False)  # "new" or "done"
    title       = Column(ProtectedText("document_reviews.title"), nullable=True)                  # the user's own title, else the suggested one
    case_key    = Column(ProtectedText("document_reviews.case_key"), nullable=True)                  # the user's case, else the suggested one
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DateChoice(Base):
    """How the user reads a date that the letter leaves open ("03/04/2026": 3 April or 4 March). StarkLLM never guesses
    such a date: until the user chooses, it is shown with both readings and used for no reminder or calendar entry.
    literal is the date as written in the document; reading is "dmy" (day first) or "mdy" (month first)."""
    __tablename__ = "date_choices"

    id          = Column(Integer, primary_key=True, index=True)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    scope       = Column(String, nullable=False)                 # "ws" or "kb"
    document_id = Column(Integer, nullable=False, index=True)
    literal     = Column(ProtectedText("date_choices.literal"), nullable=False)
    reading     = Column(String, nullable=False)                 # "dmy" or "mdy"
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DeadlineReminder(Base):
    """A reminder the user set for a deadline found in a letter (docs/document-inbox-design.md, B5): "remind me
    N days before". The deadline itself is not stored; it is found again in the document text by rules, and is
    identified by document, date and kind. A reminder becomes active on (due date - days_before) and stays on the
    dashboard until the user confirms it. Nothing leaves the PC."""
    __tablename__ = "deadline_reminders"
    __table_args__ = (UniqueConstraint("user_id", "scope", "document_id", "due_date", "kind", "days_before",
                                       name="uq_deadline_reminder"),)

    id           = Column(Integer, primary_key=True, index=True)
    user_id      = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    scope        = Column(String, nullable=False)                 # "ws" or "kb", as in DocumentReview
    document_id  = Column(Integer, nullable=False)
    due_date     = Column(String, nullable=False)                 # ISO yyyy-mm-dd
    kind         = Column(String, nullable=False)                 # "deadline", "payment" or "appointment"
    days_before  = Column(Integer, nullable=False)                # 0 = on the day
    acknowledged = Column(Integer, default=0, nullable=False)     # 1 once the user confirmed the reminder
    created_at   = Column(DateTime, default=datetime.utcnow)


class DeadlineDone(Base):
    """A deadline the user marked done (a paid invoice, a kept appointment), independent of its letter: it leaves the
    list, the dashboard and the calendar file, the letter stays, and the mark can be undone. Identified like a
    reminder: document, date and kind (docs/document-inbox-design.md, B5)."""
    __tablename__ = "deadline_done"
    __table_args__ = (UniqueConstraint("user_id", "scope", "document_id", "due_date", "kind", name="uq_deadline_done"),)

    id          = Column(Integer, primary_key=True, index=True)
    user_id     = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    scope       = Column(String, nullable=False)                 # "ws" or "kb"
    document_id = Column(Integer, nullable=False)
    due_date    = Column(String, nullable=False)                 # ISO yyyy-mm-dd
    kind        = Column(String, nullable=False)
    created_at  = Column(DateTime, default=datetime.utcnow)
