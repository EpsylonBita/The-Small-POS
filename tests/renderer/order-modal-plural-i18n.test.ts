import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';

const projectRoot = process.cwd();
const localesDir = path.join(projectRoot, 'src', 'locales');

const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const createT = async (lng: string) => {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
      de: { translation: loadLocale('de') },
      fr: { translation: loadLocale('fr') },
      it: { translation: loadLocale('it') },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(lng);
};

const countKeys = [
  'modals.orderCancellation.message',
  'modals.editOptions.message',
  'modals.driverAssignment.message',
  'modals.editOrderItems.message',
  'modals.editCustomer.updateMessage',
];

test('Greek order modal count copy uses natural i18next plurals', async () => {
  const t = await createT('el');

  assert.equal(
    t('modals.editCustomer.updateMessage', { count: 1 }),
    'Ενημέρωση στοιχείων πελάτη για 1 επιλεγμένη παραγγελία.',
  );
  assert.equal(
    t('modals.editCustomer.updateMessage', { count: 2 }),
    'Ενημέρωση στοιχείων πελάτη για 2 επιλεγμένες παραγγελίες.',
  );
  assert.equal(
    t('modals.driverAssignment.message', { count: 1 }),
    '1 παραγγελία παράδοσης πρέπει να ανατεθεί σε οδηγό.',
  );
  assert.equal(
    t('modals.driverAssignment.message', { count: 3 }),
    '3 παραγγελίες παράδοσης πρέπει να ανατεθούν σε οδηγό.',
  );
});

test('order modal count keys are pluralized in every POS locale', () => {
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const locale = loadLocale(lng);
    for (const key of countKeys) {
      const parentPath = key.split('.');
      const baseKey = parentPath.pop();
      if (!baseKey) {
        throw new Error(`${key} should include a leaf key`);
      }
      const parent = parentPath.reduce<Record<string, any>>((value, part) => value[part], locale);

      assert.equal(typeof parent[`${baseKey}_one`], 'string', `${lng} missing ${key}_one`);
      assert.equal(typeof parent[`${baseKey}_other`], 'string', `${lng} missing ${key}_other`);
      assert.equal(parent[baseKey], undefined, `${lng} should not keep flat fallback ${key}`);
    }
  }
});

test('Greek order modal count copy does not contain parenthetical plural grammar', () => {
  const source = readFileSync(path.join(localesDir, 'el.json'), 'utf8');

  assert.doesNotMatch(source, /επιλεγμένη\(ες\)/);
  assert.doesNotMatch(source, /παραγγελία\(ες\)/);
});
