import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditOptionsModal.tsx');

test('EditOptionsModal uses colored outlines, neutral fills, grey icon wrappers, and larger colored icons', () => {
  const source = readFileSync(modalPath, 'utf8');

  assert.match(source, /border-blue-200\/50 dark:border-blue-400\/30 bg-white\/5 hover:bg-white\/10 liquid-glass-modal-text/);
  assert.match(source, /border-green-200\/50 dark:border-green-400\/30 bg-white\/5 hover:bg-white\/10 liquid-glass-modal-text/);
  assert.match(source, /border-amber-200\/50 dark:border-amber-400\/30 bg-white\/5 hover:bg-white\/10/);
  assert.match(source, /border-violet-200\/50 dark:border-violet-400\/30 bg-white\/5 liquid-glass-modal-text/);
  assert.match(source, /w-12 h-12 rounded-lg bg-gray-200\/70 dark:bg-zinc-800\/80 flex items-center justify-center backdrop-blur-sm/);
  assert.match(source, /w-6 h-6 text-blue-600 dark:text-blue-400/);
  assert.match(source, /w-6 h-6 text-green-600 dark:text-green-400/);
  assert.match(source, /w-6 h-6 \$\{/);
  assert.match(source, /text-amber-600 dark:text-amber-400/);
  assert.match(source, /w-6 h-6 text-violet-600 dark:text-violet-400/);

  assert.doesNotMatch(source, /bg-blue-50\/50 dark:bg-blue-500\/10/);
  assert.doesNotMatch(source, /bg-green-50\/50 dark:bg-green-500\/10/);
  assert.doesNotMatch(source, /bg-amber-50\/50 dark:bg-amber-500\/10/);
  assert.doesNotMatch(source, /bg-violet-50\/50 dark:bg-violet-500\/10/);
  assert.doesNotMatch(source, /rounded-lg bg-blue-500\/20 dark:bg-blue-500\/30/);
  assert.doesNotMatch(source, /rounded-lg bg-green-500\/20 dark:bg-green-500\/30/);
  assert.doesNotMatch(source, /rounded-lg bg-violet-500\/20 dark:bg-violet-500\/30/);
});
