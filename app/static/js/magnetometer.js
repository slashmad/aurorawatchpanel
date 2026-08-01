// app/static/js/magnetometer.js

import { getLocation } from './state.js';

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

// IRF = KIR, TOP
//SGU = ABK, LYC, UPS
export const IRF_STATIONS = [
  { id: "ABK", name: "Abisko, ABK",     color: "#80ffb3", lat: 68.40, lon: 18.80 },
  { id: "KIR", name: "Kiruna, KIR",     color: "#ffa500", lat: 67.84, lon: 20.41 },
  { id: "LYC", name: "Lycksele, LYC",   color: "#c77dff", lat: 64.60, lon: 18.75 },
  { id: "UPS", name: "Uppsala, UPS",    color: "#ffd166", lat: 59.86, lon: 17.64 },
  { id: "TOP", name: "Tormestorp, TOP", color: "#7dc9f5", lat: 56.09, lon: 13.72 },
];

const EXCLUDE = [""];

let magChart = null;

export async function fetchAndRenderMagIRF(period = 6, component = "x") {
  configureHighchartsTimezone();
  const stationIds = IRF_STATIONS.map(s => s.id).join(",");
  const res = await fetch(`/magneto/timeseries_multi?stations=${stationIds}&hours=${period}&component=${component}&_=${Date.now()}`);
  const json = await res.json();
  if (!json.data) return;
  const kindexRes = await fetch(`/kindex/timeseries?stations=${stationIds}&hours=${period * 2}&_=${Date.now()}`);
  const kindexJson = await kindexRes.json();

const series = IRF_STATIONS
  .filter(station => !EXCLUDE.includes(station.id))      // <-- ta bort helt!
  .map(station => ({
    name: station.name,
    data: (json.data[station.id] || [])
      .filter(pt => Math.abs(pt.value) < 10000)          // filtrera orimliga värden!
      .map(pt => [new Date(pt.time + 'Z').getTime(), pt.value]),
    color: station.color,
    lineWidth: 1,
    marker: { enabled: false },
    visible: true
}));

  let allPoints = series.flatMap(s => s.data.map(pt => pt[1]));
  let min = Math.floor(Math.min(...allPoints) - 10);
  let max = Math.ceil(Math.max(...allPoints) + 10);

  let plotLines = [];
  const firstSeriesPoints = series[0]?.data;
  if (firstSeriesPoints?.length) {
    plotLines.push({
      color: '#fff',
      width: 0,
      value: firstSeriesPoints.at(-1)[0],
      zIndex: 10
    });
  }

  if (magChart) magChart.destroy();

  magChart = Highcharts.chart('magneto-chart', {
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
      title: null,
      plotLines,
      labels: { style: { color: '#fff', fontSize: '7px' }, y: 20 }
    },
	yAxis: {
	  min,
	  max,
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
    tooltip: {
      valueSuffix: ' nT',
      xDateFormat: '%H:%M',
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "7px"
	  }
    },
    legend: { enabled: true, symbolWidth: 5, itemDistance: 5, itemStyle: { color: '#fff', fontSize: '7px' }, y: 8 },
    credits: { enabled: false },
    series: series,
    plotOptions: {
      line: { marker: { enabled: false } },
      series: { animation: false }
    }
  });

  if (series[0] && series[0].data.length) {
    const val = series[0].data.at(-1)[1];
    const vspan = document.getElementById("mag-kiruna-current");
    if (vspan) vspan.textContent = val.toFixed(2) + " nT";
  }

	const kirKData = (kindexJson.data.KIR || []);
	let latestKirK = "-";
	if (kirKData.length) {
	  latestKirK = kirKData.at(-1).k_index;
	}
	const kspan = document.getElementById("mag-kiruna-kindex");
	if (kspan) {
	  kspan.textContent = `K-I: ${latestKirK}`;
	  // Färgkod (SWL-stil)
	  kspan.style.color =
		latestKirK >= 8 ? '#b71c1c' :
		latestKirK >= 7 ? '#ea4442' :
		latestKirK >= 6 ? '#fa9942' :
		latestKirK >= 5 ? '#ffd55b' :
		'#6bc779';
	}

}


export function setupMagnetometer() {
  configureHighchartsTimezone();
  const periodSelect = document.getElementById('mag-kiruna-range');
  const compSelect = document.getElementById('mag-kiruna-component');

  function updateChart() {
    fetchAndRenderMagIRF(
      periodSelect?.value || 6,
      compSelect?.value || "x"
    );
  }

  if (periodSelect) periodSelect.addEventListener('change', updateChart);
  if (compSelect) compSelect.addEventListener('change', updateChart);

  updateChart();
  setInterval(updateChart, 60000);
}