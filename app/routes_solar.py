# app/routes_solar.py

from fastapi import APIRouter, Request, Query
from utils import get_db
from datetime import datetime, timedelta

router = APIRouter()

@router.get("/events")
def get_solar_events(
    event_type: str = Query(None, description="Filtrera på event_type, t.ex. X-ray, Proton, Radio"),
    region: str = Query(None, description="Filtrera på region-id"),
    after: str = Query(None, description="Visa events efter detta datum (ISO-format)"),
    limit: int = Query(20, description="Max antal event", le=500)
):
    conn = get_db()
    c = conn.cursor()
    query = "SELECT * FROM solar_events WHERE 1=1"
    params = []
    if event_type:
        query += " AND event_type=%s"
        params.append(event_type)
    if region:
        query += " AND region=%s"
        params.append(region)
    if after:
        query += " AND begin_time >= %s"
        params.append(after)
    query += " ORDER BY begin_time DESC LIMIT %s"
    params.append(limit)
    c.execute(query, tuple(params))
    res = c.fetchall()
    c.close()
    conn.close()
    # Konvertera datatider till strängar för JSON
    for row in res:
        for k in ['begin_time', 'peak_time', 'end_time', 'inserted_at']:
            if k in row and isinstance(row[k], datetime):
                row[k] = row[k].isoformat()
    return res

@router.get("/regions")
def get_solar_regions(
    date: str = Query(None, description="Visa regioner för visst datum (YYYY-MM-DD)"),
    limit: int = Query(20, description="Max antal regioner", le=100)
):
    conn = get_db()
    c = conn.cursor()
    query = "SELECT * FROM solar_regions WHERE 1=1"
    params = []
    if date:
        query += " AND date=%s"
        params.append(date)
    query += " ORDER BY date DESC, region_num ASC LIMIT %s"
    params.append(limit)
    c.execute(query, tuple(params))
    res = c.fetchall()
    c.close()
    conn.close()
    # Konvertera datatider till strängar för JSON
    for row in res:
        if 'inserted_at' in row and isinstance(row['inserted_at'], datetime):
            row['inserted_at'] = row['inserted_at'].isoformat()
    return res
