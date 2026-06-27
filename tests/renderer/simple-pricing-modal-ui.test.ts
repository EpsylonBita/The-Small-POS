import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, 'src', 'renderer', 'components', 'pricing', 'SimplePricingModal.tsx');
const source = () => readFileSync(sourcePath, 'utf8');

const localePath = (locale: string) => path.join(projectRoot, 'src', 'locales', `${locale}.json`);
const readLocale = (locale: string) => JSON.parse(readFileSync(localePath(locale), 'utf8'));

test('SimplePricingModal uses shared glass shell and touch-first semantic actions', () => {
  const modal = source();

  assert.match(modal, /import \{ LiquidGlassModal, POSGlassButton \} from '\.\.\/ui\/pos-glass-components'/);
  assert.match(modal, /<LiquidGlassModal[\s\S]*?isOpen=\{isOpen\}[\s\S]*?onClose=\{onClose\}[\s\S]*?title=\{titleToShow\}/);
  assert.match(modal, /liquid-glass-modal-card/);
  assert.match(modal, /liquid-glass-modal-input/);
  assert.match(modal, /focus:ring-yellow-400/);
  assert.match(modal, /variant="error"[\s\S]*?\{t\('common\.actions\.cancel'/);
  assert.match(modal, /variant="success"[\s\S]*?\{t\('modals\.simplePricing\.savePricing'\)/);
  assert.match(modal, /icon=\{<Save className="h-4 w-4" aria-hidden="true" \/>\}/);
  assert.match(modal, /bg-yellow-400 text-black/);
  assert.match(modal, /text-emerald-500/);

  assert.doesNotMatch(modal, /hover:|dark:hover:|group-hover:/);
  assert.doesNotMatch(modal, /bg-blue-|text-blue-|border-blue-|ring-blue-|focus:ring-blue/);
  assert.doesNotMatch(modal, /rounded-lg/);
  assert.doesNotMatch(modal, /<button[\s\S]*?Save Pricing/);
});

test('SimplePricingModal has no hardcoded visible pricing copy', () => {
  const modal = source();

  for (const text of [
    'Order Type Pricing',
    'Pickup Price',
    'Delivery Price',
    'Set different prices for pickup and delivery orders',
    'Save Pricing',
    'Cancel</',
  ]) {
    assert.doesNotMatch(modal, new RegExp(text));
  }

  for (const key of [
    'orderTypePricing',
    'pickupPrice',
    'deliveryPrice',
    'pricingHelp',
    'savePricing',
  ]) {
    assert.match(modal, new RegExp(`modals\\.simplePricing\\.${key}`));
  }
});

test('SimplePricingModal i18n keys are present in all supported locales', () => {
  for (const locale of ['en', 'el', 'de', 'fr', 'it']) {
    const simplePricing = readLocale(locale).modals.simplePricing;
    for (const key of [
      'title',
      'orderTypePricing',
      'pickupPrice',
      'deliveryPrice',
      'pricingHelp',
      'savePricing',
    ]) {
      assert.equal(typeof simplePricing[key], 'string', `${locale}.${key} should be localized`);
      assert.ok(simplePricing[key].trim().length > 0, `${locale}.${key} should not be empty`);
    }
  }
});
