// ---- app/static/js/station_freshness.js ----
// Says which stations have no data in the selected window and when they last
// reported, instead of silently leaving them out of a chart. The magnetometer
// endpoints return { data, missing: { STATION: "<last timestamp UTC>" | null } }.

const pad = n => String(n).padStart(2, '0');

function formatUtc(iso) {
  const d = new Date(`${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function showMissingStations(chartId, missing, hours) {
  const chart = document.getElementById(chartId);
  if (!chart) return;
  let note = chart.parentElement.querySelector(`.station-missing-note[data-for="${chartId}"]`);
  const entries = Object.entries(missing || {});
  if (!entries.length) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement('div');
    note.className = 'station-missing-note';
    note.dataset.for = chartId;
    chart.after(note);
  }
  note.textContent = `No data in the last ${hours} h: ` + entries
    .map(([station, last]) => (last ? `${station} (last ${formatUtc(last)})` : `${station} (no data yet)`))
    .join(', ');
}
