"""A ZIP file whose entries are encrypted with AES-256 (WinZip AE-2), written with the `cryptography` package the
engine already has, so no new dependency is needed (tax package, StarkLLM 2.8, option 11).

Format (WinZip "AES Encryption Information", AE-2): each entry is deflated, then encrypted with AES-256 in counter
mode (little-endian counter starting at 1). The keys come from the password with PBKDF2-HMAC-SHA1 (1000 rounds, a
random 16-byte salt per entry); the entry starts with the salt and a 2-byte password check and ends with a 10-byte
HMAC-SHA1 of the encrypted data. The CRC field is 0 (AE-2), the method is 99 and an 0x9901 extra field names AES-256
and deflate. 7-Zip, WinRAR, WinZip, PeaZip and Python's pyzipper open it; the Windows Explorer and macOS Finder do not.

Only what the archive needs: files in memory, no ZIP64 (the export is limited far below 4 GB), no comments.
File names stay readable in any ZIP, encrypted or not.
"""
import hashlib
import hmac
import os
import struct
import time
import zlib
from typing import Iterable, Tuple

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SALT_LEN = 16          # AES-256
KEY_LEN = 32
ITERATIONS = 1000
MAC_LEN = 10
METHOD_AES = 99
METHOD_DEFLATE = 8
FLAG_ENCRYPTED = 0x0001
FLAG_UTF8 = 0x0800
VERSION = 51           # 5.1: AES encryption
MAX_TOTAL = 0xFFFFFFFF - (1 << 20)


def derive(password: bytes, salt: bytes) -> Tuple[bytes, bytes, bytes]:
    """(AES key, HMAC key, 2-byte password check) for a password and salt."""
    dk = hashlib.pbkdf2_hmac("sha1", password, salt, ITERATIONS, 2 * KEY_LEN + 2)
    return dk[:KEY_LEN], dk[KEY_LEN:2 * KEY_LEN], dk[2 * KEY_LEN:]


def ctr_xor(key: bytes, data: bytes) -> bytes:
    """AES in WinZip's counter mode: block i (from 1) is XORed with AES(key, i as 16 little-endian bytes). The same
    call encrypts and decrypts."""
    if not data:
        return b""
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    out = bytearray(len(data))
    blocks = (len(data) + 15) // 16
    step = 4096
    for first in range(0, blocks, step):
        n = min(step, blocks - first)
        stream = enc.update(b"".join((first + i + 1).to_bytes(16, "little") for i in range(n)))
        lo, hi = first * 16, min(len(data), (first + n) * 16)
        part = data[lo:hi]
        out[lo:hi] = (int.from_bytes(part, "big") ^ int.from_bytes(stream[:len(part)], "big")).to_bytes(len(part), "big")
    return bytes(out)


def _dos_time(when: float) -> Tuple[int, int]:
    t = time.localtime(when)
    year = max(1980, t.tm_year)
    return (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2), ((year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday


def encrypt_entry(data: bytes, password: bytes) -> bytes:
    """salt + password check + encrypted deflated data + authentication code."""
    packer = zlib.compressobj(6, zlib.DEFLATED, -15)
    packed = packer.compress(data) + packer.flush()
    salt = os.urandom(SALT_LEN)
    aes_key, mac_key, check = derive(password, salt)
    secret = ctr_xor(aes_key, packed)
    mac = hmac.new(mac_key, secret, hashlib.sha1).digest()[:MAC_LEN]
    return salt + check + secret + mac


def _extra() -> bytes:
    # 0x9901, 7 bytes: vendor version 2 (AE-2), "AE", strength 3 (AES-256), the method inside (deflate)
    return struct.pack("<HHH2sBH", 0x9901, 7, 2, b"AE", 3, METHOD_DEFLATE)


def write(files: Iterable[Tuple[str, bytes]], password: str, when: float = None) -> bytes:
    """A ZIP file of (name in the archive, content) pairs, every entry encrypted with AES-256 under the password."""
    if not password:
        raise ValueError("A password is needed.")
    secret = password.encode("utf-8")
    mtime, mdate = _dos_time(when if when is not None else time.time())
    out, central, count = bytearray(), bytearray(), 0
    for name, data in files:
        raw_name = name.replace("\\", "/").encode("utf-8")
        flags = FLAG_ENCRYPTED | FLAG_UTF8
        body = encrypt_entry(data, secret)
        extra = _extra()
        offset = len(out)
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, VERSION, flags, METHOD_AES, mtime, mdate, 0,
                           len(body), len(data), len(raw_name), len(extra))
        out += raw_name + extra + body
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, VERSION, VERSION, flags, METHOD_AES, mtime, mdate, 0,
                               len(body), len(data), len(raw_name), len(extra), 0, 0, 0, 0, offset)
        central += raw_name + extra
        count += 1
        if len(out) > MAX_TOTAL:
            raise ValueError("The archive is too large.")
    start = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, count, count, len(central), start, 0)
    return bytes(out)


class WrongPassword(Exception):
    pass


def read(archive: bytes, password: str) -> dict:
    """{name: content} of an archive written by write() (used by the tests and to check an archive after writing it).
    Raises WrongPassword when the password check or the authentication code does not match."""
    secret = password.encode("utf-8")
    end = archive.rfind(b"PK\x05\x06")
    _, _, _, _, count, size, start, _ = struct.unpack("<IHHHHIIH", archive[end:end + 22])
    files, pos = {}, start
    for _ in range(count):
        head = struct.unpack("<IHHHHHHIIIHHHHHII", archive[pos:pos + 46])
        name_len, extra_len, comment_len, offset = head[10], head[11], head[12], head[16]
        name = archive[pos + 46:pos + 46 + name_len].decode("utf-8")
        pos += 46 + name_len + extra_len + comment_len
        local = struct.unpack("<IHHHHHIIIHH", archive[offset:offset + 30])
        method, csize, usize, lname, lextra = local[3], local[7], local[8], local[9], local[10]
        body = archive[offset + 30 + lname + lextra:offset + 30 + lname + lextra + csize]
        if method != METHOD_AES:
            raise ValueError(f"{name} is not AES-encrypted")
        salt, check, data, mac = body[:SALT_LEN], body[SALT_LEN:SALT_LEN + 2], body[SALT_LEN + 2:-MAC_LEN], body[-MAC_LEN:]
        aes_key, mac_key, expected = derive(secret, salt)
        if not hmac.compare_digest(check, expected):
            raise WrongPassword(name)
        if not hmac.compare_digest(hmac.new(mac_key, data, hashlib.sha1).digest()[:MAC_LEN], mac):
            raise WrongPassword(name)
        content = zlib.decompress(ctr_xor(aes_key, data), -15)
        if len(content) != usize:
            raise ValueError(f"{name}: wrong size")
        files[name] = content
    return files
