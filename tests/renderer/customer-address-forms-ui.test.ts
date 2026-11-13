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
  assert.match(source, /focus:border-\(--pos-s-yellow\)/);
  assert.match(source, /focus:border-yellow-500/);
  assert.match(source, /focus:ring-\(--pos-s-fg\)/);
  assert.equal((source.match(/className=\{inputClass\}/g) || []).length, 3);

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});

test('AddressSelectionCard uses touch feedback, yellow/neutral accents, and labelled icon buttons', () => {
  const source = readRenderer('components/forms/AddressSelectionCard.tsx');

  // founder 11/11/2026: shared tap-card owns depth and press feedback.
  assert.match(source, /pos-glass-tap-card relative p-6/);
  assert.match(source, /pos-glass-field inline-flex min-h-touch min-w-touch/);
  const glass = readRenderer('styles/glassmorphism.css');
  assert.match(glass, /\.pos-glass-tap-card:is\(:active, \[data-pressed\]\):not\(:disabled\) \{[\s\S]*?box-shadow: var\(--pos-s-depth-press\);[\s\S]*?translate: 0 1px/);
  assert.match(source, /text-yellow-300/);
  assert.match(source, /h-5 w-5 liquid-glass-modal-text-muted/);
  assert.match(source, /aria-label=\{t\('common\.actions\.edit', 'Edit'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.delete', 'Delete'\)\}/);
  assert.match(source, /onEdit\(address\)/);
  assert.match(source, /onDelete\(address\)/);
  assert.match(source, /pos-solid-btn pos-solid-btn--danger min-h-touch min-w-touch/);

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
  // founder 11/11/2026: frosted customer/field groups and neutral context icon.
  assert.match(source, /pos-glass-form-card/);
  assert.match(source, /rounded-2xl liquid-glass-modal-text-muted/);
  assert.match(source, /liquid-glass-modal-input pos-glass-field min-h-touch w-full/);
  assert.match(source, /pos-glass-tap-card min-h-touch w-full px-4 py-3 text-left focus-visible:outline-2/);
  assert.match(source, /border-\(--pos-s-border\) border-t-yellow-400 rounded-full animate-spin/);
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
  // founder 11/11/2026: glass field owns yellow focus; checkbox retains focus-visible.
  assert.match(source, /liquid-glass-modal-input pos-glass-field min-h-touch w-full/);
  assert.match(source, /h-5 w-5 shrink-0 rounded-xl accent-yellow-500 focus-visible:outline-2 focus-visible:outline-yellow-400/);
  assert.match(source, /form="edit-address-form"/);
  assert.match(source, /id="edit-address-form"/);
  assert.match(source, /scrollbar-hide/);

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});


test('the three scoped desktop suggestion editors append the shared localized distance on its second line', () => {
  for (const file of ['components/modals/AddCustomerModal.tsx', 'components/modals/AddNewAddressModal.tsx',
    'components/modals/EditCustomerInfoModal.tsx']) {
    const source = readRenderer(file);
    assert.match(source, /secondary_text[\s\S]{0,180}formatAddressDistance\(suggestion.distance_meters, i18n\?\.resolvedLanguage \|\| i18n\?\.language\)/, file);
  }
});
