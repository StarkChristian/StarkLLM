import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "StarkLLM"
    VERSION: str = "1.0.0"
    
    # API settings
    API_V1_STR: str = "/api/v1"
    
    # CORS
    BACKEND_CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
        "http://localhost:8080",
        "http://localhost",
    ]

    # Knowledge Base — mounted Docker volume path
    KB_DATA_DIR: str = "/kb_data"
    KB_AUTO_SYNC_INTERVAL_SECONDS: int = int(os.getenv("KB_AUTO_SYNC_INTERVAL_SECONDS", "30"))
    KB_SYNC_DEBOUNCE_SECONDS: int = int(os.getenv("KB_SYNC_DEBOUNCE_SECONDS", "3"))
    
    # Auth
    SECRET_KEY: str = "starkllm_research_beta_secure_fallback_key_2026_change_in_production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7 # 7 days
    
    # Database
    SQLITE_URL: str = "sqlite:///./data/starkllm.db"
    
    # Vector DB
    CHROMA_PERSIST_DIRECTORY: str = "data/chroma"
    
    # LLM Settings (Ollama on Host)
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
    DEFAULT_TEXT_MODEL: str = os.getenv("DEFAULT_TEXT_MODEL", "qwen2.5:7b")
    DEFAULT_VISION_MODEL: str = os.getenv("DEFAULT_VISION_MODEL", "llava")
    DEFAULT_EMBEDDING_MODEL: str = os.getenv("DEFAULT_EMBEDDING_MODEL", "nomic-embed-text")
    
    # Paths for uploads
    UPLOAD_DIR: str = "data/uploads"
    
    # RAG Chunking configuration
    RAG_CHUNKING_STRATEGY: str = "semantic"  # "semantic", "recursive", "fixed"
    RAG_SEMANTIC_THRESHOLD: float = 0.45
    RAG_CHUNK_SIZE: int = 700
    RAG_CHUNK_OVERLAP: int = 100
    
    # RAG Improvements
    RAG_QUERY_REWRITING: bool = False
    RAG_MAX_CONTEXT_CHARS: int = 8000
    
    # Advanced RAG
    RAG_HYBRID_SEARCH: bool = True
    RAG_CONTEXT_COMPRESSION: bool = True
    
    class Config:
        case_sensitive = True

settings = Settings()
