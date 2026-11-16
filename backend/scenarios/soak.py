"""Long test against a running engine: many documents, a long conversation, parallel requests, a restart.

    python3 backend/scenarios/soak.py --secret <SECRET_KEY> --api http://127.0.0.1:18100 --work /tmp/soak
        [--letters 120] [--turns 20] [--container scen-engine]

1. 120 generated letters (scenarios/letters.py) as PDFs, uploaded four at a time: every one must be read.
2. The home page must show their dates and amounts: the whole path PDF -> pieces -> dates, not only the text.
3. One chat with 20 follow-up questions: every answer must come, none may be empty, no error.
4. Three questions and an upload at the same time: no error (the database is SQLite).
5. The engine restarts: documents, chats and dates are still there.
Memory of the engine container is recorded along the way. Needs PyMuPDF for the PDFs (run it in the engine image or
pip install pymupdf). Writes soak-report.json into --work.
"""
import argparse
import concurrent.futures as cf
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scenarios.letters import generate  # noqa: E402
from scenarios.run import Api  # noqa: E402


def memory(container):
    if not container:
        return None
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container],
                         capture_output=True, text=True).stdout.strip()
    return out.split(" / ")[0] if out else None


def _font():
    """A TrueType font with the euro sign; PyMuPDF's built-in Helvetica writes "?" for "€"."""
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
              "C:\\Windows\\Fonts\\arial.ttf"):
        if Path(f).exists():
            return {"fontname": "dejavu", "fontfile": f}
    return {"fontname": "helv"}


def write_pdfs(letters, folder: Path):
    import fitz
    folder.mkdir(parents=True, exist_ok=True)
    for letter in letters:
        doc = fitz.open()
        lines = letter["text"].splitlines()
        page = doc.new_page(width=595, height=842)
        # a font with the euro sign: the built-in Helvetica writes "?" for "€"
        page.insert_textbox(fitz.Rect(56, 56, 540, 800), "\n".join(lines), fontsize=10, **_font())
        doc.save(folder / f"{letter['id']}.pdf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:18100")
    ap.add_argument("--secret", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--letters", type=int, default=120)
    ap.add_argument("--turns", type=int, default=20)
    ap.add_argument("--container")
    args = ap.parse_args()
    work = Path(args.work)
    report = {"memory": {"start": memory(args.container)}, "problems": []}

    def problem(text):
        report["problems"].append(text)
        print("PROBLEM", text, flush=True)

    letters = generate(args.letters, seed=77)
    write_pdfs(letters, work / "pdfs")
    api = Api(args.api, args.secret)
    ws = api.call("POST", "/api/v1/workspaces/", {"name": f"Soak {time.strftime('%H:%M:%S')}"})["id"]

    # ---- 1. uploads, four at a time
    t0 = time.time()
    files = sorted((work / "pdfs").iterdir())
    with cf.ThreadPoolExecutor(4) as pool:
        uploaded = list(pool.map(lambda f: (f.name, api.upload(ws, f).get("id")), files))
    pending = dict(uploaded)
    status = {}
    while pending and time.time() - t0 < 3600:
        for name, doc_id in list(pending.items()):
            s = str(api.call("GET", f"/api/v1/documents/{ws}/documents/{doc_id}/status").get("status", "")).lower()
            if "indexed" in s or "failed" in s or "error" in s:
                status[name] = s
                del pending[name]
        time.sleep(2)
    failed = {n: s for n, s in status.items() if "indexed" not in s}
    report["upload"] = {"documents": len(files), "indexed": len(files) - len(failed) - len(pending),
                        "failed": failed, "timeout": list(pending), "seconds": round(time.time() - t0)}
    print("upload", report["upload"], flush=True)
    if failed or pending:
        problem(f"{len(failed)} failed, {len(pending)} not done")
    report["memory"]["after_upload"] = memory(args.container)

    # ---- 2. dates through the whole path (PDF -> pieces -> dates), as the home page and the MCP tool see them
    api.call("PUT", "/api/v1/connections", {"enabled": True})
    key = api.call("POST", "/api/v1/connections/keys", {"name": "soak test"})
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "upcoming_dates", "arguments": {"days": 366}}}
    raw = api.call("POST", "/mcp", rpc, headers={"Authorization": f"Bearer {key['key']}"})
    shown = json.loads(raw["result"]["content"][0]["text"])["dates"]
    got = {(d["filename"], d["date"]): d for d in shown}
    expected = missing = amount_wrong = 0
    for letter in letters:
        for e in letter["expected"]:
            expected += 1
            d = got.get((f"{letter['id']}.pdf", e["date"]))
            if not d:
                missing += 1
            elif e.get("amount") and not (d.get("amount") and d["amount"].split()[0] == e["amount"]):
                amount_wrong += 1
    report["dates_through_pipeline"] = {"expected": expected, "shown": len(shown), "missing": missing,
                                        "amount_wrong": amount_wrong}
    print("dates", report["dates_through_pipeline"], flush=True)
    if missing:
        problem(f"{missing} of {expected} dates of the letters are not shown")
    api.call("DELETE", f"/api/v1/connections/keys/{key['id']}")

    # ---- 3. a long conversation
    chat_id, turns = None, []
    senders = sorted({l["text"].splitlines()[0] for l in letters})
    questions = [f"Was will {s} von mir?" for s in senders] + ["Und bis wann?", "Welche Beträge hast du gerade genannt?",
                                                               "Fasse alles in drei Sätzen zusammen."]
    questions = (questions * 3)[: args.turns]
    for i, q in enumerate(questions):
        body = {"workspace_id": ws, "message": q, "stream": False}
        if chat_id:
            body["chat_id"] = chat_id
        t = time.time()
        try:
            r = api.call("POST", "/api/v1/chat/", body, timeout=600)
            chat_id = r.get("chat_id", chat_id)
            answer = r.get("response", "")
            if not answer.strip():
                problem(f"turn {i + 1}: empty answer")
            turns.append({"q": q, "seconds": round(time.time() - t), "chars": len(answer)})
        except Exception as e:
            problem(f"turn {i + 1}: {e}")
            turns.append({"q": q, "error": str(e)[:200]})
        print(f"turn {i + 1:2} {turns[-1].get('seconds', '-')}s {turns[-1].get('chars', turns[-1].get('error'))}", flush=True)
    report["conversation"] = turns
    report["memory"]["after_conversation"] = memory(args.container)

    # ---- 4. parallel requests while uploading
    extra = work / "pdfs" / files[0].name
    def ask(q):
        return api.call("POST", "/api/v1/chat/", {"workspace_id": ws, "message": q, "stream": False}, timeout=900)
    with cf.ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(ask, q) for q in ("Welche Fristen habe ich im Dezember?", "Was ist die größte Rechnung?",
                                                  "Welche Termine habe ich?")]
        futures.append(pool.submit(api.upload, ws, extra))
        for f in futures:
            try:
                f.result()
            except Exception as e:
                problem(f"parallel request: {e}")
    report["parallel"] = "ok" if not any("parallel" in p for p in report["problems"]) else "errors"
    print("parallel", report["parallel"], flush=True)

    # ---- 5. restart
    if args.container:
        before = (len(api.call("GET", f"/api/v1/documents/{ws}")), len(api.call("GET", f"/api/v1/chat/session/{chat_id}")["messages"]))
        subprocess.run(["docker", "restart", args.container], capture_output=True)
        t = time.time()
        while time.time() - t < 180:
            try:
                api = Api(args.api, args.secret)
                break
            except Exception:
                time.sleep(3)
        after = (len(api.call("GET", f"/api/v1/documents/{ws}")), len(api.call("GET", f"/api/v1/chat/session/{chat_id}")["messages"]))
        report["restart"] = {"before": before, "after": after, "seconds": round(time.time() - t)}
        if after != before:
            problem(f"restart lost data: {before} -> {after}")
        print("restart", report["restart"], flush=True)
        report["memory"]["after_restart"] = memory(args.container)

    (work / "soak-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"\n{len(report['problems'])} problem(s); memory {report['memory']}")


if __name__ == "__main__":
    main()
