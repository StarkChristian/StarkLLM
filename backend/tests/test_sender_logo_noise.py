"""The OCR of a logo in front of the letterhead is not part of the sender's name (Android 0.4.0 phone test)."""
from app.services.facts_service import sender


def name(first_line):
    fact = sender({1: first_line + "\nMusterstrasse 1\n12345 Musterstadt\nRechnung"})
    return fact and fact.get("value")


def test_logo_noise_is_left_out():
    assert name("Oo Orneksehir Elektrik A.S.") == "Orneksehir Elektrik A.S."
    assert name("© Stadtwerke Musterstadt GmbH") == "Stadtwerke Musterstadt GmbH"
    assert name("» Sampleton Water Ltd") == "Sampleton Water Ltd"


def test_real_short_names_stay():
    assert name("AB Energie GmbH") == "AB Energie GmbH"
    assert name("EWE AG") == "EWE AG"
    assert name("E.ON Energie Deutschland") == "E.ON Energie Deutschland"
    assert name("Stadtwerke Musterstadt GmbH") == "Stadtwerke Musterstadt GmbH"
