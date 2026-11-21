// ---- app/static/js/card_layout.js ----
// Per-visitor dashboard layout: collapsible cards, drag-to-reorder (also
// between desktop columns), saved per browser in localStorage.
//
// Cards are the direct children of the four dashboard sections that carry a
// `data-card` id. Each section's cards live either in its tab panel (narrow
// screens) or in its dashboard column (desktop, moved by dashboard_panels.js);
// this module works on whichever container currently holds them.
//
// Collapsed cards are "inactive": pollers ask isCardActive(id) and skip work,
// and expanding a card calls the handler registered by the app so it refreshes
// immediately. This module has no app imports, so any panel module may use it.

export const LAYOUT_STORAGE_KEY = 'aurora.layout.v1';
export const LAYOUT_SECTIONS = ['location', 'solarwind', 'magnetometer', 'solar'];

let defaultLayout = null;
let expandHandler = () => {};
let layoutChangeHandler = () => {};
let isDesktop = () => false;

const tabPanelOf = section => document.querySelector(`.tab-panel[data-section="${section}"]`);
const columnOf = section => document.getElementById(`dashboard-${section}`);

export const cardElement = id => document.querySelector(`[data-card="${CSS.escape(id)}"]`);

export function isCardActive(id) {
  const el = cardElement(id);
  return !el || !el.classList.contains('is-collapsed');
}

// The container currently holding a section's cards.
function containerOf(section) {
  const column = columnOf(section);
  if (isDesktop() && column) return column;
  return tabPanelOf(section);
}

function sectionOfContainer(container) {
  if (container.dataset.section) return container.dataset.section;
  return container.id.replace(/^dashboard-/, '');
}

function readLayoutFromDom() {
  const sections = {};
  for (const section of LAYOUT_SECTIONS) {
    const container = containerOf(section);
    sections[section] = container
      ? [...container.children].filter(el => el.dataset.card).map(el => el.dataset.card)
      : [];
  }
  const collapsed = [...document.querySelectorAll('[data-card].is-collapsed')].map(el => el.dataset.card);
  return { sections, collapsed };
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.sections ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(readLayoutFromDom()));
  } catch {
    // Storage unavailable (private mode, quota): the layout simply is not kept.
  }
}

// Places every known card according to `layout`; unknown ids are ignored and
// cards missing from it keep their default section and relative order.
function applyLayout(layout) {
  const placed = new Set();
  for (const section of LAYOUT_SECTIONS) {
    const container = containerOf(section);
    if (!container) continue;
    for (const id of layout.sections?.[section] || []) {
      const el = typeof id === 'string' && !placed.has(id) ? cardElement(id) : null;
      if (!el) continue;
      container.appendChild(el);
      placed.add(id);
    }
  }
  for (const section of LAYOUT_SECTIONS) {
    const container = containerOf(section);
    if (!container) continue;
    for (const id of defaultLayout.sections[section]) {
      if (placed.has(id)) continue;
      const el = cardElement(id);
      if (el) container.appendChild(el);
    }
  }
  const collapsed = new Set(Array.isArray(layout.collapsed) ? layout.collapsed : []);
  document.querySelectorAll('[data-card]').forEach(el => setCollapsed(el, collapsed.has(el.dataset.card)));
}

// Collapsing keeps only the path from the card to its header row visible
// (headers can be nested in wrapper elements), plus the controls and any
// error box.
function setCollapsed(card, collapsed) {
  card.classList.toggle('is-collapsed', collapsed);
  card.querySelectorAll('.card-collapse-hidden').forEach(el => el.classList.remove('card-collapse-hidden'));
  const head = card.querySelector('.card-head-row');
  if (collapsed && head) {
    for (let node = head; node && node !== card; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling.matches('.card-controls, .section-error')) continue;
        sibling.classList.add('card-collapse-hidden');
      }
    }
  }
  const toggle = card.querySelector('.card-controls .card-collapse-btn');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Expand' : 'Collapse';
    toggle.innerHTML = `<i class="fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}" aria-hidden="true"></i>`;
  }
}

export function toggleCard(id, collapsed) {
  const card = cardElement(id);
  if (!card) return;
  const next = collapsed ?? !card.classList.contains('is-collapsed');
  setCollapsed(card, next);
  saveLayout();
  if (!next) expandHandler(id);
  layoutChangeHandler();
}

export function resetLayout() {
  const wasCollapsed = [...document.querySelectorAll('[data-card].is-collapsed')].map(el => el.dataset.card);
  try { localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch { /* ignore */ }
  applyLayout(defaultLayout);
  wasCollapsed.forEach(id => expandHandler(id));
  layoutChangeHandler();
}

// ---- moving cards ----------------------------------------------------------

function dropContainers() {
  if (isDesktop()) return LAYOUT_SECTIONS.map(columnOf).filter(c => c && c.offsetParent !== null);
  return LAYOUT_SECTIONS.map(tabPanelOf).filter(c => c && c.offsetParent !== null);
}

function finishMove() {
  saveLayout();
  layoutChangeHandler();
}

// Keyboard: ArrowUp/ArrowDown within the column, ArrowLeft/ArrowRight to the
// neighbouring column on desktop.
function moveByKey(card, key) {
  const container = card.parentElement;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const siblings = [...container.children].filter(el => el.dataset.card);
    const i = siblings.indexOf(card);
    const j = key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return false;
    if (key === 'ArrowUp') siblings[j].before(card); else siblings[j].after(card);
    return true;
  }
  if (!isDesktop()) return false;
  const containers = dropContainers();
  const k = containers.indexOf(container) + (key === 'ArrowLeft' ? -1 : 1);
  if (k < 0 || k >= containers.length) return false;
  containers[k].appendChild(card);
  return true;
}

function startPointerDrag(card, handle, ev) {
  if (ev.button !== undefined && ev.button !== 0) return;
  ev.preventDefault();
  const containers = dropContainers();
  const origin = { parent: card.parentElement, next: card.nextSibling };
  const rect = card.getBoundingClientRect();
  const offsetX = ev.clientX - rect.left;
  const offsetY = ev.clientY - rect.top;

  const placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
  placeholder.style.height = `${rect.height}px`;
  card.before(placeholder);

  card.classList.add('is-dragging');
  Object.assign(card.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  handle.setPointerCapture?.(ev.pointerId);

  const onMove = e => {
    card.style.left = `${e.clientX - offsetX}px`;
    card.style.top = `${e.clientY - offsetY}px`;
    if (e.clientY < 40) window.scrollBy(0, -20);
    else if (e.clientY > window.innerHeight - 40) window.scrollBy(0, 20);

    const target = containers.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right;
    }) || placeholder.parentElement;
    const before = [...target.children].find(el =>
      el !== card && el !== placeholder && el.dataset.card &&
      e.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
    if (before) before.before(placeholder); else target.appendChild(placeholder);
  };

  const end = cancelled => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    card.classList.remove('is-dragging');
    card.style.width = card.style.left = card.style.top = '';
    if (cancelled) origin.parent.insertBefore(card, origin.next);
    else placeholder.replaceWith(card);
    placeholder.remove();
    if (!cancelled) finishMove();
  };
  const onUp = () => end(false);
  const onCancel = () => end(true);
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); end(true); } };

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

// Panels sometimes rebuild their header with innerHTML; put the controls back.
function watchControls(card) {
  const restore = () => {
    if (card.querySelector('.card-controls')) return;
    card.querySelector('.card-head-row')?.classList.remove('card-head-row', 'card-head-row--corner');
    addControls(card);
    setCollapsed(card, card.classList.contains('is-collapsed'));
    observeHead();
  };
  const observer = new MutationObserver(() => queueMicrotask(restore));
  const observeHead = () => {
    observer.disconnect();
    observer.observe(card, { childList: true });
    // The header row and every wrapper between it and the card.
    for (let node = card.querySelector('.card-head-row'); node && node !== card; node = node.parentElement) {
      observer.observe(node, { childList: true });
    }
  };
  observeHead();
}

function addControls(card) {
  if (card.querySelector('.card-controls')) return;
  // The card's header row; cards with several headers side by side (location
  // + sun & moon) get the controls in the card's top-right corner instead.
  const headers = card.querySelectorAll('.card-header');
  const head = headers[0] || [...card.children].find(el => !el.classList.contains('section-error'));
  if (head) head.classList.add('card-head-row');
  const inHeader = headers.length === 1 && getComputedStyle(head).display.includes('flex');

  const controls = document.createElement('div');
  controls.className = 'card-controls';
  controls.innerHTML = `
    <button type="button" class="card-move-handle" title="Drag to move (or focus and use arrow keys)"
            aria-label="Move card"><i class="fa-solid fa-grip-vertical" aria-hidden="true"></i></button>
    <button type="button" class="card-collapse-btn" aria-expanded="true" title="Collapse"
            aria-label="Collapse or expand card"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>`;
  // Inside a flex header the controls simply follow its own controls (range
  // selects, buttons); otherwise they sit in the card's top-right corner.
  if (inHeader) {
    head.appendChild(controls);
  } else {
    controls.classList.add('card-controls-corner');
    head?.classList.add('card-head-row--corner');
    card.appendChild(controls);
  }

  const id = card.dataset.card;
  controls.querySelector('.card-collapse-btn').addEventListener('click', () => toggleCard(id));
  const handle = controls.querySelector('.card-move-handle');
  handle.addEventListener('pointerdown', ev => startPointerDrag(card, handle, ev));
  handle.addEventListener('keydown', ev => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    ev.preventDefault();
    if (moveByKey(card, ev.key)) {
      handle.focus();
      finishMove();
    }
  });
}

// Call once at startup, before any panel data is loaded, while every card is
// still in its tab panel.
export function setupCardLayout({ desktop, onExpand, onLayoutChange } = {}) {
  if (desktop) isDesktop = desktop;
  if (onExpand) expandHandler = onExpand;
  if (onLayoutChange) layoutChangeHandler = onLayoutChange;

  const desktopNow = isDesktop;
  isDesktop = () => false; // cards are still in their tab panels at this point
  defaultLayout = readLayoutFromDom();
  document.querySelectorAll('[data-card]').forEach(card => {
    addControls(card);
    watchControls(card);
  });
  const saved = loadSaved();
  if (saved) applyLayout(saved);
  isDesktop = desktopNow;
}
