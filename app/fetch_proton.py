# /app/fetch_proton.py

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_text
from datetime import datetime, timedelta
import requests

IRF_PROTON_URL = "https://www2.irf.se/cgi-bin/get-proton-data?{date}"  # date = YYYY/MM/DD

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS proton_data (
        timestamp INT PRIMARY KEY,
        datetime_utc DATETIME,
        proton_value INT
    )
"""

def fetch_proton(date=None):
    """Fetch proton data for given date (YYYY/MM/DD), else today UTC."""
    if date is None:
        date = datetime.utcnow().strftime("%Y/%m/%d")
    url = IRF_PROTON_URL.format(date=date)
    text = fetch_text(url, timeout=15)
    if not text:
        log(f"[PROTON] No data fetched for {date}")
        return []
    data = []
    for line in text.strip().splitlines():
        if not line.strip():
            continue
        try:
            ts_s, value_s = line.split()
            ts = int(ts_s)
            value = int(value_s)
            dt = datetime.utcfromtimestamp(ts)
            data.append({
                "timestamp": ts,
                "datetime_utc": dt.strftime("%Y-%m-%d %H:%M:%S"),
                "proton_value": value
            })
        except Exception:
            continue
    return data

def fetch_and_store():
    ensure_table(CREATE_SQL)
    all_rows = []
    dates = [
        datetime.utcnow().strftime("%Y/%m/%d"),
        (datetime.utcnow() - timedelta(days=1)).strftime("%Y/%m/%d"),
    ]
    # Hämta för idag och igår, så man alltid fyller luckor!
    for date in dates:
        rows = fetch_proton(date)
        all_rows.extend(rows)

    if not all_rows:
        log("[PROTON] No new data to store.")
        return

    conn = get_db()
    cur = conn.cursor()
    n_new = 0
    for row in all_rows:
        try:
            cur.execute(
                "INSERT IGNORE INTO proton_data (timestamp, datetime_utc, proton_value) VALUES (%s, %s, %s)",
                (row["timestamp"], row["datetime_utc"], row["proton_value"])
            )
            if cur.rowcount > 0:
                n_new += 1
        except Exception as e:
            log(f"[PROTON] DB error: {e}")
    conn.commit()
    cur.close()
    conn.close()

    log(f"[PROTON] Stored {n_new} new proton datapoints.")

if __name__ == "__main__":
    wait_for_db()
    while True:
        log("Start fetching IRF proton data...")
        fetch_and_store()
        log("Done. Sleeping 5 min.")
        import time
        time.sleep(300)
