# ---- app/render_aurora_oval.py ----

import json
import os
import numpy as np
import matplotlib.colors as mcolors
from datetime import datetime, timedelta
from pathlib import Path
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.interpolate import griddata
from utils import log, wait_for_db, get_db

WIDTH, HEIGHT = 2048, 1024
THRESHOLD_P = 5
BACKGROUND = Path("/app/static/land_shallow_topo.jpg")
HISTORY_DIR = Path("/app/static/aurora_oval_history")
HISTORY_DIR.mkdir(parents=True, exist_ok=True)

wait_for_db()

def _fetch_latest_grid():
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM ovation_aurora ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
    if not row:
        return [], []
    grid = np.asarray(json.loads(row["probs_json"]))
    nlat, nlon = grid.shape
    grid = np.roll(grid, nlon // 2, axis=1)
    lats = np.linspace(float(row["max_lat"]), float(row["min_lat"]), nlat)
    lons = np.linspace(-180, 180, nlon)
    lon_mesh, lat_mesh = np.meshgrid(lons, lats)
    probs_flat = grid.flatten()
    coords_flat = np.column_stack((lon_mesh.flatten(), lat_mesh.flatten()))
    valid_mask = probs_flat > THRESHOLD_P
    lat_mask = (coords_flat[:,1] > 40) | (coords_flat[:,1] < -40)
    final_mask = valid_mask & lat_mask
    return coords_flat[final_mask], probs_flat[final_mask] / 100.0

def _compute_lighting():
    now = datetime.utcnow()
    days = (now - datetime(2000, 1, 1, 12)).total_seconds() / 86400.0
    eps = np.deg2rad(23.439 - 0.0000004 * days)
    L = np.deg2rad((280.46 + 0.9856474 * days) % 360)
    M = np.deg2rad((357.528 + 0.9856003 * days) % 360)
    lam = L + np.deg2rad(1.915) * np.sin(M) + np.deg2rad(0.020) * np.sin(2*M)
    decl = np.arcsin(np.sin(eps) * np.sin(lam))
    utc_hours = now.hour + now.minute / 60 + now.second / 3600
    sub_lon = np.deg2rad((utc_hours - 12) * 15)
    lon = np.deg2rad(np.linspace(-180, 180, WIDTH))
    lat = np.deg2rad(np.linspace(90, -90, HEIGHT))
    lon2, lat2 = np.meshgrid(lon, lat)
    ha = lon2 - sub_lon
    sun_alt = np.arcsin(np.sin(lat2) * np.sin(decl) + np.cos(lat2) * np.cos(decl) * np.cos(ha))
    sd = np.rad2deg(sun_alt)
    f = np.clip((sd + 18) / 18, 0, 1)
    return f[..., None]

from PIL import ImageFont, ImageDraw
import pytz

def add_overlay_text(img):
    from PIL import ImageFont, ImageDraw
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (255,255,255,0))
    draw = ImageDraw.Draw(overlay, "RGBA")
    now_utc = datetime.utcnow()
    date_str = now_utc.strftime("%Y-%m-%d")
    time_str = now_utc.strftime("%H:%M")
    lines = [
        f"{date_str} | {time_str} UTC",
        "aurora.slashmad.com | © NOAA SWPC"
    ]
    try:
        font = ImageFont.truetype(
            os.getenv(
                "AURORA_FONT_PATH",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ),
            20,
        )
    except:
        font = ImageFont.load_default()
    text_bboxes = [draw.textbbox((0,0), line, font=font) for line in lines]
    text_widths = [bbox[2] - bbox[0] for bbox in text_bboxes]
    text_heights = [bbox[3] - bbox[1] for bbox in text_bboxes]
    pad_x = 36
    pad_y = 18
    gap = 22
    box_w = max(text_widths) + 2*pad_x
    box_h = sum(text_heights) + (len(lines)-1)*gap + 2*pad_y
    x0 = img.width - box_w - 40
    y0 = img.height - box_h - 40
    draw.rounded_rectangle([x0, y0, x0+box_w, y0+box_h], radius=32, fill=(0,0,0,64))
    y = y0 + pad_y
    for line, h in zip(lines, text_heights):
        draw.text((x0 + pad_x + 2, y + 2), line, font=font, fill="black")
        draw.text((x0 + pad_x, y), line, font=font, fill="white")
        y += h + gap
    img = Image.alpha_composite(img, overlay)
    return img

def render():
    now = datetime.utcnow()

    # Remove old frames and thumbnails (>12h) at every run
    cutoff = now - timedelta(hours=12)
    for f in HISTORY_DIR.glob("aurora_oval_*.png"):
        try:
            # Matchar både fullsize och thumb-filer (de slutar på _thumb.png eller .png)
            # Hämta tidstämpel ur filnamnet (för båda)
            stem = f.name.replace('_thumb', '')
            t = datetime.strptime(stem, "aurora_oval_%Y%m%d_%H%M.png")
            if t < cutoff:
                log(f"Deleting old frame or thumb: {f}")
                f.unlink()
        except Exception as e:
            log(f"Error deleting {f}: {e}")


    # Only render at 5-minute intervals
    if now.minute % 5 != 0:
        log(f"Skipping render at {now.strftime('%H:%M')}: Not a 5-minute mark.")
        return

    timestamp = now.strftime('%Y%m%d_%H%M')
    history_path = HISTORY_DIR / f"aurora_oval_{timestamp}.png"
    if history_path.exists():
        log(f"Image for {timestamp} already exists, skipping render.")
        return

    log("Rendering at UTC: " + now.strftime('%Y-%m-%d %H:%M:%S'))
    coords, values = _fetch_latest_grid()
    if len(coords) == 0:
        log("No OVATION data available.")
        return

    minprob = 0.13
    maxprob = 1.00
    lon_grid = np.linspace(-180, 180, WIDTH)
    lat_grid = np.linspace(-90, 90, HEIGHT)
    lon_mesh, lat_mesh = np.meshgrid(lon_grid, lat_grid)
    grid_interp = griddata(coords, values, (lon_mesh, lat_mesh), method='linear', fill_value=0)
    smooth = gaussian_filter(grid_interp, sigma=3)
    smooth[smooth < minprob] = 0
    stretched = np.clip(smooth / maxprob, 0, 1)
    alpha = np.clip(stretched * 3, 0, 1)

    SWL_COLORS = [
        (0.00, "#45ff42"),
        (0.28, "#5bfa32"),
        (0.55, "#b6f549"),
        (0.65, "#e4f549"),
        (0.75, "#f5d049"),
        (0.85, "#c73030"),
        (1.00, "#c40202"),
    ]
    CMAP = mcolors.LinearSegmentedColormap.from_list("aurora", SWL_COLORS, N=256)
    rgb = CMAP(stretched)[..., :3]
    bg_image = Image.open(BACKGROUND).resize((WIDTH, HEIGHT), Image.BILINEAR)
    bg = np.asarray(bg_image, dtype=np.float64) / 255.0
    shade = 0.3 + 0.7 * _compute_lighting()
    shade = np.flip(shade, axis=1)
    bg[..., :3] *= shade
    out = (1 - alpha[..., None]) * bg + alpha[..., None] * rgb
    img_rgba = np.dstack([np.clip(out, 0, 1) * 255, np.full((HEIGHT, WIDTH), 255)])
    img = Image.fromarray(img_rgba.astype(np.uint8), mode="RGBA")

    img_overlay = add_overlay_text(img)
    img_overlay.save(history_path)
    thumb_path = history_path.with_name(history_path.stem + '_thumb.png')
    thumb = img_overlay.copy()
    thumb = thumb.resize((770, 385), Image.LANCZOS)
    thumb.save(thumb_path, "PNG", optimize=True)
    log(f"Aurora-map saved: {history_path}")

if __name__ == "__main__":
    import time
    while True:
        render()
        time.sleep(60)
