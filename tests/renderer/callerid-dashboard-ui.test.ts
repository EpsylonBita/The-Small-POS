import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const callerIdPopupPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'callerid',
  'CallerIdPopup.tsx',
);
const dashboardCardPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'DashboardCard.tsx',
);

test('CallerIdPopup uses touch-safe on-palette actions', () => {
  const source = readFileSync(callerIdPopupPath, 'utf8');

  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|ring-blue-/);
  // Close: labelled, with press feedback and a visible focus ring.
  assert.match(source, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
  assert.match(source, /active:scale-95 active:bg-white\/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300\/80/);
  // Since 27/07/2026 the toast's only action opens the customer search with the caller's
  // number (amber, touch height, press feedback). The green "Start Order" action is gone:
  // the toast never starts or changes operational work.
  assert.match(source, /onSearchCustomer\(\)/);
  assert.match(source, /min-h-9 [^"]*bg-amber-400 [^"]*active:scale-\[0\.98\] active:bg-amber-500/);
  assert.match(source, /t\('callerid\.popup\.searchCustomer', 'Search customer'\)/);
  assert.doesNotMatch(source, /onStartOrder|startOrder|ShoppingCart/);
});

test('DashboardCard maps legacy blue/purple variants onto the POS palette without hover motion', () => {
  const source = readFileSync(dashboardCardPath, 'utf8');

  assert.doesNotMatch(source, /bg-blue-|text-blue-|ring-blue-/);
  assert.doesNotMatch(source, /bg-purple-|text-purple-/);
  assert.doesNotMatch(source, /hover:/);
  assert.match(source, /blue: \{\s*bg: \{ light: 'bg-amber-50'/);
  assert.match(source, /purple: \{\s*bg: \{ light: 'bg-zinc-100'/);
  assert.match(source, /rounded-2xl border p-6/);
  assert.match(source, /transition-transform active:scale-\[0\.98\]/);
  assert.match(source, /focus:ring-amber-400/);
});
