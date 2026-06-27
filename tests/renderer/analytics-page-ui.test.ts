import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const analyticsPageSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'pages', 'AnalyticsPage.tsx'),
    'utf8',
  );

// Round 189 (touch-first, static/code-verified): the AnalyticsPage refresh button still carried a
// native DOM `title` tooltip. Touchscreen-first POS -> no native title tooltips and no hover
// utilities; the accessible name comes from aria-label. (Live QA remains blocked by module
// availability per round 147, so this is a static/code-verified fix only.)
test('AnalyticsPage has no native title tooltips and no hover utilities', () => {
  const source = analyticsPageSource();

  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /dark:hover:/);
  assert.doesNotMatch(source, /group-hover:/);
});

test('AnalyticsPage refresh button keeps aria-label, handler, disabled-loading, icon, and amber glass chrome', () => {
  const source = analyticsPageSource();

  // Accessible name via aria-label (no native title), with the fetch handler + disabled gate intact.
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /onClick=\{\(\) => void fetchAnalytics\(\)\}/);
  assert.match(source, /disabled=\{loading\}/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);

  // Amber glass + active (touch) feedback; spinner on loading.
  assert.match(source, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(source, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(source, /active:scale-95/);
  assert.match(source, /opacity-60 cursor-not-allowed/);
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
});

test('AnalyticsPage keeps warm amber/orange chart accents and no blue/cyan/purple/pink tokens', () => {
  const source = analyticsPageSource();

  assert.match(source, /h-full overflow-y-auto overflow-x-hidden scrollbar-hide p-4/);
  // Warm chart palette preserved.
  assert.match(source, /text-amber-500/);
  assert.match(source, /bg-amber-500/);
  assert.match(source, /from-amber-500 to-orange-500/);
  assert.match(source, /color="bg-zinc-600"/);
  assert.match(source, /color="bg-yellow-500"/);
  assert.match(source, /<BarChart3 className="w-5 h-5 text-yellow-500" \/>/);
  assert.match(source, /className=\{`px-3 py-1\.5 rounded-2xl text-sm font-medium transition-transform active:scale-95/);
  assert.match(source, /<div className=\{`p-2 rounded-2xl \$\{color\}`\}>/);
  assert.match(source, /className=\{`rounded-2xl border px-3 py-3/);

  // No off-palette cool/pink utility tokens and no small-radius leftovers.
  assert.doesNotMatch(source, /(?:border-t-|border-|text-|bg-|ring-|from-|to-|via-)(?:blue|cyan|purple|pink)-/);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /overflow-auto p-4/);
});
