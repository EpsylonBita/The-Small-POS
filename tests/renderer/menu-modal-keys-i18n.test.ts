import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Tomikro 22/10/2026: modals.menu.orderNotSavedCartKept existed in no locale,
// so a failed checkout told the Greek cashier, in English, to press Pay again.
// Every modals.menu key MenuModal asks for resolves in all six languages once
// the base locale and its overlays are merged, as src/locales/bundles.ts does.

const LOCALES = ['en', 'el', 'de', 'fr', 'it', 'sq'] as const;
const localesDir = path.join(process.cwd(), 'src', 'locales');

const merge = (base: Record<string, any>, layer: Record<string, any>): Record<string, any> => {
  for (const [key, value] of Object.entries(layer)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      merge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
};

const mergedLocale = (locale: string): Record<string, any> => {
  const bundle = JSON.parse(readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));
  const overlays = readdirSync(path.join(localesDir, 'overlays'))
    .filter(name => name.startsWith(`${locale}.`) && name.endsWith('.json'))
    .sort();
  for (const name of overlays) merge(bundle, JSON.parse(readFileSync(path.join(localesDir, 'overlays', name), 'utf8')));
  return bundle;
};

const lookup = (bundle: Record<string, any>, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as any)[part] : undefined), bundle);

const menuModalKeys = [...new Set(
  [...readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx'), 'utf8')
    .matchAll(/\bt\(\s*['"](modals\.menu\.[A-Za-z0-9_.]+)['"]/g)].map(match => match[1]),
)].sort();

test('MenuModal asks for the checkout outcome keys this fix added', () => {
  for (const key of ['modals.menu.orderNotSavedCartKept', 'modals.menu.freezeReadbackChanged', 'modals.menu.orderConfirmationRefused']) {
    assert.ok(menuModalKeys.includes(key), key);
  }
});

for (const locale of LOCALES) {
  test(`every modals.menu key of MenuModal resolves in ${locale}`, () => {
    const bundle = mergedLocale(locale);
    const missing = menuModalKeys.filter(key => {
      const value = lookup(bundle, key);
      return typeof value !== 'string' || !value.trim();
    });
    assert.deepEqual(missing, []);
  });
}

test('the checkout outcome messages are translated, not English copies', () => {
  const english = mergedLocale('en');
  for (const locale of LOCALES.filter(code => code !== 'en')) {
    const bundle = mergedLocale(locale);
    for (const key of ['modals.menu.orderNotSavedCartKept', 'modals.menu.freezeReadbackChanged', 'modals.menu.orderConfirmationRefused']) {
      assert.notEqual(lookup(bundle, key), lookup(english, key), `${locale} ${key}`);
    }
  }
});
