import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const readRenderer = (relativePath: string) =>
  readFileSync(path.join(projectRoot, 'src', 'renderer', relativePath), 'utf8');

test('CustomerDetailsForm uses smooth yellow-focus inputs without blue or hover styling', () => {
  const source = readRenderer('components/forms/CustomerDetailsForm.tsx');

  assert.match(source, /const inputClass =/);
  assert.match(source, /rounded-2xl border px-3 py-3/);
  assert.match(source, /focus:border-yellow-400\/80/);
  assert.match(source, /focus:border-yellow-500/);
  assert.match(source, /focus:ring-yellow-400\/40/);
  assert.equal((source.match(/className=\{inputClass\}/g) || []).length, 3);

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});

test('AddressSelectionCard uses touch feedback, yellow/neutral accents, and labelled icon buttons', () => {
  const source = readRenderer('components/forms/AddressSelectionCard.tsx');

  assert.match(source, /rounded-3xl border p-6 backdrop-blur-xl transition-transform/);
  assert.match(source, /active:scale-\[0\.99\]/);
  assert.match(source, /bg-yellow-400\/18/);
  assert.match(source, /bg-yellow-200\/80/);
  assert.match(source, /text-yellow-300/);
  assert.match(source, /text-yellow-700/);
  assert.match(source, /aria-label=\{t\('common\.actions\.edit', 'Edit'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.delete', 'Delete'\)\}/);
  assert.match(source, /onEdit\(address\)/);
  assert.match(source, /onDelete\(address\)/);
  assert.match(source, /active:bg-red-500\/18/);

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});

test('AddNewAddressModal uses yellow customer context, rounded fields, and touch suggestions', () => {
  const source = readRenderer('components/modals/AddNewAddressModal.tsx');
  const buttonTypes = source.match(/type="button"/g) ?? [];

  assert.match(source, /const fieldClass =/);
  assert.match(source, /const addressFieldClass = `\$\{fieldClass\} pl-10`/);
  assert.match(source, /rounded-3xl border border-yellow-400\/25 bg-yellow-400\/12/);
  assert.match(source, /rounded-2xl bg-yellow-400 text-black/);
  assert.match(source, /border-yellow-400\/30 border-t-yellow-400 rounded-full animate-spin/);
  assert.match(source, /text-yellow-600 dark:text-yellow-300/);
  assert.match(source, /scrollbar-hide/);
  assert.match(source, /className=\{addressFieldClass\}/);
  assert.match(source, /className=\{fieldClass\}/);
  assert.match(source, /className=\{`\$\{fieldClass\} resize-none`\}/);
  assert.ok(buttonTypes.length >= 3, 'suggestions and footer actions should be explicit button controls');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});

test('EditAddressModal shares the rounded yellow-focus address field recipe', () => {
  const source = readRenderer('components/modals/EditAddressModal.tsx');

  assert.match(source, /const fieldClass =/);
  assert.equal((source.match(/className=\{fieldClass\}/g) || []).length, 4);
  assert.match(source, /className=\{`\$\{fieldClass\} resize-none`\}/);
  assert.match(source, /rounded-2xl border border-gray-300 bg-white\/60/);
  assert.match(source, /focus:border-yellow-500/);
  assert.match(source, /focus:ring-yellow-400\/40/);
  assert.match(source, /h-5 w-5 rounded-xl/);
  assert.match(source, /scrollbar-hide/);

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});
