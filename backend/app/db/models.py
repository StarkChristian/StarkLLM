from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Float, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.session import Base


# ---------------------------------------------------------------------------
# Existing models
# ---------------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    profile_context = Column(String, nullable=True)
    custom_instructions = Column(String, nullable=True)
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
    name = Column(String, index=True)
    active_kb_dir_ids = Column(String, nullable=True)  # JSON-encoded list of integer folder IDs
    system_prompt = Column(String, nullable=True)       # Custom workspace-level system prompt
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="workspaces")
    chats = relationship("Chat", back_populates="workspace")
    documents = relationship("Document", back_populates="workspace")
    chat_folders = relationship("ChatFolder", back_populates="workspace", cascade="all, delete-orphan")


class ChatFolder(Base):
    __tablename__ = "chat_folders"
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="chat_folders")
    chats = relationship("Chat", back_populates="folder")


class Chat(Base):
    __tablename__ = "chats"
    id = Column(Integer, primary_key=True, index=True)
    workspace_id = Column(Integer, ForeignKey("workspaces.id"))
    folder_id = Column(Integer, ForeignKey("chat_folders.id", ondelete="SET NULL"), nullable=True)
    title = Column(String)
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
    content = Column(String)
    feedback = Column(String, nullable=True)  # 'positive', 'negative', or None
    # JSON {"kb_used", "kb", "ws", "web": [{"title", "url"}]}: the source chips of an answer, shown again when the
    # chat is reopened (they used to exist only in the headers of the live response).
    sources = Column(String, nullable=True)
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
    filename = Column(String)
    filepath = Column(String)
    file_type = Column(String)
    status = Column(String, default=DocStatus.INDEXED, nullable=False)
    error_message = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    workspace = relationship("Workspace", back_populates="documents")

class PromptTemplate(Base):
    __tablename__ = "prompt_templates"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, index=True)
    content = Column(String)
    tags = Column(String, nullable=True)
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
    error_message = Column(String, nullable=True)                # set on failure
    indexed_at    = Column(DateTime, nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    folder = relationship("KnowledgeBaseFolder", back_populates="documents")

    def __repr__(self) -> str:
        return (
            f"<KnowledgeBaseDocument id={self.id} folder_id={self.folder_id} "
            f"name={self.file_name!r} status={self.status!r}>"
        )
