// app/static/js/skyfield_graph.js

import { getLocation } from './state.js';

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

// ISS-pass
export async function drawISSPass() {
  const { lat, lon } = getLocation();
  const res = await fetch(`/iss-nextpass?lat=${lat}&lon=${lon}`);
  const data = await res.json();
  if (data.error) return;

  Highcharts.chart('iss-pass-graph', {
    chart: { type: 'line', backgroundColor: '#222', height: 140 },
    title: { text: null },
    xAxis: {
      categories: data.times,
      labels: { style: { color: '#fff', fontSize: '9px' } }
    },
    yAxis: {
      min: 0,
      max: Math.ceil(Math.max(...data.altitudes) / 10) * 10,
      title: { text: 'Altitude (°)', style: { color: '#fff', fontSize: '9px' } },
      labels: { style: { color: '#fff', fontSize: '9px' } }
    },
    tooltip: { valueSuffix: '°', backgroundColor: "rgba(25,30,40,0.95)", borderColor: "#222", style: { color: "#fff", fontSize: "0.7em" } },
    series: [{ name: 'ISS', data: data.altitudes, color: '#4efaff', fontSize: '9px' }],
    credits: { enabled: false }
  });
}

// Meteorit‐radiant
export async function drawMeteorRadiant(name) {
  const { lat, lon } = getLocation();
  const res = await fetch(`/meteor-shower?name=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}`);
  const data = await res.json();

  Highcharts.chart('meteor-radiant-graph', {
    chart: { type: 'spline', backgroundColor: '#222', height: 140 },
    title: { text: null },
    xAxis: { categories: data.times, labels: { style: { color: '#fff', fontSize: '9px' } } },
    yAxis: {
      min: 0,
      max: 90,
      title: { text: 'Radiant altitude (°)', style: { color: '#fff', fontSize: '9px' } },
      labels: { style: { color: '#fff' } }
    },
    tooltip: { valueSuffix: '°' },
    series: [{ name: 'Radiant', data: data.radiant_altitudes, color: '#ffda4e', fontSize: '9px' }],
    credits: { enabled: false }
  });
}

// Djuprymdsobjekt‐höjd
export async function drawDeepSkyAltitude(name) {
  const { lat, lon } = getLocation();
  const res = await fetch(`/deepsky-altitude?name=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}`);
  const data = await res.json();

  Highcharts.chart('deepsky-alt-graph', {
    chart: { type: 'spline', backgroundColor: '#222', height: 140 },
    title: { text: null },
    xAxis: { categories: data.times, labels: { style: { color: '#fff', fontSize: '9px' } } },
    yAxis: {
      min: 0,
      max: 90,
      title: { text: 'Altitude (°)', style: { color: '#fff', fontSize: '9px' } },
      labels: { style: { color: '#fff' } }
    },
    tooltip: { valueSuffix: '°' },
    series: [{ name, data: data.altitudes, color: '#bb8cff', fontSize: '9px' }],
    credits: { enabled: false }
  });
}

function azimuthToTextEN(azi) {
  if (azi === null || azi === undefined) return '';
  azi = (azi + 360) % 360; // för säkerhets skull
  if (azi >= 337.5 || azi < 22.5) return "N";
  if (azi >= 22.5 && azi < 67.5) return "NE";
  if (azi >= 67.5 && azi < 112.5) return "E";
  if (azi >= 112.5 && azi < 157.5) return "SE";
  if (azi >= 157.5 && azi < 202.5) return "S";
  if (azi >= 202.5 && azi < 247.5) return "SW";
  if (azi >= 247.5 && azi < 292.5) return "W";
  if (azi >= 292.5 && azi < 337.5) return "NW";
  return "";
}

export async function drawAstroMasterGraph(containerId = "astro-master-graph-embed") {
  const { lat, lon, tz } = getLocation();
  const astroRes = await fetch(`/astro/skyfield-astro?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`);
  const astroInfo = await astroRes.json();

  // Hämta alla objekt i ett enda batch-anrop!
  const batchNames = [
    "ISS", "Perseids", "Geminids",
    "Jupiter", "Mars", "Venus", "Saturn",
    "M31", "M42", "M45",
    "Sirius", "Betelgeuse", "Rigel", "Aldebaran"
  ];
  const [sunMoon, batch] = await Promise.all([
    fetch(`/astro/skyfield-altitudes?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}&step_min=60`).then(r => r.json()),
    fetch(`/astro/batch?names=${batchNames.join(",")}&lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`).then(r => r.json())
  ]);

  // Plocka ut varje resultat ur batchen (default till [] om error)
  const iss = batch["ISS"] || {};
  const perseids = batch["Perseids"] || {};
  const geminids = batch["Geminids"] || {};
  const jupiter = batch["Jupiter"] || {};
  const mars = batch["Mars"] || {};
  const venus = batch["Venus"] || {};
  const saturn = batch["Saturn"] || {};
  const m31 = batch["M31"] || {};
  const m42 = batch["M42"] || {};
  const m45 = batch["M45"] || {};
  const sirius = batch["Sirius"] || {};
  const betelgeuse = batch["Betelgeuse"] || {};
  const rigel = batch["Rigel"] || {};
  const aldebaran = batch["Aldebaran"] || {};

  const times = sunMoon.times;

  // Ditt findTimeIndex och övriga funktioner här...
  function findTimeIndex(times, timeStr) {
    let idx = times.findIndex(t => t === timeStr);
    if (idx !== -1) return idx;
    idx = times.findIndex(t => t.startsWith(timeStr.slice(0,2)));
    return idx !== -1 ? idx : 0;
  }
  // Tider för plotBands/plotLines
  const sunriseIndex   = astroInfo.sunrise   && astroInfo.sunrise !== "-" ? findTimeIndex(times, astroInfo.sunrise)   : null;
  const sunsetIndex    = astroInfo.sunset    && astroInfo.sunset !== "-"  ? findTimeIndex(times, astroInfo.sunset)    : null;
  const dawnIndex      = astroInfo.astro_dawn && astroInfo.astro_dawn !== "-" ? findTimeIndex(times, astroInfo.astro_dawn) : null;
  const duskIndex      = astroInfo.astro_dusk && astroInfo.astro_dusk !== "-" ? findTimeIndex(times, astroInfo.astro_dusk) : null;
  const moonriseIndex  = astroInfo.moonrise  && astroInfo.moonrise !== "-" ? findTimeIndex(times, astroInfo.moonrise)  : null;
  const moonsetIndex   = astroInfo.moonset   && astroInfo.moonset !== "-"  ? findTimeIndex(times, astroInfo.moonset)   : null;

  function padArray(arr, len) {
    if (arr.length === len) return arr;
    if (arr.length > len) return arr.slice(0, len);
    return [...arr, ...Array(len - arr.length).fill(null)];
  }

  // --- Spara previous visibility ---
  let prevVisibility = {};
  try {
    prevVisibility = JSON.parse(localStorage.getItem("astroVisibility") || "{}");
  } catch (e) {}

  if (window.astroChart && window.astroChart.series) {
    window.astroChart.series.forEach(s => {
      prevVisibility[s.name] = s.visible;
    });
    localStorage.setItem("astroVisibility", JSON.stringify(prevVisibility));
  }

  // --- Series-definieringen är oförändrad (dina objekt här, inkl visible:false på deep sky!) ---
  const series = [
    { name: "☀️ Sun", data: sunMoon.sun_altitudes, azimuths: sunMoon.sun_azimuths, color: "rgba(255,224,102,0.92)", zIndex: 3,
      marker: { enabled: true, symbol: 'circle', radius: 5 },
      shadow: { color: "#fff6a0", width: 16, opacity: 0.22 }
    },
    { name: "🌙 Moon", data: sunMoon.moon_altitudes, azimuths: sunMoon.moon_azimuths, color: "rgba(147,165,255,0.86)", zIndex: 2,
      marker: { enabled: true, symbol: 'circle', radius: 5 },
      shadow: { color: "#93a5ff", width: 12, opacity: 0.17 }
    },
    { name: "🛰️ ISS", data: padArray(iss.altitudes ?? [], times.length), azimuths: padArray(iss.azimuths ?? [], times.length), color: "#4efaff", dashStyle: "Dot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'diamond', radius: 4 }
    },
    { name: "☄️ Perseids", data: padArray(perseids.altitudes ?? [], times.length), azimuths: padArray(perseids.azimuths ?? [], times.length), color: "#ffda4e", dashStyle: "Dash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'triangle', radius: 4 }
    },
    { name: "☄️ Geminids", data: padArray(geminids.altitudes ?? [], times.length), azimuths: padArray(geminids.azimuths ?? [], times.length), color: "#ffd700", dashStyle: "ShortDot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'triangle', radius: 4 }
    },
    { name: "♃ Jupiter", data: padArray(jupiter.altitudes ?? [], times.length), azimuths: padArray(jupiter.azimuths ?? [], times.length), color: "#fd7e14", dashStyle: "Solid", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "♂ Mars", data: padArray(mars.altitudes ?? [], times.length), azimuths: padArray(mars.azimuths ?? [], times.length), color: "#e74c3c", dashStyle: "Dash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "♀ Venus", data: padArray(venus.altitudes ?? [], times.length), azimuths: padArray(venus.azimuths ?? [], times.length), color: "#ecb8ff", dashStyle: "Dot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "♄ Saturn", data: padArray(saturn.altitudes ?? [], times.length), azimuths: padArray(saturn.azimuths ?? [], times.length), color: "#f5e8b1", dashStyle: "ShortDot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "🌌 Andromeda (M31)", data: padArray(m31.altitudes ?? [], times.length), azimuths: padArray(m31.azimuths ?? [], times.length), color: "#bb8cff", dashStyle: "ShortDash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'square', radius: 3 }
    },
    { name: "🟣 Orion Nebula (M42)", data: padArray(m42.altitudes ?? [], times.length), azimuths: padArray(m42.azimuths ?? [], times.length), color: "#ff7f50", dashStyle: "Dot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'square', radius: 3 }
    },
    { name: "✴️ Pleiades (M45)", data: padArray(m45.altitudes ?? [], times.length), azimuths: padArray(m45.azimuths ?? [], times.length), color: "#82eefd", dashStyle: "ShortDot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'square', radius: 3 }
    },
    { name: "★ Sirius", data: padArray(sirius.altitudes ?? [], times.length), azimuths: padArray(sirius.azimuths ?? [], times.length), color: "#6ddcff", dashStyle: "Dash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "★ Betelgeuse", data: padArray(betelgeuse.altitudes ?? [], times.length), azimuths: padArray(betelgeuse.azimuths ?? [], times.length), color: "#ffa07a", dashStyle: "Dot", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "★ Rigel", data: padArray(rigel.altitudes ?? [], times.length), azimuths: padArray(rigel.azimuths ?? [], times.length), color: "#6495ed", dashStyle: "ShortDash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    },
    { name: "★ Aldebaran", data: padArray(aldebaran.altitudes ?? [], times.length), azimuths: padArray(aldebaran.azimuths ?? [], times.length), color: "#ffdb58", dashStyle: "Dash", zIndex: 1, visible: false,
      marker: { enabled: true, symbol: 'circle', radius: 3 }
    }
  ];

  // plotBands och plotLines (ingen ändring på dessa)
  const plotBands = [];
  if (dawnIndex !== null && sunriseIndex !== null)
    plotBands.push({
      color: 'rgba(255,220,100,0.09)',
      from: dawnIndex, to: sunriseIndex,
      label: { text: "Twilight", style: { color: "#ffd", fontSize: "7px" } }
    });
  if (sunriseIndex !== null && sunsetIndex !== null)
    plotBands.push({
      color: 'rgba(255,255,255,0.06)',
      from: sunriseIndex, to: sunsetIndex,
      label: { text: "Day", style: { color: "#ffe066", fontSize: "7px" } }
    });
  if (sunsetIndex !== null && duskIndex !== null)
    plotBands.push({
      color: 'rgba(255,220,100,0.09)',
      from: sunsetIndex, to: duskIndex,
      label: { text: "Twilight", style: { color: "#ffd", fontSize: "7px" } }
    });
  if (duskIndex !== null && dawnIndex !== null)
    plotBands.push({
      color: 'rgba(44,100,180,0.11)',
      from: duskIndex, to: times.length-1,
      label: { text: "Night", style: { color: "#8ef", fontSize: "7px" } }
    });
  if (dawnIndex !== null && dawnIndex > 0)
    plotBands.push({
      color: 'rgba(44,100,180,0.11)',
      from: 0, to: dawnIndex,
      label: { text: "Night", style: { color: "#8ef", fontSize: "7px" } }
    });

  const plotLines = [];
  if (sunriseIndex !== null)
    plotLines.push({
      color: "#fff49b", width: 1.5, value: sunriseIndex, dashStyle: 'Dash',
      label: { text: "Sunrise", style: { color: "#ffe066", fontSize: "7px" } }
    });
  if (sunsetIndex !== null)
    plotLines.push({
      color: "#ffbb7b", width: 1.5, value: sunsetIndex, dashStyle: 'Dash',
      label: { text: "Sunset", style: { color: "#ffe066", fontSize: "7px" } }
    });
  if (moonriseIndex !== null)
    plotLines.push({
      color: "#b7c8ff", width: 1, value: moonriseIndex, dashStyle: 'Dot',
      label: { text: "Moonrise", style: { color: "#bde", fontSize: "7px" } }
    });
  if (moonsetIndex !== null)
    plotLines.push({
      color: "#bac3ff", width: 1, value: moonsetIndex, dashStyle: 'Dot',
      label: { text: "Moonset", style: { color: "#bde", fontSize: "7px" } }
    });

  // --- Skapa grafen ---
  window.astroChart = Highcharts.chart(containerId, {
    chart: {
      type: 'spline',
      backgroundColor: 'rgba(0,0,0,0)',
      height: 350,
      spacing: [2, 2, 2, 2],
	  margin: [5,5,140,40],  //margin: [top, right, bottom, left]
    },
    title: null,
    exporting: { enabled: false },
    xAxis: {
      categories: times,
      labels: { style: { color: '#ccc', fontSize: '7px' }, y: 10 },
      gridLineColor: "#333",
      gridLineWidth: 1,
      tickColor: "#333",
      plotBands: plotBands,
      plotLines: plotLines
    },
    yAxis: {
      min: -80,
      max: 80,
      title: { text: 'Altitude (°)', style: { color: '#fff', fontSize: '7px' }, x: 10 },
      labels: { style: { color: '#ccc', fontSize: '7px' }, x: -2 },
      gridLineColor: "#333",
      gridLineWidth: 1,
      plotBands: [{
        from: -80, to: 0, color: 'rgba(44,62,80,0.12)', label: { text: null }
      }],
      plotLines: [{ value: 0, color: '#aaa', width: 2, dashStyle: 'Dash', label: { text: 'Horizon', style: { color: '#fff', fontSize: '7px' }}}]
    },
    legend: {
      layout: 'horizontal',
      align: 'center',
      verticalAlign: 'bottom',
      y: 3,
      itemStyle: { color: '#fff', fontWeight: 'normal', fontSize: '7px' },
      symbolHeight: 14,
      symbolWidth: 30,
      symbolRadius: 4,
      backgroundColor: 'rgba(16,19,26,0.92)',
      borderRadius: 6,
	  itemDistance: 5,
      itemHoverStyle: { color: '#ffe066' }
    },
    tooltip: {
      shared: true,
      useHTML: true,
      backgroundColor: 'rgba(30, 33, 45, 0.95)',
      borderColor: '#ffd700',
      style: { color: '#fff', fontSize: '7px' },
      formatter: function () {
        let s = `<b>${this.x}</b><br/>`;
        this.points.forEach(pt => {
          const azArr = pt.series.userOptions.azimuths;
          const azi = azArr ? azArr[pt.point.index] : null;
          s += `<span style="color:${pt.color};font-size:13px;">●</span> <b>${pt.series.name}</b>: <b>${pt.y}&deg;</b>`;
          if (azi !== null && azi !== undefined) {
            s += `, ${azi}&deg; (${azimuthToTextEN(azi)})`;
          }
          s += "<br/>";
        });
        return s;
      }
    },
    series: series,
    credits: { enabled: false }
  });

  // --- Återställ visibility (efter grafen skapats) ---
  if (prevVisibility && window.astroChart) {
    window.astroChart.series.forEach(s => {
      if (s.name in prevVisibility && prevVisibility[s.name] !== s.visible) {
        s.setVisible(prevVisibility[s.name], false);
      }
    });
    window.astroChart.redraw();
  }

  // --- Spara varje gång legend togglas (så sparas alltid rätt state) ---
  if (window.astroChart) {
    window.astroChart.update({
      chart: {
        events: {
          redraw: function() {
            let state = {};
            this.series.forEach(s => { state[s.name] = s.visible; });
            localStorage.setItem("astroVisibility", JSON.stringify(state));
          }
        }
      }
    });
  }
}