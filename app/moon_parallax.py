# moon_parallax.py
from skyfield.api import load, Topos
import numpy as np
from datetime import datetime
import pytz

def get_parallactic_angle(lat, lon, dt_utc):
    ts = load.timescale()
    eph = load('de421.bsp')
    observer = eph['earth'] + Topos(latitude_degrees=lat, longitude_degrees=lon)
    t = ts.from_datetime(dt_utc)

    # Alt-az för månen just nu
    moon = eph['moon']
    alt, az, _ = observer.at(t).observe(moon).apparent().altaz()
    # ha = observer.at(t).sidereal_time() - eph['moon'].at(t).ra  # <-- DENNA RAD BORT

    # Parallaktisk vinkel (astro-formel)
    phi = np.radians(lat)
    A = np.radians(az.degrees)
    a = np.radians(alt.degrees)
    par = np.arctan2(np.sin(A), np.tan(phi)*np.cos(a) - np.sin(a)*np.cos(A))
    par_deg = np.degrees(par)
    return par_deg
