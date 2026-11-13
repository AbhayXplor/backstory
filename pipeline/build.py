"""Backstory data pipeline.

Pulls real imagery for each precomputed area and writes consumer-facing
statistics plus PNGs.

Sentinel-2 L2A (10 m, 2019 →) from Earth Search, Landsat C2 L2 (30 m, 2002 →)
from Microsoft Planetary Computer. Both free, no account.

Deliberately NOT published: an absolute "built-up %" per date. Bare desert and
concrete are not separable from multispectral data at this resolution, and the
2002 figure would read as 90% built. Only *change* between two dates is
claimed, which is what the product is about anyway.

    python pipeline/build.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import planetary_computer as pc
import rasterio
from PIL import Image
from pystac_client import Client
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "public" / "geo"
DATA = ROOT / "public" / "data"

STAC = "https://earth-search.aws.element84.com/v1"
PC = "https://planetarycomputer.microsoft.com/api/stac/v1"

SITES = [
    {
        "id": "business-bay",
        "name": "Business Bay",
        "city": "Dubai",
        "centre": [25.1860, 55.2700],
        "bbox": [55.2560, 25.1750, 55.2840, 25.1975],
        "note": "new towers on former open ground",
    },
    {
        "id": "dubai-marina",
        "name": "Dubai Marina",
        "city": "Dubai",
        "centre": [25.0805, 55.1400],
        "bbox": [55.1275, 25.0695, 55.1545, 25.0905],
        "note": "built out early, now changing at the edges",
    },
]

FRAMES = [
    ("2002", "landsat-c2-l2", "2002-01-01/2002-12-31"),
    ("2019", "sentinel-2-l2a", "2019-10-01/2019-12-31"),
    ("2022", "sentinel-2-l2a", "2022-10-01/2022-12-31"),
    ("2025", "sentinel-2-l2a", "2025-10-01/2025-12-31"),
]

W = 560
VALID_SCL = {4, 5, 6, 7, 11}


def log(*a):
    print(*a, flush=True)


def grid(bbox, w=W):
    lon0, lat0, lon1, lat1 = bbox
    mid_lat = (lat0 + lat1) / 2
    width_km = (lon1 - lon0) * 111.32 * np.cos(np.radians(mid_lat))
    height_km = (lat1 - lat0) * 110.57
    return w, max(64, int(round(w * height_km / width_km)))


def pick_item(catalog, collection, window, bbox):
    search = catalog.search(
        collections=[collection],
        bbox=bbox,
        datetime=window,
        query={"eo:cloud_cover": {"lt": 12}},
        limit=50,
    )
    items = sorted(search.items(), key=lambda i: i.properties.get("eo:cloud_cover", 100))
    if not items:
        return None
    return pc.sign(items[0]) if collection.startswith("landsat") else items[0]


def read_asset(item, asset, bbox, hw, nearest=False):
    href = item.assets[asset].href
    env = rasterio.Env(AWS_NO_SIGN_REQUEST="YES", AWS_REGION="us-west-2")
    with env, rasterio.open(href) as ds:
        b = transform_bounds("EPSG:4326", ds.crs, *bbox)
        win = from_bounds(*b, transform=ds.transform)
        return ds.read(
            1,
            window=win,
            out_shape=hw,
            boundless=True,
            fill_value=0,
            resampling=Resampling.nearest if nearest else Resampling.bilinear,
        ).astype("float32")


def stretch(rgb, valid):
    sample = rgb[valid] if valid.any() else rgb.reshape(-1, 3)
    lo, hi = np.percentile(sample, [3, 97])
    out = np.clip((rgb - lo) / max(hi - lo, 1e-6), 0, 1) ** 0.9
    return (out * 255).astype("uint8")


def save_rgb(path, red, green, blue, valid):
    img = stretch(np.dstack([red, green, blue]), valid)
    img[~valid] = [18, 20, 24]
    Image.fromarray(img).save(path, optimize=True)


def save_overlay(path, lost_green, new_built, new_water):
    h, w = lost_green.shape
    rgba = np.zeros((h, w, 4), dtype="uint8")
    rgba[lost_green] = [239, 68, 68, 205]
    rgba[new_built] = [251, 146, 60, 215]
    rgba[new_water] = [56, 189, 248, 215]
    Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)


def build_site(catalog, pc_catalog, site):
    bbox = site["bbox"]
    w, h = grid(bbox)
    hw = (h, w)
    log(f"\n{site['name']} · grid {w}x{h}")

    dates, layers = [], {}
    for label, collection, window in FRAMES:
        cat = pc_catalog if collection.startswith("landsat") else catalog
        item = pick_item(cat, collection, window, bbox)
        if item is None:
            log(f"  {label}: skipped, too cloudy")
            continue

        sentinel = collection == "sentinel-2-l2a"
        nir_key = "nir" if sentinel else "nir08"
        swir_key = "swir16" if "swir16" in item.assets else "swir22"

        red = read_asset(item, "red", bbox, hw)
        green = read_asset(item, "green", bbox, hw)
        blue = read_asset(item, "blue", bbox, hw)
        nir = read_asset(item, nir_key, bbox, hw)
        swir = read_asset(item, swir_key, bbox, hw)

        if sentinel and "scl" in item.assets:
            scl = read_asset(item, "scl", bbox, hw, nearest=True).astype("int16")
            valid = np.isin(scl, list(VALID_SCL))
            is_water = scl == 6
        elif not sentinel and "qa_pixel" in item.assets:
            qa = read_asset(item, "qa_pixel", bbox, hw, nearest=True).astype("int32")
            valid = ((qa & 1) | (qa & 4) | (qa & 8) | (qa & 16)) == 0
            is_water = np.zeros_like(valid)
        else:
            valid = (red > 0) & (nir > 0)
            is_water = np.zeros_like(valid)

        eps = 1e-6
        ndvi = (nir - red) / (nir + red + eps)
        ndwi = (green - nir) / (green + nir + eps)
        ndbi = (swir - nir) / (swir + nir + eps)
        is_water = is_water | ((ndwi > 0.15) & valid)
        is_green = (ndvi > 0.30) & ~is_water & valid
        is_built = (ndbi > 0.05) & (ndvi < 0.18) & ~is_water & valid

        n = max(int(valid.sum()), 1)
        stats = {
            "green": round(100 * float(is_green.sum()) / n, 1),
            "water": round(100 * float(is_water.sum()) / n, 1),
            "seen": round(100 * n / valid.size, 1),
        }

        name = f"{site['id']}_{label}"
        save_rgb(GEO / f"rgb_{name}.png", red, green, blue, valid)
        dates.append({
            "year": label,
            "date": item.properties["datetime"][:10],
            "cloud": round(float(item.properties.get("eo:cloud_cover") or 0), 1),
            "scene": item.id,
            "sensor": "Sentinel-2" if sentinel else "Landsat",
            "resolution": 10 if sentinel else 30,
            **stats,
            "image": f"/geo/rgb_{name}.png",
        })
        layers[label] = {"green": is_green, "water": is_water, "built": is_built,
                         "ndvi": ndvi, "valid": valid}
        log(f"  {label} {dates[-1]['sensor']}: green {stats['green']}% "
            f"water {stats['water']}% seen {stats['seen']}%")

    pairs = []
    labels = [d["year"] for d in dates]
    for i, a in enumerate(labels):
        for b in labels[i + 1:]:
            la, lb = layers[a], layers[b]
            both = la["valid"] & lb["valid"]
            # Water edges move with tide and level; counting them as change
            # would inflate every number near a marina or canal.
            land = both & ~(la["water"] | lb["water"])
            n = max(int(land.sum()), 1)
            changed = land & (np.abs(la["ndvi"] - lb["ndvi"]) > 0.15)
            lost_green = land & (la["ndvi"] - lb["ndvi"] > 0.15)
            # Strict subset of "changed": a building only counts if the pixel
            # also crossed the change threshold, so the two numbers can never contradict.
            new_built = changed & lb["built"] & ~la["built"]
            new_water = both & (lb["water"] & ~la["water"])
            name = f"{site['id']}_change_{a}_{b}"
            save_overlay(GEO / f"change_{name}.png", lost_green, new_built, new_water)
            pairs.append({
                "from": a, "to": b,
                "seen": round(100 * int(both.sum()) / both.size, 1),
                "changed": round(100 * float(changed.sum()) / n, 1),
                "lostGreen": round(100 * float(lost_green.sum()) / n, 1),
                "newBuilt": round(100 * float(new_built.sum()) / n, 1),
                "newWater": round(100 * float(new_water.sum()) / n, 1),
                "overlay": f"/geo/change_{name}.png",
            })

    return {
        "site": site,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Sentinel-2 L2A (ESA) and Landsat C2 L2 (USGS) · via Earth Search and Microsoft Planetary Computer",
        "grid": [w, h],
        "dates": dates,
        "pairs": pairs,
    }


def main():
    GEO.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    catalog = Client.open(STAC)
    pc_catalog = Client.open(PC)

    wanted = sys.argv[1:]
    index = []
    for site in SITES:
        if wanted and site["id"] not in wanted:
            continue
        payload = build_site(catalog, pc_catalog, site)
        (DATA / f"{site['id']}.json").write_text(json.dumps(payload, indent=2), encoding="utf8")
        index.append({k: site[k] for k in ("id", "name", "city", "note")})
        log(f"  wrote {site['id']}.json · {len(payload['dates'])} frames, {len(payload['pairs'])} pairs")

    (DATA / "index.json").write_text(json.dumps(index, indent=2), encoding="utf8")
    log("done")


if __name__ == "__main__":
    main()
