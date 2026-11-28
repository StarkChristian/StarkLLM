"""Retrieval eval of StarkLLM 2.7 (option 4: two-stage search with a local reranker; option 5: "no good source").

Indexes the labelled set of corpus.py with the engine's own pipeline (PDF reading, semantic chunking, embeddings of the
local Ollama) into a throw-away vector store, then asks every question through RAGService.query_merged, the call the
chat makes (5 passages), once per variant:

    today      the first stage as it is (hybrid vector + keyword search, the small English reranker fused in)
    reranker   the same first stage with 20 candidates, then the multilingual reranker (reranker.py), fused
               with the first-stage order; the other variants change one knob (30 candidates, order alone, ...)

and scores hit@1 / hit@3: the passage at rank 1 / within the first 3 comes from the folder and page that answer the
question. Questions without an answer calibrate the "no good source" threshold (source_quality.py): their best score
must be low, the best score of answered questions high.

Run it with the engine's Python and a local Ollama with the embedding model (nomic-embed-text), for example in the
engine image:

    docker run --rm --network host -v "$PWD:/repo" -v /path/to/model:/reranker \
      -e OLLAMA_BASE_URL=http://127.0.0.1:11434 -e STARKLLM_MULTILINGUAL_RERANKER_DIR=/reranker \
      -w /repo/eval/retrieval ghcr.io/starkchristian/starkllm-backend:<version> python run.py

/path/to/model holds model.onnx and tokenizer.json (Settings > Document search downloads them to
data/models/gte-multilingual-reranker-base-int8). Results: results/results.json and results/summary.md (not committed).
"""
import argparse
import functools
import json
import os
import pathlib
import statistics
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIXTURES = REPO / "backend" / "tests" / "fixtures"
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(HERE))

import corpus  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"  # Turkish letters (ş, ğ, ı) are not in the PDF base fonts


def make_pdf(path, pages):
    import pymupdf as fitz
    doc = fitz.open()
    for text in pages:
        page = doc.new_page()
        if os.path.exists(FONT):
            page.insert_font(fontname="dejavu", fontfile=FONT)
            font = "dejavu"
        else:
            font = "helv"
        left = page.insert_textbox(fitz.Rect(56, 56, 540, 790), text, fontsize=10.5, fontname=font)
        assert left >= 0, f"text does not fit on a page: {text[:40]}"
    doc.save(path)


def build(workdir):
    files = []
    for lang, name in corpus.FOLDERS.items():
        letter = (FIXTURES / "letters" / corpus.LETTERS[lang]).read_text(encoding="utf-8")
        pages = [letter] + corpus.PAGES[lang][1:]
        path = os.path.join(workdir, name)
        make_pdf(path, pages)
        files.append(path)
    for folder, name in corpus.EXTRA_FILES:
        path = os.path.join(workdir, name)
        pathlib.Path(path).write_bytes((FIXTURES / folder / name).read_bytes())
        files.append(path)
    return files


def questions():
    out = []
    for lang, qs in corpus.QUESTIONS.items():
        for qid, q, page in qs:
            out.append({"id": qid, "lang": lang, "q": q, "file": corpus.FOLDERS[lang] if page else None, "page": page})
    return out


def where(r):
    meta = r.get("metadata") or {}
    page = meta.get("page")
    return os.path.basename(meta.get("source") or ""), (page + 1 if isinstance(page, int) else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "results"))
    ap.add_argument("--variants", default="today,reranker")
    ap.add_argument("--threads", default="", help="also time the reranker with these thread counts, e.g. 2,4")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    work = tempfile.mkdtemp(prefix="w27-eval-")
    os.chdir(work)  # the engine keeps its data (vector store, logs) in ./data
    from app.services import reranker as ml
    from app.services.llm_service import llm_service
    from app.services.rag_service import rag_service, RAGService
    from app.services import source_quality

    if not ml.installed():
        sys.exit(f"the multilingual reranker is not in {ml.model_dir()} (model.onnx, tokenizer.json)")
    # one embedding per question text for all variants: the variants differ only after the first stage
    llm_service.generate_embeddings = functools.lru_cache(maxsize=None)(llm_service.generate_embeddings)

    t0 = time.time()
    for path in build(work):
        rag_service.add_document(1, 1, path, display_name=os.path.basename(path))
    pieces = rag_service.get_or_create_collection(1, 1).count()
    print(f"indexed {pieces} passages in {time.time() - t0:.0f} s", flush=True)

    real_ready = ml.ready
    timings = []
    real_score = ml.score

    def timed_score(query, passages):
        t = time.perf_counter()
        res = real_score(query, passages)
        if res is not None:
            timings.append({"n": len(res), "s": time.perf_counter() - t, "scores": sorted(res, reverse=True)})
        return res

    ml.score = timed_score
    # "fused": the reranker's order fused with the first-stage order (what the app does); "score": its order alone
    variants = {
        "today": dict(ready=False),
        "reranker": dict(ready=True, order="fused", name=True, candidates=20, tokens=320),  # what the app does
        "reranker_30": dict(ready=True, order="fused", name=True, candidates=30, tokens=320),
        "reranker_256_tokens": dict(ready=True, order="fused", name=True, candidates=30, tokens=256),
        "reranker_score_only": dict(ready=True, order="score", name=True, candidates=30, tokens=320),
        "reranker_no_file_name": dict(ready=True, order="fused", name=False, candidates=30, tokens=320),
    }
    defaults = (ml.MAX_CANDIDATES, ml.MAX_TOKENS, RAGService.RERANK_ORDER, RAGService.RERANK_WITH_NAME)
    rows = []
    qs = questions()
    for v in [x for x in args.variants.split(",") if x]:
        cfg = variants[v]
        ml.ready = real_ready if cfg["ready"] else (lambda: False)
        RAGService.RERANK_ORDER = cfg.get("order", defaults[2])
        RAGService.RERANK_WITH_NAME = cfg.get("name", defaults[3])
        ml.MAX_CANDIDATES = cfg.get("candidates", defaults[0])
        if cfg.get("tokens", defaults[1]) != ml.MAX_TOKENS:
            ml.MAX_TOKENS = cfg.get("tokens", defaults[1])
            ml.reset()
        timings.clear()
        for q in qs:
            t = time.perf_counter()
            ws, _ = rag_service.query_merged(1, 1, q["q"], use_kb=False, n_results=5)
            took = time.perf_counter() - t
            got = [where(r) for r in ws]
            target = (q["file"], q["page"])
            rows.append({
                "variant": v, **q, "seconds": round(took, 3),
                "got": [f"{f} p{p}" for f, p in got],
                "hit1": bool(q["file"]) and got[:1] == [target],
                "hit3": bool(q["file"]) and target in got[:3],
                "best_rerank": max([r["_rerank_score"] for r in ws if "_rerank_score" in r], default=None),
                "top_rerank": ws[0].get("_rerank_score") if ws else None,
                "best_vector": max([r["_vector_sim"] for r in ws if "_vector_sim" in r], default=None),
                "top_vector": ws[0].get("_vector_sim") if ws else None,
                "candidate_scores": [round(x, 4) for x in timings[-1]["scores"]] if timings and cfg["ready"] else None,
                "no_good_source": source_quality.assess(ws, q["q"])["weak"],
            })
            print(json.dumps({k: rows[-1][k] for k in ("variant", "id", "hit1", "hit3", "top_rerank", "top_vector")}), flush=True)
        if timings:
            rows.append({"variant": v, "id": "_latency", "rerank_s": [x["s"] for x in timings], "n": [x["n"] for x in timings]})
    ml.ready = real_ready
    ml.MAX_CANDIDATES, ml.MAX_TOKENS, RAGService.RERANK_ORDER, RAGService.RERANK_WITH_NAME = defaults
    ml.reset()

    # latency with fewer threads (an ordinary PC has fewer cores than the test server)
    thread_lat = {}
    ml.BUDGET_S = 1000.0  # time all 30 passages here, without the cap
    for th in [int(x) for x in args.threads.split(",") if x]:
        ml.THREADS = th
        ml.reset()
        timings.clear()
        texts = list(rag_service.get_or_create_collection(1, 1).get(limit=30)["documents"])
        ml.score("Wie viele Urlaubstage habe ich noch?", texts)  # load
        timings.clear()
        for q in qs[:20]:
            ml.score(q["q"], texts)
        thread_lat[th] = sorted(x["s"] for x in timings)

    (out / "results.json").write_text(json.dumps({"rows": rows, "thread_latency": thread_lat, "passages": pieces},
                                                 ensure_ascii=False, indent=1), encoding="utf-8")
    write_summary(out, rows, thread_lat, pieces)


def pct(vals, p):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(round(p * (len(vals) - 1))))]


def write_summary(out, rows, thread_lat, pieces):
    from app.services.reranker import MAX_CANDIDATES as ml_max
    lines = [f"# Retrieval eval ({pieces} passages in one workspace)", ""]
    variants = list(dict.fromkeys(r["variant"] for r in rows))
    langs = list(corpus.FOLDERS)
    lines += ["| variant | " + " | ".join(langs) + " | all hit@1 | all hit@3 |", "|---|" + "---|" * (len(langs) + 2)]
    for v in variants:
        qrows = [r for r in rows if r["variant"] == v and r["id"] != "_latency" and r["file"]]
        cells = []
        for lang in langs:
            lr = [r for r in qrows if r["lang"] == lang]
            cells.append(f"{sum(r['hit1'] for r in lr)}/{sum(r['hit3'] for r in lr)} of {len(lr)}")
        h1, h3 = sum(r["hit1"] for r in qrows), sum(r["hit3"] for r in qrows)
        lines.append(f"| {v} | " + " | ".join(cells) + f" | {h1}/{len(qrows)} = {h1 / len(qrows):.0%} | {h3}/{len(qrows)} = {h3 / len(qrows):.0%} |")
    lines += ["", "Cells: hit@1/hit@3 of the questions of that language.", "",
              "\"No good source\" (source_quality.py) per variant: unanswerable questions caught / answerable questions "
              "wrongly flagged:", ""]
    for v in variants:
        qrows = [r for r in rows if r["variant"] == v and r["id"] != "_latency"]
        un = [r for r in qrows if not r["file"]]
        an = [r for r in qrows if r["file"]]
        caught = [r["id"] for r in un if r.get("no_good_source")]
        wrong = [r["id"] for r in an if r.get("no_good_source")]
        lines.append(f"- {v}: caught {len(caught)} of {len(un)} ({', '.join(caught) or '-'}); "
                     f"wrongly flagged {len(wrong)} of {len(an)} ({', '.join(wrong) or '-'})")
    lines.append("")
    for v in variants:
        lat = [r for r in rows if r["variant"] == v and r["id"] == "_latency"]
        if lat:
            s = lat[0]["rerank_s"]
            lines.append(f"- {v}: reranker time per question (n={len(s)}, candidates {min(lat[0]['n'])}-{max(lat[0]['n'])}): "
                         f"median {statistics.median(s) * 1000:.0f} ms, p95 {pct(s, 0.95) * 1000:.0f} ms, max {max(s) * 1000:.0f} ms")
        q = [r["seconds"] for r in rows if r["variant"] == v and r["id"] != "_latency"]
        lines.append(f"- {v}: whole retrieval per question: median {statistics.median(q) * 1000:.0f} ms, p95 {pct(q, 0.95) * 1000:.0f} ms")
    for th, s in thread_lat.items():
        lines.append(f"- reranker with {th} threads, {ml_max} passages: median {statistics.median(s) * 1000:.0f} ms, max {max(s) * 1000:.0f} ms")
    lines += ["", "## Scores for the \"no good source\" threshold", "",
              "| variant | id | answerable | hit@1 | top reranker score | top vector similarity |", "|---|---|---|---|---|---|"]
    for r in rows:
        if r["id"] == "_latency":
            continue
        f = lambda x: "-" if x is None else f"{x:.3f}"
        lines.append(f"| {r['variant']} | {r['id']} | {'yes' if r['file'] else 'no'} | {'yes' if r['hit1'] else ''} | {f(r['top_rerank'])} | {f(r['top_vector'])} |")
    lines += ["", "## Misses", ""]
    for r in rows:
        if r["id"] != "_latency" and r["file"] and not r["hit1"]:
            lines.append(f"- {r['variant']} {r['id']} ({r['q']}): wanted {r['file']} p{r['page']}, got {', '.join(r['got'][:3])}")
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:16]))


if __name__ == "__main__":
    main()
