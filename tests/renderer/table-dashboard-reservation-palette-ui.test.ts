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
  assert.match(tablesDashboardSource, /border-\(--pos-s-border\) bg-\(--pos-s-surface-2\)/);
  assert.match(tablesDashboardSource, /border-\(--pos-s-border\) bg-\(--pos-s-surface-2\)/);
  // Wave ΣΤ7: the table tile action is the yellow primary for both an open check and a free table.
  assert.doesNotMatch(tablesDashboardSource, /bg-emerald-700 text-white/);
});

test('ReservationForm existing-reservation warning is the kit warn notice, not blue admin chrome', () => {
  assert.doesNotMatch(reservationFormSource, /border-blue|bg-blue|text-blue/);
  // Wave ΣΤ3: the solid warn notice tint in both themes (no translucent amber wash).
  assert.match(reservationFormSource, /border border-\(--pos-s-warn\) bg-\(--pos-s-warn-bg\) p-3/);
  assert.match(reservationFormSource, /text-amber-800 dark:text-amber-300/);
});
