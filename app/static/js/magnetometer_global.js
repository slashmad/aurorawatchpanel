// static/js/magnetometer_global.js
import { isCardActive } from './card_layout.js';

import { getLocation } from './state.js';

// Lista på globala stationer med färg och namn
export const GLOBAL_MAG_STATIONS = [
  { id: "BOU", name: "Boulder, BOU", color: "#e57373", lat: 40.13, lon: -105.24 },
  { id: "FRD", name: "Fredericksburg, FRD", color: "#64b5f6", lat: 38.20, lon: -77.37 },
  { id: "BRW", name: "Utqiagvik, BRW", color: "#ffd54f", lat: 71.32, lon: -156.61 },
  { id: "CMO", name: "College, CMO", color: "#81c784", lat: 64.87, lon: -147.86 }
];

let globalChart = null;
let globalRefreshTimer = null;
const boundGlobalControls = new WeakSet();

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

export async function setupMagnetometerGlobal() {
  if (globalRefreshTimer === null) {
    globalRefreshTimer = setInterval(() => {
      if (isCardActive('mag-global')) setupMagnetometerGlobal();
    }, 60000);
  }

  configureHighchartsTimezone();
  const compSelect = document.getElementById("magneto-global-component");
  const rangeSelect = document.getElementById("magneto-global-range");
  const component = compSelect ? compSelect.value : "x";
  const period = rangeSelect ? rangeSelect.value : 6;
  const stationIds = GLOBAL_MAG_STATIONS.map(s => s.id).join(",");
  const url = `/magneto_global/timeseries?stations=${stationIds}&hours=${period}&component=${component}&_=${Date.now()}`;

  const res = await fetch(url);
  const json = await res.json();
  if (!json.data) return;

  const series = GLOBAL_MAG_STATIONS.map(station => ({
    name: station.name,
    data: (json.data[station.id] || []).map(pt => [new Date(pt.time + 'Z').getTime(), pt.value]),
    color: station.color,
	lineWidth: 1,
    visible: true
  }));

  if (globalChart) globalChart.destroy();
  globalChart = Highcharts.chart('magneto-global-chart', {
    chart: {
	  type: 'line',
	  backgroundColor: 'rgba(0,0,0,0)',
	  spacing: [2,2,2,2],
      margin: [10,10,40,40],
      height: 220
	  },
    title: { text: null },
    exporting: { enabled: false },
    xAxis: {
      type: 'datetime',
      tickPixelInterval: 80,
      lineColor: '#888',
      tickColor: '#888',
      gridLineWidth: 1,
      gridLineColor: 'rgba(200,200,200,0.18)',
      labels: { style: { color: '#fff', fontSize: '7px' }, y: 20 }
    },
    yAxis: {
      title: { text: `Δ${component.toUpperCase()} (nT)`, style: { color: '#fff', fontSize: '7px' }, x: 10 },
      gridLineWidth: 1,
      gridLineColor: 'rgba(200,200,200,0.14)',
      labels: { style: { color: '#fff', fontSize: '7px' }, x: -2 },
		plotBands: [
		  { from: -220, to: -360, color: 'rgba(255,230,90,0.12)', label: { text: 'K5', style: { color: '#fff', fontWeight: '', fontSize: '7px' }, align: 'right', verticalAlign: 'top', x: 0 } },
		  { from: -360, to: -600, color: 'rgba(240,185,60,0.14)', label: { text: 'K6', style: { color: '#fff', fontWeight: '', fontSize: '7px' }, align: 'right', verticalAlign: 'top', x: 0 } },
		  { from: -600, to: -1000, color: 'rgba(230,100,34,0.18)', label: { text: 'K7', style: { color: '#fff', fontWeight: '', fontSize: '7px' }, align: 'right', verticalAlign: 'top', x: 0 } },
		  { from: -1000, to: -1500, color: 'rgba(230,34,34,0.28)', label: { text: 'K8', style: { color: '#fff', fontWeight: '', fontSize: '7px' }, align: 'right', verticalAlign: 'top', x: 0 } },
		  { from: -1500, to: -5000, color: 'rgba(140,0,40,0.34)', label: { text: 'K9', style: { color: '#fff', fontWeight: '', fontSize: '7px' }, align: 'right', verticalAlign: 'top', x: 0 } }
		],
    },
    tooltip: { valueSuffix: ' nT', xDateFormat: '%H:%M', backgroundColor: "rgba(25,30,40,0.95)", borderColor: "#222", style: { color: "#fff", fontSize: "7px" } },
    legend: { enabled: true, symbolWidth: 5, itemDistance: 5, itemStyle: { color: '#fff', fontSize: '7px' }, y: 8 },
    credits: { enabled: false },
    series: series,
    plotOptions: {
      series: { animation: false },
      line: { marker: { enabled: false } }
    }
  });
}

export function setupMagnetometerGlobalEvents() {
  const compSelect = document.getElementById("magneto-global-component");
  const rangeSelect = document.getElementById("magneto-global-range");

  [compSelect, rangeSelect].forEach(control => {
    if (!control || boundGlobalControls.has(control)) return;
    control.addEventListener("change", setupMagnetometerGlobal);
    boundGlobalControls.add(control);
  });
}
