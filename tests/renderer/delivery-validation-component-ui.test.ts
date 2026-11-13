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
  // Founder 11/11/2026: the address field is the kit's frosted field (its focus outline lives in the
  // kit, .pos-glass-field:focus-visible) and the result block is the kit's frosted card.
  assert.match(source, /className="pos-glass-field w-full py-2\.5 pl-10 pr-4"/);
  assert.match(source, /className="pos-glass-form-card space-y-3"/);
  assert.match(source, /fixed inset-0 z-1200(?![\w.-])[^"]*bg-black\/45 backdrop-blur-md/);
  assert.match(source, /rounded-\[28px\][^"]*bg-white\/72[^"]*backdrop-blur-2xl/);
  assert.match(source, /active:scale-\[0\.98\]/);
  assert.match(source, /focus-visible:ring-\(--pos-s-fg\)/);
  assert.match(source, /bg-red-600/);
  assert.match(source, />\s*Cancel\s*</);
});
