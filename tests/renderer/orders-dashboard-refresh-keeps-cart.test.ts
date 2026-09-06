import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Live 06/09/2026 (Το Μικρό Παρίσι): staff were building an order in MenuModal
// when an efood order rang; pressing «Αποδοχή» emptied the cart. The approval
// handler awaits loadOrders(), every store operation flips `isLoading`, and the
// dashboard's early `return <OrderDashboardSkeleton />` replaced the whole tree
// — MenuModal unmounted mid-order and remounted empty. The same early return
// on `error` would drop the draft after a failed approval.

const projectRoot = process.cwd();
const dashboardPath = path.join(projectRoot, 'src', 'renderer', 'components', 'OrderDashboard.tsx');
const source = readFileSync(dashboardPath, 'utf8');

test('OrderDashboard shows the skeleton only for the initial load and never over an open order draft', () => {
  assert.match(source, /const hasCompletedInitialLoadRef = React\.useRef\(false\);/);
  // Armed only on a loading -> idle transition: the store starts idle and the
  // parent dashboard starts the first load from its own (later) effect, so an
  // "if (!isLoading) arm" would fire on the mount render and kill the skeleton.
  assert.match(source, /const wasLoadingRef = React\.useRef\(false\);/);
  assert.match(
    source,
    /if \(wasLoadingRef\.current && !isLoading\) \{\s*hasCompletedInitialLoadRef\.current = true;\s*\}\s*wasLoadingRef\.current = isLoading;/,
  );
  assert.doesNotMatch(source, /if \(!isLoading\) \{\s*hasCompletedInitialLoadRef\.current = true;/);
  assert.match(source, /const isOrderEntryOpen = showMenuModal \|\| showEditMenuModal;/);
  assert.match(
    source,
    /if \(isLoading && isShiftActive && !hasCompletedInitialLoadRef\.current && !isOrderEntryOpen\) \{\s*return <OrderDashboardSkeleton \/>;/,
  );
  // The bare guard that unmounted MenuModal on every refresh is gone.
  assert.doesNotMatch(source, /if \(isLoading && isShiftActive\) \{\s*return <OrderDashboardSkeleton \/>;/);
});

test('OrderDashboard never replaces the tree with the error page while order entry is open', () => {
  assert.match(source, /if \(error && !isOrderEntryOpen\) \{/);
  assert.doesNotMatch(source, /\n\s*if \(error\) \{\s*\n\s*return \(\s*\n\s*<div className="p-6">/);
});

test('MenuModal is rendered unconditionally by the dashboard (mount survives refreshes)', () => {
  assert.match(source, /<MenuModal\s+key=\{menuSessionKey\}\s+isOpen=\{showMenuModal\}/);
});
