# ---- app/hp_fetch.py ----

from utils import nowstr, log, DB, get_db, wait_for_db, ensure_table, fetch_text

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS hp_index (
        timestamp DATETIME PRIMARY KEY,
        hp30 FLOAT,  ap30 INT,
        hp60 FLOAT,  ap60 INT
    )
"""

wait_for_db()

def parse_line(parts):
    yyyy, mm, dd, hh_h, *_ = parts
    hour = int(float(hh_h))
    minute = int((float(hh_h) % 1) * 60)
    from datetime import datetime
    return datetime(int(yyyy), int(mm), int(dd), hour, minute)

def fetch_and_store_hp(url, col_hp, col_ap):
    text = fetch_text(url, timeout=15)
    if not text:
        log(f"Error getting ({col_hp}): Ingen data!")
        return 0
    lines = [l for l in text.strip().splitlines() if not l.startswith("#") and l.strip()]

    conn = get_db()
    cur = conn.cursor()
    count = 0
    for line in lines:
        parts = line.split()
        if len(parts) < 9:
            continue
        timestamp = parse_line(parts)
        try:
            hp_f = float(parts[7])
            ap_i = int(parts[8])
            if hp_f == -1.0 or ap_i == -1:
                continue
        except Exception:
            continue
        try:
            cur.execute(
                f"INSERT INTO hp_index (timestamp, {col_hp}, {col_ap}) VALUES (%s, %s, %s) "
                f"ON DUPLICATE KEY UPDATE {col_hp} = VALUES({col_hp}), {col_ap} = VALUES({col_ap})",
                (timestamp, hp_f, ap_i)
            )
            count += 1
        except Exception as e:
            log(f"SQL-error ({col_hp}): {e}")
            continue
    conn.commit()
    cur.close()
    conn.close()
    log(f"{col_hp}: Saved {count} new lines.")
    return count

def fetch_and_store_all():
    ensure_table(CREATE_SQL)
    n1 = fetch_and_store_hp(
        "https://www-app3.gfz-potsdam.de/kp_index/Hp30_ap30_nowcast.txt", "hp30", "ap30"
    )
    n2 = fetch_and_store_hp(
        "https://www-app3.gfz-potsdam.de/kp_index/Hp60_ap60_nowcast.txt", "hp60", "ap60"
    )
    log(f"Total {n1} Hp30 and {n2} Hp60 values stored.")

if __name__ == "__main__":
    import time
    while True:
        log("Start fetching HP-data")
        fetch_and_store_all()
        log("Done. Sleeping 1 min.")
        time.sleep(60)
