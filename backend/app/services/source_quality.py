"""An honest "no good source" (StarkLLM 2.7, option 5).

When no retrieved passage answers the question well, the answer must not guess from whatever came back. This module
decides that from the retrieval itself, without asking a model. Two signals:

* the score: with the multilingual reranker installed (reranker.py) the best reranker score of the passages that go to
  the answer; without it the best cosine similarity between the question and those passages;
* shared words: whether any content word of the question (5+ letters, no stop word; compared by its first five
  letters, so "Urlaubstage" meets "Resturlaub", "tetkikinden" meets "tetkikten") appears in the first three passages.

Weak is: a reranker score under RERANK_WEAK, or under RERANK_WEAK_NO_WORDS when no word is shared; without the reranker,
a similarity under VECTOR_WEAK_NO_WORDS when no word is shared.

The thresholds come from the labelled eval in eval/retrieval (48 questions with an answer and 12 without, in de, en,
fr, es, it, tr) and are set so that no answerable question of the eval is flagged: a wrong "no good source" hides a
correct answer, so the check fires only on clearly weak retrieval. That is also its limit, written down in
eval/retrieval/README.md: on the eval it catches 2 of the 12 unanswerable questions with the reranker and none without
it. A question next to a real document (household insurance when only a car insurance exists) scores like an
answerable one and is left to the model's own refusal rule and the term check of chat.py.

The chat shows the notice only for a question that is about the user's documents: the strict document mode, or a
question with a possessive or document word ("my", "mein", "ma facture", "faturam" ...). "What is the capital of
France?" in a workspace with letters is answered normally.
"""
import re
from typing import Dict, Iterable, List, Optional

RERANK_WEAK = 0.30            # lowest best score of an answerable eval question: 0.325
RERANK_WEAK_NO_WORDS = 0.36   # ... of one that shares no word with its passages: 0.379
VECTOR_WEAK_NO_WORDS = 0.45   # lowest best similarity of an answerable eval question: 0.452
SHARED_WORD_PASSAGES = 3

# possessive words: a question about the user's own things ("my rent", "ma facture"), in the six interface languages.
# Not "I" or "ich": "How do I bake bread?" is no question about the documents.
_PERSONAL = {
    "en": r"\b(my|our)\b",
    "de": r"\b(mein|meine|meinen|meinem|meiner|meines|unser|unsere|unseren|unserem|unserer)\b",
    "fr": r"\b(mon|ma|mes|notre|nos)\b",
    "es": r"\b(mi|mis|nuestro|nuestra|nuestros|nuestras)\b",
    "it": r"\b(mio|mia|miei|mie|nostro|nostra|nostri|nostre)\b",
    # benim/bizim, or a noun with a first-person possessive ending: faturam, evim, primim, pasaportumun, iznim
    "tr": r"\b(benim|bizim)\b|\b\w{3,}(?:ım|im|um|üm|m)(?:ın|in|un|ün|ı|i|u|ü)?\b",
}
# document words; German ones also inside compounds ("Stromrechnung", "Mietvertrag")
_DOCUMENT_WORDS = (
    r"\b(document|documents|file|files|letter|letters|invoice|bill|contract|policy|payslip|statement|"
    r"dokument\w*|datei\w*|fichier|lettre|courrier|facture|contrat|bulletin|"
    r"documento|documentos|archivo|carta|factura|contrato|nómina|nomina|póliza|"
    r"documenti|lettera|fattura|bolletta|contratto|polizza|busta|"
    r"belge|belgeler|dosya|mektup|fatura|sözleşme|poliçe|bordro)\b"
    r"|(rechnung|vertrag|bescheid|schreiben|abrechnung|versicherungsschein|police\b)"
)
_TURKISH = re.compile(r"[ışğ]|\b(mı|mi|mu|mü|ne|kaç|nasıl|hangi|nerede|neden)\b")
_QUESTION = re.compile(
    r"\?|^\s*(what|when|where|who|which|how|why|is|are|do|does|did|can|could|should|"
    r"was|wann|wo|wer|wie|welche\w*|warum|ist|sind|muss|kann|darf|habe|hat|"
    r"que|quel\w*|quand|où|qui|comment|combien|pourquoi|est-ce|"
    r"qué|cuándo|dónde|quién|cómo|cuánt\w*|cuál\w*|por qué|"
    r"che|cosa|quando|dove|chi|come|quant\w*|qual\w*|perché|"
    r"ne|ne zaman|nerede|kim|nasıl|kaç|hangi|neden)\b",
    re.IGNORECASE,
)


def best(results: Iterable[Dict], key: str) -> Optional[float]:
    vals = [float(r[key]) for r in results or [] if isinstance(r.get(key), (int, float))]
    return max(vals) if vals else None


def content_words(message: str) -> List[str]:
    """The question's content words, folded like the keyword search folds them ("Kündigung" -> "kuendigung")."""
    from app.services.rag_service import _fold, ENGLISH_STOP_WORDS, GERMAN_STOP_WORDS, OTHER_STOP_WORDS
    stop = ENGLISH_STOP_WORDS | GERMAN_STOP_WORDS | OTHER_STOP_WORDS
    return list(dict.fromkeys(w for w in re.findall(r"\w+", _fold(message or ""))
                              if len(w) >= 5 and w not in stop and not w.isdigit()))


def shares_words(message: str, results: List[Dict]) -> Optional[bool]:
    """Does a content word of the question appear in the first passages? None when the question has none."""
    from app.services.rag_service import _fold
    words = content_words(message)
    if not words:
        return None
    texts = [_fold(r.get("content") or "") for r in results[:SHARED_WORD_PASSAGES]]
    return any(w[:5] in t for w in words for t in texts)


def assess(results: List[Dict], message: str = "") -> Dict:
    """{"weak": bool, "signal": "reranker" | "vector" | None, "best": float | None, "shared_words": bool | None}.
    No passages at all is not "weak" here: then the prompt already says there are none."""
    results = list(results or [])
    if not results:
        return {"weak": False, "signal": None, "best": None, "shared_words": None}
    shared = shares_words(message, results)
    no_words = shared is False
    score = best(results, "_rerank_score")
    if score is not None:
        weak = score < RERANK_WEAK or (no_words and score < RERANK_WEAK_NO_WORDS)
        return {"weak": weak, "signal": "reranker", "best": round(score, 4), "shared_words": shared}
    sim = best(results, "_vector_sim")
    if sim is not None:
        return {"weak": no_words and sim < VECTOR_WEAK_NO_WORDS, "signal": "vector", "best": round(sim, 4),
                "shared_words": shared}
    return {"weak": False, "signal": None, "best": None, "shared_words": shared}


def about_documents(message: str, strict_document_mode: bool) -> bool:
    """Is the message a question about the user's own documents (so "nothing found" is worth a notice)?"""
    if strict_document_mode:
        return True
    text = (message or "").strip().lower()
    if not text or not _QUESTION.search(text):
        return False
    if re.search(_DOCUMENT_WORDS, text):
        return True
    # the Turkish endings would also match English words ("system"): only for Turkish text
    turkish = bool(_TURKISH.search(text))
    return any(re.search(p, text) for lang, p in _PERSONAL.items() if lang != "tr" or turkish)


def no_good_source(results: List[Dict], message: str, *, strict_document_mode: bool, whole_document: bool = False,
                   named_files: bool = False, overview: bool = False) -> Optional[Dict]:
    """The notice for the answer (a warning of kind "no_good_source") or None. Not for questions about a whole document
    (they are answered from its summaries), a file the user named, or the list of all letters (dates and payments)."""
    if whole_document or named_files or overview or not results:
        return None
    if not about_documents(message, strict_document_mode):
        return None
    quality = assess(results, message)
    if not quality["weak"]:
        return None
    return {"kind": "no_good_source", "signal": quality["signal"], "score": quality["best"]}
