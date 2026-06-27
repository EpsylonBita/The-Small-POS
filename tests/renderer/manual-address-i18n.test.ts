import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const localesDir = path.join(projectRoot, 'src', 'locales');

const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const getKey = (obj: Record<string, any>, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((value, key) => {
    if (value == null) return value;
    return (value as Record<string, unknown>)[key];
  }, obj);

const keys = [
  'modals.editCustomer.manualAddressPlaceholder',
  'modals.editCustomer.manualAddressEntryHint',
  'modals.addCustomer.manualAddressPlaceholder',
  'modals.addCustomer.manualAddressEntryHint',
  'modals.addNewAddress.manualAddressPlaceholder',
  'modals.addNewAddress.manualAddressEntryHint',
];

test('manual address fallback copy is localized in every POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const locale = loadLocale(lng);
    for (const key of keys) {
      const value = getKey(locale, key);
      assert.equal(typeof value, 'string', `${lng} missing ${key}`);
      assert.ok((value as string).trim().length > 0, `${lng} has empty ${key}`);
    }
  }
});

test('Greek manual address copy does not fall back to English', () => {
  const el = loadLocale('el');
  const en = loadLocale('en');

  for (const key of keys) {
    const value = getKey(el, key);
    assert.equal(typeof value, 'string', `el missing ${key}`);
    assert.notEqual(value, getKey(en, key), `el ${key} should not equal English`);
    assert.doesNotMatch(value as string, /Enter address manually|Delivery zones are disabled/i);
  }
});

test('manual address modal call sites do not carry raw English fallback literals', () => {
  for (const file of [
    'AddCustomerModal.tsx',
    'AddNewAddressModal.tsx',
    'EditCustomerInfoModal.tsx',
  ]) {
    const source = readFileSync(
      path.join(projectRoot, 'src', 'renderer', 'components', 'modals', file),
      'utf8',
    );
    assert.doesNotMatch(source, /Enter address manually/, `${file} leaks placeholder fallback`);
    assert.doesNotMatch(source, /Delivery zones are disabled|Delivery Pro is not enabled/, `${file} leaks helper fallback`);
  }
});
