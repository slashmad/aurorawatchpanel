// static/js/magnetometer_uit.js

import { getLocation } from './state.js';

export const UIT_STATIONS = [
  { id: "NAL", name: "NAL",        color: "#29b6f6", lat: 78.93, lon: 11.92 }, //Ny Ålesund,
  { id: "LYR", name: "LYR",      color: "#7c4dff", lat: 78.22, lon: 15.63 }, //Longyearbyen,
  { id: "HOP", name: "HOP",             color: "#00c853", lat: 76.51, lon: 25.01 }, //Hopen,
  { id: "BJN", name: "BJN",          color: "#d84315", lat: 74.50, lon: 19.02 }, //Bjørnøya,
  { id: "NOR", name: "NOR",          color: "#b71c1c", lat: 71.17, lon: 25.78 }, //Nordkapp,
  { id: "SOR", name: "SOR",            color: "#33691e", lat: 70.63, lon: 22.11 }, //Sørøya,
  { id: "TRO", name: "TRO",            color: "#ff6f00", lat: 69.58, lon: 19.22 }, //Tromsø,
  { id: "AND", name: "AND",           color: "#1565c0", lat: 69.32, lon: 16.12 }, //Andenes,
  { id: "RST", name: "RST",              color: "#a1887f", lat: 67.51, lon: 12.10 }, //Røst,
  { id: "JCK", name: "JCK",           color: "#0097a7", lat: 66.61, lon: 16.97 }, //Jäckvik,
  { id: "DON", name: "DON",             color: "#388e3c", lat: 66.12, lon: 12.52 }, //Dønna,
  { id: "RVK", name: "RVK",            color: "#fbc02d", lat: 64.86, lon: 11.24 }, //Rørvik,
  { id: "DOB", name: "DOB",            color: "#512da8", lat: 62.07, lon: 9.13 }, //Dombås,
  { id: "SOL", name: "SOL",            color: "#c51162", lat: 61.08, lon: 4.83 }, //Solund,
  { id: "HAR", name: "HAR",          color: "#607d8b", lat: 60.22, lon: 10.75 }, //Harestua,
  { id: "KAR", name: "KAR",            color: "#00bfae", lat: 59.15, lon: 5.25 } //Karmøy,
];

UIT_STATIONS.sort((a, b) => b.lat - a.lat);

let uitChart = null;

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

export async function setupMagnetometerUIT() {
  const chartDiv = document.getElementById('magneto-uit-chart');
  if (!chartDiv) return;
  configureHighchartsTimezone();
  const compSelect = document.getElementById("magneto-uit-component");
  const rangeSelect = document.getElementById("magneto-uit-range");
  const component = compSelect ? compSelect.value : "x";
  // Mappa “x”→”D_deg”, “y”→”H_nT”, “z”→”Z_nT” innan vi skickar till backend
  const compMapBackend = { x: "D_deg", y: "H_nT", z: "Z_nT" };
  const backendComponent = compMapBackend[component] || "D_deg";
  const period = rangeSelect ? rangeSelect.value : 6;
  const stationIds = UIT_STATIONS.map(s => s.id).join(",");
  const res = await fetch(`/magneto_uit/timeseries?stations=${stationIds}&hours=${period}&component=${backendComponent}&_=${Date.now()}`);
  const json = await res.json();
  if (!json.data) return;

	const UIT_VISIBLE = [
	  "TRO", "JCK", "NOR", "HOP", "BJN"
	];

  const series = UIT_STATIONS.map(station => {
    const raw = json.data[station.id] || [];
    const filtered = raw
      .filter(pt => pt.value !== 0 && pt.value !== null && pt.value !== undefined)
      .map(pt => [new Date(pt.time + 'Z').getTime(), pt.value]);
    return {
      name: station.name,
      data: filtered,
      color: station.color,
      lineWidth: 1.2,
      visible: UIT_VISIBLE.includes(station.id)
    };
  });

  if (uitChart) uitChart.destroy();
  uitChart = Highcharts.chart('magneto-uit-chart', {
    chart: {
	  type: 'line',
	  backgroundColor: 'rgba(0,0,0,0)',
	  spacing: [2,2,2,2],
      margin: [5,5,50,40],
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
      labels: { style: { color: '#fff', fontSize: '9px' }, y: 20 }
    },
    yAxis: {
      title: (() => {
        // Anpassa titel beroende på vald komponent
        if (component === "x") return { text: "ΔD (°)", style: { color: '#fff', fontSize: '9px' }, x: 20 };
        if (component === "y") return { text: "ΔH (nT)", style: { color: '#fff', fontSize: '9px' }, x: 20 };
        if (component === "z") return { text: "ΔZ (nT)", style: { color: '#fff', fontSize: '9px' }, x: 20 };
        return { text: "Value", style: { color: '#fff', fontSize: '9px' }, x: 20 };
      })(),
      gridLineWidth: 1,
      gridLineColor: 'rgba(200,200,200,0.14)',
      labels: { style: { color: '#fff', fontSize: '9px' }, x: -2 }
    },
    tooltip: {
      valueSuffix: (() => {
        if (component === "x") return " °";
        if (component === "y" || component === "z") return " nT";
        return "";
      })(),
      xDateFormat: '%H:%M',
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "0.7em"
	  }
    },
    legend: {
      enabled: true,
	  symbolWidth: 5,
      itemStyle: { color: '#fff', fontWeight: 'normal', fontSize: '9px' },
      itemHoverStyle: { color: '#fff' },
      itemHiddenStyle: { color: '#888' },
	  itemDistance: 5,
	  y: 10
    },
    credits: { enabled: false },
    series: series,
    plotOptions: {
      series: { animation: false },
      line: { marker: { enabled: false } }
    }
  });
}

export function setupMagnetometerUITEvents() {
  const compSelect = document.getElementById("magneto-uit-component");
  const rangeSelect = document.getElementById("magneto-uit-range");
  // Lägg till detta om du vill:
  if (!compSelect && !rangeSelect) return;
  if (compSelect) compSelect.addEventListener("change", setupMagnetometerUIT);
  if (rangeSelect) rangeSelect.addEventListener("change", setupMagnetometerUIT);
}
