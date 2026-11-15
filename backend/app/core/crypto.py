"""Encryption primitives for protection at rest (B6) and encrypted backups (B7).

Only well-reviewed building blocks are used, from the `cryptography` and `argon2-cffi` packages:

* AES-256-GCM for every encryption (authenticated: a changed byte is always detected),
* HKDF-SHA256 to derive one key per purpose from the data key,
* Argon2id to turn a backup passphrase into a key.

Nothing here invents a cipher or a mode. The two formats below only decide how data is cut into pieces:

Stored values ("tokens"):   $sllm-enc1$<key id>$<base64url(nonce || ciphertext || tag)>
Streams (files, backups):   header | chunk | chunk | ... | final chunk
    every chunk is AES-256-GCM with a nonce that is its counter, the header and the counter and a "final" flag are
    authenticated data. So chunks cannot be reordered, dropped, repeated or cut off at the end without detection.
"""
import base64
import hashlib
import hmac
import os
import struct
from typing import BinaryIO, Iterator

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEY_LEN = 32
CHUNK = 1024 * 1024            # plaintext bytes per chunk
TAG_LEN = 16
FILE_MAGIC = b"SLLMENC\x01"    # protected file, format version 1
BACKUP_MAGIC = b"SLLMBKP\x01"  # encrypted backup, format version 1
TOKEN_PREFIX = "$sllm-enc1$"
PLAIN_ESCAPE = "$sllm-raw$"    # a plain value that itself starts with a prefix is stored behind this marker


class CryptoError(Exception):
    """Base class: the data cannot be read."""


class WrongKey(CryptoError):
    """The key does not match the data (wrong key, or the data was changed)."""


class CorruptData(CryptoError):
    """The data is damaged, cut off or was changed."""


def new_key() -> bytes:
    return os.urandom(KEY_LEN)


def derive_key(master: bytes, purpose: str, salt: bytes = b"") -> bytes:
    """One independent 32-byte key per purpose ('files', 'fields', 'vectors', ...) from the data key."""
    if len(master) != KEY_LEN:
        raise ValueError("The data key must be 32 bytes.")
    return HKDF(algorithm=hashes.SHA256(), length=KEY_LEN, salt=salt or None,
                info=b"starkllm/v1/" + purpose.encode()).derive(master)


def key_id(master: bytes) -> str:
    """Short public fingerprint of a data key: lets a wrong key be told apart from damaged data. Not reversible."""
    return derive_key(master, "key-id")[:4].hex()


# --- Stored values -------------------------------------------------------------------------------------------------

def encrypt_text(key: bytes, text: str, context: str = "") -> str:
    """Encrypt a text value. `context` (for example 'messages.content') is authenticated, so a value copied into a
    different column does not decrypt."""
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, text.encode("utf-8"), context.encode())
    return TOKEN_PREFIX + key_id(key) + "$" + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def is_token(value) -> bool:
    return isinstance(value, str) and value.startswith(TOKEN_PREFIX)


def token_key_id(token: str) -> str:
    return token[len(TOKEN_PREFIX):].split("$", 1)[0]


def decrypt_text(key: bytes, token: str, context: str = "") -> str:
    try:
        kid, body = token[len(TOKEN_PREFIX):].split("$", 1)
        raw = base64.urlsafe_b64decode(body.encode("ascii"))
    except Exception:
        raise CorruptData("A stored value is damaged.")
    if kid != key_id(key):
        raise WrongKey("A stored value was protected with a different key.")
    if len(raw) < 12 + TAG_LEN:
        raise CorruptData("A stored value is cut off.")
    try:
        return AESGCM(key).decrypt(raw[:12], raw[12:], context.encode()).decode("utf-8")
    except InvalidTag:
        raise CorruptData("A stored value was changed or damaged.")


# --- Streams -------------------------------------------------------------------------------------------------------

def _stream_key(key: bytes, header: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=KEY_LEN, salt=hashlib.sha256(header).digest(),
                info=b"starkllm/v1/stream").derive(key)


def _chunk_nonce(counter: int) -> bytes:
    return b"\x00" * 4 + struct.pack(">Q", counter)


def _chunk_aad(header: bytes, final: bool) -> bytes:
    return header + (b"\x01" if final else b"\x00")


class StreamWriter:
    """File-like writer that encrypts what is written. close() must be called: it writes the final chunk."""

    def __init__(self, raw: BinaryIO, key: bytes, header: bytes):
        self._raw, self._header = raw, header
        self._aead = AESGCM(_stream_key(key, header))
        self._buf = bytearray()
        self._counter = 0
        self._closed = False
        raw.write(header)

    def write(self, data) -> int:
        if self._closed:
            raise ValueError("write to a closed stream")
        self._buf += data
        while len(self._buf) > CHUNK:       # keep the last piece back: only close() knows it is the final one
            self._emit(bytes(self._buf[:CHUNK]), False)
            del self._buf[:CHUNK]
        return len(data)

    def _emit(self, block: bytes, final: bool):
        self._raw.write(self._aead.encrypt(_chunk_nonce(self._counter), block, _chunk_aad(self._header, final)))
        self._counter += 1

    def flush(self):
        pass

    def close(self):
        if not self._closed:
            self._closed = True
            self._emit(bytes(self._buf), True)
            self._buf.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.close()
        return False


def read_stream(raw: BinaryIO, key: bytes, header_len: int, header: bytes = None) -> Iterator[bytes]:
    """Yield the plaintext chunks of a stream. Every chunk is verified before it is yielded; a stream that ends
    before its final chunk, has data after it or has a changed byte raises CorruptData (WrongKey for a wrong key
    where that can be told: the very first chunk)."""
    header = header if header is not None else raw.read(header_len)
    if len(header) != header_len:
        raise CorruptData("The file is cut off (header).")
    aead = AESGCM(_stream_key(key, header))
    block = CHUNK + TAG_LEN
    current = raw.read(block)
    if not current:
        raise CorruptData("The file is cut off (no data).")
    counter = 0
    while True:
        following = raw.read(block) if len(current) == block else b""
        final = not following
        try:
            yield aead.decrypt(_chunk_nonce(counter), current, _chunk_aad(header, final))
        except InvalidTag:
            if counter == 0:
                raise WrongKey("Wrong key, or the file was changed.")
            raise CorruptData("The file was changed, damaged or cut off.")
        if final:
            return
        current, counter = following, counter + 1


# --- Protected files -----------------------------------------------------------------------------------------------

FILE_HEADER_LEN = len(FILE_MAGIC) + 4 + 16     # magic | key id | random salt


def file_header(key: bytes) -> bytes:
    return FILE_MAGIC + bytes.fromhex(key_id(key)) + os.urandom(16)


def is_encrypted_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(FILE_MAGIC)) == FILE_MAGIC
    except OSError:
        return False


def plain_size(encrypted_size: int) -> int:
    """Size of the original, from the size of the protected file (no need to decrypt)."""
    body = encrypted_size - FILE_HEADER_LEN
    if body < TAG_LEN:
        raise CorruptData("The file is cut off.")
    chunks = -(-body // (CHUNK + TAG_LEN))
    return body - chunks * TAG_LEN


def open_file_writer(path: str, key: bytes) -> StreamWriter:
    return StreamWriter(open(path, "wb"), key, file_header(key))


class _OwningWriter(StreamWriter):
    def close(self):
        if not self._closed:
            try:
                super().close()
            finally:
                self._raw.close()


def create_encrypted(path: str, key: bytes) -> StreamWriter:
    """Writer for a new protected file at `path` (closing it closes the file too)."""
    raw = open(path, "wb")
    try:
        return _OwningWriter(raw, key, file_header(key))
    except Exception:
        raw.close()
        raise


def iter_decrypted(path: str, key: bytes) -> Iterator[bytes]:
    with open(path, "rb") as raw:
        header = raw.read(FILE_HEADER_LEN)
        if header[:len(FILE_MAGIC)] != FILE_MAGIC:
            raise CorruptData("This file is not protected.")
        if header[len(FILE_MAGIC):len(FILE_MAGIC) + 4].hex() != key_id(key):
            raise WrongKey("This file was protected with a different key.")
        yield from read_stream(raw, key, FILE_HEADER_LEN, header)


def encrypt_bytes_to_file(path: str, key: bytes, data: bytes):
    with create_encrypted(path, key) as w:
        w.write(data)


def decrypt_file_bytes(path: str, key: bytes) -> bytes:
    return b"".join(iter_decrypted(path, key))


# --- Backup passphrase ---------------------------------------------------------------------------------------------

# Argon2id: 128 MiB, 3 passes, 4 lanes. A guess costs an attacker the same memory and time, so a short list of
# likely passphrases is the only thing worth trying; the dialog asks for a long one.
KDF_ARGON2ID = 1
DEFAULT_KDF = {"time_cost": 3, "memory_kib": 128 * 1024, "parallelism": 4}
MAX_KDF = {"time_cost": 10, "memory_kib": 1024 * 1024, "parallelism": 16}   # a crafted file must not exhaust memory


def passphrase_key(passphrase: str, salt: bytes, time_cost: int, memory_kib: int, parallelism: int) -> bytes:
    from argon2.low_level import Type, hash_secret_raw
    if not (1 <= time_cost <= MAX_KDF["time_cost"] and 8 <= memory_kib <= MAX_KDF["memory_kib"]
            and 1 <= parallelism <= MAX_KDF["parallelism"]):
        raise CorruptData("The backup uses key settings that are not allowed.")
    return hash_secret_raw(passphrase.encode("utf-8"), salt, time_cost=time_cost, memory_cost=memory_kib,
                           parallelism=parallelism, hash_len=KEY_LEN, type=Type.ID)


def constant_time_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
