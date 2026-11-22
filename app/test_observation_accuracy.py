import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from pymysql.cursors import DictCursor

import main
import pytz
import fetch_ovation_aurora as ovation
import skyfield_astro as astro
from test_magnetometer_sql import ENABLED, connect


class ObservationAccuracyTests(unittest.TestCase):
    def test_full_and_waning_moon_labels(self):
        for day, phase in [(24, "Full Moon"), (28, "Waning Gibbous")]:
            when = datetime(2026, 11, day, 16, tzinfo=timezone.utc)
            with self.subTest(day=day), patch.object(astro, "datetime", wraps=datetime) as clock:
                clock.now.return_value = when.astimezone(pytz.timezone("Europe/Stockholm"))
                result = astro._compute_moon_info(63.9, 20.55, "Europe/Stockholm")
                self.assertEqual(result["moon_phase_label"], phase)
                self.assertFalse(result["is_waxing"])

    def test_civil_and_astronomical_twilight_bracket_daylight(self):
        when = datetime(2026, 11, 22, 14, 13, tzinfo=timezone.utc)
        with patch.object(astro, "datetime", wraps=datetime) as clock:
            clock.now.return_value = when.astimezone(pytz.timezone("Europe/Stockholm"))
            result = astro._compute_sun_info(63.9, 20.55, "Europe/Stockholm")
        times = [result[key] for key in ("astro_dawn", "dawn", "sunrise", "sunset", "dusk", "astro_dusk")]
        self.assertEqual(times, sorted(set(times)))
        self.assertGreater(result["sun_altitude"], -6)
        self.assertLess(result["sun_altitude"], -1)

    def test_replay_utc_day_spans_two_local_camera_folders(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(main, "ALLSKY_FS_ROOT", Path(temp)), \
             patch.object(main, "_load_replay_database", return_value=([], {}, [], [])):
            for day in ("20261122", "20261123"):
                folder = Path(temp, day)
                folder.mkdir()
                (folder / f"image-{day}003000.jpg").touch()
            replay = main.replay_day("2026-11-22", "KIR", "x")
            self.assertEqual([row["time"] for row in replay["allsky"]], ["2026-11-22T23:30:00Z"])

    def test_archive_index_reuse_invalidation_and_utc_day(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(main, "DATA_IMAGE_DIR", Path(temp)):
            folder = Path(temp, "Synoptic")
            folder.mkdir()
            for day in ("20261121", "20261122"):
                (folder / f"Synoptic_{day}T010000Z.jpg").touch()
            with patch.object(main.os, "scandir", wraps=os.scandir) as scan:
                result = main.images_list("Synoptic Map", day=date(2026, 11, 21))
                self.assertEqual(result["files"], ["Synoptic/Synoptic_20261121T010000Z.jpg"])
                self.assertTrue(main.images_list("Synoptic Map", 1)["has_more"])
                self.assertEqual(scan.call_count, 1)
                (folder / "Synoptic_20261123T010000Z.jpg").touch()
                self.assertIn("20261123", main.images_list("Synoptic Map", 1)["files"][0])
                self.assertEqual(scan.call_count, 2)

    def test_power_parser_uses_latest_usable_observation_and_its_forecast(self):
        text = """# NOAA
2026-11-22_14:00 2026-11-22_15:04 13 14
2026-11-22_14:05 2026-11-22_15:09 0 n/a
2026-11-22_14:10 2026-11-22_15:14 n/a n/a
bad line"""
        self.assertEqual(ovation.latest_power(text),
                         ("2026-11-22T14:05:00Z", "2026-11-22T15:09:00Z", 0.0, None))


@unittest.skipUnless(ENABLED, "requires a disposable database ending in _test")
class OvationDatabaseTests(unittest.TestCase):
    def test_concurrent_grid_ingestion_and_tabular_power(self):
        prefix = "test_" + uuid4().hex + "_"

        class IsolatedCursor(DictCursor):
            def execute(self, query, args=None):
                for name in ("ovation_aurora", "ovation_power"):
                    query = query.replace(name, prefix + name)
                return super().execute(query, args)

        def fixture_connection():
            connection = connect()
            connection.cursorclass = IsolatedCursor
            return connection

        def cleanup():
            with fixture_connection() as conn, conn.cursor() as cur:
                cur.execute("DROP TABLE IF EXISTS ovation_aurora, ovation_power")

        self.addCleanup(cleanup)
        with fixture_connection() as conn, conn.cursor() as cur:
            cur.execute(ovation.CREATE_SQL)
        with patch.object(main, "get_db", fixture_connection):
            self.assertEqual(main.latest_hemispheric_power(), {"error": "No HP found"})
        with fixture_connection() as conn, conn.cursor() as cur:
            cur.execute(ovation.CREATE_POWER_SQL)
        grid = {"Observation Time": "2026-11-22T14:08:00Z", "coordinates": [[0, 0, 42]]}
        power = "2026-11-22_14:05 2026-11-22_15:10 13 14"
        with patch.object(ovation, "get_db", fixture_connection), patch.object(main, "get_db", fixture_connection):
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(ovation.store_grid, [grid] * 4))
            ovation.store_grid({**grid, "Observation Time": "2026-11-22T14:01:00Z"})
            with patch.object(ovation, "fetch_text", return_value=power):
                ovation.fetch_and_store_power()
            with patch.object(ovation, "fetch_text", return_value=power.replace("13 14", "n/a 18")):
                ovation.fetch_and_store_power()
            self.assertEqual(main.latest_hemispheric_power(), {
                "ts": "2026-11-22T14:05:00Z", "forecast_time": "2026-11-22T15:10:00Z",
                "hemispheric_power_north": 13.0, "hemispheric_power_south": 18.0,
            })
            self.assertEqual(main.get_latest_aurora_oval()["coordinates"], [[42]])
            with fixture_connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT probs_south_json FROM ovation_aurora")
                self.assertEqual(cur.fetchall(), [{"probs_south_json": None}])
