# ---- app/fetch_solarwind.py ----

from datetime import datetime, timezone
import time

from utils import (
    log,
    get_db,
    wait_for_db,
    ensure_table,
    fetch_json,
)

CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS solarwind (
        timestamp DATETIME PRIMARY KEY,
        speed FLOAT,
        density FLOAT,
        bt FLOAT,
        bz FLOAT,
        `by` FLOAT
    )
"""

WIND_URL = (
    "https://services.swpc.noaa.gov/json/rtsw/"
    "rtsw_wind_1m.json"
)

MAG_URL = (
    "https://services.swpc.noaa.gov/json/rtsw/"
    "rtsw_mag_1m.json"
)

wait_for_db()


def parse_noaa_timestamp(value):
    """
    Parse NOAA timestamps such as:

        2026-07-31T17:40:00Z
        2026-07-31T17:40:00.000Z

    Returns a timezone-aware UTC datetime.
    """

    if not isinstance(value, str):
        return None

    try:
        dt = datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )
    except ValueError:
        return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    return dt.astimezone(timezone.utc)


def is_active(row):
    """
    NOAA currently publishes active as a JSON boolean.

    String handling is retained defensively in case an upstream
    producer temporarily serializes it as text.
    """

    value = row.get("active")

    if value is True:
        return True

    if isinstance(value, str):
        return value.lower() == "true"

    return False


def index_active_rows(rows, product_name):
    """
    Build:

        {
            "2026-07-31T17:40:00Z": row,
            ...
        }

    Only NOAA's active source is selected. This reproduces the
    behavior of the removed solar-wind products.
    """

    result = {}
    duplicate_count = 0

    for row in rows:
        if not isinstance(row, dict):
            continue

        if not is_active(row):
            continue

        timestamp = row.get("time_tag")

        if not timestamp:
            continue

        if timestamp in result:
            duplicate_count += 1

        result[timestamp] = row

    if duplicate_count:
        log(
            f"Warning: {product_name} contained "
            f"{duplicate_count} duplicate active timestamps."
        )

    return result


def to_float(row, field):
    value = row.get(field)

    if value is None or value == "":
        return None

    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_and_store():
    ensure_table(CREATE_SQL)

    wind_data = fetch_json(WIND_URL, timeout=30)
    mag_data = fetch_json(MAG_URL, timeout=30)

    if not isinstance(wind_data, list):
        log(
            "Invalid RTSW wind response: expected a JSON list."
        )
        return

    if not isinstance(mag_data, list):
        log(
            "Invalid RTSW magnetometer response: "
            "expected a JSON list."
        )
        return

    wind_by_time = index_active_rows(
        wind_data,
        "RTSW wind",
    )

    mag_by_time = index_active_rows(
        mag_data,
        "RTSW magnetometer",
    )

    common_timestamps = sorted(
        wind_by_time.keys() & mag_by_time.keys()
    )

    if not common_timestamps:
        log(
            "No matching active RTSW timestamps. "
            f"wind={len(wind_by_time)}, "
            f"mag={len(mag_by_time)}"
        )
        return

    db_rows = []
    newest_timestamp = None
    invalid_count = 0

    for timestamp in common_timestamps:
        wind_row = wind_by_time[timestamp]
        mag_row = mag_by_time[timestamp]

        dt = parse_noaa_timestamp(timestamp)

        if dt is None:
            invalid_count += 1
            continue

        speed = to_float(
            wind_row,
            "proton_speed",
        )

        density = to_float(
            wind_row,
            "proton_density",
        )

        bt = to_float(
            mag_row,
            "bt",
        )

        bz = to_float(
            mag_row,
            "bz_gsm",
        )

        by = to_float(
            mag_row,
            "by_gsm",
        )

        values = (
            speed,
            density,
            bt,
            bz,
            by,
        )

        if any(value is None for value in values):
            invalid_count += 1
            continue

        if newest_timestamp is None or dt > newest_timestamp:
            newest_timestamp = dt

        # MariaDB DATETIME has no timezone information.
        # Store a naive datetime whose value is explicitly UTC.
        db_timestamp = dt.replace(tzinfo=None)

        db_rows.append(
            (
                db_timestamp,
                speed,
                density,
                bt,
                bz,
                by,
            )
        )

    if not db_rows:
        log(
            "RTSW responses contained no complete matching rows. "
            f"invalid={invalid_count}"
        )
        return

    conn = get_db()
    cur = conn.cursor()

    try:
        cur.executemany(
            """
            INSERT INTO solarwind (
                timestamp,
                speed,
                density,
                bt,
                bz,
                `by`
            )
            VALUES (
                %s,
                %s,
                %s,
                %s,
                %s,
                %s
            )
            ON DUPLICATE KEY UPDATE
                speed = VALUES(speed),
                density = VALUES(density),
                bt = VALUES(bt),
                bz = VALUES(bz),
                `by` = VALUES(`by`)
            """,
            db_rows,
        )

        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        cur.close()
        conn.close()

    log(
        f"Merged {len(db_rows)} RTSW rows. "
        f"invalid={invalid_count}."
    )

    if newest_timestamp is not None:
        age_seconds = (
            datetime.now(timezone.utc) - newest_timestamp
        ).total_seconds()

        if age_seconds > 600:
            log(
                "Warning: newest complete RTSW measurement is "
                f"{age_seconds / 60:.1f} minutes old: "
                f"{newest_timestamp.isoformat()}"
            )


if __name__ == "__main__":
    while True:
        try:
            fetch_and_store()
        except Exception as exc:
            log(
                "Unhandled solar-wind fetch error: "
                f"{type(exc).__name__}: {exc}"
            )

        time.sleep(60)