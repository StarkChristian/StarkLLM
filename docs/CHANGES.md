# How changes are made

Every change, from a typo to a new engine, goes the same way. What differs is how much evidence it needs; that
depends on what can go wrong, not on how big the diff is. The rules behind this are in [RULES.md](RULES.md).

## The way

1. **Start from a finding.** A bug, a test result, a user report or a roadmap item. Write down what is wrong or
   missing in one or two sentences; it becomes the *Why* of the pull request.
2. **Branch from `main`** (or from the pull request it builds on, and say so).
3. **Change, and add the test that would have caught it.** A fix without a test may come back.
4. **Open a pull request** with the template. Pick the class below and tick what it needs.
5. **Checks must be green** (backend tests, German UI, build, languages). Windows and other workflows run when their
   files change.
6. **The owner reviews and merges** (R1). Pull requests that build on each other are merged in order; the next one is
   then pointed at `main`.
7. **Release** with the release checklist.

## Classes

| Class | Examples | Needs, besides Checks |
|---|---|---|
| **S** small | text, styling, docs, a theme | a screenshot if it changes what users see |
| **F** feature | new screen, new endpoint, new setting | tests for the new behaviour; German texts; privacy note if it touches the network or stored data |
| **A** answers | prompt, retrieval, chunking, document checks, model settings | **F**, plus `backend/scenarios` before and after with the same model; the numbers and any new failure in the pull request (R4) |
| **R** risky | installer, updater, engine start, data migration, security, signing | **F**, plus the Windows workflows, one fresh install and one update from the last release on a real Windows PC, and how to go back if it fails (R5) |

When in doubt, take the higher class.

## Measuring answers (class A)

```
python -m scenarios.make_documents /tmp/docs                     # in backend/, needs Pillow and PyMuPDF
python3 backend/scenarios/run.py --secret <SECRET_KEY> --docs /tmp/docs --api http://127.0.0.1:8000 --out after.json
```

- Run *before* (on `main`) and *after* (on the branch) with the same model, so the numbers can be compared.
- A small model varies from run to run. On the 33 questions with `qwen2.5:3b`, two runs of the same code differ by a
  few answers. Look at *which* questions changed, not only at the total. A question that fails in both runs
  after, and passed in both before, is a regression.
- Warnings and dates are checked without the model too. They must not get worse at all: no missed scam, no new false
  alarm, no missing date (R8, R9).
- New behaviour gets new scenarios: add the letter to `documents.py` and the question to `questions.py`, with what
  the answer must and must not say.

## When something goes wrong

1. Fix it, and add the test that would have caught it.
2. Ask: would a check have caught it before release? If yes, add the check (a test, a CI step).
3. Only if the harm was severe, or the same kind of mistake happened before, add a rule to RULES.md, with its
   reason and its review (principle 1 there).
4. Write what happened and why in the pull request, so the next person understands the test.
