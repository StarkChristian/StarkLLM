"""Does a model fit this PC? (StarkLLM 2.7, model picker)

Users of local AI tools struggle most with choosing a model, and a download gives no hint whether the model will run.
This module answers three questions for the model lists of the app:

- what hardware the PC has: total and free memory, the graphics cards with their video memory, the processor and the
  free disk space. The desktop app detects it on the PC itself at every start (desktop/hardware.js) and writes
  data/hardware.json, because the engine in Docker cannot see the PC's graphics card; without that file the engine
  detects what it can itself (memory, NVIDIA cards through nvidia-smi, disk).
- whether a model fits: "good" (fits well), "tight" (runs, but slower) or "no" (will not fit), with the reason as a
  code and the numbers, which the web UI turns into one sentence in the user's language.
- which model to recommend: one chat model and one image model per hardware tier, from model_tiers.json.
"""
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import time
from pathlib import Path

logger = logging.getLogger(__name__)

GIB = 1024 ** 3
TIERS_FILE = Path(__file__).resolve().parent.parent / "core" / "model_tiers.json"
HARDWARE_FILE = "hardware.json"   # in the data folder, written by the desktop app

# A model needs its file in memory plus room for the conversation (the context cache and the work buffers): at least
# 0.6 GB, 15 % of the file for larger models (about what Ollama reserves for an 8k context with 4-bit models).
CONTEXT_MIN = 0.6 * GIB
CONTEXT_SHARE = 0.15
GPU_USABLE = 0.9          # of the video memory; the rest is for the screen and the graphics driver
RAM_RESERVE_MIN = 4 * GIB  # memory kept for Windows, the app and the engine ...
RAM_RESERVE_SHARE = 0.25   # ... or a quarter of it, whichever is more
CPU_GOOD_MAX = 3.5 * GIB   # on the processor alone, models up to about 4B parameters answer at a usable speed


def need_bytes(size_bytes: float) -> int:
    """Memory a model needs to run: its size on disk plus the context overhead."""
    size = max(0.0, float(size_bytes or 0))
    return int(size + max(CONTEXT_MIN, CONTEXT_SHARE * size))


def ram_budget(ram_total: float) -> int:
    """Memory a model may use when it runs on the processor (or partly does)."""
    ram = max(0.0, float(ram_total or 0))
    return int(max(0.0, ram - max(RAM_RESERVE_MIN, RAM_RESERVE_SHARE * ram)))


def graphics_card(hw: dict):
    """The graphics card of its own with the most video memory, or None."""
    cards = [g for g in (hw or {}).get("gpus") or [] if g.get("kind") != "integrated" and (g.get("vram_total") or 0) > 0]
    return max(cards, key=lambda g: g["vram_total"]) if cards else None


def integrated_graphics(hw: dict):
    """Integrated graphics the AI models may use (they share the PC's memory), or None."""
    igpus = [g for g in (hw or {}).get("gpus") or [] if g.get("kind") == "integrated" and (g.get("vram_total") or 0) > 0]
    return max(igpus, key=lambda g: g["vram_total"]) if igpus else None


def assess(size_bytes: float, hw: dict, installed: bool = False) -> dict:
    """Whether a model of this size on disk fits the PC.

    Returns {fit: "good" | "tight" | "no", reason, need_bytes, size_bytes, vram_bytes, ram_bytes, disk_free}.
    reason: gpu (all on the graphics card), igpu (integrated graphics), cpu (small enough for the processor),
    split (partly on the graphics card, the rest on the processor), cpu_slow (on the processor, slower),
    memory (more than the PC has), disk (not enough free disk space for the download).
    """
    hw = hw or {}
    size = max(0, int(size_bytes or 0))
    need = need_bytes(size)
    ram = int(hw.get("ram_total") or 0)
    budget = ram_budget(ram)
    card = graphics_card(hw)
    igpu = integrated_graphics(hw)
    vram = int(card["vram_total"]) if card else (int(igpu["vram_total"]) if igpu else 0)
    disk_free = hw.get("disk_free")
    out = {"need_bytes": need, "size_bytes": size, "vram_bytes": vram, "ram_bytes": ram,
           "disk_free": int(disk_free) if isinstance(disk_free, (int, float)) else None}

    def result(fit, reason):
        return {"fit": fit, "reason": reason, **out}

    if not installed and out["disk_free"] is not None and size > out["disk_free"]:
        return result("no", "disk")
    if card and need <= vram * GPU_USABLE:
        return result("good", "gpu")
    if not card and igpu and need <= vram:
        return result("good", "igpu")
    if card and need <= vram * GPU_USABLE + budget:
        return result("tight", "split")
    if not card and need <= budget:
        return result("good", "cpu") if size <= CPU_GOOD_MAX else result("tight", "cpu_slow")
    return result("no", "memory")


# ------------------------------------------------------------------------------------------------ tiers

def load_tiers(path: Path = TIERS_FILE) -> list:
    with open(path, encoding="utf-8") as f:
        return json.load(f)["tiers"]


def choose_tier(hw: dict, tiers: list = None) -> dict:
    """The highest tier the PC reaches: by the video memory of its own graphics card, else by its memory."""
    tiers = tiers if tiers is not None else load_tiers()
    card = graphics_card(hw or {})
    vram_gb = (card["vram_total"] / GIB) if card else 0
    ram_gb = float((hw or {}).get("ram_total") or 0) / GIB
    reached = [t for t in tiers
               if (t.get("kind") == "gpu" and card and vram_gb >= t.get("gpu_gb", 0))
               or (t.get("kind") == "cpu" and ram_gb >= t.get("ram_gb", 0))]
    if not reached:
        reached = [t for t in tiers if t.get("kind") == "cpu"] or tiers[:1]
    return max(reached, key=lambda t: (t.get("kind") == "gpu", t.get("gpu_gb", 0), t.get("ram_gb", 0)))


# ------------------------------------------------------------------------------------------------ sizes

_UNITS = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}


def parse_size(text) -> int:
    """'2.0 GB' / '274 MB' -> bytes (decimal units, as Ollama shows them); 0 when unknown."""
    m = re.match(r"^\s*([0-9.]+)\s*([KMGT]?B)\s*$", str(text or ""), re.I)
    return int(float(m.group(1)) * _UNITS[m.group(2).upper()]) if m else 0


# ------------------------------------------------------------------------------------------------ hardware

_cache = {"at": 0.0, "hw": None, "key": None}
CACHE_SECONDS = 60


def _clean(raw: dict) -> dict:
    """Only known fields with the right types: the file comes from another program."""
    num = lambda v: int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None
    gpus = []
    for g in (raw.get("gpus") or [])[:8]:
        if not isinstance(g, dict):
            continue
        gpus.append({
            "name": str(g.get("name") or "")[:120],
            "vendor": str(g.get("vendor") or "")[:20],
            "kind": "integrated" if g.get("kind") == "integrated" else "discrete",
            "vram_total": num(g.get("vram_total")) or 0,
            "vram_free": num(g.get("vram_free")),
        })
    cpu = raw.get("cpu") if isinstance(raw.get("cpu"), dict) else {}
    return {
        "source": str(raw.get("source") or "desktop")[:20],
        "detected_at": str(raw.get("detected_at") or "")[:40],
        "ram_total": num(raw.get("ram_total")) or 0,
        "ram_free": num(raw.get("ram_free")),
        "cpu": {"name": str(cpu.get("name") or "")[:120], "cores": num(cpu.get("cores"))},
        "gpus": gpus,
        "disk_free": num(raw.get("disk_free")),
    }


def _memory():
    """(total, free) memory of the machine the engine runs on, or (0, None)."""
    if os.name == "nt":
        try:
            import ctypes

            class _Status(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = _Status()
            st.dwLength = ctypes.sizeof(_Status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullTotalPhys), int(st.ullAvailPhys)
        except Exception:
            pass
        return 0, None
    try:
        info = {}
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                key, _, rest = line.partition(":")
                info[key] = int(rest.split()[0]) * 1024
        return info.get("MemTotal", 0), info.get("MemAvailable")
    except Exception:
        return 0, None


def parse_nvidia_smi(text: str) -> list:
    """Lines of `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` -> gpus."""
    gpus = []
    for line in str(text or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            total, free = int(float(parts[1])) * 1024 * 1024, int(float(parts[2])) * 1024 * 1024
        except ValueError:
            continue
        gpus.append({"name": parts[0], "vendor": "NVIDIA", "kind": "discrete", "vram_total": total, "vram_free": free})
    return gpus


def _nvidia():
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return parse_nvidia_smi(out.stdout) if out.returncode == 0 else []
    except Exception:
        return []


def _cpu():
    name = ""
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("model name"):
                    name = line.split(":", 1)[1].strip()
                    break
    except Exception:
        name = platform.processor() or ""
    return {"name": name[:120], "cores": os.cpu_count()}


def _disk_free(path: str):
    try:
        return int(shutil.disk_usage(path).free)
    except Exception:
        return None


def detect_hardware(data_dir: str = "data", now=None) -> dict:
    """The hardware of the PC: from data/hardware.json (the desktop app) or detected by the engine itself."""
    now = time.time() if now is None else now
    file = Path(data_dir) / HARDWARE_FILE
    try:
        key = (str(file), file.stat().st_mtime)
    except OSError:
        key = (str(file), None)
    if _cache["hw"] is not None and _cache["key"] == key and now - _cache["at"] < CACHE_SECONDS:
        return _cache["hw"]

    hw = None
    if key[1] is not None:
        try:
            hw = _clean(json.loads(file.read_text(encoding="utf-8")))
        except Exception as e:
            logger.warning(f"hardware.json could not be read: {e}")
    if hw is None:
        total, free = _memory()
        hw = {"source": "engine", "detected_at": "", "ram_total": total, "ram_free": free, "cpu": _cpu(),
              "gpus": _nvidia(), "disk_free": _disk_free(data_dir)}
    elif os.name == "nt":
        # the engine without Docker runs on the PC itself: the free memory and disk space of now
        total, free = _memory()
        if free is not None:
            hw["ram_free"] = free
    _cache.update(at=now, hw=hw, key=key)
    return hw


# ------------------------------------------------------------------------------------------------ for the API

def recommendation(hw: dict, sizes: dict, tiers: list = None) -> dict:
    """The recommended chat and image model for this PC. sizes: {model name: size on disk in bytes}."""
    tier = choose_tier(hw, tiers)
    pick = lambda name: {"name": name, **assess(sizes.get(name, 0), hw)}
    return {"tier": tier["id"], "text": pick(tier["text"]), "vision": pick(tier["vision"])}
