import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const source = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'delivery', 'DeliveryValidationComponent.tsx'),
  'utf8',
);

test('delivery validation uses touch-first amber glass styling', () => {
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /blue-|cyan-|purple-|orange-/);
  assert.doesNotMatch(source, /focus:ring-blue/);
  assert.doesNotMatch(source, /rounded-lg/);

  assert.match(source, /text-amber-600 dark:text-amber-300/);
  assert.match(source, /focus:ring-2 focus:ring-amber-400\/35/);
  assert.match(source, /rounded-\[22px\][^"]*backdrop-blur-xl/);
  assert.match(source, /fixed inset-0 z-\[1200\][^"]*bg-black\/45 backdrop-blur-md/);
  assert.match(source, /rounded-\[28px\][^"]*bg-white\/72[^"]*backdrop-blur-2xl/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /focus-visible:ring-amber-300\/80/);
  assert.match(source, /bg-red-600/);
  assert.match(source, />\s*Cancel\s*</);
});
