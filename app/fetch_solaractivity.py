# ---- app/fetch_solaractivity.py ----

from utils import log, DB, get_db, wait_for_db, ensure_table, fetch_json
from datetime import datetime
import hashlib
import time

# ---- 1. Skapa tabeller vid behov ----

CREATE_EVENTS_SQL = """
CREATE TABLE IF NOT EXISTS solar_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(32),
    event_type VARCHAR(32),
    class VARCHAR(8),
    region VARCHAR(8),
    location VARCHAR(16),
    begin_time DATETIME,
    peak_time DATETIME,
    end_time DATETIME,
    peak_flux VARCHAR(16),
    comments TEXT,
    inserted_at DATETIME,
    UNIQUE KEY uniq_event (event_id)
) CHARSET=utf8mb4
"""

CREATE_REGIONS_SQL = """
CREATE TABLE IF NOT EXISTS solar_regions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    region_num VARCHAR(16),
    date DATE,
    location VARCHAR(16),
    area VARCHAR(8),
    latitude VARCHAR(16),
    longitude VARCHAR(16),
    carrington_longitude VARCHAR(16),
    spot_class VARCHAR(16),
    extent VARCHAR(16),
    number_spots VARCHAR(8),
    mag_class VARCHAR(16),
    mag_string VARCHAR(16),
    status VARCHAR(16),
    c_xray_events VARCHAR(8),
    m_xray_events VARCHAR(8),
    x_xray_events VARCHAR(8),
    proton_events VARCHAR(8),
    s_flares VARCHAR(8),
    impulse_flares_1 VARCHAR(8),
    impulse_flares_2 VARCHAR(8),
    impulse_flares_3 VARCHAR(8),
    impulse_flares_4 VARCHAR(8),
    protons VARCHAR(8),
    c_flare_probability VARCHAR(8),
    m_flare_probability VARCHAR(8),
    x_flare_probability VARCHAR(8),
    proton_probability VARCHAR(8),
    first_date VARCHAR(16),
    inserted_at DATETIME,
    UNIQUE KEY uniq_region (region_num, date)
) CHARSET=utf8mb4
"""

wait_for_db()
ensure_table(CREATE_EVENTS_SQL)
ensure_table(CREATE_REGIONS_SQL)

def parse_time(val):
    if not val:
        return None
    try:
        return datetime.strptime(val.replace('Z', ''), "%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None

def get_event_id(ev):
    # Bygg unikt ID av tid, typ, region, location
    raw = f"{ev.get('begin_datetime','')}_{ev.get('type','')}_{ev.get('region','')}_{ev.get('location','')}"
    return hashlib.md5(raw.encode()).hexdigest()

def fetch_and_store_events():
    url = "https://services.swpc.noaa.gov/json/edited_events.json"
    data = fetch_json(url, timeout=20)
    if not data or not isinstance(data, list):
        log("solar_events: No data or wrong format!")
        return 0

    conn = get_db()
    c = conn.cursor()
    count = 0
    nowstr = datetime.utcnow()
    for ev in data:
        event_id = get_event_id(ev)
        c.execute("""
            INSERT IGNORE INTO solar_events
            (event_id, event_type, class, region, location, begin_time, peak_time, end_time, peak_flux,
             observatory, frequency, quality, obsid, particulars1, particulars2, particulars3, particulars4, particulars5,
             particulars6, particulars7, particulars8, particulars9, particulars10, coded_type, bin, status_code, status_text,
             change_flag, comments, inserted_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            event_id,
            ev.get('type'),
            ev.get('particulars4') or None,  # (eller ev.get('particulars1') beroende på din frontend)
            str(ev.get('region')) if ev.get('region') else None,
            ev.get('location'),
            parse_time(ev.get('begin_datetime')),
            parse_time(ev.get('max_datetime')),
            parse_time(ev.get('end_datetime')),
            ev.get('particulars10') or None,
            # ---- nya kolumner ----
            ev.get('observatory'),
            ev.get('frequency'),
            ev.get('quality'),
            str(ev.get('obsid')) if ev.get('obsid') is not None else None,
            ev.get('particulars1'),
            ev.get('particulars2'),
            ev.get('particulars3'),
            ev.get('particulars4'),
            ev.get('particulars5'),
            ev.get('particulars6'),
            ev.get('particulars7'),
            ev.get('particulars8'),
            ev.get('particulars9'),
            ev.get('particulars10'),
            str(ev.get('coded_type')) if ev.get('coded_type') is not None else None,
            str(ev.get('bin')) if ev.get('bin') is not None else None,
            str(ev.get('status_code')) if ev.get('status_code') is not None else None,
            ev.get('status_text'),
            str(ev.get('change_flag')) if ev.get('change_flag') is not None else None,
            '',  # comments
            nowstr
        ))
        if c.rowcount > 0:
            count += 1
    conn.commit()
    c.close()
    conn.close()
    if count > 0:
        log(f"solar_events: Saved {count} new events.")

def fetch_and_store_regions():
    url = "https://services.swpc.noaa.gov/json/solar_regions.json"
    data = fetch_json(url, timeout=15)
    if not data or not isinstance(data, list):
        log("solar_regions: No data or wrong format!")
        return 0

    conn = get_db()
    c = conn.cursor()
    count = 0
    nowstr = datetime.utcnow()
    for reg in data:
        try:
            c.execute("""
              INSERT IGNORE INTO solar_regions
              (region_num, date, location, area, latitude, longitude, carrington_longitude, old_carrington_longitude, spot_class, extent, number_spots, mag_class, mag_string, status, c_xray_events, m_xray_events, x_xray_events, proton_events, s_flares, impulse_flares_1, impulse_flares_2, impulse_flares_3, impulse_flares_4, protons, c_flare_probability, m_flare_probability, x_flare_probability, proton_probability, first_date, inserted_at)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                reg.get('region'),
                reg.get('observed_date'),
                reg.get('location'),
                reg.get('area'),
                reg.get('latitude'),
                reg.get('longitude'),
                reg.get('carrington_longitude'),
                reg.get('old_carrington_longitude'),
                reg.get('spot_class'),
                reg.get('extent'),
                reg.get('number_spots'),
                reg.get('mag_class'),
                reg.get('mag_string'),
                reg.get('status'),
                reg.get('c_xray_events'),
                reg.get('m_xray_events'),
                reg.get('x_xray_events'),
                reg.get('proton_events'),
                reg.get('s_flares'),
                reg.get('impulse_flares_1'),
                reg.get('impulse_flares_2'),
                reg.get('impulse_flares_3'),
                reg.get('impulse_flares_4'),
                reg.get('protons'),
                reg.get('c_flare_probability'),
                reg.get('m_flare_probability'),
                reg.get('x_flare_probability'),
                reg.get('proton_probability'),
                reg.get('first_date'),
                nowstr
            ))
            if c.rowcount > 0:
                count += 1
        except Exception as e:
            log(f"solar_regions SQL error: {e}")
    conn.commit()
    c.close()
    conn.close()
    if count > 0:
        log(f"solar_regions: Saved {count} new regions.")

if __name__ == "__main__":
    while True:
        try:
            fetch_and_store_events()
            fetch_and_store_regions()
        except Exception as e:
            log(f"solaractivity: FEL: {e}")
        log("solaractivity: Sleep 5 min...")
        time.sleep(300)  # 5 minuter
