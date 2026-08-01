// app/static/js/sunspot.js

export async function updateSunspotCard(date = null) {
  const content = document.getElementById('sunspot-content');
  const controls = document.getElementById('sunspot-controls');
  if (!content || !controls) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const selectedStr = date || todayStr;
  const disableNext = selectedStr >= todayStr ? "disabled" : "";

  // Lägg till kontroller för dagbläddring
  controls.innerHTML = `
    <div class="sunspot-controls-row">
      <button id="sunspot-prev-day" class="astro-btn"><i class="fa fa-chevron-left"></i> Previous Day</button>
      <button id="sunspot-today" class="astro-btn">Present Day</button>
      <button id="sunspot-next-day" class="astro-btn" ${disableNext}>Next Day <i class="fa fa-chevron-right"></i></button>
      <input type="date" id="sunspot-date-picker" class="sunspot-date">
    </div>
  `;

  document.getElementById('sunspot-today').onclick = () => updateSunspotCard(todayStr);

  const dp = document.getElementById('sunspot-date-picker');
  if (dp) dp.value = selectedStr;

  document.getElementById('sunspot-prev-day').onclick = () => {
    const d = new Date(dp.value);
    d.setDate(d.getDate() - 1);
    updateSunspotCard(d.toISOString().slice(0, 10));
  };
  const nextBtn = document.getElementById('sunspot-next-day');
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (selectedStr >= todayStr) return;
      const d = new Date(dp.value);
      d.setDate(d.getDate() + 1);
      updateSunspotCard(d.toISOString().slice(0, 10));
    };
  }
  if (dp) dp.onchange = () => updateSunspotCard(dp.value);

  // Hämta regioner för valt datum
  content.innerHTML = '<div style="color:#8af;">Loading…</div>';
  const url = `/api/solar/regions?date=${selectedStr}`;
  let regions = [];
  try {
    const res = await fetch(url);
    regions = await res.json();
  } catch (e) {}

// ...regionfetchen före detta block...
// ... Resten av funktionen ovanför är oförändrad ...

if (!regions.length) {
  // Om vi försöker visa dagens datum men får tomt: försök automatiskt med gårdagen
  if (selectedStr === todayStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const ystr = yesterday.toISOString().slice(0, 10);

    // Visa "Loading yesterday..." och hämta gårdagens regioner
    content.innerHTML = `<div style="color:#ccc;">No sunspot regions for today, loading yesterday's data…</div>`;
    try {
      const res = await fetch(`/api/solar/regions?date=${ystr}`);
      const yregions = await res.json();
      if (yregions.length) {
        content.innerHTML = `<div style="color:#ffe066;font-size:1em;margin-bottom:0.4em;">
          No sunspot data for today yet.<br>Showing yesterday's regions:
        </div>` + yregions.map(r => {
          const cls = r.mag_class || r.magclass || r.z || "–";
          const klassColor = getClassColor(r.mag_class || r.magclass);
          const area = r.area && r.area !== "null" ? `${r.area} MSH` : "–";
          const spots = r.number_spots && r.number_spots !== "null" ? `${r.number_spots}` : "–";
          return `
            <div class="sunspot-region-row" style="margin-bottom:0.6em;">
              <span style="font-size:1.05em;color:#adf;font-weight:bold;">${r.region_num || "–"}</span>
              <span style="margin-left:0.7em;font-size:0.98em;color:${klassColor};">${cls}</span>
              <span style="margin-left:0.6em;color:#f7d;">${spots} spots</span>
              <span style="margin-left:0.7em;color:#8ef;">${r.location || "–"}</span>
              <span style="margin-left:0.7em;color:#ffe066;">area: ${area}</span>
            </div>
          `;
        }).join("");
        return;
      }
    } catch {}
  }

  content.innerHTML = `<div style="color:#ccc;font-size:1.09em;margin:1.1em 0 0 0;">No sunspot regions for this day</div>`;
  return;
}

const magColors = {
  "A": "#8ef", "B": "#fff70c", "BG": "#ff97e1", "C": "#ff4d4d", "D": "#8eff98", "E": "#fba4e0", "F": "#eaffc7"
};
function getClassColor(mag_class) {
  if (!mag_class) return "#888";
  if (magColors[mag_class]) return magColors[mag_class];
  if (mag_class.match(/[A-Z]{1,2}/)) return "#e4f";
  return "#bfe";
}

content.innerHTML = regions.map(r => {
  const cls = r.mag_class || r.magclass || r.z || "–";
  const klassColor = getClassColor(r.mag_class || r.magclass);
  const area = r.area && r.area !== "null" ? `${r.area} MSH` : "–";
  const spots = r.number_spots && r.number_spots !== "null" ? `${r.number_spots}` : "–";
  return `
    <div class="sunspot-region-row" style="margin-bottom:0.6em;">
      <span style="font-size:1.05em;color:#adf;font-weight:bold;">${r.region_num || "–"}</span>
      <span style="margin-left:0.7em;font-size:0.98em;color:${klassColor};">${cls}</span>
      <span style="margin-left:0.6em;color:#f7d;">${spots} spots</span>
      <span style="margin-left:0.7em;color:#8ef;">${r.location || "–"}</span>
      <span style="margin-left:0.7em;color:#ffe066;">area: ${area}</span>
    </div>
  `;
}).join("");

}