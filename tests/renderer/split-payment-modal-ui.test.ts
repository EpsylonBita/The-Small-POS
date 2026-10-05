import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalSource = readFileSync(path.join(process.cwd(), 'src/renderer/components/modals/SplitPaymentModal.tsx'), 'utf8');
const glassCss = readFileSync(path.join(process.cwd(), 'src/renderer/styles/glassmorphism.css'), 'utf8');

test('split payment preserves one bounded scroll body and a separate footer', () => {
  assert.match(modalSource, /contentClassName="flex min-h-0 flex-col overflow-hidden !px-6 !py-3"/);
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
  assert.equal((modalSource.match(/bg-yellow-400 text-black shadow-sm split-payment-segment-selected/g) ?? []).length, 2);
  assert.equal((modalSource.match(/bg-yellow-400 text-black split-payment-segment-selected/g) ?? []).length, 2);
  assert.match(glassCss, /button\.split-payment-segment-selected[\s\S]*?color:\s*#000\s*!important/);
  assert.doesNotMatch(modalSource, /<[a-z][^>]*\stitle=/);
  assert.doesNotMatch(modalSource, /hover:/);
});

test('zero-discount portions suppress redundant subtotal and discount rows', () => {
  assert.match(modalSource, /const hasDiscount = portion\.discountAmount > 0\.009;/);
  assert.match(modalSource, /\{hasDiscount && \(\s*<>[\s\S]*?modals\.orderDetails\.subtotal[\s\S]*?modals\.orderDetails\.discount/);
  assert.match(modalSource, /splitPayment\.payable/);
});
