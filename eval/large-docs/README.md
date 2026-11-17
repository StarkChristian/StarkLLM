# Large-document evaluation

Roadmap phase 2 ("large documents and general assistant") is done when StarkLLM answers both kinds of questions about
whole books: specific ones ("what is written on the bottle?") and whole-book ones ("summarize the book", "how does it
end?", "who are the mates?"), and says so when something is not in the book. This folder measures that, before and
after every change of phase 2.

- `make_corpus.py` builds three PDFs from public-domain books (Project Gutenberg, pinned by SHA-256): Moby-Dick
  (English, 550 pages, 136 chapter bookmarks), Alice's Adventures in Wonderland (English, 83 pages) and Effi Briest
  (German, 284 pages), each with `<name>.pages.json` (the text of every page).
- `questions.json` holds 21 questions with what a correct answer must contain and the predicted chance of passing,
  written down before the first run.
- `run.py` uploads the PDFs into a new workspace of a running StarkLLM, waits until they are indexed, asks every
  question in a new chat and writes `results/results.jsonl` (all answers in full) and `results/summary.md`.

```
python make_corpus.py
python run.py --user <account>            # password in STARK_PASSWORD
```

Both scripts run with StarkLLM's own engine Python, which has PyMuPDF and requests:
`%LOCALAPPDATA%\Programs\StarkLLM\resources\engine-native\runtime\python.exe`.

The keyword scoring is only a first filter: read the answers. `corpus/` and `results/` are not committed.
