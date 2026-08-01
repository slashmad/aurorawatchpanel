#!/usr/bin/env python3
import os
import re
import json
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests
from PIL import Image
from io import BytesIO


# =========================
# Config
# =========================
IMAGE_ROOT = Path(os.getenv("IMAGE_ROOT", "/app/data/images"))
DIRLIST_URL = os.getenv("LYCKEBO_DIRLIST_URL", "https://lyckebosommargard.se/wp-content/uploads/Webcam/")
POLL_SECONDS = int(os.getenv("LYCKEBO_POLL_SECONDS", "60"))

STARTUP_SYNC = os.getenv("LYCKEBO_STARTUP_SYNC", "1") == "1"
STARTUP_MAX = int(os.getenv("LYCKEBO_STARTUP_MAX", "0"))          # 0 = unlimited
INCREMENTAL_MAX = int(os.getenv("LYCKEBO_INCREMENTAL_MAX", "30")) # per poll

HTTP_TIMEOUT = int(os.getenv("LYCKEBO_HTTP_TIMEOUT", "30"))
HTTP_RETRIES = int(os.getenv("LYCKEBO_HTTP_RETRIES", "4"))
BACKOFF_BASE = float(os.getenv("LYCKEBO_BACKOFF_BASE", "1.6"))

# Fallback: om vi inte gjort "progress" på ett tag -> rescan senaste N remote
STALE_SECONDS = int(os.getenv("LYCKEBO_STALE_SECONDS", "900"))  # 15 min default
RESCAN_LAST = int(os.getenv("LYCKEBO_RESCAN_LAST", "300"))      # hur många nyaste remote att verifiera

KEY = os.getenv("LYCKEBO_KEY", "lyckebocam")
PREFIX = os.getenv("LYCKEBO_PREFIX", "Lyckebo")
UA = os.getenv("LYCKEBO_UA", "slashmad-aurora-panel/1.0 (lyckebo-dirlist)")

THUMB_WIDTH = int(os.getenv("LYCKEBO_THUMB_WIDTH", "320"))
THUMB_QUALITY = int(os.getenv("LYCKEBO_THUMB_QUALITY", "88"))

BASE_DIR = IMAGE_ROOT / KEY
STATE_PATH = BASE_DIR / ".state.json"

IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
BASE_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(f"{datetime.utcnow().isoformat()}Z {msg}", flush=True)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def parse_dt_from_filename(name: str) -> datetime | None:
    # Ex: 26-01-17_19-00-02_9999.jpg  (YY-MM-DD_HH-MM-SS)
    base = Path(name).name
    m = re.search(r"(\d{2})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})", base)
    if not m:
        return None
    yy, mo, d, hh, mi, ss = map(int, m.groups())
    return datetime(2000 + yy, mo, d, hh, mi, ss, tzinfo=timezone.utc)


def bytes_to_jpeg(raw: bytes, quality: int = 90) -> bytes:
    im = Image.open(BytesIO(raw))
    if im.mode != "RGB":
        im = im.convert("RGB")
    bio = BytesIO()
    im.save(bio, format="JPEG", quality=quality, optimize=True, progressive=True)
    return bio.getvalue()


def create_thumbnail(image_path: Path, thumb_path: Path, max_width: int = 320, quality: int = 88) -> None:
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as im:
        if im.mode != "RGB":
            im = im.convert("RGB")
        w, h = im.size
        if w > max_width:
            new_w = max_width
            new_h = int(h * (new_w / w))
            im = im.resize((new_w, new_h))
        im.save(thumb_path, format="JPEG", quality=quality, optimize=True, progressive=True)


def out_path_for(dt: datetime) -> Path:
    y, mo, d = dt.strftime("%Y"), dt.strftime("%m"), dt.strftime("%d")
    ts = dt.strftime("%Y%m%dT%H%M%SZ")
    return BASE_DIR / y / mo / d / f"{PREFIX}_{ts}.jpg"


def thumb_path_for(dt: datetime) -> Path:
    p = out_path_for(dt)
    return p.parent / "thumbs" / p.name  # samma filnamn, men i thumbs/


def update_progress(state: dict, dt: datetime, remote_name: str) -> None:
    # Cursor MÅSTE flyttas även om filen redan fanns, annars fastnar vi i "Catch-up N/N"
    state["cursor_dt"] = dt.isoformat()
    state["last_remote"] = remote_name
    state["last_ok_utc"] = str(time.time())


def http_get(session: requests.Session, url: str) -> requests.Response:
    last_err = None
    for attempt in range(1, HTTP_RETRIES + 1):
        try:
            r = session.get(
                url,
                timeout=HTTP_TIMEOUT,
                headers={
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
            )
            r.raise_for_status()
            return r
        except Exception as e:
            last_err = e
            sleep_s = BACKOFF_BASE ** (attempt - 1)
            log(f"[Lyckebo] HTTP fail {attempt}/{HTTP_RETRIES}: {e} (sleep {sleep_s:.1f}s)")
            time.sleep(sleep_s)
    raise RuntimeError(f"HTTP failed after {HTTP_RETRIES} retries: {last_err}")


def list_dir(session: requests.Session) -> list[tuple[datetime, str, str]]:
    r = http_get(session, DIRLIST_URL)
    html = r.text
    hrefs = re.findall(r'href=["\']([^"\']+\.(?:jpe?g|png))["\']', html, flags=re.IGNORECASE)

    out: list[tuple[datetime, str, str]] = []
    for href in hrefs:
        name = Path(urlparse(href).path).name
        if not name:
            continue
        dt = parse_dt_from_filename(name)
        if not dt:
            continue
        out.append((dt, urljoin(DIRLIST_URL, href), name))

    out.sort(key=lambda x: x[0])
    return out


def ensure_one(session: requests.Session, state: dict, dt: datetime, url: str, remote_name: str) -> bool:
    """
    Säkerställ att bilden finns lokalt och att thumb finns.
    Returnerar True endast om vi faktiskt laddade ner en ny bildfil.
    """
    p = out_path_for(dt)
    tp = thumb_path_for(dt)

    # Fil finns redan -> skapa thumb vid behov + flytta cursor
    if p.exists():
        if not tp.exists():
            try:
                create_thumbnail(p, tp, max_width=THUMB_WIDTH, quality=THUMB_QUALITY)
                log(f"[Lyckebo] Created thumb {tp.relative_to(IMAGE_ROOT)}")
            except Exception as e:
                log(f"[Lyckebo] Thumb error for existing {p.name}: {e}")
        update_progress(state, dt, remote_name)
        return False

    # Ladda ner
    p.parent.mkdir(parents=True, exist_ok=True)
    bust = url + ("&" if "?" in url else "?") + f"ts={int(time.time())}"
    r = http_get(session, bust)
    if not r.content:
        return False

    jpeg = bytes_to_jpeg(r.content, quality=90)
    p.write_bytes(jpeg)

    # Thumb (best effort, men vi loggar)
    try:
        create_thumbnail(p, tp, max_width=THUMB_WIDTH, quality=THUMB_QUALITY)
        log(f"[Lyckebo] Created thumb {tp.relative_to(IMAGE_ROOT)}")
    except Exception as e:
        log(f"[Lyckebo] Thumb error for {p.name}: {e}")

    update_progress(state, dt, remote_name)
    log(f"[Lyckebo] Saved {p.relative_to(IMAGE_ROOT)}")
    return True


def parse_cursor(state: dict) -> datetime | None:
    # Bakåtkomp: acceptera gammal key om den finns
    for k in ("cursor_dt", "last_saved_dt"):
        v = state.get(k)
        if not v:
            continue
        try:
            return datetime.fromisoformat(v)
        except Exception:
            pass
    return None


def main() -> None:
    session = requests.Session()
    session.headers.update({"User-Agent": UA})

    state = load_state()

    items = list_dir(session)
    if not items:
        log("[Lyckebo] Dirlisting empty; exiting.")
        return

    # =========================
    # Startup sync: gå igenom allt (eller cap) och säkerställ lokalt + thumbs
    # =========================
    if STARTUP_SYNC:
        log("[Lyckebo] Startup sync begin")
        downloaded = 0
        processed = 0

        for dt, url, name in items:
            if STARTUP_MAX > 0 and processed >= STARTUP_MAX:
                break
            processed += 1
            try:
                if ensure_one(session, state, dt, url, name):
                    downloaded += 1
            except Exception as e:
                log(f"[Lyckebo] Startup sync error for {name}: {e}")

        save_state(state)
        log(f"[Lyckebo] Startup sync done, downloaded={downloaded}, processed={processed}")

    # =========================
    # Normal loop
    # =========================
    while True:
        try:
            items = list_dir(session)
            if not items:
                time.sleep(POLL_SECONDS)
                continue

            # Toucha alltid senaste remote (skapar thumb + håller last_ok_utc färsk)
            try:
                dt_last, url_last, name_last = items[-1]
                ensure_one(session, state, dt_last, url_last, name_last)
            except Exception as e:
                log(f"[Lyckebo] Latest touch error: {e}")

            cursor = parse_cursor(state)
            if cursor is None:
                # Första varvet: starta på senaste
                cursor = items[-1][0]
                state["cursor_dt"] = cursor.isoformat()
                save_state(state)
                time.sleep(POLL_SECONDS)
                continue

            todo = [it for it in items if it[0] > cursor]
            progressed = False

            if todo:
                batch = todo[:INCREMENTAL_MAX]
                log(f"[Lyckebo] Catch-up {len(batch)}/{len(todo)}")
                for dt, url, name in batch:
                    try:
                        ensure_one(session, state, dt, url, name)
                        progressed = True
                    except Exception as e:
                        log(f"[Lyckebo] Catch-up error for {name}: {e}")
            else:
                last_ok = float(state.get("last_ok_utc", "0") or 0)
                age = (time.time() - last_ok) if last_ok else 1e9
                if age > STALE_SECONDS:
                    tail = items[-RESCAN_LAST:] if RESCAN_LAST > 0 else items
                    log(f"[Lyckebo] Stale for {int(age)}s -> rescan last {len(tail)} remote files")
                    for dt, url, name in tail:
                        if out_path_for(dt).exists():
                            continue
                        try:
                            if ensure_one(session, state, dt, url, name):
                                progressed = True
                        except Exception as e:
                            log(f"[Lyckebo] Rescan error for {name}: {e}")

            if progressed:
                save_state(state)

        except Exception as e:
            log(f"[Lyckebo] ERROR: {e}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
