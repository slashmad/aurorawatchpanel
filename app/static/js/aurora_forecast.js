// app/static/js/aurora_forecast.js

import { getLocation, setLocation } from './state.js';
import { showWeather, showInPlaceTime, getParsedWeatherAndSunMoon } from './weather.js';
import { fetchAndRenderSW } from './solarwind.js';
import { fetchAndRenderMagIRF, IRF_STATIONS } from './magnetometer.js';
import { setupMagnetometerFMI, setupMagnetometerFMIEvents, FMI_STATIONS } from './magnetometer_fmi.js';
import { setupMagnetometerUIT, setupMagnetometerUITEvents, UIT_STATIONS } from './magnetometer_uit.js';
import { setupMagnetometerGlobal, GLOBAL_MAG_STATIONS } from './magnetometer_global.js';
import { setupHp30Gauge } from './hp30.js';
import { setupKpGauge } from './kpindex.js';
import { drawAstroMasterGraph } from './skyfield_graph.js';

const ALL_MAG_STATIONS = [
  ...IRF_STATIONS,
  ...FMI_STATIONS,
  ...UIT_STATIONS,
  ...GLOBAL_MAG_STATIONS
];

function nearestMagnetometerStation(lat, lon) {
  let best = null, bestDist = Infinity;
  for (const s of ALL_MAG_STATIONS) {
    const d = Math.hypot(lat - s.lat, lon - s.lon);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function mergeHeadsUpEvents(events, mergeWindowMinutes = 30) {
  // Grupp per type+txt
  const grouped = {};
  for (let ev of events) {
    if (!ev.time) continue;
    // Unik nyckel per event-nivå (t.ex. Speed600, KP Kp=5 osv)
    const key = `${ev.type}||${ev.txt}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(ev);
  }

  const merged = [];
  for (const arr of Object.values(grouped)) {
    arr.sort((a, b) => a.time.localeCompare(b.time));
    let session = null;
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      const t = new Date(ev.time).getTime();
      if (!session) {
        session = { ...ev, start: ev.time, end: ev.time };
      } else {
        const prevT = new Date(arr[i-1].time).getTime();
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
          session = { ...ev, start: ev.time, end: ev.time };
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
  let cir = null, hss = null;
  for (let i = 1; i < densityArr.length; i++) {
    const prevD = densityArr[i-1]?.value ?? 0, currD = densityArr[i].value;
    const prevBt = btArr[i-1]?.value ?? 0, currBt = btArr[i].value;
    const currSpeed = speedArr[i].value;
    // CIR: density-jump + Bt-jump
    if ((prevD < 10 && currD >= 10) && (currBt - prevBt > 5)) cir = densityArr[i];
    // HSS: hastighet > 550, density låg
    if (currSpeed >= 550 && currD <= 8 && !hss) hss = speedArr[i];
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

  // --- 5. Strong Southward Bz (<-10 nT, minst 10 min) --- //
  let bzThreshold = -10;
  let seqLen = 0, firstBzT = null;
  for (let i = 0; i < bzArr.length; i++) {
    if (bzArr[i].value <= bzThreshold) {
      if (seqLen === 0) firstBzT = bzArr[i].time;
      seqLen++;
    } else if (seqLen >= 2) { // 2 datapunkter = ca 10 min om 5-minutersdata
      heads.push({
        type: "BZ-", time: firstBzT,
        txt: "Strong southward Bz",
        desc: `Bz ≤ -10 nT for at least ${seqLen*5} min – high risk for strong auroras.`
      });
      seqLen = 0;
      firstBzT = null;
    } else {
      seqLen = 0;
      firstBzT = null;
    }
  }
  // Om sekvensen är kvar vid slutet
  if (seqLen >= 2 && firstBzT) {
    heads.push({
      type: "BZ-", time: firstBzT,
      txt: "Strong southward Bz",
      desc: `Bz ≤ -10 nT for at least ${seqLen*5} min – high risk for strong auroras.`
    });
  }

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

  // --- 7. Hp30 (från 50 uppåt) --- //
  for (let i = 0; i < hpArr.length; i++) {
    const hp = hpArr[i].hp30 ?? hpArr[i].value;
    const hpTime = hpArr[i].timestamp || hpArr[i].time;
    if (hp >= 50) {
      let gclass = '';
      if (hp >= 80) gclass = 'G4/G5? - Extreme';
      else if (hp >= 60) gclass = 'G2/G3 - Strong';
      else if (hp >= 50) gclass = 'G1+ - Minor/Moderate';
      heads.push({
        type: "HP30",
        time: hpTime,
        txt: `Disturbance storm Hp30: ${hp} - ${gclass}`,
        desc: `Strong geomagnetic disturbance – potential for high-latitude auroras!`
      });
    }
  }

  // --- 8. CME-liknande impact (snabb jump i Bt, hastighet, density) --- //
  for (let i = 1; i < btArr.length; i++) {
    if (
      btArr[i-1].value < 10 && btArr[i].value > 20 &&
      speedArr[i-1].value < 500 && speedArr[i].value > 600 &&
      densityArr[i-1].value < 10 && densityArr[i].value > 20
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
  try {
    const { lat, lon, tz } = getLocation();
    // Hämtar 12h historik för alla eventdetektorer
    const [
      bzRes, byRes, densRes, speedRes, btRes,
      kirxRes, fmiRes, hpRes, kpRes, astroRes, flagsRes
    ] = await Promise.all([
      fetch(`/solarwind/timeseries?param=bz&hours=12`),
      fetch(`/solarwind/timeseries?param=by&hours=12`),
      fetch(`/solarwind/timeseries?param=density&hours=12`),
      fetch(`/solarwind/timeseries?param=speed&hours=12`),
      fetch(`/solarwind/timeseries?param=bt&hours=12`),
      fetch(`/magneto/timeseries_multi?stations=KIR&hours=12`),
      fetch(`/magneto_fmi/timeseries?stations=${FMI_STATIONS.map(s => s.id).join(",")}&hours=12&component=x`),
      fetch(`/hp30/timeseries?hours=12`),
      fetch(`/kp/timeseries?hours=12`),
      fetch(`/astro/skyfield-astro?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`),
      fetch(`/aurora/flags`)
    ]);

    // Parse all data
    const bzArr = (await bzRes.json()).data ?? [];
    const byArr = (await byRes.json()).data ?? [];
    const densityArr = (await densRes.json()).data ?? [];
    const speedArr = (await speedRes.json()).data ?? [];
    const btArr = (await btRes.json()).data ?? [];
    const kirxDataRaw = (await kirxRes.json()).data ?? {};
    const kirxData = kirxDataRaw["KIR"] ?? [];
    let hp30Arr = (await hpRes.json()).data ?? [];
    if (!Array.isArray(hp30Arr)) hp30Arr = [];
    const kpArr = (await kpRes.json()).data ?? [];
    const astro = await astroRes.json();
    const flags = (await flagsRes.json()).flags;

    // Detektera heads-up events (solar wind/geomagnetic alerts)
    const headsUp = detectSolarwindEvents({
      speedArr, densityArr, btArr, bzArr, kpArr, hpArr: hp30Arr
    });

// Visa heads-up / badge i #aurora-headsup
let headsUpToShow = headsUp.slice().sort((a, b) => {
  // Sortera SENASTE först (descending)
  // Om "a.time" eller "b.time" saknas, lägg dem sist
  if (!a.time) return 1;
  if (!b.time) return -1;
  return b.time.localeCompare(a.time);
});

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
    const bz = bzArr.at(-1)?.value ?? 0;
    const by = byArr.at(-1)?.value ?? 0;
    const dens = densityArr.at(-1)?.value ?? 0;
    const speed = speedArr.at(-1)?.value ?? 0;
    const bt = btArr.at(-1)?.value ?? 0;
    const hp30 = hp30Arr.at(-1)?.hp30 ?? null;
    const kp = kpArr.at(-1)?.kp ?? null;

    // Magnetometer-data
    const fmiData = (await fmiRes.json()).data ?? {};
    const nearestStation = nearestMagnetometerStation(lat, lon);
    let nearestMag = 0;
    if (nearestStation.id === "KIR") {
      nearestMag = kirxData.length ? kirxData.at(-1)?.value ?? 0 : 0;
    } else {
      const nearestDataArr = (fmiData[nearestStation.id] || []);
      nearestMag = nearestDataArr.length ? nearestDataArr.at(-1)?.value ?? 0 : 0;
    }
    let allFMI = [];
    for (const arr of Object.values(fmiData)) {
      if (arr && arr.length) allFMI.push(arr.at(-1)?.value ?? 0);
    }
    const maxMag = allFMI.length ? Math.max(...allFMI.map(v => Math.abs(v))) : 0;

    // Weather
    const weather = window.latestWeather;
    let weatherMsg = "";
    if (weather) {
      const hArr = weather.hourArr || [];
      const cloud = weather.cloudArr || [];
      const cloudThresholdClear = 20, cloudThresholdCloudy = 70;
      const clearNow = cloud[0] <= cloudThresholdClear;
      const cloudyNow = cloud[0] >= cloudThresholdCloudy;
      const firstCloudyIdx = cloud.slice(1).findIndex(c => c >= cloudThresholdCloudy);
      const firstCloudyHour = firstCloudyIdx !== -1 ? hArr[firstCloudyIdx + 1] : null;
      const firstClearIdx = cloud.slice(1).findIndex(c => c <= cloudThresholdClear);
      const firstClearHour = firstClearIdx !== -1 ? hArr[firstClearIdx + 1] : null;
      if (clearNow && firstCloudyHour) {
        weatherMsg += `Clear sky now, clouds expected to increase from ${firstCloudyHour}:00. `;
      } else if (clearNow) {
        weatherMsg += "Clear sky expected throughout the next 6 hours. ";
      } else if (cloudyNow && firstClearHour) {
        weatherMsg += `Cloudy now, expected to clear from ${firstClearHour}:00. `;
      } else if (cloudyNow) {
        weatherMsg += "Heavy clouds expected for the next 6 hours. ";
      } else if (cloud.some(c => c > cloudThresholdClear && c < cloudThresholdCloudy)) {
        weatherMsg += "Partly cloudy skies expected over the next 6 hours. ";
      } else {
        weatherMsg += "Mixed cloud cover expected. ";
      }

      const fog = weather.fogArr || [];
      const fogThreshold = 40;
      const fogNow = fog[0] >= fogThreshold;
      const fogFirstIdx = fog.slice(1).findIndex(f => f >= fogThreshold);
      const fogFirstHour = fogFirstIdx !== -1 ? hArr[fogFirstIdx + 1] : null;
      if (fogNow && fogFirstHour) {
        weatherMsg += "Fog currently reduces visibility and may persist. ";
      } else if (fogNow) {
        weatherMsg += "Fog currently reduces visibility. ";
      } else if (fogFirstHour) {
        weatherMsg += `Fog may develop later, especially from ${fogFirstHour}:00. `;
      }

      if (weather.tempArr && weather.windArr) {
        const avgTemp = Math.round(weather.tempArr.reduce((a, b) => a + b, 0) / weather.tempArr.length);
        const avgWind = Math.round(weather.windArr.reduce((a, b) => a + b, 0) / weather.windArr.length);
        weatherMsg += `Avg. temp: ${avgTemp}°C, avg. wind: ${avgWind} m/s. `;
      }
      weatherMsg += hArr.length ? `(Forecast: ${hArr[0]}:00–${hArr.at(-1)}:00)` : "";
    }

    // Måne
	let moonMsg = "";
	if (weather && weather.moon) {
	  const moon = weather.moon;
	  moonMsg = `Moon phase: ${moon.moon_phase}%`;
	  const hasMoon = (moon.moonrise && moon.moonrise !== "-") || (moon.moonset && moon.moonset !== "-");
	  const maxAlt = typeof moon.moon_altitude === "number" ? moon.moon_altitude : null;
	  let neverVisible = false;
	  if (hasMoon) {
		if (moon.moonrise && moon.moonrise !== "-") {
		  moonMsg += `. Moonrise: ${moon.moonrise}`;
		  if (moon.moonset && moon.moonset !== "-") moonMsg += `, moonset: ${moon.moonset}`;
		} else if (moon.moonset && moon.moonset !== "-") {
		  moonMsg += `. Moonset: ${moon.moonset}`;
		}
		if (maxAlt !== null) moonMsg += `. Max altitude tonight: ${maxAlt}°`;
	  } else if (maxAlt !== null && maxAlt > 0) {
		moonMsg += `. The moon never sets tonight (always visible above the horizon). Max altitude: ${maxAlt}°`;
	  } else {
		neverVisible = true;
		moonMsg += `. The moon never rises above the horizon tonight.`;
		if (maxAlt !== null) moonMsg += ` (Max altitude: ${maxAlt}°)`;
	  }
	  if (moon.moon_phase > 80 && !neverVisible) {
		moonMsg += " (Full moon or nearly full – may reduce aurora visibility.)";
	  }
	}


    // ---- Forecast logic (day/twilight/night) ----
    const sunriseStr = (astro.sunrise ?? "").toString().trim();
    const sunsetStr = (astro.sunset ?? "").toString().trim();
    const dawnStr = (astro.astro_dawn ?? "").toString().trim();
    const duskStr = (astro.astro_dusk ?? "").toString().trim();
    const isNoSunrise = sunriseStr === "" || sunriseStr === "-";
    const isNoSunset = sunsetStr === "" || sunsetStr === "-";
    let isDay = false, isNight = false, isTwilight = false, isMidnightSun = false, isPolarNight = false;

    const parseTime = str => (str && str.includes(":")) ? parseInt(str.split(":")[0]) + parseInt(str.split(":")[1]) / 60 : null;
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const sunrise = parseTime(sunriseStr);
    const sunset = parseTime(sunsetStr);
    const dawn = parseTime(dawnStr);
    const dusk = parseTime(duskStr);

    if (isNoSunrise && isNoSunset) {
      const sunAltNoon = typeof astro.sun_altitude_noon === "number" ? astro.sun_altitude_noon : -99;
      if (sunAltNoon > 0) {
        isMidnightSun = true;
        isDay = true;
      } else {
        isPolarNight = true;
        isNight = true;
      }
    } else if (!isNoSunrise && !isNoSunset) {
      if (dawn && hour >= dawn && hour < sunrise) {
        isTwilight = true;
      } else if (dusk && hour >= sunset && hour < dusk) {
        isTwilight = true;
      } else if (hour >= sunrise && hour < sunset) {
        isDay = true;
      } else {
        isNight = true;
      }
    }

    // Aurora triggers (ingen ändring)
    const standardAuroraTrigger = (bz <= -2 && (Math.abs(nearestMag) >= 30 || maxMag >= 30)) || bz <= -5;
    const byAuroraTrigger = (
      by <= -8 &&
      dens >= 10 &&
      speed >= 500 &&
      bt >= 10 &&
      (Math.abs(nearestMag) >= 30 || maxMag >= 30)
    );
    const globalStrongTrigger = (kp !== null && kp >= 5) || (hp30 !== null && hp30 >= 60);
    const extremeGlobal = (
      (kp !== null && kp >= 7) ||
      (hp30 !== null && hp30 >= 80) ||
      (bz !== null && bz <= -10)
    );
    const hasLocalDisturbance = (Math.abs(nearestMag) >= 30 || maxMag >= 30);

    // Textlogik (ingen ändring)
    let mainMsg = "", headline = "", extraTip = "";
    if (isDay || isMidnightSun) {
      headline = "The sky is too bright for aurora observations at this location.";
      mainMsg = "";
      if (standardAuroraTrigger || byAuroraTrigger || globalStrongTrigger) {
        mainMsg += "<br><b>However, geomagnetic and solar wind conditions are currently strong.</b> If these conditions continue, be ready to check after sunset.";
      }
    } else if (isTwilight) {
      headline = "Aurora is rarely visible during twilight.";
      mainMsg = "Aurora can sometimes be observed during astronomical twilight, but only during very strong geomagnetic storms.";
      if (standardAuroraTrigger || byAuroraTrigger || globalStrongTrigger) {
        mainMsg += "<br><b>Strong conditions detected:</b> If the sky darkens further, there may be a chance for aurora.";
      } else {
        mainMsg += "<br>Only very strong storms make aurora visible at this time.";
      }
      extraTip = "If these conditions persist or strengthen, check again after dark.";
    } else if (isNight || isPolarNight) {
      headline = "Aurora forecast for tonight:";
      if ((standardAuroraTrigger || byAuroraTrigger) && hasLocalDisturbance) {
        mainMsg = "<b>Aurora possible for your location.</b> Conditions are favorable due to strong magnetic disturbance and suitable solar wind values.";
      } else if ((globalStrongTrigger || extremeGlobal) && !hasLocalDisturbance) {
        mainMsg = "<b>Strong geomagnetic storm detected, but no local disturbances recorded.</b> Aurora is unlikely at this location right now.";
      } else {
        mainMsg = "<b>No aurora conditions at the moment.</b>";
      }
    }

    let infoParts = [];
    if (weatherMsg) infoParts.push(weatherMsg);
    if (moonMsg) infoParts.push(moonMsg);
    if (extraTip) infoParts.push(extraTip);

    let nearestInfo = nearestStation
      ? `Based on <b>your selected position</b> (${lat.toFixed(2)}, ${lon.toFixed(2)}). Nearest magnetometer: <b>${nearestStation.name}</b> (${nearestStation.lat.toFixed(2)}, ${nearestStation.lon.toFixed(2)})`
      : `Based on <b>your selected position</b> (${lat.toFixed(2)}, ${lon.toFixed(2)})`;

    // Storm badge
    let alertBadge = "";
    if (extremeGlobal) {
      alertBadge = `<span style="
        position:absolute;top:10px;right:18px;
        background:#f23d3d;
        color:#fff;
        border-radius:20px;
        padding:3px 8px 3px 6px;
        font-size:0.95em;
        font-weight:bold;
        box-shadow:0 0 12px #d00b,0 0 3px #fff4;
        display:inline-flex;
        align-items:center;
        z-index:12;
      ">
        <svg width="12" height="12" style="margin-right:4px" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#fff" stroke="#fff" stroke-width="2"/><text x="10" y="15" text-anchor="middle" font-size="13" fill="#f23d3d" font-family="sans-serif" font-weight="bold">!</text></svg>
        STORM ALERT
      </span>`;
    }

    const condAlert = document.getElementById('cond-alert');
    if (condAlert) {
      condAlert.innerHTML =
        `<div style="position:relative">
           ${alertBadge}
           <div style="font-size:0.7em;color:#fff7;margin-bottom:0.4em;font-style:italic">${nearestInfo}</div>
           <b>${headline}</b><br>
           <span style="font-size:0.7em">${mainMsg}</span>
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
    console.error('updateAuroraForecasts error:', err);
    const condAlert = document.getElementById('cond-alert');
    if (condAlert) {
      condAlert.innerHTML = "<b>Error updating forecast. Please check your connection or reload the page.</b>";
    }
    const headsUpBox = document.getElementById("aurora-headsup");
    if (headsUpBox) headsUpBox.innerHTML = "";
  }
}
