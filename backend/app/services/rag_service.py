import os 
import re 
import math 
import hashlib 
import unicodedata 
from collections import Counter 
import tempfile 
import logging 
import chromadb 
from typing import List ,Dict ,Any ,Tuple ,Optional 
from html .parser import HTMLParser 
from app .core .config import settings 
from app .services .llm_service import llm_service 
from app .services .vision_service import vision_service 
try :
    import pymupdf as fitz 
except ImportError :
    import fitz # PyMuPDF

logger =logging .getLogger (__name__ )

try :
    from flashrank import Ranker ,RerankRequest 
except ImportError :
    Ranker ,RerankRequest =None ,None 

ENGLISH_STOP_WORDS ={
"a","about","above","after","again","against","all","am","an","and","any","are","aren't","as","at",
"be","because","been","before","being","below","between","both","but","by","can't","cannot","could",
"couldn't","did","didn't","do","does","doesn't","doing","don't","down","during","each","few","for",
"from","further","had","hadn't","has","hasn't","have","haven't","having","he","he'd","he'll","he's",
"her","here","here's","hers","herself","him","himself","his","how","how's","i","i'd","i'll","i'm",
"i've","if","in","into","is","isn't","it","it's","its","itself","let's","me","more","most","mustn't",
"my","myself","no","nor","not","of","off","on","once","only","or","other","ought","our","ours",
"ourselves","out","over","own","same","shan't","she","she'd","she'll","she's","should","shouldn't",
"so","some","such","than","that","that's","the","their","theirs","them","themselves","then","there",
"there's","these","they","they'd","they'll","they're","they've","this","those","through","to","too",
"under","until","up","very","was","wasn't","we","we'd","we'll","we're","we've","were","weren't",
"what","what's","when","when's","where","where's","which","while","who","who's","whom","why","why's",
"with","won't","would","wouldn't","you","you'd","you'll","you're","you've","your","yours","yourself",
"yourselves"
}

# The lexical branch used to filter English stop words only, so German function words ("der", "wie", "beim")
# dominated the keyword ranking of German questions.
GERMAN_STOP_WORDS ={
"der","die","das","den","dem","des","ein","eine","einer","einem","einen","eines","und","oder","aber","nicht",
"ist","sind","war","waren","wird","werden","wurde","wurden","hat","haben","hatte","hatten","wie","was","wer",
"wo","wann","warum","wieso","welche","welcher","welches","welchen","welchem","viel","viele","wieviel","auf",
"aus","bei","beim","mit","nach","von","vom","zu","zum","zur","über","ueber","unter","vor","für","fuer","gegen",
"ohne","durch","um","am","im","in","an","ich","du","er","sie","es","wir","ihr","mein","dein","sein","unser",
"sich","auch","noch","nur","schon","dann","dass","daß","als","wenn","bitte","kann","können","koennen","muss",
"müssen","muessen","soll","sollen","gibt","mir","mich","uns","dir","ihre","ihren","ihrem","seine","seinen"
}

def _fold(text :str )->str :
    """Lowercase and fold German umlauts / accents so 'Zähler' matches 'Zaehler' and 'Straße' matches 'Strasse'."""
    text =text .lower ().replace ("ä","ae").replace ("ö","oe").replace ("ü","ue").replace ("ß","ss")
    return "".join (c for c in unicodedata .normalize ("NFKD",text )if not unicodedata .combining (c ))


class HTMLTextExtractor (HTMLParser ):
    def __init__ (self ):
        super ().__init__ ()
        self .reset ()
        self .fed =[]
        self .ignore_tags ={"script","style","head"}
        self .current_ignore =set ()

    def handle_starttag (self ,tag ,attrs ):
        if tag in self .ignore_tags :
            self .current_ignore .add (tag )

    def handle_endtag (self ,tag ):
        if tag in self .ignore_tags :
            self .current_ignore .discard (tag )
        if tag in {"p","br","div","h1","h2","h3","h4","h5","h6","li","tr","td"}:
            self .fed .append (" ")

    def handle_data (self ,d ):
        if not self .current_ignore :
            self .fed .append (d )

    def get_data (self ):
        text ="".join (self .fed )
        return " ".join (text .split ())


_UPLOAD_PREFIX = re.compile(r"^[0-9a-f]{8}_(.+)$")


def source_display_name(meta: dict) -> str:
    """The file name a person recognises for a chunk: the KB's stored name, or the upload's original name
    (uploads are saved as '<8 hex>_<original name>' to avoid collisions; that prefix is not part of the name)."""
    meta = meta or {}
    if meta.get("file_name"):
        return meta["file_name"]
    path = meta.get("source") or meta.get("file_path") or ""
    name = os.path.basename(path)
    upload_dir = os.path.normpath(settings.UPLOAD_DIR)
    if path and os.path.normpath(os.path.dirname(path)).endswith(upload_dir):
        m = _UPLOAD_PREFIX.match(name)
        if m:
            return m.group(1)
    return name


class RAGService :
    def __init__ (self ):
        self .chroma_client =chromadb .PersistentClient (
        path =settings .CHROMA_PERSIST_DIRECTORY ,
        settings =chromadb .config .Settings (anonymized_telemetry =False ),
        )
        self .embedding_model =settings .DEFAULT_EMBEDDING_MODEL 
        self .ranker =None 
        if Ranker :
            try :
                self .ranker =Ranker (
                model_name ="ms-marco-TinyBERT-L-2-v2",cache_dir ="./data/models"
                )
            except Exception as e :
                # The reranker model is downloaded on first use; without network access
                # the backend must still start (retrieval just skips reranking).
                logger .warning (f"Reranker unavailable, continuing without reranking: {e }")

            # ------------------------------------------------------------------
            # Collection helpers
            # ------------------------------------------------------------------

    def get_or_create_collection (self ,workspace_id :int ,user_id :int ):
        name =f"user_{user_id }_workspace_{workspace_id }"
        return self .chroma_client .get_or_create_collection (name =name )

    def get_kb_collection_name (self ,user_id :int )->str :
        return f"user_{user_id }_knowledge_base"

    def get_or_create_kb_collection (self ,user_id :int ):
        name =self .get_kb_collection_name (user_id )
        return self .chroma_client .get_or_create_collection (name =name )

    def get_document_preview(self, collection, filepath: str) -> str:
        """Fetches the first few chunks of a document to serve as a preview."""
        try:
            # We don't need all chunks, just enough to show the user what it is.
            results = collection.get(where={"source": filepath}, limit=5)
            if results and results.get('documents'):
                docs = results['documents']
                preview_text = "\n\n...\n\n".join(docs)
                if len(preview_text) > 3000:
                    return preview_text[:3000] + "..."
                return preview_text
            return "No text preview available for this document."
        except Exception as e:
            logger.error(f"Error fetching document preview: {e}")
            return "Error loading preview."

        # ------------------------------------------------------------------
        # Shared file-processing core
        # ------------------------------------------------------------------

    def _file_id_prefix (self ,file_path :str )->str :
        """8-char hash of the full path — makes chunk IDs unique across files
        that share the same basename."""
        return hashlib .md5 (file_path .encode ()).hexdigest ()[:8 ]

    def _process_file_to_chunks (
    self ,file_path :str 
    )->Tuple [List [str ],List [Dict ],List [str ]]:
        """
        Parse *file_path* and return (chunks, metadatas, ids).

        Supported types:
            .pdf  — text extraction → OCR fallback → Vision fallback
            .png / .jpg / .jpeg — Vision description
            .txt / .md          — plain text
            .docx               — python-docx paragraph extraction
        """
        file_ext =os .path .splitext (file_path )[1 ].lower ()
        prefix =self ._file_id_prefix (file_path )
        basename =os .path .basename (file_path )

        chunks :List [str ]=[]
        metadatas :List [Dict ]=[]
        ids :List [str ]=[]

        try :
        # ---------------------------------------------------------------- PDF
            if file_ext ==".pdf":
                logger.info (f"RAG: Starting PDF processing for {file_path }")
                doc =fitz .open (file_path )
                logger.info (f"RAG: PDF opened — {len (doc )} page(s)")
                pdf_chunks_created =0 

                for page_num in range (len (doc )):
                    page =doc .load_page (page_num )
                    text =page .get_text ("text")

                    if text and text.strip():
                        page_chunks = self._semantic_chunk_text(text)
                        for idx, chunk in enumerate(page_chunks):
                            if chunk.strip():
                                chunks.append(chunk.strip())
                                metadatas.append({
                                    "source": file_path,
                                    "page": page_num,
                                    "locator": f"Page {page_num + 1}",
                                    "chunk": idx + 1
                                })
                                ids.append(f"{prefix}_{basename}_p{page_num}_c{idx}")
                                pdf_chunks_created += 1
                    else:
                        logger.info(
                            f"RAG: Page {page_num} has no native text — trying OCR…"
                        )
                        temp_path = None
                        try:
                            pix = page.get_pixmap()
                            with tempfile.NamedTemporaryFile(
                                suffix=".png", delete=False
                            ) as tmp:
                                temp_path = tmp.name
                            pix.save(temp_path)

                            import pytesseract
                            from PIL import Image

                            ocr_text = pytesseract.image_to_string(
                                Image.open(temp_path)
                            )

                            if ocr_text and len(ocr_text.strip()) > 50:
                                logger.info(
                                    f"RAG: Tesseract extracted "
                                    f"{len(ocr_text.strip())} chars from page {page_num}"
                                )
                                page_chunks = self._semantic_chunk_text(ocr_text)
                                for idx, chunk in enumerate(page_chunks):
                                    if chunk.strip():
                                        chunks.append(chunk.strip())
                                        metadatas.append({
                                            "source": file_path,
                                            "page": page_num,
                                            "type": "ocr_fallback",
                                            "locator": f"Page {page_num + 1} (OCR)",
                                            "chunk": idx + 1
                                        })
                                        ids.append(f"{prefix}_{basename}_p{page_num}_ocr_{idx}")
                                        pdf_chunks_created += 1
                            else:
                                logger.warning(
                                    f"RAG: Tesseract insufficient — falling back to Vision model…"
                                )
                                pdf_vision_prompt = (
                                    "This is a scanned page from a PDF document. "
                                    "It may be a filled form, certificate, or template. "
                                    "Please extract the content carefully, paying special attention "
                                    "to the difference between the original template text (e.g., "
                                    "placeholders, labels) and the actual filled-in values. "
                                    "Identify and structure key information: "
                                    "1. Clearly separate the template structure from the filled content. "
                                    "2. Prioritize extracting the filled-in values (e.g., names, dates, "
                                    "addresses, company names, signatures). "
                                    "3. If fields use different font sizes, handwriting, or colors, "
                                    "pay special attention to those areas as they are usually the filled values. "
                                    "4. Provide a structured summary focusing on what was actually entered "
                                    "into the document, followed by a detailed transcription."
                                )
                                description = vision_service.generate_image_description(
                                    temp_path, prompt=pdf_vision_prompt
                                )
                                if description and description.strip():
                                    chunks.append(description.strip())
                                    metadatas.append({
                                        "source": file_path,
                                        "page": page_num,
                                        "type": "vision_fallback",
                                        "locator": f"Page {page_num + 1} (Vision)",
                                        "chunk": 1
                                    })
                                    ids.append(f"{prefix}_{basename}_p{page_num}_vision")
                                    pdf_chunks_created += 1
                                    logger.info(
                                        f"RAG: Vision description generated for page {page_num} ({len(description)} chars)"
                                    )
                                else:
                                    logger.info(
                                        f"RAG: Vision model returned empty for page {page_num}"
                                    )
                        except Exception as ocr_err:
                            logger.error(
                                f"RAG: OCR/Vision fallback failed for page {page_num}: {ocr_err}"
                            )
                        finally:
                            if temp_path and os.path.exists(temp_path):
                                os.remove(temp_path)

                logger.info(
                    f"RAG: PDF processing complete — {pdf_chunks_created} chunk(s) created"
                )

            # ---------------------------------------------------------------- Images
            elif file_ext in [".png", ".jpg", ".jpeg"]:
                description = vision_service.generate_image_description(file_path)
                if description:
                    chunks.append(description)
                    metadatas.append({
                        "source": file_path,
                        "type": "image_description",
                        "locator": "Image"
                    })
                    ids.append(f"{prefix}_{basename}_desc")

            # ---------------------------------------------------------------- Plain text / Markdown
            elif file_ext in [".txt", ".md"]:
                with open(file_path, "r", encoding="utf-8-sig", errors="ignore") as f:
                    text = f.read()
                file_chunks = self._semantic_chunk_text(text)
                for idx, chunk in enumerate(file_chunks):
                    if chunk.strip():
                        chunks.append(chunk.strip())
                        metadatas.append({
                            "source": file_path,
                            "type": "text",
                            "chunk": idx + 1,
                            "locator": f"Chunk {idx + 1}"
                        })
                        ids.append(f"{prefix}_{basename}_c{idx}")

            # ---------------------------------------------------------------- HTML
            elif file_ext == ".html":
                with open(file_path, "r", encoding="utf-8-sig", errors="ignore") as f:
                    html_content = f.read()
                extractor = HTMLTextExtractor()
                extractor.feed(html_content)
                text = extractor.get_data()
                file_chunks = self._semantic_chunk_text(text)
                for idx, chunk in enumerate(file_chunks):
                    if chunk.strip():
                        chunks.append(chunk.strip())
                        metadatas.append({
                            "source": file_path,
                            "type": "html",
                            "chunk": idx + 1,
                            "locator": f"Chunk {idx + 1}"
                        })
                        ids.append(f"{prefix}_{basename}_c{idx}")

            # ---------------------------------------------------------------- DOCX
            elif file_ext == ".docx":
                try:
                    import docx

                    doc = docx.Document(file_path)
                    sections = []
                    current_heading = "General"
                    current_texts = []
                    for p in doc.paragraphs:
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
                    table_rows = []
                    for table in doc.tables:
                        for row in table.rows:
                            cells = []
                            for c in row.cells:
                                t = c.text.strip()
                                if t and (not cells or cells[-1] != t):
                                    cells.append(t)
                            if cells:
                                table_rows.append(" | ".join(cells) + ".")
                    if table_rows:
                        sections.append(("Tables", "\n".join(table_rows)))
                    if not sections:
                        full_text = "\n".join([p.text for p in doc.paragraphs if p.text.strip()])
                        sections = [("General", full_text)]

                    chunk_counter = 0
                    for sec_title, sec_text in sections:
                        sec_chunks = self._semantic_chunk_text(sec_text)
                        for c in sec_chunks:
                            if c.strip():
                                chunk_counter += 1
                                chunks.append(c.strip())
                                if sec_title and sec_title != "General":
                                    locator = f"Section: '{sec_title}' (chunk {chunk_counter})"
                                else:
                                    locator = f"Chunk {chunk_counter}"
                                metadatas.append({
                                    "source": file_path,
                                    "type": "docx",
                                    "section": sec_title if sec_title != "General" else "",
                                    "chunk": chunk_counter,
                                    "locator": locator
                                })
                                ids.append(f"{prefix}_{basename}_c{chunk_counter}")
                except Exception as docx_err:
                    logger.error(f"RAG: DOCX processing failed for {file_path}: {docx_err}")
                    raise

            # ---------------------------------------------------------------- CSV / JSON / XML / LOG (plain-text data)
            elif file_ext in [".csv", ".json", ".xml", ".log", ".markdown"]:
                with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
                    text = f.read()
                for idx, chunk in enumerate(self._chunk_structured_text(text, file_ext)):
                    if chunk.strip():
                        chunks.append(chunk.strip())
                        metadatas.append({
                            "source": file_path,
                            "type": file_ext.lstrip("."),
                            "chunk": idx + 1,
                            "locator": f"Chunk {idx + 1}"
                        })
                        ids.append(f"{prefix}_{basename}_c{idx}")

            # ---------------------------------------------------------------- XLSX
            elif file_ext == ".xlsx":
                import openpyxl

                wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
                try:
                    idx = 0
                    for sheet in wb.worksheets:
                        lines = []
                        for row in sheet.iter_rows(values_only=True):
                            cells = ["" if c is None else str(c) for c in row]
                            if any(c.strip() for c in cells):
                                lines.append(" | ".join(cells).rstrip(" |"))
                        if not lines:
                            continue
                        for chunk in self._chunk_rows(lines, f"Sheet: {sheet.title}"):
                            chunks.append(chunk)
                            metadatas.append({
                                "source": file_path,
                                "type": "xlsx",
                                "sheet": sheet.title,
                                "chunk": idx + 1,
                                "locator": f"Sheet '{sheet.title}' (chunk {idx + 1})"
                            })
                            ids.append(f"{prefix}_{basename}_c{idx}")
                            idx += 1
                finally:
                    wb.close()

        except Exception as e :
            logger.error (f"RAG: Error processing document {file_path }: {e }")
            raise 

        if not chunks :
            # never report "indexed" for a file that produced nothing searchable
            raise ValueError (f"No text content could be extracted from '{basename }'")
        return chunks ,metadatas ,ids 

    def _embed_and_store (self ,collection ,chunks ,metadatas ,ids ,label :str ):
        """Embed a list of chunks and upsert them into a ChromaDB collection."""
        if not chunks :
            logger.info (f"RAG: No chunks to store for {label }")
            return 
        embeddings =llm_service .generate_embeddings_batch (self .embedding_model ,chunks )
        try:
            collection.add(
                documents=chunks,
                embeddings=embeddings,
                metadatas=metadatas,
                ids=ids,
            )
        except Exception as add_err:
            if "dimension" in str(add_err).lower():
                logger.warning(
                    f"RAG: Dimension mismatch for collection '{collection.name}' ({add_err}). "
                    f"Recreating collection to match new embedding model dimensions..."
                )
                col_name = collection.name
                self.chroma_client.delete_collection(col_name)
                collection = self.chroma_client.get_or_create_collection(
                    name=col_name,
                    metadata={"hnsw:space": "cosine"}
                )
                collection.add(
                    documents=chunks,
                    embeddings=embeddings,
                    metadatas=metadatas,
                    ids=ids,
                )
            else:
                raise
        logger.info (
        f"RAG: Stored {len (chunks )} chunk(s) in '{collection .name }'. "
        f"Collection now has {collection .count ()} item(s)."
        )
        if embeddings :
            dim =len (embeddings [0 ])if isinstance (embeddings [0 ],(list ,tuple ))else "?"
            logger.info (f"RAG: Embedding dimension: {dim }")

            # ------------------------------------------------------------------
            # Public indexing methods
            # ------------------------------------------------------------------

    def add_document (self ,workspace_id :int ,user_id :int ,file_path :str ):
        """Index a file into a workspace-scoped ChromaDB collection."""
        collection =self .get_or_create_collection (workspace_id ,user_id )
        logger.info (f"RAG: Indexing '{file_path }' → collection '{collection .name }'")
        chunks ,metadatas ,ids =self ._process_file_to_chunks (file_path )
        self ._embed_and_store (collection ,chunks ,metadatas ,ids ,file_path )

    def add_kb_document (self ,user_id :int ,file_path :str ):
        """Index a file into the user's personal Knowledge Base collection."""
        collection =self .get_or_create_kb_collection (user_id )
        logger.info (f"RAG: Indexing '{file_path }' → KB collection '{collection .name }'")
        chunks ,metadatas ,ids =self ._process_file_to_chunks (file_path )
        self ._embed_and_store (collection ,chunks ,metadatas ,ids ,file_path )

        # ------------------------------------------------------------------
        # Internal query helpers
        # ------------------------------------------------------------------

    def _raw_query (
    self ,collection ,query_text :str ,n_candidates :int ,filters :Dict [str ,Any ]=None 
    )->List [Dict [str ,Any ]]:
        """Query a collection and return a flat list of {content, metadata, id} dicts."""
        count =collection .count ()
        if count ==0 :
            return []
        n =min (n_candidates ,count )
        embedding =llm_service .generate_embeddings (self .embedding_model ,query_text )
        where_filter =self ._build_where_filter (filters )
        query_kwargs ={"query_embeddings":[embedding ],"n_results":n }
        if where_filter :
            query_kwargs ["where"]=where_filter 
        try :
            results =collection .query (**query_kwargs )
        except Exception as query_err :
            logger.warning (f"RAG: Vector query on '{collection .name }' failed ({query_err }). Falling back to keyword search.")
            return []

        docs =results .get ("documents",[[]])[0 ]
        metas =results .get ("metadatas",[[]])[0 ]
        ids =results .get ("ids",[[]])[0 ]if "ids"in results and results ["ids"]else [None ]*len (docs )
        return [
        {
        "content":doc ,
        "metadata":metas [i ]if i <len (metas )else {},
        "id":ids [i ]if i <len (ids )else f"gen_{hashlib .md5 (doc .encode ()).hexdigest ()}"
        }
        for i ,doc in enumerate (docs )
        ]

    def _rerank_or_truncate (
    self ,candidates :List [Dict ],query_text :str ,n_results :int 
    )->List [Dict ]:
        """Re-rank candidates with FlashRank (if available), else truncate."""
        if not candidates :
            return []
        if self .ranker :
            passages =[]
            for i ,r in enumerate (candidates ):
                meta =r .get ("metadata",{})
                filename =source_display_name (meta )
                prefix =f"[Document: {filename}]\n"if filename else ""
                passages .append ({"id":str (i ),"text":prefix +r ["content"],"meta":meta })
            reranked =self .ranker .rerank (RerankRequest (query =query_text ,passages =passages ))
            # The bundled cross-encoder is English-only; on German text its order is close to noise and used to
            # replace the hybrid (vector + keyword) order completely. Fuse both orders (RRF) instead, and never
            # drop the hybrid's best candidate or the vector search's nearest neighbour.
            k =60 
            rerank_pos ={int (r ["id"]):pos for pos ,r in enumerate (reranked )}
            order =sorted (
            range (len (candidates )),
            key =lambda i :-(1.0 /(k +i +1 )+1.0 /(k +rerank_pos .get (i ,len (candidates ))+1 )),
            )
            top =order [:n_results ]
            protected =[i for i ,c in enumerate (candidates )if i ==0 or c .get ("_vector_top")]
            for i in protected :
                if i not in top and top :
                    for j in range (len (top )-1 ,-1 ,-1 ):
                        if top [j ]not in protected :
                            top [j ]=i 
                            break 
            return [candidates [i ]for i in top ]
        return candidates [:n_results ]

        # ------------------------------------------------------------------
        # Public query methods
        # ------------------------------------------------------------------

    def query (self ,workspace_id :int ,user_id :int ,query_text :str ,n_results :int =3 ,filters :Dict [str ,Any ]=None )->List [Dict [str ,Any ]]:
        """Query the workspace collection (legacy — used when KB toggle is OFF)."""
        try :
            collection =self .get_or_create_collection (workspace_id ,user_id )
            logger.info (
            f"RAG: Querying workspace collection '{collection .name }' "
            f"({collection .count ()} item(s))"
            )
            if getattr (settings ,"RAG_HYBRID_SEARCH",True ):
                candidates =self ._hybrid_query (collection ,query_text ,max (n_results *5 ,15 ),filters )
            else :
                candidates =self ._raw_query (collection ,query_text ,max (n_results *5 ,15 ),filters )
            results =self ._rerank_or_truncate (candidates ,query_text ,n_results )
            logger.info (f"RAG: Returning {len (results )} result(s)")
            return results 
        except Exception as e :
            logger.error (f"RAG: Error querying workspace {workspace_id }: {e }")
            return []

    def query_kb (self ,user_id :int ,query_text :str ,n_results :int =3 ,filters :Dict [str ,Any ]=None )->List [Dict [str ,Any ]]:
        """Query only the user's personal Knowledge Base collection."""
        try :
            collection =self .get_or_create_kb_collection (user_id )
            logger.info (
            f"RAG: Querying KB collection '{collection .name }' "
            f"({collection .count ()} item(s))"
            )
            if getattr (settings ,"RAG_HYBRID_SEARCH",True ):
                candidates =self ._hybrid_query (collection ,query_text ,max (n_results *5 ,15 ),filters )
            else :
                candidates =self ._raw_query (collection ,query_text ,max (n_results *5 ,15 ),filters )
            results =self ._rerank_or_truncate (candidates ,query_text ,n_results )
            logger.info (f"RAG: KB returning {len (results )} result(s)")
            return results 
        except Exception as e :
            logger.error (f"RAG: Error querying KB for user {user_id }: {e }")
            return []

    def query_merged (
    self ,
    workspace_id :int ,
    user_id :int ,
    query_text :str ,
    use_kb :bool ,
    n_results :int =5 ,
    filters :Dict [str ,Any ]=None ,
    preferred_sources :list =None ,
    use_hybrid_search :Optional [bool ]=None ,
    use_query_rewriting :Optional [bool ]=None ,
    use_context_compression :Optional [bool ]=None ,
    )->Tuple [List [Dict ],List [Dict ]]:
        """
        Query workspace + (optionally) KB collections with Query Rewriting,
        Hybrid Search (vector + keyword), deduplication, FlashRank re-ranking,
        Context Compression, and truncation.
        """
        use_rewrite =use_query_rewriting if use_query_rewriting is not None else getattr (settings ,"RAG_QUERY_REWRITING",True )
        queries =self .rewrite_query (query_text )if use_rewrite else [query_text ]
        n_candidates =max (n_results *4 ,15 )
        use_hybrid =use_hybrid_search if use_hybrid_search is not None else getattr (settings ,"RAG_HYBRID_SEARCH",True )

        # Split filters: folder_id only makes sense on KB, not workspace
        kb_filters =filters .copy ()if filters else {}
        ws_filters ={k :v for k ,v in filters .items ()if k !="folder_id"}if filters else {}

        ws_candidates =[]
        kb_candidates =[]

        # 1. Retrieve candidates for all queries
        for q in queries :
        # ---- Workspace collection search
            try :
                ws_collection =self .get_or_create_collection (workspace_id ,user_id )
                q_ws =self ._hybrid_query (ws_collection ,q ,n_candidates ,ws_filters, preferred_sources )if use_hybrid else self ._raw_query (ws_collection ,q ,n_candidates ,ws_filters )
                for r in q_ws :
                    r .setdefault ("metadata",{})["_collection_type"]="workspace"
                ws_candidates .extend (q_ws )
            except Exception as e :
                logger.error (f"RAG: Workspace query failed for '{q }': {e }")

                # ---- KB collection search (if enabled)
            if use_kb :
                try :
                    kb_collection =self .get_or_create_kb_collection (user_id )
                    q_kb =self ._hybrid_query (kb_collection ,q ,n_candidates ,kb_filters, preferred_sources )if use_hybrid else self ._raw_query (kb_collection ,q ,n_candidates ,kb_filters )
                    for r in q_kb :
                        r .setdefault ("metadata",{})["_collection_type"]="knowledge_base"
                    kb_candidates .extend (q_kb )
                except Exception as e :
                    logger.error (f"RAG: KB query failed for '{q }': {e }")

                    # 2. Deduplicate candidate pools separately
        def deduplicate (candidates ):
            seen_ids =set ()
            deduped =[]
            for c in candidates :
                cid =c .get ("id")or hashlib .md5 (c ["content"].encode ()).hexdigest ()
                if cid not in seen_ids :
                    seen_ids .add (cid )
                    deduped .append (c )
            return deduped 

        ws_candidates =deduplicate (ws_candidates )
        kb_candidates =deduplicate (kb_candidates )

        # 3. Re-rank workspace and Knowledge Base pools separately to prevent dilution
        ws_results =self ._rerank_or_truncate (ws_candidates ,query_text ,n_results )
        kb_results =self ._rerank_or_truncate (kb_candidates ,query_text ,n_results )

        # 4. Context compression — remove redundant sentences across chunks
        use_compression =use_context_compression if use_context_compression is not None else getattr (settings ,"RAG_CONTEXT_COMPRESSION",True )
        if use_compression :
            ws_results =self ._compress_context (ws_results )
            kb_results =self ._compress_context (kb_results )

            # 5. Apply context truncation to protect LLM context windows
        max_chars =getattr (settings ,"RAG_MAX_CONTEXT_CHARS",8000 )
        ws_results =self ._truncate_context (ws_results ,max_chars //2 )
        kb_results =self ._truncate_context (kb_results ,max_chars //2 )

        logger.info (
        f"RAG [retrieval]: hybrid={use_hybrid } | rewrite={use_rewrite } | compression={use_compression } | "
        f"ws_results={len (ws_results )} ws_cands={len (ws_candidates )} | "
        f"kb_results={len (kb_results )} kb_cands={len (kb_candidates )}"
        )
        return ws_results ,kb_results 

    def _chunk_text_recursive (self ,text :str ,chunk_size :int =None ,overlap :int =None )->List [str ]:
        """
        Splits text recursively on common separators (paragraphs, sentences, words)
        to respect semantic boundaries without hitting the LLM model.
        """
        c_size =chunk_size or getattr (settings ,"RAG_CHUNK_SIZE",700 )
        c_overlap =overlap if overlap is not None else getattr (settings ,"RAG_CHUNK_OVERLAP",100 )

        separators =["\n\n","\n",". ","? ","! "," ",""]

        def split_recursive (text_to_split :str ,current_seps :list )->List [str ]:
            if len (text_to_split )<=c_size :
                return [text_to_split ]
            if not current_seps :
                return [text_to_split [i :i +c_size ]for i in range (0 ,len (text_to_split ),c_size )]

            sep =current_seps [0 ]
            remaining_seps =current_seps [1 :]

            if sep =="":
                splits =list (text_to_split )
            else :
                splits =text_to_split .split (sep )
                if sep in [". ","? ","! "]:
                    splits =[s +sep .strip ()for s in splits [:-1 ]if s ]+([splits [-1 ]]if splits [-1 ]else [])

            chunks =[]
            current_buffer =[]
            current_len =0 

            for s in splits :
                if not s or not s .strip ():
                    continue 
                if len (s )>c_size :
                    if current_buffer :
                        chunks .append (sep .join (current_buffer ))
                        current_buffer =[]
                        current_len =0 
                    chunks .extend (split_recursive (s ,remaining_seps ))
                elif current_len +len (s )+(len (sep )if current_buffer else 0 )<=c_size :
                    current_buffer .append (s )
                    current_len +=len (s )+(len (sep )if len (current_buffer )>1 else 0 )
                else :
                    if current_buffer :
                        chunks .append (sep .join (current_buffer ))
                        # Handle overlapping
                    if c_overlap >0 and len (current_buffer )>0 :
                        overlap_str =sep .join (current_buffer )[-c_overlap :]
                        current_buffer =[overlap_str ,s ]
                        current_len =len (overlap_str )+len (s )+len (sep )
                    else :
                        current_buffer =[s ]
                        current_len =len (s )

            if current_buffer :
                chunks .append (sep .join (current_buffer ))

            return chunks 

        result =split_recursive (text .strip (),separators )
        logger.info (f"RAG [recursive-chunker]: {len (result )} chunk(s) from {len (text )} chars")
        return result 

    def _chunk_rows (self ,rows :List [str ],header :str ="",max_chars :int =None )->List [str ]:
        """Pack line-oriented data (CSV rows, spreadsheet rows, log lines) into chunks of at most
        `max_chars`; every chunk repeats `header` so a row keeps its column context."""
        limit =max_chars or getattr (settings ,"RAG_CHUNK_SIZE",700 )
        head =(header +"\n")if header else ""
        out ,cur =[],[]
        cur_len =len (head )
        for row in rows :
            row =row [:limit -len (head )]if len (row )>limit -len (head )else row 
            if cur and cur_len +len (row )+1 >limit :
                out .append (head +"\n".join (cur ))
                cur ,cur_len =[],len (head )
            cur .append (row )
            cur_len +=len (row )+1 
        if cur :
            out .append (head +"\n".join (cur ))
        return out 

    def _chunk_structured_text (self ,text :str ,ext :str )->List [str ]:
        """CSV / JSON / XML / LOG / Markdown: line-aware chunking that always respects the chunk size."""
        if not text or not text .strip ():
            return []
        if ext ==".json":
            try :
                import json 

                text =json .dumps (json .loads (text ),ensure_ascii =False ,indent =1 )
            except Exception :
                pass 
        lines =[l for l in text .splitlines ()if l .strip ()]
        if ext ==".csv"and lines :
            return self ._chunk_rows (lines [1 :]or lines ,"Columns: "+lines [0 ][:300 ])
        if ext ==".markdown":
            return self ._semantic_chunk_text (text )
        return self ._chunk_rows (lines )

    def _semantic_chunk_text (self ,text :str )->List [str ]:
        """
        Splits text based on sentence semantic similarity using nomic-embed-text.
        Falls back to _chunk_text_recursive if the strategy is not 'semantic'
        or if embedding generation fails.
        """
        strategy =getattr (settings ,"RAG_CHUNKING_STRATEGY","semantic").lower ()
        chunk_size =getattr (settings ,"RAG_CHUNK_SIZE",700 )

        if strategy !="semantic"or not text or not text .strip ():
            return self ._chunk_text_recursive (text )if text and text .strip ()else []

            # 1. Split into sentences (keeping end marks)
        raw_sentences =re .split (r'(?<=[.?!])\s+',text .strip ())
        sentences =[]
        for raw in raw_sentences :
            raw =raw .strip ()
            if not raw :
                continue 
            if len (raw )>chunk_size :
                # Text without sentence punctuation (logs, tables, code, lists) is one huge "sentence":
                # split it by lines/words first so it never becomes a single giant chunk.
                sentences .extend (part .strip ()for part in self ._chunk_text_recursive (raw ,chunk_size =chunk_size ,overlap =0 )if part .strip ())
            else :
                sentences .append (raw )

        if len (sentences )<=1 :
            logger.info (f"RAG [semantic-chunker]: only {len (sentences )} sentence(s) — returning as-is")
            return sentences 

        try :
        # 2. Batch generate embeddings for each sentence
            logger.info (f"RAG [semantic-chunker]: embedding {len (sentences )} sentence(s) via '{self .embedding_model }'")
            embeddings =llm_service .generate_embeddings_batch (self .embedding_model ,sentences )
            if not embeddings or len (embeddings )!=len (sentences ):
                logger.warning ("RAG Warning: Sentence embedding length mismatch. Falling back to recursive chunking.")
                return self ._chunk_text_recursive (text )
        except Exception as embed_err :
            logger.error (f"RAG Warning: Embeddings failed: {embed_err }. Falling back to recursive chunking.")
            return self ._chunk_text_recursive (text )

            # 3. Calculate similarities between adjacent sentences
        def cosine_similarity (v1 ,v2 ):
            dot_product =sum (a *b for a ,b in zip (v1 ,v2 ))
            mag1 =sum (a *a for a in v1 )**0.5 
            mag2 =sum (b *b for b in v2 )**0.5 
            if not mag1 or not mag2 :
                return 0.0 
            return dot_product /(mag1 *mag2 )

        similarities =[]
        for i in range (len (embeddings )-1 ):
            similarities .append (cosine_similarity (embeddings [i ],embeddings [i +1 ]))

            # 4. Cluster sentences
        threshold =getattr (settings ,"RAG_SEMANTIC_THRESHOLD",0.45 )
        min_chunk_len =150 # Prevent too small chunks unless necessary
        logger.info (f"RAG [semantic-chunker]: similarity threshold={threshold }, max_chunk_size={chunk_size }")
        # Log adjacency similarities for debugging
        for i ,sim in enumerate (similarities ):
            logger.debug (f"  sim[{i }→{i +1 }]={sim :.4f}  {'<SPLIT>'if sim <threshold else ''}")

        chunks =[]
        current_chunk_sentences =[sentences [0 ]]
        current_chunk_len =len (sentences [0 ])

        for i in range (len (sentences )-1 ):
            next_sentence =sentences [i +1 ]
            similarity =similarities [i ]

            should_split =False 
            # Split if similarity drops below threshold (meaning different topic)
            if similarity <threshold and current_chunk_len >=min_chunk_len :
                should_split =True 
                # Split if adding next sentence exceeds maximum configured chunk size
            if current_chunk_len +len (next_sentence )>chunk_size :
                should_split =True 

            if should_split :
                chunks .append (" ".join (current_chunk_sentences ))
                current_chunk_sentences =[next_sentence ]
                current_chunk_len =len (next_sentence )
            else :
                current_chunk_sentences .append (next_sentence )
                current_chunk_len +=len (next_sentence )+1 

        if current_chunk_sentences :
            chunks .append (" ".join (current_chunk_sentences ))

        logger.info (f"RAG [semantic-chunker]: produced {len (chunks )} chunk(s) from {len (sentences )} sentence(s)")
        return chunks 

    def rewrite_query (self ,query :str )->List [str ]:
        """
        Rewrite/expand the user query into 1-2 more specific or expanded search queries.
        """
        if not getattr (settings ,"RAG_QUERY_REWRITING",True )or not query or not query .strip ():
            return [query ]

        prompt =(
        "You are a search query optimizer for a vector database retrieval system. "
        "Given the user's input search query, generate exactly 1 or 2 alternative, more specific, "
        "or expanded versions of this query. "
        "The rewritten queries should focus on key concepts, synonyms, and specific search terms that "
        "might appear in documents. "
        "Ensure that you ONLY output the rewritten queries, one per line. Do not include any numbering, "
        "prefixes, explanations, or metadata. Just output the raw rewritten queries.\n\n"
        f"User Query: {query }"
        )

        try :
            model =settings .DEFAULT_TEXT_MODEL 
            messages =[{"role":"user","content":prompt }]
            response =llm_service .generate_chat (model ,messages ,stream =False )
            content =response .get ("message",{}).get ("content","").strip ()

            rewritten_queries =[]
            if content :
                lines =content .split ("\n")
                for line in lines :
                    line =line .strip ()
                    # Strip lists like "1. ", "- "
                    line =re .sub (r'^\d+\.\s*','',line )
                    line =re .sub (r'^[-*]\s*','',line )
                    line =line .strip ()
                    if line and line .lower ()!=query .lower ():
                        rewritten_queries .append (line )

                        # Deduplicate, keep original first, limit rewritten to max 2 queries
            final_queries =[query ]
            for rq in rewritten_queries [:2 ]:
                if rq not in final_queries :
                    final_queries .append (rq )

            logger.info (f"RAG [query-rewriting]: Expanded '{query }' → {final_queries }")
            return final_queries 
        except Exception as e :
            logger.error (f"RAG [query-rewriting] Warning: Failed to rewrite query: {e }. Using original.")
            return [query ]

    def _truncate_context (self ,context_list :List [Dict ],max_chars :int =4000 )->List [Dict ]:
        """
        Truncates the retrieved list of candidates to stay within the character limit.
        """
        truncated =[]
        current_chars =0 
        for item in context_list :
            content =item .get ("content","")
            if current_chars +len (content )<=max_chars :
                truncated .append (item )
                current_chars +=len (content )
            else :
                remaining =max_chars -current_chars 
                if remaining >50 :
                    item_copy =item .copy ()
                    item_copy ["content"]=content [:remaining -3 ]+"..."
                    truncated .append (item_copy )
                break 
        return truncated 

        # ------------------------------------------------------------------
        # Advanced RAG Helpers
        # ------------------------------------------------------------------

    def _build_where_filter (self ,filters :Dict [str ,Any ])->Dict [str ,Any ]:
        """Build a ChromaDB structured where filter from a flat dict. Supports list values for $in."""
        if not filters :
            return None 
        valid ={k :v for k ,v in filters .items ()if v is not None }
        if not valid :
            return None 
            
        def _make_field_filter (k ,v ):
            if isinstance (v ,dict )and v and all (str (op ).startswith ("$")for op in v ):
                return {k :v }# already a Chroma operator expression, e.g. {"$in": [1, 2]}
            if isinstance (v ,list ):
                return {k :{"$in":v }}
            return {k :{"$eq":v }}
            
        if len (valid )==1 :
            k ,v =next (iter (valid .items ()))
            return _make_field_filter (k ,v )
        return {"$and":[_make_field_filter (k ,v )for k ,v in valid .items ()]}

    def _keyword_query (
    self ,collection ,query_text :str ,n_candidates :int ,filters :Dict [str ,Any ]=None 
    )->List [Dict [str ,Any ]]:
        """
        Retrieve all documents from a collection (applying optional filters) and
        rank them by TF-IDF relevance against stop-word filtered query terms.
        """
        # Score every chunk, not just the first few: a rare token (an error code, a part number, a counter)
        # can sit in any chunk of a long document. Read the collection page by page up to a safety cap.
        docs ,metas ,ids =[],[],[]
        try :
            where_filter =self ._build_where_filter (filters )
            scan_cap =getattr (settings ,"RAG_KEYWORD_SCAN_LIMIT",20000 )
            page_size =1000 
            while len (docs )<scan_cap :
                get_kwargs ={"include":["documents","metadatas"],"limit":min (page_size ,scan_cap -len (docs )),"offset":len (docs )}
                if where_filter :
                    get_kwargs ["where"]=where_filter 
                page =collection .get (**get_kwargs )
                page_docs =page .get ("documents",[])or []
                if not page_docs :
                    break 
                docs .extend (page_docs )
                metas .extend (page .get ("metadatas",[])or [])
                ids .extend (page .get ("ids",[])or [])
                if len (page_docs )<get_kwargs ["limit"]:
                    break 
            else :
                logger .warning (f"RAG [keyword-query]: scan cap of {scan_cap } chunks reached; later chunks were not scored lexically")
        except Exception as e :
            logger.error (f"RAG [keyword-query]: ChromaDB get failed: {e }")
            return []

        N =len (docs )
        if N ==0 :
            return []

            # Tokenize query, filter stop words
        raw_words =re .findall (r'\b\w+\b',_fold (query_text ))
        query_terms =[w for w in raw_words if len (w )>1 and w not in ENGLISH_STOP_WORDS and w not in GERMAN_STOP_WORDS ]
        if not query_terms :
        # Safeguard fallback: if all query terms are stop words, retain them
            query_terms =[w for w in raw_words if len (w )>1 ]

        if not query_terms :
        # Fallback to returning sequential elements if no terms can be analyzed
            return [
            {
            "content":docs [i ],
            "metadata":metas [i ]if i <len (metas )else {},
            "id":ids [i ]if i <len (ids )else f"gen_{hashlib .md5 (docs [i ].encode ()).hexdigest ()}"
            }
            for i in range (min (n_candidates ,N ))
            ]

            # Tokenize document texts — also include filename tokens from metadata
            # so that queries mentioning a filename (e.g. "book4page") score the
            # correct file's chunks without polluting stored chunk text.
        doc_words =[]
        for doc_idx ,doc in enumerate (docs ):
            words =re .findall (r'\b\w+\b',_fold (doc ))
            # Append filename-derived tokens from metadata
            meta =metas [doc_idx ]if doc_idx <len (metas )else {}
            for raw_name in (source_display_name (meta ),):
                if raw_name :
                    filename =os .path .basename (raw_name )
                    basename ,ext =os .path .splitext (filename )
                    name_tokens =re .findall (r'\b\w+\b',_fold (basename ))
                    if ext :
                        name_tokens .append (ext .replace (".","").lower ())
                    # Also index the raw filename and full lowercased name
                    name_tokens .append (_fold (filename ))
                    words =words +name_tokens
                    break # one source is enough
            doc_words .append (words )

            # Term counts per chunk (one pass over the tokens instead of one list scan per query term)
        doc_counts =[Counter (words )for words in doc_words ]

            # Document frequency count
        df ={}
        for term in query_terms :
            df [term ]=sum (1 for counts in doc_counts if term in counts )

            # Calculate IDF values
        idf ={}
        for term in query_terms :
            doc_freq =df [term ]
            idf [term ]=math .log (N /doc_freq )+1.0 if doc_freq >0 else 0.0 

            # Score candidates
        scored =[]
        for i ,words in enumerate (doc_words ):
            if not words :
                continue 

            score =0.0 
            counts =doc_counts [i ]
            for term in query_terms :
                term_count =counts .get (term ,0 )
                if term_count >0 :
                    tf =term_count /len (words )
                    score +=tf *idf [term ]

            if score >0.0 :
                scored .append ((score ,i ))

        scored .sort (reverse =True ,key =lambda x :x [0 ])
        return [
        {
        "content":docs [idx ],
        "metadata":metas [idx ]if idx <len (metas )else {},
        "id":ids [idx ]if idx <len (ids )else f"gen_{hashlib .md5 (docs [idx ].encode ()).hexdigest ()}",
        "keyword_score":score ,
        }
        for score ,idx in scored [:n_candidates ]
        ]

    def _hybrid_query (
    self ,collection ,query_text :str ,n_candidates :int ,filters :Dict [str ,Any ]=None, preferred_sources :list =None 
    )->List [Dict [str ,Any ]]:
        """
        Reciprocal Rank Fusion (RRF) of vector similarity and keyword overlap results.
        Falls back to vector-only if keyword retrieval returns nothing.
        """
        k =60 # RRF constant
        vector_cands =self ._raw_query (collection ,query_text ,n_candidates *2 ,filters )
        keyword_cands =self ._keyword_query (collection ,query_text ,n_candidates *2 ,filters )

        if not vector_cands :
            return keyword_cands [:n_candidates ]
        if not keyword_cands :
            return vector_cands [:n_candidates ]

            # Assign RRF scores
        rrf_scores :Dict [str ,float ]={}
        all_by_id :Dict [str ,Dict ]={}

        for rank ,cand in enumerate (vector_cands ):
            cid =cand .get ("id")or hashlib .md5 (cand ["content"].encode ()).hexdigest ()
            rrf_scores [cid ]=rrf_scores .get (cid ,0.0 )+1.0 /(k +rank +1 )
            all_by_id [cid ]=cand 
            if rank ==0 :
                cand ["_vector_top"]=True # the reranker must not drop the nearest neighbour

        for rank ,cand in enumerate (keyword_cands ):
            cid =cand .get ("id")or hashlib .md5 (cand ["content"].encode ()).hexdigest ()
            rrf_scores [cid ]=rrf_scores .get (cid ,0.0 )+1.0 /(k +rank +1 )
            all_by_id .setdefault (cid ,cand )

        # Boost candidates whose filename is explicitly mentioned in the query
        for cid ,cand in all_by_id .items ():
            meta =cand .get ("metadata",{})
            source =meta .get ("source")or meta .get ("file_path")or ""
            
            # 1. Boost via explicit preferred_sources list (highest priority)
            if preferred_sources and source in preferred_sources:
                rrf_scores [cid ]=rrf_scores .get (cid ,0.0 )+50.0 
            
            # 2. Fallback heuristic string match boost
            filename =source_display_name (meta )
            if filename :
                query_lower =query_text .lower ()
                file_lower =filename .lower ()
                import re
                def norm(n): return re.sub(r'[^a-z0-9]', '', n)
                norm_file = norm(os.path.splitext(file_lower)[0])
                if norm_file and len(norm_file) >= 3 and norm_file in norm(query_lower):
                    rrf_scores [cid ]=rrf_scores .get (cid ,0.0 )+10.0 

        sorted_cids =sorted (rrf_scores ,key =lambda x :rrf_scores [x ],reverse =True )
        results =[all_by_id [cid ]for cid in sorted_cids [:n_candidates ]]

        logger.info (
        f"RAG [hybrid-query]: vector={len (vector_cands )}, keyword={len (keyword_cands )}, "
        f"fused={len (results )} (RRF k={k })"
        )
        return results 

    def _compress_context (self ,context_list :List [Dict ])->List [Dict ]:
        """
        Remove duplicate sentences across all retrieved chunks.
        Preserves chunk order and metadata; only prunes redundant text.
        """
        compressed =[]
        seen_sentences :set =set ()

        for item in context_list :
            content =item .get ("content","")
            sentences =re .split (r'(?<=[.?!])\s+',content )
            unique =[]
            for s in sentences :
                s_strip =s .strip ()
                if not s_strip :
                    continue 
                    # Normalise: lowercase + alphanumeric only for dedup key
                s_key ="".join (c for c in s_strip .lower ()if c .isalnum ())
                if s_key not in seen_sentences :
                    seen_sentences .add (s_key )
                    unique .append (s_strip )

            if unique :
                item_copy =item .copy ()
                item_copy ["content"]=" ".join (unique )
                compressed .append (item_copy )

        return compressed 


rag_service =RAGService ()
