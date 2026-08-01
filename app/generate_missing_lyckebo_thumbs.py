#!/usr/bin/env python3
"""
Generate missing thumbnails for existing Lyckebo images.

- Scans IMAGE_ROOT/KEY/YYYY/MM/DD/*.jpg
- Creates IMAGE_ROOT/KEY/YYYY/MM/DD/thumbs/*_thumb.jpg when missing
- Does NOT modify original images
"""

import os
import re
from pathlib import Path

from PIL import Image


IMAGE_ROOT = Path(os.getenv("IMAGE_ROOT", "/app/data/images"))
KEY = os.getenv("LYCKEBO_KEY", "lyckebocam")
PREFIX = os.getenv("LYCKEBO_PREFIX", "Lyckebo")

# Match filenames like: Lyckebo_20260120T124200Z.jpg
FILENAME_RE = re.compile(rf"^{re.escape(PREFIX)}_(\d{{8}}T\d{{6}}Z)\.jpg$", re.IGNORECASE)


def create_thumbnail(image_path: Path, thumb_path: Path, max_width: int = 320, quality: int = 88) -> None:
    """Create a small JPEG thumbnail."""
    img = Image.open(image_path)
    if img.mode != "RGB":
        img = img.convert("RGB")

    w, h = img.size
    if w > max_width:
        scale = max_width / float(w)
        new_h = int(h * scale)
        img = img.resize((max_width, new_h), Image.LANCZOS)

    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(thumb_path, "JPEG", quality=quality, optimize=True, progressive=True)


def main() -> int:
    root = IMAGE_ROOT / KEY
    if not root.exists():
        print(f"Folder not found: {root}")
        return 2

    created = 0
    skipped = 0
    errors = 0

    # Iterate all jpg files, but skip thumbs folders
    for jpg in root.rglob("*.jpg"):
        if "thumbs" in jpg.parts:
            continue

        m = FILENAME_RE.match(jpg.name)
        if not m:
            # Not a Lyckebo image in expected naming format
            continue

        ts = m.group(1)
        day_dir = jpg.parent
        thumb_path = day_dir / "thumbs" / f"{PREFIX}_{ts}_thumb.jpg"

        if thumb_path.exists():
            skipped += 1
            continue

        try:
            create_thumbnail(jpg, thumb_path)
            created += 1
        except Exception as e:
            errors += 1
            print(f"ERROR: {jpg} -> {thumb_path}: {e}")

    print(f"Done. created={created} skipped={skipped} errors={errors}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
