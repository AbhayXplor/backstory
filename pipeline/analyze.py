"""Analyse one arbitrary point.

    python pipeline/analyze.py --lat 25.0805 --lon 55.1400 --slug p_25.0805_55.1400

Writes public/sites/<slug>.json and the PNGs beside it, then prints the path.
Cached: the same slug is not recomputed unless --force is passed.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import planetary_computer as pc
import rasterio
from PIL import Image
from pystac_client import Client
from rasterio.enums import Resampling
from rasterio.features import shapes as raster_shapes
from rasterio.transform import Affine
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sites"

STAC = "https://earth-search.aws.element84.com/v1"
PC = "https://planetarycomputer.microsoft.com/api/stac/v1"

DEM_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/"
           "Copernicus_DSM_COG_10_{tile}_DEM/Copernicus_DSM_COG_10_{tile}_DEM.tif")

DEFAULT_YEARS = [2002, 2019, 2025]


def frames_for(years):
    """Each year maps to the collection that existed then, and to the same season
    (Oct-Dec) so a comparison is not a seasonal artefact."""
    frames = []
    for y in years:
        # Sentinel-2 L2A coverage in this archive is complete from 2017; before that Landsat is the
        # only 30 m record, so an older request widens in resolution rather than dropping the year.
        if y >= 2017:
            # Same season as every other Sentinel frame.
            frames.append((str(y), "sentinel-2-l2a", f"{y}-10-01/{y}-12-31"))
        else:
            # A single narrow season in 2002 is often fully clouded over Dubai; the clearest pass of
            # the year is the honest maximum, and in practice it lands within a month of the others.
            frames.append((str(y), "landsat-c2-l2", f"{y}-01-01/{y}-12-31"))
    return frames

W = 640
VALID_SCL = {4, 5, 6, 7, 11}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def bbox_for(lat: float, lon: float, km: float):
    half_lat = km / 2 / 110.57
    half_lon = km / 2 / (111.32 * np.cos(np.radians(lat)))
    return [lon - half_lon, lat - half_lat, lon + half_lon, lat + half_lat]


def grid(bbox, w=W):
    lon0, lat0, lon1, lat1 = bbox
    mid_lat = (lat0 + lat1) / 2
    width_km = (lon1 - lon0) * 111.32 * np.cos(np.radians(mid_lat))
    height_km = (lat1 - lat0) * 110.57
    return w, max(64, int(round(w * height_km / width_km)))


def pick_item(catalog, collection, window, bbox, max_cloud=15):
    for limit in (max(2, max_cloud // 3), max_cloud, 100):
        search = catalog.search(
            collections=[collection],
            bbox=bbox,
            datetime=window,
            query={"eo:cloud_cover": {"lt": limit}},
            limit=50,
        )
        items = sorted(search.items(), key=lambda i: i.properties.get("eo:cloud_cover", 100))
        if items:
            return pc.sign(items[0]) if collection.startswith("landsat") else items[0]
    return None


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


def read_url(href, bbox, hw, nearest=True):
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


def to_reflectance(bands, sentinel):
    """Both archives store integers, and both need decoding before an index means anything.

    Sentinel-2 L2A is plain DN/10000, which cancels inside NDVI and NDWI because it is a
    pure factor. Landsat Collection 2 L2 is DN*2.75e-5-0.2, and that -0.2 offset does not
    cancel. Skipping it compressed every index: Gulf water scored 0.09 NDWI instead of 0.67
    and fell under the 0.15 water threshold, which is why a sea window read 1.2% water.
    """
    if sentinel:
        return {k: v / 10000.0 for k, v in bands.items()}
    return {k: v * 2.75e-5 - 0.2 for k, v in bands.items()}


def tile_name(lat, lon):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"{ns}{abs(int(np.floor(lat))):02d}_00_{ew}{abs(int(np.floor(lon))):03d}_00"


def terrain(lat, lon, km=3.0):
    """Is this plot lower than the ground around it?

    Copernicus DEM is a surface model: a tower reads as a summit. So each 140 m block is
    reduced to its 10th percentile, which is the bare ground in that block, and the pin's
    block is compared with the median of the surrounding blocks.
    """
    arr = read_url(DEM_URL.format(tile=tile_name(lat, lon)), bbox_for(lat, lon, km), (220, 220))
    arr = arr.astype("float32")
    arr[arr < -100] = np.nan
    if not np.isfinite(arr).any():
        return None

    h, w = arr.shape
    b = 10
    blocks = []
    for r in range(0, h - b + 1, b):
        for c in range(0, w - b + 1, b):
            blk = arr[r:r + b, c:c + b]
            blk = blk[np.isfinite(blk)]
            if blk.size < b * b * 0.6:
                continue
            blocks.append((float(np.percentile(blk, 10)), r, c))
    if len(blocks) < 10:
        return None

    cr, cc = h // 2, w // 2
    # The pin is read from a 60 m window, not a 140 m block: in a canal district a block-wide
    # minimum is the water in the canal, which made dry plots look 6 m below their neighbours.
    centre = arr[max(0, cr - 2):cr + 3, max(0, cc - 2):cc + 3]
    centre = centre[np.isfinite(centre)]
    pin_m = float(np.percentile(centre, 10)) if centre.size else float(blocks[0][0])
    # Blocks at sea level are water, not neighbours. Left in, an island reads as sitting
    # 4 m above "the ground" when the real comparison is the mainland.
    others = np.array([v[0] for v in blocks if v[0] > 0.5])
    if others.size < 5:
        others = np.array([v[0] for v in blocks])
    around = float(np.median(others))
    everything = arr[np.isfinite(arr)]
    return {
        "pin_m": round(pin_m, 1),
        "around_m": round(around, 1),
        "low_by_m": round(around - pin_m, 1),
        "min_m": round(float(np.min(everything)), 1),
        "max_m": round(float(np.max(everything)), 1),
        "window_km": km,
        "resolution_m": 30,
        "source": "Copernicus DEM 30 m",
    }


def flood_extent(lat, lon):
    """Water standing on the ground after the April 2024 storm, read from the first clear pass."""
    cat = Client.open(STAC)
    bbox = bbox_for(lat, lon, 1.4)
    w, h = grid(bbox)
    # April first, because water drains. Any later pass is reported with the delay it carries,
    # and a hazy scene is only accepted if enough of this window is actually visible.
    best = None
    for window in ("2024-04-16/2024-04-30", "2024-05-01/2024-05-31"):
        search = cat.search(
            collections=["sentinel-2-l2a"], bbox=bbox, datetime=window,
            query={"eo:cloud_cover": {"lt": 90}}, limit=30,
        )
        items = sorted(search.items(), key=lambda i: i.properties.get("eo:cloud_cover", 100))[:4]
        for item in items:
            green = read_asset(item, "green", bbox, (h, w))
            nir = read_asset(item, "nir", bbox, (h, w))
            scl = read_asset(item, "scl", bbox, (h, w), True).astype("int16")
            visible = np.isin(scl, list(VALID_SCL)) | (scl == 6)
            share = float(visible.mean())
            if best is None or share > best[1]:
                best = (item, share, scl, visible, green, nir)
            if share > 0.5:
                break
        if best and best[1] > 0.5:
            break

    if best is None:
        return {"status": "no pass found in the month after the storm"}
    item, share, scl, visible, green, nir = best
    seen = item.properties["datetime"][:10]
    if share < 0.2:
        return {
            "status": "too cloudy over this point after the storm",
            "date": seen,
            "seen_pct": round(100 * share, 1),
        }

    water = (scl == 6) | (((green - nir) / (green + nir + 1e-6) > 0.15) & (scl > 0))
    cy, cx = h // 2, w // 2
    pin = water[max(0, cy - 1):cy + 2, max(0, cx - 1):cx + 2]
    return {
        "date": seen,
        "days_after_storm": (datetime.fromisoformat(seen) - datetime(2024, 4, 16)).days,
        "scene": item.id,
        "cloud": round(float(item.properties.get("eo:cloud_cover") or 0), 1),
        "water_pct": round(100 * float(water[visible].sum()) / max(int(visible.sum()), 1), 1),
        "pin_water_pct": round(100 * float(pin.mean()), 0) if pin.size else None,
        "seen_pct": round(100 * share, 1),
    }


def heat(lat, lon):
    """Surface temperature on an August afternoon, against this scene's own median."""
    cat = Client.open(PC)
    bbox = bbox_for(lat, lon, 1.4)
    w, h = grid(bbox)
    item = None
    for window in ("2025-08-01/2025-09-30", "2024-08-01/2024-09-30", "2023-08-01/2023-09-30"):
        item = pick_item(cat, "landsat-c2-l2", window, bbox, max_cloud=25)
        if item is not None:
            break
    if item is None:
        return None
    key = next((k for k in ("lwir11", "lwir") if k in item.assets), None)
    if key is None:
        return None

    st = read_asset(item, key, bbox, (h, w)) * 0.00341802 + 149.0 - 273.15
    red = read_asset(item, "red", bbox, (h, w))
    nir = read_asset(item, "nir08", bbox, (h, w))
    qa = read_asset(item, "qa_pixel", bbox, (h, w), True).astype("int32")
    valid = (((qa & 1) | (qa & 8) | (qa & 16)) == 0) & (st > -20) & (st < 85)
    if valid.sum() < 200:
        return None

    ndvi = (nir - red) / (nir + red + 1e-6)
    cy, cx = h // 2, w // 2
    win = (slice(max(0, cy - 2), cy + 3), slice(max(0, cx - 2), cx + 3))
    pin = st[win][valid[win]]
    planted = valid & (ndvi > 0.25)
    return {
        "date": item.properties["datetime"][:10],
        "scene": item.id,
        "platform": str(item.properties.get("platform", "landsat")).replace("landsat-", "Landsat "),
        "resolution_m": 100,
        "pin_c": round(float(np.median(pin)), 1) if pin.size else None,
        "median_c": round(float(np.median(st[valid])), 1),
        "green_c": round(float(np.median(st[planted])), 1) if planted.sum() > 20 else None,
    }


def stretch(rgb, valid):
    sample = rgb[valid] if valid.any() else rgb.reshape(-1, 3)
    lo, hi = np.percentile(sample, [3, 97])
    return (np.clip((rgb - lo) / max(hi - lo, 1e-6), 0, 1) ** 0.9 * 255).astype("uint8")


def save_rgb(path, red, green, blue, valid):
    img = stretch(np.dstack([red, green, blue]), valid)
    img[~valid] = [18, 20, 24]
    Image.fromarray(img).save(path, optimize=True)
    return img


def save_overlay(path, lost_green, new_built, new_water):
    h, w = lost_green.shape
    rgba = np.zeros((h, w, 4), dtype="uint8")
    rgba[lost_green] = [239, 68, 68, 205]
    rgba[new_built] = [251, 146, 60, 215]
    rgba[new_water] = [56, 189, 248, 215]
    Image.fromarray(rgba, mode="RGBA").save(path, optimize=True)


def ring_area(ring):
    s = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def crop_pair(before, after, row, col, half, gutter=6):
    h, w, _ = before.shape
    r0, r1 = max(0, row - half), min(h, row + half)
    c0, c1 = max(0, col - half), min(w, col + half)
    if r1 - r0 < 8 or c1 - c0 < 8:
        return None
    left = before[r0:r1, c0:c1]
    right = after[r0:r1, c0:c1]
    band = np.full((left.shape[0], gutter, 3), 248, dtype="uint8")
    return np.hstack([left, band, right])


def find_hotspots(changed, land, la, lb, rgb_a, rgb_b, m_per_px, lon0, lat0, lon1, lat1, prefix, limit=4, min_px=25):
    """Connected regions of change, ranked by area, each with a before/after crop."""
    mask = (changed & land).astype("uint8")
    if not mask.any():
        return []
    h, w = mask.shape
    regions = []
    for geom, val in raster_shapes(mask, mask=mask.astype(bool), transform=Affine.identity()):
        for ring in ([geom["coordinates"][0]] if geom["type"] == "Polygon" else
                     [p[0] for p in geom["coordinates"]]):
            px = ring_area(ring)
            if px < min_px:
                continue
            xs = [p[0] for p in ring]
            raw = [p[1] for p in ring]
            # rasterio emits y either up or down depending on the transform; normalise to rows.
            ys = [-v for v in raw] if max(raw) <= 0 else raw
            if min(ys) < 0:
                ys = [abs(v) for v in ys]
            regions.append({
                "px": px,
                "col": int(np.mean(xs)),
                "row": int(np.mean(ys)),
                "c0": int(min(xs)), "c1": int(max(xs)),
                "r0": int(min(ys)), "r1": int(max(ys)),
            })
    regions.sort(key=lambda r: -r["px"])

    out = []
    for i, r in enumerate(regions[:limit]):
        row, col = r["row"], r["col"]
        sl = (slice(max(0, r["r0"]), min(h, r["r1"] + 1)), slice(max(0, r["c0"]), min(w, r["c1"] + 1)))
        built_px = int((lb["built"] & ~la["built"])[sl].sum())
        green_px = int(la["green"][sl].sum() - lb["green"][sl].sum())
        water_px = int(lb["water"][sl].sum() - la["water"][sl].sum())
        box_px = max(1, (sl[0].stop - sl[0].start) * (sl[1].stop - sl[1].start))
        stage = "built" if built_px / box_px > 0.2 else "open"
        if built_px >= max(green_px, water_px):
            kind = "building"
        elif green_px >= water_px:
            kind = "lost greenery"
        else:
            kind = "new water"
        crop = crop_pair(rgb_a, rgb_b, row, col, half=54)
        name = None
        if crop is not None:
            name = f"hot_{prefix}_{i}"
            Image.fromarray(crop).save(OUT / f"{name}.png", optimize=True)
        lon = lon0 + (col / w) * (lon1 - lon0)
        lat = lat1 - (row / h) * (lat1 - lat0)
        out.append({
            "kind": kind,
            "stage": stage,
            "built_share": round(100 * built_px / box_px, 1),
            "area_m2": int(round(r["px"] * m_per_px * m_per_px / 100.0) * 100),
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "crop": f"/sites/{name}.png" if name else None,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--name", default="This place")
    ap.add_argument("--km", type=float, default=1.4)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--years", default=",".join(str(y) for y in DEFAULT_YEARS),
                    help="comma separated acquisition years, e.g. 2002,2019,2025,2016")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{args.slug}.json"
    if target.exists() and not args.force:
        log(f"cached {target.name}")
        print(str(target))
        return

    bbox = bbox_for(args.lat, args.lon, args.km)
    w, h = grid(bbox)
    hw = (h, w)
    lon0, lat0, lon1, lat1 = bbox
    mid_lat = (lat0 + lat1) / 2
    m_per_px = (lon1 - lon0) * 111320 * np.cos(np.radians(mid_lat)) / w
    log(f"{args.name} · {args.km} km · grid {w}x{h} · {round(m_per_px)} m/px")

    catalog = Client.open(STAC)
    pc_catalog = Client.open(PC)
    dates, layers, rgb_images = [], {}, {}

    try:
        years = sorted({int(y) for y in args.years.split(",") if y.strip().isdigit() and 1999 <= int(y) <= 2026})
    except ValueError:
        years = DEFAULT_YEARS
    if len(years) < 2:
        years = DEFAULT_YEARS
    log(f"years {years}")

    for label, collection, window in frames_for(years):
        cat = pc_catalog if collection.startswith("landsat") else catalog
        try:
            item = pick_item(cat, collection, window, bbox)
            if item is None and window.endswith("12-31") and window[5:7] == "10":
                # Nothing clear in the matched season; widen to the whole year and say so.
                item = pick_item(cat, collection, f"{label}-01-01/{label}-12-31", bbox)
                if item is not None:
                    log(f"  {label}: no clear Oct-Dec pass, widened to the full year")
            if item is None and collection == "sentinel-2-l2a":
                item = pick_item(pc_catalog, "landsat-c2-l2", f"{label}-01-01/{label}-12-31", bbox)
                if item is not None:
                    collection = "landsat-c2-l2"
                    log(f"  {label}: no Sentinel-2 pass, fell back to Landsat")
        except Exception as exc:
            log(f"  {label}: search failed {exc}")
            continue
        if item is None:
            log(f"  {label}: no usable scene")
            continue

        sentinel = collection == "sentinel-2-l2a"
        nir_key = "nir" if sentinel else "nir08"
        swir_key = "swir16" if "swir16" in item.assets else "swir22"

        try:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {
                    "red": pool.submit(read_asset, item, "red", bbox, hw),
                    "green": pool.submit(read_asset, item, "green", bbox, hw),
                    "blue": pool.submit(read_asset, item, "blue", bbox, hw),
                    "nir": pool.submit(read_asset, item, nir_key, bbox, hw),
                    "swir": pool.submit(read_asset, item, swir_key, bbox, hw),
                }
                bands = {k: f.result() for k, f in futures.items()}
                mask_key = "scl" if sentinel and "scl" in item.assets else "qa_pixel"
                mask = pool.submit(read_asset, item, mask_key, bbox, hw, True).result() if mask_key in item.assets else None
        except Exception as exc:
            log(f"  {label}: read failed {exc}")
            continue

        bands = to_reflectance(bands, sentinel)
        red, green, blue, nir, swir = (bands["red"], bands["green"], bands["blue"], bands["nir"], bands["swir"])

        if mask is not None and sentinel:
            scl = mask.astype("int16")
            valid = np.isin(scl, list(VALID_SCL))
            is_water = scl == 6
        elif mask is not None:
            qa = mask.astype("int32")
            valid = ((qa & 1) | (qa & 4) | (qa & 8) | (qa & 16)) == 0
            is_water = np.zeros_like(valid)
        else:
            valid = (red > -0.05) & (nir > -0.05)
            is_water = np.zeros_like(valid)

        eps = 1e-6
        ndvi = (nir - red) / (nir + red + eps)
        ndwi = (green - nir) / (green + nir + eps)
        ndbi = (swir - nir) / (swir + nir + eps)
        bsi = ((swir + red) - (nir + blue)) / ((swir + red) + (nir + blue) + eps)
        is_water = is_water | ((ndwi > 0.15) & valid)
        is_green = (ndvi > 0.30) & ~is_water & valid
        is_built = (ndbi > 0.05) & (ndvi < 0.18) & ~is_water & valid
        is_bare = (bsi > 0.05) & ~is_water & ~is_green & ~is_built & valid

        n = max(int(valid.sum()), 1)
        if n < valid.size * 0.25:
            log(f"  {label}: only {round(100 * n / valid.size, 1)}% visible, skipped")
            continue

        # What the ground under the pin itself is, in every frame: a 7x7 window
        # around the centre pixel, split by class.
        cy, cx = h // 2, w // 2
        win = (slice(max(0, cy - 3), cy + 4), slice(max(0, cx - 3), cx + 4))
        n_win = max(int(win[0].stop - win[0].start) * int(win[1].stop - win[1].start), 1)
        spot = {
            "water": round(100 * float(is_water[win].sum()) / n_win),
            "green": round(100 * float(is_green[win].sum()) / n_win),
            "built": round(100 * float(is_built[win].sum()) / n_win),
            "bare": round(100 * float(is_bare[win].sum()) / n_win),
            "seen": round(100 * float(valid[win].sum()) / n_win),
        }

        name = f"{args.slug}_{label}"
        rgb_bytes = save_rgb(OUT / f"rgb_{name}.png", red, green, blue, valid)
        rgb_images[label] = rgb_bytes
        dates.append({
            "year": label,
            "date": item.properties["datetime"][:10],
            "cloud": round(float(item.properties.get("eo:cloud_cover") or 0), 1),
            "scene": item.id,
            "sensor": "Sentinel-2" if sentinel else "Landsat",
            "resolution": 10 if sentinel else 30,
            "green": round(100 * float(is_green.sum()) / n, 1),
            "water": round(100 * float(is_water.sum()) / n, 1),
            "bare": round(100 * float(is_bare.sum()) / n, 1),
            "spot": spot,
            "seen": round(100 * n / valid.size, 1),
            "image": f"/sites/rgb_{name}.png",
        })
        layers[label] = {"green": is_green, "water": is_water, "built": is_built,
                         "bare": is_bare, "ndvi": ndvi, "valid": valid}
        log(f"  {label} {dates[-1]['sensor']}: green {dates[-1]['green']}% "
            f"water {dates[-1]['water']}% seen {dates[-1]['seen']}%")

    if len(dates) < 2:
        log("not enough clear frames at this location")
        sys.exit(2)

    pairs = []
    labels = [d["year"] for d in dates]
    for i, a in enumerate(labels):
        for b in labels[i + 1:]:
            la, lb = layers[a], layers[b]
            both = la["valid"] & lb["valid"]
            land = both & ~(la["water"] | lb["water"])
            n = max(int(land.sum()), 1)
            changed = land & (np.abs(la["ndvi"] - lb["ndvi"]) > 0.15)
            lost_green = land & (la["ndvi"] - lb["ndvi"] > 0.15)
            # Strict subset of "changed": a building only counts if the pixel
            # also crossed the change threshold, so the two numbers can never contradict.
            new_built = changed & lb["built"] & ~la["built"]
            new_water = both & (lb["water"] & ~la["water"])
            # Ground that was open water in the older frame and is not any more. This is the
            # one number that survives the land mask, because reclaimed sea is exactly the
            # case where "land" looks like it did not exist.
            reclaimed = both & la["water"] & ~lb["water"]
            name = f"{args.slug}_change_{a}_{b}"
            save_overlay(OUT / f"change_{name}.png", lost_green, new_built, new_water)
            pairs.append({
                "from": a, "to": b,
                "hotspots": find_hotspots(
                    changed, land, la, lb, rgb_images[a], rgb_images[b], m_per_px,
                    lon0, lat0, lon1, lat1, f"{args.slug}_{a}_{b}",
                    min_px=max(25, int(1200 / max(m_per_px ** 2, 1e-6))),
                ),
                "seen": round(100 * int(both.sum()) / both.size, 1),
                "changed": round(100 * float(changed.sum()) / n, 1),
                "lostGreen": round(100 * float(lost_green.sum()) / n, 1),
                "newBuilt": round(100 * float(new_built.sum()) / n, 1),
                "newWater": round(100 * float(new_water.sum()) / n, 1),
                "wasWater": round(100 * float(reclaimed.sum()) / max(int(both.sum()), 1), 1),
                "reclaimed_m2": int(round(reclaimed.sum() * m_per_px * m_per_px / 100.0) * 100),
                "overlay": f"/sites/change_{name}.png",
            })

    context = {}
    for key, fn in (("terrain", terrain), ("flood", flood_extent), ("heat", heat)):
        try:
            context[key] = fn(args.lat, args.lon)
            log(f"  {key}: {'ok' if context[key] else 'unavailable'}")
        except Exception as exc:
            context[key] = None
            log(f"  {key}: failed {exc}")

    payload = {
        "site": {
            "id": args.slug,
            "name": args.name,
            "city": "",
            "centre": [args.lat, args.lon],
            "bbox": bbox,
            "note": f"{args.km} km across",
        },
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Sentinel-2 L2A (ESA) and Landsat C2 L2 (USGS) · Earth Search and Microsoft Planetary Computer",
        "grid": [w, h],
        "dates": dates,
        "pairs": pairs,
        "context": context,
    }
    target.write_text(json.dumps(payload, indent=2), encoding="utf8")
    log(f"wrote {target.name}")
    print(str(target))


if __name__ == "__main__":
    main()
