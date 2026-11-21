import asyncio
import inspect
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main


class FakeRequest:
    def __init__(self, payload):
        self.payload = payload

    async def json(self):
        return self.payload


class FixedDateTime(datetime):
    @classmethod
    def utcnow(cls):
        return cls(2026, 8, 2, 12, 0, 0)


def relative_series_query(table, column):
    return main._RELATIVE_SERIES_SQL.format(table=table, column=column)


def relative_series_params(station, cutoff):
    return (station, cutoff, (main.MAGNETOMETER_MAX_POINTS - 2) // 2, main.MAGNETOMETER_MAX_POINTS)


# What the downsampling query returns for raw values 10.0, None, 14.0: the
# null row is filtered in SQL and `base` is the mean of the non-null values.
SQL_SERIES_ROWS = [
    {"timestamp": "2026-08-02T09:30:00", "v": 10.0, "base": 12.0},
    {"timestamp": "2026-08-02T10:30:00", "v": 14.0, "base": 12.0},
]


class FakeCursor:
    def __init__(self, row=None, rows=None, rows_sequence=None, error=None):
        self.row = row
        self.rows = rows
        self.rows_sequence = iter(rows_sequence) if rows_sequence is not None else None
        self.error = error
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params=None):
        self.executed.append(query if params is None else (query, params))
        if self.error:
            raise self.error

    def fetchone(self):
        return self.row

    def fetchall(self):
        if self.rows_sequence is not None:
            return next(self.rows_sequence)
        return self.rows


class FakeDatabase:
    def __init__(self, row=None, rows=None, rows_sequence=None, error=None):
        self.fake_cursor = FakeCursor(
            row=row,
            rows=rows,
            rows_sequence=rows_sequence,
            error=error,
        )
        self.close_count = 0

    def cursor(self):
        return self.fake_cursor

    def close(self):
        self.close_count += 1


class AuroraOvalEndpointTests(unittest.TestCase):
    def call_endpoint(self, database):
        with patch.object(main, "get_db", return_value=database):
            return main.get_latest_aurora_oval()

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.get_latest_aurora_oval))

    def test_latest_row_contract_and_connection_cleanup(self):
        database = FakeDatabase(row={
            "id": 17,
            "probs_json": '[[65.0, 20.0, 0.75]]',
            "probs_south_json": '[[0.0, 0.0, 0.0]]',
            "updated": "2026-08-02T12:00:00",
        })

        result = self.call_endpoint(database)

        self.assertEqual(result, {
            "coordinates": [[65.0, 20.0, 0.75]],
            "updated": "2026-08-02T12:00:00",
        })
        self.assertEqual(database.close_count, 1)
        self.assertEqual(database.fake_cursor.executed, [
            "SELECT * FROM ovation_aurora ORDER BY id DESC LIMIT 1"
        ])

    def test_empty_and_malformed_rows_preserve_error_contracts(self):
        empty_database = FakeDatabase(row=None)
        malformed_database = FakeDatabase(row={"id": 1, "probs_json": "not-json"})

        self.assertEqual(self.call_endpoint(empty_database), {"error": "No data"})
        self.assertEqual(
            self.call_endpoint(malformed_database),
            {"error": "Could not decode coordinates"},
        )
        self.assertEqual(empty_database.close_count, 1)
        self.assertEqual(malformed_database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("query failed"))

        with self.assertRaisesRegex(RuntimeError, "query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class Hp30TimeseriesEndpointTests(unittest.TestCase):
    def call_endpoint(self, database, hours=6):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.hp30_timeseries(hours=hours)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.hp30_timeseries))
        self.assertEqual(
            inspect.signature(main.hp30_timeseries).parameters["hours"].default,
            6,
        )
        self.assertEqual(main.MAX_HP30_HOURS, 720)

    def test_http_preserves_default_ui_and_thirty_day_windows(self):
        cases = (
            (None, "2026-08-02 06:00:00"),
            (3, "2026-08-02 09:00:00"),
            (12, "2026-08-02 00:00:00"),
            (720, "2026-07-03 12:00:00"),
        )

        for hours, expected_cutoff in cases:
            with self.subTest(hours=hours):
                database = FakeDatabase(rows=[])
                with (
                    patch.object(main, "get_db", return_value=database),
                    patch.object(main, "datetime", FixedDateTime),
                    TestClient(main.app) as client,
                ):
                    url = "/hp30/timeseries"
                    if hours is not None:
                        url = f"{url}?hours={hours}"
                    response = client.get(url)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"data": []})
                self.assertEqual(database.close_count, 1)
                self.assertEqual(
                    database.fake_cursor.executed,
                    [(
                        "SELECT timestamp, hp30, ap30, hp60, ap60 "
                        "FROM hp_index WHERE timestamp >= %s "
                        "ORDER BY timestamp ASC",
                        (expected_cutoff,),
                    )],
                )

    def test_http_rejects_out_of_range_before_database_access(self):
        for hours in (-1, 0, 721):
            with self.subTest(hours=hours):
                with (
                    patch.object(main, "get_db") as get_db_mock,
                    TestClient(main.app) as client,
                ):
                    response = client.get(f"/hp30/timeseries?hours={hours}")

                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json()["detail"][0]["loc"],
                    ["query", "hours"],
                )
                get_db_mock.assert_not_called()

    def test_response_filter_query_and_connection_cleanup_are_preserved(self):
        retained_hp30 = {
            "timestamp": "2026-08-02T06:30:00",
            "hp30": 12.5,
            "ap30": 5,
            "hp60": None,
            "ap60": None,
        }
        filtered_empty = {
            "timestamp": "2026-08-02T07:00:00",
            "hp30": None,
            "ap30": 4,
            "hp60": None,
            "ap60": 3,
        }
        retained_hp60 = {
            "timestamp": "2026-08-02T07:30:00",
            "hp30": None,
            "ap30": None,
            "hp60": 9.5,
            "ap60": 4,
        }
        database = FakeDatabase(rows=[retained_hp30, filtered_empty, retained_hp60])

        result = self.call_endpoint(database, hours=6)

        self.assertEqual(result, {"data": [retained_hp30, retained_hp60]})
        self.assertEqual(database.close_count, 1)
        self.assertEqual(database.fake_cursor.executed, [(
            "SELECT timestamp, hp30, ap30, hp60, ap60 FROM hp_index "
            "WHERE timestamp >= %s ORDER BY timestamp ASC",
            ("2026-08-02 06:00:00",),
        )])

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("hp query failed"))

        with self.assertRaisesRegex(RuntimeError, "hp query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class KpTimeseriesEndpointTests(unittest.TestCase):
    def call_endpoint(self, database, hours=3):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.kp_timeseries(hours=hours)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.kp_timeseries))

    def test_response_mapping_query_and_connection_cleanup_are_preserved(self):
        database = FakeDatabase(rows=[
            {"timestamp": "2026-08-02T09:30:00", "kp": 3.0},
            {"timestamp": "2026-08-02T10:00:00", "kp": None},
            {"timestamp": "2026-08-02T10:30:00", "kp": 0.0},
        ])

        result = self.call_endpoint(database, hours=3)

        self.assertEqual(result, {"data": [
            {"time": "2026-08-02T09:30:00", "kp": 3.0},
            {"time": "2026-08-02T10:30:00", "kp": 0.0},
        ]})
        self.assertEqual(database.close_count, 1)
        self.assertEqual(database.fake_cursor.executed, [(
            "SELECT timestamp, kp FROM kp_index "
            "WHERE timestamp >= %s ORDER BY timestamp ASC",
            ("2026-08-02 09:00:00",),
        )])

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("kp query failed"))

        with self.assertRaisesRegex(RuntimeError, "kp query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class SolarwindTimeseriesEndpointTests(unittest.TestCase):
    def call_endpoint(self, database, param="bz", hours=3):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.solarwind_timeseries(param=param, hours=hours)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.solarwind_timeseries))

    def test_invalid_parameter_preserves_error_without_opening_database(self):
        with patch.object(main, "get_db") as get_db_mock:
            result = main.solarwind_timeseries(param="invalid")

        self.assertEqual(result, {"error": "Ogiltig parameter"})
        get_db_mock.assert_not_called()

    def test_allowed_columns_mapping_query_and_cleanup_are_preserved(self):
        for param in ("speed", "density", "bt", "bz", "by"):
            with self.subTest(param=param):
                database = FakeDatabase(rows=[
                    {"timestamp": "2026-08-02T09:30:00", param: None},
                    {"timestamp": "2026-08-02T10:00:00", param: 0.0},
                ])

                result = self.call_endpoint(database, param=param, hours=3)

                self.assertEqual(result, {"data": [
                    {"time": "2026-08-02T10:00:00", "value": 0.0},
                ]})
                self.assertEqual(database.close_count, 1)
                self.assertEqual(database.fake_cursor.executed, [(
                    f"SELECT timestamp, `{param}` FROM solarwind "
                    "WHERE timestamp >= %s ORDER BY timestamp ASC",
                    ("2026-08-02 09:00:00",),
                )])

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("solarwind query failed"))

        with self.assertRaisesRegex(RuntimeError, "solarwind query failed"):
            self.call_endpoint(database, param="bz")

        self.assertEqual(database.close_count, 1)


class MagnetoTimeseriesMultiEndpointTests(unittest.TestCase):
    def call_endpoint(self, database, stations="KIR", hours=3, component="x"):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.magneto_timeseries_multi(
                stations=stations,
                hours=hours,
                component=component,
            )

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.magneto_timeseries_multi))

    def test_station_parsing_baseline_queries_and_cleanup_are_preserved(self):
        database = FakeDatabase(rows=SQL_SERIES_ROWS)

        result = self.call_endpoint(
            database,
            stations=" kir, , abc ",
            hours=3,
            component="Y",
        )

        expected_series = [
            {"time": "2026-08-02T09:30:00", "value": -2.0},
            {"time": "2026-08-02T10:30:00", "value": 2.0},
        ]
        self.assertEqual(result["data"], {
            "KIR": expected_series,
            "ABC": expected_series,
        })
        self.assertEqual(result["missing"], {})
        self.assertEqual(database.close_count, 1)
        query = relative_series_query("magnetometer", "kiry")
        self.assertEqual(database.fake_cursor.executed, [
            (query, relative_series_params("KIR", "2026-08-02 09:00:00")),
            (query, relative_series_params("ABC", "2026-08-02 09:00:00")),
        ])

    def test_component_mapping_and_invalid_fallback_are_preserved(self):
        for component, column in (
            ("x", "kirx"),
            ("y", "kiry"),
            ("z", "kirz"),
            ("invalid", "kirx"),
        ):
            with self.subTest(component=component):
                database = FakeDatabase(rows=[
                    {"timestamp": "2026-08-02T10:00:00", "v": 5.0, "base": 5.0},
                ])

                result = self.call_endpoint(database, component=component)

                self.assertEqual(result["data"], {
                    "KIR": [{"time": "2026-08-02T10:00:00", "value": 0.0}],
                })
                self.assertEqual(result["missing"], {})
                self.assertEqual(
                    database.fake_cursor.executed[0][0],
                    relative_series_query("magnetometer", column),
                )
                self.assertEqual(database.close_count, 1)

    def test_empty_station_list_preserves_empty_response_and_cleanup(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database, stations=" , ")

        self.assertEqual(result, {"data": {}, "missing": {}})
        self.assertEqual(database.fake_cursor.executed, [])
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("magnetometer query failed"))

        with self.assertRaisesRegex(RuntimeError, "magnetometer query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class MagnetoUitTimeseriesEndpointTests(unittest.TestCase):
    DEFAULT_STATIONS = (
        "TRO", "NOR", "SOR", "AND", "RST", "JCK", "DON", "RVK",
        "DOB", "SOL", "HAR", "KAR", "NAL", "LYR", "HOP", "BJN",
    )

    def call_endpoint(self, database, **kwargs):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.magneto_uit_timeseries(**kwargs)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.magneto_uit_timeseries))

    def test_default_station_order_empty_series_and_cleanup_are_preserved(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database)

        self.assertEqual(result, {
            "data": {station: [] for station in self.DEFAULT_STATIONS},
        })
        query = (
            "SELECT timestamp, `D_deg` FROM magnetometer_uit_gif "
            "WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC"
        )
        self.assertEqual(database.fake_cursor.executed, [
            (query, (station, "2026-08-02 09:00:00"))
            for station in self.DEFAULT_STATIONS
        ])
        self.assertEqual(database.close_count, 1)

    def test_component_mapping_rounding_filtering_and_queries_are_preserved(self):
        for component, column in (
            ("x", "D_deg"),
            ("y", "H_nT"),
            ("z", "Z_nT"),
            ("invalid", "D_deg"),
        ):
            with self.subTest(component=component):
                rows = [
                    {"timestamp": "2026-08-02T09:30:00", column: 1.23456},
                    {"timestamp": "2026-08-02T10:00:00", column: None},
                ]
                database = FakeDatabase(rows=rows)

                result = self.call_endpoint(
                    database,
                    stations=" tro, , nor ",
                    hours=3,
                    component=component,
                )

                expected_series = [
                    {"time": "2026-08-02T09:30:00", "value": 1.235},
                ]
                self.assertEqual(result, {"data": {
                    "TRO": expected_series,
                    "NOR": expected_series,
                }})
                query = (
                    f"SELECT timestamp, `{column}` FROM magnetometer_uit_gif "
                    "WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC"
                )
                self.assertEqual(database.fake_cursor.executed, [
                    (query, ("TRO", "2026-08-02 09:00:00")),
                    (query, ("NOR", "2026-08-02 09:00:00")),
                ])
                self.assertEqual(database.close_count, 1)

    def test_empty_station_list_preserves_empty_response_and_cleanup(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database, stations=" , ")

        self.assertEqual(result, {"data": {}})
        self.assertEqual(database.fake_cursor.executed, [])
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("UiT query failed"))

        with self.assertRaisesRegex(RuntimeError, "UiT query failed"):
            self.call_endpoint(database, stations="TRO")

        self.assertEqual(database.close_count, 1)


class KindexTimeseriesEndpointTests(unittest.TestCase):
    def call_endpoint(self, database, **kwargs):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.kindex_timeseries(**kwargs)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.kindex_timeseries))

    def test_default_stations_mapping_queries_and_cleanup_are_preserved(self):
        database = FakeDatabase(rows=[
            {"timestamp": datetime(2026, 8, 2, 9, 30), "k_index": None},
            {"timestamp": datetime(2026, 8, 2, 10, 0), "k_index": 0},
            {"timestamp": datetime(2026, 8, 2, 10, 30), "k_index": 4},
        ])

        result = self.call_endpoint(database)

        expected_series = [
            {"time": "2026-08-02T10:00:00Z", "k_index": 0},
            {"time": "2026-08-02T10:30:00Z", "k_index": 4},
        ]
        self.assertEqual(result, {"data": {
            "KIR": expected_series,
            "TOP": expected_series,
        }})
        query = (
            "SELECT timestamp, k_index FROM magnetometer_kindex "
            "WHERE station = %s AND timestamp >= %s ORDER BY timestamp ASC"
        )
        self.assertEqual(database.fake_cursor.executed, [
            (query, ("KIR", "2026-08-02 09:00:00")),
            (query, ("TOP", "2026-08-02 09:00:00")),
        ])
        self.assertEqual(database.close_count, 1)

    def test_station_normalization_and_empty_input_are_preserved(self):
        normalized_database = FakeDatabase(rows=[])
        empty_database = FakeDatabase(rows=[])

        normalized_result = self.call_endpoint(
            normalized_database,
            stations=" kir, , top ",
        )
        empty_result = self.call_endpoint(empty_database, stations=" , ")

        self.assertEqual(normalized_result, {"data": {"KIR": [], "TOP": []}})
        self.assertEqual(empty_result, {"data": {}})
        self.assertEqual(len(normalized_database.fake_cursor.executed), 2)
        self.assertEqual(empty_database.fake_cursor.executed, [])
        self.assertEqual(normalized_database.close_count, 1)
        self.assertEqual(empty_database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("K-index query failed"))

        with self.assertRaisesRegex(RuntimeError, "K-index query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class MagnetoFmiTimeseriesEndpointTests(unittest.TestCase):
    DEFAULT_STATIONS = (
        "KEV", "MAS", "KIL", "IVA", "MUO", "SOD", "PEL",
        "RAN", "OUJ", "MEK", "HAN", "NUR", "TAR",
    )

    def call_endpoint(self, database, **kwargs):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.magneto_fmi_timeseries(**kwargs)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.magneto_fmi_timeseries))

    def test_default_station_order_and_empty_series_omission_are_preserved(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database)

        self.assertEqual(result, {
            "data": {},
            "missing": {station: None for station in self.DEFAULT_STATIONS},
        })
        query = relative_series_query("magnetometer_fmi", "x")
        last_seen = "SELECT MAX(timestamp) AS last FROM magnetometer_fmi WHERE station = %s"
        self.assertEqual(database.fake_cursor.executed, [
            call
            for station in self.DEFAULT_STATIONS
            for call in (
                (query, relative_series_params(station, "2026-08-02 09:00:00")),
                (last_seen, (station,)),
            )
        ])
        self.assertEqual(database.close_count, 1)

    def test_component_mapping_baseline_filtering_and_queries_are_preserved(self):
        for component, column in (
            ("x", "x"),
            ("Y", "y"),
            ("z", "z"),
            ("invalid", "x"),
        ):
            with self.subTest(component=component):
                database = FakeDatabase(rows=SQL_SERIES_ROWS)

                result = self.call_endpoint(
                    database,
                    stations=" kev, , mas ",
                    component=component,
                )

                expected_series = [
                    {"time": "2026-08-02T09:30:00", "value": -2.0},
                    {"time": "2026-08-02T10:30:00", "value": 2.0},
                ]
                self.assertEqual(result["data"], {
                    "KEV": expected_series,
                    "MAS": expected_series,
                })
                self.assertEqual(result["missing"], {})
                query = relative_series_query("magnetometer_fmi", column)
                self.assertEqual(database.fake_cursor.executed, [
                    (query, relative_series_params("KEV", "2026-08-02 09:00:00")),
                    (query, relative_series_params("MAS", "2026-08-02 09:00:00")),
                ])
                self.assertEqual(database.close_count, 1)

    def test_empty_station_list_preserves_empty_response_and_cleanup(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database, stations=" , ")

        self.assertEqual(result, {"data": {}, "missing": {}})
        self.assertEqual(database.fake_cursor.executed, [])
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("FMI query failed"))

        with self.assertRaisesRegex(RuntimeError, "FMI query failed"):
            self.call_endpoint(database, stations="KEV")

        self.assertEqual(database.close_count, 1)


class MagnetoGlobalTimeseriesEndpointTests(unittest.TestCase):
    DEFAULT_STATIONS = ("BOU", "FRD", "BRW", "CMO")

    def call_endpoint(self, database, **kwargs):
        fixed_now = datetime(2026, 8, 2, 12, 0, 0)
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime") as datetime_mock,
        ):
            datetime_mock.utcnow.return_value = fixed_now
            return main.magneto_global_timeseries(**kwargs)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.magneto_global_timeseries))

    def test_default_station_order_and_empty_series_omission_are_preserved(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database)

        self.assertEqual(result, {
            "data": {},
            "missing": {station: None for station in self.DEFAULT_STATIONS},
        })
        query = relative_series_query("magnetometer_global", "x")
        last_seen = "SELECT MAX(timestamp) AS last FROM magnetometer_global WHERE station = %s"
        self.assertEqual(database.fake_cursor.executed, [
            call
            for station in self.DEFAULT_STATIONS
            for call in (
                (query, relative_series_params(station, "2026-08-02 09:00:00")),
                (last_seen, (station,)),
            )
        ])
        self.assertEqual(database.close_count, 1)

    def test_component_mapping_baseline_filtering_and_queries_are_preserved(self):
        for component, column in (
            ("x", "x"),
            ("Y", "y"),
            ("z", "z"),
            ("invalid", "x"),
        ):
            with self.subTest(component=component):
                database = FakeDatabase(rows=SQL_SERIES_ROWS)

                result = self.call_endpoint(
                    database,
                    stations=" bou, , frd ",
                    component=component,
                )

                expected_series = [
                    {"time": "2026-08-02T09:30:00", "value": -2.0},
                    {"time": "2026-08-02T10:30:00", "value": 2.0},
                ]
                self.assertEqual(result["data"], {
                    "BOU": expected_series,
                    "FRD": expected_series,
                })
                self.assertEqual(result["missing"], {})
                query = relative_series_query("magnetometer_global", column)
                self.assertEqual(database.fake_cursor.executed, [
                    (query, relative_series_params("BOU", "2026-08-02 09:00:00")),
                    (query, relative_series_params("FRD", "2026-08-02 09:00:00")),
                ])
                self.assertEqual(database.close_count, 1)

    def test_empty_station_list_preserves_empty_response_and_cleanup(self):
        database = FakeDatabase(rows=[])

        result = self.call_endpoint(database, stations=" , ")

        self.assertEqual(result, {"data": {}, "missing": {}})
        self.assertEqual(database.fake_cursor.executed, [])
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("global query failed"))

        with self.assertRaisesRegex(RuntimeError, "global query failed"):
            self.call_endpoint(database, stations="BOU")

        self.assertEqual(database.close_count, 1)


class AuroraFlagsEndpointTests(unittest.TestCase):
    def test_post_keeps_async_body_parsing_and_db_helper_is_synchronous(self):
        self.assertTrue(inspect.iscoroutinefunction(main.aurora_flag))
        self.assertFalse(inspect.iscoroutinefunction(main._insert_aurora_flag))
        self.assertFalse(inspect.iscoroutinefunction(main.get_flags))

    def test_missing_post_fields_preserve_error_without_database_work(self):
        with patch.object(main, "_insert_aurora_flag") as insert_mock:
            result = asyncio.run(main.aurora_flag(FakeRequest({"timestamp": "now"})))

        self.assertEqual(result, {"error": "Missing data"})
        insert_mock.assert_not_called()

    def test_valid_post_contract_queries_and_cleanup_are_preserved(self):
        database = FakeDatabase()
        payload = {
            "timestamp": "2026-08-02 22:00:00",
            "reason": "visible",
            "bz": -4.5,
            "by": 1.25,
            "density": 6.0,
            "speed": 450.0,
        }

        with patch.object(
            main,
            "run_in_threadpool",
            new_callable=AsyncMock,
        ) as run_in_threadpool_mock:
            result = asyncio.run(main.aurora_flag(FakeRequest(payload)))

        self.assertEqual(result, {"status": "ok"})
        run_in_threadpool_mock.assert_awaited_once_with(
            main._insert_aurora_flag,
            payload,
        )

        with patch.object(main, "get_db", return_value=database):
            main._insert_aurora_flag(payload)

        self.assertEqual(database.close_count, 1)
        self.assertEqual(len(database.fake_cursor.executed), 2)
        create_query = " ".join(database.fake_cursor.executed[0].split())
        insert_query, insert_params = database.fake_cursor.executed[1]
        self.assertIn("CREATE TABLE IF NOT EXISTS aurora_flags", create_query)
        self.assertIn("INSERT IGNORE INTO aurora_flags", insert_query)
        self.assertEqual(insert_params, (
            "2026-08-02 22:00:00", "visible", -4.5, 1.25,
            6.0, 450.0, None, None,
        ))

    def test_post_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("flag insert failed"))

        with (
            patch.object(main, "get_db", return_value=database),
            self.assertRaisesRegex(RuntimeError, "flag insert failed"),
        ):
            main._insert_aurora_flag({"timestamp": "now", "reason": "test"})

        self.assertEqual(database.close_count, 1)

    def test_get_mapping_query_and_cleanup_are_preserved(self):
        database = FakeDatabase(rows=[
            {"timestamp": datetime(2026, 8, 2, 22, 5), "reason": "visible"},
        ])

        with patch.object(main, "get_db", return_value=database):
            result = main.get_flags()

        self.assertEqual(result, {"flags": [
            {"time": "2026-08-02 22:05", "reason": "visible"},
        ]})
        query = " ".join(database.fake_cursor.executed[0].split())
        self.assertEqual(
            query,
            "SELECT timestamp, reason FROM aurora_flags "
            "WHERE timestamp >= NOW() - INTERVAL 1 DAY ORDER BY timestamp DESC",
        )
        self.assertEqual(database.close_count, 1)

    def test_get_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("flags query failed"))

        with (
            patch.object(main, "get_db", return_value=database),
            self.assertRaisesRegex(RuntimeError, "flags query failed"),
        ):
            main.get_flags()

        self.assertEqual(database.close_count, 1)


class LatestHemisphericPowerEndpointTests(unittest.TestCase):
    def call_endpoint(self, database):
        with patch.object(main, "get_db", return_value=database):
            return main.latest_hemispheric_power()

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.latest_hemispheric_power))

    def test_success_contract_query_and_cleanup_are_preserved(self):
        database = FakeDatabase(row={
            "ts": "2026-08-02T22:00:00",
            "hemisphere_power_north": 42.5,
            "hemisphere_power_south": 18.0,
            "ignored": "field",
        })

        result = self.call_endpoint(database)

        self.assertEqual(result, {
            "ts": "2026-08-02T22:00:00",
            "hemispheric_power_north": 42.5,
            "hemispheric_power_south": 18.0,
        })
        self.assertEqual(database.fake_cursor.executed, [
            "SELECT ts, hemisphere_power_north, hemisphere_power_south "
            "FROM ovation_aurora ORDER BY id DESC LIMIT 1"
        ])
        self.assertEqual(database.close_count, 1)

    def test_empty_result_preserves_error_and_cleanup(self):
        database = FakeDatabase(row=None)

        result = self.call_endpoint(database)

        self.assertEqual(result, {"error": "No HP found"})
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("HP query failed"))

        with self.assertRaisesRegex(RuntimeError, "HP query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class ByAuroraScoreSeriesEndpointTests(unittest.TestCase):
    STATIONS = (
        "KIR", "KEV", "SOD", "OUJ", "HAN", "IVA", "MEK",
        "NUR", "KIL", "RAN", "BOU", "FRD", "BRW", "CMO",
    )

    def call_endpoint(self, database, hours=6, tolerance=120):
        with (
            patch.object(main, "get_db", return_value=database),
            patch.object(main, "datetime", FixedDateTime),
        ):
            return main.by_aurora_score_series_synced(
                hours=hours,
                tolerance=tolerance,
            )

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(
            inspect.iscoroutinefunction(main.by_aurora_score_series_synced)
        )

    def test_query_order_sync_score_contract_and_cleanup_are_preserved(self):
        earth_1 = datetime(2026, 8, 2, 12, 0, 0)
        earth_2 = datetime(2026, 8, 2, 12, 1, 0)
        station_rows = [
            {"timestamp": earth_1, "kirx": 100.0},
            {"timestamp": earth_2, "kirx": 220.0},
        ]
        solarwind_rows = [
            {"timestamp": datetime(2026, 8, 2, 10, 57, 30), "by": 10.0, "bz": 0.0, "speed": 400.0},
            {"timestamp": datetime(2026, 8, 2, 10, 58, 30), "by": 10.0, "bz": 0.0, "speed": 400.0},
            {"timestamp": earth_1, "by": 0.0, "bz": 0.0, "speed": 400.0},
            {"timestamp": earth_2, "by": 0.0, "bz": 0.0, "speed": 400.0},
        ]
        database = FakeDatabase(rows_sequence=[
            station_rows,
            *([[]] * 13),
            solarwind_rows,
        ])

        result = self.call_endpoint(database)

        self.assertEqual(result, {"data": [
            {"time": earth_1, "score": 600.0, "index": 2, "by": 10.0, "bz": 0.0, "mag": 60.0},
            {"time": earth_2, "score": 600.0, "index": 2, "by": 10.0, "bz": 0.0, "mag": 60.0},
        ]})
        self.assertEqual(len(database.fake_cursor.executed), 15)
        self.assertEqual(
            database.fake_cursor.executed[0][1],
            ("KIR", "2026-08-02 06:00:00"),
        )
        self.assertEqual(
            [entry[1][0] for entry in database.fake_cursor.executed[:14]],
            list(self.STATIONS),
        )
        self.assertEqual(database.fake_cursor.executed[-1], (
            "SELECT timestamp, `by`, bz, speed FROM solarwind "
            "WHERE timestamp >= %s ORDER BY timestamp ASC",
            ("2026-08-02 06:00:00",),
        ))
        self.assertEqual(database.close_count, 1)

    def test_empty_solarwind_preserves_empty_response_and_cleanup(self):
        database = FakeDatabase(rows_sequence=[*([[]] * 14), []])

        result = self.call_endpoint(database)

        self.assertEqual(result, {"data": []})
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("score query failed"))

        with self.assertRaisesRegex(RuntimeError, "score query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


class ReplayDayEndpointTests(unittest.TestCase):
    ALL_STATIONS = (
        "KIR", "TOP",
        "KEV", "MAS", "KIL", "IVA", "MUO", "SOD", "PEL", "RAN",
        "OUJ", "MEK", "HAN", "NUR", "TAR",
        "BOU", "FRD", "BRW", "CMO",
        "TRO", "NOR", "SOR", "AND", "RST", "JCK", "DON", "RVK",
        "DOB", "SOL", "HAR", "KAR", "NAL", "LYR", "HOP", "BJN",
    )

    def call_endpoint(self, database, **kwargs):
        params = {
            "date": "2026-08-02",
            "stations": "KIR",
            "component": "x",
        }
        params.update(kwargs)
        with patch.object(main, "get_db", return_value=database):
            return main.replay_day(**params)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.replay_day))

    def test_supported_date_formats_share_the_same_utc_window(self):
        iso_window = main._parse_replay_date("2026-08-02")
        local_window = main._parse_replay_date("02/08/2026")

        self.assertEqual(iso_window, local_window)
        self.assertEqual(iso_window, (
            datetime(2026, 8, 2, 0, 0, tzinfo=main.timezone.utc),
            datetime(2026, 8, 3, 0, 0, tzinfo=main.timezone.utc),
            "20260802",
        ))

    def test_invalid_date_preserves_error_without_database_work(self):
        with patch.object(main, "get_db") as get_db_mock:
            result = main.replay_day(
                date="invalid",
                stations="KIR",
                component="x",
            )

        self.assertEqual(
            result,
            {"error": "Invalid date. Use YYYY-MM-DD or DD/MM/YYYY."},
        )
        get_db_mock.assert_not_called()

    def test_complete_database_and_filesystem_contract_is_preserved(self):
        solarwind_rows = [
            {
                "timestamp": datetime(2026, 8, 2, 0, 15),
                "speed": 420.0,
                "density": 5.5,
                "bt": 7.0,
                "bz": -2.0,
                "by": 1.0,
            },
            {"timestamp": None, "speed": 999.0},
        ]
        magnetometer_rows = [
            {"timestamp": datetime(2026, 8, 2, 0, 20), "v": 10.0},
            {"timestamp": datetime(2026, 8, 2, 0, 25), "v": None},
            {"timestamp": datetime(2026, 8, 2, 0, 30), "v": 14.0},
        ]
        kp_rows = [
            {"timestamp": datetime(2026, 8, 2, 0, 0), "kp": 0.0},
            {"timestamp": datetime(2026, 8, 2, 3, 0), "kp": None},
        ]
        hp_rows = [
            {
                "timestamp": datetime(2026, 8, 2, 0, 0),
                "hp30": 12.0,
                "ap30": 4,
                "hp60": None,
                "ap60": None,
            },
            {
                "timestamp": datetime(2026, 8, 2, 1, 0),
                "hp30": None,
                "ap30": None,
                "hp60": None,
                "ap60": None,
            },
        ]
        database = FakeDatabase(rows_sequence=[
            solarwind_rows,
            magnetometer_rows,
            kp_rows,
            hp_rows,
        ])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_root = root / "data"
            image_root = data_root / "images"
            sdo_dir = image_root / "coronal-holes/2026/08/02"
            allsky_root = root / "allsky"
            allsky_day = allsky_root / "20260802"
            sdo_dir.mkdir(parents=True)
            allsky_day.mkdir(parents=True)
            sdo_file = sdo_dir / "SDO_193_20260802T000005Z_thumb.jpg"
            allsky_file = allsky_day / "image-20260802020000.jpg"
            sdo_file.write_bytes(b"sdo fixture")
            allsky_file.write_bytes(b"allsky fixture")

            with (
                patch.object(main, "DATA_DIR", data_root),
                patch.object(main, "DATA_IMAGE_DIR", image_root),
                patch.object(main, "ALLSKY_FS_ROOT", allsky_root),
            ):
                result = self.call_endpoint(
                    database,
                    component="invalid",
                )

        self.assertEqual(result, {
            "date": "2026-08-02",
            "start": "2026-08-02T00:00:00Z",
            "end": "2026-08-02T23:59:59Z",
            "solarwind": [{
                "time": "2026-08-02T00:15:00Z",
                "speed": 420.0,
                "density": 5.5,
                "bt": 7.0,
                "bz": -2.0,
                "by": 1.0,
            }],
            "magnetometer": {"KIR": [
                {"time": "2026-08-02T00:20:00Z", "value": -2.0},
                {"time": "2026-08-02T00:30:00Z", "value": 2.0},
            ]},
            "kp": [{"time": "2026-08-02T00:00:00Z", "kp": 0.0}],
            "hp": [{
                "time": "2026-08-02T00:00:00Z",
                "hp30": 12.0,
                "ap30": 4,
                "hp60": None,
                "ap60": None,
            }],
            "sdo_193": [{
                "time": "2026-08-02T00:00:05Z",
                "url": "/data/images/coronal-holes/2026/08/02/SDO_193_20260802T000005Z_thumb.jpg",
                "filename": "SDO_193_20260802T000005Z_thumb.jpg",
            }],
            "allsky": [{
                "time": "2026-08-02T00:00:00Z",
                "url": "/allsky-images/20260802/image-20260802020000.jpg",
                "filename": "image-20260802020000.jpg",
            }],
        })
        self.assertEqual(len(database.fake_cursor.executed), 4)
        magnetometer_query = " ".join(database.fake_cursor.executed[1][0].split())
        self.assertIn("SELECT timestamp, `kirx` AS v FROM magnetometer", magnetometer_query)
        self.assertEqual(database.close_count, 1)

    def test_all_expands_every_station_and_probes_four_sources(self):
        database = FakeDatabase(rows_sequence=[
            [],
            *([[]] * (len(self.ALL_STATIONS) * 4)),
            [],
            [],
        ])

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with (
                patch.object(main, "DATA_DIR", root / "data"),
                patch.object(main, "DATA_IMAGE_DIR", root / "data/images"),
                patch.object(main, "ALLSKY_FS_ROOT", root / "allsky"),
            ):
                result = self.call_endpoint(
                    database,
                    stations="ALL",
                    component="z",
                )

        self.assertEqual(tuple(result["magnetometer"]), self.ALL_STATIONS)
        self.assertTrue(all(series == [] for series in result["magnetometer"].values()))
        self.assertEqual(
            len(database.fake_cursor.executed),
            1 + len(self.ALL_STATIONS) * 4 + 2,
        )
        self.assertEqual(database.close_count, 1)

    def test_query_failure_closes_connection_and_propagates(self):
        database = FakeDatabase(error=RuntimeError("replay query failed"))

        with self.assertRaisesRegex(RuntimeError, "replay query failed"):
            self.call_endpoint(database)

        self.assertEqual(database.close_count, 1)


if __name__ == "__main__":
    unittest.main()


class IndexRouteTests(unittest.TestCase):
    def test_index_answers_get_and_head(self):
        client = TestClient(main.app)
        get = client.get("/")
        head = client.head("/")
        self.assertEqual(get.status_code, 200)
        self.assertEqual(head.status_code, 200)
        self.assertIn("text/html", head.headers["content-type"])
        self.assertEqual(head.content, b"")
