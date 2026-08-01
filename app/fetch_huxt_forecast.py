# ---- app/fetch_huxt_forecast.py ----
import json
import os
import time
from pathlib import Path

import requests

HUXT_URL = "https://swxforecastlab.s3.eu-west-2.amazonaws.com/WSA_CONECME_huxt_animation_latest.mp4"
OUTDIR = Path("data/huxt")
OUTFILE = OUTDIR / "huxt_latest.mp4"
META_FILE = OUTDIR / "huxt_latest.meta.json"


def load_meta():
    try:
        with META_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_meta(meta):
    try:
        with META_FILE.open("w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception as e:
        print(f"Could not write meta: {e}")


def head_info():
    try:
        r = requests.head(HUXT_URL, timeout=20, allow_redirects=True)
        if not r.ok:
            return {}
        return {
            "etag": r.headers.get("ETag") or r.headers.get("Etag"),
            "last_modified": r.headers.get("Last-Modified"),
            "content_length": r.headers.get("Content-Length"),
        }
    except Exception as e:
        print(f"HEAD failed: {e}")
        return {}


def should_download(meta, head):
    if not OUTFILE.exists():
        return True
    if head.get("etag") and meta.get("etag") == head.get("etag"):
        return False
    if head.get("last_modified") and meta.get("last_modified") == head.get("last_modified"):
        return False
    if head.get("content_length"):
        try:
            if OUTFILE.stat().st_size == int(head["content_length"]):
                return False
        except Exception:
            pass
    return True


def fetch():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    meta = load_meta()
    head = head_info()
    if not should_download(meta, head):
        print("HUXt: no update.")
        return

    tmp = OUTDIR / "huxt_latest.tmp"
    print(f"HUXt: downloading {HUXT_URL}")
    try:
        with requests.get(HUXT_URL, stream=True, timeout=120) as r:
            r.raise_for_status()
            with tmp.open("wb") as f:
                for chunk in r.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
        os.replace(tmp, OUTFILE)
        save_meta({
            "etag": head.get("etag"),
            "last_modified": head.get("last_modified"),
            "content_length": head.get("content_length"),
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        print(f"HUXt: saved {OUTFILE}")
    except Exception as e:
        print(f"HUXt: download failed: {e}")
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass


def main():
    while True:
        fetch()
        print("HUXt: sleep 1 hour...")
        time.sleep(3600)


if __name__ == "__main__":
    main()
