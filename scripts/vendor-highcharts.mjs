// Copies the pinned Highcharts build from node_modules into app/static/vendor/
// so the page loads it from its own server instead of code.highcharts.com.
// The files are git-ignored: Highcharts has its own license and is not
// redistributed with this repository.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'highcharts');
const target = join(root, 'app', 'static', 'vendor', 'highcharts');

// Modules the dashboard uses (see index.html): arearange and gauge panes need
// highcharts-more; the Kp/HP30 gauges need solid-gauge; the astro graphs keep
// their export menu; accessibility adds screen-reader support.
const FILES = [
  'highcharts.js',
  'highcharts-more.js',
  'modules/solid-gauge.js',
  'modules/exporting.js',
  'modules/export-data.js',
  'modules/accessibility.js',
];

const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies.highcharts;
const installed = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
if (installed !== pinned) {
  console.error(`highcharts ${installed} is installed but package.json pins ${pinned}; run npm ci.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
for (const file of FILES) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  copyFileSync(join(source, file), join(target, file));
}
console.log(`Highcharts ${installed}: ${FILES.length} files -> app/static/vendor/highcharts/`);
