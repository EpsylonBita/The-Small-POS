import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'AddCustomerModal.tsx');
const glassCssPath = path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css');
const source = readFileSync(modalPath, 'utf8');
const glassCss = readFileSync(glassCssPath, 'utf8');

test('Round 422: AddCustomerModal keeps the shared glass shell and semantic actions', () => {
  assert.match(source, /<LiquidGlassModal/);
  // The shared shell titles the form. The Caller ID workspace (05/08/2026) swaps in its own
  // header with the same title plus labelled Minimize/Close controls, and names the dialog.
  assert.match(source, /title=\{callerIdWorkspace \? undefined : getModalTitle\(\)\}/);
  assert.match(source, /<h2 className="liquid-glass-modal-title">\{getModalTitle\(\)\}<\/h2>/);
  assert.match(source, /ariaLabel=\{callerIdWorkspace \? getModalTitle\(\) : undefined\}/);
  assert.match(source, /aria-label=\{t\('modals\.addCustomer\.minimize', 'Minimize'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.actions\.close', 'Close'\)\}/);
  assert.match(source, /<form onSubmit=\{handleSubmit\}/);
  // Founder 31/10: the actions sit in the modal's fixed footer — a neutral Cancel and the yellow kit primary —
  // and the submit reaches the form through its id.
  assert.match(source, /<form onSubmit=\{handleSubmit\} id="add-customer-form"/);
  assert.match(source, /footer=\{\(\s*<div className="flex gap-3 border-t border-\(--modal-glass-line\) px-6 py-4">/);
  assert.match(source, /className="liquid-glass-modal-button flex-1 rounded-2xl"/);
  assert.match(source, /type="submit"\s*form="add-customer-form"[\s\S]*?className="liquid-glass-modal-button pos-modal-primary flex-1 rounded-2xl/);
  assert.doesNotMatch(source, /liquid-glass-modal-error|liquid-glass-modal-success/);
});

test('Field icons are a calm solid neutral (founder 31/10: yellow is the primary action), suggestions are amber, validation loading is yellow', () => {
  const fieldIconMatches = source.match(/liquid-glass-modal-field-icon/g) ?? [];
  assert.ok(fieldIconMatches.length >= 8, 'every customer field icon should use the shared high-contrast token');
  assert.match(
    glassCss,
    /\.liquid-glass-modal-field-icon\s*\{[\s\S]*?z-index:\s*2\s*!important;[\s\S]*?color:\s*#71717a\s*!important;[\s\S]*?stroke:\s*#71717a\s*!important;[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?stroke-opacity:\s*1\s*!important;[\s\S]*?stroke-width:\s*2;[\s\S]*?filter:\s*none\s*!important;[\s\S]*?mix-blend-mode:\s*normal\s*!important;[\s\S]*?\}/,
    'light-theme field icons sit above the glass input and paint a solid neutral stroke',
  );
  assert.match(
    glassCss,
    /\.dark \.liquid-glass-modal-field-icon\s*\{[\s\S]*?color:\s*#a1a1aa\s*!important;[\s\S]*?stroke:\s*#a1a1aa\s*!important;[\s\S]*?\}/,
    'dark-theme field icons paint a solid neutral stroke',
  );
  assert.match(source, /text-amber-500 dark:text-amber-300 mt-1 shrink-0/);
  assert.match(source, /flex items-center gap-2 text-yellow-600 dark:text-yellow-300/);
});

test('Round 422: no legacy blue chrome, hover affordances, or small-radius controls remain', () => {
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
});

test('Round 422: customer and delivery validation behavior hooks are preserved', () => {
  for (const required of [
    'resolveAddressSuggestion',
    'validateAddressForDelivery',
    'buildAddressFingerprint',
    'ensureAddressValidationForSubmit',
    'customerService.addCustomerAddress',
    'customerService.updateCustomerAddress',
    'customerService.updateCustomer',
    'customerService.createCustomer',
    'onCustomerAdded',
  ]) {
    assert.match(source, new RegExp(required.replace(/\./g, '\\.')), `${required} must remain wired`);
  }
});
