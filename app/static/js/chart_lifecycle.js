// ---- app/static/js/chart_lifecycle.js ----
// Highcharts only cleans up a previous chart when a new one is drawn into the
// *same* element. Code that rebuilds a container with innerHTML creates new
// elements, so the old charts stay alive (SVG, listeners, data) forever. Call
// this before replacing markup that contains charts.

export function destroyChartsWithin(root) {
  const charts = window.Highcharts?.charts;
  if (!root || !Array.isArray(charts)) return 0;
  let destroyed = 0;
  // Copy first: destroy() mutates Highcharts.charts.
  charts.slice().forEach(chart => {
    if (chart && chart.renderTo && root.contains(chart.renderTo)) {
      chart.destroy();
      destroyed += 1;
    }
  });
  return destroyed;
}
