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
  assert.match(source, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
  assert.match(source, /bg-amber-400/);
  assert.match(source, /active:bg-amber-500/);
  assert.match(source, /bg-green-600/);
  assert.match(source, /active:bg-green-700/);
  assert.match(source, /focus-visible:ring-amber-300\/80/);
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
