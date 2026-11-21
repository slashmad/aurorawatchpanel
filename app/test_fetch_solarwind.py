import importlib
import unittest
from unittest import mock

# fetch_solarwind calls wait_for_db() at import time; keep the test offline.
with mock.patch("utils.wait_for_db") as _wait_for_db:
    fetch_solarwind = importlib.import_module("fetch_solarwind")
to_float = fetch_solarwind.to_float


class ToFloatTests(unittest.TestCase):
    def test_parses_numeric_values(self):
        self.assertEqual(to_float({"speed": "412.5"}, "speed"), 412.5)
        self.assertEqual(to_float({"bz": -3}, "bz"), -3.0)
        self.assertEqual(to_float({"bt": "0"}, "bt"), 0.0)

    def test_missing_empty_and_invalid_values_return_none(self):
        self.assertIsNone(to_float({}, "speed"))
        self.assertIsNone(to_float({"speed": None}, "speed"))
        self.assertIsNone(to_float({"speed": ""}, "speed"))
        self.assertIsNone(to_float({"speed": "n/a"}, "speed"))
        self.assertIsNone(to_float({"speed": [1]}, "speed"))

    def test_non_finite_values_return_none(self):
        for raw in ("NaN", "nan", "inf", "-Infinity", float("nan"), float("inf")):
            with self.subTest(raw=raw):
                self.assertIsNone(to_float({"speed": raw}, "speed"))


if __name__ == "__main__":
    unittest.main()
