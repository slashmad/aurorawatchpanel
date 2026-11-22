import { expect, test } from '@playwright/test';

const now = new Date('2026-11-22T14:13:00Z');
const stamp = minutesAgo => new Date(+now - minutesAgo * 60000).toISOString().slice(0, 19);
const bzPoint = minutesAgo => ({ time: stamp(minutesAgo), value: -11 });
const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;

test.use({ viewport: { width: 412, height: 900 }, timezoneId: 'America/New_York' });

async function open(page, options = {}) {
  const requested = [];
  if (options.tickingClock) await page.clock.install({ time: now });
  else await page.clock.setFixedTime(now);
  await page.addInitScript(() => { window.flatpickr = () => {}; });
  if (options.location) await page.addInitScript(loc => {
    Object.entries(loc).forEach(([key, value]) => localStorage.setItem(key, value));
  }, options.location);
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin !== localOrigin) return route.abort();
    if (u.pathname === '/' || u.pathname.startsWith('/static/') || u.pathname.startsWith('/data/')) return route.continue();
    requested.push(u.pathname + u.search);
    if (options.offline?.includes(u.pathname)) return route.fulfill({ status: 503, body: 'unavailable' });
    let json = {};
    if (u.pathname === '/proxy/weather/forecast') json = {
      source: options.source ?? 'SMHI',
      hourly: [{ tid: now.toISOString(), vis: options.vis ?? 26.8, moln: 100, temp: 2, wind: 3 }],
    };
    if (u.pathname.startsWith('/astro/')) json = { sun_altitude: options.sun ?? -5 };
    if (u.pathname === '/solarwind/timeseries') json = {
      data: u.searchParams.get('param') === 'bz' ? options.bz ?? [bzPoint(1), bzPoint(0)] : [],
    };
    if (u.pathname === '/magneto/timeseries_multi') json = {
      data: { LYC: [{ time: stamp(options.age ?? 2), value: options.mag ?? 1 }], ...options.swedish },
    };
    if (u.pathname === '/magneto_fmi/timeseries') json = { data: options.fmi ?? {} };
    if (u.pathname === '/magneto_global/timeseries') json = { data: options.usgs ?? {} };
    if (u.pathname === '/hp30/timeseries') json = { data: [{ timestamp: stamp(30), hp30: options.hp ?? 0 }] };
    if (u.pathname === '/kp/timeseries') json = { data: [{ time: stamp(5), kp: 0 }, { time: stamp(0), kp: 2 }] };
    if (u.pathname === '/images/list' && u.searchParams.get('label') === 'Synoptic Map') {
      const day = (u.searchParams.get('day') || '2026-11-21').replaceAll('-', '');
      json = { files: [`Synoptic/Synoptic_${day}T110000Z.jpg`] };
    }
    if (u.pathname === '/api/replay/day') json = {
      start: '2026-11-22T00:00:00Z', end: '2026-11-22T23:59:59Z',
      allsky: [{ time: '2026-11-22T00:01:00Z', url: '/images/test.jpg' }],
      magnetometer: u.searchParams.get('stations') === 'PEL'
        ? { PEL: [{ time: '2026-11-22T00:00:00Z', value: 52 }] }
        : { KIR: [{ time: '2026-11-22T00:00:00Z', value: -31 }] },
    };
    return route.fulfill({ json });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cond-alert')).toContainText('Nearest station');
  return requested;
}

test('forecast shows its loading message on entry and keeps the last forecast during refresh', async ({ page }) => {
  await open(page, { tickingClock: true });
  const card = page.locator('#cond-alert');
  const feed = '**/magneto_fmi/timeseries?**';
  let release;
  await page.route(feed, async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fallback();
  });
  const firstRequest = page.waitForRequest(feed);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await firstRequest;
  await expect(card.getByRole('status')).toHaveText('Asking the Sun if it feels like sending us a solar storm…');
  await expect(card.getByRole('status')).toBeVisible();
  release();
  await expect(card).toContainText('FMI/IMAGE');
  await expect(card.getByRole('status')).toHaveCount(0);

  const refreshRequest = page.waitForRequest(feed);
  await page.clock.fastForward(60_000);
  await refreshRequest;
  await expect(card).toContainText('FMI/IMAGE');
  await expect(card.getByRole('status')).toHaveCount(0);
  const refreshResponse = page.waitForResponse(feed);
  release();
  await refreshResponse;
});

test('Sävar requests both networks, SMHI kilometres and local twilight in a foreign browser zone', async ({ page }) => {
  const requests = await open(page);
  const feeds = requests.filter(path => path.includes('latest_only=true'));
  expect(feeds.some(path => path.startsWith('/magneto/timeseries_multi?') && path.includes('LYC'))).toBe(true);
  expect(feeds.some(path => path.startsWith('/magneto_fmi/timeseries?') && path.includes('SOD'))).toBe(true);
  await expect(page.locator('#cond-alert')).toContainText('Civil twilight');
  await expect(page.locator('#cond-alert')).toContainText('ΔX 1 nT');
  await expect(page.locator('#weather-card-scroll')).toContainText('26.8 km');
  await expect(page.locator('#cond-alert')).not.toContainText('Low visibility');
  await expect(page.locator('#aurora-headsup')).not.toContainText('Strong southward Bz');
  await expect(page.locator('.kp-tooltip-wrap').locator('..').locator('..').locator('..')).toContainText('1.0');
});

test('ten elapsed minutes of southward Bz, local activity and Hp30 reach the forecast', async ({ page }) => {
  await open(page, { sun: -22, mag: -50, hp: 6, bz: Array.from({ length: 11 }, (_, i) => bzPoint(10-i)) });
  await expect(page.locator('#cond-alert')).toContainText('Regional aurora watch');
  await expect(page.locator('#aurora-headsup')).toContainText('10 min');
  await expect(page.locator('#aurora-headsup')).toContainText('Elevated Hp30: 6');
});

test('a missing minute breaks the alarm and stale local data stays unknown', async ({ page }) => {
  const points = Array.from({ length: 12 }, (_, i) => bzPoint(11-i)).filter((_, i) => i !== 5);
  await open(page, { sun: -22, age: 60, bz: points, mag: 84, source: 'MET Norway', vis: 70 });
  await expect(page.locator('#aurora-headsup')).not.toContainText('Strong southward Bz');
  await expect(page.locator('#cond-alert')).toContainText('no measurement in the last 30 min');
  await expect(page.locator('#cond-alert')).toContainText('last report 60 min ago');
  await expect(page.locator('#cond-alert')).toContainText('Solar wind or planetary indices indicate elevated activity');
  await expect(page.locator('#weather-card-scroll')).toContainText('70%');
  await expect(page.locator('#cond-alert')).toContainText('Low visibility or fog');
});

test('one fresh FMI station raises a regional watch while Lycksele is quiet and solar wind is unavailable', async ({ page }) => {
  await open(page, { sun: -20, mag: 0, fmi: {
    SOD: [{ time: stamp(1), value: -83 }], OUJ: [{ time: stamp(2), value: 0 }],
    KEV: [{ time: stamp(45), value: -250 }],
  }, offline: ['/solarwind/timeseries', '/proxy/weather/forecast'] });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('FMI/IMAGE: 2/13');
  await expect(card).toContainText('1 disturbed');
  await expect(card).toContainText('Lycksele, LYC');
  await expect(card).toContainText('ΔX 0 nT');
  await expect(card).toContainText('Regional aurora watch.');
  await expect(card).toContainText('FMI/IMAGE station SOD');
  await expect(card).toContainText('ΔX -83 nT, 1 min ago');
});

test('FMI is cited first with both networks active and the Swedish network unavailable does not veto it', async ({ page }) => {
  await open(page, { sun: -22, mag: -123, bz: [], fmi: { PEL: [{ time: stamp(1), value: 45 }] } });
  await expect(page.locator('#cond-alert')).toContainText('FMI/IMAGE station PEL');
  await page.route('**/magneto/timeseries_multi?**', r => r.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cond-alert')).toContainText('no measurement in the last 30 min');
  await expect(page.locator('#cond-alert')).toContainText('FMI/IMAGE station PEL');
});

test('Swedish peers can raise the watch when FMI is offline and Lycksele is stale', async ({ page }) => {
  await open(page, { sun: -22, age: 90, bz: [], offline: ['/magneto_fmi/timeseries'],
    swedish: { KIR: [{ time: stamp(1), value: 53 }] } });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('FMI/IMAGE: 0/13');
  await expect(card).toContainText('Swedish network station Kiruna');
  await expect(card).toContainText('Regional aurora watch.');
});

test('stale FMI observations alone do not raise a watch', async ({ page }) => {
  await open(page, { sun: -22, age: 40, bz: [], fmi: { SOD: [{ time: stamp(31), value: -283 }] } });
  await expect(page.locator('#cond-alert')).toContainText('Coverage is incomplete');
  await expect(page.locator('#cond-alert')).not.toContainText('Regional aurora watch.');
});

test('visible forecast refreshes after a minute and ages out the last good FMI reading during a feed outage', async ({ page }) => {
  await open(page, { tickingClock: true, sun: -23, bz: [], fmi: { HAN: [{ time: stamp(1), value: 95 }] } });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('FMI/IMAGE station HAN');
  await page.route('**/magneto_fmi/timeseries?**', r => r.abort());
  await page.clock.fastForward(60_000);
  await expect(card).toContainText('Latest update unavailable from FMI/IMAGE');
  await expect(card).toContainText('ΔX 95 nT, 2 min ago');
  await page.clock.fastForward(30 * 60_000);
  await expect(card).toContainText('FMI/IMAGE: 0/13');
  await expect(card).not.toContainText('Regional aurora watch.');
});

test('in Alaska a different reporting USGS station can supply the regional signal', async ({ page }) => {
  const requests = await open(page, { sun: -23, bz: [], location: { lat: '64.87', lon: '-147.86', tz: 'America/Anchorage' },
    usgs: { BRW: [{ time: stamp(1), value: 80 }] } });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('College, CMO');
  await expect(card).toContainText('USGS station Utqiagvik');
  expect(requests.some(path => path.startsWith('/magneto_fmi/timeseries'))).toBe(false);
});

test('positive solar altitude during midnight sun gives the daylight message', async ({ page }) => {
  await open(page, { sun: 12 });
  await expect(page.locator('#cond-alert')).toContainText('sky is too bright');
});

test('Synoptic quicklink opens the newest available UTC day and browses another date', async ({ page }) => {
  const requests = await open(page);
  await page.locator('[data-quicklink="synoptic"]').click();
  await expect(page.locator('#synoptic-date')).toHaveValue('2026-11-21');
  await expect(page.locator('#synoptic-image')).toHaveAttribute('src', /20261121T110000Z/);
  await page.locator('#synoptic-date').fill('2026-10-15');
  await expect(page.locator('#synoptic-image')).toHaveAttribute('src', /20261015T110000Z/);
  expect(requests.some(path => path.includes('limit=1') && path.includes('Synoptic'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#synoptic-overlay')).toBeHidden();
});

test('Replay clears the frame during a gap and restores it on returning', async ({ page }) => {
  await open(page);
  await page.locator('.allsky-replay-btn').click();
  await page.locator('#replay-load').click();
  const img = page.locator('#replay-allsky-img');
  await expect(img).toHaveAttribute('src', '/images/test.jpg');
  await expect(page.locator('#replay-mag-irf-current')).toContainText('KIR');
  await page.locator('#replay-station').selectOption('PEL');
  await page.locator('#replay-load').click();
  await expect(page.locator('#replay-mag-fmi-current')).toContainText('PEL');
  await expect(page.locator('#replay-mag-irf-current')).toBeEmpty();
  await page.locator('#replay-slider').fill('600');
  await expect(img).not.toHaveAttribute('src', /.+/);
  await page.locator('#replay-slider').fill('1');
  await expect(img).toHaveAttribute('src', '/images/test.jpg');
});

const disturbedFmi = { SOD: [{ time: stamp(1), value: -83 }], OUJ: [{ time: stamp(2), value: 0 }] };

test('one disturbed FMI station in the dark shows an aurora watch badge, advice and tab title', async ({ page }) => {
  await open(page, { sun: -20, mag: 0, fmi: disturbedFmi, offline: ['/solarwind/timeseries', '/proxy/weather/forecast'] });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('Aurora watch for this location');
  await expect(card.locator('.aurora-level-badge')).toHaveText('AURORA WATCH');
  await expect(card.locator('.aurora-action')).toContainText('Look north');
  await expect(card).toContainText('Regional aurora watch.');
  await expect(page).toHaveTitle('● Aurora watch – Aurora Watch Panel');
});

test('a disturbance with southward Bz under a cloudy forecast is an alert that still says to look', async ({ page }) => {
  const bz = [{ time: stamp(1), value: -6 }, { time: stamp(0), value: -6 }];
  await open(page, { sun: -22, mag: 0, fmi: disturbedFmi, bz });
  const card = page.locator('#cond-alert');
  await expect(card.locator('.aurora-level-badge')).toHaveText('AURORA ALERT');
  await expect(card).toContainText('Aurora alert for this location');
  await expect(card.locator('.aurora-action')).toContainText('breaks can still reveal aurora');
  await expect(card).toContainText('Solar wind or planetary indices also favor aurora.');
  await expect(page).toHaveTitle('● Aurora alert – Aurora Watch Panel');
});

test('no alert badge in civil twilight even with a disturbance', async ({ page }) => {
  await open(page, { sun: -5, mag: 0, fmi: disturbedFmi, offline: ['/solarwind/timeseries'] });
  const card = page.locator('#cond-alert');
  await expect(card).toContainText('Civil twilight');
  await expect(card.locator('.aurora-level-badge')).toHaveCount(0);
  await expect(page).toHaveTitle('Aurora Watch Panel');
});
