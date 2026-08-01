import { getLocation } from './state.js';

// ---- OBJECT DEFINITIONS ----
const OBJECTS = [
  { id: "sun",     name: "Sun",     icon: "☀️",  color: "#ffd85b",  arcOpacity: 0.5 },
  { id: "moon",    name: "Moon",    icon: "🌙",  color: "#82b6ff",  arcOpacity: 0.5 },
  { id: "mercury", name: "Mercury", icon: "☿️",  color: "#d7a5ff",  arcOpacity: 0.5 },
  { id: "venus",   name: "Venus",   icon: "♀️",  color: "#ffc1de",  arcOpacity: 0.5 },
  { id: "mars",    name: "Mars",    icon: "♂️",  color: "#ff8888",  arcOpacity: 0.5 },
  { id: "jupiter", name: "Jupiter", icon: "♃",   color: "#ffd88f",  arcOpacity: 0.5 },
  { id: "saturn",  name: "Saturn",  icon: "♄",   color: "#ffffc0",  arcOpacity: 0.5 },
  { id: "uranus",  name: "Uranus",  icon: "♅",   color: "#a0e9ff",  arcOpacity: 0.5 },
  { id: "neptune", name: "Neptune", icon: "♆",   color: "#67e0fa",  arcOpacity: 0.5 },
  { id: "iss",     name: "ISS",     icon: "🛰️",  color: "#dadada",  arcOpacity: 0.5 },
  { id: "perseids", name: "Perseids", icon: "☄️", color: "#ffd700", arcOpacity: 0.5 },
  { id: "geminids", name: "Geminids", icon: "☄️", color: "#7de0ff", arcOpacity: 0.5 }
];

// ---- Helper: plocka rätt objekt-data från batch
function getObjData(obj, batch) {
  // batch["Venus"] eller batch["Moon"]
  const d = batch?.[obj.name] || {};
  return {
    rise:   d.rise   ?? "-",
    riseAz: d.riseAz ?? "-",
    set:    d.set    ?? "-",
    setAz:  d.setAz  ?? "-",
    max:    d.max    ?? "-",
    maxAz:  d.maxAz  ?? "-",
    maxAlt: d.maxAlt ?? "-",
    nowAz:  d.nowAz  ?? "-",
    nowAlt: d.nowAlt ?? "-"
  };
}

// ---- MAP AND DRAW HELPERS ----
const CIRCLE_RADIUS_M = 7000;      // Horizon circle (meters)
const CIRCLE_RADIUS_PX = 170;      // Overlay circle pixel radius (on 440px box)

function destinationPoint(lat, lon, azimuth, distance) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const brng = azimuth * rad;
  const lat1 = lat * rad, lon1 = lon * rad;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(distance/R) +
    Math.cos(lat1)*Math.sin(distance/R)*Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(distance/R)*Math.cos(lat1),
                                 Math.cos(distance/R)-Math.sin(lat1)*Math.sin(lat2));
  return [lat2/rad, lon2/rad];
}

// Generate points for an arc on the circle between two azimuths
function arcPoints(lat, lon, az1, az2, radius, step=2) {
  let points = [];
  let delta = ((az2 - az1 + 360) % 360);
  // INTE: if (delta > 180) delta -= 360;
  let steps = Math.max(1, Math.round(delta/step));
  for (let i=0; i<=steps; i++) {
    let az = (az1 + i*(delta/steps)) % 360;
    points.push(destinationPoint(lat, lon, az, radius));
  }
  return points;
}

function renderOverlayPanel(container, selected, onChange) {
  container.innerHTML = '';
  OBJECTS.forEach(obj => {
    const label = document.createElement('label');
    label.className = 'az-ctrl-label';
    label.innerHTML = `
      <input type="checkbox" data-obj="${obj.id}" ${selected[obj.id] ? "checked" : ""}>
      <span class="az-ctrl-icon">${obj.icon}</span>
      <span class="az-ctrl-name">${obj.name}</span>
      <span class="az-ctrl-dot" style="background:${obj.color};"></span>
    `;
    label.querySelector("input").onchange = e => {
      onChange(obj.id, e.target.checked);
    };
    container.appendChild(label);
  });
}

function renderTimesOverlay(container, batch, selected) {
  let html = '';
  OBJECTS.forEach(obj => {
    if (!selected[obj.id]) return;
    const d = getObjData(obj, batch);

    // Kolla om objektet INTE är synligt
	const isMeteorShower = obj.icon === "☄️";
	// För meteorregn: synlig om det finns en bana och maxAlt > 0
	const notVisible = !isMeteorShower
	  ? ((d.rise === "-" || d.rise === undefined) &&
		 (d.set === "-" || d.set === undefined) &&
		 (d.maxAlt === "-" || d.maxAlt === undefined || Number(d.maxAlt) <= 0))
	  : (d.maxAlt === "-" || d.maxAlt === undefined || Number(d.maxAlt) <= 0);

    if (notVisible) {
      html += `
        <span style="color:${obj.color};white-space:nowrap; margin-right:14px; font-size:0.75em;">
          ${obj.icon} <b>${obj.name}:</b> <span style="font-style:italic;opacity:.8;">Not visible today</span>
        </span>
      `;
    } else {
      html += `
        <span style="color:${obj.color};white-space:nowrap; margin-right:14px; font-size:0.75em;">
          ${obj.icon} <b>${obj.name}:</b>
          Rise <b>${d.rise || "-"}</b> (${d.riseAz !== "-" ? Math.round(d.riseAz) : "–"}°)
          | Max <b>${d.max || "-"}</b> (${d.maxAz !== "-" ? Math.round(d.maxAz) : "–"}°, ${d.maxAlt !== undefined ? d.maxAlt+"°" : ""})
          | Set <b>${d.set || "-"}</b> (${d.setAz !== "-" ? Math.round(d.setAz) : "–"}°)
        </span>
      `;
    }
  });
  container.innerHTML = html;
}

export async function drawAzimuthMap(containerId = "astro-azimuth-embed") {
  const { lat, lon } = getLocation();

  // Panel och overlay
  const container = document.getElementById(containerId);
  if (!container) return;

  // Remove previous map/canvas
  if (window.astroAzimuthMap) {
    window.astroAzimuthMap.remove();
    window.astroAzimuthMap = null;
  }
  const oldDiv = document.getElementById('astro-azimuth-map');
  if (oldDiv) oldDiv.remove();

  // Add new div
  const newDiv = document.createElement('div');
  newDiv.id = 'astro-azimuth-map';
  newDiv.style.height = '400px';
  newDiv.style.position = 'relative';
  newDiv.style.borderRadius = '6px';
  newDiv.style.overflow = 'hidden';
  container.insertBefore(newDiv, container.querySelector('.astro-azimuth-times'));

  // Overlay-canvas
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.id = 'astro-azimuth-overlay';
  overlayCanvas.style.position = 'absolute';
  overlayCanvas.style.left = '0';
  overlayCanvas.style.top = '0';
  overlayCanvas.style.width = '100%';
  overlayCanvas.style.height = '100%';
  overlayCanvas.style.pointerEvents = 'none';
  overlayCanvas.style.zIndex = '1000';
  newDiv.appendChild(overlayCanvas);

  // Leaflet map
  let map = L.map('astro-azimuth-map', {
    center: [lat, lon],
    zoom: 10,
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
    minZoom: 3,
    attribution: '&copy; OpenStreetMap, &copy; CARTO'
  }).addTo(map);
  window.astroAzimuthMap = map;

  const controls = document.querySelector('.astro-azimuth-controls');
  const times = document.querySelector('.astro-azimuth-times');

  let selected = JSON.parse(localStorage.getItem('astroAzimuthObjs') || '{}');
  if (!selected || typeof selected !== "object") selected = {};
  OBJECTS.forEach(o => { if (selected[o.id] === undefined) selected[o.id] = (o.id === "sun" || o.id === "moon"); });

  // Legend
  let legend = newDiv.querySelector('.astro-azimuth-legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.className = 'astro-azimuth-legend';
    legend.style.display = 'flex';
    legend.style.gap = '18px';
    legend.style.alignItems = 'center';
    legend.style.justifyContent = 'center';
    legend.style.marginTop = '6px';
    legend.style.zIndex = '1100';
    newDiv.appendChild(legend);
  }

  // ----- HÄMTA ALLT FRÅN BATCH API -----
  const tz = localStorage.getItem('tz') || "Europe/Stockholm";
  const names = OBJECTS.map(o => o.name).join(",");
  const res = await fetch(`/astro/azimuth-batch?names=${encodeURIComponent(names)}&lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`);
  const batch = await res.json();

  legend.innerHTML = '';
  Object.keys(selected)
    .filter(id => selected[id])
    .sort((a, b) => {
      if (a === "moon") return -1;
      if (b === "moon") return 1;
      if (a === "sun") return -1;
      if (b === "sun") return 1;
      return a.localeCompare(b);
    })
    .forEach(id => {
      const obj = OBJECTS.find(o => o.id === id);
      if (!obj) return;
      // Liten färgcirkel + namn
      const d = document.createElement('span');
      d.style.display = 'inline-flex';
      d.style.alignItems = 'center';
      d.style.gap = '4px';
      d.innerHTML = `
        <span style="display:inline-block;width:18px;height:18px;border-radius:50%;background:${obj.color};border:1.5px solid #222;box-shadow:0 1px 3px #0002;margin-right:4px;"></span>
        <span style="color:${obj.color};font-weight:bold;">${obj.icon} ${obj.name}</span>
      `;
      legend.appendChild(d);
    });

  // Rita overlay på canvas
  function resizeAndDrawOverlay() {
    overlayCanvas.width = newDiv.offsetWidth;
    overlayCanvas.height = newDiv.offsetHeight;
    drawPixelAzimuthOverlay(overlayCanvas, selected, batch);
  }
  resizeAndDrawOverlay();
  window.addEventListener('resize', resizeAndDrawOverlay);
  map.on('resize', resizeAndDrawOverlay);

  // Overlay-panel UI
  renderOverlayPanel(controls, selected, (objId, show) => {
    selected[objId] = show;
    localStorage.setItem('astroAzimuthObjs', JSON.stringify(selected));
    drawAzimuthMap(); // Redraw
  });

  renderTimesOverlay(times, batch, selected);
}

function drawPixelAzimuthOverlay(canvas, selected, batch) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const borderBottomMargin = 22;
  const compassTextMargin = 34;
  const objOrder = Object.keys(selected)
    .filter(id => selected[id])
    .sort((a, b) => {
      if (a === "moon") return -1;
      if (b === "moon") return 1;
      if (a === "sun") return -1;
      if (b === "sun") return 1;
      return a.localeCompare(b);
    });
  const maxRings = objOrder.length;
  const maxRadius = Math.max(40, Math.min(canvas.width, canvas.height) / 2 - compassTextMargin - borderBottomMargin);
  let ringGap = 18;
  let baseRadius = maxRadius - ringGap * (maxRings - 1);
  let ARC_OFFSET_STEP = ringGap;
  if (baseRadius < 20) {
    ARC_OFFSET_STEP = (maxRadius - 20) / Math.max(maxRings - 1, 1);
    baseRadius = 20;
  }
  const cx = canvas.width / 2, cy = canvas.height / 2;

  objOrder.forEach((objId, i) => {
    const obj = OBJECTS.find(o => o.id === objId);
    const d = getObjData(obj, batch);   // <-- NYCKELRAD
    if ([d.riseAz, d.setAz].some(x => x === "-" || typeof x !== "number" || isNaN(x))) return;
    if (d.riseAz === d.setAz) return;
    // Beräkna medurs vinkelintervall
    let startAz = d.riseAz, endAz = d.setAz;
    let delta = ((endAz - startAz + 360) % 360);
    if (delta === 0) return;
    const r = baseRadius + i*ARC_OFFSET_STEP;

    // Rita bågen
    let start = ((startAz - 90) * Math.PI/180);
    let end = ((startAz + delta - 90) * Math.PI/180);
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end, false);
    ctx.strokeStyle = obj.color;
    ctx.globalAlpha = obj.arcOpacity;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Kompassriktningar (N/E/S/W) på overlayn
    const compassLabels = ["N", "E", "S", "W"];
    ctx.save();
	ctx.font = "bold 16px sans-serif";
	ctx.fillStyle = "#e6edf3";
	ctx.strokeStyle = "rgba(0,0,0,0.45)";
	ctx.lineWidth = 2;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
    const rText = maxRadius - 5;

    compassLabels.forEach((label, i) => {
      const angle = ((i * 90 - 90) * Math.PI/180);
	  ctx.strokeText(label, cx + rText * Math.cos(angle), cy + rText * Math.sin(angle));
	  ctx.fillText(label,   cx + rText * Math.cos(angle), cy + rText * Math.sin(angle));
      ctx.fillText(label, cx + rText * Math.cos(angle), cy + rText * Math.sin(angle));
    });
    ctx.restore();

    // Markör: Rise
    ctx.beginPath();
    ctx.arc(cx + r*Math.cos(start), cy + r*Math.sin(start), 7, 0, 2*Math.PI);
    ctx.fillStyle = obj.color;
    ctx.fill();
    // Markör: Set
    ctx.beginPath();
    ctx.arc(cx + r*Math.cos(end), cy + r*Math.sin(end), 7, 0, 2*Math.PI);
    ctx.fillStyle = obj.color;
    ctx.fill();

    // Markör: Max
    if (typeof d.maxAz === "number" && !isNaN(d.maxAz)) {
      let maxAng = ((d.maxAz - 90) * Math.PI/180);
      ctx.beginPath();
      ctx.arc(cx + r*Math.cos(maxAng), cy + r*Math.sin(maxAng), 8, 0, 2*Math.PI);
      ctx.fillStyle = "#111";
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      ctx.arc(cx + r*Math.cos(maxAng), cy + r*Math.sin(maxAng), 4, 0, 2*Math.PI);
      ctx.fillStyle = obj.color;
      ctx.fill();
    }

    // Markör: Now
    if (typeof d.nowAz === "number" && typeof d.nowAlt === "number" && d.nowAlt > 0) {
      let nowAng = ((d.nowAz - 90) * Math.PI/180);
      ctx.beginPath();
      ctx.arc(cx + r*Math.cos(nowAng), cy + r*Math.sin(nowAng), 10, 0, 2*Math.PI);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = obj.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  });

  // Yttersta cirkeln (valfritt – som referens)
  ctx.beginPath();
  ctx.arc(cx, cy, baseRadius + (objOrder.length-1)*ARC_OFFSET_STEP, 0, 2*Math.PI);
  ctx.strokeStyle = "#aaa";
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1.0;
}
