// ---- app/static/js/solar_cycle.js ----

function makeSolarCycleSeries(obs, pred, param, opts = {}) {
  const monthlyKey    = param === "ssn" ? "ssn" : "f10.7";
  const smoothedKey   = param === "ssn" ? "smoothed_ssn" : "smoothed_f10.7";
  const predKey       = param === "ssn" ? "predicted_ssn" : "predicted_f10.7";
  const high75Key     = param === "ssn" ? "high75_ssn" : "high75_f10.7";
  const low75Key      = param === "ssn" ? "low75_ssn" : "low75_f10.7";
  const high50Key     = param === "ssn" ? "high_ssn" : "high_f10.7";
  const low50Key      = param === "ssn" ? "low_ssn" : "low_f10.7";
  const high25Key     = param === "ssn" ? "high25_ssn" : "high25_f10.7";
  const low25Key      = param === "ssn" ? "low25_ssn" : "low25_f10.7";

  const parseTime = row => Date.parse((row["time-tag"] || row.time) + "T00:00:00Z");

  const observed = obs
    .filter(r => {
      if (r[monthlyKey] == null || r[monthlyKey] <= 0) return false;
      const year = Number((r["time-tag"] || r.time).split("-")[0]);
      if (param === "ssn" && year < 1749) return false;
      if (param === "f10.7" && year < 1947) return false;
      return true;
    })
    .map(r => [parseTime(r), r[monthlyKey]]);
  const smoothed = obs
    .filter(r => {
      if (r[smoothedKey] == null || r[smoothedKey] <= 0) return false;
      const year = Number((r["time-tag"] || r.time).split("-")[0]);
      if (param === "ssn" && year < 1749) return false;
      if (param === "f10.7" && year < 1947) return false;
      return true;
    })
    .map(r => [parseTime(r), r[smoothedKey]]);

  const band75 = pred.filter(r => r[high75Key] != null && r[low75Key] != null)
    .map(r => [parseTime(r), r[low75Key], r[high75Key]]);
  const band50 = pred.filter(r => r[high50Key] != null && r[low50Key] != null)
    .map(r => [parseTime(r), r[low50Key], r[high50Key]]);
  const band25 = pred.filter(r => r[high25Key] != null && r[low25Key] != null)
    .map(r => [parseTime(r), r[low25Key], r[high25Key]]);

  const predicted = pred.filter(r => r[predKey] != null)
    .map(r => [parseTime(r), r[predKey]]);

  return [
    {
      name: "75th Percentile Predicted Range",
      type: "arearange",
      data: band75,
      color: "rgba(255,0,160,0.09)",
      showInLegend: true,
      zIndex: 1,
      fillOpacity: 1,
      marker: { enabled: false }
    },
    {
      name: "50th Percentile Predicted Range",
      type: "arearange",
      data: band50,
      color: "rgba(255,0,160,0.17)",
      showInLegend: true,
      zIndex: 2,
      fillOpacity: 1,
      marker: { enabled: false }
    },
    {
      name: "25th Percentile Predicted Range",
      type: "arearange",
      data: band25,
      color: "rgba(255,0,160,0.31)",
      showInLegend: true,
      zIndex: 3,
      fillOpacity: 1,
      marker: { enabled: false }
    },
    {
      name: "Predicted Values",
      data: predicted,
      color: "#f960d7",
      lineWidth: 2,
      dashStyle: "Dash",
      marker: { enabled: false },
      zIndex: 8
    },
    {
      name: "Smoothed Monthly Values",
      data: smoothed,
      color: "#a5a7ff",
      lineWidth: 2,
      marker: { enabled: false },
      zIndex: 6
    },
    {
      name: "Monthly Values",
      data: observed,
      color: "rgba(219,230,255,0.5)",
      lineWidth: 1.2,
      marker: { enabled: true, symbol: "circle", radius: 2.2, fillColor: "rgba(219,230,255,0.5)" },
      zIndex: 5
    }
  ];
}

export async function setupSolarCycleCharts() {
  const obsUrl = "https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json";
  const predUrl = "https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json";
  // Ladda data parallellt
  const [obs, pred] = await Promise.all([
    fetch(obsUrl).then(r => r.json()),
    fetch(predUrl).then(r => r.json()),
  ]);

const ssnSeries = makeSolarCycleSeries(obs, pred, "ssn");
const f107Series = makeSolarCycleSeries(obs, pred, "f10.7");

  // 1. SUNSPOT NUMBER GRAF
  Highcharts.chart('solarcycle-ssn-chart', {
    chart: {
      type: 'line',
      backgroundColor: 'rgba(0,0,0,0)',
      zoomType: 'x',
      height: 310,
      style: { fontFamily: "system-ui, sans-serif" }
    },
    title: null,
    credits: { enabled: false },
    exporting: { enabled: false },
    xAxis: {
      type: "datetime",
      title: { text: null },
	  min: Date.UTC(2005,0,1),
      gridLineColor: "#ccc",
      gridLineWidth: 1,
      labels: { style: { color: "#fff" } }
    },
    yAxis: {
	  min: 0,
      title: { text: "Sunspot Number", style: { color: "#fff" } },
      gridLineColor: "#ccc",
      gridLineWidth: 1,
      labels: { style: { color: "#fff" } }
    },
    legend: {
      enabled: true,
      itemStyle: { color: "#fff", fontWeight: "normal" },
      itemHoverStyle: { color: "#ffe066" }
    },
    tooltip: {
      shared: true,
      xDateFormat: "%Y-%m",
      valueDecimals: 1,
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "0.7em"
	  }
    },
    series: makeSolarCycleSeries(obs, pred, "ssn"),
  navigator: {
    enabled: true,
    outlineColor: "#ccc",
    series: {
      color: "#dbe6ff",
      lineWidth: 1,
      data: ssnSeries[ssnSeries.length-1].data
    }
  },
  scrollbar: { enabled: true },
  });

  // 2. F10.7CM GRAF
  Highcharts.chart('solarcycle-f107-chart', {
    chart: {
      type: 'line',
      backgroundColor: 'rgba(0,0,0,0)',
      zoomType: 'x',
      height: 310,
      style: { fontFamily: "system-ui, sans-serif" }
    },
    title: null,
    credits: { enabled: false },
    exporting: { enabled: false },
    xAxis: {
      type: "datetime",
      title: { text: null },
	  min: Date.UTC(2005,0,1),
      gridLineColor: "#ccc",
      gridLineWidth: 1,
      labels: { style: { color: "#fff" } }
    },
    yAxis: {
	  min: 50,
	  startOnTick: false,
      title: { text: "F10.7 Flux (solar flux units)", style: { color: "#fff" } },
      gridLineColor: "#ccc",
      gridLineWidth: 1,
      labels: { style: { color: "#fff" } }
    },
    legend: {
      enabled: true,
      itemStyle: { color: "#fff", fontWeight: "normal" },
      itemHoverStyle: { color: "#ffe066" }
    },
    tooltip: {
      shared: true,
      xDateFormat: "%Y-%m",
      valueDecimals: 1,
	  backgroundColor: "rgba(25,30,40,0.95)",
	  borderColor: "#222",
	  style: {
		color: "#fff",
		fontSize: "0.7em"
	  }
    },
    series: makeSolarCycleSeries(obs, pred, "f10.7"),
  navigator: {
    enabled: true,
    outlineColor: "#ccc",
    series: {
      color: "#dbe6ff",
      lineWidth: 1,
      data: f107Series[f107Series.length-1].data
    }
  },
  scrollbar: { enabled: true },
  });
}
