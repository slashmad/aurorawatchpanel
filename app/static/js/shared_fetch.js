// ---- app/static/js/shared_fetch.js ----
// Coalesces identical JSON GET requests issued close together. At startup the
// aurora forecast runs twice and several panels ask for the same series; each
// caller still gets its own copy of the data, so nobody can mutate another's.
//
// fetchShared(url) resolves to a minimal Response-like object
// ({ ok, status, json() }), so existing `res.json()` call sites keep working.
// The `_` cache-buster parameter is ignored when matching requests.

export const SHARED_FETCH_MAX_AGE_MS = 20_000;

const entries = new Map();

function keyFor(url) {
  const u = new URL(url, window.location.origin);
  u.searchParams.delete('_');
  u.searchParams.sort();
  return u.pathname + '?' + u.searchParams.toString();
}

async function load(url) {
  const res = await fetch(url);
  let data;
  let parseError = null;
  try {
    data = await res.json();
  } catch (err) {
    parseError = err;
  }
  return { ok: res.ok, status: res.status, data, parseError };
}

export function fetchShared(url, { maxAgeMs = SHARED_FETCH_MAX_AGE_MS } = {}) {
  const key = keyFor(url);
  const now = Date.now();
  let entry = entries.get(key);
  if (!entry || now - entry.startedAt > maxAgeMs) {
    entry = { startedAt: now, promise: load(url) };
    entries.set(key, entry);
    // Never keep failures around: callers in the same burst share the result,
    // the next caller retries.
    const forget = () => { if (entries.get(key) === entry) entries.delete(key); };
    entry.promise.then(result => { if (!result.ok || result.parseError) forget(); }, forget);
  }
  return entry.promise.then(result => ({
    ok: result.ok,
    status: result.status,
    async json() {
      if (result.parseError) throw result.parseError;
      return structuredClone(result.data);
    },
  }));
}

export function clearSharedFetchCache() {
  entries.clear();
}
