// app/static/js/by_aurora_calc.js

export async function setupByAuroraChart() {
  const res = await fetch(`/byaurora/timeseries?hours=6&_=${Date.now()}`);
  const json = await res.json();
  if (!json.data) return;

  const times = json.data.map(d => new Date(d.time + "Z").getTime());
  const byaurora = json.data.map(d => d.byaurora);
  const by = json.data.map(d => d.by);
  const bz = json.data.map(d => d.bz);

  Highcharts.chart('by-aurora-chart', {
    chart: { type: 'area', backgroundColor: '#222', height: 270 },
    title: { text: null },
	exporting: { enabled: false },
    xAxis: {
      type: 'datetime',
      gridLineWidth: 0,
      lineColor: '#888',
      labels: { style: { color: '#fff', fontSize: '10px' } }
    },
    yAxis: {
      min: 0, max: 2,
      tickPositions: [0,1,2],
      title: { text: null },
      labels: {
        formatter: function() {
          return this.value === 2 ? "Extreme" : this.value === 1 ? "Likely" : "";
        },
        style: { color: '#fff', fontSize: '10px' }
      }
    },
    series: [{
      name: 'By Aurora Index',
      data: json.data.map((d, i) => [times[i], byaurora[i]]),
      step: 'left',
      color: '#52f',
      fillOpacity: 0.3
    }],
    tooltip: {
      formatter: function() {
        const d = json.data.find(x => new Date(x.time + "Z").getTime() === this.x);
        return `<b>${Highcharts.dateFormat('%H:%M', this.x)}</b><br>
          By-index: <b>${d.byaurora}</b><br>
          By: <b>${d.by.toFixed(2)}</b> nT<br>
          Bz: <b>${d.bz.toFixed(2)}</b> nT<br>
          ΔX Kiruna: <b>${d.mag.toFixed(2)}</b> nT
        `;
      }
    },
    credits: { enabled: false },
    legend: { enabled: false },
    plotOptions: { series: { animation: false } }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupByAuroraChart();
  setInterval(setupByAuroraChart, 60000);
});

export async function setupByAuroraScoreChart() {
  const res = await fetch(`/byaurora/score_series?hours=6&_=${Date.now()}`);
  const json = await res.json();
  if (!json.data) return;

  const times = json.data.map(d => new Date(d.time + "Z").getTime());
  const score = json.data.map(d => d.score);
  const index = json.data.map(d => d.index);

  Highcharts.chart('by-aurora-chart', {
    chart: { type: 'area', backgroundColor: '#222', height: 270 },
    title: { text: null },
    exporting: { enabled: false },
    xAxis: {
      type: 'datetime',
      gridLineWidth: 0,
      lineColor: '#888',
      labels: { style: { color: '#fff', fontSize: '10px' } }
    },
    yAxis: {
      min: 0,
      max: Math.max(...score, 100), // Anpassa efter behov!
      title: { text: 'By Aurora Score', style: { color: '#fff', fontSize: '11px' } },
      plotBands: [
        {
          from: 0, to: 200,
          color: "rgba(40,180,255,0.06)",
          label: { text: "Likely", style: { color: "#41c0ff" } }
        },
        {
          from: 200, to: 500,
          color: "rgba(130,0,255,0.08)",
          label: { text: "Extreme", style: { color: "#d52cff" } }
        }
      ],
      labels: { style: { color: '#fff', fontSize: '10px' } }
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
      }
    },
    credits: { enabled: false },
    legend: { enabled: false },
    plotOptions: { series: { animation: false } }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupByAuroraScoreChart();
  setInterval(setupByAuroraScoreChart, 60000);
});
