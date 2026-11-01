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
  assert.match(source, /border border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) text-\(--pos-s-fg\) active:bg-\(--pos-s-border\)/);
  assert.match(source, /border border-\(--pos-s-yellow\) bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-200 active:bg-\(--pos-s-surface-2\)/);
  assert.match(source, /border border-\(--pos-s-yellow\) bg-\(--pos-s-surface-2\) text-yellow-700 active:bg-\(--pos-s-surface-2\)/);
});

test('KioskManagementPage stat and order fallback tones stay semantic or neutral', () => {
  assert.match(source, /color: 'yellow' \| 'green' \| 'amber'/);
  assert.match(source, /yellow: isDark \? 'bg-\(--pos-s-surface-2\) text-yellow-800 dark:text-yellow-200' : 'bg-\(--pos-s-surface-2\) text-yellow-700'/);
  assert.match(source, /green: isDark \? 'bg-\(--pos-s-surface-2\) text-green-800 dark:text-green-300' : 'bg-\(--pos-s-surface-2\) text-green-800 dark:text-green-300'/);
  assert.match(source, /amber: isDark \? 'bg-\(--pos-s-surface-2\) text-amber-800 dark:text-amber-300' : 'bg-\(--pos-s-surface-2\) text-amber-800 dark:text-amber-300'/);
  assert.match(source, /: isDark \? 'bg-zinc-800 text-zinc-300' : 'bg-zinc-100 text-zinc-700'/);
  assert.doesNotMatch(source, /color="blue"|color="purple"/);
});
