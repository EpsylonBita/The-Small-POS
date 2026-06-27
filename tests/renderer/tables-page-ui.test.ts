import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'TablesPage.tsx'),
  'utf8',
);

test('TablesPage keeps table controls rounded, touch-first, and on-palette', () => {
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  assert.match(source, /w-10 h-10 rounded-2xl flex items-center justify-center text-lg font-bold/);
  assert.match(source, /flex items-center gap-1\.5 px-2\.5 py-1 rounded-2xl text-xs font-medium/);
  assert.match(source, /px-3 py-1\.5 rounded-2xl text-xs font-medium/);
  assert.match(source, /px-4 py-2 rounded-2xl text-sm font-medium/);
  assert.match(source, /p-2 rounded-2xl/);
  assert.match(source, /w-8 h-8 rounded-2xl flex items-center justify-center/);
});

test('TablesPage preserves table workflow handlers while smoothing chrome', () => {
  assert.match(source, /onClick=\{onPress\}/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /onClick=\{\(\) => handleStatusChange\(status\)\}/);
  assert.match(source, /onClick=\{handleReset\}/);
  assert.match(source, /onClick=\{\(\) => setFilter\(f => \(\{ \.\.\.f, statusFilter: f\.statusFilter === key \? 'all' : key \}\)\)\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
});
