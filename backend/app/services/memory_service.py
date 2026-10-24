import logging
import chromadb
import uuid
import json
from app.core.config import settings
from app.services.llm_service import llm_service

logger = logging.getLogger(__name__)

class MemoryService:
    def __init__(self):
        self.chroma_client = chromadb.PersistentClient(
            path=settings.CHROMA_PERSIST_DIRECTORY,
            settings=chromadb.config.Settings(anonymized_telemetry=False),
        )
        self.memory_collection = self.chroma_client.get_or_create_collection(name="long_term_memory")
        self.embedding_model = settings.DEFAULT_EMBEDDING_MODEL
        self.summarize_model = settings.DEFAULT_TEXT_MODEL
        
    def summarize_and_store_conversation(self, chat_history: str, workspace_id: int):
        """
        Background task to summarize a conversation and extract facts.
        Uses semantic deduplication to avoid storing redundant facts.
        """
        prompt = f"""
Extract the most important personal facts, preferences, decisions, and long-term context from the following conversation.
Rules:
1. Extract ONLY explicit preferences, personal details (name, location, role), and major project context.
2. DO NOT extract temporary tasks, general greetings, or trivial details.
3. Format each fact as a standalone, clear sentence.

You MUST output ONLY a valid JSON array of objects, where each object has a "fact" key.
If nothing is worth remembering, output an empty JSON array: []

Example Output:
[
  {{"fact": "User prefers Python over JavaScript"}},
  {{"fact": "User is building an AI assistant named StarkLLM"}},
  {{"fact": "User lives in Berlin"}}
]

Conversation:
{chat_history}
"""
        
        messages = [{"role": "user", "content": prompt}]
        try:
            options = {"temperature": 0.1}
            response = llm_service.generate_chat(self.summarize_model, messages, stream=False, options=options)
            content = response.get("message", {}).get("content", "").strip()
            
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

            if not content:
                return

            try:
                fact_objects = json.loads(content)
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse memory JSON: {content}")
                return

            if not isinstance(fact_objects, list) or len(fact_objects) == 0:
                return

            valid_facts = []
            for obj in fact_objects:
                if isinstance(obj, dict) and "fact" in obj:
                    fact_str = str(obj["fact"]).strip()
                    if len(fact_str) > 3 and fact_str.upper() != "NONE":
                        valid_facts.append(fact_str)
            
            if not valid_facts:
                return

            # Batch encode all valid facts
            embeddings = llm_service.generate_embeddings_batch(self.embedding_model, valid_facts)

            # Query existing memories for deduplication
            results = self.memory_collection.query(
                query_embeddings=embeddings,
                n_results=1,
                where={"workspace_id": workspace_id}
            )

            added_count = 0
            for i, fact in enumerate(valid_facts):
                is_duplicate = False
                
                # Check distances
                if results and "distances" in results and len(results["distances"]) > i:
                    fact_distances = results["distances"][i]
                    if fact_distances and len(fact_distances) > 0:
                        closest_distance = fact_distances[0]
                        # Threshold for L2 distance with typical normalized embeddings (like Nomic). 
                        # Anything < 0.35 is highly semantically similar.
                        if closest_distance < 0.35:
                            is_duplicate = True
                            logger.info(f"Skipping duplicate fact: '{fact}' (distance: {closest_distance:.3f})")

                if not is_duplicate:
                    mem_id = str(uuid.uuid4())
                    self.memory_collection.add(
                        documents=[fact],
                        embeddings=[embeddings[i]],
                        metadatas=[{"workspace_id": workspace_id, "timestamp": str(uuid.uuid1())}],
                        ids=[mem_id]
                    )
                    added_count += 1

            logger.info(f"Extracted {len(valid_facts)} facts. Added {added_count} new memories for workspace {workspace_id}")
        except Exception as e:
            logger.error(f"Failed to summarize/store memory context: {e}", exc_info=True)
            
    def add_memory(self, workspace_id: int, content: str):
        """Add a single manual memory."""
        mem_id = str(uuid.uuid4())
        embedding = llm_service.generate_embeddings(self.embedding_model, content)
        self.memory_collection.add(
            documents=[content],
            embeddings=[embedding],
            metadatas=[{"workspace_id": workspace_id, "timestamp": str(uuid.uuid1())}],
            ids=[mem_id]
        )
        return {"id": mem_id, "content": content}

    def get_memories(self, workspace_id: int):
        """Retrieve all memories for a specific workspace."""
        results = self.memory_collection.get(
            where={"workspace_id": workspace_id}
        )
        
        memories = []
        if results and results.get("ids"):
            for i in range(len(results["ids"])):
                memories.append({
                    "id": results["ids"][i],
                    "content": results["documents"][i]
                })
        return memories

    def delete_memory(self, workspace_id: int, memory_id: str) -> bool:
        """Delete a specific memory by ID, only if it belongs to the given workspace."""
        found = self.memory_collection.get(ids=[memory_id])
        metas = (found or {}).get("metadatas") or []
        if not metas or (metas[0] or {}).get("workspace_id") != workspace_id:
            return False
        # ChromaDB does not allow `ids` + `where` together — delete by ID only (ownership checked above)
        self.memory_collection.delete(ids=[memory_id])
        return True

    def clear_memories(self, workspace_id: int):
        """Clear all memories for a workspace."""
        self.memory_collection.delete(
            where={"workspace_id": workspace_id}
        )

    def retrieve_memory_context(self, query: str, workspace_id: int) -> str:
        """
        Retrieve relevant long-term memory context based on the current user query.
        """
        if self.memory_collection.count() == 0:
            return ""
        
        try:
            # Count only memories for this workspace to avoid n_results > actual count crash
            ws_count = len(self.memory_collection.get(
                where={"workspace_id": workspace_id},
                include=[]  # fetch only IDs for a lightweight count
            ).get("ids", []))

            if ws_count == 0:
                return ""

            n_results = min(5, ws_count)
            query_embedding = llm_service.generate_embeddings(self.embedding_model, query)
            results = self.memory_collection.query(
                query_embeddings=[query_embedding],
                n_results=n_results,
                where={"workspace_id": workspace_id}
            )
            
            if results['documents'] and results['documents'][0]:
                docs = results['documents'][0]
                formatted = "\n".join([f"- {doc}" for doc in docs])
                return formatted
        except Exception as e:
            logger.error(f"Error querying memory collection: {e}")
            
        return ""

memory_service = MemoryService()
