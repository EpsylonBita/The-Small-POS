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
  assert.match(source, /title=\{getModalTitle\(\)\}/);
  assert.match(source, /<form onSubmit=\{handleSubmit\}/);
  assert.match(source, /className="liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-2xl"/);
  assert.match(
    source,
    /className="liquid-glass-modal-button liquid-glass-modal-success flex-1 rounded-2xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"/,
  );
});

test('Round 423: field icons use a solid high-contrast yellow in both themes, suggestions are amber, and validation loading is yellow', () => {
  const fieldIconMatches = source.match(/liquid-glass-modal-field-icon/g) ?? [];
  assert.ok(fieldIconMatches.length >= 8, 'every customer field icon should use the shared high-contrast token');
  assert.match(
    glassCss,
    /\.liquid-glass-modal-field-icon\s*\{[\s\S]*?z-index:\s*2\s*!important;[\s\S]*?color:\s*#eab308\s*!important;[\s\S]*?stroke:\s*#eab308\s*!important;[\s\S]*?opacity:\s*1\s*!important;[\s\S]*?stroke-opacity:\s*1\s*!important;[\s\S]*?stroke-width:\s*3;[\s\S]*?filter:\s*none\s*!important;[\s\S]*?mix-blend-mode:\s*normal\s*!important;[\s\S]*?\}/,
    'light-theme field icons should sit above the glass input and paint a solid true-yellow stroke',
  );
  assert.match(
    glassCss,
    /\.dark \.liquid-glass-modal-field-icon\s*\{[\s\S]*?color:\s*#facc15\s*!important;[\s\S]*?stroke:\s*#facc15\s*!important;[\s\S]*?\}/,
    'dark-theme field icons should explicitly paint a solid yellow-400 stroke',
  );
  assert.match(source, /text-amber-500 dark:text-amber-300 mt-1 flex-shrink-0/);
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
