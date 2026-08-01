// app/static/js/magnetometer_fmi.js

import { getLocation } from './state.js';

function configureHighchartsTimezone() {
  const { tz } = getLocation();
  Highcharts.setOptions({ time: { timezone: tz } });
}

export const FMI_STATIONS = [
  { id: "KEV", name: "KEV",        color: "#e57373", lat: 69.76, lon: 27.01 }, //Kevo,
  { id: "MAS", name: "MAS",        color: "#e5ae73", lat: 69.46, lon: 23.70 }, //Masi,
  { id: "KIL", name: "KIL", color: "#e3e573", lat: 69.02, lon: 20.79 }, //Kilpisjärvi,
  { id: "IVA", name: "IVA",       color: "#b7e573", lat: 68.56, lon: 27.29 }, //Ivalo,
  { id: "MUO", name: "MUO",      color: "#88e573", lat: 68.02, lon: 23.53 }, //Muonio,
  { id: "SOD", name: "SOD",   color: "#73e591", lat: 67.37, lon: 26.63 }, //Sodankylä,
  { id: "PEL", name: "PEL",       color: "#73e5c7", lat: 66.90, lon: 24.08 }, //Pello,
  { id: "RAN", name: "RAN",       color: "#73d0e5", lat: 65.54, lon: 26.25 }, //Ranua,
  { id: "OUJ", name: "OUJ",   color: "#73a3e5", lat: 64.52, lon: 27.23 }, //Oulujärvi,
  { id: "MEK", name: "MEK",  color: "#737de5", lat: 62.77, lon: 30.97 }, //Mekrijärvi,
  { id: "HAN", name: "HAN",  color: "#9173e5", lat: 62.25, lon: 26.60 }, //Hankasalmi,
  { id: "NUR", name: "NUR",  color: "#b473e5", lat: 60.50, lon: 24.65 }, //Nurmijärvi,
  { id: "TAR", name: "TAR",       color: "#d873e5", lat: 58.26, lon: 24.46 } //Tartu,
];

let fmiChart = null;

export async function setupMagnetometerFMI() {
    configureHighchartsTimezone();
    const compSelect = document.getElementById("magneto-fmi-component");
    const rangeSelect = document.getElementById("magneto-fmi-range");
    const component = compSelect ? compSelect.value : "x";
    const period = rangeSelect ? rangeSelect.value : 6;
    const stationIds = FMI_STATIONS.map(s => s.id).join(",");
    const res = await fetch(`/magneto_fmi/timeseries?stations=${stationIds}&hours=${period}&component=${component}&_=${Date.now()}`);
    const json = await res.json();
    if (!json.data) return;

    const series = FMI_STATIONS.map(station => ({
        name: station.name,
        data: (json.data[station.id] || []).map(pt => [new Date(pt.time + 'Z').getTime(), pt.value]),
        color: station.color,
		lineWidth: 1,
        visible: true
    }));

    if (fmiChart) fmiChart.destroy();
    fmiChart = Highcharts.chart('magneto-fmi-chart', {
        chart: {
		  type: 'line',
		  backgroundColor: 'rgba(0,0,0,0)',
		  spacing: [2,2,2,2],
		  margin: [10,10,50,40],
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
        legend: {
            enabled: true,
			symbolWidth: 5,
            itemStyle: { color: '#fff', fontWeight: 'normal', fontSize: '7px' },
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

export function setupMagnetometerFMIEvents() {
    const compSelect = document.getElementById("magneto-fmi-component");
    const rangeSelect = document.getElementById("magneto-fmi-range");
    if (compSelect) compSelect.addEventListener("change", setupMagnetometerFMI);
    if (rangeSelect) rangeSelect.addEventListener("change", setupMagnetometerFMI);
}