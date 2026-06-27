import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'ui', 'ConfirmDialog.tsx'),
  'utf8',
);

test('ConfirmDialog keeps shared confirmation modals amber glass and touch-first', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /cyan-|yellow-|blue-|purple-|orange-/);
  assert.doesNotMatch(source, /focus:ring-cyan/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /rounded-md/);

  assert.match(source, /color: 'text-amber-300'/);
  assert.match(source, /bgIcon: 'bg-amber-400\/18'/);
  assert.match(source, /rounded-2xl[^"]*active:scale-\[0\.99\]/);
  assert.match(source, /h-5 w-5 rounded-xl border-white\/30/);
  assert.match(source, /text-amber-400/);
  assert.match(source, /focus:ring-2 focus:ring-amber-300\/80/);
  assert.match(source, /<LiquidGlassModal/);
});
