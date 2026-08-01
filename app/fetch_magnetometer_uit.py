# ---- app/fetch_magnetometer_uit.py ----

import os
import requests
import time as systime
from datetime import datetime, timedelta
from io import BytesIO

from PIL import Image
import numpy as np

from utils import nowstr, log, get_db, wait_for_db, ensure_table

# ------------------------------------------------------------
# 1) STATIONS OCH URL-MALL (Last24-GIF)
# ------------------------------------------------------------
# Samma stationer som tidigare, men vi använder Last24-filnamn direkt.
STATIONS = {
    "NAL": "nal1a",
    "LYR": "lyr2a",
    "HOP": "hop1a",
    "BJN": "bjn1a",
    "JAN": "jan1a",
    "NOR": "nor1a",
    "SOR": "sor1a",
    "TRO": "tro2a",
    "AND": "and1a",
    "RST": "rst1a",
    "JCK": "jck1a",
    "DON": "don1a",
    "RVK": "rvk1a",
    "DOB": "dob1a",
    "SOL": "sol1a",
    "HAR": "har1a",
    "KAR": "kar1a",
    "TRL": "trl1a",
}

# Last24-URL: vi formaterar in stationens “slug” (ex. “nal1a”) i filnamnet.
BASE_URL = "https://flux.phys.uit.no/Last24/Last24_{slug}.gif"


# ------------------------------------------------------------
# 2) KONSTANTER FÖR PIXELINTERVALL OCH NOLLPUNKTER
# ------------------------------------------------------------
PIXEL_X_START = 61
PIXEL_X_END   = 780

# Vertikala nollpunkter (y-pixlar) för D, H, Z
# Observera: D (röd) vid y=300, H (blå) vid y=350, Z (grön) vid y=250
Y_ZERO = {
    "H": 350,   # blå kurva (horisontell intensitet i nT)
    "D": 300,   # röd kurva  (deklination i grader)
    "Z": 250,   # grön kurva (vertikal komponent i nT)
}

# Färger (RGB) för de tre kurvorna och grid-linjer (ljusgrå)
COLOR_TOLERANCE = 30
COLOR_RED   = (255,   0,   0)
COLOR_GREEN = (  0, 255,   0)
COLOR_BLUE  = (  0,   0, 255)
COLOR_GRID  = (200, 200, 200)  # ljusgrå rutnätslinjer


# ------------------------------------------------------------
# 3) SQL-TABELL: skapas om den saknas
# ------------------------------------------------------------
CREATE_SQL = """
CREATE TABLE IF NOT EXISTS magnetometer_uit_gif (
    station VARCHAR(8),
    timestamp DATETIME,
    D_deg FLOAT,
    H_nT  FLOAT,
    Z_nT  FLOAT,
    PRIMARY KEY (station, timestamp)
)
"""


# ------------------------------------------------------------
# 4) HJÄLPFUNKTIONER FÖR FÄRGDETEKTION
# ------------------------------------------------------------
def is_similar_color(pixel_rgb, target_rgb, tol=COLOR_TOLERANCE):
    """
    Return True om pixel_rgb ligger inom 'tol' i varje kanal gentemot target_rgb.
    """
    r1, g1, b1 = pixel_rgb
    r2, g2, b2 = target_rgb
    return (abs(r1 - r2) <= tol and
            abs(g1 - g2) <= tol and
            abs(b1 - b2) <= tol)


def is_red_pixel(r, g, b):
    return is_similar_color((r, g, b), COLOR_RED)


def is_green_pixel(r, g, b):
    return is_similar_color((r, g, b), COLOR_GREEN)


def is_blue_pixel(r, g, b):
    return is_similar_color((r, g, b), COLOR_BLUE)


def is_grid_line_pixel(r, g, b):
    return is_similar_color((r, g, b), COLOR_GRID, tol=10)


# ------------------------------------------------------------
# 5) LADDAR NER OCH RETURNERAR PIL-Bild
# ------------------------------------------------------------
def fetch_image_from_last24(station_slug):
    """
    Hämtar Last24‐GIF för angiven station och returnerar en PIL Image‐instans.
    Vi lägger på ?nocache för att undvika cacheade bilder.
    """
    url = BASE_URL.format(slug=station_slug)
    log(f"Downloading: {url}")
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    img = Image.open(BytesIO(response.content)).convert("RGB")
    return img


# 6) HITTA HORISONTELLA GRID-LINJER (generisk mode-baserad detektion)
# ------------------------------------------------------------
def find_horizontal_grid_lines(img):
    """
    Identifierar horisontella rutnätslinjer genom att undersöka varje y-rad i hela bilden.
    För varje rad räknar vi mode-färgen (den färg som förekommer flest gånger) och ser
    om den täcker >80% av raden. Om ja, betraktas raden som grid-linje.
    Returnerar en sorterad lista med y-pixlar för dessa linjer.
    """
    width, height = img.size
    grid_lines = []

    for y in range(0, height):
        # Hämta RGB för varje pixel i raden (vi kan sampling varannan pixel för snabbhet)
        pixels = [img.getpixel((x, y)) for x in range(0, width, 2)]
        # Räkna hur många gånger varje färg förekommer
        counts = {}
        for pix in pixels:
            counts[pix] = counts.get(pix, 0) + 1
        # Hitta mode-färgen och dess andel
        mode_color, mode_count = max(counts.items(), key=lambda kv: kv[1])
        fraction = mode_count / float(len(pixels))
        # Om mode-färgen täcker >80% av raden, tolka som grid-linje
        if fraction >= 0.80:
            grid_lines.append(y)

    return sorted(grid_lines)

# ------------------------------------------------------------
# 7) KALIBRERA PIXEL→ENHET (nT eller grader)
# ------------------------------------------------------------
def calibrate_scale(grid_lines, y_zero, unit_per_line):
    """
    Givet 'grid_lines' (lista av y-pixlar för horisontella streck),
    y_zero (noll-pixel) och unit_per_line (100.0 för nT eller 0.50 för grader),
    returneras (unit_per_pixel, dy_pixel).

    - unit_per_pixel = unit_per_line / |dy_pixel|.
    - dy_pixel = pixeldistans mellan närmaste grid-linje och y_zero (absolutvärde).
    """
    if not grid_lines:
        raise ValueError("Ingen grid-linje hittad inom intervallet för kalibrering.")
    # Beräkna minsta avstånd från y_zero till någon grid_line ≠ y_zero
    diffs = [abs(y - y_zero) for y in grid_lines if y != y_zero]
    if diffs:
        dy_pixel = min(diffs)
    else:
        # Om y_zero råkar ligga på en grid-linje, välj två närmaste grid_lines och använd deras avstånd
        if len(grid_lines) < 2:
            raise ValueError("För få grid-linjer för att kalibrera.")
        grid_sorted = sorted(grid_lines)
        dy_pixel = abs(grid_sorted[1] - grid_sorted[0])
    scale = unit_per_line / float(dy_pixel)
    return scale, dy_pixel


# ------------------------------------------------------------
# 8) SKRAPAR UT D, H, Z FRÅN EN LAST24-BILD
# ------------------------------------------------------------
def scrape_dhz_from_image(img):
    """
    Tar en PIL-bild 'img' (Last24-GIF) och extraherar tre tidsserier:
      - D (degrees)
      - H (nanotesla)
      - Z (nanotesla)
    Returnerar tre listor av tuples: (timestamp_utc, värde).
    """
    width, height = img.size

    # 8.1) TIDSAXEL (24 h UTC)
    now = datetime.utcnow()
    start_time = now - timedelta(hours=24)
    total_pixels = PIXEL_X_END - PIXEL_X_START       # 780 - 61 = 719
    minutes_per_pixel = 1440.0 / total_pixels        # 1440 min = 24 h

    # 8.2) Hitta och kalibrera skala för H, Z, D (skannar HELA bildens höjd)
    all_grids = find_horizontal_grid_lines(img)
    h_grid = [y for y in all_grids if abs(y - Y_ZERO["H"]) <= 100]
    scale_H, dy_H = calibrate_scale(h_grid, Y_ZERO["H"], unit_per_line=100.0)

    z_grid = [y for y in all_grids if abs(y - Y_ZERO["Z"]) <= 100]
    scale_Z, dy_Z = calibrate_scale(z_grid, Y_ZERO["Z"], unit_per_line=100.0)

    d_grid = [y for y in all_grids if abs(y - Y_ZERO["D"]) <= 100]
    scale_D, dy_D = calibrate_scale(d_grid, Y_ZERO["D"], unit_per_line=0.50)

    log(f"Calibration: H-scale={scale_H:.3f}nT/pix (dy={dy_H}), Z-scale={scale_Z:.3f}nT/pix (dy={dy_Z}), D-scale={scale_D:.4f}deg/pix (dy={dy_D})")

    # 8.3) Samla värden i tre listor
    d_series = []
    h_series = []
    z_series = []

    # 8.4) Loop över x = 61..780 och scanna y=200..420 (täcker alla kurvor)
    for x in range(PIXEL_X_START, PIXEL_X_END + 1):
        delta_min = (x - PIXEL_X_START) * minutes_per_pixel
        timestamp = start_time + timedelta(minutes=delta_min)

        for y in range(200, 421):
            r, g, b = img.getpixel((x, y))

            if is_blue_pixel(r, g, b):
                # H-komponenten (nanotesla)
                delta_pix = Y_ZERO["H"] - y
                h_val = delta_pix * scale_H
                h_series.append((timestamp, h_val))

            elif is_green_pixel(r, g, b):
                # Z-komponenten (nanotesla)
                delta_pix = Y_ZERO["Z"] - y
                z_val = delta_pix * scale_Z
                z_series.append((timestamp, z_val))

            elif is_red_pixel(r, g, b):
                # D-komponenten (grader)
                delta_pix = Y_ZERO["D"] - y
                d_val = delta_pix * scale_D
                d_series.append((timestamp, d_val))

            else:
                # annan färg→ ignoreras
                continue

    return d_series, h_series, z_series


# ------------------------------------------------------------
# 9) LAGRAR DATA I MARIADB
# ------------------------------------------------------------
def insert_into_db(station_code, d_series, h_series, z_series):
    """
    Skriver in D/H/Z i tabellen 'magnetometer_uit_gif'.
    Vi använder INSERT IGNORE för att undvika dubbletter (PRIMARY KEY).
    """
    wait_for_db()
    ensure_table(CREATE_SQL)
    log(f"Inserting data into DB for {station_code}")

    conn = get_db()
    cur = conn.cursor()

    # Bygg upp ett index över timestamp → {D:, H:, Z:}
    all_timestamps = set(ts for ts, _ in d_series) | set(ts for ts, _ in h_series) | set(ts for ts, _ in z_series)
    data_map = {ts: {"D": None, "H": None, "Z": None} for ts in all_timestamps}

    for ts, val in d_series:
        data_map[ts]["D"] = val
    for ts, val in h_series:
        data_map[ts]["H"] = val
    for ts, val in z_series:
        data_map[ts]["Z"] = val

    inserted = 0
    for ts in sorted(all_timestamps):
        row = data_map[ts]
        try:
            cur.execute(
                """
                INSERT IGNORE INTO magnetometer_uit_gif (station, timestamp, D_deg, H_nT, Z_nT)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (station_code, ts.strftime("%Y-%m-%d %H:%M:%S"),
                 row["D"], row["H"], row["Z"])
            )
            inserted += cur.rowcount
        except Exception as e:
            log(f"DB error for {station_code} at {ts}: {e}")

    conn.commit()
    cur.close()
    conn.close()
    log(f"Inserted {inserted} rows for {station_code}")


# ------------------------------------------------------------
# 10) BEARBETAR ALLA STATIONER
# ------------------------------------------------------------
def fetch_and_process_all():
    for code, slug in STATIONS.items():
        try:
            # 10.1) Hämta bilden
            img = fetch_image_from_last24(slug)

            # 10.2) Extrahera D, H, Z
            d_series, h_series, z_series = scrape_dhz_from_image(img)

            # 10.3) Lagra i DB
            insert_into_db(code, d_series, h_series, z_series)

        except Exception as e:
            log(f"Error processing station {code}: {e}")
            continue


# ------------------------------------------------------------
# 11) MAIN-LOOP
# ------------------------------------------------------------
if __name__ == "__main__":
    while True:
        log("Starting Last24 magnetometer fetcher")
        fetch_and_process_all()
        log("Done. Sleeping 5 minutes.")
        systime.sleep(300)
