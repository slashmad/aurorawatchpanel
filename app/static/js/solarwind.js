// app/static/js/solarwind.js
import { settleAll } from './section_errors.js';

import { getLocation } from './state.js';

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

const swParams = [
  { key: 'speed',   label: 'Speed',     unit: 'km/s',  color: '#fff262' },
  { key: 'density', label: 'Density',   unit: 'p/cm³', color: '#b6ff5a' },
  { key: 'bt',      label: 'Bt',        unit: 'nT',    color: '#b6ff5a' },
  { key: 'bz',      label: 'Bz',        unit: 'nT',    color: '#ff5252' },
  { key: 'by',      label: 'By',        unit: 'nT',    color: '#90caf9' }
];

const swCharts = {};
let solarwindRefreshTimer = null;
const boundSolarwindControls = new WeakSet();
const solarwindRefreshCallbacks = new Map(
  swParams.map(({ key, unit }) => [key, () => fetchAndRenderSW(key, unit)])
);

// SPEED
function getSpeedColors(value) {
  if (value > 1000) return {
    gradient: ['rgba(255,0,0,0.45)',    'rgba(232,118,0,0.8)'],
    border:   'rgba(200,0,0,1.0)'
  };
  if (value > 900) return {
    gradient: ['rgba(255,64,0,0.45)',   'rgba(232,197,0,0.8)'],
    border:   'rgba(200,0,0,1.0)'
  };
  if (value > 800) return {
    gradient: ['rgba(255,115,0,0.45)',   'rgba(255,200,0,0.8)'],
    border:   'rgba(200,0,0,1.0)'
  };
  if (value > 700) return {
    gradient: ['rgba(255,145,0,0.45)',   'rgba(215,206,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 600) return {
    gradient: ['rgba(255,187,0,0.45)',   'rgba(191,217,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 500) return {
    gradient: ['rgba(255,213,0,0.45)',   'rgba(121,219,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 400) return {
    gradient: ['rgba(121,291,0,0.45)',   'rgba(161,254,0,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
  if (value > 350) return {
    gradient: ['rgba(163,227,0,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
  return {
    gradient: ['rgba(70,255,70,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
}

// DENSITY
function getDensityColors(value) {
  if (value > 50) return {
    gradient: ['rgba(255,70,70,0.45)',    'rgba(232,118,0,0.8)'],
    border:   'rgba(255,0,0,1.0)'
  };
  if (value > 40) return {
    gradient: ['rgba(255,70,70,0.45)',   'rgba(255,200,0,0.8)'],
    border:   'rgba(255,0,0,1.0)'
  };
  if (value > 30) return {
    gradient: ['rgba(255,200,0,0.45)',   'rgba(220,200,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 20) return {
    gradient: ['rgba(220,200,0,0.45)',   'rgba(219,183,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 10) return {
    gradient: ['rgba(219,183,0,0.45)',   'rgba(121,219,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 5) return {
    gradient: ['rgba(163,227,0,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
  return {
    gradient: ['rgba(70,255,70,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
}

// BT
function getBtColors(value) {
  if (value > 25) return {
    gradient: ['rgba(255,70,70,0.45)',    'rgba(232,100,0,0.8)'],
    border:   'rgba(255,0,0,1.0)'
  };
  if (value > 20) return {
    gradient: ['rgba(232,100,0,0.45)',   'rgba(232,200,0,0.8)'],
    border:   'rgba(255,0,0,1.0)'
  };
  if (value > 15) return {
    gradient: ['rgba(232,200,0,0.45)',   'rgba(220,200,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 10) return {
    gradient: ['rgba(220,200,0,0.45)',   'rgba(121,219,0,0.8)'],
    border:   'rgba(255,213,0,1.0)'
  };
  if (value > 5) return {
    gradient: ['rgba(163,227,0,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
  return {
    gradient: ['rgba(70,255,70,0.45)',   'rgba(70,255,70,0.8)'],
    border:   'rgba(0,200,0,1.0)'
  };
}

function getEarthLine(timeMs) {
  return [{
    color: '#7a7a7a',
    width: 1.5,
    value: timeMs,
    zIndex: 10,
    label: {
      text: 'Earth',
      rotation: 90,
      align: 'left',
      verticalAlign: 'top',
      x: 5, y: 0,
      style: { color: '#7a7a7a', fontSize: '8px' }
    }
  }];
}

let globalMinTime = null;
let globalMaxTime = null;

const swlDescriptions = {
  speed: (value) => {
    if (value < 400) return { desc: "Normal solar wind speed.", level: "< 400: Normal speed" };
    if (value < 500) return { desc: "Elevated solar wind speed.", level: "400–500: Elevated speed" };
    if (value < 700) return { desc: "Moderately high solar wind speed.", level: "500–700: Moderately high speed" };
    if (value < 900) return { desc: "High solar wind speed.", level: "700–900: High speed" };
    return { desc: "Very high solar wind speed.", level: "> 900: Very high speed" };
  },
  density: (value) => {
    if (value < 10) return { desc: "Low solar wind density.", level: "< 10: Low density" };
    if (value < 20) return { desc: "Moderate solar wind density.", level: "10–20: Moderate density" };
    if (value < 40) return { desc: "High solar wind density.", level: "20–40: High density" };
    if (value < 60) return { desc: "Very high solar wind density.", level: "40–60: Very high density" };
    return { desc: "Extremely high solar wind density.", level: "> 60: Extremely high density" };
  },
  bt: (value) => {
    if (value < 10) return { desc: "Weak interplanetary magnetic field.", level: "< 10: Weak IMF" };
    if (value < 20) return { desc: "Moderately strong interplanetary magnetic field.", level: "10–20: Moderately strong IMF" };
    if (value < 30) return { desc: "Strong interplanetary magnetic field.", level: "20–30: Strong IMF" };
    return { desc: "Very strong interplanetary magnetic field.", level: "> 30: Very strong IMF" };
  },
  bz: (value) => {
    if (value > 0) return { desc: "Usually quiet, less aurora.", level: "> 0: Northward" };
    if (value > -10) return { desc: "Potential for aurora.", level: "0 to -10: Southward" };
    return { desc: "Increased geomagnetic activity and aurora chances.", level: "< -10: Strong southward" };
  },
  by: (value) => {
    if (Math.abs(value) < 5) return { desc: "Minor effect.", level: "< 5: Weak" };
    if (Math.abs(value) < 15) return { desc: "Can enhance aurora at high latitudes.", level: "5–15: Moderate" };
    return { desc: "Significant east/west tilt, can enhance local aurora.", level: "> 15: Strong" };
  }
};

export async function fetchAndRenderSW(param, unit) {
	configureHighchartsTimezone();
	const periodEl = document.getElementById(`sw-${param}-range`);
	const hours    = periodEl?.value || 3;
	const res      = await fetch(`/solarwind/timeseries?param=${param}&hours=${hours}&_=${Date.now()}`);
	const json     = await res.json();
	if (!json.data?.length) return;

	const points = json.data.map(pt => [new Date(pt.time + 'Z').getTime(), pt.value]);
	const lastPoint = points[points.length - 1];

	let min = Math.min(...points.map(p => p[1]));
	let max = Math.max(...points.map(p => p[1]));
	if (param === 'bz' || param === 'by') {
	min = Math.min(min, 0) - 0.5;
	max = Math.max(max, 0) + 0.5;
	}

	const thisMinTime = points.length ? points[0][0] : null;
	const thisMaxTime = points.length ? points[points.length-1][0] : null;
	if (thisMinTime && (globalMinTime === null || thisMinTime < globalMinTime)) globalMinTime = thisMinTime;
	if (thisMaxTime && (globalMaxTime === null || thisMaxTime > globalMaxTime)) globalMaxTime = thisMaxTime;

	let plotLines = [];
	const speedChart = swCharts['speed'];
	const lastSpeed  = speedChart
	? speedChart.series[0].options.data.at(-1)[1]
	: null;
	if (lastSpeed) {
	const distanceKm = 1_500_000;
	const travelMs   = (distanceKm / lastSpeed) * 1000;
	const now        = Date.now();
	const lineTime   = now - travelMs;
	plotLines = getEarthLine(lineTime);
	}

	// Efter att du hämtat sista värdet i lastPoint:
	let fillColor, borderColor;
	if (param === "speed") {
	  const colors = getSpeedColors(lastPoint[1]);
	  fillColor = {
		linearGradient: [0, 220, 0, 0], // lodrät
		stops: [
		  [0, colors.gradient[1]], // top
		  [1, colors.gradient[0]]  // bottom
		]
	  };
	  borderColor = colors.border;
	} else if (param === "density") {
	  const colors = getDensityColors(lastPoint[1]);
	  fillColor = {
		linearGradient: [0, 220, 0, 0],
		stops: [
		  [0, colors.gradient[1]],
		  [1, colors.gradient[0]]
		]
	  };
	  borderColor = colors.border;
	} else if (param === "bt") {
	  const colors = getBtColors(lastPoint[1]);
	  fillColor = {
		linearGradient: [0, 220, 0, 0],
		stops: [
		  [0, colors.gradient[1]],
		  [1, colors.gradient[0]]
		]
	  };
	  borderColor = colors.border;
	} else {
	  fillColor = undefined;
	  borderColor = "#ffb300"; // fallback
	}

	let chartSeries = [{
	  name: param.toUpperCase(),
	  data: points,
	  type: "area",
	  color: borderColor, // används för själva linjen/ytan
	  fillColor: fillColor,
	  fillOpacity: 1,
	  lineWidth: 1,
	  marker: { enabled: false },
	  zIndex: 4
	}];

	if (["speed", "density", "bt"].includes(param)) {
	  chartSeries.push({
		name: param.toUpperCase() + " top",
		data: points,
		type: "line",
		color: borderColor,   // <-- använd rätt färg!
		lineWidth: 1,
		marker: { enabled: false },
		enableMouseTracking: false,
		linkedTo: null,
		zIndex: 10,
		visible: true,
		showInLegend: false
	  });
	}

	// Zones används bara på Bz och By
	let zones = [];
	if (param === 'bz' || param === 'by') {
	zones = [
	  { value: 0, color: 'rgba(200,0,0,0.9)', fillColor: 'rgba(255,70,70,0.19)' },
	  { color: 'rgba(0,200,0,0.9)', fillColor: 'rgba(70,255,70,0.19)' }
	];
	chartSeries[0].zones = zones;
	chartSeries[0].zoneAxis = "y";
	}

	if (swCharts[param]) swCharts[param].destroy();

	swCharts[param] = Highcharts.chart(`sw-${param}-chart`, {
	chart: {
	  type: "area",
	  backgroundColor: 'rgba(0,0,0,0)',
	  spacing: [2,2,2,2],
	  margin: [10,10,30,35],
	  height: 220,
	  style: { fontFamily: 'Arial, sans-serif' }
	},
	title: { text: null },
	exporting: { enabled: false },
	xAxis: {
	  type: 'datetime',
	  tickPixelInterval: 80,
	  lineColor: '#888',
	  tickColor: '#888',
	  gridLineWidth: 1,
	  gridLineColor: 'rgba(200,200,200,0.2)',
	  title: null,
	  plotLines,
	  labels: { style: { color: '#fff', fontSize: '7px' }, y: 20 }
	},
	yAxis: {
	  min: min,
	  max: max,
	  title: { text: unit, style: { color: '#fff', fontSize: '7px' }, x: 10 },
	  gridLineWidth: 1,
	  gridLineColor: 'rgba(200,200,200,0.13)',
	  plotBands: [],
	  labels: { style: { color: '#fff', fontSize: '7px' }, x: -2 }
	},
	tooltip: {
	  valueSuffix: ' ' + unit,
	  xDateFormat: '%H:%M',
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "7px"
	  }
	},
	legend: { enabled: false },
	credits: { enabled: false },
	plotOptions: {
	  series: {
		marker: { enabled: false },
		lineWidth: 1,
		animation: true
	  },
	  area: {
		marker: { enabled: false },
		fillOpacity: 1,
		lineWidth: 1
	  }
	},
	series: chartSeries
	});

	// Value tooltip (kan behålla som innan)
	const valueSpan = document.getElementById(`sw-${param}-current`);
	if (valueSpan) {
	const value = lastPoint[1].toFixed(2) + " " + unit;
	const time = new Date(lastPoint[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	let tooltipDesc = "";
	if (swlDescriptions[param]) {
	  const { desc, level } = swlDescriptions[param](lastPoint[1]);
	  tooltipDesc = `<div style="margin-top:0.3em;"><b>${level}</b><br>${desc}</div>`;
	}
	valueSpan.innerHTML = `
	  <span class="current-value-tooltip">
		${value}
	  </span>
	`;
	}
}

// Refreshes all five charts independently; rejects with the combined errors so
// callers (section_errors.runSection) can show them.
function refreshAllSolarwindCharts() {
  return settleAll(swParams.map(({ key }) => [key, () => solarwindRefreshCallbacks.get(key)()]));
}

export function setupSolarwind() {
  swParams.forEach(({ key }) => {
    const select = document.getElementById(`sw-${key}-range`);
    if (select && !boundSolarwindControls.has(select)) {
      select.addEventListener('change', solarwindRefreshCallbacks.get(key));
      boundSolarwindControls.add(select);
    }
  });

  const initial = refreshAllSolarwindCharts();
  if (solarwindRefreshTimer === null) {
    solarwindRefreshTimer = setInterval(
      () => refreshAllSolarwindCharts().catch(err => console.error('Solarwind refresh failed:', err)),
      60_000,
    );
  }
  return initial;
}

let byAuroraChart = null;

export async function fetchAndRenderByAuroraScore() {
  const chartDiv = document.getElementById('by-aurora-chart');
  if (!chartDiv) return;
  configureHighchartsTimezone();
  const periodEl = document.getElementById('by-aurora-range');
  const hours = periodEl?.value || 6;
  const res = await fetch(`byaurora/score_series_synced?hours=${hours}&_=${Date.now()}`);
  const json = await res.json();
  if (!json.data) return;

  const times = json.data.map(d => new Date(d.time + "Z").getTime());
  const score = json.data.map(d => d.score);
  const index = json.data.map(d => d.index);

  const thisMinTime = times.length ? times[0] : null;
  const thisMaxTime = times.length ? times[times.length-1] : null;
  if (thisMinTime && (globalMinTime === null || thisMinTime < globalMinTime)) globalMinTime = thisMinTime;
  if (thisMaxTime && (globalMaxTime === null || thisMaxTime > globalMaxTime)) globalMaxTime = thisMaxTime;

  // Y-axel max, dynamisk men aldrig under 100
  const yMax = Math.max(...score, 100);

  if (byAuroraChart) byAuroraChart.destroy();

  byAuroraChart = Highcharts.chart('by-aurora-chart', {
    chart: {
	  type: 'area',
	  backgroundColor: 'rgba(0,0,0,0)',
	  spacing: [2,2,2,2],
      margin: [5,5,30,40],
	  height: 220
	},
    title: { text: null },
    exporting: { enabled: false },
    xAxis: {
	  type: 'datetime',
	  min: globalMinTime,
	  max: globalMaxTime,
	  tickPixelInterval: 80,
      gridLineWidth: 1,
      gridLineColor: 'rgba(200,200,200,0.2)',
      lineColor: '#888',
      labels: { style: { color: '#fff', fontSize: '7px' }, y: 20  }
    },
    yAxis: {
      min: 0,
      max: yMax,
      title: { text: 'By Aurora Score', style: { color: '#fff', fontSize: '7px' }, x: 10 },
      plotBands: [
        {
          from: 0, to: 200,
          color: "rgba(40,180,255,0.06)",
          label: { text: "Likely", style: { color: "#41c0ff" } }
        },
        {
          from: 200, to: yMax,
          color: "rgba(130,0,255,0.08)",
          label: { text: "Extreme", style: { color: "#d52cff" } }
        }
      ],
      labels: { style: { color: '#fff', fontSize: '7px' }, x: -2 }
    },
    series: [{
      name: 'By Aurora Score',
      data: json.data.map((d, i) => [times[i], score[i]]),
      color: {
        linearGradient: [0, 0, 0, 240],
        stops: [
          [0, '#52f'],
          [0.7, '#22ffb2'],
          [1, '#fff']
        ]
      },
	  lineWidth: 1.2,
      fillOpacity: 0.35
    }],
    tooltip: {
      formatter: function() {
        const d = json.data.find(x => new Date(x.time + "Z").getTime() === this.x);
        return `<b>${Highcharts.dateFormat('%H:%M', this.x)}</b><br>
          Score: <b>${d.score.toFixed(1)}</b><br>
          By-index: <b>${d.index}</b><br>
          By: <b>${d.by.toFixed(2)}</b> nT<br>
          Bz: <b>${d.bz.toFixed(2)}</b> nT<br>
          ΔX (medel): <b>${d.mag.toFixed(2)}</b> nT
        `;
      },
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "7px"
	  }
    },
    credits: { enabled: false },
    legend: { enabled: false },
    plotOptions: { series: { animation: false } }
  });
}

export function setupByAuroraScore() {
  const periodEl = document.getElementById('by-aurora-range');
  const chartDiv = document.getElementById('by-aurora-chart');
  if (!periodEl || !chartDiv) return; // Avbryt allt om inget finns kvar

  periodEl.addEventListener('change', fetchAndRenderByAuroraScore);
  fetchAndRenderByAuroraScore();
  setInterval(fetchAndRenderByAuroraScore, 60000);
}
