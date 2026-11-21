import { expect, test } from '@playwright/test';

const localOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '18081'}`;

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

test('azimuth surfaces retain independent map and listener ownership', async ({ page }) => {
  await page.goto('/static/js/state.js', { waitUntil: 'domcontentloaded' });

  const state = await page.evaluate(async () => {
    document.body.innerHTML = `
      <div class="azimuth-map-container" id="astro-azimuth-embed">
        <div class="astro-azimuth-controls"></div>
        <div id="astro-azimuth-embed-map" class="astro-azimuth-map"></div>
        <div class="astro-azimuth-times"></div>
      </div>
      <div class="azimuth-map-container" id="astro-azimuth-modal-container">
        <div class="astro-azimuth-controls"></div>
        <div id="astro-azimuth-modal-container-map" class="astro-azimuth-map"></div>
        <div class="astro-azimuth-times"></div>
      </div>
    `;
    localStorage.removeItem('astroAzimuthObjs');

    const resizeHandlers = new Set();
    const originalAddEventListener = window.addEventListener.bind(window);
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    window.addEventListener = (type, handler, options) => {
      if (type === 'resize') resizeHandlers.add(handler);
      return originalAddEventListener(type, handler, options);
    };
    window.removeEventListener = (type, handler, options) => {
      if (type === 'resize') resizeHandlers.delete(handler);
      return originalRemoveEventListener(type, handler, options);
    };

    const maps = [];
    window.L = {
      map(target) {
        const events = new Map();
        const record = { target, parentId: target.parentElement.id, events, removed: false };
        const map = {
          on(type, handler) {
            events.set(type, handler);
          },
          off(type, handler) {
            if (events.get(type) === handler) events.delete(type);
          },
          remove() {
            record.removed = true;
          },
        };
        record.map = map;
        maps.push(record);
        return map;
      },
      tileLayer() {
        return { addTo() {} };
      },
    };

    let fetchCount = 0;
    window.fetch = async () => {
      fetchCount += 1;
      return { json: async () => ({}) };
    };

    const { drawAzimuthMap } = await import(`/static/js/azimuth_map.js?test=${Date.now()}`);
    await drawAzimuthMap('astro-azimuth-embed');
    await drawAzimuthMap('astro-azimuth-modal-container');

    const modalSun = document.querySelector(
      '#astro-azimuth-modal-container .astro-azimuth-controls input[data-obj="sun"]'
    );
    modalSun.checked = false;
    modalSun.dispatchEvent(new Event('change'));
    await new Promise(resolve => {
      const waitForRedraw = () => {
        if (maps.length === 3 && resizeHandlers.size === 2 && maps[2].events.has('resize')) resolve();
        else setTimeout(waitForRedraw, 0);
      };
      waitForRedraw();
    });

    return {
      controlsPerSurface: [
        document.querySelectorAll('#astro-azimuth-embed .az-ctrl-label').length,
        document.querySelectorAll('#astro-azimuth-modal-container .az-ctrl-label').length,
      ],
      fetchCount,
      mapIds: Array.from(document.querySelectorAll('.astro-azimuth-map'), node => node.id),
      canvasIds: Array.from(document.querySelectorAll('.astro-azimuth-overlay'), node => node.id),
      mapParents: maps.map(record => record.parentId),
      mapTargetsAreElements: maps.every(record => record.target instanceof HTMLElement),
      removedMaps: maps.map(record => record.removed),
      resizeHandlerCount: resizeHandlers.size,
      modalSunChecked: document.querySelector(
        '#astro-azimuth-modal-container .astro-azimuth-controls input[data-obj="sun"]'
      ).checked,
    };
  });

  expect(state.controlsPerSurface).toEqual([12, 12]);
  expect(state.fetchCount).toBe(3);
  expect(state.mapIds).toEqual(['astro-azimuth-embed-map', 'astro-azimuth-modal-container-map']);
  expect(state.canvasIds).toEqual([
    'astro-azimuth-embed-map-overlay',
    'astro-azimuth-modal-container-map-overlay',
  ]);
  expect(state.mapParents).toEqual([
    'astro-azimuth-embed',
    'astro-azimuth-modal-container',
    'astro-azimuth-modal-container',
  ]);
  expect(state.mapTargetsAreElements).toBe(true);
  expect(state.removedMaps).toEqual([false, true, false]);
  expect(state.resizeHandlerCount).toBe(2);
  expect(state.modalSunChecked).toBe(false);
});

test('bundled application base DOM has no duplicate IDs', async ({ page }) => {
  await isolateApplicationRequests(page);
  await page.goto('/?browser_test=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('dashboard-solar')?.children.length > 0);

  const duplicateIds = await page.evaluate(() => {
    const counts = new Map();
    document.querySelectorAll('[id]').forEach(node => {
      counts.set(node.id, (counts.get(node.id) || 0) + 1);
    });
    return Array.from(counts.entries()).filter(([, count]) => count > 1);
  });

  expect(duplicateIds).toEqual([]);
  await expect(page.locator('#astro-azimuth-embed-map')).toHaveCount(1);
  await expect(page.locator('#astro-azimuth-modal-container-map')).toHaveCount(1);
  await expect(page.locator('#astro-azimuth-map')).toHaveCount(0);
});
