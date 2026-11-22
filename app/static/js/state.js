// static/js/state.js

// Module for managing application state: latitude, longitude, and timezone
// Initializes from localStorage if available

let lat = localStorage.getItem('lat')
  ? parseFloat(localStorage.getItem('lat'))
  : null;
let lon = localStorage.getItem('lon')
  ? parseFloat(localStorage.getItem('lon'))
  : null;
let tz = localStorage.getItem('tz') || null;
let country = localStorage.getItem('country') || "SE";
let placename = localStorage.getItem('placename') || "Sävar";

let sunData = null;
let moonData = null;

/**
 * Sets the current location and timezone in state and persists to localStorage.
 * @param {number} newLat - Latitude in decimal degrees
 * @param {number} newLon - Longitude in decimal degrees
 * @param {string} newTz - IANA timezone string (e.g., "Europe/Stockholm")
 */
export function setLocation(newLat, newLon, newTz, newCountry = null, newPlacename = null) {
  if (newLat !== lat || newLon !== lon || newTz !== tz) {
    sunData = null;
    moonData = null;
  }
  lat = newLat;
  lon = newLon;
  tz  = newTz;
  if (newCountry) {
    country = newCountry;
    localStorage.setItem('country', newCountry);
  }
  if (newPlacename) {
    placename = newPlacename;
    localStorage.setItem('placename', newPlacename);
  }
  localStorage.setItem('lat', newLat);
  localStorage.setItem('lon', newLon);
  localStorage.setItem('tz', newTz);
}

// --- Uppdaterad getLocation ---
export function getLocation() {
  return {
    lat: lat !== null ? lat : 63.90,
    lon: lon !== null ? lon : 20.55,
    tz:  tz  || 'Europe/Stockholm',
    country: country || "SE",
    name: placename || "Sävar"
  };
}

/**
 * Fetch sun- and moon-data from API and store them in state.
 * This should köras vid sidstart eller platsbyte.
 */
export async function fetchAndStoreSunMoon() {
  const { lat, lon, tz } = getLocation();
  try {
    // Fetch sun-data and moon-data parallellt
    const [sunRes, moonRes] = await Promise.all([
      fetch(`/astro/sun?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`),
      fetch(`/astro/moon?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}`)
    ]);
    if (!sunRes.ok || !moonRes.ok) {
      console.error("Failed to fetch sun or moon:", sunRes.status, moonRes.status);
      return;
    }
    const [sun, moon] = await Promise.all([sunRes.json(), moonRes.json()]);
    const current = getLocation();
    if (lat === current.lat && lon === current.lon && tz === current.tz) {
      sunData = sun;
      moonData = moon;
    }
  } catch (e) {
    console.error("Error in fetchAndStoreSunMoon:", e);
  }
}

/** Returnerar sparad sol-data eller null om den inte finns */
export function getSunData() {
  return sunData;
}

/** Returnerar sparad måne-data eller null om den inte finns */
export function getMoonData() {
  return moonData;
}

/**
 * Clears the saved location and timezone from state and localStorage.
 */
export function clearLocation() {
  sunData = null;
  moonData = null;
  lat = null;
  lon = null;
  tz = null;
  localStorage.removeItem('lat');
  localStorage.removeItem('lon');
  localStorage.removeItem('tz');
}
