
import logging
logging.basicConfig(level=logging.INFO)
from app.services.memory_service import memory_service

def test_memory():
    ws_id = 999
    memory_service.clear_memories(ws_id)
    print("\n--- TEST 1 ---")
    conv1 = "User: My name is Alice, I live in Berlin, and I prefer Python for backend."
    memory_service.summarize_and_store_conversation(conv1, ws_id)
    print("Memories:", [m["content"] for m in memory_service.get_memories(ws_id)])

    print("\n--- TEST 2 ---")
    conv2 = "User: I am Alice, based in Berlin. I really like Python. Also, I am 30 years old."
    memory_service.summarize_and_store_conversation(conv2, ws_id)
    print("Memories:", [m["content"] for m in memory_service.get_memories(ws_id)])

if __name__ == "__main__":
    test_memory()

