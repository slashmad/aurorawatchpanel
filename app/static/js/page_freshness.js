// ---- app/static/js/page_freshness.js ----
// Keeps a long-open page current without full reloads. Replaces the former
// unconditional hourly location.reload():
//  - slow-moving data (sun/moon, weather, forecast) refreshes in place on a timer,
//    and immediately when a tab becomes visible after being hidden for a while;
//  - day-based cards refresh after local midnight, but only once the page is idle
//    so a visitor browsing an older date is not pulled back to today;
//  - the page reloads only when a new frontend build is deployed, and only while
//    the tab is hidden or nobody has interacted with it for a while.

const MINUTE = 60_000;

export const FRESHNESS_DEFAULTS = {
  tickMs: MINUTE,
  dataRefreshMs: 15 * MINUTE,
  staleAfterHiddenMs: 10 * MINUTE,
  versionCheckMs: 10 * MINUTE,
  idleMs: 10 * MINUTE,
};

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

let active = null;

function localDay(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function setupPageFreshness({
  refreshData,
  refreshDaily,
  versionUrl = '/static/js/main.min.js',
  reload = () => window.location.reload(),
  now = () => Date.now(),
  options = {},
} = {}) {
  if (active) return active;

  const cfg = { ...FRESHNESS_DEFAULTS, ...options };
  const start = now();
  const state = {
    lastRefresh: start,
    lastInteraction: start,
    lastVersionCheck: start,
    day: localDay(start),
    version: null,
    updatePending: false,
    refreshing: false,
  };

  const markInteraction = () => { state.lastInteraction = now(); };
  INTERACTION_EVENTS.forEach(type => window.addEventListener(type, markInteraction, { passive: true }));

  const isIdle = () => now() - state.lastInteraction >= cfg.idleMs;

  async function runRefresh() {
    if (state.refreshing || typeof refreshData !== 'function') return;
    state.refreshing = true;
    try {
      await refreshData();
    } catch (err) {
      console.warn('Periodic data refresh failed:', err);
    } finally {
      state.lastRefresh = now();
      state.refreshing = false;
    }
  }

  async function readVersion() {
    try {
      const res = await fetch(versionUrl, { method: 'HEAD', cache: 'no-store' });
      if (!res.ok) return null;
      const etag = res.headers.get('etag');
      const modified = res.headers.get('last-modified');
      return etag || modified || null;
    } catch {
      return null;
    }
  }

  async function checkVersion() {
    state.lastVersionCheck = now();
    const version = await readVersion();
    if (!version) return;
    if (state.version === null) state.version = version;
    else if (version !== state.version) state.updatePending = true;
  }

  function reloadIfUpdateAllowed() {
    if (!state.updatePending || !(document.hidden || isIdle())) return false;
    reload();
    return true;
  }

  async function tick() {
    if (reloadIfUpdateAllowed()) return;
    if (now() - state.lastVersionCheck >= cfg.versionCheckMs) {
      await checkVersion();
      if (reloadIfUpdateAllowed()) return;
    }
    // Hidden tabs are throttled by the browser; catch up when visible again.
    if (document.hidden) return;

    const today = localDay(now());
    if (today !== state.day && isIdle() && typeof refreshDaily === 'function') {
      state.day = today;
      try {
        await refreshDaily();
      } catch (err) {
        console.warn('Daily refresh failed:', err);
      }
    }
    if (now() - state.lastRefresh >= cfg.dataRefreshMs) await runRefresh();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      reloadIfUpdateAllowed();
      return;
    }
    if (now() - state.lastRefresh >= cfg.staleAfterHiddenMs) runRefresh();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  const ready = checkVersion();
  const timer = setInterval(tick, cfg.tickMs);

  active = {
    state,
    ready,
    tick,
    stop() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      INTERACTION_EVENTS.forEach(type => window.removeEventListener(type, markInteraction));
      active = null;
    },
  };
  return active;
}
