"""Encryption primitives (B6/B7): stored values, chunked streams, protected files, the passphrase key."""
import io
import os

import pytest

from app.core import crypto

KEY = crypto.new_key()
OTHER = crypto.new_key()


def test_derived_keys_are_independent_per_purpose():
    assert crypto.derive_key(KEY, "files") != crypto.derive_key(KEY, "fields")
    assert crypto.derive_key(KEY, "files") == crypto.derive_key(KEY, "files")
    assert crypto.key_id(KEY) != crypto.key_id(OTHER)


def test_text_round_trip_and_is_not_readable():
    token = crypto.encrypt_text(KEY, "Kündigung Mietvertrag Müller", "messages.content")
    assert crypto.is_token(token) and "Müller" not in token
    assert crypto.decrypt_text(KEY, token, "messages.content") == "Kündigung Mietvertrag Müller"
    assert crypto.encrypt_text(KEY, "same", "x") != crypto.encrypt_text(KEY, "same", "x")   # fresh nonce every time


def test_text_wrong_key_wrong_column_and_changes_are_refused():
    token = crypto.encrypt_text(KEY, "secret", "a.b")
    with pytest.raises(crypto.WrongKey):
        crypto.decrypt_text(OTHER, token, "a.b")
    with pytest.raises(crypto.CorruptData):
        crypto.decrypt_text(KEY, token, "other.column")      # a value moved into another column
    flipped = token[:-3] + ("AAA" if not token.endswith("AAA") else "BBB")
    with pytest.raises(crypto.CorruptData):
        crypto.decrypt_text(KEY, flipped, "a.b")
    with pytest.raises(crypto.CorruptData):
        crypto.decrypt_text(KEY, crypto.TOKEN_PREFIX + "garbage", "a.b")


def _encrypt(data: bytes, key=KEY, header=b"HDR-0123456789"):
    out = io.BytesIO()
    with crypto.StreamWriter(out, key, header) as w:
        w.write(data)
    return out.getvalue()


def _decrypt(blob: bytes, key=KEY, header_len=14):
    return b"".join(crypto.read_stream(io.BytesIO(blob), key, header_len))


@pytest.mark.parametrize("size", [0, 1, 100, crypto.CHUNK - 1, crypto.CHUNK, crypto.CHUNK + 1, 3 * crypto.CHUNK,
                                  3 * crypto.CHUNK + 17])
def test_stream_round_trip_at_chunk_boundaries(size):
    data = os.urandom(size)
    assert _decrypt(_encrypt(data)) == data


def test_stream_written_in_small_pieces_equals_one_write():
    data = os.urandom(crypto.CHUNK * 2 + 5)
    out = io.BytesIO()
    with crypto.StreamWriter(out, KEY, b"HDR-0123456789") as w:
        for i in range(0, len(data), 7919):
            w.write(data[i:i + 7919])
    assert _decrypt(out.getvalue()) == data


def test_stream_truncation_is_detected_everywhere():
    blob = _encrypt(os.urandom(crypto.CHUNK * 2 + 100))
    for cut in (len(blob) - 1, len(blob) - 16, crypto.CHUNK + 40, 14 + 5, 14, 5):
        with pytest.raises(crypto.CryptoError):
            _decrypt(blob[:cut])


def test_stream_cut_exactly_at_a_chunk_boundary_is_detected():
    blob = _encrypt(os.urandom(crypto.CHUNK * 3))
    boundary = 14 + 2 * (crypto.CHUNK + crypto.TAG_LEN)
    with pytest.raises(crypto.CorruptData):
        _decrypt(blob[:boundary])


def test_stream_changed_byte_extra_data_and_reordering_are_detected():
    data = os.urandom(crypto.CHUNK * 2 + 10)
    blob = bytearray(_encrypt(data))
    for position in (14 + 3, 14 + crypto.CHUNK + 20, len(blob) - 5):
        broken = bytearray(blob)
        broken[position] ^= 0x01
        with pytest.raises(crypto.CryptoError):
            _decrypt(bytes(broken))
    with pytest.raises(crypto.CryptoError):
        _decrypt(bytes(blob) + b"extra")
    size = crypto.CHUNK + crypto.TAG_LEN
    swapped = bytes(blob[:14]) + bytes(blob[14 + size:14 + 2 * size]) + bytes(blob[14:14 + size]) + bytes(blob[14 + 2 * size:])
    with pytest.raises(crypto.CryptoError):
        _decrypt(swapped)


def test_stream_wrong_key_and_changed_header_are_refused():
    blob = _encrypt(b"hello world")
    with pytest.raises(crypto.WrongKey):
        _decrypt(blob, key=OTHER)
    changed = bytearray(blob)
    changed[2] ^= 1
    with pytest.raises(crypto.CryptoError):
        _decrypt(bytes(changed))


def test_protected_files_round_trip_size_and_detection(tmp_path):
    path = str(tmp_path / "doc.pdf")
    for n in (0, 5, crypto.CHUNK, crypto.CHUNK + 1, 2 * crypto.CHUNK + 3):
        data = os.urandom(n)
        crypto.encrypt_bytes_to_file(path, KEY, data)
        assert crypto.is_encrypted_file(path)
        assert crypto.decrypt_file_bytes(path, KEY) == data
        assert crypto.plain_size(os.path.getsize(path)) == n
    with open(path, "wb") as f:
        f.write(b"%PDF-1.4 plain")
    assert not crypto.is_encrypted_file(path)
    assert not crypto.is_encrypted_file(str(tmp_path / "missing"))


def test_protected_file_wrong_key_and_plain_file(tmp_path):
    path = str(tmp_path / "a.txt")
    crypto.encrypt_bytes_to_file(path, KEY, b"letter")
    with pytest.raises(crypto.WrongKey):
        crypto.decrypt_file_bytes(path, OTHER)
    plain = tmp_path / "b.txt"
    plain.write_bytes(b"not protected at all, long enough to have a header")
    with pytest.raises(crypto.CorruptData):
        crypto.decrypt_file_bytes(str(plain), KEY)


def test_passphrase_key_is_deterministic_and_checks_limits():
    kdf = dict(time_cost=1, memory_kib=64, parallelism=1)
    salt = os.urandom(16)
    assert crypto.passphrase_key("correct horse", salt, **kdf) == crypto.passphrase_key("correct horse", salt, **kdf)
    assert crypto.passphrase_key("correct horse", salt, **kdf) != crypto.passphrase_key("correct horsf", salt, **kdf)
    assert crypto.passphrase_key("correct horse", salt, **kdf) != crypto.passphrase_key("correct horse", os.urandom(16), **kdf)
    with pytest.raises(crypto.CorruptData):
        crypto.passphrase_key("x", salt, time_cost=1, memory_kib=64 * 1024 * 1024, parallelism=1)
