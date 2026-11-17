# Baseline: StarkLLM 2.2.1 on the MSI (17 Nov 2026)

Before any phase 2 change. Engine without Docker, chat model **qwen3.8:27b** (the app's choice on this PC, fully in
the graphics card's memory), questions pre-registered in `questions.json` (predicted 11.0 of 21).

| | result |
|---|---|
| all | **10 of 21** |
| specific questions | 7 of 12 |
| whole-book questions | 3 of 9 |
| "not in the book" | 3 of 3 (no invented answer) |
| citations on the right page | 4 of 9 |
| median answer time | 9.9 s |
| indexing | Alice 39 s, Effi Briest ~168 s, Moby-Dick ~418 s |

Per question: M1 M2 M4 M5 M6 M9 A4 A5 E1 E7 passed; M3 M7 M8 A1 A2 A3 E2 E3 E4 E5 E6 failed.

What the failures show: almost all are **retrieval misses with an honest "not found"**. Each answer sees five passages,
and for whole-book questions ("summarize the book", "how does it end?") five passages from the middle of the book are
not enough: the model says so (M7, M8, E6). Some specific facts are missed too, because the five passages come from
the wrong part of the book (A1 "DRINK ME", A2 "hookah", E3 the dog Rollo). One answer is wrong (E2: "Greifenhagen"
instead of Kessin). No invented answers to the trap questions.

Found on the way: a reused connection was reset while polling (the engine closes idle connections after 5 s; run.py
now retries and polls every 3 s), and the engine logged "LLM Batch Embeddings API Error: 400 ... /api/embed" twice
before falling back to embedding one passage at a time (nothing lost, but slower).
