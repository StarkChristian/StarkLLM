"""Which languages the OCR (Tesseract) reads, chosen by the user, and extra language packs.

The program brings English and German. A user in another country can pick other languages in Settings and, when a
pack is not installed, ask for it: only then it is downloaded (one file of a few MB, from the official Tesseract
language data, nothing about the user or the documents is sent) into the data folder. The bundled English and German
data are never changed: reading with a downloaded pack uses a folder that also holds links to the bundled files.

    languages the user wants -> data/ocr_settings.json    (else OCR_LANGUAGES of the environment, "eng+deu")
    downloaded packs         -> data/tessdata/<code>.traineddata and data/tessdata/installed.json
"""
import functools
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Dict, List, Optional

from app.core import netguard
from app.core.config import settings

logger = logging.getLogger(__name__)

# Tesseract language codes that can be chosen (English names; the UI shows them next to the code).
CATALOG: Dict[str, str] = {
    "eng": "English", "deu": "German", "fra": "French", "spa": "Spanish", "ita": "Italian", "tur": "Turkish",
    "por": "Portuguese", "nld": "Dutch", "pol": "Polish", "rus": "Russian", "ukr": "Ukrainian", "ces": "Czech",
    "slk": "Slovak", "hun": "Hungarian", "ron": "Romanian", "bul": "Bulgarian", "ell": "Greek", "swe": "Swedish",
    "dan": "Danish", "nor": "Norwegian", "fin": "Finnish", "hrv": "Croatian", "srp": "Serbian", "slv": "Slovenian",
    "cat": "Catalan", "lit": "Lithuanian", "lav": "Latvian", "est": "Estonian", "sqi": "Albanian", "ara": "Arabic",
    "fas": "Persian", "heb": "Hebrew", "hin": "Hindi", "ben": "Bengali", "urd": "Urdu", "ind": "Indonesian",
    "msa": "Malay", "vie": "Vietnamese", "tha": "Thai", "jpn": "Japanese", "kor": "Korean", "chi_sim": "Chinese (simplified)",
    "chi_tra": "Chinese (traditional)",
}
BUNDLED = ("eng", "deu")  # delivered with the program; osd (page orientation) comes with them
MAX_PACK_BYTES = 80 * 1024 * 1024
MIN_PACK_BYTES = 50 * 1024
MAX_LANGUAGES = 4  # more languages at once make reading slow and less sure

# official "fast" language data of the Tesseract project; OCR_PACK_URL can point to a mirror ({code} is replaced)
PACK_URL = os.getenv("OCR_PACK_URL", "https://github.com/tesseract-ocr/tessdata_fast/raw/main/{code}.traineddata")


def data_dir() -> str:
    return os.path.abspath(os.getenv("OCR_DATA_DIR", "data/tessdata"))


def _settings_file() -> str:
    return os.path.join(os.path.dirname(data_dir()), "ocr_settings.json")


def _manifest_file() -> str:
    return os.path.join(data_dir(), "installed.json")


def _read_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(path: str, value) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def valid_code(code: str) -> bool:
    return bool(re.fullmatch(r"[a-z]{3}(_[a-z]{3})?", code or "")) and code in CATALOG


def clean(languages) -> List[str]:
    """Codes in order, without duplicates, only known ones."""
    out: List[str] = []
    for code in languages:
        code = (code or "").strip().lower()
        if valid_code(code) and code not in out:
            out.append(code)
    return out


def configured() -> List[str]:
    """The languages to read with: the user's choice, else the environment's OCR_LANGUAGES, else English and German."""
    saved = clean(_read_json(_settings_file(), {}).get("languages", []))
    if saved:
        return saved[:MAX_LANGUAGES]
    return clean((settings.OCR_LANGUAGES or "").split("+")) or ["eng", "deu"]


def save(languages) -> List[str]:
    codes = clean(languages)[:MAX_LANGUAGES]
    if not codes:
        raise ValueError("Choose at least one language.")
    _write_json(_settings_file(), {"languages": codes})
    return codes


def downloaded() -> List[str]:
    """Packs the user asked for (their files are in data_dir())."""
    names = [c for c in clean(_read_json(_manifest_file(), [])) if os.path.exists(os.path.join(data_dir(), c + ".traineddata"))]
    return names


@functools.lru_cache(maxsize=4)
def bundled_dir(tesseract_cmd: str = "tesseract") -> Optional[str]:
    """The folder of the language data that comes with Tesseract ("tesseract --list-langs" names it)."""
    try:
        out = subprocess.run([tesseract_cmd, "--list-langs"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'languages.*?"([^"]+)"', (out.stdout or "") + (out.stderr or ""))
    return m.group(1).rstrip("/\\") if m and os.path.isdir(m.group(1)) else None


def _link_or_copy(src: str, dst: str) -> None:
    if os.path.lexists(dst):
        return
    try:
        os.symlink(src, dst)
    except (OSError, NotImplementedError):
        shutil.copyfile(src, dst)  # Windows without the right to make links


def tessdata_arg(tesseract_cmd: str = "tesseract") -> Optional[str]:
    """The folder to read with when the user downloaded packs, else None (Tesseract then uses its own folder, as
    always). The folder also holds the bundled data, so English and German keep working."""
    if not downloaded():
        return None
    folder = data_dir()
    base = bundled_dir(tesseract_cmd)
    if base:
        for name in os.listdir(base):
            if name.endswith(".traineddata"):
                _link_or_copy(os.path.join(base, name), os.path.join(folder, name))
    return folder


def fetch(url: str) -> bytes:
    """Download one language pack (a plain GET through the network layer, which records it and refuses it while the
    app is fully offline; nothing about the user or the documents is sent)."""
    resp = netguard.request("GET", url, feature="ocr_language_pack", timeout=120, stream=True,
                            headers={"User-Agent": "StarkLLM-language-pack"})
    try:
        resp.raise_for_status()
        data = b""
        for chunk in resp.iter_content(1024 * 1024):
            data += chunk
            if len(data) > MAX_PACK_BYTES:
                break
        return data
    finally:
        resp.close()


def install(code: str, fetcher: Optional[Callable[[str], bytes]] = None) -> str:
    """Download the pack of one language into the data folder. Raises ValueError for a language that is not offered
    and RuntimeError when the download does not give a language file."""
    code = (code or "").lower()
    if not valid_code(code):
        raise ValueError(f"Unknown OCR language: {code}")
    data = (fetcher or fetch)(PACK_URL.format(code=code))
    if not (MIN_PACK_BYTES <= len(data) <= MAX_PACK_BYTES):
        raise RuntimeError("The download did not give a language file (wrong size).")
    folder = data_dir()
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, suffix=".part")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, os.path.join(folder, code + ".traineddata"))
    _write_json(_manifest_file(), sorted(set(downloaded()) | {code}))
    logger.info(f"OCR: language pack {code} installed")
    return code


def remove(code: str) -> None:
    """Delete a downloaded pack (never the bundled English and German data)."""
    if code not in downloaded():
        raise ValueError("Only language packs that were downloaded can be removed.")
    path = os.path.join(data_dir(), code + ".traineddata")
    if os.path.exists(path) and not os.path.islink(path):
        os.remove(path)
    _write_json(_manifest_file(), [c for c in downloaded() if c != code])
    left = [c for c in configured() if c != code]
    if left != configured():
        save(left or list(BUNDLED))
