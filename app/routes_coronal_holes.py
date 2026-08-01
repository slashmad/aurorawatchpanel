# routes_coronal_holes.py

from fastapi import APIRouter, Query
from utils import get_db
from datetime import datetime, timezone, timedelta
from calendar import monthrange
from typing import List, Dict, Any, Optional
import math

router = APIRouter()

@router.get("/coronal_holes")
def list_coronal_holes(
    limit: int = Query(50, le=300),
    from_: str = Query(None, alias="from"),
    to: str = Query(None),
    carrington: int = Query(None)
):
    conn = get_db()
    c = conn.cursor()
    sql = "SELECT * FROM coronal_holes WHERE detected=1"
    params = []
    if from_:
        sql += " AND DATE(timestamp) >= %s"
        params.append(from_)
    if to:
        sql += " AND DATE(timestamp) <= %s"
        params.append(to)
    if carrington:
        sql += " AND carrington = %s"
        params.append(carrington)
    sql += " ORDER BY timestamp DESC LIMIT %s"
    params.append(limit)
    c.execute(sql, tuple(params))
    rows = c.fetchall()
    c.close()
    conn.close()
    return rows

@router.get("/coronal_hole_rotations")
def list_rotations():
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT DISTINCT carrington FROM coronal_holes WHERE detected=1 ORDER BY carrington DESC")
    rotations = [r["carrington"] for r in c.fetchall()]
    c.close()
    conn.close()
    return {"rotations": rotations}

@router.get("/coronal_holes/unique_best")
def unique_best(deg_limit: float = Query(60.0, ge=5.0, le=90.0), limit: int = Query(100, le=500)):
    """
    For each unique hole (mask_hash), pick the row with minimum ABS(lon_deg) as 'best frame'.
    Also compute earth_facing_start/end as the min/max timestamp where ABS(lon_deg) <= deg_limit.
    Returns full, unmodified SDO_193 filename for the best frame plus the calendar thumb you already store.
    """
    conn = get_db()
    c = conn.cursor()

    # 1) Find recent unique holes
    c.execute("""
        SELECT mask_hash
        FROM coronal_holes
        WHERE detected=1 AND mask_hash IS NOT NULL
        GROUP BY mask_hash
        ORDER BY MAX(timestamp) DESC
        LIMIT ?
    """, (limit,))
    hashes = [row["mask_hash"] for row in c.fetchall()]
    if not hashes:
        c.close(); conn.close()
        return {"items": []}

    # 2) For each hash, pick best frame and earth-facing window
    items = []
    for h in hashes:
        # Best frame (min |lon_deg|)
        c.execute("""
            SELECT *,
                   ABS(lon_deg) AS abs_lon
            FROM coronal_holes
            WHERE detected=1 AND mask_hash=?
                  AND lon_deg IS NOT NULL
            ORDER BY abs_lon ASC, timestamp DESC
            LIMIT 1
        """, (h,))
        best = c.fetchone()
        if not best:
            continue

        # Earth-facing interval within this hole's life
        # We consider all detections for this hash and pick min/max timestamp where |lon|<=deg_limit
        c.execute("""
            SELECT MIN(timestamp) AS start_ts, MAX(timestamp) AS end_ts
            FROM coronal_holes
            WHERE detected=1 AND mask_hash=?
                  AND lon_deg IS NOT NULL
                  AND ABS(lon_deg) <= ?
        """, (h, deg_limit))
        win = c.fetchone()
        earth_start = win["start_ts"]
        earth_end   = win["end_ts"]

        items.append({
            "mask_hash": h,
            "best_timestamp": best["timestamp"],
            "best_lon_deg": best["lon_deg"],
            # full unmodified image for display:
            "best_full_filename": best["filename"],   # you already store full SDO_193 here
            # keep your existing thumb for calendar tiles:
            "sdo_thumb": best.get("sdo_thumb") or best.get("processed_filename") or None,
            "earth_facing_start": earth_start,
            "earth_facing_end": earth_end,
            "carrington": best["carrington"],
        })

    c.close()
    conn.close()
    return {"deg_limit": deg_limit, "items": items}


@router.get("/coronal_holes/calendar")
def coronal_hole_calendar(month: str = None, tz: str = "UTC"):
    """
    Returns per-day summary for a given month.
    Query: month="YYYY-MM" (UTC). If not set, uses current UTC month.
    Response:
    {
      "month": "2025-10",
      "days": [
        {"date":"2025-10-04","count":3,"max_area":0.226,"rotations":[2302],
         "thumbs": ["/data/images/coronal-holes/2025/10/04/SDO_193_..._thumb.jpg", ...]}
      ]
    }
    """
    # Resolve month range (UTC)
    now_utc = datetime.now(timezone.utc)
    if month:
        try:
            y, m = map(int, month.split("-"))
            first_day = datetime(y, m, 1, tzinfo=timezone.utc)
        except Exception:
            return {"error": "Invalid month format. Use YYYY-MM"}
    else:
        first_day = datetime(now_utc.year, now_utc.month, 1, tzinfo=timezone.utc)

    _, ndays = monthrange(first_day.year, first_day.month)
    start_ts = first_day
    end_ts = datetime(first_day.year, first_day.month, ndays, 23, 59, 59, tzinfo=timezone.utc)

    conn = get_db()
    c = conn.cursor()

    # Per-day aggregates
    c.execute(
        """
        SELECT
            DATE(timestamp) AS d,
            COUNT(*) AS cnt,
            MAX(area_fraction) AS max_area,
            AVG(lon_deg) AS avg_lon_deg,
            MAX(preview) AS preview,
            GROUP_CONCAT(DISTINCT carrington ORDER BY carrington) AS rotations
        FROM coronal_holes
        WHERE detected=1 AND timestamp BETWEEN %s AND %s
        GROUP BY d
        ORDER BY d
        """,
        (start_ts, end_ts)
    )
    rows = c.fetchall()

    result = []
    for r in rows:
        d = r["d"].strftime("%Y-%m-%d")
        c.execute(
            """
            SELECT processed_filename
            FROM coronal_holes
            WHERE detected=1 AND DATE(timestamp)=%s AND processed_filename IS NOT NULL
            ORDER BY area_fraction DESC, timestamp DESC
            LIMIT 3
            """,
            (d,)
        )
        thumbs = []
        for t in c.fetchall():
            rel = t["processed_filename"]
            if rel:
                thumbs.append(f"/data/images/coronal-holes/{rel}")
        rotations = []
        if r["rotations"]:
            rotations = [int(x) for x in r["rotations"].split(",") if x.strip().isdigit()]
        result.append({
            "date": d,
            "count": int(r["cnt"]),
            "max_area": float(r["max_area"]) if r["max_area"] is not None else None,
            "avg_lon_deg": float(r["avg_lon_deg"]) if r["avg_lon_deg"] is not None else None,
            "preview": int(r["preview"]) if r["preview"] is not None else 0,
            "rotations": rotations,
            "thumbs": thumbs
        })
    month_str = f"{first_day.year:04d}-{first_day.month:02d}"
    return {"month": month_str, "days": result}

@router.get("/coronal_holes/grouped")
def list_grouped_holes(
    month: str = Query(None),
    tolerance_days: int = 2,
    tolerance_lon: float = 20.0,
    tolerance_area: float = 0.5,
    rotations: int = 6  # number of Carrington rotations to forecast
):
    """
    Groups coronal holes by proximity in time, longitude, and area.
    Query: month="YYYY-MM" (UTC). If not set, uses all available data.
    Response: {groups: [...], predictions: [...]}
    """

    # ---- helpers ----
    def to_utc(dt):
        """Return timezone-aware UTC datetime for comparisons/serialization."""
        if isinstance(dt, str):
            try:
                dt = datetime.strptime(dt, "%Y-%m-%d %H:%M:%S")
            except Exception:
                try:
                    dt = datetime.fromisoformat(dt)
                except Exception:
                    return datetime.now(timezone.utc)
        if isinstance(dt, datetime):
            return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)
        return datetime.now(timezone.utc)

    def iso(dt):
        return dt if isinstance(dt, str) else to_utc(dt).isoformat()

    now_utc = datetime.now(timezone.utc)

    # Optional month filter window (aware)
    if month:
        try:
            y, m = map(int, month.split("-"))
            first_day = datetime(y, m, 1, tzinfo=timezone.utc)
            _, ndays = monthrange(y, m)
            start_ts = first_day
            end_ts = datetime(y, m, ndays, 23, 59, 59, tzinfo=timezone.utc)
        except Exception:
            return {"error": "Invalid month format. Use YYYY-MM"}
    else:
        start_ts = None
        end_ts = None

    conn = get_db()
    c = conn.cursor()

    # ---------- Fetch detected holes ----------
    # KEY CHANGE: when month is provided, we look back far enough to allow predictions
    # from earlier groups to land in the requested month.
    rotation_period = 27.275  # days (synodic Carrington)
    lookback_days = int(math.ceil(rotation_period * max(1, rotations))) + 5  # padding

    sql = """
        SELECT id, timestamp, filename, processed_filename, area_fraction, lon_deg, carrington
        FROM coronal_holes
        WHERE detected = 1
    """
    params = []
    if start_ts and end_ts:
        # Look back N rotations so earlier groups can generate predictions in this month.
        sql += " AND timestamp BETWEEN %s AND %s"
        params.extend([start_ts - timedelta(days=lookback_days), end_ts + timedelta(days=5)])
    sql += " ORDER BY timestamp ASC"
    c.execute(sql, tuple(params))
    rows = c.fetchall()

    groups = []
    current_group = None

    # ---------- Grouping ----------
    for idx, r in enumerate(rows):
        hole_data = {
            "id": r["id"],
            "timestamp": to_utc(r["timestamp"]),
            "filename": r["filename"],
            "processed_filename": r["processed_filename"],
            "area_fraction": float(r["area_fraction"]) if r["area_fraction"] is not None else 0.0,
            "lon_deg": float(r["lon_deg"]) if r["lon_deg"] is not None else 0.0,
            "carrington": int(r["carrington"]) if r["carrington"] is not None else 0
        }

        if not groups:
            current_group = {
                "id": f"group_{hole_data['id']}",
                "start_timestamp": hole_data["timestamp"],
                "end_timestamp": hole_data["timestamp"],
                "carrington": hole_data["carrington"],
                "lon_deg": hole_data["lon_deg"],
                "area_fraction": hole_data["area_fraction"],
                "filenames": [hole_data["filename"]],
                "processed_filenames": [hole_data["processed_filename"]] if hole_data["processed_filename"] else [],
                "count": 1,
                "members": [{
                    "timestamp": hole_data["timestamp"],
                    "lon_deg": hole_data["lon_deg"],
                    "area_fraction": hole_data["area_fraction"],
                    "processed_filename": hole_data["processed_filename"],
                }],
            }
            groups.append(current_group)
        else:
            prev = rows[idx - 1]
            last_hole = {
                "timestamp": to_utc(prev["timestamp"]),
                "lon_deg": float(prev["lon_deg"]) if prev["lon_deg"] is not None else 0.0,
                "area_fraction": float(prev["area_fraction"]) if prev["area_fraction"] is not None else 0.0,
                "carrington": int(prev["carrington"]) if prev["carrington"] is not None else 0
            }
            time_diff = (hole_data["timestamp"] - last_hole["timestamp"]).days
            lon_diff = abs(hole_data["lon_deg"] - last_hole["lon_deg"])
            area_base = max(last_hole["area_fraction"], 0.0001)
            area_diff = abs(hole_data["area_fraction"] - last_hole["area_fraction"]) / area_base

            if (time_diff <= tolerance_days and
                lon_diff <= tolerance_lon and
                area_diff <= tolerance_area and
                hole_data["carrington"] == last_hole["carrington"]):
                current_group["end_timestamp"] = hole_data["timestamp"]
                current_group["lon_deg"] = (
                    current_group["lon_deg"] * current_group["count"] + hole_data["lon_deg"]
                ) / (current_group["count"] + 1)
                current_group["area_fraction"] = (
                    current_group["area_fraction"] * current_group["count"] + hole_data["area_fraction"]
                ) / (current_group["count"] + 1)
                current_group["filenames"].append(hole_data["filename"])
                if hole_data["processed_filename"]:
                    current_group["processed_filenames"].append(hole_data["processed_filename"])
                current_group["count"] += 1
                current_group.setdefault("members", []).append({
                    "timestamp": hole_data["timestamp"],
                    "lon_deg": hole_data["lon_deg"],
                    "area_fraction": hole_data["area_fraction"],
                    "processed_filename": hole_data["processed_filename"],
                })
            else:
                current_group = {
                    "id": f"group_{hole_data['id']}",
                    "start_timestamp": hole_data["timestamp"],
                    "end_timestamp": hole_data["timestamp"],
                    "carrington": hole_data["carrington"],
                    "lon_deg": hole_data["lon_deg"],
                    "area_fraction": hole_data["area_fraction"],
                    "filenames": [hole_data["filename"]],
                    "processed_filenames": [hole_data["processed_filename"]] if hole_data["processed_filename"] else [],
                    "count": 1,
                    "members": [{
                        "timestamp": hole_data["timestamp"],
                        "lon_deg": hole_data["lon_deg"],
                        "area_fraction": hole_data["area_fraction"],
                        "processed_filename": hole_data["processed_filename"],
                    }],
                }
                groups.append(current_group)

    # ---------- Predictions: strictly forward, month-aware, multi-rotation ----------
    decay_factor = 0.88       # per-rotation area decay
    min_area = 0.005          # drop predictions below this area

    predictions = []
    for g in groups:
        base_start = to_utc(g["start_timestamp"])
        base_end = to_utc(g["end_timestamp"])
        base_area = max(g["area_fraction"], 0.0)
        base_lon = g["lon_deg"]
        base_carr = g["carrington"]

        for r in range(1, max(1, rotations) + 1):
            start_pred = base_start + timedelta(days=rotation_period * r)
            end_pred = base_end + timedelta(days=rotation_period * r)

            if end_pred < now_utc:
                continue  # only future-like windows

            if start_ts and end_ts:
                # keep only those overlapping selected month
                if end_pred < start_ts or start_pred > end_ts:
                    continue

            area_pred = base_area * (decay_factor ** r)
            if area_pred < min_area:
                break

            predictions.append({
                "predicted": True,
                "rotation_index": r,
                "id": f"pred_{g['id']}_+{r}",
                "ref_group_id": g["id"],
                "ref_carrington": base_carr,
                "ref_start_date": iso(base_start)[:10],
                "start_timestamp": start_pred,
                "end_timestamp": end_pred,
                "carrington": base_carr + r,
                "lon_deg": base_lon,
                "area_fraction": area_pred,
                "ref_filename": g["filenames"][-1],
                "count": g["count"],
                "confidence": max(0.2, 1.0 - 0.12 * r),
            })

    predictions.sort(key=lambda p: p["start_timestamp"])

    c.close()
    conn.close()

    # ---------- best-centered thumb per group ----------
    def member_sort_key(m):
        earth_pref = 0 if (m.get("lon_deg") is not None and abs(m["lon_deg"]) <= 60.0) else 1
        abs_lon = abs(m["lon_deg"]) if m.get("lon_deg") is not None else 999.0
        area = m.get("area_fraction") or 0.0
        ts_num = to_utc(m.get("timestamp")).timestamp()
        return (earth_pref, abs_lon, -area, -ts_num)

    for g in groups:
        members = [m for m in (g.get("members") or []) if m.get("processed_filename")]
        best = sorted(members, key=member_sort_key)[:1]
        g["thumbs"] = [f"/data/images/coronal-holes/{best[0]['processed_filename']}"] if best else []
        g["start_timestamp"] = iso(g["start_timestamp"])
        g["end_timestamp"]   = iso(g["end_timestamp"])

    ref_by_id = {g["id"]: g for g in groups}
    for p in predictions:
        ref = ref_by_id.get(p["ref_group_id"])
        p["ref_thumb"] = (ref["thumbs"][-1] if ref and ref.get("thumbs") else None)
        p["start_timestamp"] = iso(p["start_timestamp"])
        p["end_timestamp"]   = iso(p["end_timestamp"])

    return {"groups": groups, "predictions": predictions}


@router.get("/coronal_holes/tracks")
def coronal_hole_tracks(
    deg_limit: float = Query(60.0, ge=5.0, le=90.0),
    lat_band_deg: int = Query(5, ge=2, le=20),
    max_rotation_gap: int = Query(2, ge=1, le=5),
    max_items: int = Query(500, ge=50, le=5000)
):
    """
    Build multi-rotation tracks by:
    1) picking the 'best frame' per Carrington rotation (min ABS(lon_deg)),
    2) grouping those by latitude band,
    3) linking consecutive rotations within a small gap (e.g., +1 .. +max_rotation_gap).

    Returns tracks with:
      - members: (carrington, timestamp, filename, processed_filename, lon_deg, lat_deg)
      - best_full_filename per member (the unmodified SDO 193 file)
      - earth_facing_start/end per member's rotation (ABS(lon_deg) <= deg_limit)
      - track 'lat_band'
    """
    conn = get_db()
    c = conn.cursor()

    # 1) Best frame per rotation
    c.execute(f"""
        SELECT t.carrington, t.timestamp, t.filename, t.processed_filename, t.lon_deg, t.lat_deg
        FROM (
            SELECT carrington,
                   timestamp,
                   filename,
                   processed_filename,
                   lon_deg,
                   lat_deg,
                   ABS(lon_deg) AS abs_lon,
                   ROW_NUMBER() OVER (PARTITION BY carrington ORDER BY ABS(lon_deg) ASC, timestamp DESC) AS rn
            FROM coronal_holes
            WHERE detected = 1
              AND lon_deg IS NOT NULL
              AND lat_deg IS NOT NULL
        ) AS t
        WHERE t.rn = 1
        ORDER BY t.carrington DESC
        LIMIT %s
    """, (max_items,))
    best_rows = c.fetchall()
    if not best_rows:
        c.close(); conn.close()
        return {"deg_limit": deg_limit, "tracks": []}

    # 2) Compute earth-facing window per rotation (min/max timestamp within +/- deg_limit)
    rotations = sorted({row["carrington"] for row in best_rows})
    earth_win = {}
    for rot in rotations:
        c.execute("""
            SELECT MIN(timestamp) AS start_ts, MAX(timestamp) AS end_ts
            FROM coronal_holes
            WHERE detected = 1
              AND carrington = %s
              AND lon_deg IS NOT NULL
              AND ABS(lon_deg) <= %s
        """, (rot, deg_limit))
        w = c.fetchone()
        earth_win[rot] = (w["start_ts"], w["end_ts"])

    # 3) Bucket by latitude band and sort ascending by rotation
    def band(lat):
        # round to nearest band center (e.g., 5 deg bands)
        return int(round(lat / float(lat_band_deg)) * lat_band_deg)

    buckets = {}
    for r in best_rows:
        b = band(r["lat_deg"])
        buckets.setdefault(b, []).append(r)

    for b in buckets:
        buckets[b].sort(key=lambda x: x["carrington"])

    # 4) Build tracks within each bucket by linking near-consecutive rotations
    tracks = []
    for b, rows in buckets.items():
        current = []
        last_rot = None
        for r in rows:
            rot = r["carrington"]
            if not current:
                current = [r]
                last_rot = rot
                continue
            gap = rot - last_rot
            if 1 <= gap <= max_rotation_gap:
                current.append(r)
                last_rot = rot
            else:
                if len(current) >= 2:
                    tracks.append({"lat_band": b, "members": current})
                current = [r]
                last_rot = rot
        if current and len(current) >= 2:
            tracks.append({"lat_band": b, "members": current})

    # 5) Enrich members with earth-facing windows
    for t in tracks:
        for m in t["members"]:
            start_ts, end_ts = earth_win.get(m["carrington"], (None, None))
            m["earth_facing_start"] = start_ts
            m["earth_facing_end"] = end_ts
            # explicitly name the full unmodified image for clarity
            m["best_full_filename"] = m["filename"]
            m["thumb"] = m["processed_filename"]

    c.close()
    conn.close()
    # Order tracks by most recent member timestamp desc
    tracks.sort(key=lambda T: T["members"][-1]["timestamp"], reverse=True)
    return {
        "deg_limit": deg_limit,
        "lat_band_deg": lat_band_deg,
        "max_rotation_gap": max_rotation_gap,
        "tracks": tracks
    }
