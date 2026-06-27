import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const tablesDashboardSource = read('src/renderer/components/tables/TablesDashboard.tsx');
const reservationFormSource = read('src/renderer/components/tables/ReservationForm.tsx');

test('TablesDashboard uses the POS palette for selected controls and table status accents', () => {
  assert.doesNotMatch(
    tablesDashboardSource,
    /blue-|purple-|orange-|focus:ring-blue|ring-blue|shadow-blue/,
    'standalone tables dashboard should not leak old blue, purple, or orange utility classes',
  );
  assert.doesNotMatch(
    tablesDashboardSource,
    /rounded-lg/,
    'table dashboard controls touched in this pass should use smoother rounded-xl/2xl corners',
  );

  assert.match(tablesDashboardSource, /bg-yellow-400 text-black/);
  assert.match(tablesDashboardSource, /border-yellow-400\/45 bg-yellow-500\/10/);
  assert.match(tablesDashboardSource, /border-red-400\/35 bg-red-500\/10/);
  assert.match(tablesDashboardSource, /bg-emerald-600 text-white/);
});

test('ReservationForm existing-reservation warning is amber glass, not blue admin chrome', () => {
  assert.doesNotMatch(reservationFormSource, /border-blue|bg-blue|text-blue/);
  assert.match(reservationFormSource, /border-amber-200 bg-amber-50/);
  assert.match(reservationFormSource, /dark:border-amber-500\/30 dark:bg-amber-500\/10/);
  assert.match(reservationFormSource, /text-amber-800 dark:text-amber-300/);
});
