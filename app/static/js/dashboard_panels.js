const DASHBOARD_PANEL_TARGETS = [
  { section: "location", columnId: "dashboard-location" },
  { section: "solarwind", columnId: "dashboard-solarwind" },
  { section: "magnetometer", columnId: "dashboard-magnetometer" },
  { section: "solar", columnId: "dashboard-solar" },
];

export function syncDashboardPanelOwnership(isDesktop = window.innerWidth >= 1350) {
  const dashboard = document.getElementById("dashboard-multipanel");
  if (!dashboard) return { isDesktop, moved: 0 };

  let moved = 0;
  DASHBOARD_PANEL_TARGETS.forEach(({ section, columnId }) => {
    const tabPanel = document.querySelector(`.tab-panel[data-section="${section}"]`);
    const dashboardColumn = document.getElementById(columnId);
    if (!tabPanel || !dashboardColumn) return;

    const source = isDesktop ? tabPanel : dashboardColumn;
    const destination = isDesktop ? dashboardColumn : tabPanel;
    Array.from(source.children).forEach(child => {
      destination.appendChild(child);
      moved += 1;
    });
  });

  return { isDesktop, moved };
}
