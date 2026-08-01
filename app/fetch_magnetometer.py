# /app/fetch_magnetometer.py

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_text, parse_datetime
from datetime import datetime, timedelta
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

IRF_STATIONS = {
    "KIR": "https://www2.irf.se/maggraphs/rt_iaga_last_hour_secondary.txt",
    "TOP": "https://www2.irf.se/mag/tormestorp/iaga2002/{YYYY}/{MM}/top{YYYY}{MM}{DD}qsec.sec",
}

GIN_STATIONS = ["ABK", "LYC", "UPS"]

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS magnetometer (
        station VARCHAR(10),
        timestamp DATETIME,
        deflection FLOAT,
        kirx FLOAT,
        kiry FLOAT,
        kirz FLOAT,
        kirf FLOAT,
        PRIMARY KEY (station, timestamp)
    )
"""

KINDEX_TOP_URL = "https://www2.irf.se/mag/tormestorp/kindex_timestamp.txt"
KINDEX_KIR_URL = "https://www2.irf.se/maggraphs/preliminary_real_time_k_index_15_minutes_secondary"
# http://www2.irf.se/maggraphs/preliminary_real_time_k_index_secondary
CREATE_KINDEX_SQL = """
    CREATE TABLE IF NOT EXISTS magnetometer_kindex (
        station VARCHAR(10),
        timestamp DATETIME,
        k_index INT,
        PRIMARY KEY (station, timestamp)
    )
"""

GIN_URL = (
    "https://imag-data.bgs.ac.uk/GIN_V1/GINServices"
    "?request=GetData"
    "&format=iaga2002"
    "&observatoryIagaCode={CODE}"
    "&samplesPerDay=Minute"
    "&dataStartDate={START}"
    "&dataDuration={DUR}"
    "&publicationState=best-avail"
    "&orientation=XYZF"
    "&recordTermination=UNIX"
)

# TOP cutoff settings (data-safe)
TOP_OVERLAP_MINUTES = 10
TOP_DEFAULT_LOOKBACK_HOURS = 6

def _get_last_timestamp(station: str):
    """Return latest timestamp for station from DB, or None."""
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT MAX(timestamp) FROM magnetometer WHERE station=%s", (station,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        return row[0] if row and row[0] else None
    except Exception:
        return None

def _top_url_for_date(d):
    return IRF_STATIONS["TOP"].format(YYYY=d.strftime("%Y"), MM=d.strftime("%m"), DD=d.strftime("%d"))

def fetch_kir():
    """Fetch Kiruna data, which is already 1-min filtered."""
    text = fetch_text(IRF_STATIONS["KIR"], timeout=15)
    if not text:
        log("[KIR] No data fetched")
        return []
    data = []
    for line in text.strip().splitlines():
        if not line or line.startswith("#") or "|" in line:
            continue
        parts = line.split()
        if len(parts) < 7:
            continue
        date_s, time_s = parts[0], parts[1]
        try:
            dt = parse_datetime(f"{date_s} {time_s}", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S")
            kirx = float(parts[3])
            kiry = float(parts[4])
            kirz = float(parts[5])
            kirf = float(parts[6]) if parts[6] != "99999.00" else None
            data.append({
                "station": "KIR",
                "dt": dt,
                "kirx": kirx,
                "kiry": kiry,
                "kirz": kirz,
                "kirf": kirf,
            })
        except Exception:
            continue
    return data

def fetch_top():
    """Fetch Tormestorp data (1-second). Store max(|TOPH|) per minute with data-safe cutoff."""
    now = datetime.utcnow()

    last_ts = _get_last_timestamp("TOP")
    if last_ts:
        start_dt = last_ts - timedelta(minutes=TOP_OVERLAP_MINUTES)
    else:
        start_dt = now - timedelta(hours=TOP_DEFAULT_LOOKBACK_HOURS)

    # We break on minute granularity to ensure we don't cut a minute in half when reading backwards
    start_minute = start_dt.replace(second=0, microsecond=0)

    # Process daily files from start date to today to avoid midnight gaps
    d = start_minute.date()
    end_d = now.date()

    minute_max = {}
    total_parsed = 0

    while d <= end_d:
        url = _top_url_for_date(d)
        text = fetch_text(url, timeout=30)
        if not text:
            log(f"[TOP] No data fetched for {d.isoformat()}")
            d = d + timedelta(days=1)
            continue

        lines = text.splitlines()

        # For the first day, stop at start_minute; for intermediate days, keep whole day (00:00 cutoff)
        day_cutoff = start_minute if d == start_minute.date() else datetime(d.year, d.month, d.day, 0, 0, 0)

        # Read backwards so we can break early once we pass cutoff
        for line in reversed(lines):
            line = line.strip()
            if (not line) or line.startswith("#") or line[0].isalpha():
                continue

            parts = line.split()
            if len(parts) < 6:
                continue

            date_s, time_s, doy, toph, topd, topz = parts[:6]
            tstr = time_s.split(".")[0]
            try:
                dt = datetime.strptime(f"{date_s} {tstr}", "%Y-%m-%d %H:%M:%S")
            except Exception:
                continue

            if dt < day_cutoff:
                break

            min_key = dt.strftime("%Y-%m-%d %H:%M")
            try:
                val = abs(float(toph))
            except Exception:
                continue

            if (min_key not in minute_max) or (val > abs(minute_max[min_key]["kirx"])):
                minute_max[min_key] = {
                    "station": "TOP",
                    "dt": dt.replace(second=0, microsecond=0),
                    "kirx": float(toph),
                    "kiry": float(topd),
                    "kirz": float(topz),
                    "kirf": None,
                }
            total_parsed += 1

        d = d + timedelta(days=1)

    return list(minute_max.values())

def fetch_gin():
    """Fetch INTERMAGNET/GIN 1-minute XYZF for ABK/LYC/UPS (IAGA2002)."""
    now = datetime.utcnow()
    start = (now.date() - timedelta(days=1)).strftime("%Y-%m-%d")
    dur = 2  # Fetch yesterday+today to avoid midnight gaps / lag

    rows = []

    for code in GIN_STATIONS:
        url = GIN_URL.format(CODE=code, START=start, DUR=dur)
        text = fetch_text(url, timeout=30)
        if not text:
            log(f"[{code}] No data fetched (GIN)")
            continue

        for line in text.splitlines():
            if (not line) or line.startswith("#") or ("|" in line):
                continue

            parts = line.split()
            # Expected: DATE TIME DOY X Y Z F
            if len(parts) < 7:
                continue

            date_s, time_s = parts[0], parts[1]
            try:
                dt = parse_datetime(
                    f"{date_s} {time_s}",
                    "%Y-%m-%d %H:%M:%S.%f",
                    "%Y-%m-%d %H:%M:%S"
                )
                if dt is None:
                    continue

                x = float(parts[3])
                y = float(parts[4])
                z = float(parts[5])
                f = float(parts[6]) if parts[6] not in ("99999.00", "99999") else None

                # Sanity filter (keeps normal absolute field values, rejects obvious garbage)
                if any(v is not None and abs(v) > 70000 for v in (x, y, z, f)):
                    continue

                rows.append({
                    "station": code,
                    "dt": dt.replace(microsecond=0),
                    "kirx": x,
                    "kiry": y,
                    "kirz": z,
                    "kirf": f,
                })
            except Exception:
                continue

    return rows

def fetch_and_store():
    ensure_table(CREATE_SQL)
    all_rows = []
    station_counts = {}
    fetchers = [fetch_kir, fetch_top, fetch_gin]

    # Fetch in parallel so slow stations (e.g. TOP) do not block others (e.g. KIR)
    with ThreadPoolExecutor(max_workers=len(fetchers)) as pool:
        future_map = {pool.submit(f): f.__name__ for f in fetchers}
        for fut in as_completed(future_map):
            fetcher_name = future_map[fut]
            try:
                rows = fut.result()
            except Exception as e:
                print(f"[ERROR] {fetcher_name} failed: {e}")
                continue
            if not rows:
                continue
            all_rows.extend(rows)

    conn = get_db()
    cur = conn.cursor()
    for row in all_rows:
        try:
            cur.execute(
                "INSERT IGNORE INTO magnetometer (station, timestamp, deflection, kirx, kiry, kirz, kirf) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (row["station"], row["dt"], None, row["kirx"], row["kiry"], row["kirz"], row["kirf"])
            )
            # Count only successful inserts
            if cur.rowcount > 0:
                station = row["station"]
                station_counts[station] = station_counts.get(station, 0) + 1
        except Exception:
            continue
    conn.commit()
    cur.close()
    conn.close()

    # Skriv ut logg för varje station
    for station, n in station_counts.items():
        log(f"[{station}] Stored {n} new datapoints.")

def fetch_kindex_top():
    text = fetch_text(KINDEX_TOP_URL, timeout=10)
    if not text:
        log("[TOP-K] No K-index data")
        return []
    data = []
    cutoff = datetime.utcnow() - timedelta(days=3)
    lines = text.strip().splitlines()[::-1]  # Läs filen baklänges (nyaste först)
    for line in lines:
        if not line or ',' not in line:
            continue
        tstr, kstr = line.split(",", 1)
        try:
            dt = parse_datetime(tstr, "%Y-%m-%dT%H:%M:%S")
            if dt < cutoff:
                break  # När vi når en rad som är äldre än cutoff, stoppa
            kval = int(kstr)
            data.append({"station": "TOP", "dt": dt, "k_index": kval})
            if len(data) >= 24:  # MAXA till senaste 24 rader, du kan ändra detta
                break
        except Exception:
            continue
    return data


def fetch_kindex_kir():
    text = fetch_text(KINDEX_KIR_URL, timeout=10)
    if not text or not text.strip().isdigit():
        log("[KIR-K] No valid K-index")
        return []
    try:
        kval = int(text.strip())
        now = datetime.utcnow().replace(second=0, microsecond=0)
        return [{"station": "KIR", "dt": now, "k_index": kval}]
    except Exception:
        return []

def store_kindex():
    ensure_table(CREATE_KINDEX_SQL)
    conn = get_db()
    cur = conn.cursor()
    new_rows = 0
    for row in fetch_kindex_top() + fetch_kindex_kir():
        try:
            cur.execute(
                "INSERT IGNORE INTO magnetometer_kindex (station, timestamp, k_index) VALUES (%s, %s, %s)",
                (row["station"], row["dt"], row["k_index"])
            )
            if cur.rowcount > 0: new_rows += 1
        except Exception as e:
            log(f"K-index SQL error: {e} - row: {row}")
    conn.commit()
    cur.close()
    conn.close()
    if new_rows:
        log(f"Stored {new_rows} new K-index rows.")

if __name__ == "__main__":
    wait_for_db()
    while True:
        log("Start fetching IRF magnetometer data (KIR + TOP)")
        fetch_and_store()
        store_kindex()
        log("Done. Sleeping 1 min.")
        import time
        time.sleep(60)