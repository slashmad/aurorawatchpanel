import { expect, test } from '@playwright/test';

test('global magnetometer has one startup owner, timer, and listener per control', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    document.body.innerHTML = `
      <select id="magneto-global-component"><option value="x" selected>x</option></select>
      <select id="magneto-global-range"><option value="6" selected>6</option></select>
    `;

    window.Highcharts = { setOptions() {} };
    window.globalMagnetometerFetchCount = 0;
    window.fetch = async () => {
      window.globalMagnetometerFetchCount += 1;
      return { json: async () => ({ data: null }) };
    };

    window.globalMagnetometerIntervals = [];
    window.setInterval = (callback, delay) => {
      window.globalMagnetometerIntervals.push({ callback, delay });
      return window.globalMagnetometerIntervals.length;
    };

    window.globalMagnetometerModule = await import(
      `/static/js/magnetometer_global.js?test=${Date.now()}`
    );
    document.dispatchEvent(new Event('DOMContentLoaded'));
  });

  expect(await page.evaluate(() => window.globalMagnetometerFetchCount)).toBe(0);
  expect(await page.evaluate(() => window.globalMagnetometerIntervals.length)).toBe(0);

  await page.evaluate(async () => {
    const {
      setupMagnetometerGlobal,
      setupMagnetometerGlobalEvents,
    } = window.globalMagnetometerModule;

    setupMagnetometerGlobalEvents();
    setupMagnetometerGlobalEvents();
    setupMagnetometerGlobalEvents();
    await Promise.all([
      setupMagnetometerGlobal(),
      setupMagnetometerGlobal(),
      setupMagnetometerGlobal(),
    ]);
  });

  expect(await page.evaluate(() => window.globalMagnetometerFetchCount)).toBe(3);
  expect(await page.evaluate(() => window.globalMagnetometerIntervals.map(({ delay }) => delay))).toEqual([60_000]);

  await page.evaluate(() => {
    window.globalMagnetometerFetchCount = 0;
    document.getElementById('magneto-global-component').dispatchEvent(new Event('change'));
  });
  await expect.poll(() => page.evaluate(() => window.globalMagnetometerFetchCount)).toBe(1);

  await page.evaluate(async () => {
    window.globalMagnetometerFetchCount = 0;
    await window.globalMagnetometerIntervals[0].callback();
  });
  expect(await page.evaluate(() => window.globalMagnetometerFetchCount)).toBe(1);
});
