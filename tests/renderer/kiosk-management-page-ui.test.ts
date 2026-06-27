import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const pagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'KioskManagementPage.tsx');
const source = readFileSync(pagePath, 'utf8');

test('KioskManagementPage is touch-first and on-theme', () => {
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/, 'kiosk page must not rely on hover states');
  assert.doesNotMatch(source, /\btitle=/, 'touch POS controls should not expose native title tooltips');
  assert.doesNotMatch(
    source,
    /\b(?:bg|text|border|ring|from|to|via|focus:ring)-(?:blue|cyan|sky|indigo|purple|pink)-/,
    'kiosk page must not use off-theme blue/purple/cyan styling',
  );
  assert.doesNotMatch(source, /rounded-lg|rounded-xl/, 'visible Kiosk surfaces should use smoother radii');
});

test('KioskManagementPage uses amber/yellow touch controls and hidden page scrollbar', () => {
  assert.match(source, /overflow-auto scrollbar-hide/);
  assert.match(source, /border-b-2 border-yellow-400/);
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(source, /border border-yellow-400\/40 bg-yellow-400\/12 text-yellow-100 active:bg-yellow-400\/20/);
  assert.match(source, /border border-yellow-400\/60 bg-yellow-50 text-yellow-700 active:bg-yellow-100/);
});

test('KioskManagementPage stat and order fallback tones stay semantic or neutral', () => {
  assert.match(source, /color: 'yellow' \| 'green' \| 'amber'/);
  assert.match(source, /yellow: isDark \? 'bg-yellow-400\/15 text-yellow-300' : 'bg-yellow-100 text-yellow-700'/);
  assert.match(source, /green: isDark \? 'bg-green-900\/30 text-green-400' : 'bg-green-100 text-green-600'/);
  assert.match(source, /amber: isDark \? 'bg-amber-900\/30 text-amber-400' : 'bg-amber-100 text-amber-600'/);
  assert.match(source, /: isDark \? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-700'/);
  assert.doesNotMatch(source, /color="blue"|color="purple"/);
});
