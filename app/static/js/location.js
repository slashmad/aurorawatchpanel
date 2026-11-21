// static/js/location.js

import { getLocation, setLocation, fetchAndStoreSunMoon } from './state.js';
import { showWeather } from './weather.js';
import { runSection } from './section_errors.js';

let debounceTimeout = null;
function debounce(fn, delay) {
  clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(fn, delay);
}

export function setupLocation() {
  const searchInput    = document.getElementById("location-search");
  const suggestionList = document.getElementById("location-suggestions");
  const infoBox        = document.getElementById("location-info");

  // Default values
  let curLat  = 63.90,
      curLon  = 20.55,
      curName = "Sävar";

  // Initialize from saved state
  const savedState = getLocation();
  if (savedState.lat != null && savedState.lon != null) {
    curLat = savedState.lat;
    curLon = savedState.lon;
  }

  // Load saved name if available
  const savedLoc = localStorage.getItem("auroraLocation");
  if (savedLoc) {
    try {
      const obj = JSON.parse(savedLoc);
      if (obj.name) {
        curName = obj.name;
        searchInput.value = curName;
      }
    } catch (e) {
      console.warn("Failed to parse saved location:", e);
    }
  } else {
    searchInput.value = curName;
  }

const detectBtn = document.getElementById("detect-location-btn");
if (detectBtn) {
  detectBtn.onclick = async function() {
    detectBtn.disabled = true;
    detectBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Detecting…';
    if (!navigator.geolocation) {
      alert("Geolocation not supported in your browser.");
      detectBtn.disabled = false;
      detectBtn.innerHTML = '<i class="fa fa-crosshairs"></i> Use my location';
      return;
    }
    navigator.geolocation.getCurrentPosition(async function(pos) {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // Hämta platsnamn och tidszon
      let placename = "Your position";
      let countryCode = "";
      let tz = "Europe/Stockholm";
      try {
        // Reverse geocode för platsnamn
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
        const data = await res.json();
        placename = data.display_name || placename;
        countryCode = data.address?.country_code?.toUpperCase() || "SE";
      } catch (e) {}
      try {
        // Timezone
        const tzResp = await fetch(`/api/timezone?lat=${lat}&lon=${lon}`);
        const tzJson = await tzResp.json();
        if (tzJson.tz) tz = tzJson.tz;
      } catch (e) {}

      // Spara och uppdatera
      localStorage.setItem("auroraLocation", JSON.stringify({ lat, lon, name: placename, tz, country: countryCode }));
      localStorage.setItem('tz', tz);
      localStorage.setItem('country', countryCode);
      localStorage.setItem('placename', placename);
      setLocation(lat, lon, tz, countryCode, placename);

      // Sätt sökrutan och infobox
      document.getElementById("location-search").value = placename;
      infoBox.innerHTML = `
        <b>Live data for your location:</b><br>
        ${placename}<br>
        <span style="font-size:0.75em;color:#ccc">
          Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}
        </span>`;

      // Hämta ny sol/moon/väderdata
      await fetchAndStoreSunMoon();
      runSection('E-WEATHER', '#weather-card-container', () => showWeather());
      if (window.setAuroraForecastLocation) window.setAuroraForecastLocation(lat, lon);

      detectBtn.disabled = false;
      detectBtn.innerHTML = '<i class="fa fa-crosshairs"></i>Detect';
    }, function(err) {
      alert("Failed to get location: " + err.message);
      detectBtn.disabled = false;
      detectBtn.innerHTML = '<i class="fa fa-crosshairs"></i>Detect';
    }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  };
}


function updateAll(callSetAurora = true, tzOverride = null) {
  setLocation(curLat, curLon, tzOverride || savedState.tz || "Europe/Stockholm");
  let city = curName, region = "", country = "";
  if (curName && curName.split(",").length >= 3) {
    const parts = curName.split(",").map(s => s.trim());
    city    = parts[0];
    region  = parts.find(s => /(kommun|county|region|municipality)/i.test(s)) || "";
    country = parts[parts.length-1];
    if (/kommun/i.test(region)) {
      region = region.replace(/kommun/i, "County");
    }
  }
  infoBox.innerHTML = `
    <b>Live data for your location:</b><br>
    ${city}${region ? ", " + region : ""}${country ? ", " + country : ""}<br>
    <span style="font-size:0.7em;color:#ccc">
      Lat: ${curLat.toFixed(2)}, Lon: ${curLon.toFixed(2)}
    </span>`;

  fetchAndStoreSunMoon().then(() => {
    runSection('E-WEATHER', '#weather-card-container', () => showWeather());
    if (callSetAurora && window.setAuroraForecastLocation) {
      window.setAuroraForecastLocation(curLat, curLon);
    }
  });
}
  async function searchLocation(q) {
    if (!q || q.length < 2) {
      suggestionList.classList.add("hidden");
      suggestionList.innerHTML = "";
      return;
    }
    const url = `https://nominatim.openstreetmap.org/search?` +
                `format=json&q=${encodeURIComponent(q)}` +
                `&limit=8&accept-language=en`;
    try {
      const res = await fetch(url);
      const places = await res.json();
      suggestionList.innerHTML = places.map(p =>
        `<li data-lat="${p.lat}" data-lon="${p.lon}" data-name="${p.display_name}">` +
           `${p.display_name}` +
         `</li>`
      ).join("");
      suggestionList.classList.remove("hidden");
    } catch (err) {
      console.error("Nominatim-search failed:", err);
    }
  }

  searchInput.addEventListener("input", e => {
    debounce(() => searchLocation(e.target.value), 350);
  });

suggestionList.addEventListener("click", async e => {
  if (e.target.tagName !== "LI") return;
  curLat  = parseFloat(e.target.dataset.lat);
  curLon  = parseFloat(e.target.dataset.lon);
  curName = e.target.dataset.name;   // <-- Platsnamnet

  searchInput.value = curName;
  suggestionList.classList.add("hidden");

  // ---- Hämta tidszon från backend ----
  let tz = "Europe/Stockholm";
  try {
    const tzResp = await fetch(`/api/timezone?lat=${curLat}&lon=${curLon}`);
    const tzJson = await tzResp.json();
    if (tzJson.tz) tz = tzJson.tz;
  } catch (e) {
    console.warn("Kunde inte hämta tidszon, defaultar till Europe/Stockholm", e);
  }

  // ---- Hämta country-code från Nominatim ----
  let countryCode = "";
  try {
    const detailsUrl = `https://nominatim.openstreetmap.org/reverse?lat=${curLat}&lon=${curLon}&format=json`;
    const res = await fetch(detailsUrl);
    const data = await res.json();
    countryCode = data.address?.country_code?.toUpperCase() || "";
  } catch (e) {
    countryCode = "";
  }

  // ---- Sätt plats, tidszon, country OCH placename i state/localStorage ----
  localStorage.setItem(
    "auroraLocation",
    JSON.stringify({
      lat: curLat,
      lon: curLon,
      name: curName,
      tz,
      country: countryCode
    })
  );
  localStorage.setItem('tz', tz);
  localStorage.setItem('country', countryCode);
  localStorage.setItem('placename', curName);
  setLocation(curLat, curLon, tz, countryCode, curName);

  // ---- Anropa updateAll med nya tz! ----
  updateAll(true, tz);
});

  document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrapper")) {
      suggestionList.classList.add("hidden");
    }
  });

  // Första render
  updateAll(true);

}