// app/static/js/hp30.js

import { getLocation } from './state.js';

export async function setupHp30Gauge() {
  async function fetchHp30() {
    try {
      const res  = await fetch('/hp30/timeseries?hours=3');
      const json = await res.json();
      if (!json.data?.length) return;

      const latest = json.data.at(-1);
      const sum30  = json.data.reduce((acc, d) => acc + (d.hp30 ?? 0), 0);
      const avg3h  = sum30 / json.data.length;
      const hp60   = (typeof latest.hp60 === 'number' && !isNaN(latest.hp60))
                     ? latest.hp60.toFixed(1)
                     : '-';

      // Formatera senaste tid i vald tidszon
      const { tz } = getLocation();
      const timeStr = new Date(latest.timestamp.replace(' ', 'T') + 'Z')
        .toLocaleTimeString('sv-SE', {
          hour:   '2-digit',
          minute: '2-digit',
          timeZone: tz
        });

      drawHp30Gauge(
        'hp30-gauge',
        latest.hp30,
        avg3h,
        '', // label
        `Hp30 ${latest.hp30?.toFixed(1) ?? '-'} / Hp60 ${hp60}` +
        `<br><span style="font-size:0.9em">${timeStr}</span>`
      );
    } catch (err) {
      console.error("Couldn't fetch Hp30:", err);
    }
  }

  fetchHp30();
  setInterval(fetchHp30, 60 * 1000);
}

function drawHp30Gauge(containerId, value, avg3h, label = "", subtitle = "") {
  Highcharts.chart(containerId, {
    chart: {
      type: 'solidgauge',
      backgroundColor: '#222'
    },
    title: {
      text: 'Kp-index (Hp30)',
      style: { color: '#fff', fontSize: '1.4em', fontWeight: 'bold' },
      margin: 25
    },
    pane: {
      startAngle: -90,
      endAngle:   90,
      size:       '100%',
      background: [{
        outerRadius:    '100%',
        innerRadius:    '60%',
        shape:          'arc',
        borderWidth:    0,
        backgroundColor:'#444'
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
      tickLength:14,
      minorTickInterval: null,
      labels: {
        distance: 18,
        style: { color: '#fff', fontSize: '1.1em' }
      }
    },
    plotOptions: {
      solidgauge: {
        dataLabels: {
          y: 20,
          borderWidth: 0,
          useHTML: true,
          format: `<div style="text-align:center">
                     <span style="font-size:2em;color:#fff">Kp {y:.1f}</span><br/>
                     <span style="font-size:1em;color:#bbb">${subtitle}</span>
                     <div style="font-size:1em;color:#ccc;margin-top:4px;">
                       Latest 3h: <b>Kp ${avg3h.toFixed(1)}</b>
                     </div>
                   </div>`
        }
      },
      series: { animation: true }
    },
    tooltip: { enabled: false },
    credits: { enabled: false },
    series: [{
      name: 'Hp30',
      data: [Math.round(value * 10) / 10],
      color: value < 4 ? '#8bc34a' :
             value < 7 ? '#ffeb3b' :
                         '#e53935'
    }]
  });
}
