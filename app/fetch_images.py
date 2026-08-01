#!/usr/bin/env python3
# ---- app/fetch_images.py ----
import os
import re
import json
import time
import hashlib
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
from datetime import datetime, timezone, timedelta
from urllib.parse import urljoin, urlparse

import requests
from PIL import Image

# ------------------------------------------------------------
# Konfiguration
# ------------------------------------------------------------
IMAGE_ROOT = Path("/app/data/images")
IMAGE_ROOT.mkdir(parents=True, exist_ok=True)

STATE_PATH = IMAGE_ROOT / ".sdo_hv_state.json"

# Parallellism
FETCH_WORKERS = int(os.getenv("SDO_FETCH_WORKERS", "8"))

# Helioviewer image scale (~1.0≈1024, 2.0≈2048, 4.0≈4096 px)
HV_IMAGESCALE = 4.0

# Pollintervall (sekunder)
POLL_SECONDS = int(os.getenv("SDO_POLL_SECONDS", "60"))

# Mikro-backfill (per kanal)
BACKFILL_MINUTES = int(os.getenv("SDO_BACKFILL_MINUTES", "120"))
# Hur många "tomma" poll-cykler innan backfill per kanal triggas
# default ≈ 10 minuter vid 60s polling
_default_idle_cycles = max(10, int(600 / max(POLL_SECONDS, 1)))
BACKFILL_IDLE_CYCLES = int(os.getenv("SDO_BACKFILL_IDLE_CYCLES", str(_default_idle_cycles)))

# Daglig full-backfill (UTC)
DAILY_BACKFILL_ENABLE = os.getenv("SDO_DAILY_BACKFILL_ENABLE", "1") == "1"
DAILY_BACKFILL_HHMM = os.getenv("SDO_DAILY_BACKFILL_HHMM", "02:00")   # "HH:MM" UTC
DAILY_BACKFILL_STEP_MIN = int(os.getenv("SDO_DAILY_BACKFILL_STEP_MIN", "1"))

# Lyckebo auroracam (WordPress-sida som listar bilder)
LYCKEBOCAM_ENABLE = os.getenv("LYCKEBOCAM_ENABLE", "0") == "1"
LYCKEBOCAM_KEY = "lyckebocam"  # katalog under IMAGE_ROOT
LYCKEBOCAM_PREFIX = "Lyckebo"  # filprefix
LYCKEBOCAM_PAGE_URL = os.getenv("LYCKEBOCAM_PAGE_URL", "https://lyckebosommargard.se/auroracam/")

# Lyckebo dir listing (preferred source)
LYCKEBOCAM_DIRLIST_URL = os.getenv(
    "LYCKEBOCAM_DIRLIST_URL",
    "https://lyckebosommargard.se/wp-content/uploads/Webcam/",
)

# If we haven't saved a new image for this many minutes, run a catch-up scan/download
LYCKEBOCAM_STALE_MINUTES = int(os.getenv("LYCKEBOCAM_STALE_MINUTES", "20"))
# Max number of images to download during catch-up
LYCKEBOCAM_BACKFILL_MAX = int(os.getenv("LYCKEBOCAM_BACKFILL_MAX", "50"))

# Synoptic
SYNOPTIC_KEY = "Synoptic"
SYNOPTIC_URL = "https://services.swpc.noaa.gov/images/synoptic-map.jpg"

# Helioviewer sourceId för SDO AIA/HMI
AIA_SOURCES = {
    "94": 8, "131": 9, "171": 10, "193": 11, "211": 12, "304": 13,
    "335": 14, "1600": 15, "1700": 16, "4500": 17,  # 4500 = HMI continuum
}

# Kanaler (katalognamn/filprefix = nycklarna)
CHANNELS = {
    "SDO_131": {"wl": "131", "source": AIA_SOURCES["131"]},
    "SDO_171": {"wl": "171", "source": AIA_SOURCES["171"]},
    "SDO_193": {"wl": "193", "source": AIA_SOURCES["193"]},
    "SDO_211": {"wl": "211", "source": AIA_SOURCES["211"]},
    "SDO_304": {"wl": "304", "source": AIA_SOURCES["304"]},
    "SDO_HMIIF": {"wl": "4500", "source": AIA_SOURCES["4500"]},
}

STATE_LOCK = threading.Lock()
_TLS = threading.local()

def get_session() -> requests.Session:
    """
    requests.Session per tråd (requests.Session är inte garanterat trådsäker).
    """
    s = getattr(_TLS, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": "slashmad-aurora-panel/1.0"})
        _TLS.session = s
    return s

def http_get(url: str, **kwargs):
    """
    Wrapper så vi alltid använder tråd-lokal Session.
    """
    return get_session().get(url, **kwargs)


# ------------------------------------------------------------
# Hjälpare
# ------------------------------------------------------------
def log(msg: str):
    print(f"{datetime.utcnow().isoformat()}Z {msg}", flush=True)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state: dict):
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bytes_png_to_jpeg_bytes(png_bytes: bytes, quality=90) -> bytes:
    im = Image.open(BytesIO(png_bytes))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGB")
    else:
        im = im.convert("RGB")
    bio = BytesIO()
    im.save(bio, format="JPEG", quality=quality, optimize=True, progressive=True)
    return bio.getvalue()


def create_thumbnail(image_path: Path, thumb_path: Path, max_width=320, quality=88):
    try:
        img = Image.open(image_path)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        w_percent = (max_width / float(img.size[0]))
        h_size = int((float(img.size[1]) * float(w_percent)))
        img = img.resize((max_width, h_size), Image.LANCZOS)
        img.save(thumb_path, "JPEG", quality=quality, optimize=True, progressive=True)
    except Exception as e:
        log(f"Thumbnail error: {e}")


def normalize_webcam_url(url: str) -> str:
    # De har ibland dubbel slash efter /Webcam//
    return re.sub(r"/Webcam/+", "/Webcam/", url)


def bytes_to_jpeg_bytes(img_bytes: bytes, quality=90) -> bytes:
    """Konvertera valfri bild (jpg/png/etc) till JPEG-bytes."""
    im = Image.open(BytesIO(img_bytes))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGB")
    else:
        im = im.convert("RGB")
    bio = BytesIO()
    im.save(bio, format="JPEG", quality=quality, optimize=True, progressive=True)
    return bio.getvalue()


def parse_lyckebo_timestamp_from_filename(name: str) -> datetime | None:
    """
    Förväntade namn från kameran, t.ex:
      26-01-15_08-05-21_9999.jpg
      2026-01-15_08-05-21_9999.jpg
    Returnerar UTC-datetime (vi sätter tz=UTC eftersom vi vill ha ...Z-format).
    """
    base = Path(name).name
    m = re.search(r"(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})_(?P<h>\d{2})-(?P<mi>\d{2})-(?P<s>\d{2})", base)
    if m:
        y = int(m.group("y"))
        mo = int(m.group("mo"))
        d = int(m.group("d"))
        h = int(m.group("h"))
        mi = int(m.group("mi"))
        s = int(m.group("s"))
        return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)
    m = re.search(r"(?P<yy>\d{2})-(?P<mo>\d{2})-(?P<d>\d{2})_(?P<h>\d{2})-(?P<mi>\d{2})-(?P<s>\d{2})", base)
    if m:
        yy = int(m.group("yy"))
        y = 2000 + yy  # rimlig default för moderna webcam-bilder
        mo = int(m.group("mo"))
        d = int(m.group("d"))
        h = int(m.group("h"))
        mi = int(m.group("mi"))
        s = int(m.group("s"))
        return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)
    return None

def list_lyckebo_dirlisting(page_url: str) -> list[tuple[datetime, str, str]]:
    """
    Parse directory listing page and return a list of (dt, url, filename) for image files.
    """
    r = http_get(
        page_url,
        timeout=30,
        headers={
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    r.raise_for_status()
    html = r.text

    # Typical dirlisting has <a href="26-01-17_19-00-02_9999.jpg">...</a>
    hrefs = re.findall(r'href=["\']([^"\']+\.(?:jpe?g|png))["\']', html, re.IGNORECASE)
    out: list[tuple[datetime, str, str]] = []
    for href in hrefs:
        name = Path(urlparse(href).path).name
        if not name:
            continue
        dt = parse_lyckebo_timestamp_from_filename(name)
        if not dt:
            continue
        url = urljoin(page_url, href)
        out.append((dt, url, name))
    out.sort(key=lambda x: x[0])
    return out

def normalize_hv_date_string(s: str) -> str:
    # "YYYY-MM-DD HH:MM:SS" eller "YYYY-MM-DDTHH:MM:SSZ" -> "YYYYMMDDTHHMMSSZ"
    if not s:
        return datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    s = s.strip()
    if " " in s and "T" not in s:
        s = s.replace(" ", "T")
    if not s.endswith("Z"):
        s = s + "Z"
    return s.replace("-", "").replace(":", "")


# ------------------------------------------------------------
# Helioviewer API
# ------------------------------------------------------------
def hv_get_closest_image(source_id: int, when_utc: datetime):
    url = "https://api.helioviewer.org/v2/getClosestImage/"
    params = {"date": when_utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "sourceId": source_id}
    r = http_get(url, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    return data.get("id"), data.get("date")


def hv_download_image_png(jp2_id: int, image_scale: float) -> bytes:
    url = "https://api.helioviewer.org/v2/downloadImage/"
    params = {"id": jp2_id, "format": "png", "imageScale": image_scale}
    r = http_get(url, params=params, timeout=60)
    r.raise_for_status()
    return r.content


# ------------------------------------------------------------
# Sparning
# ------------------------------------------------------------
def save_jpeg_and_thumb(key: str, jp2_id: int, actual_date: str, png_bytes: bytes) -> bool:
    category_dir = IMAGE_ROOT / key
    category_dir.mkdir(parents=True, exist_ok=True)

    jpeg_bytes = bytes_png_to_jpeg_bytes(png_bytes, quality=90)
    ts_compact = normalize_hv_date_string(actual_date)
    fname = f"{key}_{ts_compact}.jpg"
    out_path = category_dir / fname

    if out_path.exists():
        return False

    latest_existing = sorted(
        [p for p in category_dir.glob(f"{key}_*.jpg") if "_thumb" not in p.name],
        reverse=True,
    )
    if latest_existing:
        try:
            if file_hash(jpeg_bytes) == file_hash(latest_existing[0].read_bytes()):
                return False
        except Exception:
            pass

    out_path.write_bytes(jpeg_bytes)

    if key == "SDO_193":
        try:
            subprocess.run(["python3", "detect_coronal_hole.py"], check=True)
            log("Coronal hole detection script executed")
        except Exception as e:
            log(f"Coronal hole detection script error: {e}")

    # Skapa thumbnail till kanalbilder
    thumb_path = category_dir / f"{key}_{ts_compact}_thumb.jpg"
    create_thumbnail(out_path, thumb_path)
    for f in category_dir.glob(f"{key}_*_thumb.jpg"):
        if f != thumb_path:
            try:
                f.unlink()
            except Exception:
                pass

    log(f"{key}: sparade {fname}")
    return True


# ------------------------------------------------------------
# Backfill-funktioner
# ------------------------------------------------------------
def backfill_recent(key: str, source_id: int, minutes: int) -> int:
    """
    Backfilla senaste 'minutes' minuterna i 1-minuterssteg (unika jp2_id).
    Returnerar antal sparade filer.
    """
    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=minutes)
    seen_ids, saved = set(), 0
    t = start
    while t <= now:
        try:
            jp2_id, actual_date = hv_get_closest_image(source_id, t)
            if not jp2_id or not actual_date or jp2_id in seen_ids:
                t += timedelta(minutes=1); continue
            seen_ids.add(jp2_id)
            png_bytes = hv_download_image_png(jp2_id, HV_IMAGESCALE)
            if png_bytes and save_jpeg_and_thumb(key, jp2_id, actual_date, png_bytes):
                saved += 1
        except Exception as e:
            log(f"{key}: backfill fel vid {t.isoformat()}Z: {e}")
        t += timedelta(minutes=1)
    if saved:
        log(f"{key}: backfill sparade {saved} bilder (senaste {minutes} min).")
    else:
        log(f"{key}: backfill hittade inget nytt i senaste {minutes} min.")
    return saved


def backfill_range(key: str, source_id: int, start_dt: datetime, end_dt: datetime, step_minutes: int) -> int:
    """
    Backfilla ett intervall i 'step_minutes'-steg (unika jp2_id).
    """
    seen_ids, saved = set(), 0
    t = start_dt
    while t <= end_dt:
        try:
            jp2_id, actual_date = hv_get_closest_image(source_id, t)
            if not jp2_id or not actual_date or jp2_id in seen_ids:
                t += timedelta(minutes=step_minutes); continue
            seen_ids.add(jp2_id)
            png_bytes = hv_download_image_png(jp2_id, HV_IMAGESCALE)
            if png_bytes and save_jpeg_and_thumb(key, jp2_id, actual_date, png_bytes):
                saved += 1
        except Exception as e:
            log(f"{key}: daily backfill fel {t.isoformat()}Z: {e}")
        t += timedelta(minutes=step_minutes)
    return saved


def backfill_yesterday_full_day(state: dict) -> int:
    """
    Backfilla hela gårdagen (UTC) i DAILY_BACKFILL_STEP_MIN.
    Körs en gång per dygn (markeras i state['daily.backfill_ymd']).
    """
    if not DAILY_BACKFILL_ENABLE:
        return 0

    today_ymd = datetime.utcnow().strftime("%Y%m%d")
    if state.get("daily.backfill_ymd") == today_ymd:
        return 0

    end = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(seconds=1)
    start = (end - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

    total = 0
    for key, info in CHANNELS.items():
        saved = backfill_range(key, info["source"], start, end, DAILY_BACKFILL_STEP_MIN)
        log(f"{key}: daily backfill (UTC {start} → {end}, step={DAILY_BACKFILL_STEP_MIN}m) sparade {saved} bilder.")
        total += saved

    state["daily.backfill_ymd"] = today_ymd
    return total


# ------------------------------------------------------------
# Fetching (realtid)
# ------------------------------------------------------------
def fetch_channel(key: str, wl: str, source_id: int, state: dict) -> bool:
    """
    Realtids-hämtning: sparar ny bild om jp2_id bytts.
    Loggar obs-tid även när inget nytt hittas.
    """
    now = datetime.now(timezone.utc)
    try:
        jp2_id, actual_date = hv_get_closest_image(source_id, now)
        if not jp2_id or not actual_date:
            log(f"{key}: Helioviewer saknar bild just nu.")
            return False

        # last_id + per-kanal idle counter i state (skydda state med lock)
        last_key = f"{key}.last_id"
        idle_key = f"{key}.idle_counter"

        with STATE_LOCK:
            last_seen = state.get(last_key)
            if last_seen and str(last_seen) == str(jp2_id):
                ts_compact = normalize_hv_date_string(actual_date)
                log(f"{key}: inga nya bilder (id={jp2_id}, obs={ts_compact}).")
                state[idle_key] = int(state.get(idle_key, 0)) + 1
                return False
        # ny bild
        png_bytes = hv_download_image_png(jp2_id, HV_IMAGESCALE)
        if not png_bytes:
            log(f"{key}: tom bilddata för id={jp2_id}.")
            # räkna ändå som idle
            with STATE_LOCK:
                state[idle_key] = int(state.get(idle_key, 0)) + 1
            return False

        if save_jpeg_and_thumb(key, jp2_id, actual_date, png_bytes):
            with STATE_LOCK:
                state[last_key] = jp2_id
                state[idle_key] = 0
            return True
        else:
            # om sparning hoppades pga identiskt innehåll
            with STATE_LOCK:
                state[idle_key] = int(state.get(idle_key, 0)) + 1
            return False

    except Exception as e:
        log(f"{key}: FEL: {e}")
        # räkna som idle för att kunna trigga backfill vid fortsatta fel
        idle_key = f"{key}.idle_counter"
        with STATE_LOCK:
            state[idle_key] = int(state.get(idle_key, 0)) + 1
        return False


def fetch_synoptic_if_changed(state: dict) -> bool:
    """
    Hämta synoptic endast när den ändrats (conditional GET).
    Sparar INTE thumbnail.
    """
    key = SYNOPTIC_KEY
    category_dir = IMAGE_ROOT / key
    category_dir.mkdir(parents=True, exist_ok=True)

    with STATE_LOCK:
        prev_etag = state.get("Synoptic.etag")
        prev_lm = state.get("Synoptic.last_modified")
        prev_hash = state.get("Synoptic.hash")

    headers = {}
    if prev_etag:
        headers["If-None-Match"] = prev_etag
    if prev_lm:
        headers["If-Modified-Since"] = prev_lm

    try:
        r = http_get(SYNOPTIC_URL, headers=headers, timeout=30)
        if r.status_code == 304:
            log("Synoptic: oförändrad (304 Not Modified).")
            return False
        r.raise_for_status()

        content = r.content
        new_etag = r.headers.get("ETag")
        new_lm = r.headers.get("Last-Modified")
        cur_hash = file_hash(content)
        if prev_hash and cur_hash == prev_hash:
            log("Synoptic: oförändrad (hash match).")
            return False

        # timestamp från Last-Modified om möjligt
        ts_str = None
        if new_lm:
            from email.utils import parsedate_to_datetime
            try:
                lm_dt = parsedate_to_datetime(new_lm).astimezone(timezone.utc)
                ts_str = lm_dt.strftime("%Y%m%dT%H%M%SZ")
            except Exception:
                pass
        if not ts_str:
            ts_str = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

        out_path = category_dir / f"{key}_{ts_str}.jpg"
        out_path.write_bytes(content)
        log(f"Synoptic: sparade {out_path.name}")

        with STATE_LOCK:
            if new_etag:
                state["Synoptic.etag"] = new_etag
            if new_lm:
                state["Synoptic.last_modified"] = new_lm
            state["Synoptic.hash"] = cur_hash

        return True
    except Exception as e:
        log(f"Synoptic: FEL: {e}")
    return False

def _download_and_store_lyckebo_one(state: dict, dt: datetime, img_url: str, remote_name: str, referer_url: str) -> bool:
    """
    Download one Lyckebo image and store it (including thumbnail). Returns True if saved.
    """
    last_remote_key = f"{LYCKEBOCAM_KEY}.last_remote"
    last_hash_key = f"{LYCKEBOCAM_KEY}.last_hash"
    last_saved_dt_key = f"{LYCKEBOCAM_KEY}.last_saved_dt"
    last_ok_utc_key = f"{LYCKEBOCAM_KEY}.last_ok_utc"

    with STATE_LOCK:
        last_remote = state.get(last_remote_key)
        last_hash = state.get(last_hash_key)
    same_remote = (last_remote == remote_name)

    y, mo, d = dt.strftime("%Y"), dt.strftime("%m"), dt.strftime("%d")
    day_dir = IMAGE_ROOT / LYCKEBOCAM_KEY / y / mo / d
    thumbs_dir = day_dir / "thumbs"
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    ts_compact = dt.strftime("%Y%m%dT%H%M%SZ")
    out_name = f"{LYCKEBOCAM_PREFIX}_{ts_compact}.jpg"
    out_path = day_dir / out_name
    if out_path.exists():
        with STATE_LOCK:
            state[last_remote_key] = remote_name
        return False

    bust_url = img_url + ("&" if "?" in img_url else "?") + f"ts={int(time.time())}"
    img_r = http_get(
        bust_url,
        timeout=30,
        headers={
            "Referer": referer_url,
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Accept": "image/*,*/*;q=0.8",
        },
    )
    img_r.raise_for_status()
    if not img_r.content:
        return False

    jpeg_bytes = bytes_to_jpeg_bytes(img_r.content, quality=90)
    cur_hash = file_hash(jpeg_bytes)

    if same_remote and last_hash and cur_hash == last_hash:
        with STATE_LOCK:
            state[last_remote_key] = remote_name
        return False

    day_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(jpeg_bytes)

    thumb_path = thumbs_dir / f"{LYCKEBOCAM_PREFIX}_{ts_compact}_thumb.jpg"
    create_thumbnail(out_path, thumb_path)

    with STATE_LOCK:
        state[last_remote_key] = remote_name
        state[last_hash_key] = cur_hash
        state[last_saved_dt_key] = dt.isoformat()
        state[last_ok_utc_key] = str(datetime.now(timezone.utc).timestamp())

    log(f"{LYCKEBOCAM_PREFIX}: sparade {out_path.relative_to(IMAGE_ROOT)}")
    return True

# ------------------------------------------------------------
# Lyckebo auroracam
# ------------------------------------------------------------
def fetch_lyckebocam_latest(state: dict) -> bool:
    """
    Hämtar senaste bilden från LYCKEBOCAM_PAGE_URL, sparar i datumstruktur:
      /app/data/images/lyckebocam/YYYY/MM/DD/
    och skapar thumbnail i:
      .../YYYY/MM/DD/thumbs/
    Döp om filen till t.ex. Lyckebo_20260116T171643Z.jpg
    """
    if not LYCKEBOCAM_ENABLE:
        return False

    # --- stale/backfill state (must be computed before use) ---
    last_saved_dt_key = f"{LYCKEBOCAM_KEY}.last_saved_dt"
    last_ok_utc_key = f"{LYCKEBOCAM_KEY}.last_ok_utc"
    now_utc = datetime.now(timezone.utc)
    with STATE_LOCK:
        last_saved_dt_iso = state.get(last_saved_dt_key)
        last_ok_utc = state.get(last_ok_utc_key)
    last_saved_dt = None
    if last_saved_dt_iso:
        try:
            last_saved_dt = datetime.fromisoformat(last_saved_dt_iso)
        except Exception:
            last_saved_dt = None
    stale = False
    if last_ok_utc:
        try:
            stale = (now_utc.timestamp() - float(last_ok_utc)) > (LYCKEBOCAM_STALE_MINUTES * 60)
        except Exception:
            stale = False

    try:
        candidates: list[tuple[datetime, str, str]] = []
        try:
            candidates = list_lyckebo_dirlisting(LYCKEBOCAM_DIRLIST_URL)
        except Exception as e:
            log(f"{LYCKEBOCAM_PREFIX}: dirlisting FEL: {e}")

        # Fallback: old page scrape if dirlisting is unavailable
        page_url = LYCKEBOCAM_PAGE_URL + ("&" if "?" in LYCKEBOCAM_PAGE_URL else "?") + f"ts={int(time.time())}"
        if not candidates:
            r = http_get(
                page_url,
                timeout=30,
                headers={
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
            )
            r.raise_for_status()
            html = r.text
            matches = re.findall(
                r'(?:src|href)=["\']([^"\']*/wp-content/uploads/Webcam/[^"\']+\.(?:jpe?g|png)(?:\?[^"\']*)?)["\']',
                html,
                re.IGNORECASE,
            )
            for ref in matches:
                candidate_url = normalize_webcam_url(urljoin(LYCKEBOCAM_PAGE_URL, ref))
                candidate_name = Path(urlparse(candidate_url).path).name
                if not candidate_name:
                    continue
                candidate_dt = parse_lyckebo_timestamp_from_filename(candidate_name)
                if not candidate_dt:
                    continue
                candidates.append((candidate_dt, candidate_url, candidate_name))
            candidates.sort(key=lambda x: x[0])

        if not candidates:
            log(f"{LYCKEBOCAM_PREFIX}: hittade inga kandidater (dirlisting + fallback tom).")
            return False

        # Latest candidate
        dt, img_url, remote_name = candidates[-1]

        # Opportunistic catch-up: fill small gaps even if we are not "stale"
        # Download a few images that are newer than last_saved_dt (oldest first)
        if last_saved_dt:
            newer = [c for c in candidates if c[0] > last_saved_dt]
            if newer:
                to_get = newer[:3]  # keep this small to avoid extra load
                any_saved = False
                for dt2, url2, name2 in to_get:
                    if _download_and_store_lyckebo_one(state, dt2, url2, name2, page_url):
                        any_saved = True
                if any_saved:
                    return True

        # If we have been stale for a while, catch up by downloading multiple images since last_saved_dt
        if stale and last_saved_dt:
            newer = [c for c in candidates if c[0] > last_saved_dt]
            if newer:
                to_get = newer[:LYCKEBOCAM_BACKFILL_MAX]  # oldest first
                log(f"{LYCKEBOCAM_PREFIX}: stale={LYCKEBOCAM_STALE_MINUTES}m, catch-up downloading {len(to_get)} files.")
                any_saved = False
                for dt2, url2, name2 in to_get:
                    if _download_and_store_lyckebo_one(state, dt2, url2, name2, page_url):
                        any_saved = True
                return any_saved

        # Undvik att ladda ner samma remote-fil om och om igen
        last_remote_key = f"{LYCKEBOCAM_KEY}.last_remote"
        last_hash_key = f"{LYCKEBOCAM_KEY}.last_hash"
        with STATE_LOCK:
            last_remote = state.get(last_remote_key)
            last_hash = state.get(last_hash_key)
        same_remote = (last_remote == remote_name)

        y, mo, d = dt.strftime("%Y"), dt.strftime("%m"), dt.strftime("%d")
        day_dir = IMAGE_ROOT / LYCKEBOCAM_KEY / y / mo / d
        thumbs_dir = day_dir / "thumbs"
        thumbs_dir.mkdir(parents=True, exist_ok=True)

        ts_compact = dt.strftime("%Y%m%dT%H%M%SZ")
        out_name = f"{LYCKEBOCAM_PREFIX}_{ts_compact}.jpg"
        out_path = day_dir / out_name
        if out_path.exists():
            with STATE_LOCK:
                state[last_remote_key] = remote_name
            log(f"{LYCKEBOCAM_PREFIX}: redan sparad ({out_name}).")
            return False

        return _download_and_store_lyckebo_one(state, dt, img_url, remote_name, page_url)

    except Exception as e:
        log(f"{LYCKEBOCAM_PREFIX}: FEL: {e}")
        return False

# ------------------------------------------------------------
# Main loop
# ------------------------------------------------------------
def main_loop():
    state = load_state()
    log(
        "Startar SDO/Helioviewer-fetcher "
        f"(poll={POLL_SECONDS}s, micro_backfill={BACKFILL_MINUTES}m efter {BACKFILL_IDLE_CYCLES} idle-cykler/kanal, "
        f"daily_backfill={'ON' if DAILY_BACKFILL_ENABLE else 'OFF'} {DAILY_BACKFILL_HHMM}Z steg={DAILY_BACKFILL_STEP_MIN}m)"
    )

    while True:
        changed_any = False

        # ------------------------------------------------------------
        # Parallell realtids-hämtning (kanaler + synoptic + lyckebo)
        # ------------------------------------------------------------
        futures = []
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as ex:
            # kanaler
            for key, info in CHANNELS.items():
                futures.append(ex.submit(fetch_channel, key, info["wl"], info["source"], state))
            # synoptic + lyckebo
            futures.append(ex.submit(fetch_synoptic_if_changed, state))
            futures.append(ex.submit(fetch_lyckebocam_latest, state))

            for fut in as_completed(futures):
                try:
                    changed_any |= bool(fut.result())
                except Exception as e:
                    log(f"Parallel fetch FEL: {e}")

        # Per-kanal mikro-backfill (logga alltid beslutet)
        for key, info in CHANNELS.items():
            idle_key = f"{key}.idle_counter"
            with STATE_LOCK:
                idle_val = int(state.get(idle_key, 0))
            if BACKFILL_MINUTES > 0 and idle_val >= BACKFILL_IDLE_CYCLES:
                log(f"{key}: mikro-backfill triggas (idle_counter={idle_val} ≥ {BACKFILL_IDLE_CYCLES})...")
                saved = backfill_recent(key, info["source"], BACKFILL_MINUTES)
                with STATE_LOCK:
                    state[idle_key] = 0  # nollställ oavsett utfall
                if saved == 0:
                    log(f"{key}: mikro-backfill hittade inget nytt.")
            else:
                log(f"{key}: mikro-backfill ej triggat (idle_counter={idle_val} < {BACKFILL_IDLE_CYCLES}).")

        # Daglig full-backfill av gårdagen på vald tid (UTC), en gång per dag
        if DAILY_BACKFILL_ENABLE:
            try:
                hh, mm = map(int, DAILY_BACKFILL_HHMM.split(":"))
                now_utc = datetime.utcnow()
                # Kör endast en gång per minut för att undvika dubbeltrigg i samma minut
                if now_utc.hour == hh and now_utc.minute == mm:
                    saved_total = backfill_yesterday_full_day(state)
                    if saved_total:
                        log(f"Daily full backfill klar: {saved_total} nya bilder.")
                        # sov för att inte trigga om under samma minut
                        time.sleep(60)
            except Exception as e:
                log(f"Daily backfill trigger fel: {e}")

        save_state(state)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main_loop()
