import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;
const scopedTimelapseIds = [
  'solar-panel-timelapse-type',
  'solar-panel-timelapse-date',
  'timelapse-show-btn',
  'timelapse-overlay-date',
  'timelapse-overlay-type',
  'timelapse-overlay-show',
  'timelapse-overlay-close',
  'timelapse-overlay-video-container',
  'solar-overlay-timelapse-date',
  'solar-overlay-timelapse-type',
  'solar-overlay-timelapse-show',
  'solar-overlay-timelapse-close',
  'solar-overlay-timelapse-video-container',
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

test('timelapse controls have unique IDs and one request per action', async ({ page }) => {
  const timelapseHeadRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'HEAD' && url.pathname.startsWith('/data/suvi-timelapse/')) {
      timelapseHeadRequests.push(url.pathname);
    }
  });

  await isolateApplicationRequests(page);
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('dashboard-solar')?.children.length > 0);

  for (const id of scopedTimelapseIds) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  for (const legacyId of [
    'timelapse-date',
    'timelapse-type',
    'timelapse-show',
    'timelapse-close',
    'timelapse-video-container',
  ]) {
    await expect(page.locator(`#${legacyId}`)).toHaveCount(0);
  }

  await page.locator('#solar-panel-timelapse-date').evaluate(input => {
    input.value = '2026-08-01';
  });
  await page.locator('#solar-panel-timelapse-type').evaluate(select => {
    select.value = 'SDO_193_';
  });
  await page.locator('#timelapse-show-btn').evaluate(button => button.click());

  await expect(page.locator('#timelapse-overlay')).toHaveClass(/active/);
  await expect(page.locator('#timelapse-overlay-date')).toHaveValue('2026-08-01');
  await expect(page.locator('#timelapse-overlay-type')).toHaveValue('SDO_193_');
  await expect.poll(() => timelapseHeadRequests).toEqual([
    '/data/suvi-timelapse/SDO_193/2026/08/SDO_193_20260801.mp4',
  ]);

  await page.locator('#timelapse-overlay-date').fill('2026-08-02');
  await page.locator('#timelapse-overlay-type').selectOption('SDO_304_');
  await page.locator('#timelapse-overlay-show').click();
  await expect.poll(() => timelapseHeadRequests).toEqual([
    '/data/suvi-timelapse/SDO_193/2026/08/SDO_193_20260801.mp4',
    '/data/suvi-timelapse/SDO_304/2026/08/SDO_304_20260802.mp4',
  ]);

  await page.locator('#timelapse-overlay-close').click();
  await expect(page.locator('#timelapse-overlay')).not.toHaveClass(/active/);
  await expect(page.locator('#timelapse-overlay-video-container')).toBeEmpty();
});
