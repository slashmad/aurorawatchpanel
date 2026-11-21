// app/static/js/gauge_double.js

import { destroyChartsWithin } from './chart_lifecycle.js';

export function drawDoubleGauge(
  containerId,
  kpValue, hp30Value,
  kp1h, kp3h, kp6h, kp12h,
  hp30_1h, hp30_3h, hp30_6h, hp30_12h
) {
  function getKpColor(v) {
    if (v < 4) return '#8bc34a';
    if (v < 7) return '#ffeb3b';
    return '#e53935';
  }
  function getHp30Color(v) {
    if (v < 4) return '#8bc34a';
    if (v < 7) return '#ffeb3b';
    return '#e53935';
  }
  function getKpStopColor(v) {
    if (v < 4) return '#8bc34a';
    if (v < 7) return '#ffeb3b';
    return '#e53935';
  }
  function getHp30StopColor(v) {
    if (v < 4) return '#8bc34a';
    if (v < 7) return '#ffeb3b';
    return '#e53935';
  }

  // Helper to format the stat row
function statRow(label, stats, colorFn) {
  if (!stats || stats.avg === null) return `
    <div style="color:#888; font-size:0.55em; margin-bottom:0.20em; display:flex; width:100%;">
      <span style="flex:0 0 2.2em; text-align:left; padding-left:4em; font-weight:600; color:#aaa;">${label}</span>
      <span style="flex:1;text-align:left;"></span>
      <span style="flex:1;text-align:center;"></span>
      <span style="flex:1;text-align:right;"></span>
    </div>
  `;
  return `
    <div style="font-size:0.55em; margin-bottom:0.13em; display: flex; width: 100%;">
      <span style="flex:0 0 2.2em; text-align:left; padding-left:4em; font-weight:600; color:#aaa;">${label}</span>
      <span style="flex:1;text-align:left; color:${colorFn(stats.min)};">${stats.min?.toFixed(1) ?? ''}</span>
      <span style="flex:1;text-align:center; color:${colorFn(stats.avg)};">${stats.avg?.toFixed(1) ?? ''}</span>
      <span style="flex:1;text-align:right; color:${colorFn(stats.max)}; padding-right:3.5em;">${stats.max?.toFixed(1) ?? ''}</span>
    </div>
  `;
}



  const container = document.getElementById(containerId);
  if (!container) return;

  // The markup below replaces the gauge elements; destroy the previous gauges
  // first, otherwise every 5-minute redraw leaks two complete charts.
  destroyChartsWithin(container);

  container.innerHTML = `
  <div style="width: 100%; display: flex; flex-direction: column; align-items: stretch; border-radius: 0.35rem;">
    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 0.5em; color: #aaa;">
      <span title="Source: NOAA SWPC">&copy; NOAA SWPC</span>
      <span title="Source: GFZ Helmholtz Centre">&copy; GFZ Helmholtz Centre</span>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: stretch; width: 100%; height: 100%;">
      <!-- Kp section -->
<div style="width:49%; min-width:125px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; height: 100%;">
  <div id="${containerId}-kp" style="width:100%;"></div>
  <div style="margin-top: -50px; margin-bottom: 5px; display: flex; align-items: flex-start; justify-content: center;">
    <div style="color:${getKpStopColor(kpValue)}; font-size:1em; font-weight:bold; text-shadow:1px 1px 3px #111;">
      <span class="kp-tooltip-wrap" style="position:relative; display:inline-block; cursor:pointer;">
        KP: ${kpValue.toFixed(1)}
        <span class="rt-tooltip">Real-time value</span>
      </span>
    </div>
  </div>
  <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; margin-top: 4px;">
<div style="display: flex; width: 100%; justify-content: space-between; font-size: 0.78em; color: #aaa; font-weight: bold; margin-bottom: 0.17em;">
  <span style="flex:0 0 2.1em; text-align:right; padding-left:2em;"></span>
  <span style="flex:1;text-align:left;">min</span>
  <span style="flex:1;text-align:center;">avg</span>
  <span style="flex:1;text-align:right; padding-right: 2em;">max</span>
</div>


${statRow("1h", kp1h, getKpStopColor)}
${statRow("3h", kp3h, getKpStopColor)}
${statRow("6h", kp6h, getKpStopColor)}
${statRow("12h", kp12h, getKpStopColor)}

  </div>
</div>
      <!-- Hp30 section -->
<div style="width:49%; min-width:125px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; height: 100%;">
  <div id="${containerId}-hp30" style="width:100%;"></div>
  <div style="margin-top: -50px; margin-bottom: 5px; margin-left: 10px; display: flex; align-items: flex-start; justify-content: center;">
    <div style="color:${getHp30StopColor(hp30Value)}; font-size:1em; font-weight:bold; text-shadow:1px 1px 3px #111;">
      <span class="hp-tooltip-wrap" style="position:relative; display:inline-block; cursor:pointer;">
        HP30: ${hp30Value.toFixed(1)}
        <span class="rt-tooltip">Real-time value</span>
      </span>
    </div>
  </div>
  <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; margin-top: 4px;">
<div style="display: flex; width: 100%; justify-content: space-between; font-size: 0.78em; color: #aaa; font-weight: bold; margin-bottom: 0.17em;">
  <span style="flex:0 0 2.1em; text-align:right; padding-left:2em;"></span>
  <span style="flex:1;text-align:left;">min</span>
  <span style="flex:1;text-align:center;">avg</span>
  <span style="flex:1;text-align:right; padding-right: 2em;">max</span>
</div>


${statRow("1h", hp30_1h, getHp30StopColor)}
${statRow("3h", hp30_3h, getHp30StopColor)}
${statRow("6h", hp30_6h, getHp30StopColor)}
${statRow("12h", hp30_12h, getHp30StopColor)}

  </div>
</div>
    </div>
  </div>
  `;

  // Shared chart options for both gauges
  const gaugeOpts = {
    chart: {
      type: 'solidgauge',
	  backgroundColor: 'rgba(0,0,0,0)',
      height: 115,
      spacingLeft: 0,
      spacingRight: 0
    },
    title: null,
    exporting: { enabled: false },
    pane: {
      startAngle: -90,
      endAngle: 90,
      center: ['50%', '76%'],
      size: '130%',
      background: [{
        outerRadius: '100%',
        innerRadius: '60%',
        backgroundColor: 'rgba(0,0,0,0)',
        borderWidth: 0,
        shape: 'arc'
      }]
    },
    yAxis: {
      min: 0,
      max: 9,
      tickPositions: [0,1,2,3,4,5,6,7,8,9],
      labels: { distance: 15, style: { color: '#fff', fontSize: '0.8em' } },
      lineWidth: 0,
      tickWidth: 2,
      tickLength: 10,
	  tickColor: '#fff',
      stops: [
        [0.33, '#8bc34a'],
        [0.67, '#ffeb3b'],
        [1,     '#e53935']
      ],
    },
    tooltip: { enabled: false },
    credits: { enabled: false },
    plotOptions: {
      solidgauge: {
        dataLabels: { enabled: false }
      }
    }
  };

  // Render Kp gauge
  Highcharts.chart(`${containerId}-kp`, {
    ...gaugeOpts,
    series: [{
      name: 'Kp',
      data: [Math.round(kpValue * 10) / 10],
      radius: '100%',
      innerRadius: '60%',
      color: getKpColor(kpValue)
    }]
  });

  // Render Hp30 gauge
  Highcharts.chart(`${containerId}-hp30`, {
    ...gaugeOpts,
    yAxis: {
      ...gaugeOpts.yAxis,
      labels: {
        ...gaugeOpts.yAxis.labels,
        formatter: function () {
          // Add "+" to 9
          if (this.value === 9) return '9+';
          return this.value;
        }
      }
    },
    series: [{
      name: 'Hp30',
      data: [Math.round(hp30Value * 10) / 10],
      radius: '100%',
      innerRadius: '60%'
    }]
  });
}
