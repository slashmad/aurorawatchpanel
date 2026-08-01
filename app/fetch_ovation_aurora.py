# ---- app/fetch_ovation_aurora.py ----

from utils import log, DB, get_db, wait_for_db, ensure_table, fetch_json
import json
from collections import defaultdict

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

wait_for_db()

def fetch_and_store_ovation():
    url = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
    data = fetch_json(url, timeout=10)
    if not data:
        log("OVATION ERROR: Kunde inte hämta eller parsa JSON!")
        return

    coords = data.get("coordinates")
    if not coords:
        log("OVATION ERROR: Ingen 'coordinates' i JSON!")
        log(str(data))
        return

    prob_grid = defaultdict(dict)
    min_lat, max_lat = 90, -90
    for lon, lat, aur in coords:
        prob_grid[lat][lon] = aur
        min_lat = min(min_lat, lat)
        max_lat = max(max_lat, lat)

    lat_list = sorted(prob_grid.keys())
    lon_list = sorted({lon for ldict in prob_grid.values() for lon in ldict.keys()})
    probs_2d = []
    for lat in lat_list:
        probs_2d.append([prob_grid[lat].get(lon, 0) for lon in lon_list])

    ts = data.get("Observation Time", "")
    hemisphere_power_north = data.get("HemPower_North")
    hemisphere_power_south = data.get("HemPower_South")
    avg_lat = None
    probs_json = json.dumps(probs_2d, separators=(",", ":"))
    probs_south_json = probs_json

    ensure_table(CREATE_SQL)
    conn = get_db()
    with conn:
        with conn.cursor() as c:
            c.execute(
                """INSERT INTO ovation_aurora (
                        ts, hemisphere_power, hemisphere_power_north, hemisphere_power_south,
                        avg_lat, min_lat, max_lat, probs_json, probs_south_json
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (ts, hemisphere_power_north, hemisphere_power_north, hemisphere_power_south,
                 avg_lat, min_lat, max_lat, probs_json, probs_south_json)
            )
    log(f"Ovation data lagrad {ts}, HP_N: {hemisphere_power_north}, HP_S: {hemisphere_power_south}, lat {min_lat}-{max_lat}")

if __name__ == "__main__":
    import time
    while True:
        fetch_and_store_ovation()
        time.sleep(60)