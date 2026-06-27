import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const customerSearchModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'CustomerSearchModal.tsx');
const globalsPath = path.join(projectRoot, 'src', 'renderer', 'styles', 'globals.css');
const source = readFileSync(customerSearchModalPath, 'utf8');

test('CustomerSearchModal uses yellow focus chrome for its search input', () => {
  const globalsSource = readFileSync(globalsPath, 'utf8');

  assert.match(source, /customer-search-yellow-input liquid-glass-modal-input/);
  assert.doesNotMatch(source, /inputBase\(resolvedTheme\)/);
  assert.match(globalsSource, /\.customer-search-yellow-input:focus\s*\{[\s\S]*border-color: rgb\(250, 204, 21\);/);
  assert.match(globalsSource, /\.customer-search-yellow-input:focus\s*\{[\s\S]*rgba\(250, 204, 21, 0\.45\)/);
});

// Touch-first + on-theme contract: no hover utilities (tap/active feedback only), no styled native
// scrollbar (the result list hides its rail), and no off-theme blue/cyan/purple/violet anywhere --
// this modal stays in the semantic red / green / amber / yellow / neutral palette.
test('CustomerSearchModal is touch-first and on-theme (no hover, no custom-scrollbar, no blue/cyan/purple/violet)', () => {
  assert.doesNotMatch(source, /hover:/, 'no hover utilities on a touch POS');
  assert.doesNotMatch(source, /group-hover:|dark:hover:/);

  assert.doesNotMatch(source, /custom-scrollbar/, 'styled native scrollbar must be replaced by scrollbar-hide');
  assert.match(
    source,
    /max-h-60 overflow-y-auto space-y-3 pr-1 scrollbar-hide/,
    'the results list keeps overflow scroll but hides the native rail',
  );

  assert.doesNotMatch(
    source,
    /\b(?:bg|text|border|from|to|via)-(?:blue|cyan|purple|violet|indigo|sky)-/,
    'no off-theme color tokens in this modal',
  );
});

// The real-time search spinner is the yellow accent (was border-blue-500/30 border-t-blue-500).
test('CustomerSearchModal search spinner uses the yellow accent, not blue', () => {
  assert.match(source, /border-yellow-500\/30 border-t-yellow-500 rounded-full animate-spin/);
  assert.doesNotMatch(source, /border-blue-500\/30 border-t-blue-500/);
});

test('CustomerSearchModal renders found customer cards with neutral active chrome and non-blue icons', () => {
  // Neutral card chrome with active (tap) feedback -- NOT hover (the previous, corrected value).
  assert.match(source, /border-zinc-300\/70 bg-zinc-100\/85 active:bg-zinc-200\/80/);
  assert.match(source, /dark:border-zinc-700\/70 dark:bg-zinc-800\/80 dark:active:bg-zinc-700\/70/);
  assert.doesNotMatch(source, /hover:bg-zinc-200\/80/);

  // The found (non-banned) User icon is neutral grey; banned stays red. Never blue.
  assert.match(
    source,
    /<User className=\{`h-6 w-6 shrink-0 \$\{c\.is_banned \? 'text-red-500' : 'text-gray-600 dark:text-gray-300'\}`\}/,
  );
  assert.match(source, /<Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300"/);
  assert.doesNotMatch(source, /📞 \{c\.phone\}/);
});

test('CustomerSearchModal renders selected customer detail with neutral chrome and yellow phone icon', () => {
  assert.match(source, /mb-6 rounded-2xl border p-4 \$\{/);
  assert.match(source, /border-zinc-300\/70 bg-zinc-100\/85 dark:border-zinc-700\/70 dark:bg-zinc-800\/80/);
  assert.match(source, /<User className=\{`h-7 w-7 shrink-0/);
  assert.match(source, /<Phone className="h-4 w-4 shrink-0 text-yellow-500 dark:text-yellow-300" \/>[\s\S]*<span>\{customer\.phone\}<\/span>/);
  assert.match(source, /w-full cursor-pointer rounded-lg p-2 transition-all/);
  assert.doesNotMatch(source, /📞 \{customer\.phone\}/);
});

test('CustomerSearchModal address + action MapPins are amber/neutral (not blue) with transparent action fills', () => {
  const actionSectionStart = source.indexOf('{/* Action Buttons - Add Address, Edit Customer, Delete */}');
  const actionSectionEnd = source.indexOf('{/* Add New Customer Option', actionSectionStart);
  assert.notEqual(actionSectionStart, -1);
  assert.notEqual(actionSectionEnd, -1);
  const actionSection = source.slice(actionSectionStart, actionSectionEnd);

  // No MapPin (or any icon) is blue anywhere in the modal.
  assert.doesNotMatch(source, /<MapPin[^>]*text-blue/);
  // The non-selected address-row marker is neutral; the Add Address action marker is amber.
  assert.match(source, /<MapPin className="w-4 h-4 text-gray-500 dark:text-gray-300 mt-0\.5 flex-shrink-0" \/>/);
  assert.match(actionSection, /<MapPin className="w-4 h-4 text-amber-500 dark:text-amber-300" \/>/);

  // Selected-address border stays green; the three action fills stay transparent; edit amber, delete red.
  assert.match(source, /border-2 border-green-500\/60 bg-transparent/);
  assert.match(source, /border border-gray-200 bg-transparent/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.addNewAddress/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.editCustomer/);
  assert.match(actionSection, /backgroundColor: 'transparent'[\s\S]*modals\.customerSearch\.deleteCustomer/);
  assert.match(actionSection, /<Edit className="w-4 h-4 text-amber-500 dark:text-amber-300" \/>/);
  assert.match(actionSection, /<Trash2 className="w-4 h-4 text-red-500 dark:text-red-400" \/>/);
});

// Touch-first a11y: the inline edit/delete address icon buttons and the delete-customer icon button
// expose their accessible name via aria-label, not a native DOM title= tooltip (hover-dependent and a
// duplicated-description leak on a touch POS). The LiquidGlassModal + ConfirmDialog title= are
// component props (modal/dialog headings), not DOM tooltips, and must remain.
test('CustomerSearchModal icon buttons use aria-label, not native title tooltips', () => {
  assert.match(source, /aria-label=\{t\('common\.edit', 'Edit'\)\}/);
  assert.match(source, /aria-label=\{t\('common\.delete', 'Delete'\)\}/);
  assert.match(source, /aria-label=\{t\('modals\.customerSearch\.deleteCustomer'\)\}/);

  assert.doesNotMatch(source, /title=\{t\('common\.edit'/);
  assert.doesNotMatch(source, /title=\{t\('common\.delete'/);
  assert.doesNotMatch(source, /title=\{t\('modals\.customerSearch\.deleteCustomer'\)\}/);

  // The only remaining title= are the two component props (modal heading + ConfirmDialog heading).
  const titleAttrs = source.match(/\btitle=/g) ?? [];
  assert.equal(titleAttrs.length, 2, 'only the LiquidGlassModal + ConfirmDialog component-prop title= remain');
  assert.match(source, /<LiquidGlassModal[\s\S]*?title=\{t\('modals\.customerSearch\.title'\)\}/);
  assert.match(source, /title=\{t\('modals\.customerSearch\.deleteCustomerTitle'/);
});

// Not-found / different-person prompt: a yellow info panel, but the create CTA stays semantic GREEN
// (#16a34a / white) because it creates/saves a customer -- it must NOT be yellow.
test('CustomerSearchModal add-new-customer prompt is a yellow info panel with a green create CTA', () => {
  const promptSectionStart = source.indexOf('{/* Add New Customer Option');
  const promptSectionEnd = source.indexOf('{/* Delete Confirmation Dialog */}', promptSectionStart);
  assert.notEqual(promptSectionStart, -1);
  assert.notEqual(promptSectionEnd, -1);
  const promptSection = source.slice(promptSectionStart, promptSectionEnd);

  // Yellow info panel.
  assert.match(promptSection, /bg-yellow-50 dark:bg-yellow-500\/10 border border-yellow-200 dark:border-yellow-500\/20/);
  // Green create CTA (semantic save) with active tap feedback -- not yellow.
  assert.match(promptSection, /backgroundColor: '#16a34a'/);
  assert.match(promptSection, /color: '#ffffff'/);
  assert.match(promptSection, /borderColor: '#16a34a'/);
  assert.doesNotMatch(promptSection, /backgroundColor: '#facc15'/);
  assert.doesNotMatch(promptSection, /blue/);
});
