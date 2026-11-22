import { openSynopticOverlay } from './synoptic.js';
// app/static/js/images.js

window.imageData = window.imageData || {};
window.indices = window.indices || {};
const imageData = window.imageData;
const indices = window.indices;
let overlay, overlayImg;
let isZoomed = false;

const sdoImageCache = {};

export function setupImages() {
  const types = [
    { label: "SDO/AIA 131", id: "sdo131" },
    { label: "SDO/AIA 171", id: "sdo171" },
    { label: "SDO/AIA 193", id: "sdo193" },
    { label: "SDO/AIA 211", id: "sdo211" },
    { label: "SDO/AIA 304", id: "sdo304" },
    { label: "SDO/AIA HMIIF", id: "sdohmiif" },
    { label: "Synoptic Map", id: "synoptic" }
  ];

  Promise.all(types.map(async ({ label, id }) => {
    const res = await fetch(`/images/list?label=${encodeURIComponent(label)}${label === "Synoptic Map" ? "&limit=1" : ""}&_=${Date.now()}`);
    const files = (await res.json()).files || [];
    if (files.length) {
      imageData[label] = files;
      indices[label] = 0;
      // ENDAST detta!
      renderThumbnail(label, id + '-container');
    }
  })).then(() => {
    setupOverlayClassic();
  });
}

function getThumbFilename(fname) {
  if (fname.endsWith('_thumb.jpg')) return fname;
  if (fname.endsWith('.jpg')) return fname.replace(/\.jpg$/, '_thumb.jpg');
  return fname;
}

export function renderThumbnail(label, containerId, retries = 3, delayMs = 2500) {
  const arr = imageData[label];
  if (!arr || !arr.length) return;
  const fname = arr[0];
  const container = document.getElementById(containerId);
  if (!container) return;

  const thumb = label === 'Synoptic Map' ? fname : getThumbFilename(fname);
  const imgUrl = `/images/${thumb}?v=${Date.now()}`;

  container.innerHTML = `
    <img id="img_${label}" src="${imgUrl}" class="image-frame" alt="${label}" loading="lazy">
  `;

  const imgElem = container.querySelector('.image-frame');
  if (imgElem) {
    let retried = 0;
    imgElem.onerror = async () => {
      if (retried < retries) {
        retried++;
        setTimeout(async () => {
          // Hämta ny lista från backend igen (kan nu ha nytt filnamn)
          const res = await fetch(`/images/list?label=${encodeURIComponent(label)}${label === "Synoptic Map" ? "&limit=1" : ""}&_=${Date.now()}`);
          const files = (await res.json()).files || [];
          if (files.length) {
            imageData[label] = files;
            indices[label] = 0;
            renderThumbnail(label, containerId, retries - retried, delayMs);
          }
        }, delayMs);
      } else {
        imgElem.onerror = null;
        imgElem.style.display = "none";
      }
    };
imgElem.addEventListener('click', () => {
  if (label.startsWith("SDO/AIA")) {
    showSDOOverlayWithSlider(label);
  } else {
    openOverlayClassic(label);
  }
});

  }
}

export function nextImage(label) {
  const arr = imageData[label];
  if (!arr) return;
  if (indices[label] < arr.length - 1) indices[label]++;
  renderThumbnail(label, labelToContainer(label));
  updateOverlay(label);
}

export function prevImage(label) {
  if (indices[label] > 0) indices[label]--;
  renderThumbnail(label, labelToContainer(label));
  updateOverlay(label);
}

function labelToContainer(label) {
  if (label === "SDO/AIA 131") return "sdo131-container";
  if (label === "SDO/AIA 171") return "sdo171-container";
  if (label === "SDO/AIA 193") return "sdo193-container";
  if (label === "SDO/AIA 211") return "sdo211-container";
  if (label === "SDO/AIA 304") return "sdo304-container";
  if (label === "SDO/AIA HMIIF") return "sdohmiif-container";
  if (label === "Synoptic Map") return "synoptic-container";
  return "";
}

// I images.js, lägg till
let sdoPlayInterval = null;

export function showSDOOverlayWithSlider(label) {
  if (label === "Synoptic Map") return openSynopticOverlay(imageData[label]?.[0]);
  const arr = imageData[label];

  overlay = document.getElementById('img-overlay');
  overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;
  overlay.classList.add('active');
  isZoomed = false;
  overlayImg.style.transform = 'scale(1)';
  overlayImg.dataset.scale = '1';

  document.getElementById('sdo-slider-box')?.remove();


    indices[label] = 0;
    updateOverlay(label);

    const box = document.createElement('div');
    box.id = 'sdo-slider-box';
    box.style = 'position:absolute; top:25px; left:50%; transform:translateX(-50%); background:rgba(20,24,28,0.88); border-radius:0.25em; padding:0.25em 1em; display:flex; gap:1em; align-items:center; z-index:10100;';
    box.innerHTML = `
      <button id="sdo-play-btn" title="Play"><i class="fa fa-play"></i></button>
      <input type="range" id="sdo-slider" min="0" max="${arr.length-1}" value="${arr.length-1}" style="width:280px;">
      <span id="sdo-slider-label" style="font-size:0.92em;color:#ccc"></span>
    `;
    overlay.appendChild(box);

    const slider = box.querySelector('#sdo-slider');
    slider.oninput = e => {
      stopSDOPlay();
      indices[label] = Number(e.target.value);
      updateOverlay(label);
    };

    const playBtn = box.querySelector('#sdo-play-btn');
    playBtn.onclick = () => {
      if (sdoPlayInterval) {
        stopSDOPlay();
      } else {
        playBtn.innerHTML = '<i class="fa fa-pause"></i>';
        sdoPlayInterval = setInterval(() => {
          let idx = indices[label] - 1;
          if (idx < 0) idx = arr.length - 1;
          slider.value = idx;
          indices[label] = idx;
          updateOverlay(label);
        }, 60);
      }
    };

    function stopSDOPlay() {
      playBtn.innerHTML = '<i class="fa fa-play"></i>';
      if (sdoPlayInterval) clearInterval(sdoPlayInterval);
      sdoPlayInterval = null;
    }

    overlay.querySelector('#img-overlay-close').onclick = e => {
      stopSDOPlay();
      overlay.classList.remove('active');
      box.remove();
    };
    overlay.onclick = e => {
      if (e.target === overlay) {
        stopSDOPlay();
        overlay.classList.remove('active');
        box.remove();
      }
    };

    // Ingen filnamn-text!
    box.querySelector('#sdo-slider-label').textContent = "";
  }

export function openOverlayClassic(label) {
  if (label === "Synoptic Map") return openSynopticOverlay(imageData[label]?.[0]);
  overlay = document.getElementById('img-overlay');
  overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;
  overlay.classList.add('active');
  isZoomed = false;
  overlayImg.style.transform = 'scale(1)';
  overlayImg.dataset.scale = '1';
  updateOverlay(label);
}

export function updateOverlay(label) {
  if (!overlayImg) return;
  const arr = imageData[label];
  if (!arr) return;
  const idx = indices[label];
  let fname = arr[idx];
  if (fname.endsWith('_thumb.jpg')) {
    fname = fname.replace('_thumb.jpg', '.jpg');
  }
  const url = `/images/${fname}`;
  overlayImg.setAttribute('data-label', label);
  // Byt till: Om bilden är cachad, använd cache-objektets src
  if (sdoImageCache[url] && sdoImageCache[url].complete) {
    overlayImg.src = sdoImageCache[url].src;
  } else {
    overlayImg.src = url; // fallback om ej laddad än
  }
}

export function setupOverlayClassic() {
  overlay = document.getElementById('img-overlay');
  overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;

  // Ta bort eventuella gamla listeners först
  overlay.onclick = null;
  overlayImg.onwheel = null;
  overlayImg.onmousedown = null;
  document.getElementById('img-overlay-prev')?.removeEventListener('click', window._prevImgEv);
  document.getElementById('img-overlay-next')?.removeEventListener('click', window._nextImgEv);
  document.getElementById('img-overlay-close')?.removeEventListener('click', window._closeImgEv);

  // Klicka utanför för att stänga
  overlay.onclick = function (e) {
    if (e.target === overlay) overlay.classList.remove('active'), overlay.classList.remove('no-arrows');
  };

  // Piltangenter
  window._prevImgEv = function (e) {
    e.stopPropagation();
    const label = overlayImg.getAttribute('data-label');
    prevImage(label);
  };
  window._nextImgEv = function (e) {
    e.stopPropagation();
    const label = overlayImg.getAttribute('data-label');
    nextImage(label);
  };
  window._closeImgEv = function (e) {
    e.stopPropagation();
    overlay.classList.remove('active');
    overlay.classList.remove('no-arrows');
  };
  document.getElementById('img-overlay-prev')?.addEventListener('click', window._prevImgEv);
  document.getElementById('img-overlay-next')?.addEventListener('click', window._nextImgEv);
  document.getElementById('img-overlay-close')?.addEventListener('click', window._closeImgEv);

  // Zoom med scroll
  overlayImg.onwheel = function (e) {
    e.preventDefault();
    let currentScale = parseFloat(overlayImg.dataset.scale || '1');
    const zoomFactor = 1.1;
    const newScale = e.deltaY < 0
      ? currentScale * zoomFactor
      : currentScale / zoomFactor;
    const clampedScale = Math.min(Math.max(newScale, 0.1), 10);
    overlayImg.dataset.scale = clampedScale.toFixed(4);
    const tx = parseFloat(overlayImg.dataset.translateX || '0');
    const ty = parseFloat(overlayImg.dataset.translateY || '0');
    overlayImg.style.transform = `scale(${clampedScale}) translate(${tx}px,${ty}px)`;
    isZoomed = clampedScale > 1.02;
  };

  // Drag för pan
  overlayImg.onmousedown = function (e) {
    if (!isZoomed) return;
    e.preventDefault();
    let startX = e.clientX;
    let startY = e.clientY;
    let tx = parseFloat(overlayImg.dataset.translateX || '0');
    let ty = parseFloat(overlayImg.dataset.translateY || '0');
    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      tx += dx;
      ty += dy;
      overlayImg.style.transform = `scale(${overlayImg.dataset.scale}) translate(${tx}px,${ty}px)`;
      overlayImg.dataset.translateX = tx;
      overlayImg.dataset.translateY = ty;
      startX = ev.clientX;
      startY = ev.clientY;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ESC för att stänga overlay
	document.removeEventListener('keydown', window._escListener);
	window._escListener = function escListener(e) {
	  if (overlay.classList.contains('active') && (e.key === 'Escape' || e.key === 'Esc')) {
		overlay.classList.remove('active');
		overlay.classList.remove('no-arrows');
	  }
	};
	document.addEventListener('keydown', window._escListener);

}
window.setupOverlayClassic = setupOverlayClassic;

export function showImgOverlay(url, altText = "") {
  const overlay = document.getElementById('img-overlay');
  const overlayImg = document.getElementById('img-overlay-img');
  if (!overlay || !overlayImg) return;
  overlayImg.src = url;
  overlayImg.alt = altText;
  overlay.classList.add('active');
  // Återställ zoom/drag (om det behövs)
  overlayImg.style.transform = "scale(1) translate(0px,0px)";
  overlayImg.dataset.scale = "1";
  overlayImg.dataset.translateX = "0";
  overlayImg.dataset.translateY = "0";
}

window.renderThumbnail = renderThumbnail;
window.showSDOOverlayWithSlider = showSDOOverlayWithSlider;
window.openOverlayClassic = openOverlayClassic;
