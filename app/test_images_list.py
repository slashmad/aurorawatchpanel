import inspect
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main
import routes_skyfield


class ImagesListTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.image_root = Path(self.temp_dir.name)

    def create_images(self, key, count):
        category_dir = self.image_root / key
        category_dir.mkdir()
        for index in range(count):
            (category_dir / f"{key}_20260801T{index:06d}Z.jpg").touch()

    def list_images(self, label, limit=None):
        with patch.object(main, "DATA_IMAGE_DIR", self.image_root):
            return main.images_list(label=label, limit=limit)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.images_list))

    def test_sdo_default_is_bounded_newest_first(self):
        self.create_images("SDO_193", main.DEFAULT_IMAGE_LIST_LIMIT + 2)

        result = self.list_images("SDO/AIA 193")

        self.assertEqual(len(result["files"]), main.DEFAULT_IMAGE_LIST_LIMIT)
        self.assertTrue(result["has_more"])
        self.assertEqual(result["limit"], main.DEFAULT_IMAGE_LIST_LIMIT)
        self.assertGreater(result["files"][0], result["files"][-1])

    def test_explicit_limit_applies_to_synoptic(self):
        self.create_images("Synoptic", 3)

        result = self.list_images("Synoptic Map", limit=2)

        self.assertEqual(len(result["files"]), 2)
        self.assertTrue(result["has_more"])
        self.assertEqual(result["limit"], 2)

    def test_synoptic_default_preserves_date_history(self):
        self.create_images("Synoptic", 3)

        result = self.list_images("Synoptic Map")

        self.assertEqual(len(result["files"]), 3)
        self.assertFalse(result["has_more"])
        self.assertIsNone(result["limit"])

    def test_limit_contract_is_bounded(self):
        self.assertEqual(main.DEFAULT_IMAGE_LIST_LIMIT, 240)
        self.assertEqual(main.MAX_IMAGE_LIST_LIMIT, 1000)

    def test_all_labels_preserve_directory_mapping(self):
        label_keys = {
            "SDO/AIA 131": "SDO_131",
            "SDO/AIA 171": "SDO_171",
            "SDO/AIA 193": "SDO_193",
            "SDO/AIA 211": "SDO_211",
            "SDO/AIA 304": "SDO_304",
            "SDO/AIA HMIIF": "SDO_HMIIF",
            "Synoptic Map": "Synoptic",
        }

        for label, key in label_keys.items():
            with self.subTest(label=label):
                self.create_images(key, 1)

                result = self.list_images(label, limit=1)

                self.assertEqual(result, {
                    "files": [f"{key}/{key}_20260801T000000Z.jpg"],
                    "limit": 1,
                    "has_more": False,
                })

    def test_unknown_label_preserves_empty_response_metadata(self):
        result = self.list_images("Unknown", limit=7)

        self.assertEqual(result, {
            "files": [],
            "limit": 7,
            "has_more": False,
        })


class NoaaAnimationListEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.noaa_root = Path(self.temp_dir.name)

    def call_endpoint(self, product):
        with patch.object(main, "Path", return_value=self.noaa_root):
            return main.list_noaa_images(product=product)

    def response_json(self, response):
        return json.loads(response.body)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.list_noaa_images))

    def test_missing_or_non_directory_product_preserves_empty_json_response(self):
        (self.noaa_root / "plain-file").touch()

        for product in ("missing", "plain-file"):
            with self.subTest(product=product):
                response = self.call_endpoint(product)

                self.assertIsInstance(response, main.JSONResponse)
                self.assertEqual(self.response_json(response), {"files": []})

    def test_existing_product_preserves_extension_filter_and_sort_order(self):
        product_dir = self.noaa_root / "enlil"
        product_dir.mkdir()
        for filename in ("z.jpg", "a.png", "m.gif", "ignored.txt", "upper.JPG"):
            (product_dir / filename).touch()
        (product_dir / "nested.jpg").mkdir()

        response = self.call_endpoint("enlil")

        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(
            self.response_json(response),
            {"files": ["a.png", "m.gif", "z.jpg"]},
        )


class HuxtListEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.huxt_path = Path(self.temp_dir.name) / "huxt"

    def call_endpoint(self):
        with patch.object(main, "Path", return_value=self.huxt_path):
            return main.list_huxt_files()

    def response_json(self, response):
        return json.loads(response.body)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.list_huxt_files))

    def test_missing_or_non_directory_path_preserves_empty_json_response(self):
        response = self.call_endpoint()
        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(self.response_json(response), {"files": []})

        self.huxt_path.touch()
        response = self.call_endpoint()
        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(self.response_json(response), {"files": []})

    def test_existing_path_preserves_mp4_filter_and_sort_order(self):
        self.huxt_path.mkdir()
        for filename in ("z.mp4", "a.mp4", "ignored.txt", "upper.MP4"):
            (self.huxt_path / filename).touch()
        (self.huxt_path / "nested.mp4").mkdir()

        response = self.call_endpoint()

        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(
            self.response_json(response),
            {"files": ["a.mp4", "z.mp4"]},
        )


class AllskyLatestEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.local_root = Path(self.temp_dir.name) / "lyckebocam"
        self.cache_patcher = patch.dict(main._ALLSKY_CACHE_BY_CAM, {}, clear=True)
        self.cache_patcher.start()
        self.addCleanup(self.cache_patcher.stop)

    def call_endpoint(self, cam="ytterboda", date=None):
        return main.allsky_latest(cam=cam, date=date)

    def response_json(self, response):
        return json.loads(response.body)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.allsky_latest))

    def test_thumbnails_consumer_calls_synchronous_latest_directly(self):
        latest_error = {"error": "latest unavailable"}

        with patch.object(
            main,
            "allsky_latest",
            return_value=latest_error,
        ) as latest:
            result = main.allsky_thumbnails(
                cam="ytterboda",
                date="20260804",
            )

        self.assertIs(result, latest_error)
        latest.assert_called_once_with(
            cam="ytterboda",
            date="20260804",
        )

    def test_invalid_camera_preserves_400_json_error_without_cache_write(self):
        response = self.call_endpoint(cam="unknown")

        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            self.response_json(response),
            {"error": "Unknown cam: unknown"},
        )
        self.assertEqual(main._ALLSKY_CACHE_BY_CAM, {})

    def test_cache_hit_and_exact_expiry_boundary_are_preserved(self):
        cached = {"url": "cached"}
        main._ALLSKY_CACHE_BY_CAM["ytterboda"] = {
            "ts": 80.5,
            "data": cached,
        }

        with (
            patch.object(main.time, "time", return_value=100.0),
            patch.object(main, "_allsky_remote_slashmad_latest") as remote_latest,
        ):
            result = self.call_endpoint()

        self.assertIs(result, cached)
        remote_latest.assert_not_called()

        stale = {"url": "stale"}
        refreshed = {"error": "upstream unavailable"}
        main._ALLSKY_CACHE_BY_CAM["ytterboda"] = {
            "ts": 80.0,
            "data": stale,
        }
        with (
            patch.object(main.time, "time", return_value=100.0),
            patch.object(
                main,
                "_allsky_remote_slashmad_latest",
                return_value=refreshed,
            ) as remote_latest,
        ):
            result = self.call_endpoint()

        self.assertIs(result, refreshed)
        remote_latest.assert_called_once_with(
            main.ALLSKY_CAMERAS["ytterboda"]["base"],
            None,
        )
        self.assertEqual(
            main._ALLSKY_CACHE_BY_CAM["ytterboda"],
            {"ts": 100.0, "data": refreshed},
        )

    def test_ytterboda_normalization_date_and_cache_write_are_preserved(self):
        remote_result = {
            "date": "20260803",
            "filename": "image-20260803235959.jpg",
            "url": "https://example.invalid/image.jpg",
            "captured": "23:59:59",
        }
        with (
            patch.object(main.time, "time", return_value=123.0),
            patch.object(
                main,
                "_allsky_remote_slashmad_latest",
                return_value=remote_result,
            ) as remote_latest,
        ):
            result = self.call_endpoint(
                cam=" YTTERBODA ",
                date="20260803",
            )

        self.assertIs(result, remote_result)
        remote_latest.assert_called_once_with(
            main.ALLSKY_CAMERAS["ytterboda"]["base"],
            "20260803",
        )
        self.assertEqual(
            main._ALLSKY_CACHE_BY_CAM["ytterboda"],
            {"ts": 123.0, "data": remote_result},
        )

    def test_tavelsjo_latest_file_mapping_and_cache_write_are_preserved(self):
        day_dir = self.local_root / "2026/08/04"
        day_dir.mkdir(parents=True)
        for filename in (
            "Lyckebo_20260804T010000Z.jpg",
            "Lyckebo_20260804T020304Z.png",
            "Lyckebo_20260804T999999Z.txt",
            "invalid.jpg",
        ):
            (day_dir / filename).touch()
        (day_dir / "Lyckebo_20260804T030000Z.jpg").mkdir()
        camera = {
            "type": "local",
            "root": str(self.local_root),
            "thumb_dir": "thumbs",
        }

        with (
            patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}),
            patch.object(main.time, "time", return_value=200.0),
        ):
            result = self.call_endpoint(cam="TAVELSJO", date="20260804")

        expected = {
            "date": "20260804",
            "filename": "Lyckebo_20260804T020304Z.png",
            "url": "/data/images/lyckebocam/2026/08/04/Lyckebo_20260804T020304Z.png",
            "captured": "02:03:04",
        }
        self.assertEqual(result, expected)
        self.assertEqual(
            main._ALLSKY_CACHE_BY_CAM["tavelsjo"],
            {"ts": 200.0, "data": expected},
        )

    def test_tavelsjo_missing_folder_and_empty_folder_errors_are_not_cached(self):
        camera = {
            "type": "local",
            "root": str(self.local_root),
            "thumb_dir": "thumbs",
        }
        with patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}):
            with self.subTest(case="missing"):
                result = self.call_endpoint(cam="tavelsjo", date="20260804")
                self.assertEqual(
                    result,
                    {"error": "No local AllSky folder for 20260804"},
                )
                self.assertEqual(main._ALLSKY_CACHE_BY_CAM, {})

            day_dir = self.local_root / "2026/08/04"
            day_dir.mkdir(parents=True)
            (day_dir / "invalid.jpg").touch()
            with self.subTest(case="empty"):
                result = self.call_endpoint(cam="tavelsjo", date="20260804")
                self.assertEqual(
                    result,
                    {"error": "No local AllSky images found for 20260804"},
                )
                self.assertEqual(main._ALLSKY_CACHE_BY_CAM, {})

    def test_kiruna_delegation_and_cache_write_are_preserved(self):
        remote_result = {
            "date": "20260804",
            "filename": "2026-08-04T23.59.59.000KRN.jpeg",
            "url": "https://example.invalid/kiruna.jpeg",
            "captured": "23:59:59",
        }
        with (
            patch.object(main.time, "time", return_value=300.0),
            patch.object(
                main,
                "_allsky_kiruna_latest",
                return_value=remote_result,
            ) as kiruna_latest,
        ):
            result = self.call_endpoint(cam="KIRUNA", date="20260803")

        self.assertIs(result, remote_result)
        kiruna_latest.assert_called_once_with(
            main.ALLSKY_CAMERAS["kiruna"]["base"],
        )
        self.assertEqual(
            main._ALLSKY_CACHE_BY_CAM["kiruna"],
            {"ts": 300.0, "data": remote_result},
        )

    def test_unsupported_camera_type_preserves_error_and_cache_write(self):
        camera = {"type": "unsupported"}
        with (
            patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}),
            patch.object(main.time, "time", return_value=400.0),
        ):
            result = self.call_endpoint(cam="tavelsjo")

        expected = {"error": "Unsupported cam type: unsupported"}
        self.assertEqual(result, expected)
        self.assertEqual(
            main._ALLSKY_CACHE_BY_CAM["tavelsjo"],
            {"ts": 400.0, "data": expected},
        )


class AllskyThumbnailsEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.local_root = Path(self.temp_dir.name) / "lyckebocam"
        self.latest_cache_patcher = patch.dict(
            main._ALLSKY_CACHE_BY_CAM,
            {},
            clear=True,
        )
        self.thumbs_cache_patcher = patch.dict(
            main._ALLSKY_THUMBS_CACHE_BY_CAM,
            {},
            clear=True,
        )
        self.latest_cache_patcher.start()
        self.thumbs_cache_patcher.start()
        self.addCleanup(self.latest_cache_patcher.stop)
        self.addCleanup(self.thumbs_cache_patcher.stop)

    def call_endpoint(self, latest, cam="ytterboda", date=None):
        with patch.object(
            main,
            "allsky_latest",
            return_value=latest,
        ) as latest_call:
            result = main.allsky_thumbnails(cam=cam, date=date)
        return result, latest_call

    def response_json(self, response):
        return json.loads(response.body)

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.allsky_thumbnails))

    def test_invalid_camera_preserves_400_json_error_without_latest_call(self):
        with patch.object(main, "allsky_latest") as latest:
            response = main.allsky_thumbnails(cam="unknown")

        self.assertIsInstance(response, main.JSONResponse)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            self.response_json(response),
            {"error": "Unknown cam: unknown"},
        )
        latest.assert_not_called()
        self.assertEqual(main._ALLSKY_THUMBS_CACHE_BY_CAM, {})

    def test_latest_error_is_propagated_without_thumbnail_cache_write(self):
        latest_error = {"error": "latest unavailable"}

        result, latest_call = self.call_endpoint(
            latest_error,
            cam=" YTTERBODA ",
            date="20260803",
        )

        self.assertIs(result, latest_error)
        latest_call.assert_called_once_with(
            cam="ytterboda",
            date="20260803",
        )
        self.assertEqual(main._ALLSKY_THUMBS_CACHE_BY_CAM, {})

    def test_cache_hit_and_exact_expiry_boundary_are_preserved(self):
        latest = {"date": "20260804"}
        cached = {"date": "20260804", "items": [{"filename": "cached.jpg"}]}
        cache_key = "ytterboda|20260804"
        main._ALLSKY_THUMBS_CACHE_BY_CAM[cache_key] = {
            "ts": 80.5,
            "data": cached,
        }

        with (
            patch.object(main.time, "time", return_value=100.0),
            patch.object(main, "_allsky_remote_slashmad_thumbs") as remote_thumbs,
        ):
            result, _ = self.call_endpoint(latest)

        self.assertIs(result, cached)
        remote_thumbs.assert_not_called()

        refreshed = {"date": "20260804", "items": []}
        main._ALLSKY_THUMBS_CACHE_BY_CAM[cache_key] = {
            "ts": 80.0,
            "data": cached,
        }
        with (
            patch.object(main.time, "time", return_value=100.0),
            patch.object(
                main,
                "_allsky_remote_slashmad_thumbs",
                return_value=refreshed,
            ) as remote_thumbs,
        ):
            result, _ = self.call_endpoint(latest)

        self.assertIs(result, refreshed)
        remote_thumbs.assert_called_once_with(
            main.ALLSKY_CAMERAS["ytterboda"]["base"],
            "20260804",
        )
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM[cache_key],
            {"ts": 100.0, "data": refreshed},
        )

    def test_ytterboda_uses_latest_date_for_delegation_and_cache_key(self):
        latest = {"date": "20260804"}
        remote_result = {
            "date": "20260804",
            "items": [{"filename": "image-20260804235959.jpg"}],
        }
        with (
            patch.object(main.time, "time", return_value=123.0),
            patch.object(
                main,
                "_allsky_remote_slashmad_thumbs",
                return_value=remote_result,
            ) as remote_thumbs,
        ):
            result, latest_call = self.call_endpoint(
                latest,
                cam="YTTERBODA",
                date="20260803",
            )

        self.assertIs(result, remote_result)
        latest_call.assert_called_once_with(
            cam="ytterboda",
            date="20260803",
        )
        remote_thumbs.assert_called_once_with(
            main.ALLSKY_CAMERAS["ytterboda"]["base"],
            "20260804",
        )
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM["ytterboda|20260804"],
            {"ts": 123.0, "data": remote_result},
        )

    def test_tavelsjo_items_preserve_reverse_order_and_thumbnail_fallback(self):
        day_dir = self.local_root / "2026/08/04"
        thumbs_dir = day_dir / "thumbs"
        thumbs_dir.mkdir(parents=True)
        newest = "Lyckebo_20260804T020304Z.png"
        oldest = "Lyckebo_20260804T010000Z.jpg"
        for filename in (oldest, newest, "invalid.jpg", "ignored.txt"):
            (day_dir / filename).touch()
        (day_dir / "Lyckebo_20260804T030000Z.jpg").mkdir()
        (thumbs_dir / "Lyckebo_20260804T020304Z_thumb.png").touch()
        camera = {
            "type": "local",
            "root": str(self.local_root),
            "thumb_dir": "thumbs",
        }

        with (
            patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}),
            patch.object(main.time, "time", return_value=200.0),
        ):
            result, _ = self.call_endpoint(
                {"date": "20260804"},
                cam="tavelsjo",
                date="20260803",
            )

        expected = {
            "date": "20260804",
            "items": [
                {
                    "filename": newest,
                    "captured": "02:03:04",
                    "thumb_url": "/data/images/lyckebocam/2026/08/04/thumbs/Lyckebo_20260804T020304Z_thumb.png",
                    "full_url": f"/data/images/lyckebocam/2026/08/04/{newest}",
                },
                {
                    "filename": oldest,
                    "captured": "01:00:00",
                    "thumb_url": f"/data/images/lyckebocam/2026/08/04/thumbs/{oldest}",
                    "full_url": f"/data/images/lyckebocam/2026/08/04/{oldest}",
                },
            ],
        }
        self.assertEqual(result, expected)
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM["tavelsjo|20260804"],
            {"ts": 200.0, "data": expected},
        )

    def test_tavelsjo_missing_directory_preserves_empty_cached_response(self):
        camera = {
            "type": "local",
            "root": str(self.local_root),
            "thumb_dir": "thumbs",
        }
        with (
            patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}),
            patch.object(main.time, "time", return_value=250.0),
        ):
            result, _ = self.call_endpoint(
                {"date": "20260804"},
                cam="tavelsjo",
            )

        expected = {"date": "20260804", "items": []}
        self.assertEqual(result, expected)
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM["tavelsjo|20260804"],
            {"ts": 250.0, "data": expected},
        )

    def test_kiruna_delegation_and_cache_write_are_preserved(self):
        latest = {"date": "20260804"}
        remote_result = {
            "date": "20260804",
            "items": [{"filename": "2026-08-04T23.59.59.000KRN.jpeg"}],
        }
        with (
            patch.object(main.time, "time", return_value=300.0),
            patch.object(
                main,
                "_allsky_kiruna_thumbs",
                return_value=remote_result,
            ) as kiruna_thumbs,
        ):
            result, _ = self.call_endpoint(latest, cam="KIRUNA")

        self.assertIs(result, remote_result)
        kiruna_thumbs.assert_called_once_with(
            main.ALLSKY_CAMERAS["kiruna"]["base"],
            "20260804",
        )
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM["kiruna|20260804"],
            {"ts": 300.0, "data": remote_result},
        )

    def test_unsupported_camera_type_preserves_empty_cached_response(self):
        camera = {"type": "unsupported"}
        with (
            patch.dict(main.ALLSKY_CAMERAS, {"tavelsjo": camera}),
            patch.object(main.time, "time", return_value=400.0),
        ):
            result, _ = self.call_endpoint(
                {"date": "20260804"},
                cam="tavelsjo",
            )

        expected = {"date": "20260804", "items": []}
        self.assertEqual(result, expected)
        self.assertEqual(
            main._ALLSKY_THUMBS_CACHE_BY_CAM["tavelsjo|20260804"],
            {"ts": 400.0, "data": expected},
        )


class AllskyBrowserEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name) / "allsky"
        self.root.mkdir()

    def call_endpoint(self, path=""):
        with patch.object(main, "ALLSKY_FS_ROOT", self.root):
            return main.allsky_browser(p=path)

    def response_text(self, response):
        return response.body.decode("utf-8")

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.allsky_browser))

    def test_traversal_and_resolved_escape_preserve_400_response(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        (self.root / "escape").symlink_to(outside, target_is_directory=True)

        for path in ("../outside", "escape"):
            with self.subTest(path=path):
                response = self.call_endpoint(path)

                self.assertIsInstance(response, main.HTMLResponse)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.response_text(response), "Invalid path")

    def test_missing_path_preserves_404_response(self):
        response = self.call_endpoint("missing")

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.response_text(response), "Not found")

    def test_file_path_preserves_leading_slash_normalization_and_redirect(self):
        day_dir = self.root / "2026/08/04"
        day_dir.mkdir(parents=True)
        (day_dir / "image.jpg").touch()

        response = self.call_endpoint("/2026/08/04/image.jpg")

        self.assertIsInstance(response, main.RedirectResponse)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "/allsky-images/2026/08/04/image.jpg",
        )

    def test_directory_listing_preserves_order_escaping_and_navigation(self):
        archive = self.root / "2026/08"
        archive.mkdir(parents=True)
        oldest = archive / "old.jpg"
        middle = archive / "middle&"
        newest = archive / 'new<&".jpg'
        oldest.touch()
        middle.mkdir()
        newest.touch()
        os.utime(oldest, (100.0, 100.0))
        os.utime(middle, (200.0, 200.0))
        os.utime(newest, (300.0, 300.0))

        response = self.call_endpoint("2026/08")
        body = self.response_text(response)

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.media_type, "text/html")
        self.assertLess(
            body.index("new&lt;&amp;&quot;.jpg"),
            body.index("middle&amp;/"),
        )
        self.assertLess(body.index("middle&amp;/"), body.index("old.jpg"))
        self.assertIn(
            'href="/allsky-images/2026/08/new&lt;&amp;&quot;.jpg"',
            body,
        )
        self.assertIn(
            'href="/allsky/browser?p=2026/08/middle&amp;"',
            body,
        )
        self.assertIn("AllSky archive: /2026/08", body)
        self.assertIn('href="/allsky/browser?p=2026">Up</a>', body)

    def test_entry_stat_failure_is_skipped(self):
        valid = self.root / "valid.jpg"
        broken = self.root / "broken.jpg"
        valid.touch()
        broken.touch()
        original_stat = Path.stat

        def stat_with_failure(path, *args, **kwargs):
            if path == broken:
                raise OSError("unreadable entry")
            return original_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat_with_failure):
            response = self.call_endpoint()
        body = self.response_text(response)

        self.assertIn("valid.jpg", body)
        self.assertNotIn("broken.jpg", body)

    def test_empty_root_preserves_title_up_link_and_marker(self):
        response = self.call_endpoint()
        body = self.response_text(response)

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 200)
        self.assertIn("AllSky archive: /", body)
        self.assertIn('href="/allsky/browser">Up</a>', body)
        self.assertIn("<li><em>Empty</em></li>", body)


class LyckeboBrowserEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name) / "lyckebo"
        self.root.mkdir()

    def call_endpoint(self, path=""):
        with patch.object(main, "LYCKEBO_FS_ROOT", self.root):
            return main.lyckebo_browser(p=path)

    def response_text(self, response):
        return response.body.decode("utf-8")

    def test_endpoint_is_synchronous_for_fastapi_threadpool_dispatch(self):
        self.assertFalse(inspect.iscoroutinefunction(main.lyckebo_browser))

    def test_traversal_and_resolved_escape_preserve_400_response(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        (self.root / "escape").symlink_to(outside, target_is_directory=True)

        for path in ("../outside", "escape"):
            with self.subTest(path=path):
                response = self.call_endpoint(path)

                self.assertIsInstance(response, main.HTMLResponse)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.response_text(response), "Invalid path")

    def test_missing_path_preserves_404_response(self):
        response = self.call_endpoint("missing")

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.response_text(response), "Not found")

    def test_file_path_preserves_leading_slash_normalization_and_redirect(self):
        day_dir = self.root / "2026/08/04"
        day_dir.mkdir(parents=True)
        (day_dir / "image.jpg").touch()

        response = self.call_endpoint("/2026/08/04/image.jpg")

        self.assertIsInstance(response, main.RedirectResponse)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "/data/images/lyckebocam/2026/08/04/image.jpg",
        )

    def test_directory_listing_preserves_order_escaping_and_navigation(self):
        archive = self.root / "2026/08"
        archive.mkdir(parents=True)
        oldest = archive / "old.jpg"
        middle = archive / "middle&"
        newest = archive / 'new<&".jpg'
        oldest.touch()
        middle.mkdir()
        newest.touch()
        os.utime(oldest, (100.0, 100.0))
        os.utime(middle, (200.0, 200.0))
        os.utime(newest, (300.0, 300.0))

        response = self.call_endpoint("2026/08")
        body = self.response_text(response)

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.media_type, "text/html")
        self.assertLess(
            body.index("new&lt;&amp;&quot;.jpg"),
            body.index("middle&amp;/"),
        )
        self.assertLess(body.index("middle&amp;/"), body.index("old.jpg"))
        self.assertIn(
            'href="/data/images/lyckebocam/2026/08/new&lt;&amp;&quot;.jpg"',
            body,
        )
        self.assertIn(
            'href="/lyckebo/browser?p=2026/08/middle&amp;"',
            body,
        )
        self.assertIn("Lyckebo archive: /2026/08", body)
        self.assertIn('href="/lyckebo/browser?p=2026">Up</a>', body)

    def test_entry_stat_failure_is_skipped(self):
        valid = self.root / "valid.jpg"
        broken = self.root / "broken.jpg"
        valid.touch()
        broken.touch()
        original_stat = Path.stat

        def stat_with_failure(path, *args, **kwargs):
            if path == broken:
                raise OSError("unreadable entry")
            return original_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat_with_failure):
            response = self.call_endpoint()
        body = self.response_text(response)

        self.assertIn("valid.jpg", body)
        self.assertNotIn("broken.jpg", body)

    def test_empty_root_preserves_title_up_link_and_blank_list(self):
        response = self.call_endpoint()
        body = self.response_text(response)

        self.assertIsInstance(response, main.HTMLResponse)
        self.assertEqual(response.status_code, 200)
        self.assertIn("Lyckebo archive: /", body)
        self.assertIn('href="/lyckebo/browser">Up</a>', body)
        self.assertIn("<ul>\n    \n  </ul>", body)
        self.assertNotIn("<em>Empty</em>", body)


class AstronomyImportRegressionTests(unittest.TestCase):
    def test_forecast_and_skyfield_helpers_are_available(self):
        self.assertTrue(callable(main.get_sun_moon_info))
        self.assertIs(routes_skyfield.re, re)
        self.assertTrue(hasattr(routes_skyfield.np, "array"))


if __name__ == "__main__":
    unittest.main()
