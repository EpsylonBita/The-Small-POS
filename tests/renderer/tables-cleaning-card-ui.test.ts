import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const orderDashboardSource = () => read('src/renderer/components/OrderDashboard.tsx');
const tablesDashboardSource = () =>
  read('src/renderer/components/tables/TablesDashboard.tsx');

test('TablesDashboard flags cleaning/maintenance/unavailable tables as needing attention', () => {
  const source = tablesDashboardSource();

  assert.match(
    source,
    /const needsAttention =\s*!hasOpenCheck &&[\s\S]*?displayStatus === 'cleaning'[\s\S]*?displayStatus === 'maintenance'[\s\S]*?displayStatus === 'unavailable'/,
    'a paid cleaning/maintenance/unavailable table must not be treated as ready',
  );
  // Status block uses the needs-attention copy instead of "Ready for guests".
  assert.match(source, /tablesDashboard\.needsCleaning/);
  assert.match(source, /tablesDashboard\.outOfService/);
  // Guest actions (New order / Assign) are gated behind the non-attention branch.
  assert.match(
    source,
    /\{needsAttention \? \([\s\S]*?\{attentionActionLabel\}[\s\S]*?\) : \(/,
    'cleaning tables should show a cleaned/back-in-service action, not New order/Assign',
  );
  assert.match(source, /tablesDashboard\.markCleaned/);
  assert.match(source, /tablesDashboard\.backInService/);
});

test('OrderDashboard table grid gates ready/new-order affordances on cleaning tables', () => {
  const source = orderDashboardSource();

  assert.match(
    source,
    /const needsAttention =\s*!hasOpenCheck &&[\s\S]*?displayStatus === "cleaning"[\s\S]*?displayStatus === "maintenance"[\s\S]*?displayStatus === "unavailable"/,
  );
  assert.match(source, /tablesDashboard\.needsCleaning/);
  assert.match(source, /tablesDashboard\.outOfService/);
  assert.match(
    source,
    /\{needsAttention \? \([\s\S]*?\{attentionActionLabel\}[\s\S]*?\) : \(/,
  );
});

test('OrderDashboard recovers the table filter when a paid table leaves the active status', () => {
  const source = orderDashboardSource();

  assert.match(
    source,
    /if \(currentStatus && currentStatus !== tableStatusFilter\) \{\s*setTableStatusFilter\("all"\);/,
    'closing a check that moved the table out of the active filter should fall back to "all"',
  );
});

test('OrderDashboard recovers the table filter after a table-order save moves the table to occupied', () => {
  const source = orderDashboardSource();

  // The order-save path marks the table occupied via updateTableStatus(..., "occupied", ...).
  assert.match(source, /updateTableStatus\(\s*selectedTable\.id,\s*"occupied"/);

  // After a successful table-order save the filter recovers to "occupied" so the
  // saved table stays visible, but only when it no longer matches the active filter
  // (not "all", not already "occupied").
  assert.match(
    source,
    /if \(\s*isTableOrder &&\s*selectedTable &&\s*tableStatusFilter !== "all" &&\s*tableStatusFilter !== "occupied"\s*\) \{\s*setTableStatusFilter\("occupied"\);\s*\}/,
    'a saved table order that leaves the active filter should switch the grid to "occupied"',
  );
});

test('OrderDashboard dine-in header label uses the shared display helper, not the raw table number', () => {
  const source = orderDashboardSource();

  // The visible dine-in customer/header label runs the table number through the
  // shared display helper so the MenuModal chip reads "#TB01" like the grid/action modal.
  assert.match(
    source,
    /t\("orderFlow\.tableCustomer",\s*\{\s*table: formatTableDisplayNumber\(selectedTable\.tableNumber\),/,
    'the dine-in header label must use formatTableDisplayNumber, not the raw table number',
  );
  // The raw table number is still kept in state for payload / session matching.
  assert.match(source, /setTableNumber\(selectedTable\.tableNumber\.toString\(\)\)/);
  // The label must not regress to interpolating the raw table number directly.
  assert.doesNotMatch(
    source,
    /t\("orderFlow\.tableCustomer",\s*\{\s*table: selectedTable\.tableNumber,/,
  );

  // Locale copy keeps the {{table}} token and never hardcodes a leading '#'.
  for (const lng of ['en', 'el', 'de', 'fr', 'it']) {
    const value = JSON.parse(read(`src/locales/${lng}.json`)).orderFlow.tableCustomer;
    assert.match(value, /\{\{table\}\}/, `${lng} orderFlow.tableCustomer must keep the {{table}} token`);
    assert.doesNotMatch(value, /#\{\{table\}\}/, `${lng} orderFlow.tableCustomer must not hardcode a '#'`);
  }
});

test('OrderDashboard table-grid secondary button is honest per status: pay / manage reservation / new reservation', () => {
  const source = orderDashboardSource();

  // A dedicated handler opens the (portalled/blurred) reservation form directly for
  // the chosen available table, instead of routing to the new-order action modal.
  assert.match(
    source,
    /const handleTableReserve = useCallback\(\(table: RestaurantTable\) => \{[\s\S]*?setSelectedTable\(table\);[\s\S]*?setShowReservationForm\(true\);[\s\S]*?\}, \[\]\);/,
    'handleTableReserve should open the reservation form for the given table',
  );

  // Reserved (no open check) tables are detected so they keep their management path.
  assert.match(
    source,
    /const isReservedTable =\s*!hasOpenCheck && displayStatus === "reserved";/,
    'reserved tables must be distinguished from plain available tables',
  );

  // Three-way secondary button: open-check OR reserved -> handleTableSelect (Pay /
  // manage existing reservation via TableActionModal's edit/no-show/cancel path);
  // only a plain available table reserves directly.
  assert.match(
    source,
    /if \(hasOpenCheck \|\| isReservedTable\) \{\s*handleTableSelect\(table\);\s*\} else \{\s*handleTableReserve\(table\);\s*\}/,
    'reserved tables must keep the TableActionModal management path; only available tables reserve directly',
  );
  // The old two-way branch (which sent reserved tables to a duplicate new-reservation form) is gone.
  assert.doesNotMatch(source, /if \(hasOpenCheck\) \{\s*handleTableSelect\(table\);\s*\} else \{\s*handleTableReserve\(table\);\s*\}/);

  // Honest, distinct labels per branch (open check / reserved / available).
  assert.match(source, /t\("tablesDashboard\.pay", "Pay"\)/);
  assert.match(source, /t\("tableActionModal\.editReservation", \{\s*defaultValue: "Edit Reservation",\s*\}\)/);
  assert.match(source, /t\("tableActionModal\.newReservation", \{\s*defaultValue: "New Reservation",\s*\}\)/);
  // The misleading "Assign" label is gone; "New order" (primary) unchanged.
  assert.doesNotMatch(source, /tablesDashboard\.assign/);
  assert.match(source, /t\("tablesDashboard\.newOrder", "New order"\)/);

  // The reserved-management and new-reservation buttons show genuinely different
  // localized labels (Greek), so the two branches are not interchangeable.
  const el = JSON.parse(read('src/locales/el.json')).tableActionModal;
  assert.notEqual(
    el.editReservation,
    el.newReservation,
    'edit-reservation and new-reservation must be distinct localized labels',
  );
});
