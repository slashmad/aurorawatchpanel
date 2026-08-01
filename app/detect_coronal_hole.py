# detect_coronal_hole.py
from pathlib import Path
from datetime import datetime, timezone
import cv2
import numpy as np
import pymysql
import shutil
import argparse
from typing import Optional
from utils import DB as DB_CONFIG

IMAGE_DIR = Path("/app/data/images/SDO_193")
BATCH_DIR = Path("/app/data/images/SDO_BATCH/193")
HOLE_DIR = Path("/app/data/images/coronal-holes")
HOLE_DIR.mkdir(parents=True, exist_ok=True)

DEBUG_MASK = False  # Set True to save debug masks

EARTH_FACING_LIMIT_DEG = 60.0  # frames within +/- 60 deg from disk center are considered "earth-facing"

def carrington_rotation(dt):
    JD = dt.timestamp() / 86400.0 + 2440587.5
    CARRINGTON_START_JD = 2398167.29583
    ROTATION_PERIOD = 27.2753
    return int((JD - CARRINGTON_START_JD) / ROTATION_PERIOD) + 1


def detect_coronal_hole(image_path):
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        print("Could not read image:", image_path)
        return None, None, None, None, None, None

    h, w = img.shape
    center_x, center_y = w // 2, h // 2
    radius = int(0.40 * w)

    # Circular mask (solar disk)
    yy, xx = np.ogrid[:h, :w]
    mask_circle = (xx - center_x) ** 2 + (yy - center_y) ** 2 <= radius ** 2

    # Dark regions threshold
    thresh_val = 60
    mask_dark = (img < thresh_val) & mask_circle

    # Remove outer limb (outer 4%)
    inner_radius = int(radius * 0.96)
    mask_inner = (xx - center_x) ** 2 + (yy - center_y) ** 2 <= inner_radius ** 2
    mask_dark = mask_dark & mask_inner

    # Morphological cleanup
    kernel = np.ones((5, 5), np.uint8)
    mask_dark = cv2.morphologyEx(mask_dark.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    mask_dark = cv2.morphologyEx(mask_dark, cv2.MORPH_CLOSE, kernel)

    # Area fraction
    area_fraction = float(mask_dark.sum()) / float(max(1, mask_circle.sum()))

    # Find contours to locate largest hole
    contours, _ = cv2.findContours(mask_dark.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return area_fraction, None, 0, 0, None, None
    largest = max(contours, key=cv2.contourArea)
    x, y, w_box, h_box = cv2.boundingRect(largest)

    # Centroid longitude/latitude in degrees (no cropping)
    M = cv2.moments(largest)
    if M["m00"] != 0:
        cx_hole = M["m10"] / M["m00"]
        cy_hole = M["m01"] / M["m00"]
    else:
        cx_hole = x + w_box / 2.0
        cy_hole = y + h_box / 2.0

    # Normalize offsets by solar disk radius
    dx = (cx_hole - center_x) / float(radius)
    dy = (center_y - cy_hole) / float(radius)  # screen y grows downward -> invert for latitude

    dx = float(np.clip(dx, -1.0, 1.0))
    dy = float(np.clip(dy, -1.0, 1.0))

    # Central meridian distance (longitude) and heliographic latitude (approx)
    lon_deg = float(np.degrees(np.arcsin(dx)))  # [-90,+90]
    lat_deg = float(np.degrees(np.arcsin(dy)))  # [-90,+90]

    # Reuse 'preview' as an "earth-facing" flag for backward compatibility
    preview = 1 if abs(lon_deg) <= EARTH_FACING_LIMIT_DEG else 0


    if DEBUG_MASK:
        # Grundmasker
        cv2.imwrite(str(HOLE_DIR / "DEBUG_sun_circle.jpg"), (mask_circle * 255).astype(np.uint8))
        cv2.imwrite(str(HOLE_DIR / "DEBUG_dark_mask.jpg"), mask_dark * 255)

        # Extra: original + overlay för visuell kontroll
        debug_input = cv2.imread(str(image_path))
        debug_overlay = debug_input.copy()
        debug_overlay[mask_dark > 0] = (0, 0, 255)  # färga mörka områden röda
        alpha = 0.4
        blended = cv2.addWeighted(debug_input, 1 - alpha, debug_overlay, alpha, 0)
        cv2.imwrite(str(HOLE_DIR / "DEBUG_input.jpg"), debug_input)
        cv2.imwrite(str(HOLE_DIR / "DEBUG_overlay.jpg"), blended)

    return area_fraction, (x, y, w_box, h_box), lon_deg, lat_deg, preview, mask_dark, mask_circle


def process_latest_image():
    files = sorted([f for f in IMAGE_DIR.glob("SDO_193_*.jpg") if "_thumb" not in f.name], reverse=True)
    if not files:
        print("No SDO_193 images found.")
        return

    latest = files[0]
    dt_str = latest.stem.split("_")[2]
    dt = datetime.strptime(dt_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    rotation = carrington_rotation(dt)

    area_fraction, bbox, lon_deg, lat_deg, preview, mask_dark, mask_circle = detect_coronal_hole(latest)
    print(f"[DEBUG] area_fraction={area_fraction:.3f}, lon_deg={lon_deg:.1f}, lat_deg={lat_deg:.1f}, preview={preview}")

    detected = area_fraction > 0.03 or preview == 1

    bbox_x, bbox_y, bbox_w, bbox_h = bbox if bbox else (None, None, None, None)

    processed_filename = None
    if detected:
        thumb_name = latest.stem + "_thumb.jpg"
        date_folder = dt.strftime("%Y/%m/%d")
        target_dir = HOLE_DIR / date_folder
        target_dir.mkdir(parents=True, exist_ok=True)

        processed_filename = target_dir / thumb_name
        img = cv2.imread(str(latest))
        h, w = img.shape[:2]
        scale = 700 / max(h, w)
        thumb = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(processed_filename), thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        print(f"Saved coronal hole thumb: {processed_filename}")

    relative_processed_filename = f"{dt.strftime('%Y/%m/%d')}/{latest.stem}_thumb.jpg" if processed_filename else None

    conn = pymysql.connect(**DB_CONFIG)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO coronal_holes
              (timestamp, filename, processed_filename, area_fraction,
               bbox_x, bbox_y, bbox_w, bbox_h, carrington, detected,
               lon_deg, lat_deg, preview)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
              filename=VALUES(filename),
              processed_filename=VALUES(processed_filename),
              area_fraction=VALUES(area_fraction),
              bbox_x=VALUES(bbox_x),
              bbox_y=VALUES(bbox_y),
              bbox_w=VALUES(bbox_w),
              bbox_h=VALUES(bbox_h),
              carrington=VALUES(carrington),
              detected=VALUES(detected),
              lon_deg=VALUES(lon_deg),
              lat_deg=VALUES(lat_deg),
              preview=VALUES(preview)
            """,
            (dt, latest.name, relative_processed_filename, area_fraction,
             bbox_x, bbox_y, bbox_w, bbox_h, rotation, int(detected),
             lon_deg, lat_deg, preview)
        )
    conn.close()

    print(f"Processed: {latest.name}, area_fraction={area_fraction:.3f}, rotation={rotation}, detected={detected}")

def iter_source_images(source_dir: Path, pattern: str = "SDO_193_*.jpg"):
    """
    Recursively yield image files matching pattern from source_dir, skipping thumbs.
    """
    # Use rglob so we can traverse YYYY/MM/DD subfolders (e.g., SDO_BATCH/193/10/01/..)
    for f in source_dir.rglob(pattern):
        if "_thumb" in f.name:
            continue
        if f.is_file():
            yield f


def process_backfill(since: Optional[datetime] = None,
                     until: Optional[datetime] = None,
                     regenerate_thumbs: bool = False,
                     source_dir: Optional[Path] = None,
                     pattern: str = "SDO_193_*.jpg"):
    src = source_dir or BATCH_DIR
    print(f"[BACKFILL] Using source: {src}")

    files = sorted(iter_source_images(src, pattern))
    if not files:
        print("No SDO_193 images found for backfill.")
        return

    conn = pymysql.connect(**DB_CONFIG)
    inserted, updated, skipped = 0, 0, 0

    with conn.cursor() as cur:
        for f in files:
            try:
                dt_str = f.stem.split("_")[2]
                dt = datetime.strptime(dt_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except Exception:
                skipped += 1
                continue

            if since and dt < since:
                continue
            if until and dt > until:
                continue

            rotation = carrington_rotation(dt)
            area_fraction, bbox, lon_deg, lat_deg, preview, mask_dark, mask_circle = detect_coronal_hole(f)
            detected = (area_fraction or 0) > 0.03 or preview == 1

            bbox_x, bbox_y, bbox_w, bbox_h = bbox if bbox else (None, None, None, None)

            # Thumb path (same logic as process_latest_image)
            relative_processed_filename = None
            processed_filename = None
            if detected and regenerate_thumbs:
                thumb_name = f.stem + "_thumb.jpg"
                date_folder = dt.strftime("%Y/%m/%d")
                target_dir = HOLE_DIR / date_folder
                target_dir.mkdir(parents=True, exist_ok=True)
                processed_filename = target_dir / thumb_name

                img = cv2.imread(str(f))
                if img is not None:
                    h, w = img.shape[:2]
                    scale = 700 / max(h, w)
                    thumb = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                    cv2.imwrite(str(processed_filename), thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                relative_processed_filename = f"{date_folder}/{f.stem}_thumb.jpg"

            # Upsert (insert or update existing by unique key)
            # Try INSERT; if duplicate, do UPDATE of dynamic fields.
            try:
                cur.execute(
                    """
                    INSERT INTO coronal_holes
                      (timestamp, filename, processed_filename, area_fraction,
                       bbox_x, bbox_y, bbox_w, bbox_h, carrington, detected,
                       lon_deg, preview)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (dt, f.name, relative_processed_filename, area_fraction,
                     bbox_x, bbox_y, bbox_w, bbox_h, rotation, int(detected),
                     lon_deg, preview)
                )
                inserted += 1
            except pymysql.err.IntegrityError:
                # Row exists -> UPDATE latest fields (keep existing thumb if we didn't regenerate)
                cur.execute(
                    """
                    UPDATE coronal_holes
                       SET processed_filename = COALESCE(%s, processed_filename),
                           area_fraction = %s,
                           bbox_x = %s, bbox_y = %s, bbox_w = %s, bbox_h = %s,
                           carrington = %s, detected = %s,
                           lon_deg = %s, preview = %s
                     WHERE timestamp = %s AND filename = %s
                    """,
                    (relative_processed_filename, area_fraction,
                     bbox_x, bbox_y, bbox_w, bbox_h,
                     rotation, int(detected),
                     lon_deg, preview,
                     dt, f.name)
                )
                updated += 1

    conn.close()
    print(f"[BACKFILL] inserted={inserted}, updated={updated}, skipped={skipped}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Detect coronal holes from SDO_193 images")
    parser.add_argument("--mode", choices=["latest", "backfill"], default="latest")
    parser.add_argument("--since", type=str, default=None, help="ISO date YYYY-MM-DD or UTC like 2025-10-01T00:00:00Z")
    parser.add_argument("--until", type=str, default=None, help="ISO date YYYY-MM-DD or UTC like 2025-10-08T23:59:59Z")
    parser.add_argument("--regen-thumbs", action="store_true", help="Regenerate thumbs during backfill")

    # NEW: source directory & filename pattern (so we can backfill from SDO_BATCH/193)
    parser.add_argument("--source-dir", type=str, default=None,
                        help="Root folder to scan images from (e.g., /app/data/images/SDO_BATCH/193)")
    parser.add_argument("--pattern", type=str, default="SDO_193_*.jpg",
                        help="Filename glob pattern (default: SDO_193_*.jpg)")

    args = parser.parse_args()

    def parse_dt(s):
        if not s:
            return None
        try:
            if "T" in s:
                return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except Exception:
            raise SystemExit(f"Bad date format: {s}")

    if args.mode == "latest":
        process_latest_image()
    else:
        since_dt = parse_dt(args.since)
        until_dt = parse_dt(args.until)
        src_dir = Path(args.source_dir) if args.source_dir else None
        process_backfill(
            since_dt, until_dt,
            regenerate_thumbs=args.regen_thumbs,
            source_dir=src_dir,
            pattern=args.pattern
        )

#    python3 detect_coronal_hole.py --mode backfill --source-dir /app/data/images/SDO_BATCH/193 --since 2025-01-01 --until 2025-01-31 --regen-thumbs --pattern "*.png"
