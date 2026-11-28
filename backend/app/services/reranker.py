"""Second search stage: a small multilingual reranker on this PC (StarkLLM 2.7, "better answers from documents").

The first stage (vector + keyword search, rag_service._hybrid_query) brings up to MAX_CANDIDATES passages. When the
user downloaded the reranker in Settings > Document search, a cross-encoder reads the question together with each
candidate and scores how well the passage answers it. Its order is fused with the first-stage order (RRF,
rag_service._rerank_multilingual) and the best ones go to the answer; the best score is one signal of "no good source"
(source_quality.py). Without the model nothing changes: retrieval works exactly as before (hybrid order, with the small
English reranker that ships in the engine image).

Model: Alibaba-NLP/gte-multilingual-reranker-base (Apache-2.0, 70+ languages, among them de, en, fr, es, it, tr), in the
int8 ONNX export of onnx-community: 341 MB model + 17 MB tokenizer, run with onnxruntime and tokenizers, which the engine
already has (no new dependency). Chosen by the labelled eval in eval/retrieval (README there):

    hit@1 / hit@3 over 48 questions   today 81 % / 96 %   with this reranker (20 candidates, fused) 96 % / 100 %

Measured and not taken: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (119 MB, 3x faster): 83 % hit@1 fused, 23 % with
its order alone; it scored the short, number-heavy pages of letters close to noise. A Qwen3-Reranker-0.6B-class model through Ollama:
Ollama has no rerank endpoint, and scoring 30 passages one by one (yes/no log-probabilities of qwen3:0.6b) took 10.4 s
on the test server's CPU.

Speed on the test server's CPU (Ryzen 9 7940HS, shared with other jobs), 20 candidates: median 0.76 s, p95 0.90 s with 8
threads, 0.95 s with 4, 1.5 s with 2; 30 candidates took 1.2 s with 8 threads. Twenty candidates were also the better
choice in the eval (96 % hit@1 against 94 % with 30).

Network: the model is fetched only when the user asks for it (Settings shows the size), through the network layer
(feature "reranker_model_download", refused while the app is fully offline), from a pinned revision, and every file is
checked against its SHA-256 before it is used. At question time nothing touches the network.

Speed: every call is timed. The number of candidates is cut so that reranking stays within BUDGET_S; on a PC too slow
even for MIN_CANDIDATES it is skipped (and measured again every PROBE_EVERY questions), so a slow PC answers as fast as
before.
"""
import hashlib
import logging
import math
import os
import shutil
import threading
import time
from typing import Callable, Dict, List, Optional

from app.core import netguard

logger = logging.getLogger(__name__)

MODEL_ID = "gte-multilingual-reranker-base-int8"
MODEL_NAME = "GTE multilingual reranker (Alibaba-NLP/gte-multilingual-reranker-base, int8)"
LICENSE = "Apache-2.0"
REVISION = "ee64367e35a2db0da46bb6497e13a18f8bd585cb"
# {path} is the file in the model repository; RERANKER_URL can point to a mirror with the same layout
URL = os.getenv("RERANKER_URL", "https://huggingface.co/onnx-community/gte-multilingual-reranker-base/resolve/"
                + REVISION + "/{path}")
FILES = (
    {"name": "model.onnx", "path": "onnx/model_int8.onnx", "size": 340858200,
     "sha256": "ccf51dba7f8aa9205753761cfaa68c55f741792501463a3bf25d7e5bcdac7c35"},
    {"name": "tokenizer.json", "path": "tokenizer.json", "size": 17082999,
     "sha256": "3ffb37461c391f096759f4a9bbbc329da0f36952f88bab061fcf84940c022e98"},
)
DOWNLOAD_BYTES = sum(f["size"] for f in FILES)

MAX_CANDIDATES = 20      # first-stage passages read by the reranker (eval: better and faster than 30)
MIN_CANDIDATES = 8       # fewer than this is not worth it: then the reranker is skipped
MAX_TOKENS = 320         # question + passage; a 700-character chunk is about 200 tokens
BUDGET_S = float(os.getenv("STARKLLM_RERANK_BUDGET_S", "1.5"))  # most a question may wait for the reranker
PROBE_EVERY = 25         # while skipped for slowness: measure again every so many questions
THREADS = max(1, min(8, os.cpu_count() or 4))


def model_dir() -> str:
    """Where the model lives: STARKLLM_MULTILINGUAL_RERANKER_DIR (a copy that came with an installer, or tests), else
    the data folder."""
    return os.path.abspath(os.getenv("STARKLLM_MULTILINGUAL_RERANKER_DIR") or os.path.join("data", "models", MODEL_ID))


def installed() -> bool:
    folder = model_dir()
    return all(os.path.isfile(os.path.join(folder, f["name"])) and os.path.getsize(os.path.join(folder, f["name"])) == f["size"]
               for f in FILES)


# ---------------------------------------------------------------------------------------------------------------
# download (only when the user asks for it)
# ---------------------------------------------------------------------------------------------------------------
_lock = threading.RLock()
_job: Dict = {"state": "idle", "done": 0, "total": DOWNLOAD_BYTES, "error": ""}


def _fetch(url: str, dest: str, expected: Dict, progress: Callable[[int], None]) -> None:
    """One file, streamed into dest.part, checked against its size and SHA-256, then moved into place."""
    resp = netguard.request("GET", url, feature="reranker_model_download", stream=True, timeout=60,
                            headers={"User-Agent": "StarkLLM-reranker"})
    part = dest + ".part"
    try:
        resp.raise_for_status()
        digest, n = hashlib.sha256(), 0
        with open(part, "wb") as f:
            for chunk in resp.iter_content(1024 * 1024):
                if not chunk:
                    continue
                n += len(chunk)
                if n > expected["size"]:
                    raise RuntimeError("the download is larger than the model file")
                digest.update(chunk)
                f.write(chunk)
                progress(len(chunk))
        if n != expected["size"] or digest.hexdigest() != expected["sha256"]:
            raise RuntimeError("the downloaded file does not match the expected model (size or checksum)")
        os.replace(part, dest)
    finally:
        resp.close()
        if os.path.exists(part):
            os.remove(part)


def download(fetch: Optional[Callable] = None) -> None:
    """Download the model (blocking). Raises on failure; the job state says what happened."""
    fetch = fetch or _fetch
    folder = model_dir()
    with _lock:
        _job.update(state="downloading", done=0, total=DOWNLOAD_BYTES, error="")

    def progress(n: int) -> None:
        with _lock:
            _job["done"] += n

    try:
        os.makedirs(folder, exist_ok=True)
        for f in FILES:
            dest = os.path.join(folder, f["name"])
            if os.path.isfile(dest) and os.path.getsize(dest) == f["size"] and _sha256(dest) == f["sha256"]:
                progress(f["size"])
                continue
            fetch(URL.format(path=f["path"]), dest, f, progress)
        with _lock:
            _job.update(state="idle", done=DOWNLOAD_BYTES)
        reset()
        logger.info("Reranker: multilingual model installed")
    except Exception as e:
        with _lock:
            _job.update(state="failed", error=str(e)[:300])
        logger.warning(f"Reranker: download failed: {e}")
        raise


def start_download() -> bool:
    """Download in the background; False when a download is already running."""
    with _lock:
        if _job["state"] == "downloading":
            return False
        _job.update(state="downloading", done=0, error="")

    def run():
        try:
            download()
        except Exception:
            pass  # recorded in the job state

    threading.Thread(target=run, name="reranker-download", daemon=True).start()
    return True


def remove() -> None:
    if os.getenv("STARKLLM_MULTILINGUAL_RERANKER_DIR"):
        raise ValueError("This reranker came with the installation and cannot be removed here.")
    with _lock:
        if _job["state"] == "downloading":
            raise ValueError("The model is being downloaded; remove it when the download has finished.")
    reset()
    folder = model_dir()
    if os.path.isdir(folder):
        shutil.rmtree(folder, ignore_errors=True)
    with _lock:
        _job.update(state="idle", done=0, error="")


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------------------------
class _Model:
    def __init__(self, folder: str):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.np = np
        self.tok = Tokenizer.from_file(os.path.join(folder, "tokenizer.json"))
        self.tok.enable_truncation(max_length=MAX_TOKENS)
        pad = self.tok.token_to_id("<pad>")
        self.tok.enable_padding(pad_id=pad if pad is not None else 0, pad_token="<pad>")
        so = ort.SessionOptions()
        so.intra_op_num_threads = THREADS
        so.log_severity_level = 3
        self.session = ort.InferenceSession(os.path.join(folder, "model.onnx"), so, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}

    def scores(self, query: str, passages: List[str]) -> List[float]:
        np = self.np
        enc = self.tok.encode_batch([(query, p) for p in passages])
        feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
        logits = self.session.run(None, feed)[0].reshape(len(passages), -1)[:, 0]
        return [1.0 / (1.0 + math.exp(-float(x))) for x in logits]


_model: Optional[_Model] = None
_model_failed = False
_stats: Dict = {"per_candidate_s": None, "last_ms": None, "last_n": 0, "calls": 0, "skipped": 0, "since_probe": 0,
                "auto_off": False}


def reset() -> None:
    """Forget the loaded model (after a download or removal) and the speed measurements."""
    global _model, _model_failed
    with _lock:
        _model, _model_failed = None, False
        _stats.update(per_candidate_s=None, last_ms=None, last_n=0, calls=0, skipped=0, since_probe=0, auto_off=False)


def ready() -> bool:
    return not _model_failed and installed()


def _load() -> Optional[_Model]:
    global _model, _model_failed
    with _lock:
        if _model is None and not _model_failed:
            try:
                _model = _Model(model_dir())
            except Exception as e:
                _model_failed = True
                logger.warning(f"Reranker: the multilingual model could not be loaded, searching without it: {e}")
        return _model


def plan(wanted: int) -> int:
    """How many candidates to score now: all wanted ones while the PC is fast enough, fewer to stay within the budget,
    0 to skip (too slow even for MIN_CANDIDATES), and MIN_CANDIDATES now and then to measure again."""
    with _lock:
        per = _stats["per_candidate_s"]
        if not per:
            return wanted
        fits = int(BUDGET_S / per)
        if fits >= MIN_CANDIDATES:
            _stats["auto_off"] = False
            return min(wanted, fits)
        _stats["auto_off"] = True
        _stats["since_probe"] += 1
        if _stats["since_probe"] >= PROBE_EVERY:
            _stats["since_probe"] = 0
            return min(wanted, MIN_CANDIDATES)
        return 0


def _measured(n: int, seconds: float) -> None:
    with _lock:
        per = seconds / max(n, 1)
        old = _stats["per_candidate_s"]
        _stats["per_candidate_s"] = per if old is None else 0.7 * old + 0.3 * per
        _stats["last_ms"] = round(seconds * 1000)
        _stats["last_n"] = n
        _stats["calls"] += 1


def score(query: str, passages: List[str]) -> Optional[List[float]]:
    """Scores (0..1) for the first passages, as many as the time budget allows (a prefix of the list), or None when
    the reranker is not installed, failed to load, or is skipped because this PC is too slow for it."""
    if not passages or not ready():
        return None
    n = plan(min(len(passages), MAX_CANDIDATES))
    if n <= 0:
        with _lock:
            _stats["skipped"] += 1
        return None
    model = _load()
    if model is None:
        return None
    t0 = time.perf_counter()
    try:
        out = model.scores(query, passages[:n])
    except Exception as e:
        logger.warning(f"Reranker: scoring failed, using the first-stage order: {e}")
        return None
    _measured(n, time.perf_counter() - t0)
    return out


def status() -> Dict:
    with _lock:
        job = dict(_job)
        stats = dict(_stats)
    return {
        "model": MODEL_NAME, "license": LICENSE, "download_bytes": DOWNLOAD_BYTES,
        "installed": installed(), "removable": not os.getenv("STARKLLM_MULTILINGUAL_RERANKER_DIR"),
        "load_failed": _model_failed,
        "download": job,
        "max_candidates": MAX_CANDIDATES, "budget_ms": round(BUDGET_S * 1000),
        "last_ms": stats["last_ms"], "last_candidates": stats["last_n"], "calls": stats["calls"],
        "skipped_slow": stats["skipped"], "auto_off": stats["auto_off"],
    }
