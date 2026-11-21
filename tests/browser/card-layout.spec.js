import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;
const STORAGE_KEY = 'aurora.layout.v1';
const DEFAULT = {
  location: ['sunmoon', 'weather', 'kp-gauges', 'aurora-oval', 'forecast', 'allsky', 'coronal-hole', 'sunspots'],
  solarwind: ['sw-speed', 'sw-density', 'sw-bt', 'sw-bz', 'sw-by'],
  magnetometer: ['mag-irf', 'mag-fmi', 'mag-global'],
  solar: ['solar-images'],
};

async function openDashboard(page, { width = 1440, layout, beforeLoad } = {}) {
  await page.addInitScript(([key, value]) => {
    window.Highcharts = { setOptions() {}, chart() { return { destroy() {}, series: [] }; }, charts: [] };
    window.flatpickr = () => {};
    if (value !== undefined && !sessionStorage.getItem('layout-seeded')) {
      localStorage.setItem(key, value);
      sessionStorage.setItem('layout-seeded', '1');
    }
  }, [STORAGE_KEY, layout === undefined ? undefined : (typeof layout === 'string' ? layout : JSON.stringify(layout))]);
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === localOrigin) requests.push(url.pathname + url.search);
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const asset = url.origin === localOrigin && (url.pathname === '/' || /^\/(static|svg|data)\//.test(url.pathname)) && !url.pathname.startsWith('/static/vendor/');
    if (request.resourceType() === 'document' || asset) await route.continue();
    else if (url.origin === localOrigin) await route.fulfill({ json: {} });
    else await route.abort();
  });
  if (beforeLoad) await beforeLoad(page); // registered last, so it takes precedence
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  return requests;
}

const placement = page => page.evaluate(() => {
  const out = {};
  for (const section of ['location', 'solarwind', 'magnetometer', 'solar']) {
    const column = document.getElementById(`dashboard-${section}`);
    const container = window.matchMedia('(min-width: 1350px)').matches
      ? column : document.querySelector(`.tab-panel[data-section="${section}"]`);
    out[section] = [...container.children].filter(el => el.dataset.card).map(el => el.dataset.card);
  }
  return out;
});
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), STORAGE_KEY);
const card = (page, id) => page.locator(`[data-card="${id}"]`);

test('every dashboard card gets move and collapse controls in its default place', async ({ page }) => {
  await openDashboard(page);
  expect(await placement(page)).toEqual(DEFAULT);
  await expect(page.locator('[data-card] .card-controls')).toHaveCount(17);
  await expect(page.locator('[data-card] .card-controls .card-move-handle')).toHaveCount(17);
});

test('collapsing hides the content, persists, and pauses the card until expanded', async ({ page }) => {
  let requests = await openDashboard(page);
  await card(page, 'sw-speed').locator('.card-collapse-btn').click();
  await expect(card(page, 'sw-speed')).toHaveClass(/is-collapsed/);
  await expect(card(page, 'sw-speed').locator('#sw-speed-chart')).toBeHidden();
  await expect(card(page, 'sw-speed').locator('.card-head-row')).toBeVisible();
  expect((await saved(page)).collapsed).toEqual(['sw-speed']);

  requests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await expect(card(page, 'sw-speed')).toHaveClass(/is-collapsed/);
  const panelSpeed = () => requests.filter(r => r.startsWith('/solarwind/timeseries?param=speed&hours=3'));
  expect(panelSpeed()).toHaveLength(0);
  expect(requests.filter(r => /\/solarwind\/timeseries\?param=(density|bt|bz|by)&hours=3/.test(r))).toHaveLength(4);

  await card(page, 'sw-speed').locator('.card-collapse-btn').click();
  await expect(card(page, 'sw-speed')).not.toHaveClass(/is-collapsed/);
  await expect.poll(() => panelSpeed().length).toBe(1);
  expect((await saved(page)).collapsed).toEqual([]);
});

test('a collapsed location card loads nothing at startup and loads on expand', async ({ page }) => {
  const requests = await openDashboard(page, {
    layout: { sections: DEFAULT, collapsed: ['allsky', 'kp-gauges'] },
  });
  expect(requests.filter(r => r.startsWith('/api/allsky/latest'))).toHaveLength(0);
  expect(requests.filter(r => r.startsWith('/kp/timeseries?hours=12'))).toHaveLength(1); // forecast still needs it
  await card(page, 'allsky').locator('.card-collapse-btn').click();
  await expect.poll(() => requests.filter(r => r.startsWith('/api/allsky/latest')).length).toBe(1);
});

test('keyboard moves a card within and between desktop columns and the order is kept', async ({ page }) => {
  await openDashboard(page);
  const handle = card(page, 'allsky').locator('.card-move-handle');
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  expect((await placement(page)).location.slice(3, 6)).toEqual(['aurora-oval', 'allsky', 'forecast']);
  await page.keyboard.press('ArrowRight');
  let p = await placement(page);
  expect(p.location).not.toContain('allsky');
  expect(p.solarwind.at(-1)).toBe('allsky');
  expect((await saved(page)).sections.solarwind.at(-1)).toBe('allsky');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  p = await placement(page);
  expect(p.solarwind.at(-1)).toBe('allsky');
  expect(p.location).not.toContain('allsky');
});

test('dragging with the pointer moves a card to another column', async ({ page }) => {
  await openDashboard(page);
  const handle = card(page, 'sunspots').locator('.card-move-handle');
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const target = await card(page, 'mag-irf').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 40, target.y + 5, { steps: 12 });
  await expect(page.locator('.card-placeholder')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.card-placeholder')).toHaveCount(0);
  const p = await placement(page);
  expect(p.magnetometer[0]).toBe('sunspots');
  expect(p.location).not.toContain('sunspots');
  await expect(card(page, 'sunspots')).not.toHaveClass(/is-dragging/);
  expect((await saved(page)).sections.magnetometer[0]).toBe('sunspots');
});

test('on narrow screens a moved card belongs to its new tab and starts there', async ({ page }) => {
  const layout = {
    sections: { ...DEFAULT, location: [...DEFAULT.location, 'mag-fmi'], magnetometer: ['mag-irf', 'mag-global'] },
    collapsed: [],
  };
  const requests = await openDashboard(page, { width: 412, layout });
  expect((await placement(page)).location.at(-1)).toBe('mag-fmi');
  // The location tab is visible, so the magnetometer group starts for the FMI card.
  await expect.poll(() => requests.filter(r => r.startsWith('/magneto_fmi/timeseries') && r.includes('hours=3')).length).toBe(1);
});

test('reset restores the default order and expands every card', async ({ page }) => {
  await openDashboard(page, {
    layout: { sections: { ...DEFAULT, location: DEFAULT.location.slice().reverse() }, collapsed: ['weather', 'mag-fmi'] },
  });
  expect((await placement(page)).location[0]).toBe('sunspots');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reset-layout-btn').click();
  expect(await placement(page)).toEqual(DEFAULT);
  await expect(page.locator('[data-card].is-collapsed')).toHaveCount(0);
  expect(await saved(page)).toBeNull();
});

test('a corrupt or outdated saved layout falls back without breaking the page', async ({ page }) => {
  await openDashboard(page, {
    layout: { sections: { location: ['nope', 'weather', 'sunmoon'], solarwind: 'bad' }, collapsed: ['ghost'] },
  });
  const p = await placement(page);
  expect(p.location.slice(0, 2)).toEqual(['weather', 'sunmoon']);
  expect([...p.location].sort()).toEqual([...DEFAULT.location].sort());
  expect(p.solarwind).toEqual(DEFAULT.solarwind);
  await expect(page.locator('[data-card]')).toHaveCount(17);

  await page.evaluate(key => localStorage.setItem(key, '{not json'), STORAGE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  expect(await placement(page)).toEqual(DEFAULT);
});

test('controls survive a panel rewriting its header or card markup', async ({ page }) => {
  await openDashboard(page);
  await expect(card(page, 'weather').locator('.card-controls')).toHaveCount(1);
  await page.evaluate(() => {
    const head = document.querySelector('[data-card="sw-bt"] .card-head-row');
    head.innerHTML = '<span>Bt rewritten</span>';
    const kp = document.querySelector('[data-card="coronal-hole"]');
    kp.innerHTML = '<div class="card-header">Rebuilt</div><div>body</div>';
  });
  await expect(card(page, 'sw-bt').locator('.card-controls')).toHaveCount(1);
  await expect(card(page, 'coronal-hole').locator('.card-controls')).toHaveCount(1);
  await card(page, 'coronal-hole').locator('.card-collapse-btn').click();
  await expect(card(page, 'coronal-hole')).toHaveClass(/is-collapsed/);
  await expect(card(page, 'coronal-hole').getByText('body')).toBeHidden();
});

test('controls sit in the header row, also when the header is nested in a wrapper', async ({ page }) => {
  await openDashboard(page);
  for (const id of ['kp-gauges', 'aurora-oval', 'forecast', 'allsky', 'sw-speed', 'mag-fmi', 'solar-images']) {
    const inHeader = await card(page, id).evaluate(el => el.querySelector('.card-controls').parentElement.classList.contains('card-header'));
    expect(inHeader, id).toBe(true);
  }
  // Two headers side by side: corner placement.
  await expect(card(page, 'sunmoon').locator(':scope > .card-controls.card-controls-corner')).toHaveCount(1);

  for (const id of ['kp-gauges', 'allsky']) {
    await card(page, id).locator('.card-collapse-btn').click();
    await expect(card(page, id).locator('.card-head-row')).toBeVisible();
    await expect(card(page, id).locator('.card-controls')).toBeVisible();
    const visibleBody = await card(page, id).evaluate(el => {
      const head = el.querySelector('.card-head-row');
      return [...el.querySelectorAll('*')].filter(n => n.offsetParent !== null && !head.contains(n) && !n.contains(head)).length;
    });
    expect(visibleBody, id).toBe(0);
  }
  await expect(page.locator('#double-gauge')).toBeHidden();
});

test('a collapsed forecast does not stop the sun & moon box from updating', async ({ page }) => {
  await openDashboard(page, {
    layout: { sections: DEFAULT, collapsed: ['forecast'] },
    beforeLoad: p => p.route(/\/astro\/(sun|moon)\?/, route => route.fulfill({
      json: route.request().url().includes('/astro/sun')
        ? { sunrise: '08:26', sunset: '14:19', sun_altitude: -30 }
        : { moon_phase: 89, moon_phase_label: 'Waxing Gibbous', is_waxing: true, moon_altitude: 36.5, next_fullmoon: '2026-11-24' },
    })),
  });
  await expect(page.locator('#sunrise-info')).toHaveText('08:26');
  await expect(page.locator('#next-fullmoon-info')).toHaveText('2026-11-24');
});

test('the support tab shows the funding links without loading anything', async ({ page }) => {
  const requests = await openDashboard(page);
  requests.length = 0;
  await page.locator('.leftbar-btn[data-section="support"]').click();
  await expect(page.locator('.tab-panel[data-section="support"]')).toBeVisible();
  const links = await page.locator('.support-link').evaluateAll(els => els.map(a => [a.getAttribute('href'), a.target, a.rel]));
  expect(links).toEqual([
    ['https://github.com/sponsors/slashmad', '_blank', 'noopener noreferrer'],
    ['https://ko-fi.com/slashmad', '_blank', 'noopener noreferrer'],
    ['https://liberapay.com/slashmad/', '_blank', 'noopener noreferrer'],
  ]);
  await page.waitForTimeout(200);
  expect(requests).toEqual([]);
  await expect(page.locator('#dashboard-multipanel')).toBeHidden();
  await page.locator('.leftbar-btn[data-section="location"]').click();
  await expect(page.locator('#dashboard-multipanel')).toBeVisible();
});
