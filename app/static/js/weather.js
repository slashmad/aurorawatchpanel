// app/static/js/weather.js

import { getLocation, getSunData, getMoonData } from './state.js';
import { fetchShared } from './shared_fetch.js';

function getCoords() {
  const { lat, lon, tz } = getLocation();
  return { lat, lon, tz };
}

// --------- ICON-MAPPNING (för Open-Meteo, SMHI, MET) ---------
const iconMap = {
  // Open-Meteo & MET symboler:
  "clearsky_day": "clear-day", "clearsky_night": "clear-night",
  "cloudy": "overcast-day", "fair_day": "partly-cloudy-day", "fair_night": "partly-cloudy-night",
  "fog": "fog-day", "fog_day": "fog-day", "fog_night": "fog-night",
  "light_rain": "rain", "rain": "rain", "heavyrain": "rain", "lightrainshowers_day": "rain",
  "lightsnow": "snow", "snow": "snow", "heavysnow": "snow",
  "partlycloudy_day": "partly-cloudy-day", "partlycloudy_night": "partly-cloudy-night",
  "rainshowers_day": "rain", "rainshowers_night": "rain",
  "thunderstorm": "thunderstorm", "sleet": "sleet",
  // Open-Meteo kod
  0:  { day: 'clear-day',           night: 'clear-night' },
  1:  { day: 'clear-day',           night: 'clear-night' },
  2:  { day: 'partly-cloudy-day',   night: 'partly-cloudy-night' },
  3:  { day: 'overcast-day',        night: 'overcast-night' },
  45: { day: 'fog-day',             night: 'fog-night' },
  48: { day: 'fog-day',             night: 'fog-night' },
  51: { day: 'drizzle',             night: 'drizzle' },
  53: { day: 'drizzle',             night: 'drizzle' },
  55: { day: 'drizzle',             night: 'drizzle' },
  56: { day: 'drizzle',             night: 'drizzle' },
  57: { day: 'drizzle',             night: 'drizzle' },
  61: { day: 'rain',                night: 'rain' },
  63: { day: 'rain',                night: 'rain' },
  65: { day: 'rain',                night: 'rain' },
  66: { day: 'rain',                night: 'rain' },
  67: { day: 'rain',                night: 'rain' },
  71: { day: 'snow',                night: 'snow' },
  73: { day: 'snow',                night: 'snow' },
  75: { day: 'snow',                night: 'snow' },
  77: { day: 'snow',                night: 'snow' },
  80: { day: 'sleet',               night: 'sleet' },
  81: { day: 'sleet',               night: 'sleet' },
  82: { day: 'rain',                night: 'rain' },
  85: { day: 'snow',                night: 'snow' },
  86: { day: 'snow',                night: 'snow' },
  95: { day: 'thunderstorm',        night: 'thunderstorm' },
  96: { day: 'thunderstorm',        night: 'thunderstorm' },
  99: { day: 'thunderstorm',        night: 'thunderstorm' },
  // SMHI symboler:
  1: { day: 'clear-day', night: 'clear-night' },
  2: { day: 'partly-cloudy-day', night: 'partly-cloudy-night' },
  3: { day: 'overcast-day', night: 'overcast-night' },
  4: { day: 'fog-day', night: 'fog-night' },
  5: { day: 'drizzle', night: 'drizzle' },
  6: { day: 'rain', night: 'rain' },
  7: { day: 'snow', night: 'snow' },
  8: { day: 'sleet', night: 'sleet' },
  9: { day: 'thunderstorm', night: 'thunderstorm' }
};

// --------- TIDSFORMATTERARE ---------
export function showInPlaceTime(isoString, timeZone, withDate = false) {
  if (!isoString || !timeZone) return "-";
  if (isoString === "Unknown" || isoString === null) return "-";
  if (/^\d{2}:\d{2}$/.test(isoString)) {
    const now = new Date();
    const localeDate = now.toLocaleDateString('sv-SE', { timeZone });
    const [day, month, year] = localeDate.split('-');
    const [h, m] = isoString.split(':');
    isoString = `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${h.padStart(2,'0')}:${m.padStart(2,'0')}:00Z`;
  } else if (isoString.length === 16) {
    isoString = isoString.replace(' ', 'T') + ':00Z';
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(isoString)) {
    isoString = isoString.replace(' ', 'T') + ':00Z';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/.test(isoString)) {
    if (!isoString.endsWith('Z')) isoString += 'Z';
  }
  const dt = new Date(isoString);
  if (isNaN(dt.getTime())) return "-";
  if (withDate === 'date') {
    return dt.toLocaleDateString('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone
    });
  }
  if (withDate === true) {
    return dt.toLocaleString('sv-SE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone
    });
  }
  return dt.toLocaleTimeString('sv-SE', {
    hour: '2-digit', minute: '2-digit', timeZone
  });
}

function roundCoord(val, decimals = 1) {
  return Math.round(val * 10 ** decimals) / 10 ** decimals;
}

async function fetchWeatherForecast() {
  const loc = getLocation();
  let url = `/proxy/weather/forecast?lat=${loc.lat}&lon=${loc.lon}&country=${loc.country}`;
  if (loc.country === "FI" && loc.name) {
    // Skicka bara första ordet för FMI!
    url += `&place=${encodeURIComponent(loc.name.split(",")[0].trim())}`;
  } else if (loc.name) {
    url += `&place=${encodeURIComponent(loc.name)}`;
  }
  // showWeather() and updateWeather() both run on startup and location change.
  const res = await fetchShared(url);
  if (!res.ok) throw new Error("Could not fetch weather data from the backend");
  return await res.json();
}

// The public weather API keeps each provider's native vis field for compatibility.
function parseWeatherData(res, tz) {
  const source = res?.source;
  const arr = (res?.hourly ?? []).map(row => {
    const vis = Number.isFinite(row.vis) && row.vis >= 0 ? row.vis : null;
    let visibilityM = null, fogArea = null;
    if (source === 'MET Norway') fogArea = vis !== null && vis <= 100 ? vis : null;
    else if (source === 'SMHI' && vis !== null) visibilityM = vis * 1000;
    else if (source === 'FMI' || source === 'Open-Meteo') visibilityM = vis;
    return { ...row, visibilityM, fogArea };
  });
  return {
    hourly: arr,
    cloudArr: arr.map(r => r.moln ?? null),
    limitedVisibility: arr.map(row => (row.visibilityM !== null && row.visibilityM < 1000) || row.fogArea >= 40),
    tempArr: arr.map(r => r.temp ?? null),
    dewArr: arr.map(r => r.dew ?? null),
    windArr: arr.map(r => r.wind ?? null),
    hourArr: arr.map(r => {
      if (!r.tid) return null;
      // Alltid UTC från backend, visa i rätt lokal tid
      const d = new Date(r.tid);
      return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    }),
    source: source || "No data"
  };
}

function pickWeatherIcon(r, isDay, source = "") {
  const isRain = (r.regn || 0) > 0.2;
  const isDrizzle = (r.regn || 0) > 0 && (r.regn || 0) <= 0.2;
  const isSnow = (r.snow || 0) > 0.2;
  const isSleet = r.sleet && r.sleet > 0.2;
  const isHail = r.hail && r.hail > 0.2;
  const isThunder = r.thunder || false; // Sätt detta via kod om du vill!
  const isFog = (r.visibilityM !== null && r.visibilityM < 1000) || r.fogArea >= 40;
  const isHaze = r.visibilityM !== null && r.visibilityM >= 1000 && r.visibilityM < 5000;
  const isCloudy = (r.moln ?? 0) >= 80;
  const isPartlyCloudy = (r.moln ?? 0) >= 20 && (r.moln ?? 0) < 80;
  const isClear = (r.moln ?? 0) < 20;

  // 1. Dimma (fog) - kombo
  if (isFog && isCloudy && isRain)    return isDay ? "overcast-day-fog-rain" : "overcast-night-fog-rain";
  if (isFog && isCloudy && isSnow)    return isDay ? "overcast-day-fog-snow" : "overcast-night-fog-snow";
  if (isFog && isCloudy)              return isDay ? "overcast-day-fog" : "overcast-night-fog";
  if (isFog && isRain)                return isDay ? "fog-day-rain" : "fog-night-rain";
  if (isFog && isSnow)                return isDay ? "fog-day-snow" : "fog-night-snow";
  if (isFog && isPartlyCloudy)        return isDay ? "partly-cloudy-day-fog" : "partly-cloudy-night-fog";
  if (isFog)                          return isDay ? "fog-day" : "fog-night";
  if (isHaze)                         return isDay ? "haze-day" : "haze-night";

  // 2. Åska/extremt (med kombos)
  if (isThunder && isRain && isCloudy)   return isDay ? "thunderstorms-overcast-rain.svg" : "thunderstorms-overcast-rain.svg";
  if (isThunder && isRain)               return isDay ? "thunderstorms-day-rain.svg" : "thunderstorms-night-rain.svg";
  if (isThunder && isSnow)               return isDay ? "thunderstorms-day-snow.svg" : "thunderstorms-night-snow.svg";
  if (isThunder)                         return isDay ? "thunderstorms-day.svg" : "thunderstorms-night.svg";

  // 3. Snö/hagel/slask (med moln-kombos)
  if (isSnow && isCloudy)                return isDay ? "overcast-day-snow" : "overcast-night-snow";
  if (isSnow && isPartlyCloudy)          return isDay ? "partly-cloudy-day-snow" : "partly-cloudy-night-snow";
  if (isSnow)                            return "snow";
  if (isSleet && isCloudy)               return isDay ? "overcast-day-sleet" : "overcast-night-sleet";
  if (isSleet && isPartlyCloudy)         return isDay ? "partly-cloudy-day-sleet" : "partly-cloudy-night-sleet";
  if (isSleet)                           return "sleet";
  if (isHail && isCloudy)                return isDay ? "overcast-day-hail" : "overcast-night-hail";
  if (isHail && isPartlyCloudy)          return isDay ? "partly-cloudy-day-hail" : "partly-cloudy-night-hail";
  if (isHail)                            return "hail";

  // 4. Regn/drizzle (med moln-kombos)
  if (isDrizzle && isCloudy)             return isDay ? "overcast-day-drizzle" : "overcast-night-drizzle";
  if (isDrizzle && isPartlyCloudy)       return isDay ? "partly-cloudy-day-drizzle" : "partly-cloudy-night-drizzle";
  if (isDrizzle)                         return "drizzle";
  if (isRain && isCloudy)                return isDay ? "overcast-day-rain" : "overcast-night-rain";
  if (isRain && isPartlyCloudy)          return isDay ? "partly-cloudy-day-rain" : "partly-cloudy-night-rain";
  if (isRain)                            return "rain";

  // 5. Moln
  if (isCloudy)                          return isDay ? "overcast-day" : "overcast-night";
  if (isPartlyCloudy)                    return isDay ? "partly-cloudy-day" : "partly-cloudy-night";

  // 6. Symbolkod override från API
  if (typeof r.code === "number" && iconMap[r.code]) {
    const mapping = iconMap[r.code];
    if (typeof mapping === 'object')
      return isDay ? mapping.day : mapping.night;
    return mapping;
  }
  if (typeof r.code === "string" && iconMap[r.code]) {
    return iconMap[r.code];
  }

  // 7. Klart
  if (isClear)                            return isDay ? "clear-day" : "clear-night";

  // Fallback
  return isDay ? "clear-day" : "clear-night";
}


// --------- UI: SHOW WEATHER ---------
export async function showWeather(containerId = 'weather-card-scroll') {
  const { lat, lon, tz } = getCoords();
  const place = getLocation().name;
  const weatherRaw = await fetchWeatherForecast();
  const current = getLocation();
  if (lat !== current.lat || lon !== current.lon || tz !== current.tz) return;
  const weather = parseWeatherData(weatherRaw, tz);
  const rows = weather.hourly;

  // Sätt alltid r.hour för dag/natt
  rows.forEach(r => {
    if (!r.tid) return;
    const d = new Date(r.tid);
    try {
      r.hour = parseInt(
        d.toLocaleTimeString('sv-SE', { hour: '2-digit', hour12: false, timeZone: tz }),
        10
      );
    } catch (e) {
      r.hour = d.getUTCHours();
    }
  });

  // Bygg horisontell lista
  const html = rows.length ? `
    <div class="weather-modern-content">
      ${
        rows.map(r => {
          const sunAlt = getSunData()?.sun_altitude;
          const isDay = sunAlt !== undefined ? sunAlt > 0 : (r.hour >= 6 && r.hour < 18);
          let icon = pickWeatherIcon(r, isDay, weather.source);
          return `
			<div class="weather-modern-row">
			  <div class="weather-time">
				<span>${showInPlaceTime(r.tid, tz)}</span>
			  </div>
			  <div class="weather-icon">
				<img src="/data/icons/${icon}.svg" class="weather-icon-img" alt="">
			  </div>
			  <div class="weather-detail">
				<img src="/data/icons/thermometer.svg" class="detail-icon" alt="Temperature">
				<span>${r.temp != null ? Math.round(r.temp) + '°C' : '–'}</span>
			  </div>
			  <div class="weather-detail">
				<img src="/data/icons/cloudy.svg" class="detail-icon" alt="Clouds">
				<span>${r.moln ?? '-'}%</span>
			  </div>
			  <div class="weather-detail">
				<img src="/data/icons/fog.svg" class="detail-icon" alt="${r.fogArea != null ? 'Fog cover' : 'Visibility'}" title="${r.fogArea != null ? 'Fog cover' : 'Visibility'}">
				<span>${r.visibilityM != null ? (r.visibilityM / 1000).toFixed(1) + ' km' : r.fogArea != null ? r.fogArea + '%' : '–'}</span>
			  </div>
			  <div class="weather-detail">
				<img src="/data/icons/raindrop.svg" class="detail-icon" alt="Rain">
				<span>${r.regn || 0} mm</span>
			  </div>
			  <div class="weather-detail">
				<img src="/data/icons/wind.svg" class="detail-icon" alt="Wind">
				<span>${r.wind != null ? r.wind : '-'} m/s</span>
			  </div>
			</div>
          `;
        }).join('')
      }
    </div>
  ` : `<div style="color:#fff8;font-size:0.8em;padding:0.7em;">No weather data available just now.</div>`;

  // Rendera till DOM
  const target = document.getElementById(containerId);
  if (target) {
    target.innerHTML = html;
  }

  // Uppdatera headern med källa
  const header = document.querySelector('.weather-modern-header');
  if (header && weather && weather.source) {
    const cardControls = header.querySelector('.card-controls'); // keep collapse/move controls
    header.innerHTML = `
      <i class="fa-solid fa-cloud-sun"></i>
      <span>Weather</span>
      <span class="weather-source-header"><i class="fa fa-database"></i> ${weather.source}</span>
    `;
    if (cardControls) header.appendChild(cardControls);
  }
}

export async function getParsedWeatherAndSunMoon(lat, lon, tz) {
  if (lat == null || lon == null || !tz) {
    const loc = getLocation();
    lat = loc.lat;
    lon = loc.lon;
    tz = loc.tz;
  }
  const res = await fetchWeatherForecast();
  const parsed = parseWeatherData(res, tz);

  // Behåll sun och moon-data precis som tidigare (från state.js)
  const sunData = getSunData();
  const moonData = getMoonData();

  return {
    ...(parsed || {}),
    sun: {
      sunrise:       sunData ? sunData.sunrise       : null,
      sunrise_azimuth: sunData ? sunData.sunrise_azimuth : null,
      sunset:        sunData ? sunData.sunset        : null,
      sunset_azimuth:  sunData ? sunData.sunset_azimuth  : null,
      sun_max_time:    sunData ? sunData.sun_max_time    : null,
      sun_max_altitude: sunData ? sunData.sun_max_altitude : null,
      sun_max_azimuth:  sunData ? sunData.sun_max_azimuth  : null,
      sun_azimuth:      sunData ? sunData.sun_azimuth      : null,
      sun_altitude:     sunData ? sunData.sun_altitude     : null,
      tz:             sunData ? sunData.tz              : tz
    },
    moon: {
      moonrise:        moonData ? moonData.moonrise        : null,
      moonrise_azimuth: moonData ? moonData.moonrise_azimuth : null,
      moonset:         moonData ? moonData.moonset         : null,
      moonset_azimuth:  moonData ? moonData.moonset_azimuth  : null,
      moon_max_time:     moonData ? moonData.moon_max_time     : null,
      moon_max_altitude:  moonData ? moonData.moon_max_altitude : null,
      moon_max_azimuth:   moonData ? moonData.moon_max_azimuth  : null,
      moon_azimuth:       moonData ? moonData.moon_azimuth      : null,
      moon_altitude:      moonData ? moonData.moon_altitude     : null,
      moon_phase:        moonData ? moonData.moon_phase        : null,
      moon_phase_label:  moonData ? moonData.moon_phase_label  : null,
      moon_phase_index:  moonData ? moonData.moon_phase_index  : null,
      next_fullmoon:     moonData ? moonData.next_fullmoon     : null,
      is_waxing:        moonData ? moonData.is_waxing        : null,
      tz:               moonData ? moonData.tz              : tz
    }
  };
}


export async function updateWeather() {
  const { lat, lon, tz } = getCoords();
  const weather = await getParsedWeatherAndSunMoon(lat, lon, tz);

  const current = getLocation();
  if (lat !== current.lat || lon !== current.lon || tz !== current.tz) return;
  const cloud = weather.cloudArr.slice(0, 6);
  const hours = weather.hourArr.slice(0, 6);
  const messages = [];
  const clear = value => Number.isFinite(value) && value <= 20;
  const cloudy = value => Number.isFinite(value) && value >= 70;
  if (cloudy(cloud[0]) || clear(cloud[0])) {
    const startsClear = clear(cloud[0]);
    const next = cloud.findIndex(startsClear ? cloudy : clear);
    const first = startsClear ? 'Clear sky' : 'Heavy cloud cover';
    const change = startsClear ? 'cloud cover increases' : 'clearing expected';
    messages.push(next >= 0 ? `${first}, with ${change} from ${hours[next]}.` : `${first} in the first forecast hour.`);
  } else if (Number.isFinite(cloud[0])) {
    messages.push('Partly cloudy in the first forecast hour.');
  }
  const limited = weather.limitedVisibility.slice(0, 6).indexOf(true);
  if (limited >= 0) messages.push(`Low visibility or fog forecast from ${hours[limited]}.`);
  function average(values) {
    const valid = values.slice(0, 6).filter(Number.isFinite);
    return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
  }
  const temp = average(weather.tempArr), wind = average(weather.windArr);
  if (temp !== null) messages.push(`Avg. temp: ${temp}°C.`);
  if (wind !== null) messages.push(`Avg. wind: ${wind} m/s.`);
  if (hours.length) messages.push(`(Forecast: ${hours[0]}–${hours.at(-1)})`);
  const weatherMsg = messages.join(' ');
  const moon = weather.moon;
  const moonMsg = Number.isFinite(moon?.moon_phase) ? `Moon illumination: ${moon.moon_phase}%.` : '';
  window.latestWeather = { ...weather, lat, lon, tz, moon, weatherMsg, moonMsg };
  window.latestWeatherSummary = weatherMsg + " " + moonMsg;
  if (moon && typeof moon.moon_phase === "number") {
    window.latestMoonIllum = moon.moon_phase;
    if (typeof updateMoonImage === "function") updateMoonImage();
  }
}
