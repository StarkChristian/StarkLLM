"""Recordings as documents (R3 of docs/roadmap-2026-12.md): a text with times, in passages, indexed like documents."""
import os
import tempfile

import pytest

from app.services import recordings as rec


def test_times():
    assert rec.stamp(0) == "00:00:00"
    assert rec.stamp(12.7) == "00:00:12"
    assert rec.stamp(4000) == "01:06:40"
    assert rec.stamp(None) == "00:00:00"


def test_passages_keep_times_and_split_by_length_and_time():
    segs = [{"start": i * 10, "end": i * 10 + 9, "text": f" sentence number {i} "} for i in range(40)]
    parts = rec.passages(segs, max_chars=300, max_seconds=60)
    assert parts[0]["text"].startswith("[00:00:00] sentence number 0")
    assert all(p["text"].count("\n") + 1 <= 6 for p in parts)  # 60 seconds at most: six segments of 10 s
    assert all(len(p["text"]) <= 300 for p in parts)
    joined = "\n".join(p["text"] for p in parts)
    assert "[00:06:30] sentence number 39" in joined
    assert parts[1]["start"] == 60.0


def test_empty_segments_are_skipped():
    assert rec.passages([{"start": 0, "end": 1, "text": "   "}]) == []


class _Info:
    def __init__(self, duration, language="de"):
        self.duration = duration
        self.language = language


class _Seg:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


class _FakeWhisper:
    def __init__(self, duration=30):
        self.duration = duration
        self.kw = None

    def transcribe(self, path, **kw):
        self.kw = kw
        return iter([_Seg(0.5, 4, "Guten Morgen."), _Seg(5, 9, "Das Budget sind 4200 Euro.")]), _Info(self.duration)


def test_transcribe_uses_the_silence_filter_and_returns_passages():
    model = _FakeWhisper()
    out = rec.transcribe("x.m4a", language="de-DE", model=model)
    assert model.kw["vad_filter"] is True and model.kw["language"] == "de"
    assert out["passages"][0]["text"] == "[00:00:00] Guten Morgen.\n[00:00:05] Das Budget sind 4200 Euro."


def test_too_long_recordings_are_refused():
    with pytest.raises(rec.RecordingError):
        rec.transcribe("x.mp3", model=_FakeWhisper(duration=5 * 3600))


def test_a_recording_becomes_chunks_with_times(monkeypatch):
    from app.services.rag_service import rag_service
    monkeypatch.setattr(rec, "transcribe", lambda path, language=None, model=None: {
        "language": "en", "duration": 200,
        "passages": [{"start": 0.0, "end": 100, "text": "[00:00:00] Hello."}, {"start": 125.4, "end": 200, "text": "[00:02:05] The budget."}]})
    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        f.write(b"\x00" * 10)
    try:
        chunks, metas, ids = rag_service._process_file_to_chunks(f.name)
    finally:
        os.unlink(f.name)
    assert chunks == ["[00:00:00] Hello.", "[00:02:05] The budget."]
    assert metas[1]["locator"] == "Time 00:02:05" and metas[1]["type"] == "recording" and metas[1]["start"] == 125.4


def test_the_upload_accepts_recordings_and_the_lists_match():
    import json
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    js = (root / "frontend/src/utils/uploadTypes.js").read_text(encoding="utf8")
    m = re.search(r"RECORDING_EXTENSIONS = (\[[^\]]*\])", js)
    assert {"." + e for e in json.loads(m.group(1).replace("'", '"'))} == rec.RECORDING_EXTENSIONS


@pytest.mark.skipif(os.environ.get("STARKLLM_REAL_WHISPER") != "1", reason="needs the Whisper model (STARKLLM_REAL_WHISPER=1)")
def test_real_speech_is_written_down_with_times():
    from app.services.voice_service import voice_service
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "memo.wav")
        voice_service.synthesize("Good morning. The budget for December is four thousand two hundred euros.", wav, voice="en_US-lessac-medium")
        out = rec.transcribe(wav, language="en")
    text = " ".join(p["text"] for p in out["passages"]).lower()
    assert text.startswith("[00:00:0")
    assert "budget" in text and "december" in text


def test_without_the_large_model_the_dictation_model_writes_it_down(monkeypatch):
    from app.services import voice_service as vs
    monkeypatch.setattr(rec, "_recording_model", lambda: (None, ""))
    fake = _FakeWhisper()
    monkeypatch.setattr(vs.VoiceService, "model", property(lambda self: fake))
    out = rec.transcribe("x.m4a")
    assert out["model"] == "base"
    assert out["passages"][0]["text"].startswith("[00:00:00] Guten Morgen.")


def test_the_large_model_is_used_when_it_is_there(monkeypatch):
    big = _FakeWhisper()
    monkeypatch.setattr(rec, "_recording_model", lambda: (big, "large-v3-turbo"))
    out = rec.transcribe("x.m4a", language="de")
    assert out["model"] == "large-v3-turbo"
    assert big.kw["vad_filter"] is True


def test_offline_the_download_is_refused_and_nothing_breaks(monkeypatch):
    import builtins
    real_import = builtins.__import__

    class NoModel:
        def __init__(self, name, **kw):
            if kw.get("local_files_only"):
                raise RuntimeError("not on this PC")
            raise RuntimeError("download refused")
    import types
    monkeypatch.setitem(__import__("sys").modules, "faster_whisper", types.SimpleNamespace(WhisperModel=NoModel))
    monkeypatch.setattr(rec, "RECORDING_MODEL", "large-v3-turbo")
    assert rec._recording_model() == (None, "")
    monkeypatch.setattr(rec, "RECORDING_MODEL", "base")
    assert rec._recording_model() == (None, "")
