# detect_sunspot_overlay.py

from pathlib import Path
from datetime import datetime, timezone, timedelta
import pymysql
import cv2
from utils import DB as DB_CONFIG

IMAGE_DIR = Path("/app/data/images/SDO_HMIIF")
OUTPUT_DIR = Path("/app/data/images/sunspots")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def get_latest_hmiif_image():
    files = sorted(IMAGE_DIR.glob("SDO_HMIIF_*.jpg"), reverse=True)
    for f in files:
        if "_thumb" not in f.name and "_overlay" not in f.name:
            return f
    return None

def get_regions_near_timestamp(timestamp):
    conn = pymysql.connect(**DB_CONFIG)
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM solar_regions WHERE date = %s", (timestamp.date(),))
        rows = cur.fetchall()
    conn.close()
    return rows

def draw_regions_on_image(image_path, regions, output_path):
    img = cv2.imread(str(image_path))
    h, w, _ = img.shape

    for r in regions:
        try:
            loc = r.get("location", "")
            if len(loc) < 5 or "N/A" in loc:
                continue
            lat_str = loc[:3]
            lon_str = loc[3:]

            try:
                lat = int(lat_str.replace("N", "").replace("S", "-").replace("*", "0"))
                lon = int(lon_str.replace("E", "").replace("W", "-").replace("*", "0"))
            except ValueError:
                continue  # hoppa över trasig punkt

            x = int(w // 2 - (lon / 90) * (w // 1.5) - 260)
            y = int(h // 2 - (lat / 90) * (h // 1.5))

            # Röd, större och tjockare ruta
            cv2.rectangle(img, (x - 40, y - 40), (x + 40, y + 40), (0, 0, 255), 3)
            cv2.putText(img, str(r["region_num"]), (x - 28, y + 12),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        except Exception as e:
            print("Draw error:", e)

    cv2.imwrite(str(output_path), img)


def process_latest_sunspot_image():
    latest_img = get_latest_hmiif_image()
    if not latest_img:
        print("No HMIIF image found.")
        return

    ts_str = latest_img.stem.split("_")[2]  # Ex: 20250614T123011Z
    dt = datetime.strptime(ts_str, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    regions = get_regions_near_timestamp(dt)
    if not regions:
        print("No regions found for", dt)
        return

    out_name = latest_img.name.replace(".jpg", "_overlay.jpg")
    out_path = OUTPUT_DIR / out_name
    draw_regions_on_image(latest_img, regions, out_path)

    conn = pymysql.connect(**DB_CONFIG)
    with conn.cursor() as cur:
        cur.execute("""
            INSERT IGNORE INTO sunspot_overlay (timestamp, filename, processed_filename)
            VALUES (%s, %s, %s)
        """, (dt, latest_img.name, out_name))
    conn.close()

    print("Saved overlay:", out_name)

if __name__ == "__main__":
    process_latest_sunspot_image()
