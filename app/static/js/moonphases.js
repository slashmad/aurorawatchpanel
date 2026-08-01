// ---- app/static/js/moonphases.js

export const moonPhases = [
  { file: "/data/icons/moon-full.svg", illum: 99.81, posAngle:   4.22 },
  { file: "/data/icons/moon-full.svg", illum: 98.82, posAngle: 358.995 },
  { file: "/data/icons/moon-waning-gibbous.svg", illum: 95.86, posAngle: 353.799 },
  { file: "/data/icons/moon-waning-gibbous.svg", illum: 90.96, posAngle: 349.024 },
  { file: "/data/icons/moon-waning-gibbous.svg", illum: 84.23, posAngle: 344.969 },
  { file: "/data/icons/moon-waning-gibbous.svg", illum: 75.85, posAngle: 341.803 },
  { file: "/data/icons/moon-waning-gibbous.svg", illum: 66.11, posAngle: 339.59 },
  { file: "/data/icons/moon-last-quarter.svg", illum: 55.39, posAngle: 338.349 },
  { file: "/data/icons/moon-last-quarter.svg", illum: 44.16, posAngle: 338.109 },
  { file: "/data/icons/moon-waning-crescent.svg", illum: 32.99, posAngle: 338.939 },
  { file: "/data/icons/moon-waning-crescent.svg", illum: 22.54, posAngle: 340.953 },
  { file: "/data/icons/moon-waning-crescent.svg", illum: 13.48, posAngle: 344.264 },
  { file: "/data/icons/moon-waning-crescent.svg", illum:  6.45, posAngle: 348.876 },
  { file: "/data/icons/moon-new.svg", illum:  1.93, posAngle: 354.546 },
  { file: "/data/icons/moon-new.svg", illum:  0.20, posAngle:   0.722 },
  { file: "/data/icons/moon-new.svg", illum:  1.26, posAngle:   6.689 },
  { file: "/data/icons/moon-waxing-crescent.svg", illum:  4.87, posAngle:  11.854 },
  { file: "/data/icons/moon-waxing-crescent.svg", illum: 10.63, posAngle:  15.92 },
  { file: "/data/icons/moon-waxing-crescent.svg", illum: 18.05, posAngle:  18.851 },
  { file: "/data/icons/moon-waxing-crescent.svg", illum: 26.63, posAngle:  20.744 },
  { file: "/data/icons/moon-waxing-crescent.svg", illum: 35.91, posAngle:  21.719 },
  { file: "/data/icons/moon-first-quarter.svg", illum: 45.51, posAngle:  21.866 },
  { file: "/data/icons/moon-first-quarter.svg", illum: 55.11, posAngle:  21.227 },
  { file: "/data/icons/moon-waxing-gibbous.svg", illum: 64.40, posAngle:  19.795 },
  { file: "/data/icons/moon-waxing-gibbous.svg", illum: 73.14, posAngle:  17.539 },
  { file: "/data/icons/moon-waxing-gibbous.svg", illum: 81.07, posAngle:  14.424 },
  { file: "/data/icons/moon-waxing-gibbous.svg", illum: 87.94, posAngle:  10.461 },
  { file: "/data/icons/moon-waxing-gibbous.svg", illum: 93.48, posAngle:   5.762 },
  { file: "/data/icons/moon-full.svg", illum: 97.42, posAngle:   0.576 }
];

export function getNearestMoonPhase(currentIllum, waxing) {
  let best = null, minDiff = Infinity;
  // Waxing = index 14–28, Waning = index 0–14.
  let start = waxing ? 14 : 0;
  let end   = waxing ? 29 : 15; // OBS: end är EXKLUSIV i JS slice!
  for (let i = start; i < end; ++i) {
    const phase = moonPhases[i];
    const diff = Math.abs(currentIllum - phase.illum);
    if (diff < minDiff) {
      minDiff = diff;
      best = phase;
    }
  }
  // Fallback: om inget hittas (extremt osannolikt)
  if (!best) {
    best = moonPhases[waxing ? 14 : 0];
  }
  return best;
}
