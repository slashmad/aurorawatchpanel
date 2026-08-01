# app/skyfield_astro.py

import pytz
from skyfield.api import load, Topos
from skyfield import almanac
from datetime import datetime, timedelta, time
import numpy as np

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
        f = almanac.risings_and_settings(eph, body, topos)
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

    # 2) Calculate maximum altitude between midnight and 24:00 (every 20 minutes)
    try:
        max_alt = -90.0
        max_time_str = None
        max_azimuth = None
        for minute in range(0, 1440, 20):
            # Build a datetime on today's date at "minute" past midnight in local tz
            local_midnight = datetime.combine(now.date(), time.min)
            local_time = now.tzinfo.localize(local_midnight + timedelta(minutes=minute))
            t_sf = ts.from_datetime(local_time.astimezone(pytz.utc))
            app = observer.at(t_sf).observe(body).apparent()
            alt, az, _ = app.altaz()
            if alt.degrees > max_alt:
                max_alt = alt.degrees
                max_time_str = local_time.strftime("%H:%M")
                max_azimuth = az.degrees
        result["max_altitude"] = round(max_alt, 1)
        result["max_time"] = max_time_str if max_time_str is not None else "-"
        result["max_azimuth"] = round(max_azimuth, 1) if max_azimuth is not None else "-"
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
    """
    Return only sun-specific data (rise, set, max, and current alt/az).

    Parameters:
        lat    : float, latitude in degrees (default 63.9)
        lon    : float, longitude in degrees (default 20.5)
        tz_str : string, timezone identifier (default "Europe/Stockholm")
        twilight_type : string, either "civil" (0°) or "nautical" (−6°) (default "civil")

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
    # 1) Load ephemeris and timescale
    ts = load.timescale()
    eph = load('de421.bsp')
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
    t0 = ts.utc(now.year, now.month, now.day)
    t1 = ts.utc(now.year, now.month, now.day + 1)

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

    # 5) Compute dawn, dusk och golden hours
    #    Välj tröskel för dawn/dusk beroende på twilight_type
    if twilight_type == "nautical":
        twilight_threshold = -6.0
    else:
        # default "civil"
        twilight_threshold = 0.0

    golden = get_golden_hours(ts, eph, topos, today, tz)
    dawn_dusk = get_dawn_dusk(ts, eph, topos, today, tz, threshold_degrees=twilight_threshold)

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
        "dawn": dawn_dusk.get("dawn"),
        "dusk": dawn_dusk.get("dusk"),

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
    if illum < 1 or illum > 99:
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

    ts = load.timescale()
    eph = load('de421.bsp')
    earth = eph['earth']
    sun = eph['sun']
    moon = eph['moon']
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    now = datetime.now(pytz.timezone(tz_str))


    moon_data = get_object_events(
        body=moon,
        ts=ts,
        eph=eph,
        topos=topos,
        observer=earth + topos,
        now=now,
        t0=ts.utc(now.year, now.month, now.day),
        t1=ts.utc(now.year, now.month, now.day + 1)
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
    sun_vec  = (earth + topos).at(t_now).observe(sun).apparent().position.km
    moon_vec = (earth + topos).at(t_now).observe(moon).apparent().position.km
    phase_angle = np.arccos(
        np.dot(sun_vec, moon_vec) /
        (np.linalg.norm(sun_vec) * np.linalg.norm(moon_vec))
    )
    moon_phase = (1 - np.cos(phase_angle)) / 2  # fraction 0.0–1.0

    illum = int(round(moon_phase * 100))
    is_waxing = bool(phase_angle < np.pi)
    moon_phase_label_value = moon_phase_label(illum, is_waxing)

    # 6) Find next full moon (sök när illuminationen är maximal)
    next_fullmoon = "-"
    best_phase = 0
    best_dt = None
    for i in range(1, 32):
        for hour in [0, 6, 12, 18]:
            dt_test = now + timedelta(days=i, hours=hour)
            t_test = ts.from_datetime(dt_test.astimezone(pytz.utc))
            sun_vec_test  = (earth + topos).at(t_test).observe(sun).apparent().position.km
            moon_vec_test = (earth + topos).at(t_test).observe(moon).apparent().position.km
            phase_test = (1 - np.cos(
                np.arccos(
                    np.dot(sun_vec_test, moon_vec_test) /
                    (np.linalg.norm(sun_vec_test) * np.linalg.norm(moon_vec_test))
                )
            )) / 2
            if phase_test > best_phase:
                best_phase = phase_test
                best_dt = dt_test
    if best_dt:
        next_fullmoon = best_dt.strftime("%Y-%m-%d")

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
        "moon_phase": int(round(moon_phase * 100)),
        "moon_phase_label": moon_phase_label_value,
        "moon_phase_index": int(round(moon_phase * 29)),
        "next_fullmoon": next_fullmoon,
        "is_waxing": is_waxing,
        "tz": tz_str
    }


def get_sun_moon_altitudes_24h(lat, lon, tz_str="Europe/Stockholm", step_min=60):
    """
    Return arrays of sun & moon altitudes for the next 24 hours at 'step_min' intervals.
    """
    # 1) Initialize Skyfield timescale and ephemeris
    ts = load.timescale()
    eph = load('de421.bsp')
    earth = eph['earth']

    # 2) Build Topos/observer for given lat/lon
    topos = Topos(latitude_degrees=lat, longitude_degrees=lon)
    observer = earth + topos

    # 3) Set local tz and today’s date
    import pytz
    from datetime import datetime, timedelta
    tz = pytz.timezone(tz_str)
    now = datetime.now(tz)
    today = now.date()

    # 4) Compute 24h range in UTC for Skyfield
    t0 = ts.utc(now.year, now.month, now.day)
    t1 = ts.utc(now.year, now.month, now.day + 1)

    # 5) Build list of times at step_min intervals (local times)
    times_local = []
    alt_sun_list = []
    alt_moon_list = []
    time_labels = []
    for minute in range(0, 1440, step_min):
        local_dt = tz.localize(datetime.combine(today, datetime.min.time()) + timedelta(minutes=minute))
        sf_t = ts.from_datetime(local_dt.astimezone(pytz.utc))
        # Sun altitude
        sun_alt = observer.at(sf_t).observe(eph['sun']).apparent().altaz()[0].degrees
        # Moon altitude
        moon_alt = observer.at(sf_t).observe(eph['moon']).apparent().altaz()[0].degrees
        alt_sun_list.append(round(sun_alt, 1))
        alt_moon_list.append(round(moon_alt, 1))
        time_labels.append(local_dt.strftime("%H:%M"))

    return {
        "times": time_labels,
        "sun_altitudes": alt_sun_list,
        "moon_altitudes": alt_moon_list,
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

def get_dawn_dusk(ts, eph, topos, date, tz, threshold_degrees=0.0):
    """
    Compute dawn and dusk by scanning from 18:00 previous day to 06:00 next day (UTC),
    filtering to only those times that fall on 'date' (00:00–24:00 local time).

    threshold_degrees : float, om du vill ha civil twilight (0.0) eller nautical (-6.0)
    """
    prev_day = date - timedelta(days=1)
    next_day = date + timedelta(days=1)

    # 1) Bygg tidsintervall i UTC
    t0_local_prev = tz.localize(datetime.combine(prev_day, time(18, 0)))
    t0 = ts.from_datetime(t0_local_prev.astimezone(pytz.utc))
    t1_local_next = tz.localize(datetime.combine(next_day, time(6, 0)))
    t1 = ts.from_datetime(t1_local_next.astimezone(pytz.utc))

    # 2) Hämta alla crossings för vald tröskel (threshold_degrees)
    all_crossings = find_altitude_crossings(ts, eph, topos, threshold_degrees, t0, t1)

    # 3) Filtrera dem som ligger på 'date' (00:00–24:00 lokal tid)
    filtered = [t_tt.astimezone(tz) for t_tt in all_crossings if t_tt.astimezone(tz).date() == date]

    # 4) Bestäm dawn (första) och dusk (sista)
    if len(filtered) >= 2:
        dawn = filtered[0].strftime("%H:%M")
        dusk = filtered[-1].strftime("%H:%M")
    else:
        dawn = None
        dusk = None

    return {"dawn": dawn, "dusk": dusk}

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