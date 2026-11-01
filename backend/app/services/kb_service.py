"""
kb_service.py — Knowledge Base folder management and sync.

This module exposes the KBService class for managing the lifecycles of KnowledgeBaseFolder
and KnowledgeBaseDocument models. It also preserves backward-compatibility helpers for the
older sync implementations.
"""

import os
import json
import logging
import hashlib
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Optional
from sqlalchemy.orm import Session

# Try to import document processing libraries
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    import docx  # python-docx
except ImportError:
    docx = None

from app.core.config import settings
from app.db import models
from app.db.models import KnowledgeBaseFolder, KnowledgeBaseDocument, KBDocStatus
from app.services.rag_service import rag_service
from app.services.llm_service import llm_service, describe_indexing_error
from app.services.vision_service import vision_service

logger = logging.getLogger(__name__)

# Supported file formats for the Knowledge Base indexer.
# CSV and JSON are intentionally omitted until a meaningful chunking strategy
# is implemented; they are not claimed in README or UI.
SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".png", ".jpg", ".jpeg", ".txt", ".md", ".markdown", ".csv", ".json", ".xlsx", ".html", ".xml", ".log"}



class KBService:
    def __init__(self):
        self._sync_mutex = threading.Lock()
        self._active_sync_folders: set[int] = set()
        self._folder_snapshots: dict[int, dict[str, float]] = {}
        self._last_change_detected: dict[int, float] = {}
        self._watcher_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def is_folder_syncing(self, folder_id: int) -> bool:
        with self._sync_mutex:
            return folder_id in self._active_sync_folders

    def _acquire_sync_lock(self, folder_id: int) -> bool:
        with self._sync_mutex:
            if folder_id in self._active_sync_folders:
                return False
            self._active_sync_folders.add(folder_id)
            return True

    def _release_sync_lock(self, folder_id: int):
        with self._sync_mutex:
            self._active_sync_folders.discard(folder_id)

    def add_folder(self, db: Session, user_id: int, folder_path: str, folder_name: str = None) -> KnowledgeBaseFolder:
        """
        Registers a new folder for the user.
        If folder_name is not provided, use the last part of the folder path as the name.
        """
        try:
            if not folder_name:
                # Use the last non-empty part of the path as the display name
                folder_name = os.path.basename(folder_path.rstrip("/\\")) or folder_path

            logger.info(f"Adding KB folder for user {user_id}: path='{folder_path}', name='{folder_name}'")
            
            folder = KnowledgeBaseFolder(
                user_id=user_id,
                folder_path=folder_path,
                folder_name=folder_name,
                is_active=1
            )
            db.add(folder)
            db.commit()
            db.refresh(folder)
            return folder
        except Exception as e:
            db.rollback()
            logger.error(f"Error adding KB folder: {e}", exc_info=True)
            raise

    def get_user_folders(self, db: Session, user_id: int) -> list[KnowledgeBaseFolder]:
        """
        Returns all active folders belonging to a specific user.
        """
        try:
            return db.query(KnowledgeBaseFolder).filter(
                KnowledgeBaseFolder.user_id == user_id,
                KnowledgeBaseFolder.is_active == 1
            ).all()
        except Exception as e:
            logger.error(f"Error getting user KB folders: {e}", exc_info=True)
            raise

    def scan_folder(self, db: Session, folder_id: int) -> list[KnowledgeBaseDocument]:
        """
        Scans the physical folder on disk.
        Finds supported files (PDF, DOCX, PNG, JPG, JPEG).
        For each file that doesn't already exist in the database, creates a
        KnowledgeBaseDocument record with status 'pending'.
        Return the list of newly added documents.
        """
        try:
            folder = db.query(KnowledgeBaseFolder).filter(KnowledgeBaseFolder.id == folder_id).first()
            if not folder:
                raise ValueError(f"KnowledgeBaseFolder with ID {folder_id} not found")

            folder_path_str = folder.folder_path
            logger.info(f"Scanning folder ID {folder_id} (path: '{folder_path_str}')")

            if not os.path.exists(folder_path_str):
                raise FileNotFoundError(f"Physical folder path '{folder_path_str}' does not exist on disk")

            new_documents = []

            # Recursively walk the directory
            for root, dirs, files in os.walk(folder_path_str):
                # Skip hidden directories (starting with .)
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                
                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        abs_filepath = os.path.abspath(os.path.join(root, file))
                        
                        # Check if this document already exists in the database under this folder
                        existing_doc = db.query(KnowledgeBaseDocument).filter(
                            KnowledgeBaseDocument.folder_id == folder_id,
                            KnowledgeBaseDocument.file_path == abs_filepath
                        ).first()

                        if not existing_doc:
                            # Gather file stats
                            try:
                                stats = os.stat(abs_filepath)
                                file_size = stats.st_size
                                last_mod_dt = datetime.fromtimestamp(stats.st_mtime)
                            except Exception as stat_err:
                                logger.warning(f"Could not stat file '{abs_filepath}': {stat_err}")
                                continue

                            file_type = ext.lstrip('.')
                            
                            new_doc = KnowledgeBaseDocument(
                                folder_id=folder_id,
                                file_path=abs_filepath,
                                file_name=file,
                                file_type=file_type,
                                file_size=file_size,
                                last_modified=last_mod_dt,
                                status=KBDocStatus.PENDING,
                                chunk_count=0
                            )
                            db.add(new_doc)
                            new_documents.append(new_doc)

            if new_documents:
                db.commit()
                # Refresh all newly created docs to populate IDs/fields from DB
                for doc in new_documents:
                    db.refresh(doc)
                logger.info(f"Scan complete. Added {len(new_documents)} new documents to folder ID {folder_id}")
            else:
                logger.info(f"Scan complete. No new documents found for folder ID {folder_id}")

            return new_documents

        except Exception as e:
            db.rollback()
            logger.error(f"Error scanning folder ID {folder_id}: {e}", exc_info=True)
            raise

    def delete_folder(self, db: Session, folder_id: int, user_id: int) -> bool:
        """
        Deletes a Knowledge Base folder completely from the system:
        - Purges all vector chunks from ChromaDB for all documents in the folder
        - Deletes all KnowledgeBaseDocument records
        - Deletes the KnowledgeBaseFolder record
        Does NOT delete any physical files from the file system.
        """
        try:
            folder = db.query(KnowledgeBaseFolder).filter(
                KnowledgeBaseFolder.id == folder_id,
                KnowledgeBaseFolder.user_id == user_id
            ).first()
            if not folder:
                raise ValueError(f"KnowledgeBaseFolder with ID {folder_id} not found or unauthorized")

            logger.info(f"Deleting folder ID {folder_id} (path: '{folder.folder_path}')")

            # 1. Purge from ChromaDB
            docs = db.query(KnowledgeBaseDocument).filter(KnowledgeBaseDocument.folder_id == folder_id).all()
            if docs:
                doc_ids = [doc.id for doc in docs]
                try:
                    collection = rag_service.get_or_create_kb_collection(user_id)
                    # Delete by finding all document IDs
                    collection.delete(where={"document_id": {"$in": doc_ids}})
                    logger.info(f"Purged {len(doc_ids)} documents from ChromaDB for folder ID {folder_id}")
                except Exception as e:
                    logger.warning(f"Failed to purge chunks for deleted folder {folder_id}: {e}")

            # 2. Delete document records from DB (cascade typically handles this, but we do it explicitly to be safe if cascade isn't set up)
            db.query(KnowledgeBaseDocument).filter(KnowledgeBaseDocument.folder_id == folder_id).delete(synchronize_session=False)

            # 3. Delete folder record from DB
            db.delete(folder)
            db.commit()
            logger.info(f"Successfully deleted folder ID {folder_id}")
            return True

        except Exception as e:
            db.rollback()
            logger.error(f"Error deleting folder ID {folder_id}: {e}", exc_info=True)
            raise


    def sync_folder(self, db: Session, folder_id: int) -> dict:
        """
        Synchronizes the folder on disk with the database:
        - Finds new files (adds them as pending)
        - Finds modified files (updates size/mtime, sets pending, purges existing chunks)
        - Finds deleted files (removes from DB, purges chunks)
        - Automatically triggers indexing for all pending documents
        Safe overlap prevention: skips duplicate concurrent executions.
        Returns a stats dictionary: {'added': int, 'updated': int, 'deleted': int, 'indexed': int, 'failed': int}
        """
        if not self._acquire_sync_lock(folder_id):
            logger.info(f"KB: Sync for folder ID {folder_id} is already in progress. Skipping duplicate request.")
            return {
                "status": "already_syncing",
                "added": 0,
                "updated": 0,
                "deleted": 0,
                "indexed": 0,
                "failed": 0
            }

        try:
            folder = db.query(KnowledgeBaseFolder).filter(KnowledgeBaseFolder.id == folder_id).first()
            if not folder:
                raise ValueError(f"KnowledgeBaseFolder with ID {folder_id} not found")

            folder_path_str = folder.folder_path
            logger.info(f"Syncing folder ID {folder_id} (path: '{folder_path_str}')")

            if not os.path.exists(folder_path_str):
                raise FileNotFoundError(f"Physical folder path '{folder_path_str}' does not exist on disk")

            # 1. Fetch existing documents for this folder
            existing_docs = db.query(KnowledgeBaseDocument).filter(
                KnowledgeBaseDocument.folder_id == folder_id
            ).all()
            
            # Map by absolute file path for quick lookup
            docs_by_path = {doc.file_path: doc for doc in existing_docs}
            
            new_documents = []
            updated_documents = []
            
            # 2. Walk directory to find current files
            for root, dirs, files in os.walk(folder_path_str):
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                
                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        abs_filepath = os.path.abspath(os.path.join(root, file))
                        
                        try:
                            stats = os.stat(abs_filepath)
                            file_size = stats.st_size
                            last_mod_dt = datetime.fromtimestamp(stats.st_mtime)
                        except Exception as stat_err:
                            logger.warning(f"Could not stat file '{abs_filepath}': {stat_err}")
                            continue

                        file_type = ext.lstrip('.')
                        
                        existing_doc = docs_by_path.pop(abs_filepath, None)
                        
                        if not existing_doc:
                            # It's a new file
                            new_doc = KnowledgeBaseDocument(
                                folder_id=folder_id,
                                file_path=abs_filepath,
                                file_name=file,
                                file_type=file_type,
                                file_size=file_size,
                                last_modified=last_mod_dt,
                                status=KBDocStatus.PENDING,
                                chunk_count=0
                            )
                            db.add(new_doc)
                            new_documents.append(new_doc)
                        else:
                            # Check if modified
                            # using a slight tolerance for mtime comparison to avoid precision issues
                            diff = abs((existing_doc.last_modified - last_mod_dt).total_seconds())
                            if diff > 1.0 or existing_doc.file_size != file_size:
                                logger.info(f"File modified: {abs_filepath}")
                                existing_doc.file_size = file_size
                                existing_doc.last_modified = last_mod_dt
                                existing_doc.status = KBDocStatus.PENDING
                                existing_doc.chunk_count = 0
                                existing_doc.error_message = None
                                updated_documents.append(existing_doc)
                                
                                # Purge existing chunks
                                try:
                                    collection = rag_service.get_or_create_kb_collection(folder.user_id)
                                    collection.delete(where={"document_id": existing_doc.id})
                                except Exception as e:
                                    logger.warning(f"Failed to purge chunks for modified doc {existing_doc.id}: {e}")

            # 3. Process deleted files (whatever is left in docs_by_path)
            deleted_count = 0
            for abs_filepath, doc_to_delete in docs_by_path.items():
                logger.info(f"File deleted from disk: {abs_filepath}")
                try:
                    collection = rag_service.get_or_create_kb_collection(folder.user_id)
                    collection.delete(where={"document_id": doc_to_delete.id})
                except Exception as e:
                    logger.warning(f"Failed to purge chunks for deleted doc {doc_to_delete.id}: {e}")
                
                db.delete(doc_to_delete)
                deleted_count += 1
                
            db.commit()
            
            added_count = len(new_documents)
            updated_count = len(updated_documents)
            
            logger.info(f"Sync Phase 1 complete. Added: {added_count}, Updated: {updated_count}, Deleted: {deleted_count}")
            
            # 4. Trigger indexing for pending documents
            indexed_ids = self.index_pending_documents(db, folder_id=folder_id)
            queued_ids = [d.id for d in new_documents + updated_documents]
            failed_count = 0
            if queued_ids:
                failed_count = db.query(KnowledgeBaseDocument).filter(
                    KnowledgeBaseDocument.id.in_(queued_ids),
                    KnowledgeBaseDocument.status == KBDocStatus.FAILED,
                ).count()
            
            folder = db.query(KnowledgeBaseFolder).filter(KnowledgeBaseFolder.id == folder_id).first()
            if folder:
                folder.last_indexed_at = datetime.utcnow()
                db.commit()
                try:
                    if os.path.exists(folder.folder_path):
                        self._folder_snapshots[folder_id] = self._take_folder_snapshot(folder.folder_path)
                except Exception:
                    pass
            
            # Calculate failures (recently failed or still pending might mean failure if indexing threw internally but caught it)
            # We'll just report what got indexed successfully.
            
            return {
                "added": added_count,
                "updated": updated_count,
                "deleted": deleted_count,
                "indexed": len(indexed_ids),
                "failed": failed_count
            }

        except Exception as e:
            db.rollback()
            logger.error(f"Error syncing folder ID {folder_id}: {e}", exc_info=True)
            raise
        finally:
            self._release_sync_lock(folder_id)

    def get_folder_documents(self, db: Session, folder_id: int) -> list[KnowledgeBaseDocument]:
        """
        Returns all documents belonging to a specific folder.
        """
        try:
            return db.query(KnowledgeBaseDocument).filter(
                KnowledgeBaseDocument.folder_id == folder_id
            ).all()
        except Exception as e:
            logger.error(f"Error getting folder documents for folder ID {folder_id}: {e}", exc_info=True)
            raise

    def update_document_status(
        self,
        db: Session,
        document_id: int,
        status: str,
        chunk_count: int = None,
        error_message: str = None
    ) -> KnowledgeBaseDocument:
        """
        Updates the status of a document (e.g., from 'pending' to 'indexed' or 'failed').
        Optionally updates chunk_count and error_message.
        """
        try:
            doc = db.query(KnowledgeBaseDocument).filter(KnowledgeBaseDocument.id == document_id).first()
            if not doc:
                raise ValueError(f"KnowledgeBaseDocument with ID {document_id} not found")

            logger.info(f"Updating document ID {document_id} status from '{doc.status}' to '{status}'")
            doc.status = status
            
            if chunk_count is not None:
                doc.chunk_count = chunk_count
            if error_message is not None:
                doc.error_message = error_message
            if status == KBDocStatus.INDEXED:
                doc.indexed_at = datetime.utcnow()

            db.commit()
            db.refresh(doc)
            return doc
        except Exception as e:
            db.rollback()
            logger.error(f"Error updating status for document ID {document_id}: {e}", exc_info=True)
            raise

    # ---------------------------------------------------------------------------
    # New Indexing and Helper Methods
    # ---------------------------------------------------------------------------

    def get_embedding_model(self) -> str:
        """Returns the default embedding model configured for the application."""
        return settings.DEFAULT_EMBEDDING_MODEL

    def _chunk_text(self, text: str, chunk_size: int = 700, overlap: int = 100) -> list[str]:
        """Splits text into chunks of length chunk_size with overlap characters."""
        chunks = []
        if not text:
            return chunks
        
        start = 0
        text_len = len(text)
        while start < text_len:
            end = min(start + chunk_size, text_len)
            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)
            next_start = start + (chunk_size - overlap)
            if next_start <= start:
                break
            start = next_start
        return chunks

    def index_document(self, db: Session, document_id: int) -> bool:
        """
        Extracts content from a file according to its type, chunks the content,
        generates embeddings, and stores the chunks in ChromaDB.
        """
        doc = db.query(KnowledgeBaseDocument).filter(KnowledgeBaseDocument.id == document_id).first()
        if not doc:
            logger.error(f"KB: KnowledgeBaseDocument with ID {document_id} not found")
            return False

        folder = db.query(KnowledgeBaseFolder).filter(KnowledgeBaseFolder.id == doc.folder_id).first()
        if not folder:
            logger.error(f"KB: KnowledgeBaseFolder with ID {doc.folder_id} not found for document {document_id}")
            return False

        # Set status to indexing
        self.update_document_status(db, document_id, KBDocStatus.INDEXING)

        file_path = doc.file_path
        file_type = doc.file_type.lower()

        try:
            # 1. Content Extraction & Chunking with Honest Locators
            chunks = []
            metadatas = []
            ids = []
            file_prefix = hashlib.md5(file_path.encode()).hexdigest()[:8]

            if file_type == "pdf":
                if not fitz:
                    raise ImportError("PyMuPDF (fitz) is not installed")
                logger.info(f"KB: Extracting PDF page by page: {file_path}")
                pdf_doc = fitz.open(file_path)
                pdf_chunk_count = 0
                for page_num in range(len(pdf_doc)):
                    page = pdf_doc.load_page(page_num)
                    text = page.get_text("text")
                    if text and text.strip():
                        page_chunks = rag_service._semantic_chunk_text(text)
                        for idx, chunk in enumerate(page_chunks):
                            if chunk.strip():
                                pdf_chunk_count += 1
                                chunks.append(chunk.strip())
                                metadatas.append({
                                    "source": "knowledge_base",
                                    "user_id": folder.user_id,
                                    "folder_id": doc.folder_id,
                                    "document_id": document_id,
                                    "file_name": doc.file_name,
                                    "file_path": file_path,
                                    "chunk_index": pdf_chunk_count,
                                    "page": page_num,
                                    "locator": f"Page {page_num + 1}"
                                })
                                ids.append(f"kb_doc_{document_id}_{file_prefix}_p{page_num}_c{idx}")
                    else:
                        temp_path = None
                        try:
                            pix = page.get_pixmap()
                            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                                temp_path = tmp.name
                            pix.save(temp_path)

                            pdf_vision_prompt = (
                                "This is a scanned page from a PDF document. "
                                "Please extract the content carefully, paying special attention "
                                "to any text, tables, handwriting, and layout. "
                                "Provide a detailed transcription/description of the page content."
                            )
                            description = vision_service.generate_image_description(
                                temp_path, prompt=pdf_vision_prompt
                            )
                            if description and description.strip():
                                pdf_chunk_count += 1
                                chunks.append(description.strip())
                                metadatas.append({
                                    "source": "knowledge_base",
                                    "user_id": folder.user_id,
                                    "folder_id": doc.folder_id,
                                    "document_id": document_id,
                                    "file_name": doc.file_name,
                                    "file_path": file_path,
                                    "chunk_index": pdf_chunk_count,
                                    "page": page_num,
                                    "locator": f"Page {page_num + 1} (Vision)"
                                })
                                ids.append(f"kb_doc_{document_id}_{file_prefix}_p{page_num}_vis")
                        except Exception as vis_err:
                            logger.error(f"KB: Vision fallback failed on page {page_num}: {vis_err}")
                        finally:
                            if temp_path and os.path.exists(temp_path):
                                os.remove(temp_path)

            elif file_type == "docx":
                if not docx:
                    raise ImportError("python-docx is not installed")
                logger.info(f"KB: Extracting DOCX sections: {file_path}")
                docx_doc = docx.Document(file_path)
                sections = []
                current_heading = "General"
                current_texts = []
                for p in docx_doc.paragraphs:
                    p_text = p.text.strip()
                    if not p_text:
                        continue
                    style_name = getattr(getattr(p, 'style', None), 'name', '') or ''
                    if 'Heading' in style_name or 'Title' in style_name:
                        if current_texts:
                            sections.append((current_heading, "\n".join(current_texts)))
                            current_texts = []
                        current_heading = p_text[:60]
                    else:
                        current_texts.append(p_text)
                if current_texts:
                    sections.append((current_heading, "\n".join(current_texts)))
                if not sections:
                    full_text = "\n".join([p.text for p in docx_doc.paragraphs if p.text.strip()])
                    sections = [("General", full_text)]

                docx_chunk_count = 0
                for sec_title, sec_text in sections:
                    sec_chunks = rag_service._semantic_chunk_text(sec_text)
                    for c in sec_chunks:
                        if c.strip():
                            docx_chunk_count += 1
                            chunks.append(c.strip())
                            locator = f"Section: '{sec_title}' (chunk {docx_chunk_count})" if sec_title != "General" else f"Chunk {docx_chunk_count}"
                            metadatas.append({
                                "source": "knowledge_base",
                                "user_id": folder.user_id,
                                "folder_id": doc.folder_id,
                                "document_id": document_id,
                                "file_name": doc.file_name,
                                "file_path": file_path,
                                "chunk_index": docx_chunk_count,
                                "section": sec_title if sec_title != "General" else "",
                                "locator": locator
                            })
                            ids.append(f"kb_doc_{document_id}_{file_prefix}_c{docx_chunk_count}")

            elif file_type in ["png", "jpg", "jpeg"]:
                logger.info(f"KB: Generating vision description for image: {file_path}")
                description = vision_service.generate_image_description(file_path)
                if description and description.strip():
                    chunks.append(description.strip())
                    metadatas.append({
                        "source": "knowledge_base",
                        "user_id": folder.user_id,
                        "folder_id": doc.folder_id,
                        "document_id": document_id,
                        "file_name": doc.file_name,
                        "file_path": file_path,
                        "chunk_index": 1,
                        "locator": "Image"
                    })
                    ids.append(f"kb_doc_{document_id}_{file_prefix}_desc")
                else:
                    raise ValueError("Vision service returned empty description for the image")

            elif file_type in ["txt", "md", "markdown", "csv", "json", "xml", "log", "xlsx"]:
                logger.info(f"KB: Extracting text/data file ({file_type}): {file_path}")
                if file_type == "xlsx":
                    import openpyxl
                    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
                    lines = []
                    for ws in wb.worksheets:
                        lines.append(f"Sheet: {ws.title}")
                        for row in ws.iter_rows(values_only=True):
                            cells = ["" if c is None else str(c) for c in row]
                            if any(cells):
                                lines.append(" | ".join(cells))
                        lines.append("")
                    wb.close()
                    text = "\n".join(lines)
                else:
                    with open(file_path, "r", encoding="utf-8-sig", errors="ignore") as f:
                        text = f.read()
                text_chunks = rag_service._semantic_chunk_text(text)
                txt_chunk_count = 0
                for c in text_chunks:
                    if c.strip():
                        txt_chunk_count += 1
                        chunks.append(c.strip())
                        metadatas.append({
                            "source": "knowledge_base",
                            "user_id": folder.user_id,
                            "folder_id": doc.folder_id,
                            "document_id": document_id,
                            "file_name": doc.file_name,
                            "file_path": file_path,
                            "chunk_index": txt_chunk_count,
                            "locator": f"Chunk {txt_chunk_count}"
                        })
                        ids.append(f"kb_doc_{document_id}_{file_prefix}_c{txt_chunk_count}")

            elif file_type == "html":
                logger.info(f"KB: Extracting HTML: {file_path}")
                with open(file_path, "r", encoding="utf-8-sig", errors="ignore") as f:
                    html_content = f.read()
                from html.parser import HTMLParser as _HP

                class _TextExtractor(_HP):
                    def __init__(self):
                        super().__init__()
                        self._parts = []
                        self._skip = set()

                    def handle_starttag(self, tag, attrs):
                        if tag in {"script", "style", "head"}:
                            self._skip.add(tag)

                    def handle_endtag(self, tag):
                        self._skip.discard(tag)

                    def handle_data(self, d):
                        if not self._skip:
                            self._parts.append(d)

                    def text(self):
                        return " ".join(" ".join(self._parts).split())

                extractor = _TextExtractor()
                extractor.feed(html_content)
                html_text = extractor.text()
                html_chunks = rag_service._semantic_chunk_text(html_text)
                html_chunk_count = 0
                for c in html_chunks:
                    if c.strip():
                        html_chunk_count += 1
                        chunks.append(c.strip())
                        metadatas.append({
                            "source": "knowledge_base",
                            "user_id": folder.user_id,
                            "folder_id": doc.folder_id,
                            "document_id": document_id,
                            "file_name": doc.file_name,
                            "file_path": file_path,
                            "chunk_index": html_chunk_count,
                            "locator": f"Chunk {html_chunk_count}"
                        })
                        ids.append(f"kb_doc_{document_id}_{file_prefix}_c{html_chunk_count}")

            else:
                raise ValueError(f"Unsupported file type for indexing: {file_type}")

            if not chunks:
                raise ValueError("No text content could be extracted from this document")

            # 2. Vector Database Sync (ChromaDB)
            collection = rag_service.get_or_create_kb_collection(folder.user_id)

            # Delete any existing chunks for this specific document_id
            try:
                collection.delete(where={"document_id": document_id})
                logger.info(f"KB: Purged existing vector chunks for document ID {document_id}")
            except Exception as delete_err:
                logger.warning(f"KB: Could not delete old chunks for document ID {document_id}: {delete_err}")

            # Generate embeddings
            embedding_model = self.get_embedding_model()
            logger.info(f"KB: Generating embeddings with model '{embedding_model}' for {len(chunks)} chunks")
            embeddings = llm_service.generate_embeddings_batch(embedding_model, chunks)

            # Upsert vectors (safe for re-indexing — avoids duplicate ID errors)
            collection.upsert(
                documents=chunks,
                embeddings=embeddings,
                metadatas=metadatas,
                ids=ids
            )

            # Update status to indexed
            self.update_document_status(
                db,
                document_id,
                KBDocStatus.INDEXED,
                chunk_count=len(chunks),
                error_message=None
            )
            return True

        except Exception as e:
            logger.error(f"KB: Error indexing document ID {document_id}: {e}", exc_info=True)
            self.update_document_status(
                db,
                document_id,
                KBDocStatus.FAILED,
                error_message=describe_indexing_error(e)
            )
            return False


    def index_pending_documents(self, db: Session, folder_id: int = None) -> list[int]:
        """
        Finds all documents with status 'pending' in a folder (or all folders)
        and indexes them one by one.
        Returns a list of successfully indexed document IDs.
        """
        try:
            query = db.query(KnowledgeBaseDocument).filter(
                KnowledgeBaseDocument.status == KBDocStatus.PENDING
            )
            if folder_id is not None:
                query = query.filter(KnowledgeBaseDocument.folder_id == folder_id)
                
            pending_docs = query.all()
            logger.info(f"KB: Found {len(pending_docs)} pending document(s) to index.")
            
            successful_ids = []
            for doc in pending_docs:
                logger.info(f"KB: Indexing pending document ID {doc.id} ({doc.file_name})")
                success = self.index_document(db, doc.id)
                if success:
                    successful_ids.append(doc.id)
            return successful_ids
        except Exception as e:
            logger.error(f"KB: Error in index_pending_documents: {e}", exc_info=True)
            raise

    def _take_folder_snapshot(self, folder_path_str: str) -> dict[str, float]:
        snapshot = {}
        if not os.path.exists(folder_path_str):
            return snapshot
        try:
            for root, dirs, files in os.walk(folder_path_str):
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        full_p = os.path.abspath(os.path.join(root, file))
                        try:
                            snapshot[full_p] = os.path.getmtime(full_p)
                        except OSError:
                            pass
        except Exception as e:
            logger.warning(f"KB Watcher snapshot error for '{folder_path_str}': {e}")
        return snapshot

    def _watcher_loop(self):
        """
        Background mtime-polling watcher for registered KB folders.

        Implementation notes (honest):
        - Uses os.walk + os.path.getmtime — NOT a kernel filesystem watcher
          (inotify / ReadDirectoryChangesW). This means:
          * Changes are detected within KB_AUTO_SYNC_INTERVAL_SECONDS (default 30s),
            not instantly.
          * On Windows/Docker bind-mounts (NTFS→WSL2→container), mtime is reliably
            propagated to the container as long as the folder path stored in the DB
            is the *container-visible* path (e.g. /kb_data/...), not the host
            Windows path (e.g. C:\\Users\\...). If the user registers a Windows path
            that is not bind-mounted into the container, os.path.exists() will
            return False and the folder is silently skipped.
        - Debounce: after first change detection, waits KB_SYNC_DEBOUNCE_SECONDS
          before triggering sync. The loop sleeps in 1s ticks so debounce is
          honored even when the poll interval is much longer.
        - Overlap safety: sync_folder() uses _acquire_sync_lock(); concurrent
          syncs for the same folder are skipped.
        """
        logger.info("KB: Background folder sync watcher started (mtime polling).")
        while not self._stop_event.is_set():
            try:
                interval = max(5, getattr(settings, "KB_AUTO_SYNC_INTERVAL_SECONDS", 30))
                debounce_window = max(1, getattr(settings, "KB_SYNC_DEBOUNCE_SECONDS", 3))

                # Sleep in 1s ticks so we can react to debounce expiry promptly
                # and shut down cleanly without a long join delay.
                for _ in range(interval):
                    if self._stop_event.is_set():
                        break

                    # Check if any pending debounce has expired
                    now = time.time()
                    expired = [
                        fid for fid, t in list(self._last_change_detected.items())
                        if now - t >= debounce_window
                    ]
                    for folder_id in expired:
                        self._last_change_detected.pop(folder_id, None)
                        logger.info(
                            f"KB Watcher: Debounce expired for folder ID {folder_id}. "
                            "Triggering auto-sync."
                        )
                        try:
                            from app.db.session import SessionLocal
                            with SessionLocal() as db:
                                self.sync_folder(db, folder_id)
                                # Refresh snapshot after sync
                                folder = db.query(KnowledgeBaseFolder).filter(
                                    KnowledgeBaseFolder.id == folder_id
                                ).first()
                                if folder and os.path.exists(folder.folder_path):
                                    self._folder_snapshots[folder_id] = self._take_folder_snapshot(
                                        folder.folder_path
                                    )
                        except Exception as sync_err:
                            logger.error(
                                f"KB Watcher: Auto-sync failed for folder ID {folder_id}: {sync_err}",
                                exc_info=True
                            )

                    time.sleep(1)

                if self._stop_event.is_set():
                    break

                # Full poll: compare snapshots for all active folders
                try:
                    from app.db.session import SessionLocal
                    with SessionLocal() as db:
                        folders = db.query(KnowledgeBaseFolder).filter(
                            KnowledgeBaseFolder.is_active == 1
                        ).all()
                        for folder in folders:
                            if self._stop_event.is_set():
                                break
                            folder_id = folder.id
                            folder_path = folder.folder_path

                            if not os.path.exists(folder_path):
                                # Path not visible from container — log warning with actionable remedy
                                logger.warning(
                                    f"KB Watcher: folder ID {folder_id} path '{folder_path}' "
                                    "not accessible from inside container. If this is a Windows path, "
                                    "use the StarkLLM launcher (start.exe) to mirror it into /kb_data."
                                )
                                continue

                            current_snap = self._take_folder_snapshot(folder_path)
                            prev_snap = self._folder_snapshots.get(folder_id)

                            if prev_snap is None:
                                # First observation — record baseline; check for unindexed files on disk
                                self._folder_snapshots[folder_id] = current_snap
                                doc_count = db.query(KnowledgeBaseDocument).filter(
                                    KnowledgeBaseDocument.folder_id == folder_id
                                ).count()
                                if len(current_snap) > doc_count:
                                    self._last_change_detected[folder_id] = time.time()
                                    logger.info(
                                        f"KB Watcher: Unindexed files detected in folder ID {folder_id} "
                                        f"({len(current_snap)} on disk vs {doc_count} in DB). Will sync after {debounce_window}s debounce."
                                    )
                                continue

                            has_changes = (current_snap != prev_snap)
                            if has_changes and folder_id not in self._last_change_detected:
                                self._last_change_detected[folder_id] = time.time()
                                logger.info(
                                    f"KB Watcher: Change detected in folder ID {folder_id} "
                                    f"('{folder_path}'). Will sync after {debounce_window}s debounce."
                                )
                            elif not has_changes and folder_id not in self._last_change_detected:
                                # Stable — keep snapshot current.
                                self._folder_snapshots[folder_id] = current_snap
                except Exception as poll_err:
                    logger.error(f"KB Watcher: Poll error: {poll_err}", exc_info=True)

            except Exception as e:
                logger.error(f"KB Watcher loop encountered error: {e}", exc_info=True)
                time.sleep(5)

        logger.info("KB: Background folder sync watcher stopped.")


    def start_background_watcher(self):
        if self._watcher_thread and self._watcher_thread.is_alive():
            return
        self._stop_event.clear()
        self._watcher_thread = threading.Thread(
            target=self._watcher_loop,
            name="KB-Folder-Sync-Watcher",
            daemon=True
        )
        self._watcher_thread.start()
        logger.info("KB: Background folder sync watcher thread initialized.")

    def stop_background_watcher(self):
        if self._watcher_thread and self._watcher_thread.is_alive():
            self._stop_event.set()
            self._watcher_thread.join(timeout=3)
            logger.info("KB: Background folder sync watcher stopped.")


kb_service = KBService()
