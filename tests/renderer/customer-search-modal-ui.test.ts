import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const customerSearchModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'CustomerSearchModal.tsx');
const globalsPath = path.join(projectRoot, 'src', 'renderer', 'styles', 'globals.css');

test('CustomerSearchModal uses yellow focus chrome for its search input', () => {
  const modalSource = readFileSync(customerSearchModalPath, 'utf8');
  const globalsSource = readFileSync(globalsPath, 'utf8');

  assert.match(modalSource, /customer-search-yellow-input liquid-glass-modal-input/);
  assert.doesNotMatch(modalSource, /inputBase\(resolvedTheme\)/);
  assert.match(globalsSource, /\.customer-search-yellow-input:focus\s*\{[\s\S]*border-color: rgb\(250, 204, 21\);/);
  assert.match(globalsSource, /\.customer-search-yellow-input:focus\s*\{[\s\S]*rgba\(250, 204, 21, 0\.45\)/);
});

test('CustomerSearchModal renders found customer cards with neutral chrome and colored icons', () => {
  const modalSource = readFileSync(customerSearchModalPath, 'utf8');

  assert.match(modalSource, /border-zinc-300\/70 bg-zinc-100\/85 hover:bg-zinc-200\/80/);
  assert.match(modalSource, /dark:border-zinc-700\/70 dark:bg-zinc-800\/80 dark:hover:bg-zinc-700\/70/);
  assert.match(modalSource, /<User className=\{`h-6 w-6 shrink-0/);
  assert.match(modalSource, /<Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300"/);
  assert.doesNotMatch(modalSource, /📞 \{c\.phone\}/);
});

test('CustomerSearchModal renders selected customer detail with neutral chrome and yellow phone icon', () => {
  const modalSource = readFileSync(customerSearchModalPath, 'utf8');

  assert.match(modalSource, /mb-6 rounded-2xl border p-4 \$\{/);
  assert.match(modalSource, /border-zinc-300\/70 bg-zinc-100\/85 dark:border-zinc-700\/70 dark:bg-zinc-800\/80/);
  assert.match(modalSource, /<User className=\{`h-7 w-7 shrink-0/);
  assert.match(modalSource, /flex min-w-0 flex-1 flex-col items-start gap-1/);
  assert.match(modalSource, /max-w-full truncate font-medium/);
  assert.match(modalSource, /<Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" \/>[\s\S]*<span>\{customer\.phone\}<\/span>/);
  assert.match(modalSource, /w-full cursor-pointer rounded-lg p-2 transition-all/);
  assert.doesNotMatch(modalSource, /📞 \{customer\.phone\}/);
  assert.doesNotMatch(modalSource, /: \{customer\.floor_number\}/);
});

test('CustomerSearchModal keeps selected address and customer action fills transparent', () => {
  const modalSource = readFileSync(customerSearchModalPath, 'utf8');
  const actionSectionStart = modalSource.indexOf('{/* Action Buttons - Add Address, Edit Customer, Delete */}');
  const actionSectionEnd = modalSource.indexOf('{/* Add New Customer Option', actionSectionStart);
  assert.notEqual(actionSectionStart, -1);
  assert.notEqual(actionSectionEnd, -1);
  const actionSection = modalSource.slice(actionSectionStart, actionSectionEnd);

  assert.match(modalSource, /border-2 border-green-500\/60 bg-transparent/);
  assert.match(modalSource, /border border-gray-200 bg-transparent/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.addNewAddress/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.editCustomer/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.deleteCustomer/);
  assert.match(actionSection, /<MapPin className="w-4 h-4 text-blue-500 dark:text-blue-400" \/>/);
  assert.match(actionSection, /<Edit className="w-4 h-4 text-amber-500 dark:text-amber-300" \/>/);
  assert.match(actionSection, /<Trash2 className="w-4 h-4 text-red-500 dark:text-red-400" \/>/);
  assert.match(modalSource, /backgroundColor: '#16a34a'[\s\S]*borderColor: '#16a34a'/);
  assert.doesNotMatch(actionSection, /hover:bg-blue-700/);
  assert.doesNotMatch(actionSection, /hover:bg-amber-700/);
  assert.doesNotMatch(actionSection, /hover:bg-red-700/);
});

test('CustomerSearchModal uses yellow chrome for the add-new-customer prompt', () => {
  const modalSource = readFileSync(customerSearchModalPath, 'utf8');
  const promptSectionStart = modalSource.indexOf('{/* Add New Customer Option');
  const promptSectionEnd = modalSource.indexOf('{/* Delete Confirmation Dialog */}', promptSectionStart);
  assert.notEqual(promptSectionStart, -1);
  assert.notEqual(promptSectionEnd, -1);
  const promptSection = modalSource.slice(promptSectionStart, promptSectionEnd);

  assert.match(promptSection, /bg-yellow-50 dark:bg-yellow-500\/10 border border-yellow-200 dark:border-yellow-500\/20/);
  assert.match(promptSection, /backgroundColor: '#facc15'/);
  assert.match(promptSection, /color: '#111827'/);
  assert.match(promptSection, /borderColor: '#facc15'/);
  assert.doesNotMatch(promptSection, /blue/);
});
