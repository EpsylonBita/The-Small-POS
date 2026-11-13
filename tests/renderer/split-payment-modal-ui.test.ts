import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalSource = readFileSync(path.join(process.cwd(), 'src/renderer/components/modals/SplitPaymentModal.tsx'), 'utf8');
const glassCss = readFileSync(path.join(process.cwd(), 'src/renderer/styles/glassmorphism.css'), 'utf8');

test('split payment preserves one bounded scroll body and a separate footer', () => {
  assert.match(modalSource, /contentClassName="flex min-h-0 flex-col overflow-hidden px-6! py-3!"/);
  assert.match(modalSource, /flex min-h-0 flex-1 flex-col space-y-3/);
  assert.match(modalSource, /min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-24 scroll-pb-24/);
  assert.equal((modalSource.match(/overflow-y-auto/g) ?? []).length, 1);
  assert.match(modalSource, /footer=\{footer\}/);
  assert.doesNotMatch(modalSource, /max-h-\[(380|500)px\]/);
});

test('empty by-items people stay compact while assigned portions retain their details', () => {
  assert.match(modalSource, /portion\.status === 'draft' && portion\.items\.length === 0 && portion\.amount <= 0\.009 && portion\.discountAmount <= 0\.009/);
  const compact = modalSource.match(/isEmptyByItemsPortion\(portion\) \? \(([\s\S]*?)\) : \(/);
  assert.ok(compact);
  assert.match(compact[1], /splitPayment\.noItems/);
  assert.match(compact[1], /formatCurrency\(portion\.amount\)/);
  assert.match(compact[1], /<MethodToggle portion=\{portion\} \/>/);
  assert.doesNotMatch(compact[1], /renderPortionDetails/);
  assert.equal((modalSource.match(/renderPortionDetails\(portion\)/g) ?? []).length, 2);
});

test('selected split and receipt segments keep the shared contrast override', () => {
  // Wave ΣΤ7: selected segments use the kit selection; yellow stays on the confirm action.
  assert.equal((modalSource.match(/bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) shadow-xs split-payment-segment-selected/g) ?? []).length, 2);
  assert.equal((modalSource.match(/border-\(--pos-s-sel-bg\) bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\) split-payment-segment-selected/g) ?? []).length, 2);
  assert.doesNotMatch(modalSource, /bg-yellow-400 text-black[^"]*split-payment-segment-selected/);
  assert.match(glassCss, /button\.split-payment-segment-selected[\s\S]*?color:\s*var\(--pos-s-sel-fg\)\s*!important/);
  assert.doesNotMatch(modalSource, /<[a-z][^>]*\stitle=/);
  assert.doesNotMatch(modalSource, /hover:/);
});

test('zero-discount portions suppress redundant subtotal and discount rows', () => {
  assert.match(modalSource, /const hasDiscount = portion\.discountAmount > 0\.009;/);
  assert.match(modalSource, /\{hasDiscount && \(\s*<>[\s\S]*?modals\.orderDetails\.subtotal[\s\S]*?modals\.orderDetails\.discount/);
  assert.match(modalSource, /splitPayment\.payable/);
});

// Founder 01/11 («και εδώ δεν έχουν όλα βάθος σωστό!!!»): every split control is raised with the kit depth and no
// dark outline, pressed sinks; person cards carry the card depth; money fields are sunken wells.
test('split controls, cards and fields carry the kit depth', () => {
  const splitCss = readFileSync(path.join(process.cwd(), 'src/renderer/components/modals/split-payment-modal.css'), 'utf8');
  assert.doesNotMatch(splitCss, /box-shadow:\s*none/);
  for (const selector of ['button.split-payment-method,']) {
    const block = splitCss.slice(splitCss.indexOf(selector));
    assert.match(block.slice(0, block.indexOf('}')), /background: var\(--pos-s-raised\) !important;\s*box-shadow: var\(--pos-s-depth\);/, selector);
  }
  assert.match(splitCss, /button\.split-payment-method\[aria-pressed='true'\] \{[^}]*box-shadow: var\(--pos-s-depth-yellow\);/);
  assert.match(splitCss, /button\.split-payment-confirm \{[^}]*box-shadow: var\(--pos-s-depth-yellow\);/);
  assert.match(splitCss, /button\.split-payment-segment-selected \{\s*box-shadow: var\(--pos-s-depth-yellow\);/);
  // founder 11/11/2026: portion panels and money fields use the shared frost; tender/confirm actions stay solid.
  assert.match(modalSource, /className="pos-glass-form-card px-4! py-3! space-y-2"/);
  assert.match(modalSource, /className="pos-glass-form-card space-y-2 p-2\.5!"/);
  assert.match(modalSource, /className="liquid-glass-modal-input pos-glass-field min-h-touch w-full py-2 pl-12 pr-3 text-base tabular-nums font-medium disabled:cursor-not-allowed disabled:opacity-70"/);
  assert.match(modalSource, /className="pos-glass-field min-h-touch flex w-full items-center justify-between gap-2 px-3 py-2\.5 text-sm"/);
  assert.match(modalSource, /assignedTo === portion\.id \? "bg-\(--pos-s-sel-bg\) text-\(--pos-s-sel-fg\)[^"]*" : "pos-glass-tap-card"/);
  assert.doesNotMatch(modalSource, /className="split-payment-(?:money-input|person|assignment|card-notice|footer)\b/);
  assert.equal((modalSource.match(/className="pos-solid-btn pos-solid-btn--sm w-full gap-2"/g) ?? []).length, 2, 'both Add Person buttons are raised');
  assert.equal((modalSource.match(/className="pos-icon-btn pos-icon-btn--danger"/g) ?? []).length, 2, 'both remove buttons are kit icon buttons');
  assert.doesNotMatch(modalSource, /border-dashed/);
  assert.doesNotMatch(modalSource, /bg-slate-100\/80|bg-white\/80|bg-slate-500\/1[05]/);
});

// founder 11/11/2026: glass content reveals without changing payment eligibility or the bounded scroll body.
test('split glass reveals respect reduced motion and keep checkout actions opaque', () => {
  assert.match(modalSource, /const reduceMotion = useReducedMotion\(\);/);
  assert.match(modalSource, /initial: reduceMotion \? false as const : \{ opacity: 0, height: 0, y: 12, overflow: 'hidden' \}/);
  assert.match(modalSource, /animate: \{ opacity: 1, height: 'auto', y: 0, overflow: 'visible' \}/);
  assert.match(modalSource, /duration: reduceMotion \? 0 : 0\.24, ease: \[0\.2, 0\.8, 0\.2, 1\]/);
  assert.doesNotMatch(modalSource, /AnimatePresence mode="wait"|animate-in|border-t\b/);
  assert.match(modalSource, /bg-\(--pos-s-surface\) px-6 pb-5 pt-2/);
  assert.match(modalSource, /\[&>\.liquid-glass-modal-header\]:border-b-0!/);
  // The notice's obsolete tender text unmounts immediately; only its empty visual wrapper exits.
  assert.match(modalSource, /useIsPresent\(\) \? children : null/);
});
