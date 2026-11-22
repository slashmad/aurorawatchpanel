# app/skyfield_astro.py

import functools
import threading
import time as _time

import pytz
from skyfield.api import load, Topos
from skyfield import almanac
from datetime import datetime, timedelta, time
import numpy as np


@functools.lru_cache(maxsize=1)
def get_timescale_and_ephemeris():
    """Load the Skyfield timescale and DE421 ephemeris once per process."""
    return load.timescale(), load('de421.bsp')


# Short-lived result cache: one page load requests /astro/sun, /astro/moon and
# /astro/skyfield-astro for the same location within a second or two.
RESULT_TTL_SECONDS = 60
_result_cache: dict = {}
_result_cache_lock = threading.Lock()
_RESULT_CACHE_MAX = 256


def _clear_cache():
    with _result_cache_lock:
        _result_cache.clear()


def _cached(kind, lat, lon, tz_str, compute):
    """Return a copy of a cached result for (kind, rounded location, tz), computing on miss."""
    key = (kind, round(float(lat), 3), round(float(lon), 3), tz_str)
    now = _time.monotonic()
    with _result_cache_lock:
        hit = _result_cache.get(key)
        if hit and now - hit[0] < RESULT_TTL_SECONDS:
            return dict(hit[1])
    value = compute()
    with _result_cache_lock:
        if len(_result_cache) >= _RESULT_CACHE_MAX:
            _result_cache.clear()
        _result_cache[key] = (now, value)
    return dict(value)


def _local_day_times(ts, tz, day, step_minutes):
    """Skyfield Time array for local 'day' at step_minutes intervals, plus the local datetimes."""
    local_midnight = datetime.combine(day, time.min)
    local_times = [tz.localize(local_midnight + timedelta(minutes=m)) for m in range(0, 1440, step_minutes)]
    return ts.from_datetimes([lt.astimezone(pytz.utc) for lt in local_times]), local_times

def _local_day_bounds(ts, day, tz):
    return tuple(ts.from_datetime(tz.localize(datetime.combine(d, time.min)))
                 for d in (day, day + timedelta(days=1)))


def get_object_events(body, ts, eph, topos, observer, now, t0, t1):
    """
    Compute rise, set, max altitude, and current alt/az for a given celestial body.

    Parameters:
        body       : skyfield body object (e.g., eph['sun'] or eph['moon'])
        ts         : skyfield Timescale object
        eph        : skyfield Ephemeris (e.g., load('de421.bsp'))
        topos      : skyfield Topos instance (observer's location)
        observer   : skyfield Earth+Topos object (observer)
        now        : datetime of 'now' with timezone
        t0         : skyfield Time at start of interval (UTC)
        t1         : skyfield Time at end of interval (UTC)

    Returns:
        dict with keys:
          - "rise"            (HH:MM string or "-")
          - "rise_azimuth"    (float or "-")
          - "set"             (HH:MM string or "-")
          - "set_azimuth"     (float or "-")
          - "max_time"        (HH:MM string or "-")
          - "max_azimuth"     (float or "-")
          - "max_altitude"    (float or "-")
          - "azimuth"         (float or "-") for current time
          - "altitude"        (float or "-") for current time
    """
    result = {
        "rise": "-", "rise_azimuth": "-",
        "set": "-",  "set_azimuth": "-",
        "max_time": "-", "max_azimuth": "-", "max_altitude": "-",
        "azimuth": "-",  "altitude": "-"
    }

    # 1) Calculate rise and set using skyfield almanac
    try:
        f = (almanac.sunrise_sunset(eph, topos) if body.target == 10
             else almanac.risings_and_settings(eph, body, topos))
        times, events = almanac.find_discrete(t0, t1, f)
        for t, e in zip(times, events):
            dt_local = t.utc_datetime().replace(tzinfo=pytz.utc).astimezone(now.tzinfo)
            az = observer.at(t).observe(body).apparent().altaz()[1].degrees
            if e == 1 and result["rise"] == "-":
                result["rise"] = dt_local.strftime("%H:%M")
                result["rise_azimuth"] = round(az, 1)
            elif e == 0 and result["set"] == "-":
                result["set"] = dt_local.strftime("%H:%M")
                result["set_azimuth"] = round(az, 1)
    except Exception:
        # If something fails (e.g., high latitude with no rise/set), leave defaults
        pass

    # 2) Calculate maximum altitude between midnight and 24:00 (every 20 minutes),
    #    evaluated as one vectorized Skyfield call; the first maximum wins.
    try:
        times, local_times = _local_day_times(ts, now.tzinfo, now.date(), 20)
        alt, az, _ = observer.at(times).observe(body).apparent().altaz()
        i = int(np.argmax(alt.degrees))
        result["max_altitude"] = round(float(alt.degrees[i]), 1)
        result["max_time"] = local_times[i].strftime("%H:%M")
        result["max_azimuth"] = round(float(az.degrees[i]), 1)
    except Exception:
        pass

    # 3) Calculate current position: altitude & azimuth right now
    try:
        t_now = ts.from_datetime(now.astimezone(pytz.utc))
        app_now = observer.at(t_now).observe(body).apparent()
        alt_now, az_now, _ = app_now.altaz()
        result["azimuth"] = round(az_now.degrees, 1)
        result["altitude"] = round(alt_now.degrees, 1)
    except Exception:
        pass

    return result


def get_sun_info(lat=63.9, lon=20.5, tz_str="Europe/Stockholm", twilight_type="civil"):
    """Sun data for a location; cached for RESULT_TTL_SECONDS. See _compute_sun_info."""
    return _cached(
        f"sun:{twilight_type}", lat, lon, tz_str,
        lambda: _compute_sun_info(lat, lon, tz_str, twilight_type),
    )


def _compute_sun_info(lat=63.9, lon=20.5, tz_str="Europe/Stockholm", twilight_type="civil"):
    """
    Return only sun-specific data (rise, set, max, and current alt/az).

    Parameters:
        lat    : float, latitude in degrees (default 63.9)
        lon    : float, longitude in degrees (default 20.5)
        tz_str : string, timezone identifier (default "Europe/Stockholm")
        twilight_type : string, either "civil" (−6°) or "nautical" (−12°) (default "civil")

    Returns:
        dict with keys:
          - "sunrise"         : "HH:MM" or "-"
          - "sunrise_azimuth" : float or "-"
          - "sunset"          : "HH:MM" or "-"
          - "sunset_azimuth"  : float or "-"
          - "sun_max_time"    : "HH:MM" or "-"
          - "sun_max_altitude": float or "-"
          - "sun_max_azimuth" : float or "-"
          - "sun_azimuth"     : float or "-"
          - "sun_altitude"    : float or "-"
          - "dawn"            : "HH:MM" or None
          - "dusk"            : "HH:MM" or None
          - "twilight_type"   : "civil" or "nautical"
          - "golden_hour_morning_start": "HH:MM" or None
          - "golden_hour_morning_end"  : "HH:MM" or None
          - "golden_hour_evening_start": "HH:MM" or None
          - "golden_hour_evening_end"  : "HH:MM" or None
          - "nightlength"     : "HH:MM" or None
          - "tz"              : string (same as tz_str)
    """
    # 1) Shared ephemeris and timescale
    ts, eph = get_timescale_and_ephemeris()
    earth = eph['earth']
    sun = eph['sun']

    # 2) Build observer on Earth at given lat/lon
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    observer = earth + topos

    # 3) Local timezone and now
    tz = pytz.timezone(tz_str)
    now = datetime.now(tz)
    today = now.date()
    # Define start and end of interval in UTC
    t0, t1 = _local_day_bounds(ts, today, tz)

    # 4) Get rise/set/max/current for the Sun
    sun_data = get_object_events(
        body=sun,
        ts=ts,
        eph=eph,
        topos=topos,
        observer=observer,
        now=now,
        t0=t0,
        t1=t1
    )

    golden = get_golden_hours(ts, eph, topos, today, tz)
    twilight = almanac.dark_twilight_day(eph, topos)
    times, states = almanac.find_discrete(t0, t1, twilight)
    before = int(twilight(t0))
    selected = 2 if twilight_type == "nautical" else 3
    dawn_dusk = dict(dawn=None, dusk=None, astro_dawn=None, astro_dusk=None)
    for event, after in zip(times, states):
        local_time = event.astimezone(tz).strftime("%H:%M")
        for level, prefix in ((selected, ""), (1, "astro_")):
            if before < level <= after:
                dawn_dusk[prefix + "dawn"] = local_time
            elif after < level <= before:
                dawn_dusk[prefix + "dusk"] = local_time
        before = int(after)

    # 6) Bygg dict med alla värden
    combined = {
        "sunrise": sun_data["rise"],
        "sunrise_azimuth": sun_data["rise_azimuth"],
        "sunset": sun_data["set"],
        "sunset_azimuth": sun_data["set_azimuth"],
        "sun_max_time": sun_data["max_time"],
        "sun_max_altitude": sun_data["max_altitude"],
        "sun_max_azimuth": sun_data["max_azimuth"],
        "sun_azimuth": sun_data["azimuth"],
        "sun_altitude": sun_data["altitude"],

        # Dawn/Dusk
        **dawn_dusk,

        # Typ av twilight för ovan tider
        "twilight_type": twilight_type,

        # Golden hours
        "golden_hour_morning_start": golden.get("golden_hour_morning_start"),
        "golden_hour_morning_end":   golden.get("golden_hour_morning_end"),
        "golden_hour_evening_start": golden.get("golden_hour_evening_start"),
        "golden_hour_evening_end":   golden.get("golden_hour_evening_end"),

        # Timezone
        "tz": tz_str
    }

    # 7) Räkna ut nightlength om dawn och dusk finns (enligt vald twilight_type)
    if dawn_dusk.get("dawn") and dawn_dusk.get("dusk"):
        dawn_str = dawn_dusk["dawn"]
        dusk_str = dawn_dusk["dusk"]
        try:
            dawn_dt = datetime.combine(today, datetime.strptime(dawn_str, "%H:%M").time())
            dusk_dt = datetime.combine(today, datetime.strptime(dusk_str, "%H:%M").time())
            if dusk_dt > dawn_dt:
                next_dawn = dawn_dt + timedelta(days=1)
                night_seconds = (next_dawn - dusk_dt).total_seconds()
            else:
                night_seconds = (dawn_dt - dusk_dt).total_seconds()
            hours = int(night_seconds // 3600)
            minutes = int((night_seconds % 3600) // 60)
            combined["nightlength"] = f"{hours:02}:{minutes:02}"
        except Exception:
            combined["nightlength"] = None
    else:
        combined["nightlength"] = None

    return combined

def moon_phase_label(illum, is_waxing):
    # illum: 0–100 (procent)
    if illum < 1:
        return "New Moon"
    elif illum < 49:
        return "Waxing Crescent" if is_waxing else "Waning Crescent"
    elif 49 <= illum <= 51:
        return "First Quarter" if is_waxing else "Last Quarter"
    elif illum < 99:
        return "Waxing Gibbous" if is_waxing else "Waning Gibbous"
    else:
        return "Full Moon"


def get_moon_info(lat=63.9, lon=20.5, tz_str="Europe/Stockholm"):
    """Moon data for a location; cached for RESULT_TTL_SECONDS. See _compute_moon_info."""
    return _cached("moon", lat, lon, tz_str, lambda: _compute_moon_info(lat, lon, tz_str))


def next_full_moon_date(ts, eph, now):
    """Local date (YYYY-MM-DD) of the first full moon at or after 'now', or "-"."""
    t0 = ts.from_datetime(now.astimezone(pytz.utc))
    t1 = ts.from_datetime((now + timedelta(days=32)).astimezone(pytz.utc))
    times, phases = almanac.find_discrete(t0, t1, almanac.moon_phases(eph))
    for t, phase in zip(times, phases):
        if phase == 2:  # 0 new, 1 first quarter, 2 full, 3 last quarter
            return t.utc_datetime().astimezone(now.tzinfo).strftime("%Y-%m-%d")
    return "-"


def _compute_moon_info(lat=63.9, lon=20.5, tz_str="Europe/Stockholm"):

    ts, eph = get_timescale_and_ephemeris()
    earth = eph['earth']
    moon = eph['moon']
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    tz = pytz.timezone(tz_str)
    now = datetime.now(tz)
    t0, t1 = _local_day_bounds(ts, now.date(), tz)

    moon_data = get_object_events(
        body=moon,
        ts=ts,
        eph=eph,
        topos=topos,
        observer=earth + topos,
        now=now,
        t0=t0, t1=t1
    )
    """
    Return only moon-specific data (rise, set, max, current alt/az) plus phase info.

    Parameters:
        lat    : float, latitude in degrees (default 63.9)
        lon    : float, longitude in degrees (default 20.5)
        tz_str : string, timezone identifier (default "Europe/Stockholm")

    Returns:
        dict with keys:
          - "moonrise"          : "HH:MM" or "-"
          - "moonrise_azimuth"  : float or "-"
          - "moonset"           : "HH:MM" or "-"
          - "moonset_azimuth"   : float or "-"
          - "moon_max_time"     : "HH:MM" or "-"
          - "moon_max_altitude" : float or "-"
          - "moon_max_azimuth"  : float or "-"
          - "moon_azimuth"      : float or "-"
          - "moon_altitude"     : float or "-"
          - "moon_phase"        : int (0–100, percent illuminated)
          - "moon_phase_label"  : string (e.g., "Waning Gibbous")
          - "moon_phase_index"  : int (0–29, index into 29-image array)
          - "next_fullmoon"     : string "YYYY-MM-DD" or "-"
          - "is_waxing"         : bool
          - "tz"                : string (same as tz_str)
    """
    # 1) Load ephemeris and timescale

    # 5) Calculate moon phase (percentage) and waxing/waning
    t_now = ts.from_datetime(now.astimezone(pytz.utc))
    phase_degrees = almanac.moon_phase(eph, t_now).degrees
    illum = int(round(100 * almanac.fraction_illuminated(eph, 'moon', t_now)))
    is_waxing = bool(phase_degrees < 180)
    moon_phase_label_value = moon_phase_label(illum, is_waxing)

    # 6) Next full moon: exact lunar-phase search. The former 6-hourly sampling
    #    picked the "fullest" moon within 31 days, which could skip the nearest
    #    full moon (e.g. in favour of a lunar eclipse a month later).
    next_fullmoon = next_full_moon_date(ts, eph, now)

    # 7) Return only moon-related keys
    return {
        "moonrise": moon_data["rise"],
        "moonrise_azimuth": moon_data["rise_azimuth"],
        "moonset": moon_data["set"],
        "moonset_azimuth": moon_data["set_azimuth"],
        "moon_max_time": moon_data["max_time"],
        "moon_max_altitude": moon_data["max_altitude"],
        "moon_max_azimuth": moon_data["max_azimuth"],
        "moon_azimuth": moon_data["azimuth"],
        "moon_altitude": moon_data["altitude"],
        "moon_phase": illum,
        "moon_phase_label": moon_phase_label_value,
        "moon_phase_index": round(((phase_degrees + 180) % 360) * 29 / 360) % 29,
        "next_fullmoon": next_fullmoon,
        "is_waxing": is_waxing,
        "tz": tz_str
    }


def get_sun_moon_altitudes_24h(lat, lon, tz_str="Europe/Stockholm", step_min=60):
    """
    Return arrays of sun & moon altitudes for the next 24 hours at 'step_min' intervals.
    """
    ts, eph = get_timescale_and_ephemeris()
    observer = eph['earth'] + Topos(latitude_degrees=lat, longitude_degrees=lon)

    tz = pytz.timezone(tz_str)
    today = datetime.now(tz).date()

    # Local-day samples at step_min intervals, one vectorized call per body.
    times, local_times = _local_day_times(ts, tz, today, step_min)
    sun_alt = observer.at(times).observe(eph['sun']).apparent().altaz()[0].degrees
    moon_alt = observer.at(times).observe(eph['moon']).apparent().altaz()[0].degrees

    return {
        "times": [lt.strftime("%H:%M") for lt in local_times],
        "sun_altitudes": [round(float(a), 1) for a in sun_alt],
        "moon_altitudes": [round(float(a), 1) for a in moon_alt],
        "tz": tz_str
    }

def find_altitude_crossings(ts, eph, topos, altitude_degrees, t0, t1, steps=240):
    sun = eph['sun']
    times = ts.linspace(t0, t1, steps)
    observer = eph['earth'] + topos
    altitudes = observer.at(times).observe(sun).apparent().altaz()[0].degrees
    above = altitudes > altitude_degrees

    crossings = []
    for i in range(1, len(above)):
        if above[i-1] != above[i]:
            t1_tt = times[i-1].tt
            t2_tt = times[i].tt
            a1 = altitudes[i-1]
            a2 = altitudes[i]
            frac = (altitude_degrees - a1) / (a2 - a1)
            tt_cross = t1_tt + frac * (t2_tt - t1_tt)
            crossings.append(ts.tt_jd(tt_cross))
    return crossings

def get_golden_hours(ts, eph, topos, date, tz):
    """
    Compute civil golden hours (−4°↔+6°) by searching from 18:00
    previous day to 06:00 next day, then pick ut de passager
    som faktiskt inträffar på "date" (00:00–24:00 lokal tid).
    """
    prev_day = date - timedelta(days=1)
    next_day = date + timedelta(days=1)

    # 1) UTC‐timestamp för 18:00 föregående dag och 06:00 nästa dag
    t0_local_prev = tz.localize(datetime.combine(prev_day, time(18, 0)))
    t0 = ts.from_datetime(t0_local_prev.astimezone(pytz.utc))
    t1_local_next = tz.localize(datetime.combine(next_day, time(6, 0)))
    t1 = ts.from_datetime(t1_local_next.astimezone(pytz.utc))

    # 2) Alla crossings för -4° och +6° i hela intervallet
    cross_minus4 = find_altitude_crossings(ts, eph, topos, -4.0, t0, t1)
    cross_plus6  = find_altitude_crossings(ts, eph, topos,  6.0, t0, t1)

    # 3) Filtrera ut de crossings som ligger på "date" (00:00 till 24:00 lokal tid)
    def filter_on_date(ts_list, target_date):
        filtered = []
        for t_tt in ts_list:
            dt_local = t_tt.astimezone(tz)
            if dt_local.date() == target_date:
                filtered.append(dt_local)
        return filtered

    minus4_on_date = filter_on_date(cross_minus4, date)
    plus6_on_date  = filter_on_date(cross_plus6,  date)

    # 4) Bestäm morgon‐start / morgon‐slut:
    golden_hour_morning_start = None
    golden_hour_morning_end   = None
    # morgon‐start = första gång solen går från < −4° → > −4° (alltså minus4_on_date[0] om den existerar)
    if minus4_on_date:
        golden_hour_morning_start = minus4_on_date[0].strftime("%H:%M")
    # morgon‐slut = första gång solen går från < +6° → > +6° (alltså plus6_on_date[0] om den existerar)
    if plus6_on_date:
        golden_hour_morning_end = plus6_on_date[0].strftime("%H:%M")

    # 5) Bestäm kvälls‐start / kvälls‐slut:
    golden_hour_evening_start = None
    golden_hour_evening_end   = None
    # kvälls‐start = sista gång solen går från > +6° → < +6° (använd sista elementet i plus6_on_date om finns)
    if plus6_on_date:
        golden_hour_evening_start = plus6_on_date[-1].strftime("%H:%M")
    # kvälls‐slut = sista gång solen går från > −4° → < −4° (använd sista elementet i minus4_on_date om finns)
    if minus4_on_date:
        golden_hour_evening_end = minus4_on_date[-1].strftime("%H:%M")

    return {
        "golden_hour_morning_start": golden_hour_morning_start,
        "golden_hour_morning_end":   golden_hour_morning_end,
        "golden_hour_evening_start": golden_hour_evening_start,
        "golden_hour_evening_end":   golden_hour_evening_end,
    }

def get_sun_moon_info(lat=63.9, lon=20.5, tz_str="Europe/Stockholm"):
    """
    Legacy combined endpoint: return both sun and moon data merged in one dict.
    """
    try:
        sun_data = get_sun_info(lat, lon, tz_str)
        moon_data = get_moon_info(lat, lon, tz_str)
        combined = {}
        combined.update(sun_data)
        combined.update(moon_data)

        # Eftersom get_sun_info redan ger twilight/golden hours/nightlength,
        # behöver vi inte göra ytterligare uppslagningar eller fromisoformat.
        return combined
    except Exception as e:
        return {"error": str(e)}