// ---- app/static/js/main.js ----
import { getLocation, getSunData, getMoonData } from './state.js';
import { setupLocation } from './location.js';
import { showWeather, showInPlaceTime, updateWeather } from './weather.js';
import { setupSynopticOverlay } from './synoptic.js';
import { moonPhases, getNearestMoonPhase } from './moonphases.js';
import { loadSolarEvents } from './solar_events.js';
import { drawDoubleGauge } from "./gauge_double.js";
import { setupSolarwind, setupByAuroraScore } from './solarwind.js';
import { setupMagnetometer } from './magnetometer.js';
import { setupMagnetometerFMI, setupMagnetometerFMIEvents } from './magnetometer_fmi.js';
import { setupMagnetometerUIT } from './magnetometer_uit.js';
import { setupMagnetometerGlobal, setupMagnetometerGlobalEvents } from './magnetometer_global.js';
import { updateAuroraForecasts } from './aurora_forecast.js';
import { setupImages, setupOverlayClassic } from './images.js';
import * as EnlilMulti from './enlil-multi.js';
import { drawAzimuthMap } from './azimuth_map.js';
import { drawAstroMasterGraph } from './skyfield_graph.js';
import { updateCoronalHoleCard } from './coronal_hole.js';
import { updateSunspotCard } from './sunspot.js';
import { syncDashboardPanelOwnership } from './dashboard_panels.js';

window.updateSunspotCard = updateSunspotCard;
window.lightPollutionLoaded = false;
window.windyLoaded = false;
window.astroGraphLoaded = false;
window.astroAzimuthLoaded = false;

let solarOverlayIsOpen = false;

function fmtTime(dtstr) {
  if (!dtstr) return "–";
  const hhmmPattern = /^\d{2}:\d{2}$/;
  if (hhmmPattern.test(dtstr)) {
    return dtstr;
  }
  const d = new Date(dtstr);
  if (isNaN(d.getTime())) {
    return "–";
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const auroraOvalImg = document.getElementById('aurora-oval-img');
if (auroraOvalImg) {
auroraOvalImg.addEventListener('click', () => {
const idx = Number(document.getElementById('aurora-slider').value) || 0;
showAuroraOvalOverlay(idx);
});
}

function pollAuroraOvalFrames() {
  setInterval(async () => {
    const res = await fetch('/auroraoval/list');
    const data = await res.json();
    const newFrames = data.files.slice().reverse();
    const slider = document.getElementById('aurora-slider');
    const framesChanged = (
      newFrames.length !== auroraFrames.length ||
      (newFrames[0] && auroraFrames[0] && newFrames[0] !== auroraFrames[0])
    );
    if (framesChanged) {
		auroraFrames = newFrames.filter(f => !f.endsWith('_thumb.png'));   // ENDAST STORA BILDER (till overlay)
		auroraThumbs = auroraFrames.map(f => f.replace('.png', '_thumb.png')); // ENDAST till sidans img, se nedan!
		slider.max = Math.max(auroraFrames.length - 1, 0);
		slider.value = 0;
		updateAuroraOvalImg(0);
    }
  }, 120000);
}

const toggle = document.querySelector('.aurora-dropdown-toggle');
const infoBox = document.getElementById('aurora-oval-info');
const arrow = document.getElementById('aurora-dropdown-arrow');
if (toggle && infoBox) {
  toggle.addEventListener('click', () => {
    const show = infoBox.style.display === "none";
    infoBox.style.display = show ? "block" : "none";
    if (arrow) arrow.textContent = show ? "▲" : "▼";
    if (show) fetchHp();
  });
}

const solarImageTypes = [
  {
    label: "SDO/AIA 193", id: "sdo193", type: "sdo",
    info: `<b>SDO/AIA 193 Å: Hot corona and solar flares.</b><br>
      This extreme ultraviolet image reveals the Sun's outer corona, typically at temperatures around 1.25 million Kelvin.
      193 Å is excellent for spotting coronal holes (dark regions), coronal mass ejections (CMEs), and solar flares, which can all influence Earth's space weather and aurora.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/AIA, updated in near real-time.</span>`
  },
  {
    label: "SDO/AIA 211", id: "sdo211", type: "sdo",
    info: `<b>SDO/AIA 211 Å: Hotter corona and active regions.</b><br>
      Sensitive to even hotter plasma (~2 million Kelvin), 211 Å images emphasize the Sun’s hottest and most dynamic coronal regions.
      Bright areas mark magnetic activity, sunspot groups, and flare sites—often sources of geomagnetic storms.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/AIA, updated in near real-time.</span>`
  },
  {
    label: "SDO/AIA 304", id: "sdo304", type: "sdo",
    info: `<b>SDO/AIA 304 Å: Chromosphere and solar prominences.</b><br>
      304 Å shows cooler material (~50,000–80,000 Kelvin) in the Sun's lower atmosphere.
      Best for visualizing prominences and filaments (long, looping eruptions of plasma) and monitoring areas likely to launch CMEs.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/AIA, updated in near real-time.</span>`
  },
  {
    label: "SDO/AIA 131", id: "sdo131", type: "sdo",
    info: `<b>SDO/AIA 131 Å: Intense solar flares and hottest plasma.</b><br>
      This filter is tuned to extremely high temperatures (10–20 million Kelvin), typically only present during the most powerful solar flares.
      131 Å images help track flare eruption sites and energetic events driving the strongest geomagnetic storms.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/AIA, updated in near real-time.</span>`
  },
  {
    label: "SDO/AIA 171", id: "sdo171", type: "sdo",
    info: `<b>SDO/AIA 171 Å: Quiet corona and magnetic loops.</b><br>
      This filter highlights plasma at about 0.6 million Kelvin and beautifully traces the Sun's magnetic field lines as bright loops.
      Ideal for seeing the large magnetic arches and the structure of 'quiet' coronal areas—useful for tracking subtle changes before solar eruptions.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/AIA, updated in near real-time.</span>`
  },
  {
    label: "SDO/AIA HMIIF", id: "sdohmiif", type: "sdo",
    info: `<b>SDO/HMIIF: White-light intensitygram of the Sun.</b><br>
      This image shows the Sun as it would appear in visible light, much like through a solar telescope.
      Dark spots (sunspots) are regions of intense magnetic activity and lower temperature—prime sites for solar flares and eruptions.
      Tracking sunspots helps forecast solar storms and aurora chances on Earth.
      <br><span class='tooltip-source'><b>Data source:</b> NASA SDO/HMI instrument, updated in near real-time.</span>`
  },
  {
    label: "CCOR1", id: "ccor1", type: "enlil",
    info: `<b>GOES-19 CCOR1: Space-based coronagraph view.</b><br>
      A coronagraph blocks the Sun’s bright disk, allowing the faint outer solar corona to be seen.
      CCOR1 images show coronal mass ejections (CMEs), solar wind streams, and dynamic structures erupting into space.
      Bright features are often CME fronts; tracking these is crucial for predicting geomagnetic storms and aurora on Earth.
      <br><span class='tooltip-source'><b>Data source:</b> NOAA GOES-19 CCOR1 instrument.</span>`
  },
  {
    label: "LASCO C2", id: "lasco-c2", type: "enlil",
    info: `<b>SOHO LASCO C2: Inner solar corona coronagraph.</b><br>
      C2 blocks the Sun to image the corona from 2–6 solar radii.
      Ideal for catching CME launches, shockwaves, and evolving solar wind structures close to the Sun.
      Sudden, bright, expanding features here often indicate an Earth-directed CME, which can cause geomagnetic storms and aurora.
      <br><span class='tooltip-source'><b>Data source:</b> ESA/NASA SOHO LASCO C2 instrument.</span>`
  },
  {
    label: "LASCO C3", id: "lasco-c3", type: "enlil",
    info: `<b>SOHO LASCO C3: Wide-field outer corona coronagraph.</b><br>
      C3 observes a larger field (3.7–30 solar radii), revealing CMEs traveling into interplanetary space, as well as planets and comets near the Sun.
      Wider coverage lets you track the progress and direction of CMEs, which is vital for space weather predictions.
      <br><span class='tooltip-source'><b>Data source:</b> ESA/NASA SOHO LASCO C3 instrument.</span>`
  },
  {
    label: "Synoptic Map", id: "synoptic", type: "sdo",
    info: `<b>NOAA SWPC daily synoptic map.</b><br>
      Shows the locations and classifications of sunspots and active regions across the solar disk.
      <br><span class='tooltip-source'><b>Data source:</b> NOAA/SWPC model output.</span>`
  },
  {
    label: "WSA-ENLIL", id: "enlil", type: "enlil",
    info: `<b>WSA-ENLIL solar wind simulation.</b><br>
      Predicts the propagation of solar wind, coronal mass ejections (CMEs), and shock fronts in the inner solar system.
      Useful for forecasting solar storms impacting Earth.
      <br><span class='tooltip-source'><b>Data source:</b> NOAA/SWPC model output.</span>`
  },
  {
    label: "HUXt Forecast", id: "huxt", type: "huxt",
    info: `<b>HUXt forecast animation.</b><br>
      Time-dependent solar wind and CME forecast from the HUXt model.
      <br><span class='tooltip-source'><b>Data source:</b> University of Reading (HUXt forecast).</span>`
  }
];

async function fetchHp() {
  try {
    const res = await fetch('/ovation/latest_hp');
    const data = await res.json();
    if (data.hemispheric_power_north != null && data.hemispheric_power_south != null) {
      document.getElementById('aurora-hp-info').innerHTML = `
        <b>Hemispheric Power North:</b> ${data.hemispheric_power_north.toFixed(1)} GW<br>
        <b>Hemispheric Power South:</b> ${data.hemispheric_power_south.toFixed(1)} GW<br>
        <span style="font-size:0.93em;color:#a2d7bb;">${data.ts}</span>
      `;
    } else {
      document.getElementById('aurora-hp-info').innerHTML = "<i>No HP-data available</i>";
    }
  } catch (err) {
    document.getElementById('aurora-hp-info').innerHTML = "<i>Couldn't fetch Hemispheric Power</i>";
  }
}

async function fetchKpAndHp30() {

function getStats(arr, periodMinutes, key) {
  if (!arr.length) return { avg: null, min: null, max: null };
  const now = Date.now();
  const threshold = now - periodMinutes * 60 * 1000;
  const filtered = arr.filter(r => {
    let tstr = r.time || r.timestamp;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tstr))
      tstr = tstr.replace(" ", "T") + "Z";
    else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(tstr))
      tstr = tstr.replace(" ", "T") + ":00Z";
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(tstr))
      tstr += ":00Z";
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(tstr))
      tstr += "Z";
    const t = new Date(tstr).getTime();
    return t >= threshold;
  });

  const vals = filtered.map(r => r[key]).filter(x => typeof x === "number" && !isNaN(x) && x > 0);
  if (!vals.length) return { avg: null, min: null, max: null };
  return {
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    min: Math.min(...vals),
    max: Math.max(...vals)
  };
}

  const kpRes = await fetch('/kp/timeseries?hours=12');
  const kpJson = await kpRes.json();
  let kp = 0, kp1h = {}, kp3h = {}, kp6h = {}, kp12h = {};
  if (kpJson.data && kpJson.data.length) {
    const validKp = kpJson.data.filter(r => typeof r.kp === 'number' && !isNaN(r.kp));
    kp = validKp.length ? validKp.at(-1).kp : 0;
	kp1h    = getStats(validKp, 60,  'kp');
	kp3h    = getStats(validKp, 180, 'kp');
	kp6h    = getStats(validKp, 360, 'kp');
	kp12h   = getStats(validKp, 720, 'kp');
  }

  // --- HP30 ---
  const hpRes = await fetch('/hp30/timeseries?hours=12');
  const hpJson = await hpRes.json();
  let hp30 = 0, hp30_1h = {}, hp30_3h = {}, hp30_6h = {}, hp30_12h = {};
  if (hpJson.data && hpJson.data.length) {
    const validHp = hpJson.data.filter(r => typeof r.hp30 === 'number' && !isNaN(r.hp30));
    hp30 = validHp.length ? validHp.at(-1).hp30 : 0;
	hp30_1h = getStats(validHp, 60,  'hp30');
	hp30_3h = getStats(validHp, 180, 'hp30');
	hp30_6h = getStats(validHp, 360, 'hp30');
	hp30_12h= getStats(validHp, 720, 'hp30');
  }

  drawDoubleGauge(
    "double-gauge",
    kp, hp30,
    kp1h, kp3h, kp6h, kp12h,
    hp30_1h, hp30_3h, hp30_6h, hp30_12h
  );
}

function setupTooltips() {
  document.querySelectorAll('.info-tooltip').forEach(el => {
    el.onmouseenter = function () {
      if ('ontouchstart' in window) return;
      showTooltip(this);
    };
    el.onmouseleave = function () {
      if ('ontouchstart' in window) return;
      hideTooltip();
    };
    el.onclick = function (e) {
      if (!('ontouchstart' in window)) return;
      e.preventDefault();
      e.stopPropagation();
      if (tooltipDiv) {
        hideTooltip();
        return;
      }
      showTooltip(this);

      function closeTooltip(ev) {
        hideTooltip();
        document.removeEventListener('click', closeTooltip, true);
      }
      setTimeout(() => {
        document.addEventListener('click', closeTooltip, true);
      }, 1);
    };
  });

  let tooltipDiv = null;

  function showTooltip(el) {
    hideTooltip();
    tooltipDiv = document.createElement('div');
    tooltipDiv.className = 'tooltip-box';
    tooltipDiv.innerHTML = el.dataset.tooltip;
    document.body.appendChild(tooltipDiv);

    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.pageYOffset || window.scrollY;
    const tipW = tooltipDiv.offsetWidth;
    const tipH = tooltipDiv.offsetHeight;

    let left = scrollX + rect.left + rect.width / 2 - tipW / 2;
    let top = scrollY + rect.bottom + 6;

    if (left < scrollX + 4) left = scrollX + 4;
    if (left + tipW > scrollX + window.innerWidth - 4)
      left = scrollX + window.innerWidth - tipW - 4;
    if (top + tipH > scrollY + window.innerHeight - 4) {
      top = scrollY + rect.top - tipH - 6;
      if (top < scrollY + 4) top = scrollY + 4;
    }

    tooltipDiv.style.left = left + 'px';
    tooltipDiv.style.top = top + 'px';
    tooltipDiv.style.opacity = '1';
  }

  function hideTooltip() {
    if (tooltipDiv) tooltipDiv.remove();
    tooltipDiv = null;
  }
}
window.setupTooltips = setupTooltips;

async function updateMoonImage() {
  const moonData = getMoonData();
  if (!moonData) return;
  const currentIllum = moonData.moon_phase;
  const waxing = moonData.is_waxing;
  const best = getNearestMoonPhase(currentIllum, waxing);

  const moonImg = document.getElementById('moon-icon');
  moonImg.src = best.file;

  const { lat, lon, tz } = getLocation();
  const now = new Date();

  const resp = await fetch(`/moonparallax?lat=${lat}&lon=${lon}&time=${encodeURIComponent(now.toISOString())}`);
  const data = await resp.json();
  const parallactic = data.parallactic_angle;

  const IMAGE_BASE_ROTATION = -40;
  let totalRotation = (best.posAngle - parallactic + IMAGE_BASE_ROTATION) % 360;
  if (totalRotation < 0) totalRotation += 360;
  moonImg.style.transform = `rotate(${totalRotation}deg)`;
  moonImg.title = `Månfas: ${currentIllum.toFixed(1)}%, rotation: ${totalRotation.toFixed(1)}°`;
}
window.updateMoonImage = updateMoonImage;

let auroraFrames = [];
let auroraThumbs = [];
let auroraOvalPlayInterval = null;

async function setupAuroraOvalSlider() {
  const res = await fetch('/auroraoval/list');
  const data = await res.json();
  auroraFrames = data.files.slice().reverse().filter(f => !f.endsWith('_thumb.png'));
  auroraThumbs = auroraFrames.map(f => f.replace('.png', '_thumb.png'));
  const slider = document.getElementById('aurora-slider');
  slider.max = Math.max(auroraFrames.length - 1, 0);
  slider.value = 0;
  updateAuroraOvalImg(0);
  slider.oninput = (e) => updateAuroraOvalImg(Number(e.target.value));
}

function updateAuroraOvalImg(idx) {
  idx = Number(idx);
  const img = document.getElementById('aurora-oval-img');
  if (!img || !auroraThumbs.length) return;
  img.src = auroraThumbs[idx];
  img.onclick = () => showAuroraOvalOverlay(idx);
}

function showAuroraOvalOverlay(startIdx = 0) {
  const overlay = document.getElementById('img-overlay');
  const overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg || !auroraFrames.length) return;
  overlay.classList.add('active');
  overlay.classList.add('no-arrows');
  overlayImg.style.transform = 'scale(1)';
  overlayImg.dataset.scale = '1';

  document.getElementById('aurora-oval-slider-box')?.remove();

  const box = document.createElement('div');
  box.id = 'aurora-oval-slider-box';
  box.style = 'position:absolute; top:25px; left:50%; transform:translateX(-50%); background:rgba(20,24,28,0.88); border-radius:0.6em; padding:0.3em 1em; display:flex; gap:0.7em; align-items:center; z-index:10100;';
  box.innerHTML = `
    <button id="aurora-oval-play-btn" title="Play"><i class="fa fa-play"></i></button>
    <input type="range" id="aurora-oval-slider" min="0" max="${auroraFrames.length-1}" value="${startIdx}" style="width:280px;">
    <span id="aurora-oval-slider-label" style="font-size:0.92em;color:#ccc"></span>
  `;
  overlay.appendChild(box);

  const slider = box.querySelector('#aurora-oval-slider');
  const playBtn = box.querySelector('#aurora-oval-play-btn');

  function updateOvalOverlay(idx) {
    overlayImg.src = auroraFrames[idx];
    slider.value = idx;
    box.querySelector('#aurora-oval-slider-label').textContent = "";
  }
  updateOvalOverlay(startIdx);

  slider.oninput = e => {
    stopOvalPlay();
    updateOvalOverlay(Number(e.target.value));
  };

  playBtn.onclick = () => {
    if (auroraOvalPlayInterval) {
      stopOvalPlay();
    } else {
      playBtn.innerHTML = '<i class="fa fa-pause"></i>';
	auroraOvalPlayInterval = setInterval(() => {
	  let idx = Number(slider.value) - 1;
	  if (idx < 0) idx = auroraFrames.length - 1;
	  updateOvalOverlay(idx);
	}, 60);
    }
  };

  function stopOvalPlay() {
    playBtn.innerHTML = '<i class="fa fa-play"></i>';
    if (auroraOvalPlayInterval) clearInterval(auroraOvalPlayInterval);
    auroraOvalPlayInterval = null;
  }

  overlay.querySelector('#img-overlay-close').onclick = e => {
    stopOvalPlay();
    overlay.classList.remove('active');
    box.remove();
  };
  overlay.onclick = e => {
    if (e.target === overlay) {
      stopOvalPlay();
      overlay.classList.remove('active');
      box.remove();
    }
  };
}

window.setAuroraForecastLocation = async function () {
  await updateWeather(() => {
    updateSolarLunarBox();
	updateAuroraForecasts();
  });
};

document.getElementById('topbar-overlay-close').onclick = function () {
  document.getElementById('topbar-overlay').classList.remove('active');
};
document.getElementById('topbar-overlay').onclick = function (e) {
  if (e.target === this) this.classList.remove('active');
};

document.querySelectorAll('.card').forEach(card => {
  const cid = card.id || card.querySelector('.card-header')?.innerText?.replace(/\s/g, '') || '';
  const collapsed = localStorage.getItem('collapsed_card_' + cid) === '1';

  if (collapsed) {
    card.classList.add('collapsed');
    const panel = card.querySelector('.panel-box');
    const icon = card.querySelector('.card-toggle i');
    if (panel) panel.classList.add('hidden');
    if (icon) icon.className = 'fa-solid fa-chevron-down';
  }
});

export function updateSolarLunarBox() {
  const sunData = getSunData();
  const moonData = getMoonData();

  document.getElementById('sunrise-info').textContent =
    sunData && sunData.sunrise ? sunData.sunrise : "–";

  let goldenText = "–";
  if (sunData) {
    const ms = sunData.golden_hour_morning_start;
    const me = sunData.golden_hour_morning_end;
    const es = sunData.golden_hour_evening_start;
    const ee = sunData.golden_hour_evening_end;
    const parts = [];
    if (ms || me) {
      if (ms && me) {
        parts.push(`${fmtTime(ms)}–${fmtTime(me)}`);
      } else if (ms && !me) {
        parts.push(`${fmtTime(ms)}–`);
      } else if (!ms && me) {
        parts.push(`–${fmtTime(me)}`);
      }
    }
    if (es || ee) {
      if (es && ee) {
        parts.push(`${fmtTime(es)}–${fmtTime(ee)}`);
      } else if (es && !ee) {
        parts.push(`${fmtTime(es)}–`);
      } else if (!es && ee) {
        parts.push(`–${fmtTime(ee)}`);
      }
    }
    if (parts.length > 0) {
      goldenText = parts.join(", ");
    }
  }
  document.getElementById('golden-hour-info').textContent = goldenText;
  document.getElementById('sunset-info').textContent =
    sunData && sunData.sunset ? sunData.sunset : "–";

  document.getElementById('sunheight-info').textContent =
    (sunData && sunData.sun_altitude != null)
      ? `${sunData.sun_altitude}°`
      : "–";

  document.getElementById('dawn-info').textContent =
    sunData && sunData.dawn ? fmtTime(sunData.dawn) : "–";

  document.getElementById('dusk-info').textContent =
    sunData && sunData.dusk ? fmtTime(sunData.dusk) : "–";

  document.getElementById('nightlength-info').textContent =
    sunData && sunData.nightlength ? sunData.nightlength : "–";

  const moonPhaseLabelEl = document.getElementById('moon-phase-info');
  const moonAltEl        = document.getElementById('moon-alt-info');
  const nextFullMoonEl   = document.getElementById('next-fullmoon-info');
  const moonImg          = document.getElementById('moon-icon');
  if (moonData) {
    if (moonData.moon_phase_label != null && moonData.moon_phase != null) {
      moonPhaseLabelEl.textContent = `${moonData.moon_phase_label} (${moonData.moon_phase}%)`;
    } else {
      moonPhaseLabelEl.textContent = "–";
    }
    if (moonData.moon_altitude != null) {
      moonAltEl.textContent = `${moonData.moon_altitude}°`;
    } else {
      moonAltEl.textContent = "–";
    }
    nextFullMoonEl.textContent = moonData.next_fullmoon || "–";
    const bestPhase = getNearestMoonPhase(moonData.moon_phase, moonData.is_waxing);
    moonImg.src = bestPhase.file;
    moonImg.alt = `Moon phase: ${moonData.moon_phase_label} (${moonData.moon_phase}%)`;
    moonImg.title = `Moon phase: ${moonData.moon_phase_label} (${moonData.moon_phase}%), Waxing: ${moonData.is_waxing ? "Yes" : "No"}`;
  } else {
    moonPhaseLabelEl.textContent = "–";
    moonAltEl.textContent        = "–";
    nextFullMoonEl.textContent   = "–";
    moonImg.src                  = "/data/moon/moon-00.jpg";
    moonImg.alt                  = "No moon data";
    moonImg.title                = "No moon data";
  }
}

// ---- Solar/SDO timelapse ----

async function showTimelapseInOverlay(dateStr, typeStr) {
  const overlay = document.getElementById('timelapse-overlay');
  const dateEl = overlay.querySelector('#timelapse-overlay-date');
  const typeEl = overlay.querySelector('#timelapse-overlay-type');
  const videoContainer = overlay.querySelector('#timelapse-overlay-video-container');

  // Sätt värden
  if (dateEl && dateStr) dateEl.value = dateStr;
  if (typeEl && typeStr) typeEl.value = typeStr;

  if (!dateEl || !typeEl || !videoContainer) return;
  const date = dateEl.value.replace(/-/g, '');
  const type = typeEl.value;
  const filename = `${type}${date}.mp4`;

  const year = date.substring(0, 4);
  const month = date.substring(4, 6);
  const cleanType = type.endsWith('_') ? type.slice(0, -1) : type;
  const url = `/data/suvi-timelapse/${cleanType}/${year}/${month}/${filename}`;

  try {
    const resp = await fetch(url, { method: 'HEAD' });
    if (resp.ok) {
      videoContainer.innerHTML = `
        <video controls autoplay style="background:#000; border-radius:0.5em; max-width:92vw; max-height:76vh;">
          <source src="${url}" type="video/mp4">
          Your browser can't play this video.
        </video>
        <div style="color:#ccc;font-size:1em; margin-top:0.7em;">${filename}</div>
      `;
      enableZoomPanOnTimelapseVideo('#timelapse-overlay');
    } else {
      videoContainer.innerHTML = `<div style="color:#ff7575; font-size:1em; margin-top:2em;">No video from this date</div>`;
    }
  } catch {
    videoContainer.innerHTML = `<div style="color:#ff7575; font-size:1em; margin-top:2em;">No video from this date</div>`;
  }
}

// ---- Zoom/pan för båda overlays ----
function enableZoomPanOnTimelapseVideo(overlaySel = '#timelapse-overlay') {
  const video = document.querySelector(`${overlaySel} video`);
  if (!video) return;

  let scale = 1, startX = 0, startY = 0, lastX = 0, lastY = 0, isPanning = false;

  video.style.transform = 'scale(1) translate(0px,0px)';
  video.style.cursor = 'grab';

  video.onwheel = function(e) {
    e.preventDefault();
    const delta = Math.sign(e.deltaY) * -0.10;
    scale = Math.min(Math.max(1, scale + delta), 6);
    video.style.transform = `scale(${scale}) translate(${lastX}px,${lastY}px)`;
  };
  video.onmousedown = function(e) {
    isPanning = true;
    startX = e.clientX - lastX;
    startY = e.clientY - lastY;
    video.style.cursor = 'grabbing';
    e.preventDefault();
  };
  window.onmousemove = function(e) {
    if (!isPanning) return;
    lastX = e.clientX - startX;
    lastY = e.clientY - startY;
    video.style.transform = `scale(${scale}) translate(${lastX}px,${lastY}px)`;
  };
  window.onmouseup = function() {
    isPanning = false;
    video.style.cursor = 'grab';
  };
  document.querySelector(overlaySel).addEventListener('transitionend', function(e) {
    if (!this.classList.contains('active')) {
      scale = 1; lastX = 0; lastY = 0;
      video.style.transform = 'scale(1) translate(0px,0px)';
    }
  });
}

// ---- Eventhandlers (lägg i din DOMContentLoaded eller längst ner) ----

// Solar/SDO timelapse
document.getElementById('timelapse-show-btn')?.addEventListener('click', function() {
  // Hämta värden från panelens fält
  const dateStr = document.getElementById('solar-panel-timelapse-date')?.value;
  const typeStr = document.getElementById('solar-panel-timelapse-type')?.value;
  // Öppna overlayen
  document.getElementById('timelapse-overlay')?.classList.add('active');
  // Sätt in exakt dessa i overlayens inputs.
  let tlDate = document.getElementById('timelapse-overlay-date');
  let tlType = document.getElementById('timelapse-overlay-type');
  if (tlDate && dateStr) tlDate.value = dateStr;
  if (tlType && typeStr) tlType.value = typeStr;
  // Kör funktionen – nu garanterat rätt värden!
  showTimelapseInOverlay(dateStr, typeStr);
});

// Timelapse-overlay knappen (inne i overlay)
document.getElementById('timelapse-overlay-show')?.addEventListener('click', function() {
  const overlay = document.getElementById('timelapse-overlay');
  const dateStr = overlay.querySelector('#timelapse-overlay-date')?.value;
  const typeStr = overlay.querySelector('#timelapse-overlay-type')?.value;
  showTimelapseInOverlay(dateStr, typeStr);
});
// CONTINUOUS TIMELAPSE PLAYBACK (main.js)
document.getElementById('timelapse-play-continuous')?.addEventListener('click', async function() {
  const playContinuousBtn = this;
  if (playContinuousBtn.dataset.playing === "1") {
    playContinuousBtn.dataset.playing = "0";
    playContinuousBtn.innerHTML = '<i class="fa fa-forward"></i> Play from this date';
    window._continuousAbort = true;
    return;
  }
  playContinuousBtn.dataset.playing = "1";
  playContinuousBtn.innerHTML = '<i class="fa fa-stop"></i> Stop playback';
  window._continuousAbort = false;

  const overlay = document.getElementById('timelapse-overlay');
  const dateEl = overlay.querySelector('#timelapse-overlay-date');
  const typeEl = overlay.querySelector('#timelapse-overlay-type');
  const videoContainer = overlay.querySelector('#timelapse-overlay-video-container');
  const startDate = dateEl.value;
  const type = typeEl.value;
  const today = new Date();
  let curr = new Date(startDate);

  async function playNext() {
    if (window._continuousAbort) {
      playContinuousBtn.dataset.playing = "0";
      playContinuousBtn.innerHTML = '<i class="fa fa-forward"></i> Play from this date';
      return;
    }
    if (curr > today) {
      playContinuousBtn.dataset.playing = "0";
      playContinuousBtn.innerHTML = '<i class="fa fa-forward"></i> Play from this date';
      return;
    }
    const yyyy = curr.getFullYear();
    const mm = String(curr.getMonth() + 1).padStart(2, '0');
    const dd = String(curr.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}${mm}${dd}`;
    const cleanType = type.endsWith('_') ? type.slice(0, -1) : type;
    const filename = `${type}${dateStr}.mp4`;
    const url = `/data/suvi-timelapse/${cleanType}/${yyyy}/${mm}/${filename}`;

    try {
      const resp = await fetch(url, { method: 'HEAD' });
      if (resp.ok) {
        videoContainer.innerHTML = `
          <video controls autoplay style="background:#000; border-radius:0.5em; max-width:92vw; max-height:76vh;">
            <source src="${url}" type="video/mp4">
            Your browser can't play this video.
          </video>
          <div style="color:#ccc;font-size:1em; margin-top:0.7em;">${filename}</div>
        `;
        const video = videoContainer.querySelector('video');
        video.onended = () => {
          curr.setDate(curr.getDate() + 1);
          playNext();
        };
        video.onerror = () => {
          curr.setDate(curr.getDate() + 1);
          playNext();
        };
        video.play();
      } else {
        curr.setDate(curr.getDate() + 1);
        playNext();
      }
    } catch {
      curr.setDate(curr.getDate() + 1);
      playNext();
    }
  }
  playNext();
});

// ESC & klick utanför för båda overlays
['timelapse-overlay', 'synoptic-overlay'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', function(e) {
    if (e.target === this) {
      this.classList.remove('active');
      this.querySelector('video')?.pause();
      this.querySelector('video')?.remove();
      var el = this.querySelector('.solar-timelapse-date');
	  if (el) el.value = "";
      (this.querySelector('#timelapse-overlay-video-container') || this.querySelector('#synoptic-video-container')).innerHTML = '';
    }
  });
});
document.addEventListener('keydown', e => {
  if (e.key === "Escape") {
    document.getElementById('timelapse-overlay')?.classList.remove('active');
    document.getElementById('timelapse-overlay-video-container').innerHTML = '';
    document.getElementById('synoptic-overlay')?.classList.remove('active');
    document.getElementById('synoptic-video-container').innerHTML = '';
  }
});
document.getElementById('timelapse-overlay-close')?.addEventListener('click', () => {
  document.getElementById('timelapse-overlay')?.classList.remove('active');
  document.getElementById('timelapse-overlay-video-container').innerHTML = '';
});
document.getElementById('synoptic-close')?.addEventListener('click', () => {
  document.getElementById('synoptic-overlay')?.classList.remove('active');
  document.getElementById('synoptic-video-container').innerHTML = '';
});

function showHuxtOverlay(src) {
  const overlay = document.getElementById('huxt-overlay');
  const container = document.getElementById('huxt-video-container');
  if (!overlay || !container) return;
  container.innerHTML = `
    <video class="huxt-video" src="${src}?v=${Date.now()}" controls autoplay loop muted playsinline></video>
  `;
  overlay.classList.add('active');
}

function closeHuxtOverlay() {
  const overlay = document.getElementById('huxt-overlay');
  const container = document.getElementById('huxt-video-container');
  if (overlay) overlay.classList.remove('active');
  if (container) container.innerHTML = '';
}

async function openHuxtLatest() {
  try {
    const res = await fetch('/huxt/list');
    const files = (await res.json()).files || [];
    if (!files.length) return;
    const latest = files[files.length - 1];
    showHuxtOverlay(`/data/huxt/${latest}`);
  } catch (err) {
    console.warn("HUXt quicklink failed:", err);
  }
}

async function ensureImageList(label) {
  try {
    window.imageData = window.imageData || {};
    window.indices = window.indices || {};
    if (window.imageData[label] && window.imageData[label].length) return true;
    const res = await fetch(`/images/list?label=${encodeURIComponent(label)}&_=${Date.now()}`);
    const files = (await res.json()).files || [];
    window.imageData[label] = files;
    window.indices[label] = 0;
    return files.length > 0;
  } catch (err) {
    console.warn("Quicklink image load failed:", err);
    return false;
  }
}

async function ensureEnlilReady() {
  try {
    if (typeof window.loadEnlilPreviews === "function") {
      await window.loadEnlilPreviews();
    }
  } catch (err) {
    console.warn("ENLIL preload failed:", err);
  }
}

document.getElementById('huxt-overlay')?.addEventListener('click', function(e) {
  if (e.target === this) closeHuxtOverlay();
});
document.getElementById('huxt-overlay-close')?.addEventListener('click', closeHuxtOverlay);
document.addEventListener('keydown', e => {
  if (e.key === "Escape") closeHuxtOverlay();
});

window.showSolarImagesInline = async function () {
  const container = document.getElementById('solar-image-list');
  if (!container) return;
  container.innerHTML = '<div style="font-size:1.2em; color:#88aaff; text-align:center; margin:2em auto;">Loading images...</div>';

  // Din typ-lista
  const types = [
    { label: "SDO/AIA 193", id: "sdo193", type: "sdo" },
    { label: "SDO/AIA 211", id: "sdo211", type: "sdo" },
    { label: "SDO/AIA 304", id: "sdo304", type: "sdo" },
    { label: "SDO/AIA 131", id: "sdo131", type: "sdo" },
    { label: "SDO/AIA 171", id: "sdo171", type: "sdo" },
    { label: "SDO/AIA HMIIF", id: "sdohmiif", type: "sdo" },
    { label: "Synoptic Map", id: "synoptic", type: "sdo" },
    { label: "WSA-ENLIL", id: "enlil", type: "enlil" },
    { label: "HUXt Forecast", id: "huxt", type: "huxt" },
    { label: "CCOR1", id: "ccor1", type: "enlil" },
    { label: "LASCO C2", id: "lasco-c2", type: "enlil" },
    { label: "LASCO C3", id: "lasco-c3", type: "enlil" }
  ];

  // Skapa lookup-tabell för tooltip info på både label och id
  const typeInfo = {};
  for (const t of solarImageTypes) {
    typeInfo[t.label] = t.info || "";
    typeInfo[t.id] = t.info || "";
  }

  // Fetch each product once and in parallel when the solar panel is opened.
  window.imageData = window.imageData || {};
  window.indices = window.indices || {};
  const productFiles = await Promise.all(types.map(async ({ label, id, type }) => {
    try {
      let res;
      if (type === "enlil") {
        res = await fetch(`/noaa_anim/list/${id}`);
      } else if (type === "huxt") {
        res = await fetch(`/huxt/list`);
      } else {
        res = await fetch(`/images/list?label=${encodeURIComponent(label)}&_=${Date.now()}`);
        const files = (await res.json()).files || [];
        window.imageData[label] = files;
        window.indices[label] = 0;
        return files;
      }
      return (await res.json()).files || [];
    } catch {
      return [];
    }
  }));

  let html = "";
  for (const [index, { label, id, type }] of types.entries()) {
    const files = productFiles[index];
    try {
      if (files.length) {
        let mediaSrc = "";
        if (type === "enlil") {
          mediaSrc = `/data/noaa_anim/${id}/${files[files.length - 1]}`;
        } else if (type === "huxt") {
          mediaSrc = `/data/huxt/${files[files.length - 1]}`;
        } else {
          mediaSrc = `/images/${files[0]}`;
        }
        // Hämta rätt tooltip-info (både på label & id)
        const tooltipText = typeInfo[label] || typeInfo[id] || "";
        const mediaTag = type === "huxt"
          ? `<video src="${mediaSrc}" class="solar-thumb-video" muted loop playsinline preload="metadata"
               data-label="${label}" data-imgtype="${type}" data-src="${mediaSrc}"></video>`
          : `<img src="${mediaSrc}" alt="${label}" loading="lazy"
               data-label="${label}" data-imgtype="${type}" />`;
        html += `
          <div class="solar-image-thumb">
            <div class="solar-thumb-label">${label}
              <span class="info-tooltip" data-tooltip="${tooltipText}">
                <i class="fa fa-circle-info"></i>
              </span>
            </div>
            ${mediaTag}
          </div>
        `;
      }
    } catch {}
  }
  container.innerHTML = html || "<div style='color:#f88; margin:1em;'>No images could be loaded!</div>";

  // Overlay-logik
  container.querySelectorAll('.solar-image-thumb img, .solar-image-thumb video').forEach(el => {
    el.onclick = () => {
      const label = el.getAttribute('data-label');
      const type = el.getAttribute('data-imgtype');
      if (type === "enlil") {
        if (window.showMultiOverlay) window.showMultiOverlay(label);
      } else if (type === "huxt") {
        const src = el.getAttribute('data-src');
        if (src) showHuxtOverlay(src);
      } else if (type === "sdo") {
        if (window.showSDOOverlayWithSlider) window.showSDOOverlayWithSlider(label);
      } else {
        if (window.openOverlayClassic) window.openOverlayClassic(label);
      }
    };
  });

  // Aktivera tooltips efter render!
  if (typeof setupTooltips === "function") setupTooltips();
};

// ===== Overlay modal controls =====
function openAstroModal(id) {
  document.querySelectorAll('.astro-overlay-modal').forEach(m => m.classList.remove('active'));
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeAstroModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Öppna vid klick på knappar som har data-modal
document.querySelectorAll('[data-modal]').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    openAstroModal(btn.getAttribute('data-modal'));
  });
});

// Stäng med X-knappar
document.querySelectorAll('.astro-overlay-close').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault();
    closeAstroModal(btn.getAttribute('data-modal'));
  });
});

// Klick utanför själva innehållet stänger
document.querySelectorAll('.astro-overlay-modal').forEach(modal => {
  modal.addEventListener('click', e => {
    if (!e.target.closest('.astro-overlay-content')) {
      modal.classList.remove('active');
    }
  });
});

// Esc-stängning
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.astro-overlay-modal.active')
      .forEach(m => m.classList.remove('active'));
  }
});


function openCloudmapIframe() {
  let anchor = document.getElementById('windy-iframe-anchor');
  if (!anchor) return;
  // Rensa gammal iframe om den finns
  anchor.innerHTML = '';
  const { lat, lon } = (typeof getLocation === "function" ? getLocation() : { lat: 64.75, lon: 20.95 });
  let iframe = document.createElement('iframe');
  iframe.src = `https://embed.windy.com/embed2.html?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=5&level=surface&overlay=clouds&menu=&message=true&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=&detailLat=${lat.toFixed(4)}&detailLon=${lon.toFixed(4)}&metricWind=default&metricTemp=default&radarRange=-1`;
  iframe.width = "100%";
  iframe.height = "100%";
  iframe.style = "border:1px solid #000; border-radius:0.25em; background:#000;";
  iframe.allowFullscreen = true;
  anchor.appendChild(iframe);
}

function openLightPollutionIframe() {
  let anchor = document.getElementById('lightpollution-iframe-anchor');
  if (!anchor) return;
  // Rensa gammal iframe om den finns
  anchor.innerHTML = '';
  const { lat, lon } = (typeof getLocation === "function" ? getLocation() : { lat: 64.75, lon: 20.95 });
  let iframe = document.createElement('iframe');
  iframe.src = `https://lightpollutionmap.app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&zoom=7`;
  iframe.width = "100%";
  iframe.height = "100%";
  iframe.style = "border:1px solid #000; border-radius:0.25em; background:#000;";
  iframe.allowFullscreen = true;
  anchor.appendChild(iframe);
}

function setupDashboardPanels() {
  syncDashboardPanelOwnership(window.innerWidth >= 1350);
}

// Rättar eventbindning för alla solar-paneler, även i dashboard
function rebindSolarPanelEvents() {
  // Selects/date-inputs – uppdatera bilderna vid ändring (dashboard-läge).
  document.querySelectorAll('#solar-panel-timelapse-type, #solar-panel-timelapse-date').forEach(inp => {
    inp.onchange = function () {
      if (window.innerWidth >= 1350 && typeof window.showSolarImagesInline === "function") {
        window.showSolarImagesInline();
      }
    };
  });
}
window.rebindSolarPanelEvents = rebindSolarPanelEvents;

let panelNavigationInitialized = false;

function setupPanelNavigation() {
  if (panelNavigationInitialized) return;

  const btns = document.querySelectorAll('.leftbar-btn');
  const panels = document.querySelectorAll('.tab-panel');
  const dashboard = document.getElementById('dashboard-multipanel');
  const panelsWrapper = document.querySelector('.tab-panels-wrapper');
  if (!dashboard) return;

  panelNavigationInitialized = true;

  function showTabPanel(section) {
    dashboard.classList.remove('active');
    if (panelsWrapper) panelsWrapper.style.display = '';
    panels.forEach(panel => panel.classList.toggle('active', panel.dataset.section === section));
    btns.forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
  }

  function refreshStandalonePanel(section) {
    if (section === "cloudmap") openCloudmapIframe();
    if (section === "lightpollution") openLightPollutionIframe();
    if (section === "solar" && typeof window.showSolarImagesInline === "function") {
      window.showSolarImagesInline();
    }
    if (section === "objects-in-sky") drawAzimuthMap('astro-azimuth-embed');
    if (section === "objects-in-sky-graph") drawAstroMasterGraph('astro-master-graph-embed');
  }

  function setActiveTabPanel(section, refresh) {
    showTabPanel(section);
    if (refresh) refreshStandalonePanel(section);
  }

  function setActiveDashboard(section, refresh) {
    const allCols = Array.from(dashboard.children);
    const dashboardColumn = {
      solarwind: "dashboard-solarwind",
      magnetometer: "dashboard-magnetometer",
      solar: "dashboard-solar",
    }[section];

    if (section !== "location" && !dashboardColumn) {
      showTabPanel(section);
      if (refresh) refreshStandalonePanel(section);
      return;
    }

    dashboard.classList.add('active');
    if (panelsWrapper) panelsWrapper.style.display = 'none';
    panels.forEach(panel => panel.classList.remove('active'));
    btns.forEach(btn => btn.classList.toggle('active', btn.dataset.section === section));
    allCols.forEach(col => {
      col.style.display = section === "location" || col.id === dashboardColumn ? "flex" : "none";
    });

    if (!refresh) return;
    if (section === "location") {
      rebindSolarPanelEvents();
    } else if (section === "solarwind") {
      setupSolarwind();
    } else if (section === "magnetometer") {
      setupMagnetometer();
      setupMagnetometerUIT();
      setupMagnetometerFMI();
      setupMagnetometerGlobal();
    } else if (section === "solar" && typeof window.showSolarImagesInline === "function") {
      window.showSolarImagesInline();
    }
  }

  function setActive(section, { refresh = true } = {}) {
    if (window.innerWidth >= 1350) {
      setActiveDashboard(section, refresh);
    } else {
      setActiveTabPanel(section, refresh);
    }
  }

  btns.forEach(btn => btn.addEventListener('click', () => setActive(btn.dataset.section)));
  setActive('location', { refresh: false });

  window.addEventListener('resize', () => {
    const activeBtn = document.querySelector('.leftbar-btn.active');
    const section = activeBtn?.dataset.section || "location";
    setupDashboardPanels();
    setActive(section, { refresh: false });
  });
}

// ---- AllSky latest image (supports dashboard cloning) ----
let allSkyTimer = null;
let allSkyLastKey = ""; // "YYYYMMDD|filename"
let allSkyActiveCam = "ytterboda";
const allSkyLastKeyByCam = {}; // cam -> "date|filename"

function setAllSkyActiveCam(cam) {
  allSkyActiveCam = String(cam || "ytterboda");

  document.querySelectorAll('.allsky-current-card').forEach(card => {
    card.dataset.allskyCam = allSkyActiveCam;

    const title = card.querySelector('.allsky-title');
    if (title) {
      if (allSkyActiveCam === "tavelsjo") title.textContent = "AllSky Tavelsjö";
      else if (allSkyActiveCam === "kiruna") title.textContent = "AllSky Kiruna";
      else title.textContent = "AllSky Ytterboda, Umeå";
    }

    card.querySelectorAll('.allsky-tab-btn').forEach(btn => {
      const isActive = (btn.dataset.cam === allSkyActiveCam);
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    card.querySelectorAll('[data-allsky-only]').forEach(btn => {
      const only = String(btn.dataset.allskyOnly || "").split(',').map(s => s.trim()).filter(Boolean);
      btn.style.display = only.includes(allSkyActiveCam) ? '' : 'none';
    });

    const replayBtn = card.querySelector('.allsky-replay-btn');
    if (replayBtn) {
      const ok = (allSkyActiveCam === "ytterboda");
      replayBtn.disabled = !ok;
      replayBtn.classList.toggle('disabled', !ok);
    }
  });
}


async function refreshAllSkyThumbs(date, activeFilename) {
  const cam = allSkyActiveCam;
  const resp = await fetch(`/api/allsky/thumbnails?cam=${encodeURIComponent(cam)}&date=${encodeURIComponent(date)}`, { cache: 'no-store' });
  const data = await resp.json();

  if (!data || !Array.isArray(data.items)) {
    throw new Error(data?.error || 'No thumbnails returned');
  }

  document.querySelectorAll('.allsky-current-card').forEach(card => {
    const strip = card.querySelector('.allsky-thumb-strip');
    if (!strip) return;

    strip.innerHTML = '';

	  const frag = document.createDocumentFragment();

	for (const it of data.items) {
      const wrapper = document.createElement("div");
		  wrapper.className = "allsky-thumb-item";

		const time = document.createElement("div");
      time.className = "allsky-thumb-time";
		  time.textContent = it.captured || formatAllSkyTimeFromFilename(it.filename);

		  const img = document.createElement("img");
		  img.className = "allsky-thumb" + (it.filename === activeFilename ? " active" : "");
		  img.loading = "lazy";
		  img.alt = time.textContent ? `AllSky ${time.textContent}` : "AllSky thumbnail";
		  img.src = it.thumb_url;
		  img.dataset.fullUrl = it.full_url;
		  img.dataset.filename = it.filename;

      wrapper.appendChild(time);
		  wrapper.appendChild(img);
		  frag.appendChild(wrapper);
	  }

	strip.innerHTML = "";
	strip.appendChild(frag);
	strip.scrollLeft = 0;

  });
}

async function refreshAllSky() {
  try {
		const cam = allSkyActiveCam;
		const resp = await fetch(`/api/allsky/latest?cam=${encodeURIComponent(cam)}`, { cache: 'no-store' });
		const data = await resp.json();

    if (!data || !data.url) {
      throw new Error(data?.error || 'No URL returned');
    }

    const newKey = `${data.date || ''}|${data.filename || ''}`;
    const isNew = newKey && (newKey !== allSkyLastKey);

    document.querySelectorAll('.allsky-current-card').forEach(card => {
      const img = card.querySelector('.allsky-current-img');
      const updated = card.querySelector('.allsky-current-updated');
      const filename = card.querySelector('.allsky-current-filename');
      const status = card.querySelector('.allsky-current-status');

      if (img) {
        // Avoid flicker: only replace src when it actually changed
        if (img.dataset.lastUrl !== data.url) {
          img.src = `${data.url}?v=${Date.now()}`; // cache-bust to be safe
          img.dataset.lastUrl = data.url;
        }
        img.style.cursor = 'pointer';
      }

      if (updated) updated.textContent = data.captured || '';
      if (filename) filename.textContent = data.filename ? `Latest: ${data.filename}` : '';
      if (status) status.textContent = '';
    });

    if (isNew) {
      allSkyLastKey = newKey;
      // Fetch + render ALL thumbnails (newest first) for the current date folder
      refreshAllSkyThumbs(data.date, data.filename).catch(() => {});
    }

  } catch (err) {
    document.querySelectorAll('.allsky-current-card .allsky-current-status').forEach(el => {
      el.textContent = `AllSky fetch failed: ${err?.message || err}`;
    });
  }
}

function formatAllSkyTimeFromFilename(filename) {
  // Expected: image-YYYYMMDDHHMMSS.jpg
  const m = String(filename || "").match(/image-(\d{14})\.(jpg|jpeg|png)$/i);
  if (!m) return "";
  const ts = m[1];
  return `${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}`;
}

function setupAllSky() {
  if (allSkyTimer) clearInterval(allSkyTimer);

  document.querySelectorAll('.allsky-tab-btn').forEach(btn => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener('click', () => {
      setAllSkyActiveCam(btn.dataset.cam || "ytterboda");
      refreshAllSky();
    });
  });

  setAllSkyActiveCam(allSkyActiveCam);
  refreshAllSky();
  allSkyTimer = setInterval(refreshAllSky, 15000);
}

// Click to open the shared overlay
document.addEventListener('click', (e) => {
  const img = e.target.closest('.allsky-current-img');
  if (!img) return;

  const overlay = document.getElementById('img-overlay');
  const overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;

  overlayImg.src = img.src;
  overlayImg.alt = 'AllSky latest image';
  overlay.classList.add('active');
  overlay.classList.add('no-arrows');

  overlayImg.style.transform = 'scale(1) translate(0px,0px)';
  overlayImg.dataset.scale = '1';
  overlayImg.dataset.translateX = '0';
  overlayImg.dataset.translateY = '0';
});

document.addEventListener('click', (e) => {
  const thumb = e.target.closest('.allsky-thumb');
  if (!thumb) return;

  const overlay = document.getElementById('img-overlay');
  const overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;

  const src = thumb.dataset.fullUrl;
  if (!src) return;

  overlayImg.src = `${src}?v=${Date.now()}`; // cache-bust for safety
  overlayImg.alt = 'AllSky image';
  overlay.classList.add('active');
  overlay.classList.add('no-arrows');

  overlayImg.style.transform = 'scale(1) translate(0px,0px)';
  overlayImg.dataset.scale = '1';
  overlayImg.dataset.translateX = '0';
  overlayImg.dataset.translateY = '0';
});

document.addEventListener("wheel", (e) => {
  const strip = e.target.closest(".allsky-thumb-strip");
  if (!strip) return;

  // If user scrolls vertically while hovering the strip, convert to horizontal scroll
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    strip.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });


// --- Replay overlay -------------------------------------------------------------

const replayState = {
  timer: null,
  stepSeconds: 60,
  t0: null,  // epoch ms
  t1: null,  // epoch ms
	tCursor: null, // epoch ms (master clock)
  solarwind: [],
	magnetometer: {}, // { STATION: [{t,value}, ...], ... }
  mag_irf: {},
  mag_fmi: {},
  mag_global: {},
  kp: [],
  hp30: [],
  sdo: [],
  allsky: [],
};

// Replay-only sanity limit for magnetometer values (detrended nT).
// Any sample outside +/- this value is ignored for rendering.
const REPLAY_MAG_ABS_LIMIT = 3000;
function replayMagValueOk(v) {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= REPLAY_MAG_ABS_LIMIT;
}

// --- Replay: Solar wind propagation L1 -> Earth (Replay only) -------------------
const REPLAY_L1_DISTANCE_KM = 1_500_000;
const REPLAY_MIN_SW_SPEED_KMS = 200;
const REPLAY_MAX_SW_DELAY_MS = 3 * 3600 * 1000;

function replaySolarwindDelayMs(speedKms) {
  let s = Number(speedKms);
  if (!isFinite(s)) s = REPLAY_MIN_SW_SPEED_KMS;
  if (s < REPLAY_MIN_SW_SPEED_KMS) s = REPLAY_MIN_SW_SPEED_KMS;
  let delayMs = (REPLAY_L1_DISTANCE_KM / s) * 1000;
  if (!isFinite(delayMs) || delayMs < 0) delayMs = 0;
  if (delayMs > REPLAY_MAX_SW_DELAY_MS) delayMs = REPLAY_MAX_SW_DELAY_MS;
  return delayMs;
}

function replayClamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function toEpochMsUtc(isoZ) {
  const d = new Date(isoZ);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function isoDayFromDateInput(v) {
  // Accept: "YYYY-MM-DD" (from <input type="date">), "DD/MM/YYYY", or "YYYYMMDD"
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(v)) {
    const [dd, mm, yyyy] = v.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }

  const digits = v.replace(/\D/g, "");
  if (digits.length >= 8) {
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  return "";
}

function nearestByTime(items, tMs) {
  if (!items || items.length === 0 || tMs == null) return null;

  let lo = 0, hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].t < tMs) lo = mid + 1;
    else hi = mid;
  }
  const a = items[lo];
  const b = items[Math.max(0, lo - 1)];
  if (!b) return a;
  return (Math.abs(a.t - tMs) < Math.abs(b.t - tMs)) ? a : b;
}

function ensureHiDpiCanvas(canvas, defaultCssHeight = 160) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 1200));
  const cssH = Math.max(1, Math.floor(rect.height || canvas.clientHeight || defaultCssHeight));
  const needW = Math.floor(cssW * dpr);
  const needH = Math.floor(cssH * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width = needW;
    canvas.height = needH;
  }
  const ctx = canvas.getContext("2d");
  // Draw in CSS pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}


const replaySeriesStyle = {
  speed:   { stroke: '#fff262', fill: 'rgba(255,242,98,0.14)' },
  density: { stroke: '#b6ff5a', fill: 'rgba(182,255,90,0.14)' },
  bt:      { stroke: '#b6ff5a', fill: 'rgba(182,255,90,0.10)' },
  bz:      { stroke: '#ff5252', splitZero: true },
  by:      { stroke: '#90caf9', splitZero: true },
  kp:      { stroke: '#e53935', fill: 'rgba(229,57,53,0.12)' },
  hp30:    { stroke: '#ff9100', fill: 'rgba(255,145,0,0.12)' },
  hp60:    { stroke: '#ff9100', fill: 'rgba(255,145,0,0.10)' },
  mag:     { stroke: '#ffd54f', splitZero: true },
};

// Station colors aligned with main site (IRF + FMI + GLOBAL)
const replayMagColors = {
  // IRF
  KIR: '#ffa500',
  TOP: '#7dc9f5',

  // FMI
  KEV: '#e57373',
  MAS: '#e5ae73',
  KIL: '#e3e573',
  IVA: '#b7e573',
  MUO: '#88e573',
  SOD: '#73e591',
  PEL: '#73e5c7',
  RAN: '#73d0e5',
  OUJ: '#73a3e5',
  MEK: '#737de5',
  HAN: '#9173e5',
  NUR: '#b473e5',
  TAR: '#d873e5',

  // Global
  BOU: '#e57373',
  FRD: '#64b5f6',
  BRW: '#ffd54f',
  CMO: '#81c784',
};

// Station groups for Replay magnetometer split
const REPLAY_IRF_STATIONS = new Set(['KIR', 'TOP']);
const REPLAY_FMI_STATIONS = new Set([
  'KEV', 'MAS', 'KIL', 'IVA', 'MUO', 'SOD', 'PEL', 'RAN', 'OUJ', 'MEK', 'HAN', 'NUR', 'TAR'
]);
// Everything else we recognize as "global" (incl. UIT-ish stations)
const REPLAY_GLOBAL_STATIONS = new Set(['BOU', 'FRD', 'BRW', 'CMO', 'TRO', 'NOR', 'HOP']);

function replaySplitMagSeriesMap(seriesMap) {
  const irf = {};
  const fmi = {};
  const global = {};

  for (const [stRaw, arr] of Object.entries(seriesMap || {})) {
    const st = String(stRaw || '').toUpperCase();
    if (REPLAY_IRF_STATIONS.has(st)) irf[st] = arr;
    else if (REPLAY_FMI_STATIONS.has(st)) fmi[st] = arr;
    else if (REPLAY_GLOBAL_STATIONS.has(st)) global[st] = arr;
    else global[st] = arr; // unknown -> keep visible
  }

  return { irf, fmi, global };
}

function replayMagCurrentText(seriesMap, tMs, preferredStation = null) {
  const keys = Object.keys(seriesMap || {});
  if (!keys.length) return '';

  const st = (preferredStation && seriesMap[preferredStation])
    ? preferredStation
    : keys.sort()[0];

  const now = nearestByTime(seriesMap[st] || [], tMs);
  if (now?.value == null) return '';
  return `${replayFmtNum(now.value, 2)} NT (${st})`;
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt ?? '';
}

function fmtNum(v, decimals = 2) {
  if (v == null || !isFinite(v)) return null;
  return Number(v).toFixed(decimals);
}

// ---- Replay helpers (compat: replaySetTime() uses these names) ----
function replaySetText(id, txt) {
  setText(id, txt);
}

function replayFmtNum(v, decimals = 2) {
  const s = fmtNum(v, decimals);
  return s == null ? "" : s;
}

function drawSeries(canvas, items, valueKey, tCursor, style = null) {
  if (!canvas) return;
	const { ctx, w, h } = ensureHiDpiCanvas(canvas, 160);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 0, w, h);

  if (!items || items.length < 2 || replayState.t0 == null || replayState.t1 == null) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "14px sans-serif";
    ctx.fillText("No data", 12, 22);
    return;
  }

  let minV = Infinity, maxV = -Infinity;
  for (const it of items) {
    const v = it[valueKey];
    if (v == null) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!isFinite(minV) || !isFinite(maxV) || minV === maxV) {
    minV -= 1; maxV += 1;
  }

  const tMin = replayState.t0;
  const tMax = replayState.t1;

  const st = style || {};
  if (st.splitZero) {
    minV = Math.min(minV, 0);
    maxV = Math.max(maxV, 0);
    const y0 = h - ((0 - minV) / (maxV - minV)) * h;
    ctx.fillStyle = "rgba(70,255,70,0.08)";
    ctx.fillRect(0, 0, w, Math.max(0, Math.min(h, y0)));
    ctx.fillStyle = "rgba(255,82,82,0.10)";
    ctx.fillRect(0, Math.max(0, Math.min(h, y0)), w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();
  }
  ctx.strokeStyle = st.stroke || "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  let started = false;
  for (const it of items) {
    const v = it[valueKey];
    if (v == null) continue;

    const x = ((it.t - tMin) / (tMax - tMin)) * w;
    const y = h - ((v - minV) / (maxV - minV)) * h;

    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  if (st.fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = st.fill;
    ctx.fill();
  }

  if (tCursor != null) {
    const cx = ((tCursor - tMin) / (tMax - tMin)) * w;
    ctx.strokeStyle = "rgba(0,200,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }
}

function drawMultiSeries(canvas, seriesMap, tCursor) {
  if (!canvas) return;
  const { ctx, w, h } = ensureHiDpiCanvas(canvas, 160);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, 0, w, h);

  const stations = Object.keys(seriesMap || {});
  const all = [];
  for (const st of stations) {
    const arr = seriesMap[st] || [];
    if (arr.length) all.push(arr);
  }

  if (!all.length || replayState.t0 == null || replayState.t1 == null) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "14px sans-serif";
    ctx.fillText("No data", 12, 22);
    return;
  }

  let minV = Infinity, maxV = -Infinity;
  for (const arr of all) {
    for (const it of arr) {
      const v = it.value;
      if (v == null) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!isFinite(minV) || !isFinite(maxV) || minV === maxV) {
    minV -= 1; maxV += 1;
  }

  const tMin = replayState.t0;
  const tMax = replayState.t1;

  // SWL-ish split background around 0
  minV = Math.min(minV, 0);
  maxV = Math.max(maxV, 0);
  const y0 = h - ((0 - minV) / (maxV - minV)) * h;
  ctx.fillStyle = "rgba(70,255,70,0.08)";
  ctx.fillRect(0, 0, w, Math.max(0, Math.min(h, y0)));
  ctx.fillStyle = "rgba(255,82,82,0.10)";
  ctx.fillRect(0, Math.max(0, Math.min(h, y0)), w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(w, y0);
  ctx.stroke();

  const palette = [
    "#ffffff",
    "#00c8ff",
    "#00ff8c",
    "#ffdc00",
    "#ff7800",
    "#c878ff",
    "#ff50a0",
  ];

  let idx = 0;
  for (const st of stations) {
    const arr = (seriesMap[st] || []).filter(it => it && it.t != null && it.value != null);
    if (arr.length < 2) continue;

    const hex = replayMagColors[st];
    ctx.strokeStyle = hex || palette[idx % palette.length];
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (const it of arr) {
      const x = ((it.t - tMin) / (tMax - tMin)) * w;
      const y = h - ((it.value - minV) / (maxV - minV)) * h;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    idx++;
  }

  if (tCursor != null) {
    const cx = ((tCursor - tMin) / (tMax - tMin)) * w;
    ctx.strokeStyle = "rgba(0,200,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }
}


function replaySetStatus(msg) {
  const el = document.getElementById("replay-status");
  if (el) el.textContent = msg || "";
}

function replayClockSet(tMs) {
  replayState.tCursor = tMs;
  replaySetTime(tMs);
}

function replaySetTime(tMs) {
  const allskyImg = document.getElementById("replay-allsky-img");
  const sdoImg = document.getElementById("replay-sdo-img");
  const label = document.getElementById("replay-time-label");

  const a = nearestByTime(replayState.allsky, tMs);
  const s = nearestByTime(replayState.sdo, tMs);

  if (a && allskyImg && allskyImg.dataset.lastUrl !== a.url) {
    allskyImg.src = `${a.url}${a.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    allskyImg.dataset.lastUrl = a.url;
  }

  if (s && sdoImg && sdoImg.dataset.lastUrl !== s.url) {
    sdoImg.src = `${s.url}${s.url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    sdoImg.dataset.lastUrl = s.url;
  }

  if (label) {
    const d = new Date(tMs ?? 0);
    label.textContent = `${d.toLocaleString()} (local)`;
  }

  if (!s && sdoImg) {
    sdoImg.removeAttribute("src");
  }

  // Update header "current" values if elements exist
  const swNow = nearestByTime(replayState.solarwind, tMs);
  replaySetText(
    'replay-sw-speed-current',
    swNow?.speed != null ? `${replayFmtNum(swNow.speed, 2)} KM/S` : ''
  );
  replaySetText(
    'replay-sw-density-current',
    swNow?.density != null ? `${replayFmtNum(swNow.density, 2)} P/CM³` : ''
  );
  replaySetText(
    'replay-sw-bt-current',
    swNow?.bt != null ? `${replayFmtNum(swNow.bt, 2)} NT` : ''
  );
  replaySetText(
    'replay-sw-bz-current',
    swNow?.bz != null ? `${replayFmtNum(swNow.bz, 2)} NT` : ''
  );
  replaySetText(
    'replay-sw-by-current',
    swNow?.by != null ? `${replayFmtNum(swNow.by, 2)} NT` : ''
  );

  const kpNow = nearestByTime(replayState.kp, tMs);
  replaySetText('replay-kp-current', kpNow?.kp != null ? `${replayFmtNum(kpNow.kp, 1)}` : '');

  const hp30Now = nearestByTime(replayState.hp30, tMs);
  replaySetText('replay-hp30-current', hp30Now?.hp30 != null ? `${replayFmtNum(hp30Now.hp30, 0)}` : '');

  // Magnetometer "current" values (split: IRF / FMI / GLOBAL)
  const preferred = (document.getElementById('replay-station')?.value || '').toUpperCase();
  replaySetText('replay-mag-irf-current', replayMagCurrentText(replayState.mag_irf, tMs, preferred));
  replaySetText('replay-mag-fmi-current', replayMagCurrentText(replayState.mag_fmi, tMs, preferred));
  replaySetText('replay-mag-global-current', replayMagCurrentText(replayState.mag_global, tMs, preferred));

  // Draw graphs (IDs can be missing depending on your current modal markup)
  drawSeries(document.getElementById("replay-sw-speed-canvas"), replayState.solarwind, "speed", tMs, replaySeriesStyle.speed);
  drawSeries(document.getElementById("replay-sw-density-canvas"), replayState.solarwind, "density", tMs, replaySeriesStyle.density);
  drawSeries(document.getElementById("replay-sw-bt-canvas"), replayState.solarwind, "bt", tMs, replaySeriesStyle.bt);
  drawSeries(document.getElementById("replay-sw-bz-canvas"), replayState.solarwind, "bz", tMs, replaySeriesStyle.bz);
  drawSeries(document.getElementById("replay-sw-by-canvas"), replayState.solarwind, "by", tMs, replaySeriesStyle.by);
  drawSeries(document.getElementById("replay-kp-canvas"), replayState.kp, "kp", tMs, replaySeriesStyle.kp);
  drawSeries(document.getElementById("replay-hp30-canvas"), replayState.hp30, "hp30", tMs, replaySeriesStyle.hp30);

  // Backwards compatible fallback if you still have the old single SW canvas
  drawSeries(document.getElementById("replay-sw-canvas"), replayState.solarwind, "bz", tMs, replaySeriesStyle.bz);

  // Magnetometer: split graphs
  drawMultiSeries(document.getElementById("replay-mag-irf-canvas"), replayState.mag_irf, tMs);
  drawMultiSeries(document.getElementById("replay-mag-fmi-canvas"), replayState.mag_fmi, tMs);
  drawMultiSeries(document.getElementById("replay-mag-global-canvas"), replayState.mag_global, tMs);
 }

async function replayLoadDay(dateStr, station) {
  const isoDay = isoDayFromDateInput(dateStr);
  if (!isoDay) {
    replaySetStatus("Invalid date");
    return;
  }

  replaySetStatus("Loading…");

	const stationsParam = (station || "KIR").toUpperCase() === "ALL" ? "ALL" : station;
  const resp = await fetch(
    `/api/replay/day?date=${encodeURIComponent(isoDay)}&stations=${encodeURIComponent(stationsParam)}&component=x`,
    { cache: "no-store" }
  );

  if (!resp.ok) {
    replaySetStatus(`Load failed (${resp.status})`);
    return;
  }

  const man = await resp.json();
  if (man?.error) {
    replaySetStatus(man.error);
    return;
  }

  replayState.t0 = toEpochMsUtc(man.start);
  replayState.t1 = toEpochMsUtc(man.end);

  // Solar wind: shift timestamps forward so Replay aligns with Earth impacts
  replayState.solarwind = (man.solarwind || [])
    .map(r => {
      const rawT = toEpochMsUtc(r.time);
      if (rawT == null) return null;
      const delayMs = replaySolarwindDelayMs(r.speed);
      let tEarth = rawT + delayMs;
      // Keep it inside the replay day window to avoid weird end-of-day clipping
      if (replayState.t0 != null && replayState.t1 != null) {
        tEarth = replayClamp(tEarth, replayState.t0, replayState.t1);
      }
      return {
        t: tEarth,
        speed: r.speed,
        density: r.density,
        bt: r.bt,
        bz: r.bz,
        by: r.by,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  // Magnetometer: keep as station->series map for multi-line rendering
  replayState.magnetometer = {};
  const magMap = (man.magnetometer || {});
  if ((station || "").toUpperCase() === "ALL") {
    for (const [st, arr] of Object.entries(magMap)) {
      replayState.magnetometer[st] = (arr || [])
			.map(r => ({ t: toEpochMsUtc(r.time), value: Number(r.value) }))
			.filter(r => r.t != null && replayMagValueOk(r.value))
        .sort((a, b) => a.t - b.t);
    }

  // Build split magnetometer maps for the three Replay charts
  {
    const split = replaySplitMagSeriesMap(replayState.magnetometer);
    replayState.mag_irf = split.irf;
    replayState.mag_fmi = split.fmi;
    replayState.mag_global = split.global;
  }

  } else {
    const arr = (magMap?.[station] || []);
    replayState.magnetometer[station] = (arr || [])
      .map(r => ({ t: toEpochMsUtc(r.time), value: r.value }))
      .filter(r => r.t != null)
      .sort((a, b) => a.t - b.t);
  }

  replayState.kp = (man.kp || [])
    .map(r => ({ t: toEpochMsUtc(r.time), kp: r.kp }))
    .filter(r => r.t != null && r.kp != null)
    .sort((a, b) => a.t - b.t);

  const hp = (man.hp || [])
    .map(r => ({ t: toEpochMsUtc(r.time), hp30: r.hp30 }))
    .filter(r => r.t != null)
    .sort((a, b) => a.t - b.t);
  replayState.hp30 = hp.filter(r => r.hp30 != null).map(r => ({ t: r.t, hp30: r.hp30 }));

  replayState.sdo = (man.sdo_193 || [])
    .map(r => ({ t: toEpochMsUtc(r.time), url: r.url }))
    .filter(r => r.t != null)
    .sort((a, b) => a.t - b.t);

  replayState.allsky = (man.allsky || [])
    .map(r => ({ t: toEpochMsUtc(r.time), url: r.url }))
    .filter(r => r.t != null)
    .sort((a, b) => a.t - b.t);

  console.log("Replay counts", {
    allsky: replayState.allsky.length,
    sdo: replayState.sdo.length,
    solarwind: replayState.solarwind.length,
    magnetometerStations: Object.keys(replayState.magnetometer || {}).length,
    kp: replayState.kp.length,
    hp30: replayState.hp30.length,
    mag_irf: Object.keys(replayState.mag_irf || {}).length,
    mag_fmi: Object.keys(replayState.mag_fmi || {}).length,
    mag_global: Object.keys(replayState.mag_global || {}).length,
  });

  const slider = document.getElementById("replay-slider");
  if (slider && replayState.t0 != null && replayState.t1 != null) {
    slider.min = 0;
    slider.max = 1440;
    slider.value = 0;

    slider.oninput = () => {
      const mins = parseInt(slider.value, 10) || 0;
      const t = replayState.t0 + mins * 60 * 1000;
      replayClockSet(t);
    };
  }

  if (replayState.t0 == null) {
    replaySetStatus("No time range returned (start/end missing).");
    return;
  }

  replaySetStatus(
    `Loaded: AllSky=${replayState.allsky.length}, SDO=${replayState.sdo.length}, SW=${replayState.solarwind.length}, Kp=${replayState.kp.length}, HP30=${replayState.hp30.length}, MAG(IRF)=${Object.keys(replayState.mag_irf || {}).length}, MAG(FMI)=${Object.keys(replayState.mag_fmi || {}).length}, MAG(Global)=${Object.keys(replayState.mag_global || {}).length}`
  );

  replayClockSet(replayState.t0);
}

function replayStart() {
  replayStop();
  const slider = document.getElementById("replay-slider");
  if (!slider) return;

  const stepMins = Math.max(1, Math.round((replayState.stepSeconds || 60) / 60));

  replayState.timer = setInterval(() => {
    let v = parseInt(slider.value, 10) || 0;
    v += stepMins;
    if (v > parseInt(slider.max, 10)) v = parseInt(slider.min, 10);

    slider.value = String(v);

    if (replayState.t0 != null) {
      replayClockSet(replayState.t0 + v * 60 * 1000);
    }
  }, 250);
}

function replayStop() {
  if (replayState.timer) {
    clearInterval(replayState.timer);
    replayState.timer = null;
  }
}

function openReplayOverlay() {
  const el = document.getElementById("replay-overlay");
  if (!el) return;

  el.classList.add("active");

  const d = document.getElementById("replay-date");
  if (d && !d.value) {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    d.value = now.toISOString().slice(0, 10);
  }

  replaySetStatus("");
}

function closeReplayOverlay() {
  replayStop();
  const el = document.getElementById("replay-overlay");
  if (el) el.classList.remove("active");
}

function initReplayOverlay() {
  const openBtn = document.querySelector(".allsky-replay-btn");
  const closeBtn = document.getElementById("replay-close");
  const loadBtn = document.getElementById("replay-load");
  const playBtn = document.getElementById("replay-play");
  const pauseBtn = document.getElementById("replay-pause");

  if (openBtn) openBtn.addEventListener("click", openReplayOverlay);
  if (closeBtn) closeBtn.addEventListener("click", closeReplayOverlay);

  if (loadBtn) {
    loadBtn.addEventListener("click", async () => {
      const dateStr = document.getElementById("replay-date")?.value || "";
      const st = document.getElementById("replay-station")?.value || "KIR";
      const sp = parseInt(document.getElementById("replay-speed")?.value || "60", 10) || 60;
      replayState.stepSeconds = sp;

      try {
        await replayLoadDay(dateStr, st);
      } catch (err) {
        replaySetStatus(`Error: ${err?.message || err}`);
      }
    });
  }

  if (playBtn) playBtn.addEventListener("click", replayStart);
  if (pauseBtn) pauseBtn.addEventListener("click", replayStop);

  document.addEventListener("keydown", (e) => {
    const overlay = document.getElementById("replay-overlay");
    if (e.key === "Escape" && overlay && overlay.classList.contains("active")) {
      closeReplayOverlay();
    }
  });
}



document.addEventListener("DOMContentLoaded", async function() {
  // === INIT-BLOCK ===
  setupDashboardPanels();
  setupPanelNavigation();
  setupLocation();
  updateSolarLunarBox();
  setupAuroraOvalSlider();
  pollAuroraOvalFrames();
  fetchKpAndHp30();
  loadSolarEvents();
  setupOverlayClassic();
  setupSolarwind();
  setupMagnetometer();
  setupMagnetometerFMI();
  setupMagnetometerFMIEvents();
  setupMagnetometerGlobal();
  setupMagnetometerGlobalEvents();
  updateAuroraForecasts();
  rebindSolarPanelEvents();
	setupAllSky();
	initReplayOverlay();
  updateCoronalHoleCard();
  updateSunspotCard();
  setTimeout(() => setupTooltips(), 250);

  // Quicklinks (HUXt / WSA-ENLIL / SDO / etc)
  document.querySelectorAll('.solar-quicklink-btn[data-quicklink]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.quicklink;
      if (!key) return;
      if (key === "huxt") {
        openHuxtLatest();
        return;
      }
      if (key === "enlil") {
        await ensureEnlilReady();
        if (window.showMultiOverlay) window.showMultiOverlay("WSA-ENLIL");
        return;
      }
      if (key === "synoptic") {
        if (await ensureImageList("Synoptic Map")) {
          if (window.openOverlayClassic) window.openOverlayClassic("Synoptic Map");
        }
        return;
      }
      if (key === "sdo193") {
        if (await ensureImageList("SDO/AIA 193")) {
          if (window.showSDOOverlayWithSlider) window.showSDOOverlayWithSlider("SDO/AIA 193");
        }
        return;
      }
      if (key === "sdo304") {
        if (await ensureImageList("SDO/AIA 304")) {
          if (window.showSDOOverlayWithSlider) window.showSDOOverlayWithSlider("SDO/AIA 304");
        }
        return;
      }
      if (key === "ccor1") {
        await ensureEnlilReady();
        if (window.showMultiOverlay) window.showMultiOverlay("CCOR1");
        return;
      }
      if (key === "lasco-c2") {
        await ensureEnlilReady();
        if (window.showMultiOverlay) window.showMultiOverlay("LASCO C2");
        return;
      }
      if (key === "lasco-c3") {
        await ensureEnlilReady();
        if (window.showMultiOverlay) window.showMultiOverlay("LASCO C3");
        return;
      }
    });
  });

  // Solar cycle charts (importeras asynkront)
  const { setupSolarCycleCharts } = await import('./solar_cycle.js');
  setupSolarCycleCharts();

  // === MOON IMAGE OVERLAY (bara om elementet finns) ===
  const img = document.getElementById('moon-icon');
  if (img) {
    img.style.cursor = "pointer";
    img.title = "Show full image";
    img.onclick = () => {
      const overlay = document.getElementById('img-overlay');
      const overlayImg = document.getElementById('img-overlay-img');
      if (!overlay || !overlayImg) return;
      overlayImg.src = img.src;
      overlayImg.alt = "NASA MOON PHASE";
      overlay.classList.add('active');
      overlayImg.style.transform = "scale(1) translate(0px,0px)";
      overlayImg.dataset.scale = "1";
      overlayImg.dataset.translateX = "0";
      overlayImg.dataset.translateY = "0";
      overlay.classList.add('no-arrows');
    };
  }

	function openMapOverlay(url) {
  const overlay = document.getElementById('map-overlay');
  const iframe = document.getElementById('map-overlay-iframe');
  if (!overlay || !iframe) return;

  iframe.src = url;
  overlay.classList.add('active');
}

function closeMapOverlay() {
  const overlay = document.getElementById('map-overlay');
  const iframe = document.getElementById('map-overlay-iframe');
  if (!overlay || !iframe) return;

  overlay.classList.remove('active');

  // Free resources + avoids stale content when reopening
  iframe.src = '';
}

// Open Ecowitt modal from AllSky header button (works in cloned dashboard too)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.allsky-weather-btn');
  if (!btn) return;

  const url = btn.dataset.iframeUrl;
  if (!url) return;

  openMapOverlay(url);
});

const mapClose = document.getElementById('map-overlay-close');
if (mapClose && !mapClose.dataset.bound) {
  mapClose.dataset.bound = "1";
  mapClose.addEventListener('click', closeMapOverlay);
}

const mapOverlay = document.getElementById('map-overlay');
if (mapOverlay && !mapOverlay.dataset.bound) {
  mapOverlay.dataset.bound = "1";

  // Click outside iframe closes (optional but nice)
  mapOverlay.addEventListener('click', (e) => {
    if (e.target === mapOverlay) closeMapOverlay();
  });

  // ESC closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mapOverlay.classList.contains('active')) {
      closeMapOverlay();
    }
  });
}

function openIframeOverlay(url) {
  const overlay = document.getElementById('map-overlay');
  const iframe = document.getElementById('map-overlay-iframe');
  if (!overlay || !iframe) return;

  iframe.src = url;
  overlay.classList.add('active');
}

function closeIframeOverlay() {
  const overlay = document.getElementById('map-overlay');
  const iframe = document.getElementById('map-overlay-iframe');
  if (!overlay || !iframe) return;

  overlay.classList.remove('active');
  iframe.src = '';
}

// Event delegation: works even if panels are cloned in desktop mode
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-iframe-url]');
  if (!btn) return;

  const url = btn.dataset.iframeUrl;
  if (!url) return;

  openIframeOverlay(url);
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'map-overlay-close') {
    closeIframeOverlay();
  }
});

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('map-overlay');
  if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
    closeIframeOverlay();
  }
});

document.querySelectorAll('.topbar-link').forEach(link => {
  link.addEventListener('click', async function (e) {
	if (this.id === 'noaa-forecast-discussion-link') return;
    e.preventDefault();
    const overlay = document.getElementById('topbar-overlay');
    const pre = document.getElementById('topbar-overlay-pre');
    if (this.dataset.images === "geospace") {
      pre.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/geospace/velocity/latest.png"  data-full="https://services.swpc.noaa.gov/images/animations/geospace/velocity/latest.png"  alt="Velocity"  style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/geospace/pressure/latest.png"  data-full="https://services.swpc.noaa.gov/images/animations/geospace/pressure/latest.png"  alt="Pressure"  style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/geospace/density/latest.png"   data-full="https://services.swpc.noaa.gov/images/animations/geospace/density/latest.png"   alt="Density"   style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/100asm_urt/latest.png"  data-full="https://services.swpc.noaa.gov/images/animations/glotec/100asm_urt/latest.png"  alt="GloTEC 100asm"  style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/100asmp_urt/latest.png" data-full="https://services.swpc.noaa.gov/images/animations/glotec/100asmp_urt/latest.png" alt="GloTEC 100asmp" style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/anomaly_urt/latest.png"  data-full="https://services.swpc.noaa.gov/images/animations/glotec/anomaly_urt/latest.png"  alt="Anomaly"  style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/anomalyp_urt/latest.png" data-full="https://services.swpc.noaa.gov/images/animations/glotec/anomalyp_urt/latest.png" alt="Anomaly+" style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/ray_urt/latest.png"     data-full="https://services.swpc.noaa.gov/images/animations/glotec/ray_urt/latest.png"     alt="Ray"     style="max-width:260px;max-height:150px;cursor:pointer;">
          <img class="geospace-thumb" src="https://services.swpc.noaa.gov/images/animations/glotec/rayp_urt/latest.png"    data-full="https://services.swpc.noaa.gov/images/animations/glotec/rayp_urt/latest.png"    alt="Ray+"    style="max-width:260px;max-height:150px;cursor:pointer;">
        </div>
      `;
      overlay.classList.add('active');
      setTimeout(() => {
        document.querySelectorAll('.geospace-thumb').forEach(img => {
          img.addEventListener('click', function (ev) {
            ev.stopPropagation();
            const overlay = document.getElementById('img-overlay');
            const overlayImg = document.getElementById('img-overlay-img');
            overlayImg.src = this.dataset.full;
            overlayImg.alt = this.alt;
            overlay.classList.add('active');
            overlay.classList.add('no-arrows');
            overlayImg.style.transform = "scale(1) translate(0px,0px)";
            overlayImg.dataset.scale = "1";
            overlayImg.dataset.translateX = "0";
            overlayImg.dataset.translateY = "0";
          });
        });
      }, 50);
      return;
    }

    const url = this.dataset.url;
    pre.textContent = 'Loading...';
    overlay.classList.add('active');
    try {
      const res = await fetch(url);
      if (res.ok) {
        pre.textContent = await res.text();
      } else {
        pre.textContent = `Could not load data (${res.status})`;
      }
    } catch (err) {
      pre.textContent = 'Failed to load content!';
    }
  });
});

const btn = document.getElementById("noaa-forecast-discussion-link");
if (btn) {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();

    // Alltid stäng och nollställ overlay
    const overlay = document.getElementById('topbar-overlay');
    const pre = document.getElementById('topbar-overlay-pre');
    pre.textContent = 'Loading...';
    overlay.classList.add('active');

    // Gårdagens datum i UTC, säkert!
    const now = new Date();
    now.setUTCDate(now.getUTCDate() - 1);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");

    // Pröva båda tider
    const times = ["1230", "0030"];
    let found = false;

    for (let time of times) {
      const url = `https://www.ngdc.noaa.gov/stp/space-weather/swpc-products/daily_reports/discussion/${yyyy}/${mm}/${yyyy}${mm}${dd}${time}forecast_discussion.txt`;
      try {
        const res = await fetch(url);
        if (res.ok) {
          pre.textContent = await res.text();
          found = true;
          break;
        }
      } catch (err) {
        // Bara fortsätt
      }
    }

    if (!found) {
      pre.textContent = 'Ingen forecast discussion hittades för gårdagens datum.';
    }
  });
}

  // === ANDRA EVENT/LISTENERS (ex overlayer, modaler) ===
  // ...lägg till här om du har fler modaler, overlays eller paneler...

  // === PERIODISKA UPPDATERINGAR ===
  setInterval(() => updateAuroraForecasts(), 300000);
  setInterval(() => setupMagnetometer(), 300000);
  setInterval(() => setupMagnetometerFMI(), 300000);
  setInterval(() => fetchKpAndHp30(), 300000);
  setInterval(() => loadSolarEvents(), 300000);
});
