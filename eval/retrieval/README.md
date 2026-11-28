# Retrieval evaluation (StarkLLM 2.7: reranker and "no good source")

Measures whether the passages that go to an answer come from the right page, before and after the optional
multilingual reranker (`backend/app/services/reranker.py`), and whether "no good source"
(`backend/app/services/source_quality.py`) fires on questions the documents cannot answer, without firing on ones
they can.

- `corpus.py`: one folder PDF per language (de, en, fr, es, it, tr). Page 1 is the language's test letter
  (`backend/tests/fixtures/letters`); pages 2-6 are a tenancy agreement, a car insurance policy, a cardiology
  appointment, an internet contract and a payslip, written so that they share vocabulary (amounts, dates, "monthly",
  "notice"). All six folders and the other fixtures (`tests/fixtures/msi`, the US invoice) go into one workspace: 47
  passages, letters of the other languages compete too. 48 questions with their page (8 per language, paraphrased:
  "Can I have breakfast before my heart test?") and 12 without an answer (a passport; household insurance next to the
  car insurance).
- `run.py`: indexes with the engine's own pipeline and local embeddings (nomic-embed-text), asks every question
  through `RAGService.query_merged` (the chat's call, 5 passages) per variant, scores hit@1 / hit@3 (the passage at
  rank 1 / within 3 comes from the right file and page) and the "no good source" decisions. How to run it: see the
  docstring. Results go to `results/` (not committed).

## Results (28 Nov 2026, test server, engine image 2.4.0 with this branch's code)

| variant | hit@1 | hit@3 |
|---|---|---|
| today (hybrid search + the bundled English reranker) | 39/48 = 81 % | 46/48 = 96 % |
| **with the reranker** (gte-multilingual-reranker-base int8, 20 candidates, fused with the first-stage order) | **46/48 = 96 %** | **48/48 = 100 %** |
| same, 30 candidates | 45/48 = 94 % | 48/48 = 100 % |
| same, the reranker's order alone (not fused) | 35/48 = 73 % | 46/48 = 96 % |
| cross-encoder/mmarco-mMiniLMv2-L12 (119 MB) instead, 30 candidates, fused (first run) | 40/48 = 83 % | 46/48 = 96 % |
| same, its order alone | 11/48 = 23 % | 23/48 = 48 % |

Per language with the reranker, hit@1: de 8/8, en 8/8, fr 8/8, es 7/8, it 8/8, tr 7/8 (today: 6, 7, 6, 7, 7, 6).

Time of the reranker per question, 20 candidates, on a Ryzen 9 7940HS shared with other jobs: median 760 ms, p95 902 ms
(8 threads); 953 ms with 4 threads, 1523 ms with 2. 30 candidates: median 1183 ms. The whole retrieval without the
reranker: median 52 ms. The engine cuts the number of candidates to stay within 1.5 s and skips the reranker on a PC too
slow for 8 candidates (`reranker.plan`).

For comparison, a Qwen3-Reranker-0.6B-class model through Ollama (yes/no log-probabilities of `qwen3:0.6b`, one request
per passage; Ollama has no rerank endpoint): 10.4 s for 30 passages on the same CPU.

## "No good source"

Thresholds are chosen so that none of the 48 answerable questions is flagged (a wrong notice hides a correct answer):

| variant | unanswerable caught | answerable wrongly flagged |
|---|---|---|
| without the reranker (similarity + shared words) | 0 of 12 | 0 of 48 |
| with the reranker (score + shared words) | 2 of 12 (DU2, SU2: passport) | 0 of 48 |

This is the honest limit of scores from the retrieval itself. The best reranker score of an unanswerable question
(0.26-0.50) overlaps the scores of answerable ones (from 0.325): "household insurance" next to a car insurance policy
scores like a real answer, and the embedding similarity of unanswerable questions is even higher than that of many
answerable ones. The notice therefore fires only on clearly weak retrieval; the remaining cases are left to the model's
refusal rules in the prompt and the term check of `chat.py`. Next step if more is wanted: an answerability check by
the chat model itself (one short extra call) or a reranker trained for "does this passage answer it".
