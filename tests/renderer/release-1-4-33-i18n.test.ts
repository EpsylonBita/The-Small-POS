import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const localesDir = path.join(projectRoot, 'src', 'locales');
const supportedLocales = ['en', 'el', 'de', 'fr', 'it'] as const;

const releaseKeys = [
  'modals.orderDetails.copyFailed',
  'modals.orderDetails.phone',
  'modals.orderDetails.email',
  'modals.orderDetails.addressNumber',
  'modals.orderDetails.customerCopied',
  'modals.orderDetails.copyCustomer',
  'modals.orderDetails.openCustomerCard',
  'modals.orderDetails.viewCustomerCard',
  'modals.orderDetails.addressCopied',
  'modals.orderDetails.copyAddress',
  'modals.orderDetails.customerCard',
  'modals.orderDetails.loadingCustomer',
  'modals.orderDetails.savedAddresses',
  'modals.orderDetails.editAddress',
  'modals.orderDetails.noSavedAddresses',
  'modals.customerSearch.deleteAddressQueued',
  'modals.customerSearch.deleteAddressSuccess',
  'users.deleteAddressQueued',
  'login.noPinWarning',
] as const;

function readLocale(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function readTranslation(
  locale: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = key.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, locale);
  return typeof value === 'string' ? value.trim() : undefined;
}

test('POS 1.4.33 customer and address actions are translated in every supported locale', () => {
  const english = readLocale('en');

  for (const localeName of supportedLocales) {
    const locale = readLocale(localeName);
    for (const key of releaseKeys) {
      const value = readTranslation(locale, key);
      assert.ok(value, `${localeName} is missing ${key}`);
      if (localeName !== 'en') {
        assert.notEqual(
          value,
          readTranslation(english, key),
          `${localeName} must not fall back to English for ${key}`,
        );
      }
    }
  }
});

test('update-ready dialog uses the existing localized update vocabulary', () => {
  const modalSource = readFileSync(
    path.join(
      projectRoot,
      'src',
      'renderer',
      'components',
      'updates',
      'UpdateReadyModal.tsx',
    ),
    'utf8',
  );

  assert.match(modalSource, /useTranslation\(\)/);
  for (const key of [
    'updates.title.downloaded',
    'updates.downloaded.ready',
    'updates.downloaded.readyGeneric',
    'updates.downloaded.description',
    'updates.downloaded.warning',
    'updates.actions.installNow',
    'updates.actions.installLater',
  ]) {
    assert.match(modalSource, new RegExp(key.split('.').join('\\.')));
  }

  assert.doesNotMatch(modalSource, />Update Ready to Install</);
  assert.doesNotMatch(modalSource, />Restart & Install Now</);
  assert.doesNotMatch(modalSource, />Install on Next Restart</);
});
