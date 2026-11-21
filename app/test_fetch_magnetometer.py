import unittest
from datetime import datetime
from unittest import mock

import fetch_magnetometer as fm

SAMPLE = """\
 Format                 IAGA-2002                                    |
 Station Name           Kiruna                                       |
 IAGA CODE              KIR                                          |
DATE       TIME         DOY     KIRX        KIRY    KIRZ      KIRF   |
2026-11-21 09:58:00.000 325     10473.90    327.37  52385.24  99999.00
2026-11-21 09:59:00.000 325     99999.00    99999.00 99999.00 99999.00
2026-11-21 10:00:00.000 325     10476.62    88888.00 52385.56  52100.10
garbage line
2026-11-21 10:01:00.000 325     not-a-number 1 2 3
"""


class ParseKirIagaTests(unittest.TestCase):
    def test_parses_data_rows_and_treats_iaga_fill_values_as_missing(self):
        rows = fm.parse_kir_iaga(SAMPLE)
        self.assertEqual([r["dt"] for r in rows], [datetime(2026, 11, 21, 9, 58), datetime(2026, 11, 21, 10, 0)])
        self.assertEqual(rows[0], {"station": "KIR", "dt": datetime(2026, 11, 21, 9, 58),
                                   "kirx": 10473.90, "kiry": 327.37, "kirz": 52385.24, "kirf": None})
        self.assertIsNone(rows[1]["kiry"])
        self.assertEqual(rows[1]["kirf"], 52100.10)

    def test_since_keeps_only_rows_at_or_after_it(self):
        rows = fm.parse_kir_iaga(SAMPLE, since=datetime(2026, 11, 21, 9, 59))
        self.assertEqual([r["dt"] for r in rows], [datetime(2026, 11, 21, 10, 0)])

    def test_empty_text_gives_no_rows(self):
        self.assertEqual(fm.parse_kir_iaga(""), [])
        self.assertEqual(fm.parse_kir_iaga(None), [])

    def test_fetch_kir_uses_the_daily_file_and_the_stored_tail(self):
        last = datetime(2026, 11, 21, 10, 5)
        with mock.patch.object(fm, "fetch_text", return_value=SAMPLE) as fetch, \
             mock.patch.object(fm, "_get_last_timestamp", return_value=last):
            rows = fm.fetch_kir()
        fetch.assert_called_once_with("https://www2.irf.se/maggraphs/rt_iaga_secondary.txt", timeout=15)
        # 10-minute overlap before the stored 10:05 keeps 09:58 and 10:00.
        self.assertEqual([r["dt"] for r in rows], [datetime(2026, 11, 21, 9, 58), datetime(2026, 11, 21, 10, 0)])


class LastTimestampTests(unittest.TestCase):
    def fake_db(self, row):
        cursor = mock.MagicMock()
        cursor.fetchone.return_value = row
        conn = mock.MagicMock()
        conn.cursor.return_value = cursor
        return conn, cursor

    def test_reads_dict_rows_from_the_dict_cursor(self):
        when = datetime(2026, 11, 21, 10, 4)
        conn, cursor = self.fake_db({"last": when})
        with mock.patch.object(fm, "get_db", return_value=conn):
            self.assertEqual(fm._get_last_timestamp("TOP"), when)
        cursor.execute.assert_called_once_with(
            "SELECT MAX(timestamp) AS last FROM magnetometer WHERE station=%s", ("TOP",))

    def test_tuple_rows_and_empty_tables(self):
        when = datetime(2026, 11, 21, 10, 4)
        for row, expected in (((when,), when), ({"last": None}, None), (None, None)):
            with self.subTest(row=row):
                conn, _ = self.fake_db(row)
                with mock.patch.object(fm, "get_db", return_value=conn):
                    self.assertEqual(fm._get_last_timestamp("KIR"), expected)


if __name__ == "__main__":
    unittest.main()
