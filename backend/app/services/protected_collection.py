"""ChromaDB collections with protected text (B6).

The text of every indexed chunk (and every stored memory) is the content of the user's documents, so it is encrypted
before it is handed to ChromaDB and decrypted when it comes back. The rest of the engine uses this wrapper exactly
like a normal collection and never sees the difference. What stays readable in the vector store, on purpose:

* the vectors (embeddings): search needs them. They are numbers, but they reveal what a chunk is about; see
  docs/encryption-design.md ("what is not protected");
* the metadata (file name, page, chunk number, source path): filters and citations need it.
"""
from app.core import chroma_store
from app.core.config import settings
from app.core.protection import protection

CONTEXT = "vectors.document"


def seal_documents(documents):
    if documents is None:
        return None
    if isinstance(documents, str):
        return protection.seal_text(documents, CONTEXT)
    return [protection.seal_text(d, CONTEXT) for d in documents]


def open_documents(documents):
    if documents is None:
        return None
    return [open_documents(d) if isinstance(d, list) else protection.open_text(d, CONTEXT) for d in documents]


class ProtectedCollection:
    """Wraps a chromadb Collection; anything not listed here is passed straight through."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    @property
    def inner(self):
        return self._inner

    def _write(self, method, ids, embeddings, metadatas, documents, kwargs):
        sealed = seal_documents(documents)
        with chroma_store.WRITE_LOCK:
            result = getattr(self._inner, method)(ids=ids, embeddings=embeddings, metadatas=metadatas,
                                                  documents=sealed, **kwargs)
        if protection.enabled:
            # new index files can hold uncleared memory with readable text (see chroma_store)
            chroma_store.scrub_soon(settings.CHROMA_PERSIST_DIRECTORY)
        return result

    def add(self, ids, embeddings=None, metadatas=None, documents=None, **kwargs):
        return self._write("add", ids, embeddings, metadatas, documents, kwargs)

    def upsert(self, ids, embeddings=None, metadatas=None, documents=None, **kwargs):
        return self._write("upsert", ids, embeddings, metadatas, documents, kwargs)

    def update(self, ids, embeddings=None, metadatas=None, documents=None, **kwargs):
        return self._write("update", ids, embeddings, metadatas, documents, kwargs)

    def get(self, *args, **kwargs):
        result = self._inner.get(*args, **kwargs)
        if result and result.get("documents") is not None:
            result["documents"] = open_documents(result["documents"])
        return result

    def query(self, *args, **kwargs):
        result = self._inner.query(*args, **kwargs)
        if result and result.get("documents") is not None:
            result["documents"] = open_documents(result["documents"])
        return result


def wrap(collection):
    from app.services.secure_index import SecureCollection
    if isinstance(collection, (ProtectedCollection, SecureCollection)):
        return collection           # the encrypted index stores everything encrypted already
    return ProtectedCollection(collection)
