import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { formatTableDisplayNumber } from '../../src/renderer/utils/table-display.ts';

const source = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableSelector.tsx'),
  'utf8',
);

const localesDir = path.join(process.cwd(), 'src', 'locales');
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'));

const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const;
const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]');

const flatten = (obj: Record<string, any>, prefix = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value, dotted));
    } else {
      out[dotted] = value as string;
    }
  }
  return out;
};

test('TableSelector copy is wired to the tableSelector.* i18n namespace (no hardcoded literals)', () => {
  for (const key of [
    'tableSelector.title',
    'tableSelector.subtitle',
    'tableSelector.searchPlaceholder',
    'tableSelector.minCapacity',
    'tableSelector.all',
    'tableSelector.noTables',
    'tableSelector.tryDifferentFilters',
    'tableSelector.allTablesOccupied',
    'tableSelector.status.available',
    'tableSelector.status.reserved',
  ]) {
    assert.match(source, new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`), `${key} must be rendered via t()`);
  }
});

test('TableSelector renders table card labels through the shared display formatter', () => {
  assert.match(source, /import \{ formatTableDisplayNumber \} from '\.\.\/\.\.\/utils\/table-display';/);
  assert.match(source, /\{formatTableDisplayNumber\(table\.tableNumber\)\}/);
  // The raw "#{table.tableNumber}" label (e.g. "#B01") is gone.
  assert.doesNotMatch(source, /#\{table\.tableNumber\}/);
});

test('tableSelector locale keys exist in every POS locale with matching structure', () => {
  const enKeys = Object.keys(flatten(loadLocale('en').tableSelector)).sort();
  assert.ok(enKeys.length >= 12, `expected the full tableSelector namespace, got ${enKeys.length} keys`);

  for (const lng of POS_LOCALES) {
    const ns = loadLocale(lng).tableSelector;
    assert.ok(ns, `${lng} is missing the tableSelector namespace`);
    const keys = Object.keys(flatten(ns)).sort();
    assert.deepEqual(keys, enKeys, `${lng} tableSelector keys diverge from en`);
    for (const [key, value] of Object.entries(flatten(ns))) {
      assert.equal(typeof value, 'string', `${lng}.tableSelector.${key} must be a string`);
      assert.ok((value as string).length > 0, `${lng}.tableSelector.${key} is empty`);
    }
  }
});

test('Greek tableSelector copy is localized, not the English leak', () => {
  const en = flatten(loadLocale('en').tableSelector);
  const el = flatten(loadLocale('el').tableSelector);

  for (const key of [
    'title',
    'searchPlaceholder',
    'minCapacity',
    'all',
    'noTables',
    'status.available',
    'status.reserved',
  ]) {
    assert.notEqual(el[key], en[key], `el.tableSelector.${key} still equals the English source`);
    assert.match(el[key], GREEK_LETTER, `el.tableSelector.${key} has no Greek letters: "${el[key]}"`);
  }

  // The exact English strings from the live repro must not survive in Greek.
  const elBlob = Object.values(el).join('\n');
  for (const phrase of [
    'Select a Table',
    'tables available',
    'Search by table number',
    'Min. capacity',
    'Available',
    'Reserved',
  ]) {
    assert.ok(!elBlob.includes(phrase), `Greek tableSelector leaks English: "${phrase}"`);
  }
});

test('tableSelector subtitle keeps its {{count}} token and pluralizes across locales', () => {
  for (const lng of POS_LOCALES) {
    const ns = flatten(loadLocale(lng).tableSelector);
    assert.match(ns.subtitle_one, /\{\{count\}\}/, `${lng} subtitle_one lost {{count}}`);
    assert.match(ns.subtitle_other, /\{\{count\}\}/, `${lng} subtitle_other lost {{count}}`);
  }
});

test('shared formatter maps table codes to the grid display convention', () => {
  assert.equal(formatTableDisplayNumber('B01'), '#TB01');
  assert.equal(formatTableDisplayNumber('P01'), '#TP01');
  assert.equal(formatTableDisplayNumber('T01'), '#T01');
});
