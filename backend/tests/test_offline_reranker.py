"""The search reranker's model ships in the engine image; it is not fetched from the internet on the user's PC."""
from app.services.rag_service import reranker_dir


def test_the_shipped_model_is_used_when_present(tmp_path, monkeypatch):
    (tmp_path / "ms-marco-TinyBERT-L-2-v2").mkdir()
    monkeypatch.setenv("STARKLLM_RERANKER_DIR", str(tmp_path))
    assert reranker_dir() == str(tmp_path)


def test_without_a_shipped_model_it_is_kept_in_the_data_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("STARKLLM_RERANKER_DIR", str(tmp_path))  # folder exists, model does not
    assert reranker_dir() == "./data/models"
    monkeypatch.delenv("STARKLLM_RERANKER_DIR")
    assert reranker_dir() == "./data/models"


def test_the_engine_image_ships_the_model():
    from pathlib import Path
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
    assert "STARKLLM_RERANKER_DIR=/opt/starkllm-models" in dockerfile and "ms-marco-TinyBERT-L-2-v2" in dockerfile
