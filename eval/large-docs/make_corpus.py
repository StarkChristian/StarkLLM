"""Builds the test documents of the large-document evaluation (roadmap phase 2) from public-domain books.

Three books from Project Gutenberg, pinned by SHA-256, rendered as PDFs with page numbers and chapter bookmarks:
  moby-dick.pdf    Herman Melville, Moby-Dick (English, the long one: 500+ pages)
  alice.pdf        Lewis Carroll, Alice's Adventures in Wonderland (English, short)
  effi-briest.pdf  Theodor Fontane, Effi Briest (German)
Next to each PDF, <name>.pages.json holds the text of every page (run.py uses it to check cited pages).

    python make_corpus.py [--out corpus]

Needs PyMuPDF (fitz): StarkLLM's own engine Python has it
(%LOCALAPPDATA%\\Programs\\StarkLLM\\resources\\engine-native\\runtime\\python.exe).
"""
import argparse
import hashlib
import json
import pathlib
import re
import textwrap
import urllib.request

try:
    import pymupdf as fitz
except ImportError:  # older PyMuPDF
    import fitz

# www.gutenberg.org itself was down for maintenance on 17 Nov 2026; the files are the same on every mirror
MIRRORS = ["https://mirrors.xmission.com/gutenberg", "http://aleph.gutenberg.org", "https://gutenberg.pglaf.org"]
BOOKS = [
    {"name": "moby-dick", "path": "2/7/0/2701/2701-0.txt", "sha256": "f12eb530502755ef2b8f535e2ecef3e95802eab584e60ac7992ccf856256fdbe",
     "title": "Moby-Dick; or, The Whale", "author": "Herman Melville", "chapter": r"^(CHAPTER \d+\. .+|Epilogue)$", "last_of_each": True},
    {"name": "alice", "path": "1/11/11-0.txt", "sha256": "a3a27f8edbf7fcd9b8ba8435494440e24952deaa3e2f2d65192d4cb7ca403754",
     "title": "Alice's Adventures in Wonderland", "author": "Lewis Carroll", "chapter": r"^CHAPTER [IVXL]+\.$", "last_of_each": False},
    {"name": "effi-briest", "path": "5/3/2/5323/5323-0.txt", "sha256": "f582a4b31c666cfb188fbf95963a3dbe22aa45a51c5ae6658cbb3392a5969241",
     "title": "Effi Briest", "author": "Theodor Fontane", "chapter": r"^\w+ Kapitel$", "last_of_each": False},
]

# A4, 12 pt, 40 lines of at most 70 characters: about 2,400 characters a page (Moby-Dick: 500+ pages)
WIDTH, LINES, SIZE, LEADING, LEFT, TOP = 70, 40, 12, 17.5, 72, 80


def fetch(book):
    for m in MIRRORS:
        try:
            with urllib.request.urlopen(f"{m}/{book['path']}", timeout=180) as r:
                data = r.read()
        except Exception as e:  # next mirror
            print(f"  {m}: {e}")
            continue
        if hashlib.sha256(data).hexdigest() == book["sha256"]:
            return data.decode("utf-8")
        print(f"  {m}: different file (SHA-256), skipped")
    raise SystemExit(f"{book['name']}: no mirror delivered the pinned file")


def body(text):
    """The book without Project Gutenberg's header and licence."""
    text = text.replace("\r\n", "\n")
    start = re.search(r"^\*\*\* START OF.*\*\*\*$", text, re.M)
    end = re.search(r"^\*\*\* END OF.*\*\*\*$", text, re.M)
    return text[start.end() if start else 0:end.start() if end else len(text)].strip("\n")


def layout(text):
    """Lines of the book, wrapped; paragraphs keep their blank line."""
    out = []
    for para in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in para.split("\n")]
        joined = " ".join(l for l in lines if l)
        if not joined:
            continue
        # headings and short verse lines stay as they are
        if all(len(l) < WIDTH for l in lines) and len(lines) <= 3 and len(joined) < 60:
            out.extend(l for l in lines if l)
        else:
            out.extend(textwrap.wrap(joined, WIDTH, break_on_hyphens=False))
        out.append("")
    return out


def render(book, lines, out_dir):
    doc = fitz.open()
    pages, page_lines = [], []
    chapter_re = re.compile(book["chapter"])
    toc = {}
    for i in range(0, len(lines), LINES):
        chunk = lines[i:i + LINES]
        page = doc.new_page(width=595, height=842)
        y = TOP
        for line in chunk:
            safe = line.encode("cp1252", "replace").decode("cp1252")
            if safe:
                page.insert_text((LEFT, y), safe, fontsize=SIZE, fontname="helv")
            if chapter_re.match(line):
                key = line
                if book["last_of_each"] or key not in toc:
                    toc[key] = doc.page_count  # 1-based page number of the heading
            y += LEADING
        page.insert_text((297 - 10, 842 - 40), str(doc.page_count), fontsize=10, fontname="helv")
        pages.append("\n".join(chunk))
    doc.set_metadata({"title": book["title"], "author": book["author"]})
    doc.set_toc([[1, title, pno] for title, pno in sorted(toc.items(), key=lambda kv: kv[1])])
    pdf = out_dir / f"{book['name']}.pdf"
    doc.save(pdf, garbage=3, deflate=True)
    (out_dir / f"{book['name']}.pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    return pdf, len(pages), len(toc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(pathlib.Path(__file__).parent / "corpus"))
    out_dir = pathlib.Path(ap.parse_args().out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for book in BOOKS:
        print(f"{book['name']}: downloading")
        pdf, n, chapters = render(book, layout(body(fetch(book))), out_dir)
        print(f"  {pdf.name}: {n} pages, {chapters} chapters, {pdf.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
