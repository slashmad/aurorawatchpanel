# ---- app/main.py ----
from __future__ import annotations
import threading
import time
import os
import heapq
import requests
import pytz
import pymysql
import numpy as np
import re
from fastapi import FastAPI, Request, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, FileResponse, Response, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from html import escape
from typing import Annotated
from utils import DB, fetch_text, get_db
from pathlib import Path
from datetime import datetime, timedelta, timezone
from timezonefinder import TimezoneFinder
from moon_parallax import get_parallactic_angle
from skyfield_astro import get_sun_moon_info
from routes_solar import router as solar_router
from routes_skyfield import router as astro_router
from routes_weather import weather_router
from routes_coronal_holes import router as coronal_router

app = FastAPI(
    title="Aurora Watch Nextgen API",
    description="FastAPI backend with separate Skyfield endpoints for sun & moon data",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # just for development, tighten later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(solar_router, prefix="/api/solar")
app.include_router(astro_router, prefix="/astro")
app.include_router(weather_router)
app.include_router(coronal_router, prefix="/api")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATE_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_IMAGE_DIR = DATA_DIR / "images"
SVG_DIR = DATA_DIR / "svg"
ALLSKY_FS_ROOT = Path(os.getenv("ALLSKY_FS_ROOT", "/allsky-images")).resolve()
LYCKEBO_FS_ROOT = DATA_IMAGE_DIR / "lyckebocam"

DEFAULT_IMAGE_LIST_LIMIT = 240
MAX_IMAGE_LIST_LIMIT = 1000
MAX_HP30_HOURS = 24 * 30

app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")
app.mount("/svg", StaticFiles(directory=str(SVG_DIR)), name="svg")
app.mount("/allsky-images", StaticFiles(directory=str(ALLSKY_FS_ROOT)), name="allsky-images")

templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    images = {"SDO/AIA 193": [], "SDO/AIA 211": [], "SDO/AIA 171": [], "SDO/AIA 304": [], "SDO/AIA 131": [], "SDO/AIA HMIIF": [], "Synoptic Map": []}
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "request": request,
            "stations": [
                {
                    "id": "KIR",
                    "name": "Kiruna",
                    "lat": 67.84,
                    "lon": 20.41,
                }
            ],
            "images": images,
        },
    )

@app.get("/images/list")
def images_list(
    label: str,
    limit: int | None = Query(default=None, ge=1, le=MAX_IMAGE_LIST_LIMIT),
):
    key_map = {
        "SDO/AIA 131": ("SDO_131", ".jpg"),
        "SDO/AIA 171": ("SDO_171", ".jpg"),
        "SDO/AIA 193": ("SDO_193", ".jpg"),
        "SDO/AIA 211": ("SDO_211", ".jpg"),
        "SDO/AIA 304": ("SDO_304", ".jpg"),
        "SDO/AIA HMIIF": ("SDO_HMIIF", ".jpg"),
        "Synoptic Map": ("Synoptic", ".jpg"),
    }
    if label not in key_map:
        return {"files": [], "limit": limit, "has_more": False}
    key, ext = key_map[label]
    category_dir = DATA_IMAGE_DIR / key
    effective_limit = limit
    if effective_limit is None and label != "Synoptic Map":
        effective_limit = DEFAULT_IMAGE_LIST_LIMIT

    candidates = category_dir.glob(f"{key}_*{ext}")
    if effective_limit is None:
        files = sorted(candidates, key=lambda path: path.name, reverse=True)
        has_more = False
    else:
        files = heapq.nlargest(
            effective_limit + 1,
            candidates,
            key=lambda path: path.name,
        )
        has_more = len(files) > effective_limit
        files = files[:effective_limit]

    return {
        "files": [f"{key}/{path.name}" for path in files],
        "limit": effective_limit,
        "has_more": has_more,
    }

@app.get("/images/{category}/{filename}")
def get_image(category: str, filename: str):
    fpath = DATA_IMAGE_DIR / category / filename
    if fpath.exists():
        return FileResponse(str(fpath))
    return {"error": "Not found"}

# main.py (replace the AllSky block around _ALLSKY_CACHE / ALLSKY_CAMERAS and the two endpoints)

_ALLSKY_CACHE_BY_CAM: dict[str, dict] = {}           # cam -> {"ts": float, "data": dict}
_ALLSKY_THUMBS_CACHE_BY_CAM: dict[str, dict] = {}    # f"{cam}|{date}" -> {"ts": float, "data": dict}

ALLSKY_CAMERAS = {
  "ytterboda": {
    "type": "remote_slashmad",
    "base": "https://allsky.slashmad.com/allsky/images/",
  },
  "tavelsjo": {
    "type": "local",
    "root": str(DATA_IMAGE_DIR / "lyckebocam"),
    "thumb_dir": "thumbs",
  },
  "kiruna": {
    "type": "irf_alis_krn",
    "base": "https://www.irf.se/alis/allsky/krn/",
  },
}

def _allsky_validate_cam(cam: str) -> str:
    cam = (cam or "").strip().lower()
    if not cam:
        cam = "ytterboda"
    if cam not in ALLSKY_CAMERAS:
        raise ValueError(f"Unknown cam: {cam}")
    return cam

def _allsky_parse_local_filename(fn: str):
    # Expected: Lyckebo_20260116T171643Z.jpg
    m = re.search(r'_(\d{8})T(\d{6})Z', fn)
    if not m:
        return None
    ymd = m.group(1)
    hms = m.group(2)
    return ymd, hms  # ("YYYYMMDD", "HHMMSS")

def _allsky_local_day_dir(root: Path, ymd: str) -> Path:
    # ymd: YYYYMMDD -> root/YYYY/MM/DD
    return root / ymd[0:4] / ymd[4:6] / ymd[6:8]

def _allsky_local_urls(root: Path, thumb_dir: str, ymd: str, filename: str):
    # served via /data mount: /data/images/lyckebocam/...
    rel_day = f"{ymd[0:4]}/{ymd[4:6]}/{ymd[6:8]}"
    base = "/data/images/lyckebocam"
    full_url = f"{base}/{rel_day}/{filename}"

    # Thumbs are stored as <stem>_thumb.<ext> inside /thumbs
    p = Path(filename)
    thumb_name = f"{p.stem}_thumb{p.suffix}"

    # Fallback for older layouts (same filename in thumb_dir)
    day_dir = _allsky_local_day_dir(root, ymd)
    if not (day_dir / thumb_dir / thumb_name).exists():
        thumb_name = filename

    thumb_url = f"{base}/{rel_day}/{thumb_dir}/{thumb_name}"
    return full_url, thumb_url

def _allsky_remote_slashmad_latest(base: str, date: str | None):
    root_html = fetch_text(base, timeout=10)
    if not root_html:
        return {"error": "Could not fetch AllSky root listing"}

    dates = sorted(set(re.findall(r'href="(\d{8})/?\"', root_html)))
    if not dates:
        return {"error": "No date folders found"}

    pick_date = date if (date and date in dates) else dates[-1]

    day_html = fetch_text(f"{base}{pick_date}/", timeout=10)
    if not day_html:
        return {"error": f"Could not fetch AllSky listing for {pick_date}"}

    names = re.findall(r'href="(image-(\d{14})\.jpg)"', day_html)
    if not names:
        return {"error": f"No images found for {pick_date}"}

    filename, ts14 = max(names, key=lambda x: x[1])
    captured = f"{ts14[8:10]}:{ts14[10:12]}:{ts14[12:14]}"
    return {
        "date": pick_date,
        "filename": filename,
        "url": f"{base}{pick_date}/{filename}",
        "captured": captured,
    }

def _allsky_remote_slashmad_thumbs(base: str, pick_date: str):
    thumbs_html = fetch_text(f"{base}{pick_date}/thumbnails/", timeout=10)
    if not thumbs_html:
        return {"error": f"Could not fetch AllSky thumbnails listing for {pick_date}"}

    names = re.findall(r'href="(image-(\d{14})\.jpg)"', thumbs_html)
    items = []
    for fname, ts14 in sorted(names, key=lambda x: x[1], reverse=True):
        items.append({
            "filename": fname,
            "ts": ts14,
            "captured": f"{ts14[8:10]}:{ts14[10:12]}:{ts14[12:14]}",
            "thumb_url": f"{base}{pick_date}/thumbnails/{fname}",
            "full_url": f"{base}{pick_date}/{fname}",
        })
    return {"date": pick_date, "items": items}

def _allsky_kiruna_latest(base: str):
    # Find latest by probing latest day + hour folders.
    # Strategy: list YYYY/MM/DD, then find highest hour folder, then newest full jpeg (not _small/_medium).
    now_utc = datetime.now(timezone.utc)

    # Try today and yesterday (handles midnight gaps)
    for day_offset in [0, 1]:
        d = (now_utc - timedelta(days=day_offset)).date()
        day_path = f"{d.year:04d}/{d.month:02d}/{d.day:02d}/"
        day_html = fetch_text(f"{base}{day_path}", timeout=10)
        if not day_html:
            continue

        hours = sorted(set(re.findall(r'href="(\d{2})/\"', day_html)))
        if not hours:
            continue
        hour = hours[-1]
        hour_path = f"{day_path}{hour}/"

        hour_html = fetch_text(f"{base}{hour_path}", timeout=10)
        if not hour_html:
            continue

        # Full size: ...KRN.jpeg but NOT _small/_medium
        files = re.findall(r'href="([^"]+KRN\.jpeg)"', hour_html)
        files = [f for f in files if not f.endswith("_small.jpeg") and not f.endswith("_medium.jpeg")]
        if not files:
            continue
        files.sort()  # lexicographic works for timestamp prefix
        filename = files[-1]

        # Derive captured from filename: 2026-01-16T18.03.00.000KRN.jpeg
        captured = ""
        m = re.match(r'(\d{4}-\d{2}-\d{2})T(\d{2})\.(\d{2})\.(\d{2})\.\d+KRN\.jpeg', filename)
        if m:
            captured = f"{m.group(2)}:{m.group(3)}:{m.group(4)}"

        # date format to match UI: YYYYMMDD
        ymd = f"{d.year:04d}{d.month:02d}{d.day:02d}"

        return {
            "date": ymd,
            "filename": filename,
            "url": f"{base}{hour_path}{filename}",
            "captured": captured,
        }

    return {"error": "Could not find Kiruna latest image"}

def _allsky_kiruna_thumbs(base: str, ymd: str):
    # ymd: YYYYMMDD
    d = datetime.strptime(ymd, "%Y%m%d").date()
    day_path = f"{d.year:04d}/{d.month:02d}/{d.day:02d}/"
    day_html = fetch_text(f"{base}{day_path}", timeout=10)
    if not day_html:
        return {"date": ymd, "items": []}

    hours = sorted(set(re.findall(r'href="(\d{2})/\"', day_html)))
    items = []

    for hour in hours:
        hour_path = f"{day_path}{hour}/"
        hour_html = fetch_text(f"{base}{hour_path}", timeout=10)
        if not hour_html:
            continue

        # full files + small thumbs
        fulls = re.findall(r'href="([^"]+KRN\.jpeg)"', hour_html)
        fulls = [f for f in fulls if not f.endswith("_small.jpeg") and not f.endswith("_medium.jpeg")]
        for fn in fulls:
            # build thumb by replacing suffix
            thumb = fn.replace("KRN.jpeg", "KRN_small.jpeg")
            # captured from filename if possible
            captured = ""
            m = re.match(r'\d{4}-\d{2}-\d{2}T(\d{2})\.(\d{2})\.(\d{2})\.\d+KRN\.jpeg', fn)
            if m:
                captured = f"{m.group(1)}:{m.group(2)}:{m.group(3)}"
            items.append({
                "filename": fn,
                "captured": captured,
                "thumb_url": f"{base}{hour_path}{thumb}",
                "full_url": f"{base}{hour_path}{fn}",
            })

    # newest first (string sort works)
    items.sort(key=lambda x: x["filename"], reverse=True)
    return {"date": ymd, "items": items}


@app.get("/api/allsky/latest")
def allsky_latest(cam: str = "ytterboda", date: str | None = None):
    """
    cam: ytterboda | tavelsjo | kiruna
    date:
      - ytterboda: YYYYMMDD
      - tavelsjo: YYYYMMDD (mapped to YYYY/MM/DD on disk)
      - kiruna: YYYYMMDD (UTC day)
    """
    try:
        cam = _allsky_validate_cam(cam)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    now = time.time()
    cached = _ALLSKY_CACHE_BY_CAM.get(cam)
    if cached and cached.get("data") and (now - cached["ts"] < 20):
        return cached["data"]

    cfg = ALLSKY_CAMERAS[cam]
    out = None

    if cfg["type"] == "remote_slashmad":
        out = _allsky_remote_slashmad_latest(cfg["base"], date)

    elif cfg["type"] == "local":
        root = Path(cfg["root"])
        thumb_dir = cfg.get("thumb_dir", "thumbnails")

        # pick date
        if date and re.fullmatch(r"\d{8}", date):
            pick_ymd = date
        else:
            pick_ymd = datetime.utcnow().strftime("%Y%m%d")

        day_dir = _allsky_local_day_dir(root, pick_ymd)
        if not day_dir.exists():
            return {"error": f"No local AllSky folder for {pick_ymd}"}

        files = [p.name for p in day_dir.iterdir() if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png")]
        files = [fn for fn in files if _allsky_parse_local_filename(fn)]
        if not files:
            return {"error": f"No local AllSky images found for {pick_ymd}"}

        files.sort()
        filename = files[-1]
        parsed = _allsky_parse_local_filename(filename)
        captured = ""
        if parsed:
            _, hms = parsed
            captured = f"{hms[0:2]}:{hms[2:4]}:{hms[4:6]}"

        full_url, _ = _allsky_local_urls(root, thumb_dir, pick_ymd, filename)
        out = {"date": pick_ymd, "filename": filename, "url": full_url, "captured": captured}

    elif cfg["type"] == "irf_alis_krn":
        out = _allsky_kiruna_latest(cfg["base"])

    else:
        out = {"error": f"Unsupported cam type: {cfg['type']}"}

    _ALLSKY_CACHE_BY_CAM[cam] = {"ts": now, "data": out}
    return out


@app.get("/api/allsky/thumbnails")
def allsky_thumbnails(cam: str = "ytterboda", date: str | None = None):
    """
    Returns thumbnails for the selected cam + date.
    """
    try:
        cam = _allsky_validate_cam(cam)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    latest = allsky_latest(cam=cam, date=date)
    if not latest or latest.get("error"):
        return latest

    pick_date = latest["date"]
    now = time.time()
    cache_key = f"{cam}|{pick_date}"
    cached = _ALLSKY_THUMBS_CACHE_BY_CAM.get(cache_key)
    if cached and (now - cached["ts"] < 20):
        return cached["data"]

    cfg = ALLSKY_CAMERAS[cam]
    data = None

    if cfg["type"] == "remote_slashmad":
        data = _allsky_remote_slashmad_thumbs(cfg["base"], pick_date)

    elif cfg["type"] == "local":
        root = Path(cfg["root"])
        thumb_dir = cfg.get("thumb_dir", "thumbnails")
        day_dir = _allsky_local_day_dir(root, pick_date)
        if not day_dir.exists():
            data = {"date": pick_date, "items": []}
        else:
            files = [p.name for p in day_dir.iterdir() if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png")]
            files = [fn for fn in files if _allsky_parse_local_filename(fn)]
            files.sort(reverse=True)

            items = []
            for fn in files:
                parsed = _allsky_parse_local_filename(fn)
                captured = ""
                if parsed:
                    _, hms = parsed
                    captured = f"{hms[0:2]}:{hms[2:4]}:{hms[4:6]}"
                full_url, thumb_url = _allsky_local_urls(root, thumb_dir, pick_date, fn)
                items.append({
                    "filename": fn,
                    "captured": captured,
                    "thumb_url": thumb_url,
                    "full_url": full_url,
                })
            data = {"date": pick_date, "items": items}

    elif cfg["type"] == "irf_alis_krn":
        data = _allsky_kiruna_thumbs(cfg["base"], pick_date)

    else:
        data = {"date": pick_date, "items": []}

    _ALLSKY_THUMBS_CACHE_BY_CAM[cache_key] = {"ts": now, "data": data}
    return data


@app.get("/allsky/browser", response_class=HTMLResponse)
def allsky_browser(p: str = ""):
    # Sanitize path (no absolute, no traversal)
    rel = (p or "").lstrip("/")
    parts = Path(rel).parts
    if any(x in ("..",) for x in parts):
        return HTMLResponse("Invalid path", status_code=400)

    fs_path = (ALLSKY_FS_ROOT / rel).resolve()
    if not str(fs_path).startswith(str(ALLSKY_FS_ROOT)):
        return HTMLResponse("Invalid path", status_code=400)

    if not fs_path.exists():
        return HTMLResponse("Not found", status_code=404)

    # If user clicked a file inside the browser: redirect to nginx-served file URL
    if fs_path.is_file():
        return RedirectResponse(url=f"/allsky-images/{rel}")

    # Directory listing, sorted by newest first (mtime desc)
    entries = []
    for e in fs_path.iterdir():
        try:
            st = e.stat()
            entries.append((e, st.st_mtime))
        except Exception:
            continue

    entries.sort(key=lambda x: x[1], reverse=True)

    # Breadcrumb / up link
    up = "/".join(Path(rel).parts[:-1])
    up_q = f"?p={escape(up)}" if up else ""

    rows = []
    for e, mtime in entries:
        name = e.name + ("/" if e.is_dir() else "")
        href_rel = f"{rel}/{e.name}".strip("/")
        if e.is_dir():
            href = f"/allsky/browser?p={escape(href_rel)}"
        else:
            href = f"/allsky-images/{escape(href_rel)}"
        rows.append(f'<li><a href="{href}">{escape(name)}</a></li>')

    title = f"AllSky archive: /{escape(rel) if rel else ''}"
    html = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; background:#0b1220; color:#e6eefc; }}
    a {{ color:#8bd3ff; text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    .bar {{ display:flex; gap:12px; align-items:center; margin-bottom:12px; }}
    .path {{ opacity:0.9; }}
    ul {{ list-style:none; padding:0; margin:0; }}
    li {{ padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06); }}
  </style>
</head>
<body>
  <div class="bar">
    <div class="path">{title}</div>
    <div style="margin-left:auto;">
      <a href="/allsky/browser{up_q}">Up</a>
    </div>
  </div>
  <ul>
    {''.join(rows) if rows else '<li><em>Empty</em></li>'}
  </ul>
</body>
</html>"""
    return HTMLResponse(html)

@app.get("/lyckebo/browser", response_class=HTMLResponse)
def lyckebo_browser(p: str = ""):
    # Sanitize path (no absolute, no traversal)
    rel = (p or "").lstrip("/")
    parts = Path(rel).parts
    if any(x in (".",) for x in parts):
        return HTMLResponse("Invalid path", status_code=400)

    fs_path = (LYCKEBO_FS_ROOT / rel).resolve()
    if not str(fs_path).startswith(str(LYCKEBO_FS_ROOT)):
        return HTMLResponse("Invalid path", status_code=400)

    if not fs_path.exists():
        return HTMLResponse("Not found", status_code=404)

    # If user clicked a file inside the browser: redirect to /data served file URL
    if fs_path.is_file():
        return RedirectResponse(url=f"/data/images/lyckebocam/{rel}")

    # Directory listing, sorted by newest first (mtime desc)
    entries = []
    for e in fs_path.iterdir():
        try:
            st = e.stat()
            entries.append((e, st.st_mtime))
        except Exception:
            continue
    entries.sort(key=lambda x: x[1], reverse=True)

    up = "/".join(Path(rel).parts[:-1])
    up_q = f"?p={escape(up)}" if up else ""

    rows = []
    for e, _mtime in entries:
        name = e.name + ("/" if e.is_dir() else "")
        href_rel = f"{rel}/{e.name}".strip("/")
        if e.is_dir():
            href = f"/lyckebo/browser?p={escape(href_rel)}"
        else:
            href = f"/data/images/lyckebocam/{escape(href_rel)}"
        rows.append(f'<li><a href="{href}">{escape(name)}</a></li>')

    title = f"Lyckebo archive: /{escape(rel) if rel else ''}"
    html = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; background:#0b1220; color:#e6eefc; }}
    a {{ color:#8bd3ff; text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    .bar {{ display:flex; gap:12px; align-items:center; margin-bottom:12px; }}
    .path {{ opacity:0.9; }}
    ul {{ list-style:none; padding:0; margin:0; }}
    li {{ padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.06); }}
  </style>
</head>
<body>
  <div class="bar">
    <div class="path">{title}</div>
    <div style="margin-left:auto;">
      <a href="/lyckebo/browser{up_q}">Up</a>
    </div>
  </div>
  <ul>
    {''.join(rows)}
  </ul>
</body>
</html>"""
    return HTMLResponse(html)

def _parse_replay_date(date_str: str) -> tuple[datetime, datetime, str] | None:
    """
    Accepts:
      - YYYY-MM-DD
      - DD/MM/YYYY
    Returns (start_utc, end_utc, yyyymmdd)
    """
    s = (date_str or "").strip()
    try:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            day = datetime.strptime(s, "%Y-%m-%d")
        elif re.match(r"^\d{1,2}/\d{1,2}/\d{4}$", s):
            dd, mm, yyyy = s.split("/")
            day = datetime.strptime(f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}", "%Y-%m-%d")
        else:
            return None
        start = datetime(day.year, day.month, day.day, 0, 0, 0, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        return start, end, day.strftime("%Y%m%d")
    except Exception:
        return None


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _dt_from_sdo_thumb_name(filename: str) -> datetime | None:
    # Ex: SDO_193_20260111T000005Z_thumb.jpg (Z optional)
    m = re.match(r"^SDO_193_(\d{8})T(\d{6})(Z)?_thumb\.jpg$", filename)
    if not m:
        return None
    ymd = m.group(1)
    hms = m.group(2)
    try:
        return datetime.strptime(f"{ymd}{hms}", "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _dt_from_allsky_name(filename: str) -> datetime | None:
    # Ex: image-YYYYMMDDHHMMSS.jpg, interpret as Europe/Stockholm local time, convert to UTC
    m = re.match(r"^image-(\d{14})\.jpg$", filename)
    if not m:
        return None
    ts14 = m.group(1)
    try:
        local_tz = pytz.timezone("Europe/Stockholm")
        naive = datetime.strptime(ts14, "%Y%m%d%H%M%S")
        local_dt = local_tz.localize(naive)
        return local_dt.astimezone(pytz.utc).replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _load_replay_database(start_utc, end_utc, station_list, component):
    col_map = {"x": "kirx", "y": "kiry", "z": "kirz"}
    mag_col = col_map[component]
    start_naive = start_utc.replace(tzinfo=None)
    end_naive = end_utc.replace(tzinfo=None)
    db = get_db()
    try:
        solarwind = []
        with db.cursor() as cur:
            cur.execute(
                """
                SELECT timestamp, speed, density, bt, bz, `by`
                FROM solarwind
                WHERE timestamp >= %s AND timestamp < %s
                ORDER BY timestamp ASC
                """,
                (start_naive, end_naive),
            )
            for r in cur.fetchall():
                ts = r.get("timestamp")
                if not ts:
                    continue
                ts = ts.replace(tzinfo=timezone.utc)
                solarwind.append({
                    "time": _iso_z(ts),
                    "speed": r.get("speed"),
                    "density": r.get("density"),
                    "bt": r.get("bt"),
                    "bz": r.get("bz"),
                    "by": r.get("by"),
                })

        # Magnetometer: unify IRF + FMI + GLOBAL + UIT with same response shape.
        uit_col_map = {"x": "D_deg", "y": "H_nT", "z": "Z_nT"}
        mag_sources = [
            {"table": "magnetometer", "station_col": "station", "value_col": mag_col},
            {"table": "magnetometer_fmi", "station_col": "station", "value_col": component},
            {"table": "magnetometer_global", "station_col": "station", "value_col": component},
            {
                "table": "magnetometer_uit_gif",
                "station_col": "station",
                "value_col": uit_col_map.get(component, "D_deg"),
            },
        ]

        def _fetch_mag_series(cur, station: str):
            for src in mag_sources:
                table = src["table"]
                st_col = src["station_col"]
                v_col = src["value_col"]
                v_col_sql = f"`{v_col}`"
                cur.execute(
                    f"""
                    SELECT timestamp, {v_col_sql} AS v
                    FROM {table}
                    WHERE {st_col} = %s AND timestamp >= %s AND timestamp < %s
                    ORDER BY timestamp ASC
                    """,
                    (station, start_naive, end_naive),
                )
                rows = cur.fetchall()
                vals = [rr["v"] for rr in rows if rr.get("v") is not None]
                if not vals:
                    continue
                base = sum(vals) / len(vals)
                out = []
                for rr in rows:
                    if rr.get("v") is None or rr.get("timestamp") is None:
                        continue
                    ts = rr["timestamp"].replace(tzinfo=timezone.utc)
                    out.append({
                        "time": _iso_z(ts),
                        "value": round(rr["v"] - base, 2),
                    })
                return out
            return []

        magnetometer = {}
        with db.cursor() as cur:
            for st in station_list:
                magnetometer[st] = _fetch_mag_series(cur, st)

        kp = []
        with db.cursor() as cur:
            cur.execute(
                """
                SELECT timestamp, kp
                FROM kp_index
                WHERE timestamp >= %s AND timestamp < %s
                ORDER BY timestamp ASC
                """,
                (start_naive, end_naive),
            )
            for r in cur.fetchall():
                ts = r.get("timestamp")
                if ts is None or r.get("kp") is None:
                    continue
                kp.append({
                    "time": _iso_z(ts.replace(tzinfo=timezone.utc)),
                    "kp": r.get("kp"),
                })

        hp = []
        with db.cursor() as cur:
            cur.execute(
                """
                SELECT timestamp, hp30, ap30, hp60, ap60
                FROM hp_index
                WHERE timestamp >= %s AND timestamp < %s
                ORDER BY timestamp ASC
                """,
                (start_naive, end_naive),
            )
            for r in cur.fetchall():
                ts = r.get("timestamp")
                if ts is None:
                    continue
                if all(r.get(k) is None for k in ("hp30", "hp60", "ap30", "ap60")):
                    continue
                hp.append({
                    "time": _iso_z(ts.replace(tzinfo=timezone.utc)),
                    "hp30": r.get("hp30"),
                    "ap30": r.get("ap30"),
                    "hp60": r.get("hp60"),
                    "ap60": r.get("ap60"),
                })

        return solarwind, magnetometer, kp, hp
    finally:
        db.close()


@app.get("/api/replay/day")
def replay_day(
    date: str = Query(..., description="YYYY-MM-DD or DD/MM/YYYY"),
    stations: str = Query("KIR", description="Comma-separated station codes"),
    component: str = Query("x", description="x|y|z for magnetometer"),
):
    parsed = _parse_replay_date(date)
    if not parsed:
        return {"error": "Invalid date. Use YYYY-MM-DD or DD/MM/YYYY."}

    start_utc, end_utc, yyyymmdd = parsed

    component = (component or "x").lower()
    if component not in ("x", "y", "z"):
        component = "x"

    station_list = [s.strip().upper() for s in (stations or "").split(",") if s.strip()]
    if not station_list:
        station_list = ["KIR"]
    # Special: ALL -> all known stations across IRF + FMI + GLOBAL + UIT
    if len(station_list) == 1 and station_list[0] == "ALL":
        station_list = [
            # IRF
            "KIR", "TOP",
            # FMI
            "KEV", "MAS", "KIL", "IVA", "MUO", "SOD", "PEL", "RAN", "OUJ", "MEK", "HAN", "NUR", "TAR",
            # GLOBAL (USGS)
            "BOU", "FRD", "BRW", "CMO",
            # UIT
            "TRO", "NOR", "SOR", "AND", "RST", "JCK", "DON", "RVK", "DOB", "SOL", "HAR", "KAR", "NAL", "LYR", "HOP", "BJN",
        ]

    solarwind, magnetometer, kp, hp = _load_replay_database(
        start_utc,
        end_utc,
        station_list,
        component,
    )

    # --- SDO 193: from coronal-holes thumbs (small JPGs)
    sdo_items = []
    holes_root = DATA_IMAGE_DIR / "coronal-holes"
    day_dir = holes_root / yyyymmdd[:4] / yyyymmdd[4:6] / yyyymmdd[6:8]

    if day_dir.exists():
        candidates = sorted(day_dir.glob(f"SDO_193_{yyyymmdd}T*_thumb.jpg"))
        for p in candidates:
            dt = _dt_from_sdo_thumb_name(p.name)
            if not dt:
                continue
            rel = p.relative_to(DATA_DIR).as_posix()  # images/...
            sdo_items.append({
                "time": _iso_z(dt),
                "url": f"/data/{rel}",
                "filename": p.name,
            })

    # Keep chronological order
    sdo_items.sort(key=lambda x: x["time"])

    # --- AllSky: full frames from local /allsky-images/YYYYMMDD/image-*.jpg
    allsky_items = []
    day_dir = ALLSKY_FS_ROOT / yyyymmdd
    if day_dir.exists():
        for p in sorted(day_dir.glob("image-*.jpg")):
            dt = _dt_from_allsky_name(p.name)
            if not dt:
                continue
            allsky_items.append({
                "time": _iso_z(dt),
                "url": f"/allsky-images/{yyyymmdd}/{p.name}",
                "filename": p.name,
            })

    return {
        "date": date,
        "start": _iso_z(start_utc),
        "end": _iso_z(end_utc - timedelta(seconds=1)),
        "solarwind": solarwind,
        "magnetometer": magnetometer,
        "kp": kp,
        "hp": hp,
        "sdo_193": sdo_items,
        "allsky": allsky_items,
    }


@app.get("/noaa_anim/list/{product}")
def list_noaa_images(product: str):
    path = Path("/app/data/noaa_anim") / product
    if not path.exists() or not path.is_dir():
        return JSONResponse({"files": []})
    files = sorted([f.name for f in path.iterdir() if f.is_file() and f.suffix in [".jpg", ".png", ".gif"]])
    return JSONResponse({"files": files})

@app.get("/huxt/list")
def list_huxt_files():
    path = Path("/app/data/huxt")
    if not path.exists() or not path.is_dir():
        return JSONResponse({"files": []})
    files = sorted([f.name for f in path.iterdir() if f.is_file() and f.suffix in [".mp4"]])
    return JSONResponse({"files": files})

@app.get("/moonparallax")
async def moonparallax(
    lat: float = Query(...),
    lon: float = Query(...),
    time: str = Query(...)  # ISO8601 t.ex. 2025-06-13T08:00:00
):
    if time.endswith("Z"):
        time = time[:-1]
    if "." in time:
        time = time.split(".")[0]
    dt = datetime.fromisoformat(time)
    if dt.tzinfo is None:
        from skyfield.api import utc
        dt = dt.replace(tzinfo=utc)
    angle = get_parallactic_angle(lat, lon, dt)
    return {"parallactic_angle": angle}

@app.get("/api/auroraoval")
def get_latest_aurora_oval():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT * FROM ovation_aurora ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
    finally:
        db.close()
    if not row:
        return {"error": "No data"}
    import json
    try:
        row["coordinates"] = json.loads(row.get("probs_json") or "[]")
    except Exception:
        return {"error": "Could not decode coordinates"}
    row.pop("probs_json", None)
    row.pop("probs_south_json", None)
    row.pop("id", None)
    return row

@app.get("/auroraoval/list")
def aurora_oval_list():
    history_dir = Path("/app/static/aurora_oval_history")
    files = sorted(history_dir.glob("aurora_oval_*.png"))
    return {
        "files": [
            f"/static/aurora_oval_history/{f.name}" for f in files
        ]
    }

@app.get("/hp30/timeseries")
def hp30_timeseries(
    hours: Annotated[int, Query(ge=1, le=MAX_HP30_HOURS)] = 6,
):
    db = get_db()
    try:
        with db.cursor() as cur:
            cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
            cur.execute("SELECT timestamp, hp30, ap30, hp60, ap60 FROM hp_index WHERE timestamp >= %s ORDER BY timestamp ASC", (cutoff,))
            rows = cur.fetchall()
    finally:
        db.close()
    return {"data": [r for r in rows if any(r[k] is not None for k in ["hp30", "hp60"])]}

@app.get("/kp/timeseries")
def kp_timeseries(hours: int = 3):
    db = get_db()
    try:
        with db.cursor() as cur:
            cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
            cur.execute("SELECT timestamp, kp FROM kp_index WHERE timestamp >= %s ORDER BY timestamp ASC", (cutoff,))
            rows = cur.fetchall()
    finally:
        db.close()
    return {"data": [{"time": r["timestamp"], "kp": r["kp"]} for r in rows if r["kp"] is not None]}

@app.get("/solarwind/timeseries")
def solarwind_timeseries(param: str, hours: int = 3):
    allowed = {"speed", "density", "bt", "bz", "by"}
    if param not in allowed:
        return {"error": "Ogiltig parameter"}
    db = get_db()
    try:
        with db.cursor() as cur:
            cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
            cur.execute(f"SELECT timestamp, `{param}` FROM solarwind WHERE timestamp >= %s ORDER BY timestamp ASC", (cutoff,))
            rows = cur.fetchall()
    finally:
        db.close()
    return {"data": [{"time": r["timestamp"], "value": r[param]} for r in rows if r[param] is not None]}

@app.get("/magneto/timeseries_multi")
def magneto_timeseries_multi(
    stations: str,
    hours: int = 3,
    component: str = "x"
):
    db = get_db()
    try:
        station_list = [s.strip().upper() for s in stations.split(",") if s.strip()]
        component = component.lower()
        if component not in ("x", "y", "z"):
            component = "x"
        col_map = {"x": "kirx", "y": "kiry", "z": "kirz"}
        col = col_map[component]
        data = {}
        with db.cursor() as cur:
            for st in station_list:
                cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    f"SELECT timestamp, {col} FROM magnetometer WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC",
                    (st, cutoff)
                )
                rows = cur.fetchall()
                values = [r[col] for r in rows if r[col] is not None]
                if rows and values:
                    base = sum(values) / len(values)
                    data[st] = [
                        {"time": r["timestamp"], "value": round(r[col] - base, 2)}
                        for r in rows if r[col] is not None
                    ]
    finally:
        db.close()
    return {"data": data}

@app.get("/magneto_uit/timeseries")
def magneto_uit_timeseries(
    stations: str = "TRO,NOR,SOR,AND,RST,JCK,DON,RVK,DOB,SOL,HAR,KAR,NAL,LYR,HOP,BJN",
    hours: int = 3,
    component: str = "x"
):
    """
    Hämtar tidsserier för UIT-stationer med de nya kolumnerna D_deg, H_nT, Z_nT.
    - stations: kommaseparerad lista av stationkoder, t.ex. "TRO,NOR,HOP"
    - hours: antal timmar bakåt från UTC‐nu
    - component: "x" → D_deg, "y" → H_nT, "z" → Z_nT
    Returnerar: { "data": { "<station>": [ { "time": <datetime>, "value": <float> }, ... ] } }
    """

    db = get_db()
    try:
        station_list = [s.strip().upper() for s in stations.split(",") if s.strip()]
        component = component.lower()

        # Mappa frontend‐komponenter till kolumnnamn
        comp_map = {"x": "D_deg", "y": "H_nT", "z": "Z_nT"}
        col = comp_map.get(component, "D_deg")  # default till D_deg om ogiltig

        data = {}
        with db.cursor() as cur:
            cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
            for st in station_list:
                # Läs ut timestamp + vald kolumn
                cur.execute(
                    f"SELECT timestamp, `{col}` FROM magnetometer_uit_gif "
                    f"WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC",
                    (st, cutoff)
                )
                rows = cur.fetchall()
                if rows:
                    data[st] = [
                        {"time": r["timestamp"], "value": round(r[col], 3)}
                        for r in rows
                        if r[col] is not None
                    ]
                else:
                    data[st] = []
    finally:
        db.close()
    return {"data": data}

@app.get("/kindex/timeseries")
def kindex_timeseries(
    stations: str = "KIR,TOP",
    hours: int = 3
):
    db = get_db()
    try:
        station_list = [s.strip().upper() for s in stations.split(",") if s.strip()]
        data = {}
        with db.cursor() as cur:
            for st in station_list:
                cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    "SELECT timestamp, k_index FROM magnetometer_kindex WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC",
                    (st, cutoff)
                )
                rows = cur.fetchall()
                data[st] = [
                    {"time": r["timestamp"].isoformat() + "Z", "k_index": r["k_index"]}
                    for r in rows if r["k_index"] is not None
                ]
    finally:
        db.close()
    return {"data": data}

@app.get("/magneto_fmi/timeseries")
def magneto_fmi_timeseries(
    stations: str = "KEV,MAS,KIL,IVA,MUO,SOD,PEL,RAN,OUJ,MEK,HAN,NUR,TAR",
    hours: int = 3,
    component: str = "x"
):
    db = get_db()
    try:
        station_list = [s.strip().upper() for s in stations.split(",") if s.strip()]
        if component.lower() not in ("x", "y", "z"):
            component = "x"
        comp = component.lower()
        data = {}
        with db.cursor() as cur:
            for st in station_list:
                cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    f"SELECT timestamp, {comp} FROM magnetometer_fmi WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC",
                    (st, cutoff)
                )
                rows = cur.fetchall()
                values = [r[comp] for r in rows if r[comp] is not None]
                if rows and values:
                    base = sum(values) / len(values)
                    data[st] = [
                        {"time": r["timestamp"], "value": round(r[comp] - base, 2)}
                        for r in rows if r[comp] is not None
                    ]
    finally:
        db.close()
    return {"data": data}

@app.get("/magneto_global/timeseries")
def magneto_global_timeseries(
    stations: str = "BOU,FRD,BRW,CMO",
    hours: int = 3,
    component: str = "x"
):
    db = get_db()
    try:
        station_list = [s.strip().upper() for s in stations.split(",") if s.strip()]
        if component.lower() not in ("x", "y", "z"):
            component = "x"
        comp = component.lower()
        data = {}
        with db.cursor() as cur:
            for st in station_list:
                cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    f"SELECT timestamp, {comp} FROM magnetometer_global WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC",
                    (st, cutoff)
                )
                rows = cur.fetchall()
                values = [r[comp] for r in rows if r[comp] is not None]
                if rows and values:
                    base = sum(values) / len(values)
                    data[st] = [
                        {"time": r["timestamp"], "value": round(r[comp] - base, 2)}
                        for r in rows if r[comp] is not None
                    ]
    finally:
        db.close()
    return {"data": data}

def _insert_aurora_flag(payload):
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS aurora_flags (
                    timestamp DATETIME PRIMARY KEY,
                    reason VARCHAR(255),
                    bz FLOAT, `by` FLOAT,
                    density FLOAT, speed FLOAT, bt FLOAT,
                    kirx FLOAT
                )""")
            cur.execute("""
                INSERT IGNORE INTO aurora_flags (timestamp, reason, bz, `by`, density, speed, bt, kirx)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                payload["timestamp"], payload["reason"], payload.get("bz"), payload.get("by"),
                payload.get("density"), payload.get("speed"), payload.get("bt"), payload.get("kirx")
            ))
    finally:
        db.close()

@app.post("/aurora/flag")
async def aurora_flag(req: Request):
    payload = await req.json()
    required = ["timestamp", "reason"]
    if any(k not in payload for k in required):
        return {"error": "Missing data"}
    await run_in_threadpool(_insert_aurora_flag, payload)
    return {"status": "ok"}

@app.get("/aurora/flags")
def get_flags():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("""
                SELECT timestamp, reason FROM aurora_flags
                WHERE timestamp >= NOW() - INTERVAL 1 DAY
                ORDER BY timestamp DESC
            """)
            rows = cur.fetchall()
    finally:
        db.close()
    return {"flags": [
        {"time": r["timestamp"].strftime("%Y-%m-%d %H:%M"), "reason": r["reason"]} for r in rows
    ]}

@app.get("/aurora/forecast")
async def aurora_forecast(
    lat: float = Query(...),
    lon: float = Query(...),
    tz: str = Query("Europe/Stockholm")
):
    try:
        # Hämta sol/måne, väder, kp, bz, etc (du kan använda get_sun_moon_info och andra helpers)
        sunmoon = get_sun_moon_info(lat=lat, lon=lon, tz_str=tz)
        # ...lägg till anrop till DB för kp/bz/magnetometer osv...
        # Gör forecast-logik här (exempel förenklad):
        forecast = {}
        if sunmoon['sunrise'] == "-" and sunmoon['sunset'] == "-":
            if sunmoon['height'] > 0:
                forecast['msg'] = "It is midnight sun – aurora will most likely not be visible."
            else:
                forecast['msg'] = "It is polar night – perfect darkness for aurora!"
        else:
            forecast['msg'] = "Standard day/night conditions."
        forecast['sunmoon'] = sunmoon
        # ...lägg till fler datakällor...
        return forecast
    except Exception as e:
        return {"error": str(e)}

@app.get("/ovation/latest_hp")
def latest_hemispheric_power():
    db = get_db()
    try:
        with db.cursor() as cur:
            cur.execute("SELECT ts, hemisphere_power_north, hemisphere_power_south FROM ovation_aurora ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
    finally:
        db.close()
    if not row:
        return {"error": "No HP found"}
    return {
        "ts": row["ts"],
        "hemispheric_power_north": row["hemisphere_power_north"],
        "hemispheric_power_south": row["hemisphere_power_south"]
    }


def find_nearest(lst, target, tolerance_s=180):
    """Return value in lst (dicts with 'timestamp') nearest to target, within tolerance (s)."""
    nearest = min(lst, key=lambda x: abs((x['timestamp'] - target).total_seconds()))
    delta = abs((nearest['timestamp'] - target).total_seconds())
    return nearest if delta <= tolerance_s else None

@app.get("/byaurora/score_series_synced")
def by_aurora_score_series_synced(
    hours: int = Query(6, ge=1, le=24),
    tolerance: int = Query(120, ge=10, le=600)   # tillåt ±2 min default
):
    db = get_db()
    try:
        cutoff = (datetime.utcnow() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")

        # 1. Hämta all magnetometerdata (detrended!)
        stations = [
            ("magnetometer", "station", "kirx", "KIR"),
            ("magnetometer_fmi", "station", "x", "KEV"),
            ("magnetometer_fmi", "station", "x", "SOD"),
            ("magnetometer_fmi", "station", "x", "OUJ"),
            ("magnetometer_fmi", "station", "x", "HAN"),
            ("magnetometer_fmi", "station", "x", "IVA"),
            ("magnetometer_fmi", "station", "x", "MEK"),
            ("magnetometer_fmi", "station", "x", "NUR"),
            ("magnetometer_fmi", "station", "x", "KIL"),
            ("magnetometer_fmi", "station", "x", "RAN"),
            ("magnetometer_global", "station", "x", "BOU"),
            ("magnetometer_global", "station", "x", "FRD"),
            ("magnetometer_global", "station", "x", "BRW"),
            ("magnetometer_global", "station", "x", "CMO"),
        ]

        station_data = {s[3]: [] for s in stations}
        with db.cursor() as cur:
            for table, col_station, col_x, station in stations:
                cur.execute(
                    f"SELECT timestamp, {col_x} FROM {table} WHERE {col_station}=%s AND timestamp >= %s ORDER BY timestamp ASC",
                    (station, cutoff)
                )
                for row in cur.fetchall():
                    if row[col_x] is not None:
                        station_data[station].append((row["timestamp"], row[col_x]))

        # Detrend
        station_bases = {}
        for station, values in station_data.items():
            vals = [v for t, v in values]
            station_bases[station] = np.mean(vals) if vals else 0

        # tid (datetime) -> [detrended values]
        all_times = set()
        time_to_station_delta = {}
        for station, values in station_data.items():
            base = station_bases[station]
            for t, v in values:
                all_times.add(t)
                dval = v - base
                if t not in time_to_station_delta:
                    time_to_station_delta[t] = []
                time_to_station_delta[t].append(dval)
        sorted_times = sorted(all_times)

        # 2. Hämta solvinddata
        with db.cursor() as cur:
            cur.execute(
                "SELECT timestamp, `by`, bz, speed FROM solarwind WHERE timestamp >= %s ORDER BY timestamp ASC",
                (cutoff,)
            )
            sw_rows = [
                {
                    "timestamp": row["timestamp"] if isinstance(row["timestamp"], datetime) else datetime.strptime(str(row["timestamp"]), "%Y-%m-%d %H:%M:%S"),
                    "by": row["by"],
                    "bz": row["bz"],
                    "speed": row["speed"]
                }
                for row in cur.fetchall()
            ]
    finally:
        db.close()
    if not sw_rows:
        return {"data": []}

    # 3. För varje magnetometertid, plocka by/bz synkat med fördröjning
    result = []
    for t_earth in sorted_times:
        mag_list = time_to_station_delta.get(t_earth)
        if not mag_list:
            continue
        # Hämta närmaste solvindhastighet för denna jordtid
        sw_row = find_nearest(sw_rows, t_earth, tolerance_s=tolerance)
        speed = sw_row["speed"] if sw_row and sw_row["speed"] else 400  # fallback
        delay_s = 1_500_000 / speed
        t_upstream = t_earth - timedelta(seconds=delay_s)
        # Hämta närmaste By/Bz “upstream”
        sw_up = find_nearest(sw_rows, t_upstream, tolerance_s=tolerance)
        if not sw_up or sw_up["by"] is None or sw_up["bz"] is None:
            continue
        by, bz = sw_up["by"], sw_up["bz"]
        mag = float(np.mean([abs(x) for x in mag_list]))
        # Mjuk score (bara när |bz|<2)
        score = abs(by) * mag if abs(bz) < 2 else 0
        # Diskret index som highlight, kan tweakas
        if bz < -2:
            idx = 0
        elif abs(by) > 8 and abs(bz) < 2:
            if mag > 50:
                idx = 2
            else:
                idx = 1
        else:
            idx = 0
        result.append({
            "time": t_earth,
            "score": score,
            "index": idx,
            "by": by,
            "bz": bz,
            "mag": mag,
        })

    return {"data": result}

@app.get("/api/timezone")
async def get_timezone(lat: float = Query(...), lon: float = Query(...)):
    tf = TimezoneFinder()
    tz = tf.timezone_at(lat=lat, lng=lon)
    if tz:
        return {"tz": tz}
    return {"tz": "Europe/Stockholm"}
