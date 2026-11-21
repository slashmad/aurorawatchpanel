import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;
const panelIds = [
  'weather-card-container',
  'sw-speed-range',
  'magneto-fmi-range',
  'solar-image-card',
];

async function isolateApplicationRequests(page) {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const isLocalAsset = url.origin === localOrigin && (
      url.pathname === '/' ||
      url.pathname.startsWith('/static/') ||
      url.pathname.startsWith('/images/') ||
      url.pathname.startsWith('/svg/') ||
      url.pathname.startsWith('/data/')
    );

    if (request.resourceType() === 'document' || isLocalAsset) {
      await route.continue();
    } else if (url.origin === localOrigin) {
      await route.fulfill({ json: {} });
    } else {
      await route.abort();
    }
  });
}

test('dashboard ownership moves the original nodes without cloning', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    document.body.innerHTML = `
      <div id="dashboard-multipanel">
        <div id="dashboard-location"></div>
        <div id="dashboard-solarwind"></div>
        <div id="dashboard-magnetometer"></div>
        <div id="dashboard-solar"></div>
      </div>
      <section class="tab-panel" data-section="location"><button id="location-node">Location</button></section>
      <section class="tab-panel" data-section="solarwind"><button id="solarwind-node">Solarwind</button></section>
      <section class="tab-panel" data-section="magnetometer"><button id="magnetometer-node">Magnetometer</button></section>
      <section class="tab-panel" data-section="solar"><button id="solar-node">Solar</button></section>
    `;

    window.originalSolarwindNode = document.getElementById('solarwind-node');
    window.solarwindNodeClicks = 0;
    window.originalSolarwindNode.addEventListener('click', () => {
      window.solarwindNodeClicks += 1;
    });

    window.dashboardPanelModule = await import(`/static/js/dashboard_panels.js?test=${Date.now()}`);
    window.firstDashboardSync = window.dashboardPanelModule.syncDashboardPanelOwnership(true);
    window.secondDashboardSync = window.dashboardPanelModule.syncDashboardPanelOwnership(true);
  });

  expect(await page.evaluate(() => window.firstDashboardSync.moved)).toBe(4);
  expect(await page.evaluate(() => window.secondDashboardSync.moved)).toBe(0);
  await expect(page.locator('#solarwind-node')).toHaveCount(1);
  expect(await page.evaluate(() => document.getElementById('solarwind-node') === window.originalSolarwindNode)).toBe(true);
  expect(await page.locator('#solarwind-node').evaluate(node => node.parentElement.id)).toBe('dashboard-solarwind');

  await page.locator('#solarwind-node').click();
  expect(await page.evaluate(() => window.solarwindNodeClicks)).toBe(1);

  await page.evaluate(() => window.dashboardPanelModule.syncDashboardPanelOwnership(false));
  expect(await page.evaluate(() => document.getElementById('solarwind-node') === window.originalSolarwindNode)).toBe(true);
  expect(await page.locator('#solarwind-node').evaluate(node => node.parentElement.dataset.section)).toBe('solarwind');

  await page.locator('#solarwind-node').click();
  expect(await page.evaluate(() => window.solarwindNodeClicks)).toBe(2);
});

test('desktop application keeps one live copy of each dashboard control', async ({ page }) => {
  await isolateApplicationRequests(page);
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('dashboard-solarwind')?.children.length > 0);

  for (const id of panelIds) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  expect(await page.locator('#sw-speed-range').evaluate(node => node.closest('.dashboard-col')?.id)).toBe(
    'dashboard-solarwind'
  );
});
