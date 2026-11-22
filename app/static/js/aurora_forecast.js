import { fetchShared } from './shared_fetch.js';
import { getLocation } from './state.js';
import { showInPlaceTime } from './weather.js';
import { IRF_STATIONS } from './magnetometer.js';
import { FMI_STATIONS } from './magnetometer_fmi.js';
import { GLOBAL_MAG_STATIONS } from './magnetometer_global.js';

// These feeds expose the X component in nT relative to its window mean.
// UiT provides D/H/Z instead, so its angles cannot use the X threshold.
const stationFeeds = [
  { name: 'FMI/IMAGE', region: 'Europe', stations: FMI_STATIONS, endpoint: '/magneto_fmi/timeseries' },
  { name: 'Swedish network', region: 'Europe', stations: IRF_STATIONS, endpoint: '/magneto/timeseries_multi' },
  { name: 'USGS', region: 'North America', stations: GLOBAL_MAG_STATIONS, endpoint: '/magneto_global/timeseries' },
];
const lastStationReports = new Map();
let forecastVersion = 0;
const BASE_TITLE = document.title || 'Aurora Watch Panel';

// Alert levels shown as a badge, a headline and in the tab title. They only
// summarise the signals computed below; the thresholds live there.
const ALERT_LEVELS = {
  watch: { badge: 'AURORA WATCH', color: '#f5b83d', text: '#1b1b1b', headline: 'Aurora watch for this location', title: 'Aurora watch' },
  alert: { badge: 'AURORA ALERT', color: '#3ddc84', text: '#0b2a17', headline: 'Aurora alert for this location', title: 'Aurora alert' },
  storm: { badge: 'STRONG ACTIVITY', color: '#f23d3d', text: '#fff', headline: 'Strong aurora activity for this location', title: 'Strong aurora activity' },
};

// What to do now, including the cloud forecast: a cloudy forecast must not
// hide a real disturbance, because breaks in the cloud still show aurora.
function actionAdvice(cloudNow) {
  if (!Number.isFinite(cloudNow)) return '<b>Look north</b> and check the all-sky cameras below.';
  if (cloudNow >= 70) return '<b>Look north.</b> Clouds are forecast, but breaks can still reveal aurora — check the all-sky cameras below.';
  if (cloudNow > 20) return '<b>Look north</b> through the gaps in the clouds, and check the all-sky cameras below.';
  return '<b>Look north</b> — the sky is forecast to be clear.';
}

function stationDistanceKm(lat, lon, station) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat - station.lat) * rad / 2) ** 2
    + Math.cos(lat * rad) * Math.cos(station.lat * rad) * Math.sin((lon - station.lon) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, a)));
}

async function forecastJson(url) {
  try {
    const res = await fetchShared(url);
    if (res.ok) return (await res.json()) ?? {};
  } catch (err) {
    console.warn('Forecast feed unavailable:', url, err);
  }
  return {};
}

async function stationObservations(lat, lon, version) {
  const stations = stationFeeds.flatMap(feed => feed.stations.map(station => ({
    ...station, feed, km: stationDistanceKm(lat, lon, station),
  }))).sort((a, b) => a.km - b.km);
  const region = stations[0].feed.region;
  const feeds = stationFeeds.filter(feed => feed.region === region);
  const results = await Promise.all(feeds.map(async feed => {
    const ids = feed.stations.map(s => s.id).join(',');
    const json = await forecastJson(`${feed.endpoint}?stations=${ids}&hours=12&component=x&latest_only=true`);
    if (json.data && version === forecastVersion) lastStationReports.set(feed.name, json);
    const snapshot = json.data ? json : lastStationReports.get(feed.name);
    return [feed.name, { snapshot, offline: !json.data }];
  }));
  const data = Object.fromEntries(results);
  return stations.filter(s => s.feed.region === region).map(s => {
    const { snapshot, offline } = data[s.feed.name];
    const rows = snapshot?.data?.[s.id] ?? [];
    const row = latestSample(rows, 'value', 30);
    const lastTime = row?.time ?? rows.at(-1)?.time ?? snapshot?.missing?.[s.id];
    const value = row?.value ?? null;
    return { ...s, value, offline, active: value !== null && Math.abs(value) >= 30,
      age: Math.floor((Date.now() - utcMillis(lastTime)) / 60000) };
  });
}

function utcMillis(iso) {
  if (!iso) return NaN;
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
}

function latestSample(rows, field, maxAgeMinutes) {
  const now = Date.now();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const age = now - utcMillis(row.time ?? row.timestamp);
    if (age > maxAgeMinutes * 60000) break;
    if (age >= 0 && Number.isFinite(row[field])) return row;
  }
  return null;
}

function latestReading(rows, field, maxAgeMinutes) {
  return latestSample(rows, field, maxAgeMinutes)?.[field] ?? null;
}

function mergeHeadsUpEvents(events, mergeWindowMinutes = 30) {
  // Grupp per type+txt
  const grouped = {};
  for (let ev of events) {
    if (!ev.time) continue;
    // Unik nyckel per event-nivå (t.ex. Speed600, KP Kp=5 osv)
    const key = ev.end ? `${ev.type}||${ev.time}` : `${ev.type}||${ev.txt}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(ev);
  }

  const merged = [];
  for (const arr of Object.values(grouped)) {
    arr.sort((a, b) => a.time.localeCompare(b.time));
    let session = null;
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      const t = utcMillis(ev.time);
      if (!session) {
        session = { ...ev, start: ev.time, end: ev.end ?? ev.time };
      } else {
        const prevT = utcMillis(arr[i-1].time);
        const diffMin = (t - prevT) / (1000 * 60);
        if (diffMin <= mergeWindowMinutes) {
          session.end = ev.time;
        } else {
          merged.push({
            ...session,
            timeStr: (session.start === session.end)
              ? session.start.replace('T',' ').slice(0,16)
              : session.start.replace('T',' ').slice(0,16) + " – " + session.end.replace('T',' ').slice(11,16)
          });
          session = { ...ev, start: ev.time, end: ev.end ?? ev.time };
        }
      }
    }
    // Lägg till sista sessionen
    if (session) {
      merged.push({
        ...session,
        timeStr: (session.start === session.end)
          ? session.start.replace('T',' ').slice(0,16)
          : session.start.replace('T',' ').slice(0,16) + " – " + session.end.replace('T',' ').slice(11,16)
      });
    }
  }
  // Sortera senaste först
  merged.sort((a, b) => (b.end || b.time).localeCompare(a.end || a.time));
  return merged;
}

// --- Solar wind / geomagnetic event detector --- //
function detectSolarwindEvents({speedArr, densityArr, btArr, bzArr, kpArr, hpArr}) {
  let heads = [];

  // --- 1. CIR och HSS --- //
  const speedAt = new Map(speedArr.map(row => [row.time, row.value]));
  const btAt = new Map(btArr.map(row => [row.time, row.value]));
  const densityAt = new Map(densityArr.map(row => [row.time, row.value]));
  let cir = null, hss = null;
  for (let i = 1; i < densityArr.length; i++) {
    const prevD = densityArr[i-1]?.value ?? 0, currD = densityArr[i].value;
    const prevBt = btAt.get(densityArr[i-1].time), currBt = btAt.get(densityArr[i].time);
    const currSpeed = speedAt.get(densityArr[i].time);
    // CIR: density-jump + Bt-jump
    if ((prevD < 10 && currD >= 10) && (currBt - prevBt > 5)) cir = densityArr[i];
    // HSS: hastighet > 550, density låg
    if (currSpeed >= 550 && currD <= 8 && !hss) hss = densityArr[i];
  }
  if (cir) heads.push({
    type: "CIR", time: cir.time, txt: "CIR passage detected",
    desc: "Plasma density and magnetic field increased – high-speed stream and aurora may follow."
  });
  if (hss) heads.push({
    type: "HSS", time: hss.time, txt: "HSS ongoing",
    desc: "Solar wind speed >550 km/s, low density – high aurora potential at high latitudes!"
  });

  // --- 2. Solvindshastighet (fler nivåer!) --- //
  const speedLevels = [
    { min: 1000, label: "Extreme solar wind speed", desc: "Solar wind speed >1000 km/s – potentially extreme geomagnetic effects!" },
    { min: 800, label: "Very strong solar wind", desc: "Solar wind speed >800 km/s – strong geomagnetic activity possible." },
    { min: 600, label: "Strong solar wind", desc: "Solar wind speed >600 km/s – strong aurora potential!" },
    { min: 500, label: "Moderately strong solar wind", desc: "Solar wind speed >500 km/s." }
  ];
  for (let i = 0; i < speedArr.length; i++) {
    for (const lvl of speedLevels) {
      if (speedArr[i].value >= lvl.min && !heads.find(ev => ev.type === `Speed${lvl.min}` && ev.time === speedArr[i].time)) {
        heads.push({
          type: `Speed${lvl.min}`,
          time: speedArr[i].time,
          txt: lvl.label,
          desc: lvl.desc + ` (Current: ${speedArr[i].value.toFixed(0)} km/s)`
        });
        break; // Bara högsta gäller per punkt
      }
    }
  }

  // --- 3. Densitet (fler nivåer!) --- //
  const densityLevels = [
    { min: 20, label: "Exceptional solar wind density", desc: "Solar wind density >20 p/cm³ – very strong pressure pulse, possible geomagnetic storm." },
    { min: 15, label: "Strong solar wind density", desc: "Solar wind density >15 p/cm³ – strong compression, risk for geomagnetic storm." },
    { min: 10, label: "Elevated solar wind density", desc: "Solar wind density >10 p/cm³ – increased compression, possible auroral activity." }
  ];
  for (let i = 0; i < densityArr.length; i++) {
    for (const lvl of densityLevels) {
      if (densityArr[i].value >= lvl.min && !heads.find(ev => ev.type === `Density${lvl.min}` && ev.time === densityArr[i].time)) {
        heads.push({
          type: `Density${lvl.min}`,
          time: densityArr[i].time,
          txt: lvl.label,
          desc: lvl.desc + ` (Current: ${densityArr[i].value.toFixed(1)} p/cm³)`
        });
        break;
      }
    }
  }

  // --- 4. Sudden Storm Commencement (SSC) --- //
  let ssc = null;
  for (let i = 1; i < btArr.length; i++) {
    if (btArr[i-1].value < 15 && btArr[i].value > 30) { // threshold justerbar!
      ssc = btArr[i];
      break;
    }
  }
  if (ssc) heads.push({
    type: "SSC", time: ssc.time, txt: "SSC (Storm Commencement)",
    desc: "Sudden jump in Bt – possible CME impact or geomagnetic storm onset."
  });

  // NOAA supplies one-minute measurements. A missing minute breaks continuity.
  let start = null, previous = null;
  function finishBzRun() {
    if (start && previous.ms - start.ms >= 600000) {
      const minutes = (previous.ms - start.ms) / 60000;
      heads.push({ type: 'BZ-', time: start.time, end: previous.time,
        txt: 'Strong southward Bz', desc: `Bz ≤ -10 nT for ${minutes} min.` });
    }
    start = null;
  }
  for (const row of bzArr) {
    const ms = utcMillis(row.time);
    if (!Number.isFinite(ms) || row.value > -10 || !Number.isFinite(row.value)) {
      finishBzRun();
      previous = null;
      continue;
    }
    if (previous && ms - previous.ms !== 60000) finishBzRun();
    previous = { time: row.time, ms };
    if (!start) start = previous;
  }
  finishBzRun();

  // --- 6. Kp-index (från 5 uppåt) --- //
  // NOAA G-klass: Kp5=G1, Kp6=G2, Kp7=G3, Kp8=G4, Kp9=G5
  for (let i = 0; i < kpArr.length; i++) {
    const kp = kpArr[i].kp ?? kpArr[i].value;
    const kpTime = kpArr[i].time;
    if (kp >= 5) {
      let gclass = '';
      if (kp >= 9) gclass = 'G5 (Extreme)';
      else if (kp >= 8) gclass = 'G4 (Severe)';
      else if (kp >= 7) gclass = 'G3 (Strong)';
      else if (kp >= 6) gclass = 'G2 (Moderate)';
      else if (kp >= 5) gclass = 'G1 (Minor)';
      heads.push({
        type: "KP",
        time: kpTime,
        txt: `Geomagnetic storm Kp: ${kp} - ${gclass}`,
        desc: `G${Math.max(1, Math.min(5, Math.round(kp-4)))} storm detected – NOAA scale.`
      });
    }
  }

  // Hp30 is GFZ's open-ended, Kp-like half-hour index. G classes are for Kp.
  for (const row of hpArr) {
    if (Number.isFinite(row.hp30) && row.hp30 >= 5) {
      heads.push({ type: 'HP30', time: row.timestamp ?? row.time,
        txt: `Elevated Hp30: ${row.hp30}`, desc: 'Elevated half-hour planetary magnetic activity (GFZ).' });
    }
  }

  // --- 8. CME-liknande impact (snabb jump i Bt, hastighet, density) --- //
  for (let i = 1; i < btArr.length; i++) {
    if (
      btArr[i-1].value < 10 && btArr[i].value > 20 &&
      speedAt.get(btArr[i-1].time) < 500 && speedAt.get(btArr[i].time) > 600 &&
      densityAt.get(btArr[i-1].time) < 10 && densityAt.get(btArr[i].time) > 20
    ) {
      heads.push({
        type: "CME", time: btArr[i].time,
        txt: "Possible CME impact",
        desc: "Sharp simultaneous increase in Bt, speed and density – CME likely impacted Earth."
      });
      break;
    }
  }

  return heads;
}


export async function updateAuroraForecasts() {
  const version = ++forecastVersion;
  const { lat, lon, tz } = getLocation();
  try {
    // Hämtar 12h historik för alla eventdetektorer
    const [
      bzData, byData, densData, speedData, btData,
      stations, hpData, kpData, astro, flagsData
    ] = await Promise.all([
      forecastJson('/solarwind/timeseries?param=bz&hours=12'),
      forecastJson('/solarwind/timeseries?param=by&hours=12'),
      forecastJson('/solarwind/timeseries?param=density&hours=12'),
      forecastJson('/solarwind/timeseries?param=speed&hours=12'),
      forecastJson('/solarwind/timeseries?param=bt&hours=12'),
      stationObservations(lat, lon, version),
      forecastJson('/hp30/timeseries?hours=12'),
      forecastJson('/kp/timeseries?hours=12'),
      forecastJson(`/astro/skyfield-astro?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`),
      forecastJson('/aurora/flags')
    ]);

    // Parse all data
    const [bzArr, byArr, densityArr, speedArr, btArr, hp30Arr, kpArr] =
      [bzData, byData, densData, speedData, btData, hpData, kpData].map(series =>
        Array.isArray(series.data) ? series.data : []);
    const flags = flagsData.flags ?? [];
    const current = getLocation();
    if (version !== forecastVersion || current.lat !== lat || current.lon !== lon || current.tz !== tz) return;

    // Detektera heads-up events (solar wind/geomagnetic alerts)
    const headsUp = detectSolarwindEvents({
      speedArr, densityArr, btArr, bzArr, kpArr, hpArr: hp30Arr
    });

// Visa heads-up / badge i #aurora-headsup
let headsUpMerged = mergeHeadsUpEvents(headsUp, 30);
headsUpMerged.sort((a, b) => {
  const ta = new Date(a.end || a.start || a.time).getTime();
  const tb = new Date(b.end || b.start || b.time).getTime();
  return tb - ta;
});
// Använd bara befintlig tz!
let headsUpHtml = headsUpMerged.map(ev => {
  let t = ev.start === ev.end
    ? showInPlaceTime(ev.start, tz, true)
    : showInPlaceTime(ev.start, tz, true) + " – " + showInPlaceTime(ev.end, tz, false);
  return `
    <div class="solarwind-badge ${ev.type.toLowerCase()}">
      <b>${ev.txt}</b>
      <div class="badge-desc">${ev.desc}</div>
      <div class="badge-time">${t}</div>
    </div>
  `;
}).join("");


const headsUpBox = document.getElementById("aurora-headsup");
if (headsUpBox) headsUpBox.innerHTML = headsUpHtml;

    // Hämta senaste värden (från arr)
    const bz = latestReading(bzArr, 'value', 30);
    const by = latestReading(byArr, 'value', 30);
    const dens = latestReading(densityArr, 'value', 30);
    const speed = latestReading(speedArr, 'value', 30);
    const bt = latestReading(btArr, 'value', 30);
    const hp30 = latestReading(hp30Arr, 'hp30', 90);
    const kp = latestReading(kpArr, 'kp', 30);
    const weather = window.latestWeather?.lat === lat && window.latestWeather?.lon === lon
      && window.latestWeather?.tz === tz ? window.latestWeather : null;
    const weatherMsg = weather?.weatherMsg ?? '';

    // Måne
	let moonMsg = "";
	if (Number.isFinite(weather?.moon?.moon_phase)) {
	  const moon = weather.moon;
	  moonMsg = `Moon phase: ${moon.moon_phase}%`;
	  const hasMoon = (moon.moonrise && moon.moonrise !== "-") || (moon.moonset && moon.moonset !== "-");
	  const maxAlt = typeof moon.moon_max_altitude === "number" ? moon.moon_max_altitude : null;
	  let neverVisible = false;
	  if (hasMoon) {
		if (moon.moonrise && moon.moonrise !== "-") {
		  moonMsg += `. Moonrise: ${moon.moonrise}`;
		  if (moon.moonset && moon.moonset !== "-") moonMsg += `, moonset: ${moon.moonset}`;
		} else if (moon.moonset && moon.moonset !== "-") {
		  moonMsg += `. Moonset: ${moon.moonset}`;
		}
		if (maxAlt !== null) moonMsg += `. Maximum altitude today: ${maxAlt}°`;
	  } else if (maxAlt !== null && maxAlt > 0) {
		moonMsg += `. The moon never sets tonight (always visible above the horizon). Max altitude: ${maxAlt}°`;
	  } else if (maxAlt !== null) {
		neverVisible = true;
		moonMsg += `. The moon never rises above the horizon tonight.`;
		if (maxAlt !== null) moonMsg += ` (Max altitude: ${maxAlt}°)`;
	  }
	  if (moon.moon_phase > 80 && !neverVisible) {
		moonMsg += " (Full moon or nearly full – may reduce aurora visibility.)";
	  }
	}


    const sunAltitude = astro.sun_altitude;
    const nearest = stations[0];
    const fmi = stations.filter(s => s.feed.name === 'FMI/IMAGE');
    const freshFmi = fmi.filter(s => s.value !== null);
    // Distance decides which active station to cite within each network.
    // In Fennoscandia FMI is the primary regional observation; a quiet or
    // offline station in another network cannot cancel that observation.
    const signal = freshFmi.find(s => s.active) ?? stations.find(s => s.active);
    const strongWind = (bz !== null && (bz <= -5 || (bz <= -2 && !!signal)))
      || (by !== null && by <= -8 && dens >= 10 && speed >= 500 && bt >= 10 && !!signal);
    const globalStrongTrigger = kp >= 5 || hp30 >= 6;
    const extremeGlobal = kp >= 7 || hp30 >= 8 || (bz !== null && bz <= -10);
    let activity;
    if (signal) {
      activity = `Magnetic disturbance at ${signal.feed.name} station ${signal.name} (${Math.round(signal.km)} km away, ΔX ${signal.value} nT, ${signal.age} min ago).`;
      if (strongWind || globalStrongTrigger) activity += ' Solar wind or planetary indices also favor aurora.';
    } else if (globalStrongTrigger || strongWind) {
      activity = 'Solar wind or planetary indices indicate elevated activity.';
    }

    const disturbed = stations.filter(s => s.active);
    const maxDeviation = disturbed.reduce((m, s) => Math.max(m, Math.abs(s.value)), 0);
    let level = null;
    if (extremeGlobal) level = 'storm';
    else if (signal && (strongWind || globalStrongTrigger || disturbed.length >= 2 || maxDeviation >= 100)) level = 'alert';
    else if (activity) level = 'watch';
    // Aurora is visible from nautical twilight on; daylight and civil twilight show no badge.
    const darkEnough = Number.isFinite(sunAltitude) && sunAltitude < -6;
    const shownLevel = darkEnough ? level : null;

    let headline, mainMsg = '', extraTip = '';
    if (!Number.isFinite(sunAltitude)) {
      headline = 'Daylight conditions are unavailable for this location.';
    } else if (sunAltitude >= -0.833) {
      headline = 'The sky is too bright for aurora observations at this location.';
      if (activity) mainMsg = activity + ' Check again after dark.';
    } else if (sunAltitude >= -18) {
      const phase = sunAltitude >= -6 ? 'Civil' : sunAltitude >= -12 ? 'Nautical' : 'Astronomical';
      headline = `${phase} twilight at this location.`;
      mainMsg = `The Sun is ${Math.abs(sunAltitude).toFixed(1)}° below the horizon. Sky brightness can reduce aurora visibility.`;
      if (activity) extraTip = activity;
    } else {
      headline = shownLevel ? ALERT_LEVELS[shownLevel].headline : 'Aurora conditions at this location';
      if (activity) {
        mainMsg = (signal ? '<b>Regional aurora watch.</b> ' : '<b>Aurora possible.</b> ') + activity;
      } else if (!stations.some(s => s.value !== null) || bz === null) {
        mainMsg = 'Coverage is incomplete. A quiet local sky cannot be inferred from the available data.';
      } else {
        mainMsg = 'The available measurements do not currently meet the aurora thresholds.';
      }
    }
    if (!Number.isFinite(sunAltitude) && activity) mainMsg = activity;

    let infoParts = [];
    if (weatherMsg) infoParts.push(weatherMsg);
    if (moonMsg) infoParts.push(moonMsg);
    if (extraTip) infoParts.push(extraTip);

    let stationStatus = 'no measurement in the last 30 min';
    if (nearest.value !== null) stationStatus = `ΔX ${nearest.value} nT, ${nearest.age} min ago`;
    else if (nearest.age >= 30) stationStatus += `, last report ${nearest.age} min ago`;
    const offline = [...new Set(stations.filter(s => s.offline).map(s => s.feed.name))];
    const networkInfo = fmi.length ? `FMI/IMAGE: ${freshFmi.length}/${fmi.length} stations reporting in the last 30 min${freshFmi.length ? `, ${freshFmi.filter(s => s.active).length} disturbed` : ''}. ` : '';
    const feedStatus = offline.length ? ` Latest update unavailable from ${offline.join(', ')}.` : '';
    const nearestInfo = `${networkInfo}Nearest station: <b>${nearest.name}</b> (${Math.round(nearest.km)} km, ${stationStatus}).${feedStatus}`;

    let alertBadge = '';
    let actionLine = '';
    if (shownLevel) {
      const cfg = ALERT_LEVELS[shownLevel];
      alertBadge = `<span class="aurora-level-badge" data-level="${shownLevel}" style="background:${cfg.color};color:${cfg.text}">${cfg.badge}</span>`;
      const cloudNow = weather?.cloudArr?.[0];
      actionLine = `<div class="aurora-action" style="border-color:${cfg.color}">${actionAdvice(cloudNow)}</div>`;
    }
    document.title = shownLevel ? `● ${ALERT_LEVELS[shownLevel].title} – ${BASE_TITLE}` : BASE_TITLE;

    const condAlert = document.getElementById('cond-alert');
    if (condAlert) {
      condAlert.innerHTML =
        `<div style="position:relative">
           <b>${headline}</b> ${alertBadge}<br>
           ${actionLine}
           <span style="font-size:0.7em">${mainMsg}</span>
           <div style="font-size:0.7em;color:#ccc;margin-top:0.4em">${nearestInfo}</div>
           ${infoParts.length ? "<br><span style='color:#fff7; font-size:0.7em'>" + infoParts.join(" ") + "</span>" : ""}
         </div>`;
    }

    // Update flag lists
    const listBy = document.getElementById('aurora-flag-items');
    const listStd = document.getElementById('aurora-standard-items');
    if (listBy) {
      const byFlags = flags.filter(f => f.reason.includes('By event'));
      listBy.innerHTML = byFlags.map(f =>
        `<li><b>${showInPlaceTime(f.time, astro.tz, true)}</b><br>${f.reason}</li>`
      ).join('');
    }
    if (listStd) {
      const stdFlags = flags.filter(f => f.reason.includes('Bz south'));
      listStd.innerHTML = stdFlags.map(f =>
        `<li><b>${showInPlaceTime(f.time, astro.tz, true)}</b><br>${f.reason}</li>`
      ).join('');
    }
  } catch (err) {
    if (version !== forecastVersion) return;
    console.error('updateAuroraForecasts error:', err);
    const condAlert = document.getElementById('cond-alert');
    if (condAlert) {
      condAlert.innerHTML = "<b>Error updating forecast. Please check your connection or reload the page.</b>";
    }
    const headsUpBox = document.getElementById("aurora-headsup");
    if (headsUpBox) headsUpBox.innerHTML = "";
  }
}
