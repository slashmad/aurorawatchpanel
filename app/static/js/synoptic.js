// ---- app/static/js/synoptic.js ----

let synopticImages = [];
let synopticPlayInterval = null;
let synopticCurrentFrame = 0;

export function setupSynopticOverlay() {
  document.querySelector('.synoptic-timelapse-btn').addEventListener('click', () => {
    document.getElementById('synoptic-overlay').classList.add('active');
    document.getElementById('synoptic-date').valueAsDate = new Date();
    document.getElementById('synoptic-image-container').querySelector('img').src = '';
    loadSynopticImages();
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
  document.getElementById('synoptic-overlay').classList.remove('active');
  stopSynoptic();
}

function loadSynopticImages() {
  const date = document.getElementById('synoptic-date').value.replace(/-/g,'');
  fetch(`/images/list?label=Synoptic Map`)
    .then(res => res.json())
    .then(data => {
      synopticImages = (data.files || []).filter(fn => fn.startsWith('Synoptic_' + date));
      document.getElementById('synoptic-slider').max = Math.max(0, synopticImages.length-1);
      synopticCurrentFrame = synopticImages.length - 1;
      showSynopticFrame();
      updateSynopticSlider();
    });
}

function showSynopticFrame() {
  const img = document.getElementById('synoptic-image');
  if (!synopticImages.length) {
    img.src = '';
    img.alt = 'Inga bilder för valt datum';
    return;
  }
  img.src = `/images/${synopticImages[synopticCurrentFrame]}`;
  img.alt = synopticImages[synopticCurrentFrame];
  document.getElementById('synoptic-slider').value = synopticCurrentFrame;
}

function playSynoptic() {
  if (synopticPlayInterval) { stopSynoptic(); return; }
  if (!synopticImages.length) return;
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