// ---- app/static/js/section_errors.js ----
// Shows a visible error code inside the card or section that failed, instead of
// failing silently or aborting the rest of the page. The box is cleared again
// as soon as the same section succeeds on a later refresh.

const BOX_CLASS = 'section-error';

function resolve(target) {
  return typeof target === 'string' ? document.querySelector(target) : target;
}

function describe(err) {
  const message = err?.message || String(err ?? 'unknown error');
  if (typeof window.Highcharts === 'undefined' && /Highcharts/.test(message)) {
    return 'chart library (Highcharts) failed to load';
  }
  return message;
}

export function showSectionError(target, code, err) {
  const el = resolve(target);
  if (!el) return;
  let box = el.querySelector(`:scope > .${BOX_CLASS}[data-code="${code}"]`);
  if (!box) {
    box = document.createElement('div');
    box.className = BOX_CLASS;
    box.setAttribute('role', 'alert');
    el.prepend(box);
  }
  const text = `${code}: ${describe(err)}`;
  box.textContent = `⚠ ${text}`;
  box.title = text;
  box.dataset.code = code;
}

export function clearSectionError(target, code) {
  const el = resolve(target);
  el?.querySelector(`:scope > .${BOX_CLASS}[data-code="${code}"]`)?.remove();
}

// Runs named steps independently; throws one combined error if any failed.
export async function settleAll(steps) {
  const results = await Promise.allSettled(steps.map(([, fn]) => Promise.resolve().then(fn)));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${steps[i][0]}: ${r.reason?.message || r.reason}` : null))
    .filter(Boolean);
  if (failed.length) throw new Error(failed.join('; '));
}

// Runs one section's setup/refresh; any throw or rejection is shown in that
// section and logged, never propagated to the caller.
export async function runSection(code, target, fn) {
  try {
    const result = await fn();
    clearSectionError(target, code);
    return result;
  } catch (err) {
    console.error(`${code}:`, err);
    showSectionError(target, code, err);
    return undefined;
  }
}
