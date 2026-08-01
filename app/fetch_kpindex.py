# ---- app/fetch_kpindex.py ----

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_json, parse_datetime

wait_for_db()

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS kp_index (
        timestamp DATETIME PRIMARY KEY,
        kp INT
    )
"""

def fetch_and_store_kp():
    ensure_table(CREATE_SQL)
    url = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"
    data = fetch_json(url, timeout=10)
    if not data:
        log("Kp-index: network- or JSON-error.")
        return

    last = data[-1]
    ts = last["time_tag"]
    kp = int(last["kp_index"])

    dt = parse_datetime(ts, "%Y-%m-%d %H:%M:%S")
    if dt is None:
        dt = ts

    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT IGNORE INTO kp_index (timestamp, kp) VALUES (%s, %s)",
            (dt, kp)
        )
        log(f"Kp-index: New value {kp} at {dt}")
    except Exception as e:
        log(f"Kp-index: SQL-error: {e}")
    conn.commit()
    cur.close()
    conn.close()

if __name__ == "__main__":
    import time
    while True:
        fetch_and_store_kp()
        time.sleep(300)