from __future__ import annotations

import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any

import requests
from fastapi import APIRouter, Query


weather_router = APIRouter(prefix="/proxy/weather")

CACHE_TTL = 900
HTTP_USER_AGENT = os.getenv("WEATHER_USER_AGENT", "Aurora-Watch/1.0")

SMHI_POINT_URL = (
    "https://opendata-download-metfcst.smhi.se/"
    "api/category/snow1g/version/1/geotype/point/"
    "lon/{lon}/lat/{lat}/data.json"
)

# Dessa fält ska finnas när SNOW1-punktanropet returnerar komplett data.
# Saknas de används nästa väderkälla i fallback-kedjan i stället för att
# cache:a och visa ett ofullständigt SMHI-svar.
SMHI_REQUIRED_FIELDS = frozenset(
    {
        "air_temperature",
        "relative_humidity",
        "cloud_area_fraction",
        "wind_speed",
        "symbol_code",
    }
)

_weather_cache: dict[tuple[Any, ...], tuple[int, Any]] = {}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc)


def _cache_get(source: str, key: str, country: str | None = None):
    now = int(time.time())
    cache_key = (source, country, key) if country else (source, key)
    cached = _weather_cache.get(cache_key)

    if not cached:
        return None

    cached_at, data = cached

    if now - cached_at < CACHE_TTL:
        return data

    # Undvik att utgångna poster ligger kvar för alltid.
    _weather_cache.pop(cache_key, None)
    return None


def _cache_set(source: str, key: str, data, country: str | None = None) -> None:
    cache_key = (source, country, key) if country else (source, key)
    _weather_cache[cache_key] = (int(time.time()), data)


def norm_coord_key(lat, lon, decimals: int = 2) -> str:
    """
    Returnerar avrundade koordinater som "lat,lon".

    Två decimaler motsvarar ungefär kilometernivå och är tillräckligt för
    prognosernas gridupplösning samt för att begränsa antalet cacheposter.
    """

    if lat is None or lon is None:
        return "none,none"

    rounded_lat = round(float(lat), decimals)
    rounded_lon = round(float(lon), decimals)
    return f"{rounded_lat},{rounded_lon}"


def _list_value(mapping: dict, names: tuple[str, ...], index: int):
    """Returnera värde från första existerande listnyckel utan IndexError."""

    for name in names:
        values = mapping.get(name)
        if isinstance(values, list) and index < len(values):
            return values[index]

    return None


def normalize_openmeteo(payload: dict) -> list[dict]:
    result: list[dict] = []
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    now_utc = _utc_now()

    for index, time_string in enumerate(times):
        valid_time = _parse_iso_utc(time_string)

        if valid_time is None or valid_time < now_utc:
            continue

        result.append(
            {
                "tid": time_string,
                "temp": _list_value(hourly, ("temperature_2m",), index),
                "dew": _list_value(
                    hourly,
                    ("dew_point_2m", "dewpoint_2m"),
                    index,
                ),
                "humidity": _list_value(
                    hourly,
                    ("relative_humidity_2m",),
                    index,
                ),
                "moln": _list_value(
                    hourly,
                    ("cloud_cover", "cloudcover"),
                    index,
                ),
                "regn": _list_value(hourly, ("precipitation",), index),
                "vis": _list_value(hourly, ("visibility",), index),
                "wind": _list_value(
                    hourly,
                    ("wind_speed_10m", "windspeed_10m"),
                    index,
                ),
                "gust": _list_value(hourly, ("wind_gusts_10m",), index),
                "wind_dir": _list_value(
                    hourly,
                    ("wind_direction_10m",),
                    index,
                ),
                "symbol": _list_value(
                    hourly,
                    ("weather_code", "weathercode"),
                    index,
                ),
            }
        )

        if len(result) >= 12:
            break

    return result


def normalize_met(payload: dict) -> list[dict]:
    result: list[dict] = []
    now_utc = _utc_now()
    timeseries = (payload.get("properties") or {}).get("timeseries") or []

    for item in timeseries:
        time_string = item.get("time")
        valid_time = _parse_iso_utc(time_string)

        if valid_time is None or valid_time < now_utc:
            continue

        data = item.get("data") or {}
        details = (data.get("instant") or {}).get("details") or {}
        next_hour = data.get("next_1_hours") or {}
        next_hour_details = next_hour.get("details") or {}
        next_hour_summary = next_hour.get("summary") or {}

        result.append(
            {
                "tid": time_string,
                "temp": details.get("air_temperature"),
                "dew": details.get("dew_point_temperature"),
                "humidity": details.get("relative_humidity"),
                "moln": details.get("cloud_area_fraction"),
                "regn": next_hour_details.get("precipitation_amount", 0),
                # MET compact exponerar normalt fogandel men inte samma
                # siktparameter som SMHI. Nyckeln behålls för frontendens API.
                "vis": details.get("fog_area_fraction"),
                "wind": details.get("wind_speed"),
                "gust": details.get("wind_speed_of_gust"),
                "wind_dir": details.get("wind_from_direction"),
                "symbol": next_hour_summary.get("symbol_code"),
            }
        )

        if len(result) >= 12:
            break

    return result


def _smhi_value(data: dict, name: str):
    value = data.get(name)

    # Kända sentinelvärden för saknad data.
    if value is None or value in (9999, -9999):
        return None

    return value


def _smhi_cloud_percent(octas) -> float | None:
    """Konvertera SMHI:s totala molntäcke från oktas 0–8 till procent."""

    if octas is None:
        return None

    try:
        value = float(octas)
    except (TypeError, ValueError):
        return None

    return round(min(100.0, max(0.0, value * 12.5)), 1)


def _dewpoint_from_rh(temp_c, relative_humidity) -> float | None:
    """Beräkna daggpunkt från temperatur och relativ luftfuktighet."""

    if temp_c is None or relative_humidity is None:
        return None

    try:
        temperature = float(temp_c)
        humidity = float(relative_humidity)
    except (TypeError, ValueError):
        return None

    if humidity <= 0:
        return None

    humidity = min(100.0, max(0.1, humidity))

    # Magnus-formeln över vatten.
    a = 17.62
    b = 243.12
    gamma = math.log(humidity / 100.0) + (a * temperature) / (b + temperature)
    dewpoint = (b * gamma) / (a - gamma)
    return round(dewpoint, 1)


def _smhi_returned_fields(payload: dict, limit: int = 12) -> set[str]:
    """Samla fältnamn från de första framtida tidsstegen."""

    fields: set[str] = set()
    now_utc = _utc_now()
    accepted = 0

    for item in payload.get("timeSeries") or []:
        valid_time = _parse_iso_utc(item.get("time"))

        if valid_time is None or valid_time < now_utc:
            continue

        data = item.get("data") or {}
        if isinstance(data, dict):
            fields.update(data.keys())

        accepted += 1
        if accepted >= limit:
            break

    return fields


def normalize_smhi(payload: dict) -> list[dict]:
    result: list[dict] = []
    now_utc = _utc_now()

    for item in payload.get("timeSeries") or []:
        time_string = item.get("time")
        valid_time = _parse_iso_utc(time_string)

        if valid_time is None or valid_time < now_utc:
            continue

        data = item.get("data") or {}
        if not isinstance(data, dict):
            continue

        temperature = _smhi_value(data, "air_temperature")
        humidity = _smhi_value(data, "relative_humidity")

        # Den deterministiska nederbörden ligger närmare den vanliga
        # punktprognosen. Fall tillbaka till ensemblemedel om den saknas.
        precipitation = _smhi_value(
            data,
            "precipitation_amount_mean_deterministic",
        )
        if precipitation is None:
            precipitation = _smhi_value(data, "precipitation_amount_mean")

        # En helt saknad temperatur innebär att tidssteget inte är användbart.
        if temperature is None:
            continue

        result.append(
            {
                "tid": time_string,
                "interval_start": item.get("intervalParametersStartTime"),
                "temp": temperature,
                "dew": _dewpoint_from_rh(temperature, humidity),
                "humidity": humidity,
                "moln": _smhi_cloud_percent(
                    _smhi_value(data, "cloud_area_fraction")
                ),
                "cloud_low": _smhi_cloud_percent(
                    _smhi_value(data, "low_type_cloud_area_fraction")
                ),
                "cloud_medium": _smhi_cloud_percent(
                    _smhi_value(data, "medium_type_cloud_area_fraction")
                ),
                "cloud_high": _smhi_cloud_percent(
                    _smhi_value(data, "high_type_cloud_area_fraction")
                ),
                "regn": precipitation,
                "precip_probability": _smhi_value(
                    data,
                    "probability_of_precipitation",
                ),
                # SMHI:s visibility_in_air anges i kilometer.
                "vis": _smhi_value(data, "visibility_in_air"),
                "wind": _smhi_value(data, "wind_speed"),
                "gust": _smhi_value(data, "wind_speed_of_gust"),
                "wind_dir": _smhi_value(data, "wind_from_direction"),
                "symbol": _smhi_value(data, "symbol_code"),
            }
        )

        if len(result) >= 12:
            break

    return result


def parse_fmi_xml(xml_string: str) -> list[dict]:
    try:
        xml_document = ET.fromstring(xml_string)
        namespaces = {
            "gml": "http://www.opengis.net/gml/3.2",
            "gmlcov": "http://www.opengis.net/gmlcov/1.0",
        }

        tuple_list = xml_document.find(
            ".//gml:doubleOrNilReasonTupleList",
            namespaces,
        )
        if tuple_list is None or not tuple_list.text:
            print("FMI: Ingen tuplelist!")
            return []

        values = tuple_list.text.strip().split()
        values = [None if value == "NaN" else float(value) for value in values]

        positions = xml_document.find(".//gmlcov:positions", namespaces)
        if positions is None or not positions.text:
            print("FMI: Inga positions!")
            return []

        position_values = positions.text.strip().split()
        times = [
            int(float(position_values[index + 2]))
            for index in range(0, len(position_values), 3)
            if index + 2 < len(position_values)
        ]

        params_per_row = 21
        result: list[dict] = []
        now_utc = _utc_now()

        for row_index, offset in enumerate(
            range(0, len(values), params_per_row)
        ):
            if row_index >= len(times):
                break

            row = values[offset : offset + params_per_row]
            time_string = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(times[row_index]),
            )
            valid_time = _parse_iso_utc(time_string)

            if valid_time is None or valid_time < now_utc:
                continue

            result.append(
                {
                    "tid": time_string,
                    "temp": row[2] if len(row) > 2 else None,
                    "dew": row[3] if len(row) > 3 else None,
                    "moln": row[10] if len(row) > 10 else None,
                    "regn": row[9] if len(row) > 9 else 0,
                    "vis": row[19] if len(row) > 19 else None,
                    "wind": row[6] if len(row) > 6 else None,
                }
            )

            if len(result) >= 12:
                break

        return result

    except Exception as exc:
        print("FMI XML parse error:", exc)
        return []


@weather_router.get("/forecast")
def weather_forecast(
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    place: str | None = Query(None),
    country: str | None = Query(None),
):
    error_messages: list[str] = []
    country = (country or "").strip().upper()

    print(
        "==> API /forecast start: "
        f"lat={lat}, lon={lon}, place={place}, country={country}"
    )

    def try_fmi():
        if country != "FI" or not place:
            print("FMI: hoppas över (country/ort)")
            return None

        short_place = place.split(",")[0].strip().capitalize()
        key = short_place.lower()
        cached_data = _cache_get("fmi", key, country)

        if cached_data:
            print("FMI: cache!")
            return {
                "hourly": cached_data,
                "source": "FMI",
                "cached": True,
            }

        url = (
            "https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0"
            "&request=getFeature"
            "&storedquery_id="
            "fmi::forecast::harmonie::surface::point::multipointcoverage"
            f"&place={short_place}"
        )
        headers = {"User-Agent": HTTP_USER_AGENT}

        try:
            response = requests.get(url, headers=headers, timeout=20)
            print("FMI-respons:", response.status_code)

            if (
                not response.ok
                or "Exception" in response.text
                or "omso:GridSeriesObservation" not in response.text
            ):
                message = (
                    f"FMI error: HTTP {response.status_code}, "
                    f"body: {response.text[:200]}"
                )
                print(message)
                error_messages.append(message)
                return None

            hourly = parse_fmi_xml(response.text)
            if not hourly:
                message = "FMI returnerade ingen användbar väderdata."
                print(message)
                error_messages.append(message)
                return None

            _cache_set("fmi", key, hourly, country)
            return {"hourly": hourly, "source": "FMI", "cached": False}

        except requests.RequestException as exc:
            message = f"FMI request failed: {exc}"
            print(message)
            error_messages.append(message)
            return None

    def try_met():
        if country != "NO" or lat is None or lon is None:
            print("MET: hoppas över")
            return None

        key = norm_coord_key(lat, lon, decimals=2)
        cached_data = _cache_get("met", key, country)

        if cached_data:
            print("MET: cache!")
            return {
                "hourly": cached_data,
                "source": "MET Norway",
                "cached": True,
            }

        rounded_lat, rounded_lon = key.split(",")
        url = (
            "https://api.met.no/weatherapi/locationforecast/2.0/compact"
            f"?lat={rounded_lat}&lon={rounded_lon}"
        )
        headers = {"User-Agent": HTTP_USER_AGENT}

        try:
            response = requests.get(url, headers=headers, timeout=10)
            print("MET-respons:", response.status_code)

            if not response.ok:
                message = f"MET error: HTTP {response.status_code}, URL: {url}"
                print(message)
                error_messages.append(message)
                return None

            hourly = normalize_met(response.json())
            if not hourly:
                message = "MET returnerade ingen användbar väderdata."
                print(message)
                error_messages.append(message)
                return None

            _cache_set("met", key, hourly, country)
            return {
                "hourly": hourly,
                "source": "MET Norway",
                "cached": False,
            }

        except (requests.RequestException, ValueError) as exc:
            message = f"MET request failed: {exc}"
            print(message)
            error_messages.append(message)
            return None

    def try_smhi():
        if country != "SE" or lat is None or lon is None:
            print("SMHI: hoppas över")
            return None

        key = norm_coord_key(lat, lon, decimals=2)
        cached_result = _cache_get("smhi", key, country)

        if isinstance(cached_result, dict) and cached_result.get("hourly"):
            print("SMHI: cache!")
            result = dict(cached_result)
            result["cached"] = True
            return result

        rounded_lat, rounded_lon = key.split(",")
        url = SMHI_POINT_URL.format(lon=rounded_lon, lat=rounded_lat)
        headers = {
            "User-Agent": HTTP_USER_AGENT,
            "Accept": "application/json",
        }

        try:
            # Avsiktligt utan query-parametern `parameters`.
            # SNOW1 returnerar då samtliga parametrar. Det undviker att ett
            # partiellt svar med bara air_temperature accepteras och cache:as.
            response = requests.get(url, headers=headers, timeout=15)

            print(
                "SMHI-respons:",
                response.status_code,
                response.url,
            )

            if not response.ok:
                message = (
                    f"SMHI error: HTTP {response.status_code}, "
                    f"URL: {response.url}, "
                    f"body: {response.text[:300]}"
                )
                print(message)
                error_messages.append(message)
                return None

            payload = response.json()
            if not isinstance(payload, dict):
                message = "SMHI returnerade inte ett JSON-objekt."
                print(message)
                error_messages.append(message)
                return None

            timeseries = payload.get("timeSeries")
            if not isinstance(timeseries, list) or not timeseries:
                message = "SMHI returnerade ingen timeSeries."
                print(message)
                error_messages.append(message)
                return None

            returned_fields = _smhi_returned_fields(payload)
            missing_fields = SMHI_REQUIRED_FIELDS - returned_fields

            print(
                "SMHI metadata:",
                {
                    "createdTime": payload.get("createdTime"),
                    "referenceTime": payload.get("referenceTime"),
                    "gridPoint": (payload.get("geometry") or {}).get(
                        "coordinates"
                    ),
                    "fields": sorted(returned_fields),
                },
            )

            if missing_fields:
                message = (
                    "SMHI-svaret saknar obligatoriska parametrar: "
                    + ", ".join(sorted(missing_fields))
                )
                print(message)
                error_messages.append(message)
                return None

            hourly = normalize_smhi(payload)
            if not hourly:
                message = (
                    "SMHI returnerade JSON men inga användbara "
                    "framtida tidsserier."
                )
                print(message)
                error_messages.append(message)
                return None

            result = {
                "hourly": hourly,
                "source": "SMHI",
                "cached": False,
                "createdTime": payload.get("createdTime"),
                "referenceTime": payload.get("referenceTime"),
                "gridPoint": (payload.get("geometry") or {}).get(
                    "coordinates"
                ),
            }

            # Cache:a först efter att hela svaret har validerats.
            _cache_set("smhi", key, result, country)
            return result

        except requests.RequestException as exc:
            message = f"SMHI request failed: {exc}"
            print(message)
            error_messages.append(message)
            return None

        except ValueError as exc:
            message = f"SMHI JSON decode failed: {exc}"
            print(message)
            error_messages.append(message)
            return None

    def try_openmeteo():
        if lat is None or lon is None:
            print("Open-Meteo: hoppas över")
            return None

        key = norm_coord_key(lat, lon, decimals=2)
        cached_data = _cache_get("openmeteo", key, country)

        if cached_data:
            print("Open-Meteo: cache!")
            return {
                "hourly": cached_data,
                "source": "Open-Meteo",
                "cached": True,
            }

        rounded_lat, rounded_lon = key.split(",")
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": rounded_lat,
            "longitude": rounded_lon,
            "hourly": ",".join(
                [
                    "temperature_2m",
                    "relative_humidity_2m",
                    "dew_point_2m",
                    "cloud_cover",
                    "precipitation",
                    "visibility",
                    "weather_code",
                    "wind_speed_10m",
                    "wind_direction_10m",
                    "wind_gusts_10m",
                ]
            ),
            "forecast_days": 2,
            "timezone": "UTC",
            "wind_speed_unit": "ms",
        }

        try:
            response = requests.get(url, params=params, timeout=10)
            print("Open-Meteo-respons:", response.status_code, response.url)

            if not response.ok:
                message = (
                    f"Open-Meteo error: HTTP {response.status_code}, "
                    f"URL: {response.url}, body: {response.text[:200]}"
                )
                print(message)
                error_messages.append(message)
                return None

            hourly = normalize_openmeteo(response.json())
            if not hourly:
                message = "Open-Meteo returnerade ingen användbar väderdata."
                print(message)
                error_messages.append(message)
                return None

            _cache_set("openmeteo", key, hourly, country)
            return {
                "hourly": hourly,
                "source": "Open-Meteo",
                "cached": False,
            }

        except (requests.RequestException, ValueError) as exc:
            message = f"Open-Meteo request failed: {exc}"
            print(message)
            error_messages.append(message)
            return None

    if country == "FI":
        priority = [try_fmi, try_openmeteo]
    elif country == "SE":
        priority = [try_smhi, try_openmeteo]
    elif country == "NO":
        priority = [try_met, try_openmeteo]
    else:
        priority = [try_openmeteo]

    for fetcher in priority:
        result = fetcher()
        if result and result.get("hourly"):
            print("==> Valde källa:", result["source"])
            return result

    print("Alla väderkällor misslyckades!", error_messages)
    return {
        "hourly": [],
        "source": "Error",
        "errors": error_messages,
    }
