import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'LoyaltyRedeemModal.tsx');

test('LoyaltyRedeemModal keeps checkout-only redemption behavior', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /createPortal\(modal, document\.body\)/);
  assert.match(source, /z-2147483000(?![\w.-])/);
  assert.match(source, /liquid-glass-modal-shell/);
  assert.match(source, /liquid-glass-modal-backdrop/);
  assert.match(source, /setRedeemPoints\(effectiveMaxPoints\)/);
  assert.match(source, /onRedeem\(discountPreview, pointsToRedeem\)/);
  assert.match(source, /onClose\(\)/);
  assert.doesNotMatch(source, /bridge\.loyalty\.redeemPoints/);
});

test('LoyaltyRedeemModal uses yellow loyalty accents and green commit action', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const buttonTypes = source.match(/type="button"/g) ?? [];

  assert.match(source, /rounded-2xl border border-\(--pos-s-border\) bg-yellow-400 text-black/);
  assert.match(source, /bg-\(--pos-s-surface-2\) text-yellow-700 dark:text-yellow-200/);
  assert.match(source, /border-\(--pos-s-yellow\) bg-\(--pos-s-surface-2\) text-yellow-900/);
  assert.match(source, /font-bold text-yellow-700 dark:text-yellow-300/);
  // Wave ΣΤ7: the redeem confirm is the kit glass-modal primary (yellow in both themes).
  assert.match(source, /liquid-glass-modal-button pos-modal-primary/);
  assert.doesNotMatch(source, /active:bg-green-800/);
  assert.ok(buttonTypes.length >= 5, 'all modal buttons should be explicit button controls');
});

test('LoyaltyRedeemModal has no legacy hover, purple, blue, or small-radius chrome', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(source, /bg-blue-|text-blue-|border-blue-|focus:ring-blue|focus:border-blue|blue-500|blue-600|blue-700/);
  assert.doesNotMatch(source, /cyan-|purple-|sky-/);
  assert.doesNotMatch(source, /rounded-md|rounded-lg/);
  assert.doesNotMatch(source, /\btitle=/);
});
