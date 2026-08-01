# /app/fetch_magnetometer_fmi.py

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_text

STATIONS = {
    "KEV": "https://space.fmi.fi/image/realtime/UT/KEV/KEVdata_01.txt",
    "MAS": "https://space.fmi.fi/image/realtime/UT/MAS/MASdata_01.txt",
    "KIL": "https://space.fmi.fi/image/realtime/UT/KIL/KILdata_01.txt",
    "IVA": "https://space.fmi.fi/image/realtime/UT/IVA/IVAdata_01.txt",
    "MUO": "https://space.fmi.fi/image/realtime/UT/MUO/MUOdata_01.txt",
    "SOD": "https://space.fmi.fi/image/realtime/UT/SOD/SODdata_01.txt",
    "PEL": "https://space.fmi.fi/image/realtime/UT/PEL/PELdata_01.txt",
    "RAN": "https://space.fmi.fi/image/realtime/UT/RAN/RANdata_01.txt",
    "OUJ": "https://space.fmi.fi/image/realtime/UT/OUJ/OUJdata_01.txt",
    "MEK": "https://space.fmi.fi/image/realtime/UT/MEK/MEKdata_01.txt",
    "HAN": "https://space.fmi.fi/image/realtime/UT/HAN/HANdata_01.txt",
    "NUR": "https://space.fmi.fi/image/realtime/UT/NUR/NURdata_01.txt",
    "TAR": "https://space.fmi.fi/image/realtime/UT/TAR/TARdata_01.txt"
}

# Use this dict to set minimum constant value per station to filter out (example: all x >= 86994.54 for SOD)
BAD_CONSTANTS_MIN = {
    "SOD": 86994.54,
    "MUO": 88411.31,
    "NUR": 32883.42,
}

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS magnetometer_fmi (
        station VARCHAR(10),
        timestamp DATETIME,
        x FLOAT,
        y FLOAT,
        z FLOAT,
        PRIMARY KEY (station, timestamp)
    )
"""

wait_for_db()

def fetch_and_store():
    ensure_table(CREATE_SQL)
    from utils import parse_datetime
    for station, url in STATIONS.items():
        log(f"Fetching {station}...")
        text = fetch_text(url, timeout=15)
        if not text:
            log(f"Error fetching for {station}: Ingen data!")
            continue

        lines = text.strip().splitlines()
        conn = get_db()
        cur = conn.cursor()
        count = 0
        last_xyz = None
        for line in lines:
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            parts = line.split()
            if len(parts) < 9:
                continue
            # Skip placeholder/invalid values (as in global/other fetchers)
            if any(p in ("99999.00", "-99999.00", "999999", "-999999") for p in parts[6:9]):
                continue
            # Skip "bad constant" values for this station (e.g. SOD x >= 86994.54)
            try:
                x_val = float(parts[6])
            except Exception:
                continue
            if station in BAD_CONSTANTS_MIN and x_val >= BAD_CONSTANTS_MIN[station]:
                continue
            try:
                dt = parse_datetime(" ".join(parts[:6]), "%Y %m %d %H %M %S")
                y = float(parts[7])
                z = float(parts[8])
                if dt is None:
                    continue
            except Exception:
                continue
            # Skip if identical to previous x/y/z value (avoids saving flatlines)
            if last_xyz == (x_val, y, z):
                continue
            last_xyz = (x_val, y, z)
            cur.execute(
                "INSERT IGNORE INTO magnetometer_fmi (station, timestamp, x, y, z) VALUES (%s, %s, %s, %s, %s)",
                (station, dt, x_val, y, z)
            )
            count += 1
        conn.commit()
        cur.close()
        conn.close()
        log(f"{station}: Stored {count} new datapoints.")

import time

if __name__ == "__main__":
    while True:
        log("Start fetching FMI magnetometer data")
        fetch_and_store()
        log("Done. Sleeping 1 min.")
        time.sleep(60)
