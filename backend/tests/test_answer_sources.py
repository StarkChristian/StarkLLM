"""The sources line lists the documents an answer used, not every retrieved passage (N36)."""
from app.services.answer_sources import used_labels

INVOICE = {"ui": "en-invoice.pdf (Page 1)", "file": "en-invoice.pdf",
           "passages": ["Example Energy Ltd. Invoice INV-2026-118. Total amount due: GBP 148.90 by 12 December 2026."]}
CONTRACT1 = {"ui": "contract.pdf (Page 1)", "file": "contract.pdf",
             "passages": ["Service agreement between Harbourside Studios and the client. Term: 1 April 2026 to 31 March 2027."]}
CONTRACT3 = {"ui": "contract.pdf (Page 3)", "file": "contract.pdf",
             "passages": ["Either party may terminate with written notice at least 30 days before the end of the term."]}
SCAN = {"ui": "ocr-umlaut-221.png (Image (OCR))", "file": "ocr-umlaut-221.png",
        "passages": ["Gärtnerei Grünfeld KG. Mitteilung über die Größe Ihrer Lieferung: 12 Säcke Blumenerde zu je 40 l."]}
ALL = [INVOICE, CONTRACT1, CONTRACT3, SCAN]


def test_the_answer_from_one_bill_lists_only_that_bill():
    answer = "The total amount due on the Example Energy invoice is GBP 148.90, payable by 12 December 2026 (Page 1)."
    assert used_labels(answer, ALL) == ["en-invoice.pdf (Page 1)"]


def test_a_named_file_counts_and_a_german_answer_finds_its_scan():
    assert used_labels("Laut contract.pdf endet der Vertrag am 31. März 2027.", ALL)[0] == "contract.pdf (Page 1)"
    assert used_labels("Die Gärtnerei Grünfeld KG liefert 12 Säcke Blumenerde zu je 40 Litern.", ALL) == [
        "ocr-umlaut-221.png (Image (OCR))"]


def test_a_refusal_code_or_greeting_uses_no_document():
    assert used_labels("I could not find any information about a potting soil delivery in the documents.", ALL) == []
    assert used_labels("```python\ndef add(a, b):\n    return a + b\n```", ALL) == []
    assert used_labels("Hello! How can I help you today?", ALL) == []


def test_two_documents_used_together_are_both_listed():
    answer = ("The contract runs from 1 April 2026 to 31 March 2027; notice must be given at least 30 days before the "
              "end of the term, so by 1 March 2027.")
    used = used_labels(answer, ALL)
    assert "contract.pdf (Page 1)" in used and "contract.pdf (Page 3)" in used and "en-invoice.pdf (Page 1)" not in used


def test_the_saved_sources_keep_the_used_documents_and_what_was_searched():
    import json
    from app.api.chat import _sources_used
    saved = json.loads(_sources_used(json.dumps({
        "mode": "maybe", "ws": ["en-invoice.pdf (Page 1)", "contract.pdf (Page 1)", "moby-dick.pdf (summary of the whole document)"],
        "kb": [], "evidence": [{**INVOICE, "label": "[en-invoice.pdf, page 1]"}, {**CONTRACT1, "label": "[contract.pdf, page 1]"}]}),
        "The total due is GBP 148.90 by 12 December 2026."))
    assert saved["used"] is True
    assert saved["ws"] == ["en-invoice.pdf (Page 1)", "moby-dick.pdf (summary of the whole document)"]
    assert saved["searched"]["ws"][1] == "contract.pdf (Page 1)"
    assert _sources_used("not json", "x") == "not json"



def test_a_quotation_that_is_not_in_the_passages_is_listed():
    # N44 (MSI night test of 2.3.0): an invented sentence was given as a quote from Moby-Dick, chapter 3
    import json
    from app.api.chat import _sources_used
    from app.services.quote_check import unverified
    page = ("Entering that gable-ended Spouter-Inn, you found yourself in a wide, low, straggling entry with "
            "old-fashioned wainscots. The Spouter Inn:—Peter Coffin.")
    fake = ('In Chapter 3: "Peter Coffin himself, a corpulent, genial old man... and his wife, a very fat, very '
            'good-natured woman, named Houck."')
    real = 'Ishmael says: "you found yourself in a wide, low, straggling entry with old-fashioned wainscots."'
    assert unverified(fake, [page]) and unverified(real, [page]) == []
    assert unverified('He answered "yes" and left.', [page]) == []  # too short to be a quotation
    saved = json.loads(_sources_used(json.dumps({"ws": [], "kb": [], "evidence": []}), fake, [page, ""]))
    assert saved["unverified_quotes"] == [fake.split(': "', 1)[1].rstrip('."') + "."]
