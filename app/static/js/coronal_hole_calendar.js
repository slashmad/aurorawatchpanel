(function () {
  "use strict";

  const OVERLAY_ID = "chcal-overlay";
  const BTN_ID = "btn-open-ch-calendar";
  const STYLE_ID = "chcal-style";
  const API_BASE = "/api/coronal_holes/grouped";

  // ----------------- local safe helpers -----------------
  function buildAbsUrl(path) {
    if (!path || String(path).trim() === "" || String(path).includes("/undefined"))
      return "";
    try {
      return new URL(path, window.location.origin).toString();
    } catch {
      return "";
    }
  }

  async function safeFetch(url, init) {
    const u = buildAbsUrl(url);
    if (!u) {
      console.warn("[CHCAL] Blocked fetch to bad URL:", url);
      return new Response(null, { status: 400, statusText: "Bad URL" });
    }
    console.log("[CHCAL] Fetch:", u);
    return fetch(u, init);
  }

  // ----------------- styles (scoped) -----------------
  const css = `
  #${OVERLAY_ID}{position:fixed;inset:0;display:none;z-index:9999}
  #${OVERLAY_ID}[data-open="1"]{display:block}
  #${OVERLAY_ID} .chcal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.55)}
  #${OVERLAY_ID} .chcal-modal{position:absolute;inset:5% 8%;background:#0b0f14;border:1px solid #1f2937;border-radius:18px;
    box-shadow:0 10px 40px rgba(0,0,0,0.35);display:flex;flex-direction:column;padding:16px;gap:10px;color:#e5e7eb;z-index:10000}
  .chcal-header{display:flex;align-items:center;justify-content:space-between}
  .chcal-header h3{margin:0;font-size:1.1rem}
  .chcal-close{background:transparent;border:0;color:#9ca3af;font-size:1.8rem;line-height:1;cursor:pointer}
  .chcal-toolbar{display:flex;align-items:center;gap:12px;justify-content:center}
  .chcal-nav{border:0;background:#111827;color:#e5e7eb;padding:.25rem .6rem;border-radius:8px;cursor:pointer}
  .chcal-month{min-width:220px;text-align:center;font-weight:600}
  .chcal-grid-head,.chcal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
  .chcal-grid-head div{opacity:.7;text-align:center;font-size:.85rem}
  .chcal-cell{min-height:68px;background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:6px 8px;position:relative;cursor:pointer}
  .chcal-cell[aria-disabled="true"]{visibility:hidden}
  .chcal-day{font-size:.9rem;opacity:.9}

  /* original single dot kept as base style (used for both dots) */
  .chcal-hit{width:10px;height:10px;border-radius:50%}

  /* OBSERVED intensity (existing colors) */
  .hit-0{display:none}
  .hit-1{background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,0.12)}
  .hit-2{background:#eab308;box-shadow:0 0 0 4px rgba(234,179,8,0.12)}
  .hit-3{background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,0.12)}

  /* Wrapper to hold two dots in the corner */
  .chcal-hits{position:absolute;right:8px;bottom:8px;display:flex;gap:6px;align-items:center}
  .chcal-hits .chcal-hit{position:static} /* override absolute positioning */

  /* PREDICTED intensity (blue-ish scale) */
  .pred-0{display:none}
  .pred-1{background:#3bb3ff;box-shadow:0 0 0 4px rgba(59,179,255,.12)}
  .pred-2{background:#1994e8;box-shadow:0 0 0 4px rgba(25,148,232,.16)}
  .pred-3{background:#0d7ecb;box-shadow:0 0 0 4px rgba(13,126,203,.20)}

  .chcal-details{margin-top:8px;border-top:1px solid #1f2937;padding-top:10px;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
  .chcal-thumb{background:#0b1220;border:1px solid #1f2937;border-radius:12px;overflow:hidden}
  .chcal-thumb img{display:block;width:100%;height:auto}
  .chcal-empty{opacity:.6}
  .chcal-predicted{border:1px dashed #ff0;background:rgba(255,255,0,0.1)}
  .chcal-pred-text{font-size:.9em;color:#ff0}
  `;

  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="chcal-backdrop" data-chcal-close></div>
      <div class="chcal-modal">
        <div class="chcal-header">
          <h3>Coronal Hole Calendar</h3>
          <button class="chcal-close" data-chcal-close>×</button>
        </div>
        <div class="chcal-toolbar">
          <button data-nav="prev" class="chcal-nav">◀</button>
          <span class="chcal-month"></span>
          <button data-nav="next" class="chcal-nav">▶</button>
        </div>
        <div class="chcal-grid-head"></div>
        <div class="chcal-grid"></div>
        <div class="chcal-details"></div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function setOpen(overlay, v) {
    overlay.setAttribute("data-open", v ? "1" : "0");
    document.body.style.overflow = v ? "hidden" : "";
  }

  // -------- data -----------

  function monthKeyUTC(y, m) {
    const yStr = String(y);
    const mStr = String(m + 1).padStart(2, "0");
    return `${yStr}-${mStr}`;
  }

  async function fetchMonthCalendar(y, m) {
    const key = monthKeyUTC(y, m);
    const url = new URL(API_BASE, window.location.origin);
    url.searchParams.set("month", key);
    const r = await safeFetch(url.toString(), { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json(); // { groups: [...], predictions: [...] }
  }

  // Build per-day stats (observed vs predicted) and also hold the items per day
  function buildByDateMap(groups, predictions) {
    const byDate = Object.create(null);
    const all = [...(groups || []), ...(predictions || [])];

    for (const it of all) {
      const start = new Date(it.start_timestamp);
      const end   = new Date(it.end_timestamp);
      if (isNaN(start) || isNaN(end)) continue;

      for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
           d <= new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
           d.setUTCDate(d.getUTCDate() + 1)) {

        const key = d.toISOString().slice(0,10);
        if (!byDate[key]) byDate[key] = { obs: 0, pred: 0, items: [] };

        const val = (it.count || 1);
        if (it.predicted) byDate[key].pred += val;
        else              byDate[key].obs  += val;

        byDate[key].items.push(it);
      }
    }
    return byDate;
  }

  // -------- UI -----------

  function hitLevel(count) {
    if (count >= 6) return 3;
    if (count >= 3) return 2;
    if (count >= 1) return 1;
    return 0;
  }

  function init() {
    injectStyleOnce();
    const overlay = ensureOverlay();

    document.addEventListener("click", (ev) => {
      const openEl = ev.target.closest(`#${BTN_ID}, [data-chcal-open]`);
      if (openEl) { ev.preventDefault(); openCalendar(overlay); }
      const closeEl = ev.target.closest(`[data-chcal-close], .chcal-close, .chcal-backdrop`);
      if (closeEl) { ev.preventDefault(); setOpen(overlay, false); }
    });

    // weekday header
    const elHead = overlay.querySelector(".chcal-grid-head");
    if (elHead && !elHead.childElementCount) {
      ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].forEach(w => {
        const d = document.createElement("div"); d.textContent = w; elHead.appendChild(d);
      });
    }
  }

  async function openCalendar(overlay) {
    setOpen(overlay, true);

    const now = new Date();
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth();
	let currentPayload = null; // cache last loaded { groups, predictions }

    const elTitle = overlay.querySelector(".chcal-month");
    const elGrid = overlay.querySelector(".chcal-grid");
    const elDetails = overlay.querySelector(".chcal-details");
    const toolbar = overlay.querySelector(".chcal-toolbar");

    function renderDetails(groupOrPred) {
      if (!groupOrPred) {
        elDetails.innerHTML = `<div class="chcal-empty">No coronal holes for selected day.</div>`;
        return;
      }

      const isPredicted = !!groupOrPred.predicted;

	// Find reference group's previous period (for predicted cards)
	let prevStartISO = null, prevEndISO = null;
	if (isPredicted) {
	  const refGroup =
		currentPayload && Array.isArray(currentPayload.groups)
		  ? currentPayload.groups.find(g => g.id === groupOrPred.ref_group_id)
		  : null;
	  if (refGroup) {
		prevStartISO = new Date(refGroup.start_timestamp).toISOString().slice(0, 10);
		prevEndISO   = new Date(refGroup.end_timestamp).toISOString().slice(0, 10);
	  } else if (groupOrPred.ref_start_date) {
		// Fallback if backend only sent start
		prevStartISO = String(groupOrPred.ref_start_date);
	  }
	}


      // Choose image(s)
      let imgUrls = [];
      if (isPredicted) {
        if (groupOrPred.ref_thumb) {
          imgUrls = [groupOrPred.ref_thumb];
        } else if (groupOrPred.ref_filename) {
          imgUrls = ["/images/SDO_193/" + groupOrPred.ref_filename];
        }
      } else {
        if (Array.isArray(groupOrPred.thumbs) && groupOrPred.thumbs.length) {
          imgUrls = groupOrPred.thumbs;
        } else if (Array.isArray(groupOrPred.processed_filenames) && groupOrPred.processed_filenames.length) {
          imgUrls = groupOrPred.processed_filenames.map(rel => "/data/images/coronal-holes/" + rel);
        } else if (Array.isArray(groupOrPred.filenames) && groupOrPred.filenames.length) {
          imgUrls = groupOrPred.filenames.map(name => "/images/SDO_193/" + name);
        }
      }

      const area = Number(
        isPredicted ? groupOrPred.area_fraction
                    : (Array.isArray(groupOrPred.area_fraction) ? groupOrPred.area_fraction[0] : groupOrPred.area_fraction) || 0
      ).toFixed(2);

      const carrington = isPredicted ? (groupOrPred.ref_carrington ?? groupOrPred.carrington) : groupOrPred.carrington;

      const startDate = new Date(groupOrPred.start_timestamp).toISOString().slice(0, 10);
      const endDate   = new Date(groupOrPred.end_timestamp).toISOString().slice(0, 10);

	elDetails.innerHTML = `
	  <div class="chcal-details ${isPredicted ? 'chcal-predicted' : ''}">
		<div>Period: ${startDate} to ${endDate}</div>
		<div>Carrington Rotation: ${carrington}</div>
		<div>Area: ${area}%</div>
		${
		  isPredicted
			? `<div class="chcal-pred-text">
				 Predicted from Rot. ${groupOrPred.ref_carrington}
				 ${prevStartISO ? `<span style="opacity:.85"> — last seen ${prevStartISO}${prevEndISO ? ` to ${prevEndISO}` : ""}</span>` : ""}
			   </div>`
			: `<div>Observations: ${groupOrPred.count}</div>`
		}
		${imgUrls.map(u => u ? `<div class="chcal-thumb"><img loading="lazy" src="${u}" alt="${startDate}"></div>` : "").join("")}
	  </div>`;
    }

    async function renderMonth() {
      elTitle.textContent = new Date(Date.UTC(y, m, 1))
        .toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

      let payload;
      try {
        payload = await fetchMonthCalendar(y, m);
      } catch (err) {
        console.error("[CHCAL] Could not load data:", err);
        elGrid.innerHTML = "";
        elDetails.innerHTML = `<div class="chcal-empty">Could not load data.</div>`;
        return;
      }

	  currentPayload = payload;

      // Build map per date with obs/pred counts and items
      const byDate = buildByDateMap(payload.groups, payload.predictions);

      // grid
      elGrid.innerHTML = "";
      const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // 0=Mon
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

      for (let i = 0; i < firstDow; i++) {
        const ph = document.createElement("div");
        ph.className = "chcal-cell";
        ph.setAttribute("aria-disabled", "true");
        elGrid.appendChild(ph);
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const dateKey = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
        const stats = byDate[dateKey] || { obs: 0, pred: 0, items: [] };

        const cell = document.createElement("div");
        cell.className = "chcal-cell";
        cell.innerHTML = `<div class="chcal-day">${d}</div><div class="chcal-hits"></div>`;
        const hits = cell.querySelector(".chcal-hits");

        // Observed dot (uses existing hit-1..3 palette)
        const obsLvl = hitLevel(stats.obs);
        const dotObs = document.createElement("span");
        dotObs.className = `chcal-hit hit-${obsLvl}`;
        hits.appendChild(dotObs);

        // Predicted dot (blue palette pred-1..3)
        const predLvl = hitLevel(stats.pred);
        const dotPred = document.createElement("span");
        dotPred.className = `chcal-hit pred-${predLvl}`;
        hits.appendChild(dotPred);

        // Click: prefer showing an observed item if available, else first predicted
        const prefer = stats.items.find(i => !i.predicted) || stats.items.find(i => i.predicted);
        cell.addEventListener("click", () => renderDetails(prefer || null));

        elGrid.appendChild(cell);
      }

      // auto select today if available
      const todayKey = new Date().toISOString().slice(0, 10);
      const todayPrefer = (byDate[todayKey]?.items || []).find(i => !i.predicted)
                         || (byDate[todayKey]?.items || [])[0];
      renderDetails(todayPrefer || null);
    }

    toolbar.onclick = (ev) => {
      const b = ev.target.closest("[data-nav]");
      if (!b) return;
      if (b.dataset.nav === "prev") m--;
      else m++;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      renderMonth();
    };

    await renderMonth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
