import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;
const expectedImageLabels = [
  'SDO/AIA 131',
  'SDO/AIA 171',
  'SDO/AIA 193',
  'SDO/AIA 211',
  'SDO/AIA 304',
  'SDO/AIA HMIIF',
  'Synoptic Map',
];

async function isolateApplicationRequests(page) {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const isLocalAsset = url.origin === localOrigin && (
      url.pathname === '/' ||
      (url.pathname.startsWith('/static/') && !url.pathname.startsWith('/static/vendor/')) || // vendor: Highcharts is stubbed
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

function panelRefreshRequests(requests) {
  return requests.filter(path =>
    path.startsWith('/solarwind/timeseries?param=') ||
    path.startsWith('/magneto/timeseries_multi?') ||
    path.startsWith('/magneto_fmi/timeseries?') ||
    path.startsWith('/magneto_global/timeseries?') ||
    path.startsWith('/magneto_uit/timeseries?')
  );
}

test('desktop navigation uses imported refresh owners and resize stays network-silent', async ({ page }) => {
  await page.addInitScript(() => {
    window.Highcharts = {
      setOptions() {},
      chart() {
        return { destroy() {}, series: [] };
      },
    };
    window.flatpickr = () => {};
  });

  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === localOrigin) requests.push(`${url.pathname}${url.search}`);
  });

  await isolateApplicationRequests(page);
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.leftbar-btn[data-section="location"]')).toHaveClass(/active/);
  await page.waitForLoadState('networkidle');

  expect(await page.evaluate(() => [
    typeof window.setupSolarwind,
    typeof window.setupMagnetometer,
    typeof window.setupMagnetometerUIT,
    typeof window.setupMagnetometerFMI,
    typeof window.setupMagnetometerGlobal,
  ])).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);

  requests.length = 0;
  await page.locator('.leftbar-btn[data-section="solarwind"]').click();
  await expect(page.locator('#dashboard-solarwind')).toBeVisible();
  await expect.poll(() => panelRefreshRequests(requests)).toHaveLength(5);
  expect(panelRefreshRequests(requests).every(path => path.startsWith('/solarwind/timeseries?param='))).toBe(true);

  requests.length = 0;
  await page.locator('.leftbar-btn[data-section="magnetometer"]').click();
  await expect(page.locator('#dashboard-magnetometer')).toBeVisible();
  await expect.poll(() => panelRefreshRequests(requests)).toHaveLength(3);
  expect(panelRefreshRequests(requests).map(path => path.split('?')[0]).sort()).toEqual([
    '/magneto/timeseries_multi',
    '/magneto_fmi/timeseries',
    '/magneto_global/timeseries',
  ]);

  requests.length = 0;
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(page.locator('.tab-panel[data-section="magnetometer"]')).toHaveClass(/active/);
  await page.waitForTimeout(100);
  expect(panelRefreshRequests(requests)).toEqual([]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#dashboard-magnetometer')).toBeVisible();
  await page.waitForTimeout(100);
  expect(panelRefreshRequests(requests)).toEqual([]);
});

test('navigation binds before unavailable chart dependencies can abort startup', async ({ page }) => {
  const imageListLabels = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/images/list') imageListLabels.push(url.searchParams.get('label'));
  });

  await isolateApplicationRequests(page);
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.leftbar-btn[data-section="location"]')).toHaveClass(/active/);
  // The solar column is visible on desktop, so it loads at startup even though
  // the chart library failed and other sections could not start.
  await expect.poll(() => imageListLabels.length).toBe(expectedImageLabels.length);
  expect([...imageListLabels].sort()).toEqual([...expectedImageLabels].sort());

  imageListLabels.length = 0;
  await page.locator('.leftbar-btn[data-section="solar"]').click();
  await expect(page.locator('.leftbar-btn[data-section="solar"]')).toHaveClass(/active/);
  await expect(page.locator('#dashboard-solar')).toBeVisible();
  await expect.poll(() => imageListLabels.length).toBe(expectedImageLabels.length);
  expect([...imageListLabels].sort()).toEqual([...expectedImageLabels].sort());
});
