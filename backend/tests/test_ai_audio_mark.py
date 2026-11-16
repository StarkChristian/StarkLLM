"""EU AI Act Art. 50(2): speech the engine makes is marked as AI-generated inside the WAV file, and the file still
plays (the mark is a RIFF LIST/INFO chunk that players skip)."""
import wave

import pytest

from app.services.voice_service import AI_MARK, mark_ai_generated


def make_wav(path, frames=b"\x00\x01" * 800):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(frames)


def test_mark_is_in_the_file_and_the_audio_is_unchanged(tmp_path):
    p = tmp_path / "tts.wav"
    make_wav(p)
    mark_ai_generated(str(p))
    raw = p.read_bytes()
    assert AI_MARK.encode() in raw and b"LIST" in raw and b"ISFT" in raw
    assert int.from_bytes(raw[4:8], "little") == len(raw) - 8, "RIFF size covers the new chunk"
    with wave.open(str(p), "rb") as w:
        assert w.getnframes() == 800
        assert w.readframes(800) == b"\x00\x01" * 800


def test_not_a_wav_is_refused(tmp_path):
    p = tmp_path / "x.wav"
    p.write_bytes(b"not audio")
    with pytest.raises(ValueError):
        mark_ai_generated(str(p))
