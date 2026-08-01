# ---- app/fetch_magnetometer_global.py ----

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_text, parse_datetime
from datetime import datetime, timedelta
import requests

USGS_STATIONS = [
    {"id": "BOU", "name": "Boulder"},
    {"id": "FRD", "name": "Fredericksburg"},
    {"id": "BRW", "name": "Barrow"},
    {"id": "CMO", "name": "College"},
]

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS magnetometer_global (
        station VARCHAR(16),
        timestamp DATETIME,
        x FLOAT,
        y FLOAT,
        z FLOAT,
        value FLOAT,
        PRIMARY KEY (station, timestamp)
    )
"""

wait_for_db()

def fetch_and_store_usgs_station(station_id):
    url = f"https://geomag.usgs.gov/ws/data/?id={station_id}"
    text = fetch_text(url, timeout=30)
    if not text:
        log(f"Error fetching for {station_id}: Ingen data!")
        return
    lines = text.strip().splitlines()
    data_lines = []
    for l in lines:
        parts = l.split()
        if len(parts) >= 7 and parts[0].count('-') == 2 and len(parts[0]) == 10:
            data_lines.append(l)
    if not data_lines:
        log(f"{station_id}: No data lines found.")
        log(f"DEBUG: First 10 lines: {lines[:10]}")
        return
    conn = get_db()
    cur = conn.cursor()
    count = 0
    for line in data_lines:
        parts = line.split()
        # SKIPPA OGILTIGA (framtida) VÄRDEN!
        if any(p in ("99999.00", "-99999.00") for p in parts[3:7]):
            continue
        try:
            dt = parse_datetime(
                f"{parts[0]} {parts[1].split('.')[0]}",
                "%Y-%m-%d %H:%M:%S"
            )
            if dt is None:
                continue
            x = float(parts[3])
            y = float(parts[4])
            z = float(parts[5])
            value = float(parts[6])
        except Exception as e:
            log(f"{station_id} parse error: {e}")
            continue
        try:
            cur.execute(
                "INSERT IGNORE INTO magnetometer_global (station, timestamp, x, y, z, value) VALUES (%s, %s, %s, %s, %s, %s)",
                (station_id, dt, x, y, z, value)
            )
            count += 1
        except Exception as e:
            log(f"{station_id} SQL error: {e}")
    conn.commit()
    cur.close()
    conn.close()
    log(f"{station_id}: {count} datapoints stored.")

def fetch_and_store_all_usgs():
    ensure_table(CREATE_SQL)
    for station in USGS_STATIONS:
        fetch_and_store_usgs_station(station["id"])

if __name__ == "__main__":
    import time
    while True:
        log("Start fetch_magnetometer_global (USGS stations)")
        fetch_and_store_all_usgs()
        log("Done. Sleeping 1 min.")
        time.sleep(60)
