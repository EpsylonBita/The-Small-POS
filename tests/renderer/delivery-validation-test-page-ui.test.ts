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
  // Since 04/10/2026 amounts follow the store's currency (founder rule: never assume EUR);
  // the label shows "—" while the store currency is unknown.
  assert.match(source, /Order Amount \(\{getStoreCurrency\(\) \?\? '—'\}\)/);
  assert.match(source, /formatCurrency\(validationResult\.zone\.deliveryFee\)/);
  assert.match(source, /formatCurrency\(validationResult\.validation\.estimatedTotal\)/);
  assert.doesNotMatch(source, /€|&euro;|\bEUR\b/, 'no hard-coded currency');
  assert.match(source, /overflow-auto scrollbar-hide/);
  // UTF-8 read as Latin-1/cp1252 (Â·, Ã©, â€”, ðŸ, Î/Ï for Greek) or a replacement character.
  assert.doesNotMatch(source, /[ÂÃâðÎÏ�]/, 'source must not contain mojibake');
});
