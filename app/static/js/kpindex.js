// app/static/js/kpindex.js

import { getLocation } from './state.js';

function drawKpGauge(containerId, value, label = "", subtitle = "") {
  // Förhindra NaN/undefined fel
  if (typeof value !== "number" || isNaN(value)) value = 0;
  Highcharts.chart(containerId, {
    chart: {
      type: 'solidgauge',
      backgroundColor: '#222'
    },
    title: {
      text: 'Kp-index',
      style: { color: '#fff', fontSize: '1.4em', fontWeight: 'bold' },
      margin: 25
    },
    pane: {
      startAngle: -90,
      endAngle:   90,
      size:       '100%',
      background: [{
        outerRadius: '100%',
        innerRadius: '60%',
        shape:       'arc',
        borderWidth: 0,
        backgroundColor: '#444'
      }]
    },
    yAxis: {
      min: 0,
      max: 9,
      tickPositions: [0,1,2,3,4,5,6,7,8,9],
      stops: [
        [0.33, '#8bc34a'],
        [0.67, '#ffeb3b'],
        [1,     '#e53935']
      ],
      lineWidth: 0,
      tickWidth: 2,
      tickLength: 14,
      minorTickInterval: null,
      labels: {
        distance: 18,
        style: { color: '#fff', fontSize: '1.1em' }
      }
    },
    plotOptions: {
      solidgauge: {
        dataLabels: {
          y: 30,
          borderWidth: 0,
          useHTML: true,
          format: `<div style="text-align:center">
                     <span style="font-size:2em;color:#fff">Kp {y}</span><br/>
                     <span style="font-size:1em;color:#bbb">${subtitle}</span>
                   </div>`
        }
      },
      series: {
        animation: true
      }
    },
    tooltip: { enabled: false },
    credits: { enabled: false },
    series: [{
      name: 'Kp',
      data: [value],
      color: value < 4 ? '#8bc34a' :
             value < 7 ? '#ffeb3b' :
                         '#e53935'
    }]
  });
}

export function setupKpGauge() {
  async function fetchKp() {
    try {
      const res  = await fetch('/kp/timeseries?hours=3');
      const json = await res.json();
      if (!json.data?.length) return;  // Avbryt om tomt

      // Filtrera bort rader utan giltigt Kp
      const validData = json.data.filter(r => typeof r.kp === 'number' && !isNaN(r.kp));
      if (!validData.length) return; // Inget att visa

      const sum     = validData.reduce((acc, r) => acc + r.kp, 0);
      const avg     = sum / validData.length;
      const rounded = Math.round(avg * 10) / 10;

      const first   = validData[0];
      const last    = validData.at(-1);
      if (!first?.time || !last?.time) return;

      const period  = `${shortTime(first.time)}–${shortTime(last.time)}`;

      drawKpGauge(
        'kp-gauge',
        rounded,
        '',
        `Kp-snitt (3h)<br><span style="font-size:0.9em">${period}</span>`
      );
    } catch (err) {
      console.error("Couldn't fetch Kp-index:", err);
    }
  }

  fetchKp();
  setInterval(fetchKp, 60 * 1000);
}
