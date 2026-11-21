# app/routes_skyfield.py

from fastapi import APIRouter, Request, Query, Body
from fastapi.responses import JSONResponse
from datetime import time, datetime, timedelta
import re

import numpy as np
import pytz
import requests
from skyfield.api import Star, load, Topos, EarthSatellite, wgs84, utc

from skyfield_astro import get_sun_info, get_moon_info, get_sun_moon_info, get_object_events

router = APIRouter()

PLANET_NAMES = {
    "Mercury": "mercury barycenter",
    "Venus": "venus barycenter",
    "Earth": "earth barycenter",
    "Mars": "mars barycenter",
    "Jupiter": "jupiter barycenter",
    "Saturn": "saturn barycenter",
    "Uranus": "uranus barycenter",
    "Neptune": "neptune barycenter",
    "Pluto": "pluto barycenter",
    "Moon": "moon",
    "Sun": "sun"
}

# Enklare katalog för några kända stjärnor
STAR_CATALOG = {
    "Sirius":  {"ra_hours": 6 + 45/60, "dec_degrees": -16.716},
    "Vega":    {"ra_hours": 18 + 36/60, "dec_degrees": 38.783},
    "Betelgeuse": {"ra_hours": 5 + 55/60, "dec_degrees": 7.407},
    "Rigel":      {"ra_hours": 5 + 14/60, "dec_degrees": -8.205},
    "Aldebaran":  {"ra_hours": 4 + 35/60, "dec_degrees": 16.509},
    # Lägg till fler stjärnor om du vill
}


def get_iss_tle():
    tle_url = "https://tle.ivanstanojevic.me/api/tle/25544"
    try:
        r = requests.get(tle_url, timeout=10)
        r.raise_for_status()
        tle_json = r.json()
        # SE TILL att det är .name, INTE .satelliteId!
        if "tle" in tle_json and all(k in tle_json["tle"] for k in ["name", "line1", "line2"]):
            iss_tle = [
                tle_json["tle"]["name"],    # ska vara str
                tle_json["tle"]["line1"],   # ska vara str
                tle_json["tle"]["line2"]    # ska vara str
            ]
            return iss_tle
    except Exception as e:
        print("TLE API fetch failed:", e)
    # Fallback: hårdkodat exempel
    return [
        "ISS (ZARYA)",
        "1 25544U 98067A   24149.25405359  .00003401  00000+0  65711-4 0  9994",
        "2 25544  51.6429 145.6048 0006910  84.9525  33.1766 15.49844849451406"
    ]

@router.get("/skyfield-astro")
async def skyfield_astro(lat: float, lon: float, tz: str = "Europe/Stockholm"):
    """
    Legacy endpoint: return both sun and moon data in a single JSON object.
    """
    try:
        data = get_sun_moon_info(lat=lat, lon=lon, tz_str=tz)
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@router.get("/sun")
async def sun_endpoint(lat: float, lon: float, tz: str = "Europe/Stockholm"):
    """
    Return only sun data (rise, set, max, and current alt/az).
    """
    try:
        data = get_sun_info(lat=lat, lon=lon, tz_str=tz)
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@router.get("/moon")
async def moon_endpoint(lat: float, lon: float, tz: str = "Europe/Stockholm"):
    """
    Return only moon data (rise, set, max, current alt/az, phase info).
    """
    try:
        data = get_moon_info(lat=lat, lon=lon, tz_str=tz)
        return data
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@router.get("/skyfield-altitudes")
async def skyfield_altitudes(
    lat: float,
    lon: float,
    tz: str = "Europe/Stockholm",
    step_min: int = 60
):
    """
    Return 24-hour sun & moon altitudes at given step (in minutes).
    """
    from skyfield_astro import get_sun_moon_altitudes_24h
    return get_sun_moon_altitudes_24h(lat, lon, tz, step_min)

@router.get("/batch")
async def astro_batch(
    names: str = Query(..., description="Komma-separerad lista, t.ex. Venus,Mars,Jupiter,Sirius"),
    lat: float = Query(63.9),
    lon: float = Query(20.5),
    tz: str = Query("Europe/Stockholm")
):
    """
    Batchar objekt-höjd, samt stödjer ISS och meteoritregn.
    name-listan kan innehålla planeter, stjärnor (från katalog), Messier, 'ISS', 'Perseids', 'Geminids', etc.
    """
    results = {}
    ts = load.timescale()
    eph = load('de421.bsp')
    observer = eph['earth'] + Topos(latitude_degrees=lat, longitude_degrees=lon)
    tzinfo = pytz.timezone(tz)
    today = datetime.now(tzinfo).date()
    times_template = []
    for minute in range(0, 1440, 60):
        t = datetime.combine(today, time(0, 0)) + timedelta(minutes=minute)
        times_template.append(t.strftime("%H:%M"))
    n_times = len(times_template)

    for name in [n.strip() for n in names.split(",")]:
        # Meteorshower
        if name.lower() in ["perseids", "geminids"]:
            try:
                radiant = {
                    "perseids": {"ra_hours": 48/15, "dec_degrees": 58},
                    "geminids": {"ra_hours": 112.25/15, "dec_degrees": 32}
                }[name.lower()]
                radiant_star = Star(ra_hours=radiant["ra_hours"], dec_degrees=radiant["dec_degrees"])
                altitudes = []
                azimuths = []
                for t_str in times_template:
                    h, m = map(int, t_str.split(":"))
                    t = datetime.combine(today, time(hour=h, minute=m))
                    t = tzinfo.localize(t)
                    tt = ts.from_datetime(t.astimezone(pytz.utc))
                    diff = observer.at(tt).observe(radiant_star)
                    alt, az, _ = diff.apparent().altaz()
                    altitudes.append(round(alt.degrees, 1))
                    azimuths.append(round(az.degrees, 1))
                results[name] = {
                    "altitudes": altitudes,
                    "azimuths": azimuths,
                    "times": times_template,
                }
            except Exception as e:
                results[name] = {"error": str(e)}

        # ISS
        elif name.lower() == "iss":
            try:
                iss_tle = get_iss_tle()
                if not iss_tle or len(iss_tle) < 3:
                    results[name] = {"error": "No TLE found"}
                    continue
                satellite = EarthSatellite(iss_tle[1], iss_tle[2], iss_tle[0], ts)
                altitudes = []
                azimuths = []
                # Loopa över alla tider i "times_template"
                for t_str in times_template:
                    h, m = map(int, t_str.split(":"))
                    t = datetime.combine(today, time(hour=h, minute=m))
                    t = tzinfo.localize(t)
                    tt = ts.from_datetime(t.astimezone(pytz.utc))
                    difference = satellite.at(tt) - observer.topos
                    alt, az, distance = difference.altaz()
                    # Sätt altitud till None om ISS är under horisonten (alt < 0)
                    if alt.degrees < 0:
                        altitudes.append(None)
                        azimuths.append(None)
                    else:
                        altitudes.append(round(alt.degrees, 1))
                        azimuths.append(round(az.degrees, 1))
                results[name] = {
                    "altitudes": altitudes,
                    "azimuths": azimuths,
                    "times": times_template,
                }
            except Exception as e:
                results[name] = {"error": str(e)}

        # Deep sky / planet / stjärna / Messier
        else:
            try:
                obj_name = name.strip()
                obj = None
                label = obj_name
                # PLANET_NAMES och STAR_CATALOG hämtas från din main.py!
                body_name = PLANET_NAMES.get(obj_name.capitalize())
                if body_name and body_name in eph:
                    obj = eph[body_name]
                elif obj_name in STAR_CATALOG:
                    star = STAR_CATALOG[obj_name]
                    obj = Star(ra_hours=star["ra_hours"], dec_degrees=star["dec_degrees"])
                elif re.match(r'^M\d{1,3}$', obj_name.upper()):
                    M_CATALOG = {
                        "M31": {"ra_hours": 0 + 42/60, "dec_degrees": 41 + 16/60},   # Andromeda
                        "M42": {"ra_hours": 5 + 35/60, "dec_degrees": -5.45},        # Orion Nebula
                        "M45": {"ra_hours": 3 + 47/60, "dec_degrees": 24 + 7/60},    # Pleiades
                    }
                    m = obj_name.upper()
                    if m in M_CATALOG:
                        d = M_CATALOG[m]
                        obj = Star(ra_hours=d["ra_hours"], dec_degrees=d["dec_degrees"])
                elif "RA=" in obj_name.upper():
                    m = re.match(r'RA\s*=\s*([0-9\.]+)[, ]+DEC\s*=\s*([\-0-9\.]+)', obj_name, re.I)
                    if m:
                        ra = float(m.group(1))
                        dec = float(m.group(2))
                        obj = Star(ra_hours=ra, dec_degrees=dec)
                if obj is None:
                    results[name] = {"error": "Object not found"}
                    continue
                times = []
                altitudes = []
                azimuths = []
                for t_str in times_template:
                    h, m = map(int, t_str.split(":"))
                    t = datetime.combine(today, time(hour=h, minute=m))
                    t = tzinfo.localize(t)
                    tt = ts.from_datetime(t.astimezone(pytz.utc))
                    diff = observer.at(tt).observe(obj)
                    app = diff.apparent()
                    alt, az, dist = app.altaz()
                    altitudes.append(round(alt.degrees, 1))
                    azimuths.append(round(az.degrees, 1))
                results[name] = {
                    "altitudes": altitudes,
                    "azimuths": azimuths,
                    "times": times_template,
                    "label": label
                }
            except Exception as e:
                results[name] = {"error": str(e)}
    return results

@router.get("/azimuth-batch")
async def azimuth_batch(
    names: str = Query(..., description="Komma-separerad lista t.ex. Sun,Moon,Venus,Mars,Jupiter,Perseids,Geminids"),
    lat: float = Query(...),
    lon: float = Query(...),
    tz: str = Query("Europe/Stockholm")
):
    """
    Returnerar EXAKT de fält azimuth_map.js behöver för overlay/tider, robust och snabb.
    Nu även stöd för meteorregn (Perseids, Geminids, m.fl.).
    """
    results = {}
    ts = load.timescale()
    eph = load('de421.bsp')
    earth = eph['earth']
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    observer = earth + topos
    tzinfo = pytz.timezone(tz)
    now = datetime.now(tzinfo)
    t0 = ts.utc(now.year, now.month, now.day)
    t1 = ts.utc(now.year, now.month, now.day + 1)

    # Alla meteorregn du vill ha stöd för
    meteor_showers = {
        "perseids":      {"ra_hours": 48/15,      "dec_degrees": 58},
        "geminids":      {"ra_hours": 112.25/15,  "dec_degrees": 32},
        "quadrantids":   {"ra_hours": 230/15,     "dec_degrees": 49},
        "lyrids":        {"ra_hours": 272.5/15,   "dec_degrees": 33},
        "eta-aquariids": {"ra_hours": 338/15,     "dec_degrees": -1},
        "orionids":      {"ra_hours": 95/15,      "dec_degrees": 16},
        "leonids":       {"ra_hours": 152/15,     "dec_degrees": 22},
        "ursids":        {"ra_hours": 217/15,     "dec_degrees": 76},
    }

    for name in [n.strip() for n in names.split(",")]:
        # ISS
        if name.upper() == "ISS":
            try:
                results["ISS"] = get_iss_events(lat, lon, tz)
            except Exception as e:
                results["ISS"] = {k: "-" for k in ["rise", "riseAz", "set", "setAz", "max", "maxAz", "maxAlt", "nowAz", "nowAlt"]}
            continue

        # SUN
        if name.lower() == "sun":
            try:
                sun = get_sun_info(lat=lat, lon=lon, tz_str=tz)
                results["Sun"] = {
                    "rise": sun.get("sunrise", "-"),
                    "riseAz": sun.get("sunrise_azimuth", "-"),
                    "set": sun.get("sunset", "-"),
                    "setAz": sun.get("sunset_azimuth", "-"),
                    "max": sun.get("sun_max_time", "-"),
                    "maxAz": sun.get("sun_max_azimuth", "-"),
                    "maxAlt": sun.get("sun_max_altitude", "-"),
                    "nowAz": sun.get("sun_azimuth", "-"),
                    "nowAlt": sun.get("sun_altitude", "-"),
                }
            except Exception as e:
                results["Sun"] = {"error": str(e)}
            continue

        # MOON
        if name.lower() == "moon":
            try:
                moon = get_moon_info(lat=lat, lon=lon, tz_str=tz)
                results["Moon"] = {
                    "rise": moon.get("moonrise", "-"),
                    "riseAz": moon.get("moonrise_azimuth", "-"),
                    "set": moon.get("moonset", "-"),
                    "setAz": moon.get("moonset_azimuth", "-"),
                    "max": moon.get("moon_max_time", "-"),
                    "maxAz": moon.get("moon_max_azimuth", "-"),
                    "maxAlt": moon.get("moon_max_altitude", "-"),
                    "nowAz": moon.get("moon_azimuth", "-"),
                    "nowAlt": moon.get("moon_altitude", "-"),
                }
            except Exception as e:
                results["Moon"] = {"error": str(e)}
            continue

        # METEORREGN
        if name.lower() in meteor_showers:
            try:
                radiant = meteor_showers[name.lower()]
                radiant_star = Star(ra_hours=radiant["ra_hours"], dec_degrees=radiant["dec_degrees"])
                max_alt = -90.0
                max_time = "-"
                max_az = "-"
                now_az = "-"
                now_alt = "-"
                for minute in range(0, 1440, 20):  # 20-min steglängd för maxhöjd
                    t = datetime.combine(now.date(), time(0, 0)) + timedelta(minutes=minute)
                    t = tzinfo.localize(t)
                    tt = ts.from_datetime(t.astimezone(pytz.utc))
                    diff = observer.at(tt).observe(radiant_star)
                    alt, az, _ = diff.apparent().altaz()
                    if alt.degrees > max_alt:
                        max_alt = alt.degrees
                        max_time = t.strftime("%H:%M")
                        max_az = round(az.degrees, 1)
                # Nuvarande position
                t_now = ts.from_datetime(now.astimezone(pytz.utc))
                app_now = observer.at(t_now).observe(radiant_star)
                alt_now, az_now, _ = app_now.apparent().altaz()
                now_az = round(az_now.degrees, 1)
                now_alt = round(alt_now.degrees, 1)
                results[name] = {
                    "rise": "-",
                    "riseAz": "-",
                    "set": "-",
                    "setAz": "-",
                    "max": max_time,
                    "maxAz": max_az,
                    "maxAlt": round(max_alt, 1),
                    "nowAz": now_az,
                    "nowAlt": now_alt,
                }
            except Exception as e:
                results[name] = {"error": str(e)}
            continue

        # PLANETER, STJÄRNOR, m.m.
        try:
            # Anropa get_object_events från skyfield_astro.py (planeter, stjärnor, ISS)
            obj_body = None
            label = name
            name_cap = name.capitalize()
            PLANET_NAMES = {
                "Mercury": "mercury barycenter",
                "Venus": "venus barycenter",
                "Earth": "earth barycenter",
                "Mars": "mars barycenter",
                "Jupiter": "jupiter barycenter",
                "Saturn": "saturn barycenter",
                "Uranus": "uranus barycenter",
                "Neptune": "neptune barycenter",
                "Pluto": "pluto barycenter",
                "Moon": "moon",
                "Sun": "sun"
            }
            if name_cap in PLANET_NAMES and PLANET_NAMES[name_cap] in eph:
                obj_body = eph[PLANET_NAMES[name_cap]]
            elif name.upper() == "ISS":
                from skyfield.api import EarthSatellite
                tle = get_iss_tle()
                obj_body = EarthSatellite(tle[1], tle[2], tle[0], ts)
            else:
                results[name] = {"error": "Not implemented"}
                continue

            from skyfield_astro import get_object_events
            obj_events = get_object_events(
                body=obj_body,
                ts=ts,
                eph=eph,
                topos=topos,
                observer=observer,
                now=now,
                t0=t0,
                t1=t1
            )
            results[name] = {
                "rise": obj_events.get("rise", "-"),
                "riseAz": obj_events.get("rise_azimuth", "-"),
                "set": obj_events.get("set", "-"),
                "setAz": obj_events.get("set_azimuth", "-"),
                "max": obj_events.get("max_time", "-"),
                "maxAz": obj_events.get("max_azimuth", "-"),
                "maxAlt": obj_events.get("max_altitude", "-"),
                "nowAz": obj_events.get("azimuth", "-"),
                "nowAlt": obj_events.get("altitude", "-"),
            }
        except Exception as e:
            results[name] = {"error": str(e)}
    return results


def get_iss_events(lat, lon, tz_str):
    ts = load.timescale()
    eph = load('de421.bsp')
    tle = get_iss_tle()
    satellite = EarthSatellite(tle[1], tle[2], tle[0], ts)
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    observer = eph['earth'] + topos
    import pytz
    tz = pytz.timezone(tz_str)
    now = datetime.now(tz)
    times = ts.utc(now.year, now.month, now.day, range(0, 24*60, 1))  # var minut
    altitudes = []
    azimuths = []
    times_dt = []
    for i, t in enumerate(times):
        app = observer.at(t).observe(satellite)
        alt, az, _ = app.apparent().altaz()
        altitudes.append(alt.degrees)
        azimuths.append(az.degrees)
        times_dt.append(t.utc_datetime().replace(tzinfo=pytz.utc).astimezone(tz))
    alt_arr = np.array(altitudes)
    above = alt_arr > 0
    if np.any(above):
        idxs = np.where(above)[0]
        rise_idx = idxs[0]
        set_idx = idxs[-1]
        max_idx = rise_idx + np.argmax(alt_arr[rise_idx:set_idx+1])
        return {
            "rise": times_dt[rise_idx].strftime("%H:%M"),
            "riseAz": round(azimuths[rise_idx], 1),
            "set": times_dt[set_idx].strftime("%H:%M"),
            "setAz": round(azimuths[set_idx], 1),
            "max": times_dt[max_idx].strftime("%H:%M"),
            "maxAz": round(azimuths[max_idx], 1),
            "maxAlt": round(alt_arr[max_idx], 1),
            "nowAz": round(azimuths[0], 1),
            "nowAlt": round(alt_arr[0], 1),
        }
    return {k: "-" for k in ["rise", "riseAz", "set", "setAz", "max", "maxAz", "maxAlt", "nowAz", "nowAlt"]}
