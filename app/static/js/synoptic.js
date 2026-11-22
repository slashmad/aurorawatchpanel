// ---- app/static/js/synoptic.js ----

let synopticImages = [];
let synopticPlayInterval = null;
let synopticCurrentFrame = 0;

let loadVersion = 0;

export function openSynopticOverlay(latestFile) {
  const timestamp = latestFile?.match(/Synoptic_(\d{4})(\d{2})(\d{2})T/);
  const input = document.getElementById('synoptic-date');
  input.value = timestamp ? timestamp.slice(1, 4).join('-') : new Date().toISOString().slice(0, 10);
  document.getElementById('synoptic-overlay').classList.add('active');
  return loadSynopticImages();
}

export function setupSynopticOverlay() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('synoptic-overlay').classList.contains('active')) closeSynopticOverlay();
  });
  document.getElementById('synoptic-close').onclick = closeSynopticOverlay;
  document.getElementById('synoptic-date').onchange = loadSynopticImages;
  document.getElementById('synoptic-slider').oninput = (e) => {
    synopticCurrentFrame = parseInt(e.target.value, 10);
    showSynopticFrame();
  };
  document.getElementById('synoptic-play').onclick = playSynoptic;
}

function closeSynopticOverlay() {
  loadVersion++;
  document.getElementById('synoptic-overlay').classList.remove('active');
  stopSynoptic();
}

async function loadSynopticImages() {
  const version = ++loadVersion;
  const day = document.getElementById('synoptic-date').value;
  stopSynoptic();
  synopticImages = [];
  synopticCurrentFrame = 0;
  showSynopticFrame();
  updateSynopticSlider();
  if (!day) return;
  try {
    const res = await fetch(`/images/list?label=Synoptic%20Map&day=${encodeURIComponent(day)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (version !== loadVersion) return;
    synopticImages = data.files.slice().reverse();
    synopticCurrentFrame = Math.max(0, synopticImages.length - 1);
    showSynopticFrame();
    updateSynopticSlider();
  } catch (error) {
    if (version === loadVersion) document.getElementById('synoptic-image').alt = 'Could not load images for this date';
  }
}

function showSynopticFrame() {
  const img = document.getElementById('synoptic-image');
  if (!synopticImages.length) {
    img.removeAttribute('src');
    img.alt = 'No images for the selected UTC date';
    return;
  }
  img.src = `/images/${synopticImages[synopticCurrentFrame]}`;
  img.alt = synopticImages[synopticCurrentFrame];
  document.getElementById('synoptic-slider').value = synopticCurrentFrame;
}

function playSynoptic() {
  if (synopticPlayInterval) { stopSynoptic(); return; }
  if (!synopticImages.length) return;
  if (synopticCurrentFrame === synopticImages.length - 1) {
    synopticCurrentFrame = 0;
    showSynopticFrame();
  }
  synopticPlayInterval = setInterval(() => {
    if (synopticCurrentFrame < synopticImages.length - 1) {
      synopticCurrentFrame++;
      showSynopticFrame();
    } else {
      stopSynoptic();
    }
  }, 150); // ca 6 fps
  updateSynopticPlayBtn();
}
function stopSynoptic() {
  if (synopticPlayInterval) clearInterval(synopticPlayInterval);
  synopticPlayInterval = null;
  updateSynopticPlayBtn();
}
function updateSynopticPlayBtn() {
  document.getElementById('synoptic-play').innerHTML =
    synopticPlayInterval ? '<i class="fa fa-pause"></i>' : '<i class="fa fa-play"></i>';
}
function updateSynopticSlider() {
  const slider = document.getElementById('synoptic-slider');
  slider.disabled = !synopticImages.length;
  slider.value = synopticCurrentFrame;
  slider.max = Math.max(0, synopticImages.length-1);
}

export default { setupSynopticOverlay };