import json
import math
import time
from collections import defaultdict
from datetime import datetime, timezone

from utils import ensure_table, fetch_json, fetch_text, get_db, log, wait_for_db

GRID_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
POWER_URL = "https://services.swpc.noaa.gov/text/aurora-nowcast-hemi-power.txt"

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS ovation_aurora (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ts VARCHAR(32),
        hemisphere_power FLOAT,
        hemisphere_power_north FLOAT,
        hemisphere_power_south FLOAT,
        avg_lat FLOAT,
        min_lat FLOAT,
        max_lat FLOAT,
        probs_json MEDIUMTEXT,
        probs_south_json MEDIUMTEXT
    ) CHARSET=utf8mb4
"""

CREATE_POWER_SQL = """
    CREATE TABLE IF NOT EXISTS ovation_power (
        ts CHAR(20) PRIMARY KEY,
        forecast_time CHAR(20) NOT NULL,
        north FLOAT,
        south FLOAT
    )
"""


def latest_power(text):
    latest = None
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) != 4 or line.startswith("#"):
            continue
        try:
            obs, forecast = (datetime.strptime(s, "%Y-%m-%d_%H:%M").strftime("%Y-%m-%dT%H:%M:%SZ")
                             for s in parts[:2])
            north, south = (None if s.lower() == "n/a" else float(s) for s in parts[2:])
        except ValueError:
            continue
        if not any(v is not None for v in (north, south)):
            continue
        if any(v is not None and (not math.isfinite(v) or v < 0) for v in (north, south)):
            continue
        if latest is None or obs >= latest[0]:
            latest = (obs, forecast, north, south)
    return latest


def store_grid(data):
    if not isinstance(data, dict) or not data.get("coordinates"):
        return
    try:
        observed = datetime.fromisoformat(data["Observation Time"].replace("Z", "+00:00"))
        if observed.tzinfo is None:
            raise ValueError("missing timezone")
        ts = observed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (KeyError, AttributeError, ValueError):
        log("OVATION grid has no valid observation time")
        return

    # Existing installations can contain duplicate timestamps. Serialize the
    # latest-row check with the insert without rewriting or indexing history.
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("SELECT GET_LOCK(CONCAT('ovation-grid-', DATABASE()), 5) AS acquired")
        if cur.fetchone()["acquired"] != 1:
            return
        try:
            cur.execute("SELECT ts FROM ovation_aurora ORDER BY id DESC LIMIT 1")
            last = cur.fetchone()
            if last and last["ts"] and last["ts"] >= ts:
                return
            grid = defaultdict(dict)
            for lon, lat, value in data["coordinates"]:
                grid[lat][lon] = value
            lats = sorted(grid)
            lons = sorted({lon for row in grid.values() for lon in row})
            payload = json.dumps([[grid[lat].get(lon, 0) for lon in lons] for lat in lats],
                                 separators=(",", ":"), allow_nan=False)
            north, south = data.get("HemPower_North"), data.get("HemPower_South")
            cur.execute("""
                INSERT INTO ovation_aurora
                    (ts, hemisphere_power, hemisphere_power_north, hemisphere_power_south,
                     min_lat, max_lat, probs_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (ts, north, north, south, lats[0], lats[-1], payload))
        finally:
            cur.execute("SELECT RELEASE_LOCK(CONCAT('ovation-grid-', DATABASE()))")


def fetch_and_store_power():
    row = latest_power(fetch_text(POWER_URL, timeout=10))
    if row is None:
        log("OVATION power feed has no usable observation")
        return
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO ovation_power (ts, forecast_time, north, south) VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE forecast_time = VALUES(forecast_time),
                north = COALESCE(VALUES(north), north), south = COALESCE(VALUES(south), south)
        """, row)


if __name__ == "__main__":
    wait_for_db()
    ensure_table(CREATE_SQL)
    ensure_table(CREATE_POWER_SQL)
    while True:
        try:
            store_grid(fetch_json(GRID_URL, timeout=10))
        except Exception as exc:
            log(f"OVATION grid update failed: {exc}")
        try:
            fetch_and_store_power()
        except Exception as exc:
            log(f"OVATION power update failed: {exc}")
        time.sleep(60)
