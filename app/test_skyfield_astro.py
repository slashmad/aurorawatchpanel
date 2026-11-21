import inspect
import unittest
from datetime import datetime, time, timedelta
from unittest import mock

import pytz
from skyfield.api import Topos

import routes_skyfield
import skyfield_astro as sa

STOCKHOLM = pytz.timezone("Europe/Stockholm")


class NextFullMoonTests(unittest.TestCase):
    def setUp(self):
        self.ts, self.eph = sa.get_timescale_and_ephemeris()

    def test_returns_nearest_full_moon_not_a_fuller_later_one(self):
        # Full moon 2026-02-01 ~23:09 CET; the 2026-03-03 full moon is a total
        # lunar eclipse, which the former sampling search wrongly preferred.
        now = STOCKHOLM.localize(datetime(2026, 1, 31, 22, 15))
        self.assertEqual(sa.next_full_moon_date(self.ts, self.eph, now), "2026-02-01")

    def test_full_moon_later_today_is_today(self):
        now = STOCKHOLM.localize(datetime(2026, 2, 1, 8, 0))
        self.assertEqual(sa.next_full_moon_date(self.ts, self.eph, now), "2026-02-01")

    def test_date_is_reported_in_local_time(self):
        # 2026-11-24 full moon at ~15:53 UTC.
        now = STOCKHOLM.localize(datetime(2026, 11, 21, 19, 30))
        self.assertEqual(sa.next_full_moon_date(self.ts, self.eph, now), "2026-11-24")


class VectorizedMaxAltitudeTests(unittest.TestCase):
    def test_matches_per_sample_loop(self):
        ts, eph = sa.get_timescale_and_ephemeris()
        topos = Topos(latitude_degrees=63.9, longitude_degrees=20.55)
        observer = eph["earth"] + topos
        now = STOCKHOLM.localize(datetime(2026, 11, 21, 19, 30))
        for body_name in ("sun", "moon"):
            with self.subTest(body=body_name):
                body = eph[body_name]
                result = sa.get_object_events(
                    body=body, ts=ts, eph=eph, topos=topos, observer=observer, now=now,
                    t0=ts.utc(2026, 11, 21), t1=ts.utc(2026, 11, 22),
                )
                best: tuple = (-90.0, None, None)
                for minute in range(0, 1440, 20):
                    local = STOCKHOLM.localize(datetime.combine(now.date(), time.min) + timedelta(minutes=minute))
                    alt, az, _ = observer.at(ts.from_datetime(local.astimezone(pytz.utc))).observe(body).apparent().altaz()
                    if alt.degrees > best[0]:
                        best = (alt.degrees, local.strftime("%H:%M"), az.degrees)
                self.assertEqual(result["max_altitude"], round(best[0], 1))
                self.assertEqual(result["max_time"], best[1])
                self.assertEqual(result["max_azimuth"], round(best[2], 1))


class ResultCacheTests(unittest.TestCase):
    def setUp(self):
        sa._clear_cache()
        self.addCleanup(sa._clear_cache)

    def test_repeated_calls_within_ttl_compute_once_and_return_copies(self):
        with mock.patch.object(sa, "_compute_moon_info", return_value={"moon_phase": 50}) as compute:
            first = sa.get_moon_info(63.9, 20.55, "Europe/Stockholm")
            first["moon_phase"] = 99
            second = sa.get_moon_info(63.9001, 20.5501, "Europe/Stockholm")
        compute.assert_called_once()
        self.assertEqual(second, {"moon_phase": 50})

    def test_location_timezone_and_twilight_type_are_part_of_the_key(self):
        with mock.patch.object(sa, "_compute_sun_info", return_value={}) as compute:
            sa.get_sun_info(63.9, 20.55, "Europe/Stockholm")
            sa.get_sun_info(59.33, 18.07, "Europe/Stockholm")
            sa.get_sun_info(63.9, 20.55, "UTC")
            sa.get_sun_info(63.9, 20.55, "Europe/Stockholm", twilight_type="nautical")
        self.assertEqual(compute.call_count, 4)

    def test_expired_entries_are_recomputed(self):
        with mock.patch.object(sa, "_compute_moon_info", return_value={}) as compute, \
             mock.patch.object(sa._time, "monotonic", side_effect=[1000.0, 1000.0 + sa.RESULT_TTL_SECONDS + 1]):
            sa.get_moon_info(63.9, 20.55, "Europe/Stockholm")
            sa.get_moon_info(63.9, 20.55, "Europe/Stockholm")
        self.assertEqual(compute.call_count, 2)


class AstroRouteDispatchTests(unittest.TestCase):
    def test_cpu_bound_astro_routes_run_in_the_threadpool(self):
        for name in ("skyfield_astro", "sun_endpoint", "moon_endpoint",
                     "skyfield_altitudes", "astro_batch", "azimuth_batch"):
            with self.subTest(route=name):
                self.assertFalse(inspect.iscoroutinefunction(getattr(routes_skyfield, name)))


if __name__ == "__main__":
    unittest.main()
