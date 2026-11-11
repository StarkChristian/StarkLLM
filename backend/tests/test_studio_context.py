"""Studio must give the model the text StarkLLM read from a file, never the raw bytes of a binary file
(2.0.11 sent JPEG bytes and the briefing said the data was corrupt)."""
from types import SimpleNamespace

from app.api.studio import _document_text, _ground_rules


class FakeCollection:
    def __init__(self, by_source):
        self.by_source = by_source

    def get(self, where, include):
        return {"documents": self.by_source.get(where["source"], [])}


def doc(path, file_type, name="x"):
    return SimpleNamespace(filepath=str(path), file_type=file_type, filename=name)


def test_image_uses_indexed_text_not_bytes(tmp_path):
    img = tmp_path / "Parking sign.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01binary")
    col = FakeCollection({str(img): ["Visitor parking: level P2, spaces 40 to 55."]})
    assert _document_text(col, doc(img, "jpg")) == "Visitor parking: level P2, spaces 40 to 55."


def test_binary_without_indexed_text_is_left_out(tmp_path):
    xlsx = tmp_path / "Inventory.xlsx"
    xlsx.write_bytes(b"PK\x03\x04\x14\x00binary zip")
    assert _document_text(FakeCollection({}), doc(xlsx, "xlsx")) == ""
    assert _document_text(None, doc(xlsx, "xlsx")) == ""


def test_plain_text_file_is_read_when_not_indexed(tmp_path):
    txt = tmp_path / "Shift handover.txt"
    txt.write_text("Forklift FL-07 out of service.", encoding="utf-8")
    assert "FL-07" in _document_text(FakeCollection({}), doc(txt, "txt"))


def test_rules_name_language_and_date():
    assert "in German" in _ground_rules("de")
    assert "in English" in _ground_rules("en-US")
    assert "language of the documents" in _ground_rules(None)
    assert "Today is 20" in _ground_rules("de")
