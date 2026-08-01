// ---- app/static/js/enlil-multi.js ----
import { openOverlayClassic } from './images.js';

const ENLIL_PRODUCTS = [
  { label: "WSA-ENLIL",    folder: "enlil"    },
  { label: "CCOR1",    folder: "ccor1"    },
  { label: "LASCO C2", folder: "lasco-c2" },
  { label: "LASCO C3", folder: "lasco-c3" }
];

const imageData = {};   // label -> [filnamn]
const indices = {};     // label -> index (frame)
let playInterval = null;
let currentLabel = null;

function cleanupEnlilOverlay() {
  // Ta bort ENLIL-specifik UI
  document.getElementById('enlil-slider-box')?.remove();

  // Återställ variabler
  playInterval = null;
  currentLabel = null;

  // Ta bort overlay-eventhandlers som lagts till av ENLIL (undvik minnesläckor!)
  const overlay = document.getElementById('img-overlay');
  if (overlay) {
    // Sätt tillbaka original onclick
    overlay.onclick = null;
    const closeBtn = overlay.querySelector('#img-overlay-close');
    if (closeBtn) closeBtn.onclick = null;
    const prevBtn = overlay.querySelector('#img-overlay-prev');
    if (prevBtn) prevBtn.onclick = null;
    const nextBtn = overlay.querySelector('#img-overlay-next');
    if (nextBtn) nextBtn.onclick = null;
  }
}

async function loadEnlilPreviews() {
  for (const prod of ENLIL_PRODUCTS) {
    // Hämta filnamn för aktuell produkt från backend
    const res = await fetch(`/noaa_anim/list/${prod.folder}`);
    const json = await res.json();
    const files = json.files || [];
    imageData[prod.label] = files;
    indices[prod.label] = 0;

    // Här väljer vi bild-elementet med rätt ID, tex: enlil-img, ccor1-img, lasco-c2-img, lasco-c3-img
    const imgEl = document.getElementById(`${prod.folder}-img`);
    if (imgEl && files.length) {
      // Sätt src till senaste bild (snyggast) – byt ut 0 mot files.length-1:
      imgEl.src = `/data/noaa_anim/${prod.folder}/${files[files.length-1]}`;
      imgEl.style.cursor = "pointer";
      imgEl.title = prod.label + " – klicka för overlay";
      imgEl.onclick = () => {
        indices[prod.label] = files.length-1;
        showMultiOverlay(prod.label);
      }
    }
  }
}


// Overlay + slider + play för valfri produkt
function showMultiOverlay(label) {
  cleanupEnlilOverlay();
  currentLabel = label;
  openOverlayClassic(""); // öppna overlay utan label, vi hanterar bilden själva

  const overlay = document.getElementById('img-overlay');
  const overlayImg = document.getElementById('img-overlay-img');

  // Ta bort ev. gammal UI
  document.getElementById('enlil-slider-box')?.remove();

  if (imageData[label] && imageData[label].length > 1) {
    // Skapa slider + play/paus
    const box = document.createElement('div');
    box.id = 'enlil-slider-box';
    box.style = 'position:absolute; top:25px; left:50%; transform:translateX(-50%); background:rgba(20,24,28,0.88); border-radius:0.6em; padding:0.3em 1em 0.3em 1em; display:flex; gap:0.7em; align-items:center; z-index:10100;';
    box.innerHTML = `
      <button id="enlil-play-btn" title="Play"><i class="fa fa-play"></i></button>
      <input type="range" id="enlil-slider" min="0" max="${imageData[label].length-1}" value="0" style="width:280px;">
      <span id="enlil-slider-label" style="font-size:0.92em;color:#ccc"></span>
      <span id="enlil-overlay-product-tabs"></span>
    `;
    overlay.appendChild(box);

    // Tabs för att byta produkt direkt i overlay
    const tabs = box.querySelector('#enlil-overlay-product-tabs');
    tabs.innerHTML = ENLIL_PRODUCTS.map(prod =>
      `<button class="enlil-prodtab" data-prod="${prod.label}" style="margin-left:7px; font-size:1em; border-radius:6px; background:${label===prod.label?'#256fff':'#1a222a'}; color:#fff; border:none; cursor:pointer; padding:1px 7px;">${prod.label}</button>`
    ).join("");
    tabs.querySelectorAll("button").forEach(btn =>
      btn.onclick = () => {
        stopEnlilPlay();
        showMultiOverlay(btn.dataset.prod);
      }
    );

    // Bildnavigering
    const slider = box.querySelector('#enlil-slider');
    const labelEl = box.querySelector('#enlil-slider-label');
    const updateFrame = idx => {
      indices[label] = idx;
      overlayImg.src = `/data/noaa_anim/${ENLIL_PRODUCTS.find(p => p.label === label).folder}/${imageData[label][idx]}`;
      labelEl.textContent = "";
    };

    slider.oninput = e => {
      stopEnlilPlay();
      updateFrame(Number(e.target.value));
    };

    // Play-knapp
    const playBtn = box.querySelector('#enlil-play-btn');
    playBtn.onclick = () => {
      if (playInterval) {
        stopEnlilPlay();
      } else {
        playBtn.innerHTML = '<i class="fa fa-pause"></i>';
        playInterval = setInterval(() => {
          let idx = indices[label] + 1;
          if (idx >= imageData[label].length) idx = 0;
          slider.value = idx;
          updateFrame(idx);
        }, 60);
      }
    };

    function stopEnlilPlay() {
      playBtn.innerHTML = '<i class="fa fa-play"></i>';
      if (playInterval) clearInterval(playInterval);
      playInterval = null;
    }

    // Stäng overlay => ta bort slider, stoppa play
	const closeOverlay = () => {
	  stopEnlilPlay();
	  cleanupEnlilOverlay();
	  overlay.classList.remove('active');
	};
    overlay.querySelector('#img-overlay-close').onclick = e => closeOverlay();
    overlay.onclick = e => {
      if (e.target === overlay) closeOverlay();
    };

    // Piltangenter, pilknappar
    const prevBtn = overlay.querySelector('#img-overlay-prev');
    const nextBtn = overlay.querySelector('#img-overlay-next');
    if (prevBtn && nextBtn) {
      prevBtn.onclick = e => {
        e.stopPropagation();
        stopEnlilPlay();
        let idx = indices[label] - 1;
        if (idx < 0) idx = imageData[label].length - 1;
        slider.value = idx;
        updateFrame(idx);
      };
      nextBtn.onclick = e => {
        e.stopPropagation();
        stopEnlilPlay();
        let idx = indices[label] + 1;
        if (idx >= imageData[label].length) idx = 0;
        slider.value = idx;
        updateFrame(idx);
      };
    }

    // Starta på första bild
    updateFrame(0);
    slider.value = 0;
  } else if (imageData[label] && imageData[label].length === 1) {
    // Endast en bild – visa den utan slider/play
    overlayImg.src = `/data/noaa_anim/${ENLIL_PRODUCTS.find(p => p.label === label).folder}/${imageData[label][0]}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadEnlilPreviews();
});

window.loadEnlilPreviews = loadEnlilPreviews;
window.showMultiOverlay = showMultiOverlay;