"""Runs the scenarios against a running StarkLLM engine and scores every answer.

    python3 backend/scenarios/run.py --docs <folder from make_documents> --out results.json
        [--api http://127.0.0.1:18000] [--secret <engine SECRET_KEY>] [--model qwen2.5:3b] [--only id,id]

Signs in like the desktop app (the key derived from the engine's SECRET_KEY), puts all documents into a new
workspace, waits until they are read, checks the dates the document home finds, then asks every question and checks
the answer. Uses only the Python standard library, so it runs anywhere next to the engine.
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scenarios.questions import QUESTIONS, REFUSAL  # noqa: E402

# dates the document home must show (file, ISO date); today is 10.11.2026 in documents.py
EXPECTED_DATES = [
    ("Steuerbescheid_2025.pdf", "2026-12-15"),
    ("Korrektur_Nebenkostenabrechnung_2025.pdf", "2026-11-30"),
    ("Kfz_Versicherung_Beitragsrechnung_2027.pdf", "2026-11-30"),
    ("Kfz_Versicherung_Beitragsrechnung_2027.pdf", "2027-01-01"),
    ("Krankenkasse_Zusatzbeitrag_2027.pdf", "2027-01-31"),
    ("Einladung_Agentur_fuer_Arbeit.pdf", "2026-11-18"),
    ("IMG_2041_Stadtwerke.jpg", "2026-11-20"),
    ("Scan_Bank_Entgelte.pdf", "2027-01-31"),
    ("Offer_Letter_Bright_Harbor.pdf", "2026-11-25"),
    ("Fitnessstudio_Kuendigungsbestaetigung.pdf", "2027-03-31"),
    ("Mahnung_Stadtwerke.pdf", "2026-11-27"),
]
# dates that must not be shown as something to do
UNWANTED_DATES = [
    ("Gewinnbenachrichtigung.pdf", "2026-11-05"),      # a scam's date is not something to do
    ("Nebenkostenabrechnung_2025.pdf", "2026-11-30"),  # replaced by the corrected letter
    ("Arztbrief_Orthopaedie.pdf", "1991-06-14"),       # date of birth
]

LANG_WORDS = {
    "de": r"\b(und|der|die|das|ist|sie|nicht|bis|ihr|ihre|ich|bin|du|dein|dir|dich|was|kann|für|mit|bei)\b",
    "en": r"\b(the|and|you|your|is|to|of)\b",
    "tr": r"\b(ve|bir|bu|için|randevu|saat|olarak|değil|ile)\b",
}


class Api:
    def __init__(self, base, secret):
        self.base = base.rstrip("/")
        key = hmac.new(secret.encode(), b"starkllm-desktop-session", hashlib.sha256).hexdigest()
        self.token = self.call("POST", "/api/v1/auth/desktop-session", headers={"X-Desktop-Key": key})["access_token"]

    def call(self, method, path, body=None, headers=None, raw=None, content_type=None, timeout=900):
        h = dict(headers or {})
        if getattr(self, "token", None):
            h["Authorization"] = f"Bearer {self.token}"
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        elif content_type:
            h["Content-Type"] = content_type
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()[:300]}") from None

    def upload(self, ws_id, path: Path):
        boundary = uuid.uuid4().hex
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
                f"Content-Type: {mime}\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        return self.call("POST", f"/api/v1/documents/{ws_id}/upload", raw=body,
                         content_type=f"multipart/form-data; boundary={boundary}")


def check(question, answer, sources, warnings=()):
    a = answer or ""
    failed, notes = [], []
    shown = [f"{w.get('kind')}:{w.get('file') or w.get('sender')}" for w in warnings]
    for want in question.get("warn", []):
        if not any(x.startswith(want) or want in x for x in shown):
            failed.append(f"no warning {want}")
    if question.get("warn_none") and shown:
        failed.append(f"false alarm {shown}")
    for p in question.get("must", []):
        if not re.search(p, a, re.IGNORECASE | re.DOTALL):
            failed.append(f"missing /{p}/")
    for p in question.get("must_not", []):
        if re.search(p, a, re.IGNORECASE | re.DOTALL):
            failed.append(f"must not say /{p}/")
    if question.get("refuse") and not re.search(REFUSAL, a, re.IGNORECASE):
        failed.append("did not say it found nothing")
    src = question.get("source")
    if src and not any(src in s for s in sources):
        failed.append(f"{src} not among the sources")
    lang = question.get("lang")
    if lang:
        counts = {k: len(re.findall(v, a, re.IGNORECASE)) for k, v in LANG_WORDS.items()}
        # short answers ("Ihr Vertrag endet zum 31.03.2027.") have few common words: one is enough if no other wins
        if counts[lang] < 1 or any(n > counts[lang] for k, n in counts.items() if k != lang):
            failed.append(f"not in {lang} ({counts})")
    if question.get("best") and not re.search(question["best"], a, re.IGNORECASE | re.DOTALL):
        notes.append(f"could be better: /{question['best']}/")
    if question.get("best_not") and re.search(question["best_not"], a, re.IGNORECASE | re.DOTALL):
        notes.append(f"could be better: says /{question['best_not']}/")
    return failed, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:18000")
    ap.add_argument("--secret", required=True)
    ap.add_argument("--docs", required=True)
    ap.add_argument("--out", default="scenario-results.json")
    ap.add_argument("--model")
    ap.add_argument("--only")
    ap.add_argument("--workspace", type=int, help="reuse a workspace that already holds the documents")
    args = ap.parse_args()

    api = Api(args.api, args.secret)
    report = {"model": args.model, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "documents": [], "dates": {},
              "answers": []}

    # ---- documents
    if args.workspace:
        ws_id = args.workspace
    else:
        ws_id = api.call("POST", "/api/v1/workspaces/", {"name": f"Scenarios {time.strftime('%H:%M:%S')}"})["id"]
        uploads = {}
        for f in sorted(Path(args.docs).iterdir()):
            t0 = time.time()
            r = api.upload(ws_id, f)
            uploads[f.name] = (r.get("id") or r.get("document_id") or (r.get("document") or {}).get("id"), t0)
        pending = dict(uploads)
        deadline = time.time() + 1800
        while pending and time.time() < deadline:
            for name, (doc_id, t0) in list(pending.items()):
                s = api.call("GET", f"/api/v1/documents/{ws_id}/documents/{doc_id}/status")
                status = str(s.get("status", "")).lower()
                if "indexed" in status or "failed" in status or "error" in status:
                    report["documents"].append({"file": name, "status": status, "seconds": round(time.time() - t0),
                                                "error": s.get("error_message") or s.get("error")})
                    print(f"  {status:8} {round(time.time() - t0):4}s  {name}", flush=True)
                    del pending[name]
            time.sleep(3)
        for name in pending:
            report["documents"].append({"file": name, "status": "timeout"})
    report["workspace_id"] = ws_id

    # ---- document home
    home = api.call("GET", "/api/v1/dashboard/home")
    shown = {(d["filename"], d["date"]) for d in home.get("dates", [])}
    report["dates"] = {
        "today": home.get("today"),
        "shown": sorted(f"{d} {f} ({x.get('kind')}, {x.get('amount')})" for x in home.get("dates", [])
                        for f, d in [(x["filename"], x["date"])]),
        "missing": [f"{d} {f}" for f, d in EXPECTED_DATES if (f, d) not in shown],
        "unwanted": [f"{d} {f}" for f, d in UNWANTED_DATES if (f, d) in shown],
    }
    print(f"dates: {len(shown)} shown, missing {report['dates']['missing']}, unwanted {report['dates']['unwanted']}",
          flush=True)

    # ---- questions
    only = set(args.only.split(",")) if args.only else None
    chats = {}
    for q in QUESTIONS:
        if only and q["id"] not in only and not (q.get("after") in only):
            continue
        body = {"workspace_id": ws_id, "message": q["q"], "stream": False}
        if args.model:
            body["model"] = args.model
        if q.get("after") in chats:
            body["chat_id"] = chats[q["after"]]
        t0 = time.time()
        try:
            r = api.call("POST", "/api/v1/chat/", body)
            answer, chat_id = r.get("response", ""), r.get("chat_id")
        except Exception as e:
            answer, chat_id = f"ERROR {e}", None
        seconds = round(time.time() - t0)
        chats[q["id"]] = chat_id
        sources, warnings = [], []
        if chat_id:
            msgs = api.call("GET", f"/api/v1/chat/session/{chat_id}").get("messages", [])
            last = [m for m in msgs if m.get("role") == "assistant"][-1:]
            if last and last[0].get("sources"):
                try:
                    src = json.loads(last[0]["sources"]) if isinstance(last[0]["sources"], str) else last[0]["sources"]
                    sources = list(src.get("ws", [])) + list(src.get("kb", []))
                    warnings = list(src.get("warnings") or [])
                except (ValueError, AttributeError):
                    pass
        failed, notes = check(q, answer, sources, warnings)
        report["answers"].append({"id": q["id"], "tests": q["tests"], "q": q["q"], "answer": answer,
                                  "sources": sources, "warnings": warnings, "seconds": seconds, "ok": not failed, "failed": failed,
                                  "notes": notes})
        print(f"{'PASS' if not failed else 'FAIL'} {seconds:4}s {q['id']:16} {'; '.join(failed + notes)[:160]}",
              flush=True)
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1))

    passed = sum(a["ok"] for a in report["answers"])
    print(f"\n{passed}/{len(report['answers'])} answers pass; dates missing {len(report['dates']['missing'])}, "
          f"unwanted {len(report['dates']['unwanted'])}")
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
