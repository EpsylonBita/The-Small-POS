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
  // Wave ΣΤ: a solid yellow focus ring, no translucent wash.
  assert.match(globalsSource, /\.customer-search-yellow-input:focus\s*\{[\s\S]*0 0 0 1px rgb\(250, 204, 21\)/);
  assert.doesNotMatch(globalsSource, /\.customer-search-yellow-input:focus\s*\{[^}]*rgba\(250, 204, 21/);
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
  assert.match(source, /border-\(--pos-s-border\) border-t-yellow-500 rounded-full animate-spin/);
  assert.doesNotMatch(source, /border-blue-500\/30 border-t-blue-500/);
});

// Founder 02/11/2026 («διόρθωσε και το modal της αναγνώρισης… και τα εικονίδια και όλα»; «τα χρώματα στα κουμπιά
// θέλω να είναι από πίσω στις σκιές τους»): the window is the kit. Cards are raised kit cards, words and icons are
// neutral (red only for a banned customer), the chosen address glows yellow behind with its check, and a coloured
// button keeps the neutral face with its colour as the shadow behind it.
test('CustomerSearchModal renders found customers as raised kit cards with neutral icons', () => {
  // founder 11/11/2026: glass tap cards retain shared press depth and neutral icons.
  assert.match(source, /className=\{`pos-glass-tap-card relative min-h-touch w-full cursor-pointer p-4 text-left`\}/);
  assert.match(source, /<User className=\{`h-6 w-6 shrink-0 \$\{c\.is_banned \? 'text-\(--pos-s-bad\)' : 'text-\(--pos-s-muted\)'\}`\}/);
  assert.doesNotMatch(source, /text-yellow-500 dark:text-yellow-300/, 'the phone icon is neutral, not decorated yellow');
  assert.doesNotMatch(source, /bg-zinc-100\/85|bg-zinc-800\/80|border-zinc-300\/70/, 'no translucent card chrome');
  assert.doesNotMatch(source, /rounded-full flex items-center gap-1/, 'banned is red words, not a pill');
  assert.doesNotMatch(source, /📞|🔔|📝/, 'kit icons, not emoji');
});

test('CustomerSearchModal renders the customer as a kit panel and addresses as raised cards; the chosen one glows yellow', () => {
  // founder 11/11/2026: frosted customer panel; selected address uses solid kit yellow.
  assert.match(source, /className=\{`pos-glass-form-card mb-3`\}/);
  assert.match(source, /className=\{`pos-glass-tap-card min-h-touch w-full cursor-pointer p-3 text-left focus-visible:outline-2 focus-visible:outline-yellow-400 \$\{isSelected\s*\? 'bg-\(--pos-s-sel-bg\)! text-\(--pos-s-sel-fg\) border-\(--pos-s-sel-bg\)!/);
  assert.match(source, /rounded-full bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)/);
  assert.doesNotMatch(source, /border-green-600|text-green-400|bg-green-500/, 'the selection is the kit yellow, never green');
  assert.match(source, /<MapPin className="mt-0\.5 h-5 w-5 shrink-0 text-\(--pos-s-muted\)" aria-hidden="true" \/>/);
  assert.match(source, /className="pos-glass-field inline-flex min-h-touch min-w-touch items-center justify-center p-2"/);
  assert.match(source, /className="pos-solid-btn pos-solid-btn--danger min-h-touch min-w-touch p-2"/);
});

test('CustomerSearchModal order types keep till glyphs on glass tap cards with press depth', () => {
  assert.match(source, /<DeliveryScooterIcon className="h-full w-full" \/>/);
  assert.match(source, /<PickupHandBagIcon className="h-full w-full" \/>/);
  assert.match(source, /<TableOrderIcon className="h-full w-full" strokeWidth=\{1\.6\} opticalScale=\{1\.62\} \/>/);
  // founder 11/11/2026: glass cards replace colored shadows; touch size and glyphs stay.
  assert.match(source, /className=\{`pos-glass-tap-card flex min-h-\[104px\] flex-col/);
  assert.doesNotMatch(source, /border-2 bg-white px-4 py-4/, 'no coloured outline on a white tile');
  const css = readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles', 'glassmorphism.css'), 'utf8');
  assert.match(css, /\.pos-glass-tap-card \{[\s\S]*?box-shadow: var\(--pos-s-depth-card\);/);
  assert.match(css, /\.pos-glass-tap-card:is\(:active, \[data-pressed\]\):not\(:disabled\) \{[\s\S]*?box-shadow: var\(--pos-s-depth-press\);[\s\S]*?translate: 0 1px/);
});

test('CustomerSearchModal address + action MapPins are neutral (not blue); actions are solid kit buttons', () => {
  const actionSectionStart = source.indexOf('{/* Action Buttons - Add Address, Edit Customer, Delete */}');
  const actionSectionEnd = source.indexOf('{/* Add New Customer Option', actionSectionStart);
  assert.notEqual(actionSectionStart, -1);
  assert.notEqual(actionSectionEnd, -1);
  const actionSection = source.slice(actionSectionStart, actionSectionEnd);

  // No MapPin (or any icon) is blue anywhere in the modal.
  assert.doesNotMatch(source, /<MapPin[^>]*text-blue/);
  assert.match(actionSection, /<MapPin className="w-4 h-4 shrink-0" \/>/);

  // The three actions are raised kit buttons (neutral Add address / Edit, red-text Delete) that wrap their words
  // in the narrow window instead of being cut.
  assert.equal((actionSection.match(/className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--wrap min-w-0 gap-1\.5"/g) || []).length, 2);
  assert.match(actionSection, /className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger"/);
  assert.doesNotMatch(actionSection, /rgba\(/);
  assert.match(actionSection, /<Edit className="w-4 h-4 shrink-0" \/>/);
  assert.match(actionSection, /<Trash2 className="w-4 h-4" \/>/);
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

// Not-found / different-person prompt: a kit panel; adding the customer is the one yellow primary when nobody was
// found, and a plain raised action next to a found customer (one yellow primary per view).
test('CustomerSearchModal add-new-customer prompt is a kit panel with the kit primary only when nobody was found', () => {
  const promptSectionStart = source.indexOf('{/* Add New Customer Option');
  const promptSectionEnd = source.indexOf('{/* Delete Confirmation Dialog */}', promptSectionStart);
  assert.notEqual(promptSectionStart, -1);
  assert.notEqual(promptSectionEnd, -1);
  const promptSection = source.slice(promptSectionStart, promptSectionEnd);

  // founder 11/11/2026: the prompt is a frosted card; its primary action stays solid.
  assert.match(promptSection, /<motion.div[^>]*className="pos-glass-form-card">/);
  assert.match(promptSection, /pos-solid-btn pos-solid-btn--md w-full gap-2 \$\{customer \? '' : `pos-solid-btn--primary pos-raised--tint \[--pos-tint:var\(--pos-s-yellow\)\]`\}/);
  assert.doesNotMatch(promptSection, /#16a34a|backgroundColor:/);
  assert.doesNotMatch(promptSection, /blue/);
});

test('CustomerSearchModal deletes saved addresses through the local-first customer bridge', () => {
  assert.match(source, /bridge\.customers\.deleteAddress\(customer\.id, addr\.id\)/);
  assert.doesNotMatch(
    source,
    /posApiFetch<any>\(`pos\/customers\/\$\{customer\.id\}\/addresses\/\$\{addr\.id\}`/,
  );
});

test('CustomerSearchModal renders a translated, touch-sized Caller ID add-address action without management controls', () => {
  const callerIdActionsStart = source.indexOf('{/* Caller ID add-address action */}');
  const callerIdActionsEnd = source.indexOf('{/* Add New Customer Option', callerIdActionsStart);
  assert.notEqual(callerIdActionsStart, -1);
  assert.notEqual(callerIdActionsEnd, -1);
  const callerIdActions = source.slice(callerIdActionsStart, callerIdActionsEnd);

  assert.match(callerIdActions, /type="button"/);
  assert.match(callerIdActions, /min-h-touch(?![\w.-])/);
  assert.match(callerIdActions, /className="pos-solid-btn pos-solid-btn--md mt-4 min-h-touch w-full gap-2"/);
  assert.match(callerIdActions, /t\('modals\.customerSearch\.addNewAddress', 'Add address'\)/);
  assert.doesNotMatch(callerIdActions, /editCustomer|deleteCustomer|Trash2|<Edit/);
});
