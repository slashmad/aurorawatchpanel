import { expect, test } from '@playwright/test';

test('repeated magnetometer setup keeps one timer and one listener per control', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    document.body.innerHTML = `
      <select id="mag-kiruna-range"><option value="6" selected>6</option></select>
      <select id="mag-kiruna-component"><option value="x" selected>x</option></select>
      <div id="magneto-chart"></div>
      <span id="mag-kiruna-current"></span>
      <span id="mag-kiruna-kindex"></span>
    `;

    window.Highcharts = {
      setOptions() {},
      chart() {
        return { destroy() {} };
      },
    };

    window.magnetometerFetchCount = 0;
    window.fetch = async url => {
      window.magnetometerFetchCount += 1;
      const data = String(url).startsWith('/kindex/')
        ? { KIR: [] }
        : { ABK: [], KIR: [], LYC: [], UPS: [], TOP: [] };
      return { json: async () => ({ data }) };
    };

    window.magnetometerIntervals = [];
    window.setInterval = (callback, delay) => {
      window.magnetometerIntervals.push({ callback, delay });
      return window.magnetometerIntervals.length;
    };

    const { setupMagnetometer } = await import(`/static/js/magnetometer.js?test=${Date.now()}`);
    setupMagnetometer();
    setupMagnetometer();
    setupMagnetometer();
  });

  await expect.poll(() => page.evaluate(() => window.magnetometerFetchCount)).toBe(6);
  expect(await page.evaluate(() => window.magnetometerIntervals.map(({ delay }) => delay))).toEqual([60_000]);

  await page.evaluate(() => {
    window.magnetometerFetchCount = 0;
    document.getElementById('mag-kiruna-range').dispatchEvent(new Event('change'));
  });

  await expect.poll(() => page.evaluate(() => window.magnetometerFetchCount)).toBe(2);
});
