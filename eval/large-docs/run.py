"""Large-document evaluation (roadmap phase 2): asks a running StarkLLM the pre-registered questions about three books
and scores the answers. Run make_corpus.py first.

    python run.py --user NAME            (password from the STARK_PASSWORD environment variable)
    python run.py --token TOKEN          (an access token of the app)
    python run.py --desktop-key-file %APPDATA%\\StarkLLM\\secret.key   (the local user of the desktop app on this PC)
  options: --base http://127.0.0.1:5173  --only M1,A2  --workspace ID (reuse one with the books)  --out results

It creates a workspace "Large documents <date>", uploads the PDFs, waits until they are indexed, then asks every
question in a new chat. Results: <out>/results.jsonl (every answer in full) and <out>/summary.md. Uses StarkLLM's
own engine Python if you like (it has requests): resources\\engine-native\\runtime\\python.exe.

Scoring is by keywords (see questions.json) and only a first filter: read the answers in results.jsonl too.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse

import requests

HERE = pathlib.Path(__file__).parent
# an answer that says the book does not tell (English and German)
REFUSAL = re.compile(r"\bnot (mention|name|give|state|said|say|found|specif|provid|reveal|known|in the|clear)\w*|\b(does|do|did)(n't| not) (\w+ )?(say|mention|give|state|name|reveal|provide|tell|specify)\w*|"
                     r"\bnever (\w+ )?(name|mention|give|gave|say|said|state|reveal|tell|told)\w*|\bno (mention|information|name)\b|\bunknown\b|isn't (given|named|mentioned|stated)|"
                     r"nicht (genannt|erwähnt|angegeben|bekannt|enthalten|zu finden|gefunden|im |aus dem|hervor)\w*|keine (Angabe|Information|Hinweis)\w*|wird nicht|steht nicht|unbekannt|geht nicht hervor", re.I)


class Api:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/") + "/api/v1"
        self.s = requests.Session()
        if token:
            self.s.headers["Authorization"] = f"Bearer {token}"

    def req(self, method, path, **kw):
        kw.setdefault("timeout", 1800)
        return self.s.request(method, self.base + path, **kw)


def sign_in(a, args):
    if args.token:
        return args.token
    if args.desktop_key_file:
        secret = pathlib.Path(args.desktop_key_file).read_text(encoding="utf-8").strip()
        key = hmac.new(secret.encode(), b"starkllm-desktop-session", hashlib.sha256).hexdigest()
        r = a.req("POST", "/auth/desktop-session", headers={"X-Desktop-Key": key})
    else:
        r = a.req("POST", "/auth/login", data={"username": args.user, "password": os.environ.get("STARK_PASSWORD", "")})
    r.raise_for_status()
    return r.json()["access_token"]


def wait_indexed(a, ws, doc_id, limit_s=7200):
    t0 = time.time()
    while time.time() - t0 < limit_s:
        j = a.req("GET", f"/documents/{ws}/documents/{doc_id}/status").json()
        if j.get("status") in ("indexed", "failed", "missing"):
            j["seconds"] = round(time.time() - t0)
            return j
        time.sleep(5)
    return {"status": "TIMEOUT", "seconds": limit_s}


def ask(a, ws, question, model=None):
    body = {"workspace_id": ws, "message": question, "stream": False, "temperature": 0}
    if model:
        body["model"] = model
    t0 = time.time()
    r = a.req("POST", "/chat/", json=body)
    took = round(time.time() - t0, 1)
    if r.status_code != 200:
        return {"http": r.status_code, "answer": r.text[:500], "seconds": took, "sources": []}
    sources = [s for s in urllib.parse.unquote(r.headers.get("X-WS-Sources", "")).split("|") if s]
    return {"http": 200, "answer": r.json().get("response", ""), "seconds": took, "sources": sources}


def found(answer, spellings):
    low = answer.lower()
    return any(s.lower() in low for s in spellings)


def score(q, answer):
    if q["kind"] == "fact":
        ok = found(answer, q["expect_any"])
        return ok, ("found" if ok else "expected one of " + ", ".join(q["expect_any"]))
    if q["kind"] == "list":
        hits = [items[0] for items in q["items"] if found(answer, items)]
        return len(hits) >= q["min"], f"{len(hits)} of {len(q['items'])} (need {q['min']}): {', '.join(hits)}"
    if q["kind"] == "unanswerable":
        bad = [f for f in q.get("forbid", []) if f.lower() in answer.lower()]
        if q.get("forbid_regex") and re.search(q["forbid_regex"], answer):
            bad.append(re.search(q["forbid_regex"], answer).group(0))
        said = bool(REFUSAL.search(answer))
        return said and not bad, ("says it is not in the book" if said else "does not say it is not in the book") + (f"; invented: {', '.join(bad)}" if bad else "")
    raise ValueError(q["kind"])


def cited_pages(sources, pdf_name):
    pages = []
    for s in sources:
        if pdf_name in s:
            pages += [int(n) for n in re.findall(r"Page (\d+)", s)]
    return pages


def citation_check(q, sources, corpus):
    """True when a cited page (+-1) of the right book contains the evidence phrase; None without evidence."""
    if not q.get("evidence"):
        return None
    pdf = q["_pdf"]
    texts = json.loads((corpus / pdf.replace(".pdf", ".pages.json")).read_text(encoding="utf-8"))
    evidence = q["evidence"].lower()
    good = {i + 1 for i, t in enumerate(texts) if evidence in t.replace("\n", " ").lower()}
    cited = cited_pages(sources, pdf)
    return any(p + d in good for p in cited for d in (-1, 0, 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:5173")
    ap.add_argument("--user")
    ap.add_argument("--token")
    ap.add_argument("--desktop-key-file")
    ap.add_argument("--workspace", type=int)
    ap.add_argument("--only", default="")
    ap.add_argument("--model")
    ap.add_argument("--corpus", default=str(HERE / "corpus"))
    ap.add_argument("--out", default=str(HERE / "results"))
    args = ap.parse_args()
    if not (args.user or args.token or args.desktop_key_file):
        sys.exit("give --user (with STARK_PASSWORD), --token or --desktop-key-file")

    spec = json.loads((HERE / "questions.json").read_text(encoding="utf-8"))
    corpus, out = pathlib.Path(args.corpus), pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    questions = [q for q in spec["questions"] if not only or q["id"] in only]
    for q in questions:
        q["_pdf"] = spec["documents"][q["doc"]]

    a = Api(args.base)
    a = Api(args.base, sign_in(a, args))
    version = a.req("GET", "/version").json()
    log = (out / "results.jsonl").open("a", encoding="utf-8")

    def rec(**kw):
        kw["t"] = datetime.datetime.now().isoformat(timespec="seconds")
        log.write(json.dumps(kw, ensure_ascii=False) + "\n")
        log.flush()
        print(json.dumps({k: (v if len(str(v)) < 140 else str(v)[:140] + "...") for k, v in kw.items()}, ensure_ascii=False))

    ws = args.workspace
    if not ws:
        ws = a.req("POST", "/workspaces/", json={"name": f"Large documents {datetime.date.today()}"}).json()["id"]
        for name in sorted({q["_pdf"] for q in questions}):
            p = corpus / name
            r = a.req("POST", f"/documents/{ws}/upload", files={"file": (name, p.read_bytes(), "application/pdf")})
            r.raise_for_status()
            st = wait_indexed(a, ws, r.json()["id"])
            rec(step="index", file=name, status=st.get("status"), seconds=st.get("seconds"), error=st.get("error_message"))
    rec(step="start", version=version, workspace=ws, questions=len(questions))

    rows = []
    for q in questions:
        r = ask(a, ws, q["q"], args.model)
        ok, why = score(q, r["answer"]) if r["http"] == 200 else (False, f"HTTP {r['http']}")
        cite = citation_check(q, r["sources"], corpus) if r["http"] == 200 else None
        rows.append({**q, "pass": ok, "why": why, "cite": cite, "seconds": r["seconds"]})
        rec(step="question", id=q["id"], scope=q["scope"], kind=q["kind"], passed=ok, why=why, cite_ok=cite, seconds=r["seconds"],
            predicted=q["p"], question=q["q"], answer=r["answer"], sources=r["sources"])

    def rate(sel):
        sel = list(sel)
        return f"{sum(r['pass'] for r in sel)} of {len(sel)}" if sel else "-"

    lines = [f"# Large documents: {version.get('version')} ({datetime.datetime.now():%Y-%m-%d %H:%M})", "",
             f"- all: {rate(rows)} (predicted {sum(r['p'] for r in rows):.1f})",
             f"- specific questions: {rate(r for r in rows if r['scope'] == 'specific')}",
             f"- whole-book questions: {rate(r for r in rows if r['scope'] == 'global')}",
             f"- 'not in the book' questions: {rate(r for r in rows if r['kind'] == 'unanswerable')}",
             f"- citations on the right page: {sum(1 for r in rows if r['cite'])} of {sum(1 for r in rows if r['cite'] is not None)}",
             f"- median answer time: {sorted(r['seconds'] for r in rows)[len(rows) // 2] if rows else '-'} s", "",
             "| id | scope | pass | predicted | why | cite | s |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['id']} | {r['scope']} | {'yes' if r['pass'] else 'no'} | {r['p']:.0%} | {r['why']} | {'' if r['cite'] is None else ('ok' if r['cite'] else 'no')} | {r['seconds']} |")
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
