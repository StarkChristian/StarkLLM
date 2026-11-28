"""The model picker (StarkLLM 2.7): does a model fit the PC, and which model is recommended for it.
Fake hardware profiles stand for the PCs users have: no graphics card, integrated graphics, 8, 12, 16 and 24 GB cards."""
import json

from app.services import model_fit
from app.services.llm_service import RECOMMENDED_MODELS

GIB = 1024 ** 3
GB = 1e9


def pc(ram_gb, vram_gb=0, kind="discrete", disk_gb=500, vendor="NVIDIA"):
    gpus = [{"name": "card", "vendor": vendor, "kind": kind, "vram_total": int(vram_gb * GIB), "vram_free": None}] if vram_gb else []
    return {"ram_total": int(ram_gb * GIB), "ram_free": int(ram_gb * GIB / 2), "gpus": gpus,
            "disk_free": int(disk_gb * GB) if disk_gb is not None else None, "cpu": {"name": "cpu", "cores": 8}}


LAPTOP_8 = pc(8)                       # office laptop, no graphics card
DESKTOP_16 = pc(16)                    # PC without a graphics card
RADEON_780M = pc(24, 9.6, kind="integrated", vendor="AMD")  # integrated graphics, 40 % of 24 GB
RTX_8 = pc(16, 8)
RTX_12 = pc(32, 12)
RTX_16 = pc(32, 16, vendor="AMD")      # an AMD card of its own counts like an NVIDIA card
RTX_24 = pc(64, 24)

SIZES = {m["name"]: model_fit.parse_size(m["size"]) for m in RECOMMENDED_MODELS}


# ---------------------------------------------------------------- fit

def test_need_is_the_size_plus_the_context():
    assert model_fit.need_bytes(2.5 * GB) == int(2.5 * GB + 0.6 * GIB)        # small model: at least 0.6 GB
    assert model_fit.need_bytes(16 * GB) == int(16 * GB * 1.15)               # large model: 15 %


def test_a_model_that_fits_the_graphics_card_fits_well():
    r = model_fit.assess(SIZES["qwen3:8b"], RTX_12)
    assert (r["fit"], r["reason"]) == ("good", "gpu")
    assert r["vram_bytes"] == 12 * GIB


def test_a_model_larger_than_the_card_runs_partly_on_the_processor():
    r = model_fit.assess(16 * GB, RTX_12)            # needs about 18 GB, the card has 12
    assert (r["fit"], r["reason"]) == ("tight", "split")
    assert 18 * GB < r["need_bytes"] < 19 * GB


def test_a_model_larger_than_card_and_memory_will_not_fit():
    r = model_fit.assess(40 * GB, RTX_8)
    assert (r["fit"], r["reason"]) == ("no", "memory")


def test_without_a_graphics_card_small_models_fit_and_medium_ones_are_slower():
    assert model_fit.assess(SIZES["qwen3:4b"], DESKTOP_16)["fit"] == "good"
    r = model_fit.assess(SIZES["qwen3:8b"], DESKTOP_16)
    assert (r["fit"], r["reason"]) == ("tight", "cpu_slow")
    assert model_fit.assess(SIZES["qwen3:14b"], LAPTOP_8)["fit"] == "no"


def test_memory_for_windows_is_kept_free():
    # 8 GB laptop: 4 GB stay for Windows and the app, so a 5.2 GB model does not fit
    assert model_fit.assess(SIZES["qwen3:8b"], LAPTOP_8)["reason"] == "memory"
    assert model_fit.ram_budget(64 * GIB) == 48 * GIB


def test_integrated_graphics_count_with_the_memory_they_may_share():
    r = model_fit.assess(SIZES["qwen3:8b"], RADEON_780M)
    assert (r["fit"], r["reason"]) == ("good", "igpu")
    r = model_fit.assess(SIZES["qwen3:14b"], RADEON_780M)   # 10.7 GB need > 9.6 GB shared, but fits the memory
    assert r["fit"] == "tight"


def test_not_enough_disk_space_will_not_fit_but_installed_models_are_not_judged_by_it():
    small_disk = pc(32, 12, disk_gb=4)
    r = model_fit.assess(SIZES["qwen3:8b"], small_disk)
    assert (r["fit"], r["reason"]) == ("no", "disk")
    assert model_fit.assess(SIZES["qwen3:8b"], small_disk, installed=True)["fit"] == "good"


def test_unknown_hardware_never_crashes():
    r = model_fit.assess(SIZES["qwen3:4b"], {})
    assert r["fit"] == "no" and r["reason"] == "memory"
    assert model_fit.assess(0, None)["need_bytes"] > 0


# ---------------------------------------------------------------- tiers

def test_one_tier_per_hardware_class():
    tier = lambda hw: model_fit.choose_tier(hw)
    assert tier(LAPTOP_8)["id"] == "cpu"
    assert tier(DESKTOP_16)["id"] == "cpu"
    assert tier(RADEON_780M)["id"] == "cpu"       # integrated graphics share the memory: the processor tier
    assert tier(RTX_8)["id"] == "gpu_8"
    assert tier(RTX_12)["id"] == "gpu_12"
    assert tier(RTX_16)["id"] == "gpu_12"
    assert tier(RTX_24)["id"] == "gpu_24"


def test_the_tier_sizes_follow_the_plan():
    params = lambda name: float(name.split(":")[1].rstrip("b"))
    assert params(model_fit.choose_tier(DESKTOP_16)["text"]) <= 4        # CPU only: 2-4B
    assert params(model_fit.choose_tier(RTX_8)["text"]) <= 4             # 8 GB: a small 4B
    assert 7 <= params(model_fit.choose_tier(RTX_12)["text"]) <= 9       # 12-16 GB: 8-9B
    assert 14 <= params(model_fit.choose_tier(RTX_24)["text"]) <= 27     # 24 GB+: 14-27B


def test_every_tier_model_is_in_the_model_hub_and_fits_its_tier():
    tiers = model_fit.load_tiers()
    assert {t["id"] for t in tiers} == {"cpu", "gpu_8", "gpu_12", "gpu_24"}
    lowest = {"cpu": DESKTOP_16, "gpu_8": pc(16, 8), "gpu_12": pc(32, 12), "gpu_24": pc(64, 24)}
    for t in tiers:
        for role in ("text", "vision"):
            assert t[role] in SIZES, f"{t[role]} is missing in RECOMMENDED_MODELS"
            assert model_fit.assess(SIZES[t[role]], lowest[t["id"]])["fit"] == "good", (t["id"], role)


def test_every_tier_has_an_image_model():
    vision = {m["name"] for m in RECOMMENDED_MODELS if m["category"] == "Vision"}
    assert all(t["vision"] in vision for t in model_fit.load_tiers())


def test_the_recommendation_names_both_models_with_their_fit():
    rec = model_fit.recommendation(RTX_12, SIZES)
    assert rec["tier"] == "gpu_12"
    assert rec["text"]["name"] == "qwen3:8b" and rec["text"]["fit"] == "good"
    assert rec["vision"]["name"] == "qwen2.5vl:7b"


def test_tiers_are_read_from_the_data_file(tmp_path):
    f = tmp_path / "tiers.json"
    f.write_text(json.dumps({"tiers": [{"id": "cpu", "kind": "cpu", "ram_gb": 0, "text": "a:1b", "vision": "v:1b"},
                                       {"id": "big", "kind": "gpu", "gpu_gb": 40, "text": "b:70b", "vision": "v:70b"}]}))
    tiers = model_fit.load_tiers(f)
    assert model_fit.choose_tier(RTX_24, tiers)["id"] == "cpu"
    assert model_fit.choose_tier(pc(128, 48), tiers)["id"] == "big"


# ---------------------------------------------------------------- hardware

def test_parse_size():
    assert model_fit.parse_size("2.0 GB") == 2 * 10 ** 9
    assert model_fit.parse_size("274 MB") == 274 * 10 ** 6
    assert model_fit.parse_size("") == 0


def test_nvidia_smi_lines():
    gpus = model_fit.parse_nvidia_smi("NVIDIA GeForce RTX 4070, 12282, 11020\nbad line\n")
    assert gpus == [{"name": "NVIDIA GeForce RTX 4070", "vendor": "NVIDIA", "kind": "discrete",
                     "vram_total": 12282 * 1024 * 1024, "vram_free": 11020 * 1024 * 1024}]


def test_the_hardware_file_of_the_desktop_app_is_used_and_checked(tmp_path, monkeypatch):
    monkeypatch.setattr(model_fit, "_cache", {"at": 0.0, "hw": None, "key": None})
    (tmp_path / "hardware.json").write_text(json.dumps({
        "source": "desktop", "ram_total": 32 * GIB, "ram_free": 20 * GIB, "disk_free": 100 * 10 ** 9,
        "cpu": {"name": "AMD Ryzen 7", "cores": 16},
        "gpus": [{"name": "Radeon RX 7800 XT", "vendor": "AMD", "kind": "discrete", "vram_total": 16 * GIB},
                 {"name": "evil", "kind": "integrated", "vram_total": "lots"}, "not a gpu"],
        "extra": "ignored"}))
    hw = model_fit.detect_hardware(str(tmp_path))
    assert hw["source"] == "desktop" and hw["ram_total"] == 32 * GIB
    assert [g["name"] for g in hw["gpus"]] == ["Radeon RX 7800 XT", "evil"]
    assert hw["gpus"][1]["vram_total"] == 0
    assert "extra" not in hw
    assert model_fit.choose_tier(hw)["id"] == "gpu_12"


def test_without_the_file_the_engine_detects_what_it_can(tmp_path, monkeypatch):
    monkeypatch.setattr(model_fit, "_cache", {"at": 0.0, "hw": None, "key": None})
    monkeypatch.setattr(model_fit, "_nvidia", lambda: [])
    hw = model_fit.detect_hardware(str(tmp_path))
    assert hw["source"] == "engine"
    assert hw["ram_total"] > 0
    assert hw["disk_free"] and hw["disk_free"] > 0


# ---------------------------------------------------------------- the API of the Model Hub

def test_the_model_hub_gets_fit_size_and_recommendation(monkeypatch):
    from app.api import models_router
    monkeypatch.setattr(model_fit, "detect_hardware", lambda *a, **k: RTX_12)
    monkeypatch.setattr(models_router.llm_service, "get_available_models", lambda: ["qwen3:8b"])
    monkeypatch.setattr(models_router.llm_service, "get_detailed_models",
                        lambda: [{"name": "qwen3:8b", "size": SIZES["qwen3:8b"]}, {"name": "huge:70b", "size": 42 * GB}])
    catalog = models_router.get_model_catalog()
    by_name = {m["name"]: m for m in catalog["catalog"]}
    assert by_name["qwen3:8b"]["recommended"] == "text" and by_name["qwen3:8b"]["is_installed"]
    assert by_name["qwen2.5vl:7b"]["recommended"] == "vision"
    assert by_name["qwen3:4b"]["recommended"] is None
    assert by_name["qwen3:8b"]["size_bytes"] == int(5.2e9)
    assert all(m["fit"]["fit"] in ("good", "tight", "no") for m in catalog["catalog"])
    detailed = {m["name"]: m["fit"]["fit"] for m in models_router.get_detailed_models()["models"]}
    assert detailed == {"qwen3:8b": "good", "huge:70b": "no"}
    hw = models_router.get_hardware()
    assert hw["recommendation"]["tier"] == "gpu_12" and hw["hardware"]["ram_total"] == 32 * GIB
