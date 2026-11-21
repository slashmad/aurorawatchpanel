import { expect, test } from '@playwright/test';

const solarwindParams = ['speed', 'density', 'bt', 'bz', 'by'];

test('repeated solarwind setup keeps one timer and one listener per control', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async params => {
    document.body.innerHTML = params
      .map(param => `<select id="sw-${param}-range"><option value="3" selected>3</option></select>`)
      .join('');

    window.Highcharts = { setOptions() {} };
    window.solarwindFetchCount = 0;
    window.fetch = async () => {
      window.solarwindFetchCount += 1;
      return { json: async () => ({ data: [] }) };
    };

    window.solarwindIntervals = [];
    window.setInterval = (callback, delay) => {
      window.solarwindIntervals.push({ callback, delay });
      return window.solarwindIntervals.length;
    };

    const { setupSolarwind } = await import(`/static/js/solarwind.js?test=${Date.now()}`);
    setupSolarwind();
    setupSolarwind();
    setupSolarwind();
  }, solarwindParams);

  await expect.poll(() => page.evaluate(() => window.solarwindFetchCount)).toBe(15);
  expect(await page.evaluate(() => window.solarwindIntervals.map(({ delay }) => delay))).toEqual([60_000]);

  await page.evaluate(() => {
    window.solarwindFetchCount = 0;
    document.getElementById('sw-speed-range').dispatchEvent(new Event('change'));
  });

  await expect.poll(() => page.evaluate(() => window.solarwindFetchCount)).toBe(1);
});
