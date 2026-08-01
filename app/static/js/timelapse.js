// ---- app/static/js/timelapse.js ----

export function setupTimelapseOverlay() {
  document.querySelectorAll('.timelapse-btn').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('timelapse-overlay').classList.add('active');
      document.getElementById('timelapse-type').value = btn.dataset.type || "SDO_195_";
      document.getElementById('timelapse-date').valueAsDate = new Date();
      document.getElementById('timelapse-video-container').innerHTML = "";
    };
  });

  document.getElementById('timelapse-close').onclick = () =>
    document.getElementById('timelapse-overlay').classList.remove('active');
  document.getElementById('timelapse-show').onclick = showTimelapse;
}
window.setupTimelapseOverlay = setupTimelapseOverlay;

async function showTimelapse() {
  const date = document.getElementById('timelapse-date').value.replace(/-/g, '');
  const type = document.getElementById('timelapse-type').value;
  const filename = `${type}${date}.mp4`;

  const year = date.substring(0, 4);
  const month = date.substring(4, 6);
  const cleanType = type.endsWith('_') ? type.slice(0, -1) : type;
  const url = `/data/suvi-timelapse/${cleanType}/${year}/${month}/${filename}`;

  const container = document.getElementById('timelapse-video-container');
  try {
    const resp = await fetch(url, { method: 'HEAD' });
    if (resp.ok) {
      container.innerHTML = `
        <video controls autoplay style="background:#000; border-radius:0.5em; max-width:92vw; max-height:76vh;">
          <source src="${url}" type="video/mp4">
          Your browser can't play this video.
        </video>
        <div style="color:#ccc;font-size:1em; margin-top:0.7em;">${filename}</div>
      `;
    } else {
      container.innerHTML = `<div style="color:#ff7575; font-size:1em; margin-top:2em;">No video from this date</div>`;
    }
  } catch {
    container.innerHTML = `<div style="color:#ff7575; font-size:1em; margin-top:2em;">No video from this date</div>`;
  }
}

export default { setupTimelapseOverlay };