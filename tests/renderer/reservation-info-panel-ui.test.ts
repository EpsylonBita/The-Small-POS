import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'tables', 'ReservationInfoPanel.tsx');

test('ReservationInfoPanel uses rounded translucent glass panel and cards', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const panelClass = `w-80 rounded-3xl border p-6 shadow-2xl backdrop-blur-xl/);
  assert.match(source, /border-white\/10 bg-black\/78 shadow-black\/45/);
  assert.match(source, /border-black\/10 bg-white\/82 shadow-black\/18/);
  assert.match(source, /const detailCardClass = `rounded-2xl border p-3/);
  assert.match(source, /className=\{detailCardClass\}/);
  assert.match(source, /rounded-2xl border px-3 py-2 text-center/);
  assert.match(source, /text-yellow-200/);
  assert.match(source, /text-yellow-800/);
});

test('ReservationInfoPanel is touch-first with labelled close and semantic actions', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const closeButtonClass = `inline-flex h-10 w-10 items-center justify-center rounded-2xl/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close', \{ defaultValue: 'Close' \}\)\}/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /onClick=\{handleSeatGuest\}/);
  assert.match(source, /bg-green-600 py-3/);
  assert.match(source, /active:scale-\[0\.98\] active:bg-green-700/);
  assert.match(source, /border-red-400\/30 bg-red-500\/12 text-red-300/);
  assert.match(source, /border-red-500\/25 bg-red-50 text-red-700/);
  assert.match(source, /type="button"/);
});

test('ReservationInfoPanel preserves seating behavior and removes legacy blue hover chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /await reservationsService\.updateStatus\(reservation\.id, 'seated'\)/);
  assert.match(source, /await reservationsService\.updateTableStatus\(tableId, 'occupied'\)/);
  assert.match(source, /onSeatGuest\?\.\(reservation\)/);
  assert.match(source, /onNavigateToMenu\(tableId, tableNumber\)/);
  assert.match(source, /onClose\(\)/);
  assert.match(source, /<Loader2 className="w-8 h-8 animate-spin text-yellow-400" \/>/);
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue|blue-500|blue-600|blue-700/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});
