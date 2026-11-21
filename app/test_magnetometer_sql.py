"""Integration tests for the SQL-side magnetometer downsampling.

They need a disposable MariaDB/MySQL 8+ server and are skipped otherwise:

    docker run -d --rm --name aurora-test-db -e MARIADB_ROOT_PASSWORD=test \\
      -e MARIADB_DATABASE=aurora_test -e MARIADB_USER=aurora -e MARIADB_PASSWORD=test \\
      -p 127.0.0.1:33099:3306 --tmpfs /var/lib/mysql mariadb:11
    AURORA_TEST_DB_HOST=127.0.0.1 AURORA_TEST_DB_PORT=33099 AURORA_TEST_DB_USER=aurora \\
      AURORA_TEST_DB_PASS=test AURORA_TEST_DB_NAME=aurora_test .venv/bin/python -m pytest app/test_magnetometer_sql.py

As a safety net the database name must end in "_test"; never point these
tests at a production database.
"""
import math
import os
import unittest
from datetime import datetime, timedelta
from unittest import mock

import main

DB_NAME = os.getenv("AURORA_TEST_DB_NAME", "")
ENABLED = bool(os.getenv("AURORA_TEST_DB_HOST")) and DB_NAME.endswith("_test")
TABLE = "test_magnetometer_series"


def connect():
    import pymysql

    return pymysql.connect(
        host=os.environ["AURORA_TEST_DB_HOST"],
        port=int(os.getenv("AURORA_TEST_DB_PORT", "3306")),
        user=os.getenv("AURORA_TEST_DB_USER", "aurora"),
        password=os.getenv("AURORA_TEST_DB_PASS", ""),
        database=DB_NAME,
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def reference(rows, max_points=main.MAGNETOMETER_MAX_POINTS):
    """Python statement of what the SQL must return, from the raw rows."""
    points = [r for r in rows if r["x"] is not None]
    if not points:
        return [], None
    base = sum(r["x"] for r in points) / len(points)
    if len(points) > max_points:
        inner = points[1:-1]
        buckets = max(1, (max_points - 2) // 2)
        size = -(-len(inner) // buckets)
        kept = [points[0]]
        for start in range(0, len(inner), size):
            chunk = inner[start:start + size]
            lo = min(range(len(chunk)), key=lambda i: chunk[i]["x"])
            hi = max(range(len(chunk)), key=lambda i: chunk[i]["x"])
            kept.extend(chunk[i] for i in sorted({lo, hi}))
        kept.append(points[-1])
        points = kept
    return [(p["timestamp"], round(p["x"] - base, 2)) for p in points], base


@unittest.skipUnless(ENABLED, "set AURORA_TEST_DB_* (database name ending in _test) to run")
class RelativeSeriesSqlTests(unittest.TestCase):
    START = datetime(2026, 11, 21, 0, 0, 0)

    def setUp(self):
        self.db = connect()
        with self.db.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
            cur.execute(
                f"CREATE TABLE {TABLE} (station VARCHAR(10), timestamp DATETIME, x DOUBLE, "
                "PRIMARY KEY (station, timestamp))"
            )
        self.addCleanup(self.db.close)

    def insert(self, station, values):
        rows = [(station, self.START + timedelta(seconds=10 * i), v) for i, v in enumerate(values)]
        with self.db.cursor() as cur:
            cur.executemany(f"INSERT INTO {TABLE} VALUES (%s, %s, %s)", rows)
        return [{"timestamp": t, "x": v} for _, t, v in rows]

    def series(self, station, cutoff=None):
        with self.db.cursor() as cur:
            return main.query_relative_series(cur, TABLE, "x", station, cutoff or self.START)

    @staticmethod
    def wave(n, spikes=()):
        # Distinct values (no ties) with a slow wave plus sharp spikes.
        values = [100.0 + 20 * math.sin(i / 250) + i * 1e-4 for i in range(n)]
        for index, delta in spikes:
            values[index] += delta
        return values

    def assert_matches_reference(self, got, raw):
        want, _ = reference(raw)
        self.assertEqual([t for t, _ in want], [p["time"] for p in got])
        for (_, value), point in zip(want, got):
            self.assertAlmostEqual(value, point["value"], places=2)

    def test_long_series_matches_reference_and_keeps_spikes_and_endpoints(self):
        for n in (601, 4300, 8640):
            with self.subTest(n=n):
                station = f"S{n}"
                raw = self.insert(station, self.wave(n, spikes=((n // 3, 400.0), (2 * n // 3, -350.0))))
                got = self.series(station)
                self.assertLessEqual(len(got), main.MAGNETOMETER_MAX_POINTS)
                self.assertEqual(got[0]["time"], raw[0]["timestamp"])
                self.assertEqual(got[-1]["time"], raw[-1]["timestamp"])
                times = {p["time"] for p in got}
                self.assertIn(raw[n // 3]["timestamp"], times)
                self.assertIn(raw[2 * n // 3]["timestamp"], times)
                self.assert_matches_reference(got, raw)

    def test_short_series_return_every_row_relative_to_the_mean(self):
        for n in (1, 2, 600):
            with self.subTest(n=n):
                station = f"T{n}"
                raw = self.insert(station, self.wave(n))
                got = self.series(station)
                self.assertEqual(len(got), n)
                self.assert_matches_reference(got, raw)

    def test_null_values_are_ignored_and_empty_windows_return_nothing(self):
        values = self.wave(1500)
        for i in range(0, 1500, 7):
            values[i] = None
        raw = self.insert("NUL", values)
        got = self.series("NUL")
        self.assertTrue(all(p["value"] is not None for p in got))
        self.assert_matches_reference(got, raw)
        self.assertEqual(self.series("NONE"), [])
        self.assertEqual(self.series("NUL", cutoff=self.START + timedelta(days=1)), [])

    def test_cutoff_limits_the_window_and_the_baseline(self):
        raw = self.insert("WIN", self.wave(2000))
        cutoff = raw[1000]["timestamp"]
        got = self.series("WIN", cutoff=cutoff)
        self.assertEqual(got[0]["time"], cutoff)
        self.assert_matches_reference(got, raw[1000:])

    def test_fmi_endpoint_end_to_end(self):
        with self.db.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS magnetometer_fmi (station VARCHAR(10), timestamp DATETIME, "
                "x FLOAT, y FLOAT, z FLOAT, PRIMARY KEY (station, timestamp))"
            )
            cur.execute("DELETE FROM magnetometer_fmi")
            now = datetime(2026, 11, 21, 12, 0, 0)
            rows = [("KEV", now - timedelta(seconds=10 * i), 12000.0 + (i % 97), 1.0, 1.0) for i in range(4320)]
            cur.executemany("INSERT INTO magnetometer_fmi VALUES (%s, %s, %s, %s, %s)", rows)
        with (
            mock.patch.object(main, "get_db", side_effect=connect),
            mock.patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = now
            result = main.magneto_fmi_timeseries(stations="KEV,SOD", hours=12, component="x")
        self.assertEqual(list(result["data"]), ["KEV"])
        self.assertEqual(result["missing"], {"SOD": None})  # never reported
        series = result["data"]["KEV"]
        self.assertLessEqual(len(series), main.MAGNETOMETER_MAX_POINTS)
        self.assertEqual(series[-1]["time"], now)


if __name__ == "__main__":
    unittest.main()
