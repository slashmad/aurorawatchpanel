# ---- app/utils.py ----

import os
import sys
import time
from datetime import datetime

try:
    import pymysql
except ImportError:
    pass  # Så utils funkar även i script som inte har DB-beroende

# 1. Tidsstämpel/logg
def nowstr():
    """Returnera nuvarande lokal tid som sträng."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log(msg):
    print(f"[{nowstr()}] {msg}")

# 2. DB-config och koppling
DB = dict(
    host=os.getenv("DB_HOST", "mariadb"),
    port=int(os.getenv("DB_PORT", "3306")),
    user=os.getenv("DB_USER", "aurora"),
    password=os.getenv("DB_PASS", ""),
    database=os.getenv("DB_NAME", "aurora"),
    charset="utf8mb4",
    autocommit=True,
    cursorclass=pymysql.cursors.DictCursor if 'pymysql' in sys.modules else None
)

def get_db():
    if 'pymysql' not in sys.modules:
        raise ImportError("pymysql is required for DB access.")
    return pymysql.connect(**DB)

# 3. Vänta på DB
def wait_for_db(DB=DB, max_wait=60):
    if 'pymysql' not in sys.modules:
        return True
    for i in range(max_wait):
        try:
            conn = pymysql.connect(**DB)
            conn.close()
            log("DB is up!")
            return True
        except Exception as e:
            log(f"Waiting for DB ({i+1}/{max_wait}): {e}")
            time.sleep(2)
    log("DB is not available, exiting.")
    exit(1)

# 4. Generisk ensure_table
def ensure_table(create_sql, DB=DB):
    conn = get_db()
    with conn.cursor() as cur:
        cur.execute(create_sql)
    conn.close()

# 5. HTTP-hjälp
def fetch_json(url, timeout=15):
    import requests
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        log(f"Error fetching {url}: {e}")
        return None

def fetch_text(url, timeout=15):
    import requests
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        log(f"Error fetching {url}: {e}")
        return None

# 6. Trygga parsers
def safe_float(val):
    try:
        return float(val)
    except Exception:
        return None

def parse_datetime(s, fmt1, fmt2=None):
    try:
        return datetime.strptime(s, fmt1)
    except Exception:
        if fmt2:
            try:
                return datetime.strptime(s, fmt2)
            except Exception:
                return None
        return None
