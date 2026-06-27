import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;
// Greek and Coptic Unicode block, built from escapes so this file stays ASCII.
const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

const integrationsSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'IntegrationsPage.tsx'),
  'utf8',
);

test('common.online / common.offline exist and are non-empty in every POS locale', () => {
  // The connectivity badge keys were referenced (with English defaults) but defined
  // in no locale, so t() fell through to "Online"/"Offline" everywhere.
  for (const lng of POS_LOCALES) {
    const common = loadLocale(lng).common ?? {};
    for (const key of ['online', 'offline']) {
      assert.equal(typeof common[key], 'string', `${lng}.common.${key} missing`);
      assert.ok(common[key].length > 0, `${lng}.common.${key} empty`);
    }
  }
});

test('Greek connectivity status is localized, not the English "Online"/"Offline" leak', () => {
  const en = loadLocale('en').common;
  const el = loadLocale('el').common;
  assert.notEqual(el.online, en.online, 'el.common.online still equals English');
  assert.notEqual(el.offline, en.offline, 'el.common.offline still equals English');
  assert.notEqual(el.online, 'Online', 'el.common.online must not be the raw "Online" leak');
  assert.notEqual(el.offline, 'Offline', 'el.common.offline must not be the raw "Offline" leak');
  assert.match(el.online, GREEK_LETTER, `el.common.online should be Greek: "${el.online}"`);
  assert.match(el.offline, GREEK_LETTER, `el.common.offline should be Greek: "${el.offline}"`);
});

test('de/fr/it connectivity status are real translations, not the English source', () => {
  const en = loadLocale('en').common;
  for (const lng of ['de', 'fr', 'it'] as const) {
    const common = loadLocale(lng).common;
    assert.notEqual(common.online, en.online, `${lng}.common.online still equals English`);
    assert.notEqual(common.offline, en.offline, `${lng}.common.offline still equals English`);
  }
});

test('IntegrationsPage connectivity badge reads from common.online/common.offline', () => {
  assert.match(
    integrationsSource,
    /isOnline \? t\('common\.online', 'Online'\) : t\('common\.offline', 'Offline'\)/,
    'the add-ons badge must resolve its label from the shared common.online/offline keys',
  );
});
