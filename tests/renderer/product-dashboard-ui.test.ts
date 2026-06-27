import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const dashboardPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'dashboards',
  'ProductDashboard.tsx',
);

test('ProductDashboard uses on-palette touch controls without hover styling', () => {
  const source = readFileSync(dashboardPath, 'utf8');

  assert.match(source, /text-yellow-300/);
  assert.match(source, /text-yellow-700/);
  assert.match(source, /bg-yellow-400 text-black/);
  assert.match(source, /bg-black text-white/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /focus-visible:ring-yellow-400/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|ring-blue-/);
  assert.doesNotMatch(source, /[Ââð�]/);
});
