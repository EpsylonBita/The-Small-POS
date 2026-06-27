import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'DeliveryValidationTestPage.tsx'),
  'utf8',
);

test('DeliveryValidationTestPage uses the app palette and touch-first chrome', () => {
  assert.match(source, /className="min-h-screen bg-black p-6"/);
  assert.match(source, /bg-white\/10 backdrop-blur-sm rounded-2xl p-6/);
  assert.match(source, /bg-amber-500\/15 active:bg-amber-500\/25 border border-amber-400\/30 rounded-2xl/);
  assert.match(source, /transition-transform active:scale-\[0\.98\]/);
  assert.doesNotMatch(source, /from-purple|via-blue|to-indigo/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue/);
  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
});

test('DeliveryValidationTestPage avoids mojibake and hides raw JSON scrollbars', () => {
  assert.match(source, /Order Amount \(EUR\)/);
  assert.match(source, /deliveryFee\} EUR/);
  assert.match(source, /estimatedTotal\} EUR/);
  assert.match(source, /overflow-auto scrollbar-hide/);
  assert.doesNotMatch(source, /€|â/);
});
