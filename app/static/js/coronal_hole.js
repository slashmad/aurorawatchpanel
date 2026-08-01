// /app/static/js/coronal_hole.js

let allRotations = [];
let currentRotation = null;

// --- Carrington-konstant (ms)
const CARRINGTON_MS = 27.2753 * 24 * 60 * 60 * 1000;

// Flytta datum ± en Carrington-rotation
function shiftCarrington(currentDateStr, direction = -1) {
  const d = new Date(currentDateStr);
  return new Date(d.getTime() + direction * CARRINGTON_MS);
}

async function fetchRotations() {
  const res = await fetch('/api/coronal_hole_rotations');
  const data = await res.json();
  allRotations = data.rotations || [];
  allRotations = allRotations.map(r => Number(r)).filter(r => !isNaN(r));
}

export async function updateCoronalHoleCard(date = null, rotation = null) {
  const content = document.getElementById('coronal-hole-content');
  const controls = document.getElementById('coronal-hole-controls');
  if (!content || !controls) return;
  content.innerHTML = '<div style="color:#8af;">Loading…</div>';

  if (!allRotations.length) await fetchRotations();

  let url = '/api/coronal_holes?limit=300';
  if (rotation) url += `&carrington=${rotation}`;
  else if (date) url += `&from=${date}&to=${date}`;

  const res = await fetch(url);
  let arr = await res.json();

  // Bestäm aktuell rotation utifrån datan
  if (arr.length) currentRotation = arr[0].carrington;
  else if (rotation) currentRotation = rotation;
  else if (allRotations.length) currentRotation = allRotations[0];

  // Index för nuvarande rotation
  const rotIdx = allRotations.indexOf(currentRotation);
  const disablePrevRot = rotIdx === allRotations.length - 1;
  const disableNextRot = rotIdx === 0;

  const todayStr = new Date().toISOString().slice(0, 10);
  const selectedStr = (date || todayStr);
  const disableNextDay = selectedStr >= todayStr ? "disabled" : "";

  controls.innerHTML = `
    <div class="solar-timelapse-select-row" style="margin-bottom:0.4em;">
      <button id="ch-prev-rot" class="astro-btn" ${disablePrevRot ? "disabled" : ""}><i class="fa fa-chevron-left"></i> Previous Rotation</button>
      <button id="ch-next-rot" class="astro-btn" ${disableNextRot ? "disabled" : ""}>Next Rotation <i class="fa fa-chevron-right"></i></button>
      <input type="date" id="ch-date-picker" class="sunspot-date">
    </div>
    <div class="solar-timelapse-select-row">
      <button id="ch-prev-day" class="astro-btn"><i class="fa fa-chevron-left"></i> Previous Day</button>
      <button id="ch-today" class="astro-btn">Present Day</button>
      <button id="ch-next-day" class="astro-btn" ${disableNextDay}>Next Day <i class="fa fa-chevron-right"></i></button>
      <button id="ch-play-day" class="astro-btn" title="Play all for this day"><i class="fa fa-play"></i> Play</button>
    </div>
  `;
  document.getElementById('ch-today').onclick = () => updateCoronalHoleCard(todayStr);
  document.getElementById('ch-play-day').onclick = () => playCoronalHoleDay(arr);

  // --- Failsafe: hoppa alltid exakt Carrington-period ---
  document.getElementById('ch-prev-rot').onclick = () => {
    const prevDate = shiftCarrington(selectedStr, -1);
    updateCoronalHoleCard(prevDate.toISOString().slice(0, 10));
  };
  document.getElementById('ch-next-rot').onclick = () => {
    const nextDate = shiftCarrington(selectedStr, 1);
    updateCoronalHoleCard(nextDate.toISOString().slice(0, 10));
  };

  // Event handlers för dag/datum
  const dp = document.getElementById('ch-date-picker');
  if (dp) dp.value = selectedStr;
  document.getElementById('ch-prev-day').onclick = () => {
    const d = new Date(dp.value);
    d.setDate(d.getDate() - 1);
    updateCoronalHoleCard(d.toISOString().slice(0, 10));
  };
  const nextBtn = document.getElementById('ch-next-day');
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (selectedStr >= todayStr) return;
      const d = new Date(dp.value);
      d.setDate(d.getDate() + 1);
      updateCoronalHoleCard(d.toISOString().slice(0, 10));
    };
  }
  if (dp) dp.onchange = () => updateCoronalHoleCard(dp.value);

  // --- Bild eller "Quiet period" ---
  if (!arr.length) {
    content.innerHTML = `<div style="color:#ccc;font-size:1.09em;margin:1.1em 0 0 0;">Quiet Period<br><span style="font-size:0.89em;color:#99f;">No coronal hole detected</span></div>`;
    return;
  }

  // Failsafe: hitta närmaste bild till valt datum (om ingen exakt match)
  arr.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let idx = arr.findIndex(img => img.timestamp && img.timestamp.slice(0, 10) === selectedStr);
  if (idx === -1) {
    const target = new Date(selectedStr);
    let minDiff = Infinity;
    let minIdx = -1;
    for (let i = 0; i < arr.length; i++) {
      const diff = Math.abs(new Date(arr[i].timestamp) - target);
      if (diff < minDiff) {
        minDiff = diff;
        minIdx = i;
      }
    }
    if (minDiff > 2 * 24 * 60 * 60 * 1000) { // >2 dagar bort
      content.innerHTML = `<div style="color:#ccc;margin:1.1em 0 0 0;">No image available for this Carrington rotation.<br><span style="font-size:0.89em;color:#99f;">(No data within ±2 days)</span></div>`;
      return;
    }
    idx = minIdx;
  }

  const current = arr[idx];
  let fname = (current.processed_filename || current.filename) || "";
  const imgUrl = `/data/images/coronal-holes/${fname}`;
  content.innerHTML = `
    <div id="ch-img-box">
      <img id="ch-img" src="${imgUrl}" alt="Coronal Hole" style="max-width:94%;margin:0.6em 0 0 0;border-radius:0.3em;">
      <div id="ch-img-info" style="font-size:0.92em;margin-top:0.6em;color:#d4eeff;">${(current.timestamp || '').replace('T',' ').slice(0,16)}</div>
      <div id="ch-img-area" style="font-size:0.85em;color:#88e0d0;">Area: ${(current.area_fraction*100).toFixed(1)}% • Carrington: ${current.carrington || '-'}</div>
    </div>
  `;
}

// --- Play-funktionen oförändrad ---
let chPlayInterval = null;

function playCoronalHoleDay(images) {
  if (!images || !images.length) return;

  // Plocka ut YYYYMMDD från nuvarande selected datum
  const content = document.getElementById('coronal-hole-content');
  const dateInput = document.getElementById('ch-date-picker');
  let selectedDate = null;
  if (dateInput && dateInput.value) {
    selectedDate = dateInput.value.replace(/-/g, "");
  } else if (images[0].timestamp) {
    selectedDate = images[0].timestamp.slice(0,10).replace(/-/g,"");
  }

  // Filtrera ut endast bilder som matchar den aktuella dagen via filnamnet
  let dayImages = images.filter(img =>
    (img.processed_filename || img.filename || "").includes(selectedDate)
  );

  // Sortera på filnamn (alfabetiskt ger kronologisk ordning)
  dayImages.sort((a, b) =>
    ((a.processed_filename || a.filename) || "").localeCompare((b.processed_filename || b.filename) || "")
  );

  if (!dayImages.length) return;

  let idx = 0;
  if (chPlayInterval) clearInterval(chPlayInterval);

  function showImage(i) {
    const img = dayImages[i];
    if (!img) return;
    let fname = (img.processed_filename || img.filename) || "";
    const imgUrl = `/data/images/coronal-holes/${fname}`;
    const imgElem = document.getElementById('ch-img');
    const infoElem = document.getElementById('ch-img-info');
    const areaElem = document.getElementById('ch-img-area');
    if (imgElem) imgElem.src = imgUrl;
    if (infoElem) infoElem.textContent = (img.timestamp || '').replace('T',' ').slice(0,16);
    if (areaElem) areaElem.textContent = `Area: ${(img.area_fraction*100).toFixed(1)}% • Carrington: ${img.carrington || '-'}`;
  }

  showImage(idx);
  chPlayInterval = setInterval(() => {
    idx++;
    if (idx >= dayImages.length) {
      clearInterval(chPlayInterval);
      chPlayInterval = null;
      return;
    }
    showImage(idx);
  }, 30); // eller annan intervall
}
