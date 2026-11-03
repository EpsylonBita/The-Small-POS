import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const promptPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'hooks',
  'usePaymentPrintPrompt.tsx',
);
const promptSource = readFileSync(promptPath, 'utf8');

// Founder 02/11/2026: the prompt is the kit — a neutral bare printer, a kit panel, raised buttons and the yellow
// primary whose colour also glows behind it («τα χρώματα στα κουμπιά … από πίσω στις σκιές τους»).
test('payment print prompt presents a large bare printer icon without a decorative wrapper', () => {
  assert.match(
    promptSource,
    /<Printer\s+className="h-9 w-9 shrink-0 text-\(--pos-s-fg\)" aria-hidden="true"\s*\/>/,
  );
  assert.match(promptSource, /<div className="pos-card px-3 py-2 text-sm">/);
  assert.match(promptSource, /className="pos-solid-btn pos-solid-btn--md"/);
  assert.match(promptSource, /className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary pos-raised--tint \[--pos-tint:var\(--pos-s-yellow\)\] gap-2"/);
  assert.doesNotMatch(promptSource, /bg-white\/5|bg-yellow-400/);
  assert.doesNotMatch(
    promptSource,
    /<div className="[^"]*(?:h-12|w-12)[^"]*(?:border|bg-yellow)[^"]*">\s*<Printer/,
  );
});
