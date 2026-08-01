// static/js/solar_events.js

import { getLocation } from './state.js';
import { showInPlaceTime } from './weather.js';

// Konvertera peak flux-värde till läsbart format
function formatPeakFlux(value) {
  if (!value) return "-";
  const num = Number(value);
  if (isNaN(num)) return value;
  if (num >= 1E-3) return num.toFixed(3) + " mW/m²";
  if (num >= 1E-6) return (num * 1E6).toFixed(2) + " μW/m²";
  if (num >= 1E-9) return (num * 1E9).toFixed(2) + " nW/m²";
  return num.toExponential(2) + " W/m²";
}

// Observatory lookup för visningsnamn (utökad)
const observatoryMap = {
  G18: "GOES-18", G19: "GOES-19", G17: "GOES-17", G16: "GOES-16", G15: "GOES-15", G14: "GOES-14", G13: "GOES-13", G12: "GOES-12", G11: "GOES-11", G10: "GOES-10",
  LEA: "Learmonth", SVI: "San Vito", PAL: "Palehua", HOL: "Holloman", SAG: "Sagamore Hill", CUL: "Culgoora", COM: "Combined", RAM: "Ramey", // etc
  // Addera fler efter behov
};

// Fyll på i denna map när du vill utöka stödet med fler beskrivningar/symboler!
const EVENT_TYPE_MAP = {
  FLA: { name: "Optical Flare (FLA)", desc: "Solar flare in H-alpha (optical).", icon: "🌟" },
  XRA: { name: "X-ray Flare (XRA)", desc: "X-ray flare by GOES.", icon: "⚡" },
  XFL: { name: "SXI X-ray Flare (XFL)", desc: "Flare by GOES SXI Imager.", icon: "☀️" },
  CME: { name: "Coronal Mass Ejection (CME)", desc: "Coronal Mass Ejection.", icon: "☄️" },
  DSF: { name: "Filament Disappearance (DSF)", desc: "Filament disappearance.", icon: "🧵" },
  EPL: { name: "Eruptive Prominence Limb (EPL)", desc: "Prominence eruption on solar limb.", icon: "💥" },
  RBR: { name: "Fixed-frequency Radio Burst (RBR)", desc: "Fixed frequency radio burst.", icon: "📻" },
  RSP: { name: "Sweep-frequency Radio Burst (RSP)", desc: "Sweep frequency radio burst.", icon: "📡" },
  RNS: { name: "Radio Noise Storm (RNS)", desc: "Noise storm radio emission.", icon: "🎧" },
  SPY: { name: "Spray (SPY)", desc: "Spray or proton event.", icon: "🚀" },
  BSL: { name: "Bright Surge on Limb (BSL)", desc: "Bright surge on limb.", icon: "🔥" },
  PCA: { name: "Polar Cap Absorption (PCA)", desc: "Polar cap absorption event.", icon: "🧊" },
  GLE: { name: "Ground-level Event (GLE)", desc: "Ground-level cosmic ray event.", icon: "🌎" },
  FOR: { name: "Forbush Decrease (FOR)", desc: "Forbush decrease.", icon: "📉" },
  LPS: { name: "Loop Prominence System (LPS)", desc: "Loop prominence system.", icon: "🔁" },
  FIL: { name: "Filament (FIL)", desc: "Solar filament.", icon: "🧶" },
  // Okända/nya typer kan alltid adderas med "?":
  UNKNOWN: { name: "Unknown Event", desc: "Unknown or uncategorized solar event.", icon: "❓" }
};

// Event-typer som ska exkluderas från visning (lägg till fler vid behov)
const EXCLUDED_EVENT_TYPES = new Set(["RBR", "RSP", "RNS"]);
const LOOKBACK_DAYS = 7;


// Sammanslår FLA+XRA (optisk+X-ray flare), filtrerar övrigt
function matchEvents(events) {
  const merged = [];
  const used = new Set();

  // Pass 1: Sammanslå FLA + XRA (optisk + X-ray) om region, tid och plats stämmer
  for (let i = 0; i < events.length; i++) {
    if (used.has(i)) continue;
    const ev = events[i];
    if (ev.event_type !== "FLA") continue;

    const j = events.findIndex((xra, idx) =>
      idx !== i && !used.has(idx) &&
      xra.event_type === "XRA" &&
      xra.region && ev.region &&
      xra.region === ev.region &&
      Math.abs(new Date(xra.begin_time) - new Date(ev.begin_time)) < 8 * 60 * 1000
    );
    if (j > -1) {
      const xra = events[j];
      used.add(i); used.add(j);
      merged.push({
        _sortIndex: i,
        _event: {
          type: "Solar Flare",
          time: ev.begin_time,
          region: ev.region,
          location: ev.location || xra.location,
          class_xray: xra.class || xra.particulars1 || "",
          class_optical: ev.class || ev.particulars1 || "",
          obs_xray: xra.observatory,
          obs_optical: ev.observatory,
          peak_flux: xra.peak_flux || ev.peak_flux,
          begin_time: ev.begin_time,
          peak_time: xra.peak_time || ev.peak_time,
          end_time: xra.end_time || ev.end_time,
        }
      });
    } else {
      // Om FLA inte kunde slås ihop: släpp inte igenom
      used.add(i);
    }
  }

  // Pass 2: Lägg till kvarvarande events (inkl. ensamma XRA)
  for (let i = 0; i < events.length; i++) {
    if (used.has(i)) continue;
    merged.push({
      _sortIndex: i,
      _event: events[i]
    });
    used.add(i);
  }

  return merged
    .sort((a, b) => a._sortIndex - b._sortIndex)
    .map(item => item._event);
}

// Hjälpfunktion: Generera detaljerad rad av event-objekt
function getEventDetails(ev) {
  let details = [];
  if (ev.region) details.push(`Region ${ev.region}`);
  if (ev.location) details.push(ev.location);
  if (ev.frequency) details.push(`Frequency: ${ev.frequency}`);
  if (ev.class || ev.particulars1) details.push(`Class: ${ev.class || ev.particulars1}`);
  if (ev.peak_flux) details.push(`Peak: ${formatPeakFlux(ev.peak_flux)}`);
  if (ev.quality) details.push(`Quality: ${ev.quality}`);
  if (ev.obsid) details.push(`ObsID: ${ev.obsid}`);
  if (ev.status_code) details.push(`Status: ${ev.status_code}`);
  if (ev.comments) details.push(ev.comments);
  return details.join(", ");
}

// Laddar och renderar solhändelser från API
export async function loadSolarEvents(limit = 500) {
  const afterDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const afterStr = afterDate.toISOString().slice(0, 19).replace("T", " ");
  const res = await fetch(`/api/solar/events?limit=${limit}&after=${encodeURIComponent(afterStr)}`);
  let data = [];
  try { data = await res.json(); } catch (e) {}
  const el = document.getElementById('solar-events-list');
  if (!el) return;
  if (!data.length) {
    el.innerHTML = `<div style='color:#fff7;'>No solar events found in the last ${LOOKBACK_DAYS} days.</div>`;
    return;
  }

  // Filtrera på events med tillräcklig info
  data = data.filter(ev => (ev.event_type && (ev.begin_time || ev.peak_time || ev.end_time)));
  // Exkludera valda event-typer (t.ex. RBR/RSP)
  data = data.filter(ev => !EXCLUDED_EVENT_TYPES.has(String(ev.event_type || "").toUpperCase()));
  // Hämta tidszon från state
  const { tz } = getLocation();

  let mergedData = matchEvents(data);

  el.innerHTML = mergedData.map(ev => {
    // Special: Flare-sammanslagning
    if (ev.type === "Solar Flare") {
      let obs = [];
      if (ev.obs_xray) obs.push(observatoryMap[ev.obs_xray] || ev.obs_xray);
      if (ev.obs_optical && ev.obs_optical !== ev.obs_xray) obs.push(observatoryMap[ev.obs_optical] || ev.obs_optical);
      let flareClass = ev.class_xray || ev.class_optical || "";
      let klassText = flareClass ? ` – <span class="solarev-class">${flareClass}</span>` : "";
      let details = [];
      if (ev.region) details.push("Region " + ev.region);
      if (ev.location) details.push(ev.location);
      if (ev.peak_flux) details.push("Peak: " + formatPeakFlux(ev.peak_flux));
      if (obs.length) details.push("Obs: " + obs.join(" & "));
      let times = [];
      if (ev.begin_time) times.push("Begin: " + showInPlaceTime(ev.begin_time, tz, true));
      if (ev.peak_time)  times.push("Peak: " + showInPlaceTime(ev.peak_time, tz, true));
      if (ev.end_time)   times.push("End: "  + showInPlaceTime(ev.end_time, tz, true));
      return `
        <div class="solarwind-badge solarev-type-flare">
          <b>🌟 Solar Flare${klassText}</b>
          <div class="badge-desc">
            ${details.join(", ")}
            ${times.length ? "<br><span style='color:#aaf;font-size:0.98em;'>" + times.join(", ") + "</span>" : ""}
          </div>
        </div>
      `;
    }

    // Alla andra events (CME, DSF, EPL, RSP, RBR, etc)
    let type = ev.event_type || ev.type || "";
    let typeObj = EVENT_TYPE_MAP[type] || EVENT_TYPE_MAP.UNKNOWN;
    let klass = ev.class || ev.particulars1 || "";
    let obs = ev.observatory ? (observatoryMap[ev.observatory] || ev.observatory) : "";
    let times = [];
    if (ev.begin_time) times.push("Begin: " + showInPlaceTime(ev.begin_time, tz, true));
    if (ev.peak_time)  times.push("Peak: " + showInPlaceTime(ev.peak_time, tz, true));
    if (ev.end_time)   times.push("End: "  + showInPlaceTime(ev.end_time, tz, true));
    let details = getEventDetails(ev);
    let titleTxt = `${typeObj.icon || ""} ${typeObj.name}${klass ? ` – <span class="solarev-class">${klass}</span>` : ""}`;
    return `
      <div class="solarwind-badge solarev-type-${type.toLowerCase()}">
        <b>${titleTxt}</b>
        <div class="badge-desc">${typeObj.desc}${details ? " – " + details : ""}</div>
        ${times.length ? `<div class="badge-time">${times.join(", ")}</div>` : ""}
        ${obs ? `<div class="badge-obs">Obs: ${obs}</div>` : ""}
      </div>
    `;
  }).join("");
}
