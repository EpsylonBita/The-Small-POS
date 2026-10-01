import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Booking a table needs the Reservations module, as on the Android POS
// (DashboardScreen passes canCreateReservation={hasReservationsModule}; the
// (+) -> Table step offers Reservation only with it). Managing a reservation
// that already exists (edit / no-show / cancel) stays available without it.

const read = (...parts: string[]) =>
  readFileSync(path.join(process.cwd(), 'src', 'renderer', ...parts), 'utf8');

const tableActionModalSource = read('components', 'tables', 'TableActionModal.tsx');
const orderDashboardSource = read('components', 'OrderDashboard.tsx');
const orderFlowSource = read('components', 'OrderFlow.tsx');
const tablesPageSource = read('pages', 'TablesPage.tsx');

test('TableActionModal offers New Reservation only when the store can book tables', () => {
  assert.match(tableActionModalSource, /canCreateReservation\?: boolean;/);
  // Defaults to true so a caller that says nothing keeps today's behaviour.
  assert.match(tableActionModalSource, /canCreateReservation = true,/);
  assert.match(tableActionModalSource, /\{!isReservedTable && canCreateReservation && \(\s*<button\s+onClick=\{handleNewReservation\}/);
  // The reserved-table management block is not behind the module.
  assert.match(tableActionModalSource, /\{isReservedTable && \(\s*<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">\s*<button\s+onClick=\{handleEditReservation\}/);
});

test('both order-taking paths pass the Reservations module to the table action modal', () => {
  assert.match(orderDashboardSource, /const hasReservationsModule = hasModule\(MODULE_IDS\.RESERVATIONS\);/);
  assert.match(
    orderDashboardSource,
    /<TableActionModal[\s\S]*?onNewReservation=\{handleTableNewReservation\}\s*canCreateReservation=\{hasReservationsModule\}/,
  );

  assert.match(orderFlowSource, /const hasReservationsModule = hasModule\(MODULE_IDS\.RESERVATIONS\);/);
  assert.match(
    orderFlowSource,
    /<TableActionModal[\s\S]*?onNewReservation=\{handleTableNewReservation\}\s*canCreateReservation=\{hasReservationsModule\}/,
  );
});

test('the Tables tab card books an available table only with the Reservations module', () => {
  assert.match(
    orderDashboardSource,
    /const showTableSecondaryAction =\s*hasOpenCheck \|\| isReservedTable \|\| hasReservationsModule;/,
  );
  // Without the secondary button the primary one takes the whole row.
  assert.match(
    orderDashboardSource,
    /<div className=\{`mt-2 grid gap-2 \$\{showTableSecondaryAction \? "grid-cols-2" : "grid-cols-1"\}`\}>/,
  );
  const gate = orderDashboardSource.indexOf('{showTableSecondaryAction && (');
  assert.ok(gate > 0, 'the secondary card button must be gated');
  const reserve = orderDashboardSource.indexOf('handleTableReserve(table);', gate);
  assert.ok(reserve > gate, 'the reserve shortcut sits inside the gated button');
});

test('the Tables page offers Reserve only with the Reservations module', () => {
  assert.match(tablesPageSource, /import \{ MODULE_IDS, useAcquiredModules \} from '\.\.\/hooks\/useAcquiredModules';/);
  assert.match(tablesPageSource, /const hasReservationsModule = hasModule\(MODULE_IDS\.RESERVATIONS\);/);
  assert.match(tablesPageSource, /canCreateReservation=\{hasReservationsModule\}/);
  assert.match(
    tablesPageSource,
    /\{table\.status === 'available' && canCreateReservation && \(\s*<button\s+onClick=\{\(\) => onNewReservation\(table\)\}/,
  );
});
