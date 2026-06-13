import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'EditCustomerInfoModal.tsx');

test('EditCustomerInfoModal uses grey fields, green address pin, and a yellow save button', () => {
  const source = readFileSync(modalPath, 'utf8');

  assert.match(source, /const editCustomerInputClass =/);
  assert.match(source, /bg-gray-100 dark:bg-zinc-800\/80/);
  assert.match(source, /border-gray-300 dark:border-zinc-600/);
  assert.match(source, /focus:ring-gray-400\/60 dark:focus:ring-white\/30/);
  assert.match(source, /w-5 h-5 text-green-400/);
  assert.match(source, /const editCustomerSaveButtonClass =/);
  assert.match(source, /bg-yellow-400 hover:bg-yellow-300/);
  assert.match(source, /!text-black disabled:!text-gray-500/);
  assert.match(source, /border border-yellow-400 hover:border-yellow-300/);
  assert.match(source, /className=\{editCustomerInputClass\}/);
  assert.match(source, /className=\{editCustomerSaveButtonClass\}/);

  assert.doesNotMatch(source, /bg-white\/50 dark:bg-gray-800\/50/);
  assert.doesNotMatch(source, /focus:ring-blue-500 focus:border-transparent/);
  assert.doesNotMatch(source, /bg-blue-500\/20 hover:bg-blue-500\/30/);
  assert.doesNotMatch(source, /text-blue-600 dark:text-blue-400 disabled:text-gray-500/);
});
