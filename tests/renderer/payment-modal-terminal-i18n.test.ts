import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'PaymentModal.tsx'),
  'utf8',
);
const loadSettingsTerminalMessages = (lng: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8'))
    .settings?.terminal?.messages ?? {};

// PaymentModal's terminal-disabled helper text lives under settings.terminal.messages.*.
// The top-level terminal.messages.* namespace only holds mobileWaiterInfo, so referencing
// terminal.messages.<key> resolves to nothing and silently leaks the English default.
const REQUIRED_KEYS = ['featureDisabled', 'cashDrawerMainOnly', 'noPaymentMethods', 'contactManager'];

test('PaymentModal does not reference the missing top-level terminal.messages keys', () => {
  // Regression: t('terminal.messages.featureDisabled') (and its siblings) leaked English
  // in Greek/de/fr/it. Pin the class of mistake, not just the one reported line.
  assert.doesNotMatch(
    modalSource,
    /t\('terminal\.messages\./,
    'PaymentModal must use settings.terminal.messages.*, not the missing top-level terminal.messages.*',
  );
  // The disabled card-payment helper text uses the valid localized key.
  assert.match(modalSource, /t\('settings\.terminal\.messages\.featureDisabled'/);
});

test('PaymentModal terminal-disabled messages are localized in every POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const messages = loadSettingsTerminalMessages(lng);
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof messages[key], 'string', `${lng}.settings.terminal.messages.${key} missing`);
      assert.ok(messages[key].length > 0, `${lng}.settings.terminal.messages.${key} empty`);
    }
  }
  // Greek must differ from English to prove real translation, not an echo.
  const en = loadSettingsTerminalMessages('en');
  const el = loadSettingsTerminalMessages('el');
  for (const key of REQUIRED_KEYS) {
    assert.notEqual(el[key], en[key], `el.settings.terminal.messages.${key} should be translated`);
  }
});

// --- Locale-aware currency rendering --------------------------------------

// Mirrors src/renderer/utils/format.ts formatCurrency's Intl config (the file isn't
// imported directly: it transitively imports lib/i18n without an extension, which
// breaks a direct `node --test`).
const eur = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const loadPaymentMessages = (lng: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${lng}.json`), 'utf8')).modals
    ?.payment ?? {};

test('PaymentModal renders every money value via the shared formatCurrency, not hardcoded € + toFixed(2)', () => {
  assert.match(modalSource, /import \{ formatCurrency \} from '\.\.\/\.\.\/utils\/format';/);
  // Main total + cash summary total, subtotal, discount, delivery fee, cash received, change.
  assert.match(modalSource, /\{formatCurrency\(orderTotal\)\}/);
  assert.match(modalSource, /\{formatCurrency\(subtotalBeforeDiscount\)\}/);
  assert.match(modalSource, /-\{formatCurrency\(discountAmount\)\}/);
  assert.match(modalSource, /\{formatCurrency\(deliveryFee\)\}/);
  assert.match(modalSource, /\{formatCurrency\(cashAmount\)\}/);
  assert.match(modalSource, /hasEnoughCash \? formatCurrency\(changeAmount\)/);
  // Below-minimum interpolation passes the formatted amount (the symbol comes from the
  // formatter, not a hardcoded € in the message).
  assert.match(modalSource, /belowMinimumMessage'[\s\S]*?amount: formatCurrency\(minimumOrderAmount\)/);

  // No hardcoded euro-prefixed / toFixed(2) display strings survive.
  assert.doesNotMatch(modalSource, /€\{[^}]*\.toFixed\(2\)\}/);
  assert.doesNotMatch(modalSource, /toFixed\(2\)/);
});

test('PaymentModal amounts format locale-aware: Greek "18,50 €", not "€18.50"', () => {
  const el = eur(18.5, 'el-GR');
  assert.match(el, /18,50/); // comma decimal separator
  assert.ok(el.includes('€'));
  assert.notEqual(el, '€18.50'); // not the old hardcoded English-style value
  assert.equal(eur(18.5, 'en-US'), '€18.50'); // English stays English-style
});

test('below-minimum message drops the baked-in € and keeps the {{amount}} placeholder in every locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const msg = loadPaymentMessages(lng).belowMinimumMessage;
    assert.equal(typeof msg, 'string', `${lng}.modals.payment.belowMinimumMessage missing`);
    assert.match(msg, /\{\{amount\}\}/, `${lng} must keep the {{amount}} placeholder`);
    assert.doesNotMatch(msg, /€/, `${lng} must not bake in a € symbol (formatCurrency supplies it)`);
  }
});
