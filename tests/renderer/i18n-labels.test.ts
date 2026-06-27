import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { resolveNavigationLabel, formatTableSeats } from '../../src/renderer/utils/i18nLabels';

const projectRoot = process.cwd();
const enLocale = JSON.parse(
  readFileSync(path.join(projectRoot, 'src', 'locales', 'en.json'), 'utf8'),
);
const elLocale = JSON.parse(
  readFileSync(path.join(projectRoot, 'src', 'locales', 'el.json'), 'utf8'),
);

async function createT(lng: 'en' | 'el') {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: enLocale },
      el: { translation: elLocale },
    },
    interpolation: { escapeValue: false },
  });
  return instance.getFixedT(lng);
}

// ---------------------------------------------------------------------------
// Behavioral regression: navigation label resolution
// ---------------------------------------------------------------------------

test('resolveNavigationLabel returns a real string for the menu module (el)', async () => {
  const t = await createT('el');
  const label = resolveNavigationLabel(t, 'menu', 'Menu');

  assert.equal(typeof label, 'string');
  assert.equal(label, 'Μενού');
  assert.doesNotMatch(label, /returned an object/i);
  assert.doesNotMatch(label, /navigation\.menu/);
});

test('resolveNavigationLabel returns a real string for the menu module (en)', async () => {
  const t = await createT('en');
  assert.equal(resolveNavigationLabel(t, 'menu', 'Menu'), 'Menu');
});

test('resolveNavigationLabel resolves flat navigation entries', async () => {
  const t = await createT('en');
  assert.equal(resolveNavigationLabel(t, 'dashboard', 'Dashboard'), 'Dashboard');
});

test('resolveNavigationLabel falls back to the module name when no key exists', async () => {
  const t = await createT('en');
  // An unknown/custom module id has no locale key, so the DB-provided name is used.
  assert.equal(resolveNavigationLabel(t, 'custom_unknown_module', 'Custom Module'), 'Custom Module');
});

test('resolveNavigationLabel localizes DB/module-backed sidebar labels (el)', async () => {
  const t = await createT('el');
  assert.equal(resolveNavigationLabel(t, 'rooms', 'Rooms'), 'Δωμάτια');
  assert.equal(resolveNavigationLabel(t, 'tables', 'Tables'), 'Τραπέζια');
  assert.equal(resolveNavigationLabel(t, 'appointments', 'Appointments'), 'Ραντεβού');
  assert.equal(resolveNavigationLabel(t, 'housekeeping', 'Housekeeping'), 'Καθαριότητα');
  assert.equal(resolveNavigationLabel(t, 'staff_schedule', 'Staff Schedule'), 'Πρόγραμμα Προσωπικού');
  assert.equal(resolveNavigationLabel(t, 'reservations', 'Reservations'), 'Κρατήσεις');
  assert.equal(resolveNavigationLabel(t, 'service_catalog', 'Services'), 'Υπηρεσίες');
  assert.equal(resolveNavigationLabel(t, 'suppliers', 'Supplier Management'), 'Διαχείριση Προμηθευτών');
  assert.equal(resolveNavigationLabel(t, 'inventory', 'Inventory Management'), 'Διαχείριση Αποθέματος');
  assert.equal(resolveNavigationLabel(t, 'loyalty', 'Loyalty & Rewards'), 'Πιστότητα & Επιβραβεύσεις');
});

test('resolveNavigationLabel keeps the English DB names in en mode', async () => {
  const t = await createT('en');
  assert.equal(resolveNavigationLabel(t, 'suppliers', 'Supplier Management'), 'Supplier Management');
  assert.equal(resolveNavigationLabel(t, 'inventory', 'Inventory Management'), 'Inventory Management');
  assert.equal(resolveNavigationLabel(t, 'service_catalog', 'Services'), 'Services');
});

test('module-backed sidebar labels exist (localized) in every POS locale', () => {
  const moduleIds = [
    'rooms', 'tables', 'appointments', 'housekeeping', 'staff_schedule',
    'reservations', 'service_catalog', 'suppliers', 'inventory', 'loyalty',
  ];
  const locales: Record<string, any> = {};
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    locales[lng] = JSON.parse(
      readFileSync(path.join(projectRoot, 'src', 'locales', `${lng}.json`), 'utf8'),
    );
  }
  for (const lng of Object.keys(locales)) {
    const menu = locales[lng].navigation?.menu ?? {};
    for (const id of moduleIds) {
      assert.equal(typeof menu[id], 'string', `${lng}.navigation.menu.${id} should be a string`);
      assert.ok(menu[id].length > 0, `${lng}.navigation.menu.${id} should be non-empty`);
    }
  }
  // Greek labels must actually differ from English (proves real localization, not echo).
  for (const id of moduleIds) {
    assert.notEqual(
      locales.el.navigation.menu[id],
      locales.en.navigation.menu[id],
      `el.navigation.menu.${id} should be translated, not the English label`,
    );
  }
});

// ---------------------------------------------------------------------------
// Behavioral regression: table seats interpolation
// ---------------------------------------------------------------------------

test('formatTableSeats interpolates the count exactly once (en)', async () => {
  const t = await createT('en');
  const label = formatTableSeats(t, 4);

  assert.equal(label, '4 seats');
  assert.doesNotMatch(label, /\{\{count\}\}/);
});

test('formatTableSeats interpolates the count exactly once (el)', async () => {
  const t = await createT('el');
  const label = formatTableSeats(t, 2);

  assert.doesNotMatch(label, /\{\{count\}\}/);
  assert.match(label, /2/);
});

// ---------------------------------------------------------------------------
// Source-level wiring regression: the components must use the safe helpers
// ---------------------------------------------------------------------------

const sidebarSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'NavigationSidebar.tsx'),
  'utf8',
);
const tablesPageSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'pages', 'TablesPage.tsx'),
  'utf8',
);

test('NavigationSidebar resolves module labels through resolveNavigationLabel', () => {
  assert.match(sidebarSource, /resolveNavigationLabel/);
  // The unsafe direct lookup that could return the navigation.menu object node
  // must no longer be used for module labels.
  assert.doesNotMatch(sidebarSource, /t\(`navigation\.\$\{module\.id\}`/);
});

test('TablesPage formats seats through formatTableSeats without duplicating the count', () => {
  assert.match(tablesPageSource, /formatTableSeats/);
  assert.doesNotMatch(tablesPageSource, /\{table\.capacity\}\s*\{t\('tables\.seats'/);
});
