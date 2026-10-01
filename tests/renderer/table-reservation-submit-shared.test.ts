import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Every desktop table screen saves the ReservationForm through one helper
// (src/renderer/utils/table-reservation-submit.ts), and none of them sends the
// cashier to a route the app does not have (24/09/2026: the Tables page
// Reserve navigated to /reservations?tableId=..., which nothing reads).

const renderer = path.join(process.cwd(), 'src', 'renderer');
const read = (...parts: string[]) => readFileSync(path.join(renderer, ...parts), 'utf8');

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourcesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

test('the dashboard, the order flow and the Tables page share one reservation submit', () => {
  for (const [name, source] of [
    ['OrderDashboard', read('components', 'OrderDashboard.tsx')],
    ['OrderFlow', read('components', 'OrderFlow.tsx')],
    ['TablesPage', read('pages', 'TablesPage.tsx')],
  ] as const) {
    assert.match(source, /import \{ submitTableReservation \} from ['"]\.\.\/utils\/table-reservation-submit['"];/, name);
    assert.match(source, /await submitTableReservation\(\{/, name);
    // The copy that lived in each screen is gone.
    assert.doesNotMatch(source, /createReservationWithTableUpdate\(/, `${name} must not book the table itself`);
  }
});

test('the Tables page Reserve opens the reservation form on that table', () => {
  const source = read('pages', 'TablesPage.tsx');
  assert.match(
    source,
    /const handleNewReservation = useCallback\(\(table: RestaurantTable\) => \{\s*setShowStatusModal\(false\);\s*setSelectedTable\(null\);\s*setReservationTable\(table\);\s*\}, \[\]\);/,
  );
  assert.match(
    source,
    /\{reservationTable && \(\s*<ReservationForm\s+isOpen\s+tableId=\{reservationTable\.id\}\s+tableCapacity=\{reservationTable\.capacity\}\s+tableNumber=\{reservationTable\.tableNumber\}\s+onSubmit=\{handleReservationSubmit\}\s+onCancel=\{handleReservationCancel\}/,
  );
});

test('no renderer source navigates to a /reservations route (the app has none)', () => {
  const app = read('App.tsx');
  assert.doesNotMatch(app, /path="\/reservations"/);
  for (const file of sourcesUnder(renderer)) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /navigate\(\s*[`'"]\/reservations/,
      `${path.relative(renderer, file)} navigates to /reservations, which only the catch-all route matches`,
    );
  }
});

test('reservation toasts use keys every locale has, not raw keys', () => {
  for (const locale of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const toasts = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'locales', `${locale}.json`), 'utf8'),
    ).reservationForm?.toasts;
    for (const key of ['created', 'updated', 'createFailed', 'updateFailed', 'missingContext']) {
      assert.equal(typeof toasts?.[key], 'string', `${locale} reservationForm.toasts.${key}`);
    }
  }
  // These keys never existed in any locale, so i18next showed them raw.
  for (const source of [read('components', 'OrderDashboard.tsx'), read('components', 'OrderFlow.tsx')]) {
    assert.doesNotMatch(source, /t\(["'](orderDashboard|orderFlow)\.(reservationCreated|missingContext)["']\)/);
  }
});
