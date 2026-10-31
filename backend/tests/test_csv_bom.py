"""Windows editors save UTF-8 with a byte-order mark. It used to stay in the text, so a CSV header was indexed as
"ï»¿item,color,code" (found on a real PC, 26 October 2026)."""
from pathlib import Path

from app.services.rag_service import rag_service

KB_SERVICE = Path(__file__).resolve().parents[1] / "app" / "services" / "kb_service.py"


def test_csv_with_bom_is_indexed_without_it(tmp_path):
    f = tmp_path / "colors.csv"
    f.write_bytes("item,color,code\nCrate,blue,CRATE-77-BLUE\n".encode("utf-8-sig"))
    chunks, _, _ = rag_service._process_file_to_chunks(str(f))
    text = "\n".join(chunks)
    assert "﻿" not in text and "ï»¿" not in text
    assert "Columns: item,color,code" in text and "CRATE-77-BLUE" in text


def test_csv_without_bom_is_unchanged(tmp_path):
    f = tmp_path / "plain.csv"
    f.write_text("item,code\nLamp,L-1\n", encoding="utf-8")
    chunks, _, _ = rag_service._process_file_to_chunks(str(f))
    assert "Columns: item,code" in "\n".join(chunks)


def test_knowledge_base_reads_text_files_without_the_bom():
    src = KB_SERVICE.read_text(encoding="utf-8")
    assert 'encoding="utf-8",' not in src and src.count('encoding="utf-8-sig"') >= 2
