#!/usr/bin/env python3
import re
import shutil
from pathlib import Path
from datetime import datetime
import argparse

from PIL import Image

# Matchar t.ex. 26-01-16_18-25-21_9999.jpg
BATCH_RE = re.compile(
    r'(?P<yy>\d{2})-(?P<mm>\d{2})-(?P<dd>\d{2})_(?P<hh>\d{2})-(?P<mi>\d{2})-(?P<ss>\d{2})',
    re.IGNORECASE
)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def parse_dt_from_name(name: str) -> datetime | None:
    m = BATCH_RE.search(name)
    if not m:
        return None
    yy = int(m.group("yy"))
    mm = int(m.group("mm"))
    dd = int(m.group("dd"))
    hh = int(m.group("hh"))
    mi = int(m.group("mi"))
    ss = int(m.group("ss"))

    # 00-69 => 2000-2069, 70-99 => 1970-1999 (klassisk regel)
    year = 2000 + yy if yy <= 69 else 1900 + yy
    return datetime(year, mm, dd, hh, mi, ss)


def make_thumb(src_path: Path, thumb_path: Path, max_size: int = 900, quality: int = 85) -> None:
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src_path) as im:
        im = im.convert("RGB")
        im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        im.save(thumb_path, format="JPEG", quality=quality, optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Sortera/byt namn på Lyckebo batchbilder och skapa thumbnails.")
    ap.add_argument("--root", default="/app/data/images/lyckebocam",
                    help="Rotmapp för lyckebocam (default: /app/data/images/lyckebocam)")
    ap.add_argument("--batch", default="/app/data/images/lyckebocam/batch",
                    help="Batchmapp (default: /app/data/images/lyckebocam/batch)")
    ap.add_argument("--prefix", default="Lyckebo", help="Prefix för omdöpta filer (default: Lyckebo)")
    ap.add_argument("--max-thumb", type=int, default=900, help="Max storlek på thumb (default: 900)")
    ap.add_argument("--quality", type=int, default=85, help="JPEG-kvalitet för thumb (default: 85)")
    ap.add_argument("--dry-run", action="store_true", help="Visa vad som skulle göras utan att flytta/skriva.")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    batch = Path(args.batch).resolve()

    if not batch.exists():
        print(f"Batchmappen finns inte: {batch}")
        return 2

    files = sorted([p for p in batch.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS])
    if not files:
        print(f"Inga bildfiler hittades i: {batch}")
        return 0

    moved = 0
    skipped = 0
    for src in files:
        dt = parse_dt_from_name(src.name)
        if not dt:
            print(f"SKIP (kan inte tolka datum): {src.name}")
            skipped += 1
            continue

        # Bygg destinationsmapp: YYYY/MM/DD
        day_dir = root / f"{dt.year:04d}" / f"{dt.month:02d}" / f"{dt.day:02d}"
        dst_name = f"{args.prefix}_{dt.strftime('%Y%m%dT%H%M%SZ')}.jpg"
        dst = day_dir / dst_name

        thumb_dir = day_dir / "thumbs"
        thumb = thumb_dir / f"{args.prefix}_{dt.strftime('%Y%m%dT%H%M%SZ')}_thumb.jpg"

        print(f"{src.name} -> {dst.relative_to(root.parent) if root.parent in dst.parents else dst}")
        if args.dry_run:
            continue

        day_dir.mkdir(parents=True, exist_ok=True)

        # Flytta/byt namn (om fil redan finns: hoppa)
        if dst.exists():
            print(f"  EXISTS: {dst.name} (hoppar över flytt)")
            skipped += 1
        else:
            shutil.move(str(src), str(dst))
            moved += 1

        # Skapa thumb om saknas
        if not thumb.exists() and dst.exists():
            try:
                make_thumb(dst, thumb, max_size=args.max_thumb, quality=args.quality)
                print(f"  THUMB: {thumb.name}")
            except Exception as e:
                print(f"  THUMB-FAIL: {e}")

    print(f"Klart. Flyttade: {moved}, Skippade: {skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
