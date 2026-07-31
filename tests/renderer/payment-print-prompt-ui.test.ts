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

test('payment print prompt presents a large bare printer icon without a decorative wrapper', () => {
  assert.match(
    promptSource,
    /<Printer\s+className="h-9 w-9 flex-shrink-0 text-yellow-500 dark:text-yellow-300"\s*\/>/,
  );
  assert.doesNotMatch(
    promptSource,
    /<div className="[^"]*(?:h-12|w-12)[^"]*(?:border|bg-yellow)[^"]*">\s*<Printer/,
  );
});
