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

test('shared fetch coalesces identical requests and isolates callers', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const calls = [];
    let fail = false;
    window.fetch = async url => {
      calls.push(url);
      if (fail) return new Response('not json', { status: 500 });
      return new Response(JSON.stringify({ data: [{ v: 1 }] }), { status: 200 });
    };
    const { fetchShared } = await import('/static/js/shared_fetch.js');
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;

    const [a, b] = await Promise.all([
      fetchShared('/kp/timeseries?hours=12&_=1'),
      fetchShared('/kp/timeseries?_=2&hours=12'),
    ]);
    const ja = await a.json();
    const jb = await b.json();
    ja.data[0].v = 99;
    const isolated = jb.data[0].v === 1;
    const afterBurst = calls.length;

    await fetchShared('/kp/timeseries?hours=3');
    const differentQuery = calls.length;

    t += 25_000;
    await fetchShared('/kp/timeseries?hours=12');
    const afterExpiry = calls.length;

    fail = true;
    let firstError = null;
    try { await (await fetchShared('/aurora/flags')).json(); } catch (err) { firstError = err.name; }
    fail = false;
    const retried = await (await fetchShared('/aurora/flags')).json();
    Date.now = realNow;
    return { afterBurst, isolated, differentQuery, afterExpiry, firstError, retriedOk: retried.data[0].v === 1, total: calls.length };
  });
  expect(result).toEqual({
    afterBurst: 1, isolated: true, differentQuery: 2, afterExpiry: 3, firstError: 'SyntaxError', retriedOk: true, total: 5,
  });
});

async function startDashboard(page, width) {
  await page.addInitScript(() => {
    window.Highcharts = { setOptions() {}, chart() { return { destroy() {}, series: [] }; }, charts: [] };
    window.flatpickr = () => {};
  });
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    requests.push(url.origin === localOrigin ? url.pathname : url.host + url.pathname);
  });
  await isolateApplicationRequests(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  return requests;
}

const SECTION_REQUESTS = {
  solarwind: path => path.startsWith('/solarwind/timeseries'),
  magnetometer: path => ['/magneto/timeseries_multi', '/magneto_fmi/timeseries', '/magneto_global/timeseries'].includes(path),
  noaa: path => path.startsWith('services.swpc.noaa.gov/json/solar-cycle/'),
};
const forecastSolarwind = 5; // aurora_forecast always reads 12 h solar wind for the location panel
const forecastMagnetometer = 2; // ... and the latest KIR + FMI values

test('narrow screens load hidden sections only when their tab is opened', async ({ page }) => {
  const requests = await startDashboard(page, 412);
  expect(requests.filter(SECTION_REQUESTS.solarwind)).toHaveLength(forecastSolarwind);
  expect(requests.filter(SECTION_REQUESTS.magnetometer)).toHaveLength(forecastMagnetometer);
  expect(requests.filter(SECTION_REQUESTS.noaa)).toHaveLength(0);

  for (const [section, expected] of [['solarwind', 5], ['magnetometer', 3], ['noaa', 2]]) {
    requests.length = 0;
    await page.locator(`.leftbar-btn[data-section="${section}"]`).click();
    await expect.poll(() => requests.filter(SECTION_REQUESTS[section]).length).toBe(expected);
  }

  // Returning to a started tab does not start it again.
  await page.locator('.leftbar-btn[data-section="location"]').click();
  requests.length = 0;
  await page.locator('.leftbar-btn[data-section="noaa"]').click();
  await page.waitForTimeout(200);
  expect(requests.filter(SECTION_REQUESTS.noaa)).toHaveLength(0);
});

test('desktop starts visible columns immediately but defers the NOAA tab', async ({ page }) => {
  const requests = await startDashboard(page, 1440);
  expect(requests.filter(SECTION_REQUESTS.solarwind)).toHaveLength(forecastSolarwind + 5);
  expect(requests.filter(SECTION_REQUESTS.magnetometer)).toHaveLength(forecastMagnetometer + 3);
  expect(requests.filter(SECTION_REQUESTS.noaa)).toHaveLength(0);

  requests.length = 0;
  await page.locator('.leftbar-btn[data-section="noaa"]').click();
  await expect.poll(() => requests.filter(SECTION_REQUESTS.noaa).length).toBe(2);
});

test('growing a narrow window to desktop starts the dashboard columns', async ({ page }) => {
  const requests = await startDashboard(page, 900);
  requests.length = 0;
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => requests.filter(SECTION_REQUESTS.solarwind).length).toBe(5);
  await expect.poll(() => requests.filter(SECTION_REQUESTS.magnetometer).length).toBe(3);
});

test('narrow screens load solar image lists only when the solar tab opens, once', async ({ page }) => {
  const lists = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/images/list') lists.push(url.searchParams.get('label'));
  });
  await startDashboard(page, 412);
  expect(lists).toEqual([]);
  await page.locator('.leftbar-btn[data-section="solar"]').click();
  await expect.poll(() => lists.length).toBe(7);
  await page.waitForTimeout(300);
  expect(new Set(lists).size).toBe(7);
  expect(lists).toHaveLength(7);
});

test('a missing chart library shows error codes in chart sections and the rest still loads', async ({ page }) => {
  // No Highcharts stub: the CDN is unreachable, as when browsing via a bare IP.
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === localOrigin) requests.push(url.pathname);
  });
  await isolateApplicationRequests(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });

  for (const code of ['E-SOLARWIND', 'E-MAGNETOMETER', 'E-KP']) {
    await expect(page.locator(`.section-error[data-code="${code}"]`)).toHaveCount(1);
    await expect(page.locator(`.section-error[data-code="${code}"]`)).toContainText('Highcharts');
  }
  await expect(page.locator('[data-card="sw-speed"] > .section-error')).toHaveCount(1);
  await expect(page.locator('[data-card="mag-irf"] > .section-error')).toHaveCount(1);
  await expect(page.locator('#double-gauge-card > .section-error')).toHaveCount(1);
  // Sections that do not need charts started normally.
  await expect.poll(() => requests.filter(p => p === '/images/list').length).toBe(7);
  await expect.poll(() => requests.includes('/api/allsky/latest')).toBe(true);
  await expect.poll(() => requests.includes('/api/coronal_holes')).toBe(true);
  await expect(page.locator('.section-error[data-code="E-SOLAR"]')).toHaveCount(0);
});

test('section errors are shown per code and cleared on the next success', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    document.body.innerHTML = '<div id="card"><p>content</p></div>';
    const { runSection } = await import('/static/js/section_errors.js');
    await runSection('E-ONE', '#card', () => { throw new Error('boom <b>'); });
    await runSection('E-TWO', '#card', async () => { throw new Error('later'); });
    const afterFailures = [...document.querySelectorAll('#card > .section-error')].map(e => e.textContent);
    const htmlSafe = document.querySelector('#card b') === null;
    const value = await runSection('E-ONE', '#card', () => 42);
    const afterSuccess = [...document.querySelectorAll('#card > .section-error')].map(e => e.dataset.code);
    return { afterFailures, htmlSafe, value, afterSuccess };
  });
  expect(result).toEqual({
    afterFailures: ['⚠ E-TWO: later', '⚠ E-ONE: boom <b>'],
    htmlSafe: true,
    value: 42,
    afterSuccess: ['E-TWO'],
  });
});
