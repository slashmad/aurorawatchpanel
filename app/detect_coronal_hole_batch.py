# detect_coronal_hole_batch.py

from pathlib import Path
from datetime import datetime, timezone
import cv2
import numpy as np
import pymysql
import argparse
from utils import DB as DB_CONFIG

# Använd rätt root för bildkatalogen:
IMAGE_ROOT = Path("/app/data/images/SDO_BATCH/193")
HOLE_ROOT = Path("/app/data/images/coronal-holes")
HOLE_ROOT.mkdir(parents=True, exist_ok=True)

DEBUG_MASK = False  # Sätt True för debugmasker

def carrington_rotation(dt):
    JD = dt.timestamp() / 86400.0 + 2440587.5
    CARRINGTON_START_JD = 2398167.29583
    ROTATION_PERIOD = 27.2753
    rotation = int((JD - CARRINGTON_START_JD) / ROTATION_PERIOD) + 1
    return rotation

def detect_coronal_hole(image_path):
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        print("Kunde inte läsa bild:", image_path)
        return None, None

    h, w = img.shape
    center_x, center_y = w // 2, h // 2
    radius = int(0.47 * w)
    y_indices, x_indices = np.ogrid[:h, :w]
    mask_circle = (x_indices - center_x)**2 + (y_indices - center_y)**2 <= radius**2

    thresh_val = 70
    mask_dark = (img < thresh_val) & mask_circle
    area_fraction = mask_dark.sum() / mask_circle.sum()

    if DEBUG_MASK:
        cv2.imwrite(str(HOLE_ROOT / f"DEBUG_{image_path.name}_circle.jpg"), (mask_circle*255).astype(np.uint8))
        cv2.imwrite(str(HOLE_ROOT / f"DEBUG_{image_path.name}_mask.jpg"), (mask_dark*255).astype(np.uint8))

    contours, _ = cv2.findContours(mask_dark.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return area_fraction, None
    largest = max(contours, key=cv2.contourArea)
    x, y, w_box, h_box = cv2.boundingRect(largest)
    return area_fraction, (x, y, w_box, h_box)

def extract_datetime_from_filename(fname):
    # Exempel: SDO_193_20250616T185520Z.png
    stem = Path(fname).stem
    parts = stem.split("_")
    if len(parts) == 3 and "T" in parts[2]:
        dt_str = parts[2].replace("Z", "")
        try:
            dt = datetime.strptime(dt_str, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            pass
    return None

def batch_process(from_date=None, to_date=None):
    all_files = sorted(list(IMAGE_ROOT.rglob("*.png")))
    if not all_files:
        print("No PNG images found.")
        return

    # Filtrera på datum om argument angivits
    def is_within_date(fname):
        dt = extract_datetime_from_filename(fname.name)
        if not dt:
            return False
        if from_date and dt.date() < from_date:
            return False
        if to_date and dt.date() > to_date:
            return False
        return True

    if from_date or to_date:
        all_files = [f for f in all_files if is_within_date(f)]
    print(f"{len(all_files)} images match date filter.")

    conn = pymysql.connect(**DB_CONFIG)
    processed = 0

    for img_path in all_files:
        # Skippar thumbnails om det finns sådana
        if "_thumb" in img_path.name:
            continue

        dt = extract_datetime_from_filename(img_path.name)
        if dt is None:
            print(f"Could not parse datetime in filename: {img_path.name}")
            continue
        rotation = carrington_rotation(dt)

        area_fraction, bbox = detect_coronal_hole(img_path)
        detected = area_fraction > 0.03
        bbox_x, bbox_y, bbox_w, bbox_h = bbox if bbox else (None, None, None, None)

        processed_filename = None
        if detected:
            rel_path = img_path.relative_to(IMAGE_ROOT)
            thumb_name = img_path.stem + "_thumb.jpg"
            out_path = HOLE_ROOT / rel_path.parent / thumb_name
            out_path.parent.mkdir(parents=True, exist_ok=True)
            img = cv2.imread(str(img_path))
            h, w = img.shape[:2]
            scale = 700 / max(h, w)
            thumb = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            if not out_path.exists():
                cv2.imwrite(str(out_path), thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                print(f"[{img_path.name}] Coronal hole thumb saved: {out_path}")
            else:
                print(f"[{img_path.name}] Thumb already exists, skipping: {out_path}")
            processed_filename = str(rel_path.parent / thumb_name)
            print(f"[{img_path.name}] Coronal hole thumb saved: {out_path}")

        # Spara i DB
        with conn.cursor() as cur:
            cur.execute(
                "INSERT IGNORE INTO coronal_holes (timestamp, filename, processed_filename, area_fraction, bbox_x, bbox_y, bbox_w, bbox_h, carrington, detected) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (dt, img_path.name, processed_filename, area_fraction, bbox_x, bbox_y, bbox_w, bbox_h, rotation, int(detected))
            )
        processed += 1
        print(f"[{img_path.name}] area_fraction={area_fraction:.3f} detected={detected}")

    conn.close()
    print(f"\nBatch done! Processed {processed} images.")

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('from_date', nargs='?', default=None, help="Format: YYYY-MM-DD (från och med)")
    parser.add_argument('to_date', nargs='?', default=None, help="Format: YYYY-MM-DD (till och med)")
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    from_date = datetime.strptime(args.from_date, "%Y-%m-%d").date() if args.from_date else None
    to_date = datetime.strptime(args.to_date, "%Y-%m-%d").date() if args.to_date else None
    batch_process(from_date, to_date)
