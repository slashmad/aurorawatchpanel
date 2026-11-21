import { expect, test } from '@playwright/test';

const expectedLabels = [
  'SDO/AIA 131',
  'SDO/AIA 171',
  'SDO/AIA 193',
  'SDO/AIA 211',
  'SDO/AIA 304',
  'SDO/AIA HMIIF',
  'Synoptic Map',
];
const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;

test('desktop solar image lists load once at startup and overlay loading is demand-driven', async ({ page }) => {
  const imageListRequests = [];
  const fullImageRequests = [];

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

  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/images/list') {
      imageListRequests.push(url.searchParams.get('label'));
    }
    if (url.pathname.startsWith('/images/SDO_193/') && !url.pathname.includes('_thumb')) {
      fullImageRequests.push(url.pathname);
    }
  });

  // Desktop (default 1440 px viewport): the solar column is visible next to the
  // location column, so its image lists load at startup, once per label.
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => imageListRequests.length).toBe(expectedLabels.length);
  await page.waitForTimeout(300);
  expect(imageListRequests).toHaveLength(expectedLabels.length);
  expect([...imageListRequests].sort()).toEqual([...expectedLabels].sort());
  await expect(page.locator('.solar-image-thumb')).toHaveCount(2);

  await expect.poll(() => fullImageRequests.length).toBe(1);
  expect(fullImageRequests[0]).toContain('SDO_193_20260801T120000Z.jpg');
  expect(fullImageRequests.some(path => path.includes('SDO_193_20260801T115900Z.jpg'))).toBe(false);

  await page.locator('.solar-image-thumb img[data-label="SDO/AIA 193"]').evaluate(element => element.click());
  await expect(page.locator('#img-overlay')).toHaveClass(/active/);
  await expect(page.locator('#img-overlay-img')).toHaveAttribute('src', /SDO_193_20260801T120000Z\.jpg/);
  await page.waitForTimeout(100);

  expect(fullImageRequests.length).toBeLessThanOrEqual(2);
  expect(fullImageRequests.every(path => path.includes('SDO_193_20260801T120000Z.jpg'))).toBe(true);
});
