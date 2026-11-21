import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;

async function isolateApplicationRequests(page) {
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const isLocalAsset = url.origin === localOrigin && (
      url.pathname === '/' ||
      url.pathname.startsWith('/static/') ||
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

test('resizing never reloads; only crossing the desktop breakpoint moves panels', async ({ page }) => {
  await page.addInitScript(() => {
    window.Highcharts = { setOptions() {}, chart() { return { destroy() {}, series: [] }; } };
    window.flatpickr = () => {};
  });
  let documentLoads = 0;
  page.on('request', request => {
    if (request.resourceType() === 'document') documentLoads += 1;
  });
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === localOrigin) requests.push(`${request.method()} ${url.pathname}`);
  });

  await isolateApplicationRequests(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    window.__weatherNode = document.getElementById('weather-card-container');
    window.__moves = 0;
    new MutationObserver(records => {
      window.__moves += records.reduce((n, r) => n + r.addedNodes.length, 0);
    }).observe(document.getElementById('dashboard-multipanel'), { childList: true, subtree: true });
  });
  const parentOfWeather = () => page.evaluate(() => {
    const node = document.getElementById('weather-card-container');
    const owner = node.parentElement.closest('#dashboard-location, .tab-panel');
    return { same: node === window.__weatherNode, parent: owner.id || `tab:${owner.dataset.section}` };
  });
  expect(await parentOfWeather()).toEqual({ same: true, parent: 'dashboard-location' });

  requests.length = 0;
  for (const width of [1500, 1380, 1600, 1351, 1440]) {
    await page.setViewportSize({ width, height: 900 });
  }
  await page.waitForTimeout(200);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => window.__moves)).toBe(0);
  expect(await parentOfWeather()).toEqual({ same: true, parent: 'dashboard-location' });

  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(async () => (await parentOfWeather()).parent).toBe('tab:location');
  expect((await parentOfWeather()).same).toBe(true);
  for (const width of [1100, 1300, 900]) {
    await page.setViewportSize({ width, height: 900 });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await parentOfWeather()).parent).toBe('dashboard-location');
  await page.waitForTimeout(200);

  expect(requests).toEqual([]);
  expect((await parentOfWeather()).same).toBe(true);
  expect(documentLoads).toBe(1);
  expect(await page.locator('head script:not([src])').evaluateAll(
    scripts => scripts.some(s => s.textContent.includes('location.reload')),
  )).toBe(false);
});

async function startFreshness(page, overrides = '{}') {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async rawOverrides => {
    window.__t = Date.UTC(2026, 10, 21, 12, 0, 0);
    window.__hidden = false;
    window.__etag = '"build-1"';
    window.__calls = { data: 0, daily: 0, reload: 0, head: 0 };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.fetch = async (url, init = {}) => {
      if (init.method === 'HEAD') window.__calls.head += 1;
      return new Response(null, { status: 200, headers: { etag: window.__etag } });
    };
    const { setupPageFreshness } = await import('/static/js/page_freshness.js');
    window.__freshness = setupPageFreshness({
      refreshData: async () => { window.__calls.data += 1; },
      refreshDaily: async () => { window.__calls.daily += 1; },
      reload: () => { window.__calls.reload += 1; },
      now: () => window.__t,
      options: { tickMs: 10 ** 9, ...JSON.parse(rawOverrides) },
    });
    await window.__freshness.ready;
  }, overrides);
}

const MIN = 60_000;
const advance = (page, ms) => page.evaluate(ms => { window.__t += ms; }, ms);
const tick = page => page.evaluate(() => window.__freshness.tick());
const calls = page => page.evaluate(() => ({ ...window.__calls }));
const setHidden = (page, hidden) => page.evaluate(hidden => {
  window.__hidden = hidden;
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const interact = page => page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown')));

test('freshness refreshes data in place on a timer, only while visible', async ({ page }) => {
  await startFreshness(page);
  await advance(page, 14 * MIN); await tick(page);
  expect((await calls(page)).data).toBe(0);
  await advance(page, 2 * MIN); await tick(page);
  expect((await calls(page)).data).toBe(1);

  await setHidden(page, true);
  await advance(page, 30 * MIN); await tick(page);
  expect((await calls(page)).data).toBe(1);

  await setHidden(page, false);
  await expect.poll(async () => (await calls(page)).data).toBe(2);
  expect((await calls(page)).reload).toBe(0);
});

test('returning to a recently refreshed tab does not refetch', async ({ page }) => {
  await startFreshness(page);
  await setHidden(page, true);
  await advance(page, 5 * MIN);
  await setHidden(page, false);
  await page.waitForTimeout(50);
  expect((await calls(page)).data).toBe(0);
});

test('a new deploy reloads only when hidden or idle, never during use', async ({ page }) => {
  await startFreshness(page);
  expect((await calls(page)).head).toBe(1);

  await page.evaluate(() => { window.__etag = '"build-2"'; });
  await advance(page, 9 * MIN); await interact(page);
  await advance(page, 1 * MIN); await tick(page);
  expect((await calls(page)).head).toBe(2);
  expect((await calls(page)).reload).toBe(0);

  await advance(page, 5 * MIN); await interact(page); await tick(page);
  expect((await calls(page)).reload).toBe(0);

  await setHidden(page, true);
  expect((await calls(page)).reload).toBe(1);
});

test('a new deploy reloads a visible but idle page (wall display)', async ({ page }) => {
  await startFreshness(page);
  await page.evaluate(() => { window.__etag = '"build-2"'; });
  await advance(page, 10 * MIN); await tick(page);
  expect((await calls(page)).reload).toBe(1);
});

test('an unchanged build never reloads', async ({ page }) => {
  await startFreshness(page);
  for (let i = 0; i < 6; i += 1) {
    await advance(page, 10 * MIN); await tick(page);
  }
  await setHidden(page, true);
  expect((await calls(page)).reload).toBe(0);
  expect((await calls(page)).head).toBe(7);
});

test('day-based cards refresh after local midnight only once idle', async ({ page }) => {
  await startFreshness(page);
  await page.evaluate(() => {
    const d = new Date(window.__t);
    d.setHours(23, 58, 0, 0);
    window.__t = d.getTime();
  });
  await interact(page);
  await advance(page, 5 * MIN); await tick(page);
  expect((await calls(page)).daily).toBe(0);
  await advance(page, 6 * MIN); await tick(page);
  expect((await calls(page)).daily).toBe(1);
  await advance(page, 1 * MIN); await tick(page);
  expect((await calls(page)).daily).toBe(1);
});

test('redrawing the Kp/HP30 gauges does not leak the previous charts', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    // Minimal Highcharts double: same-element reuse destroys, like the real library.
    const charts = [];
    window.Highcharts = {
      charts,
      chart(id) {
        const renderTo = typeof id === 'string' ? document.getElementById(id) : id;
        const previous = charts.findIndex(c => c && c.renderTo === renderTo);
        if (previous >= 0) charts[previous].destroy();
        const chart = { renderTo, destroy() { charts[charts.indexOf(this)] = undefined; } };
        charts.push(chart);
        return chart;
      },
    };
    document.body.innerHTML = '<div id="double-gauge"></div>';
    const { drawDoubleGauge } = await import('/static/js/gauge_double.js');
    for (let i = 0; i < 12; i += 1) drawDoubleGauge('double-gauge', 3, 4, null, null, null, null, null, null, null, null);
    const alive = charts.filter(Boolean);
    return { alive: alive.length, detached: alive.filter(c => !document.contains(c.renderTo)).length };
  });
  expect(result).toEqual({ alive: 2, detached: 0 });
});
