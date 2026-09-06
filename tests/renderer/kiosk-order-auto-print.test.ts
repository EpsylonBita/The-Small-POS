import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const hookPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'hooks',
  'useKioskOrderAutoPrint.ts',
);
const source = () => readFileSync(hookPath, 'utf8');

// Regression (audit #4): the kiosk auto-print handler used to mark an order
// dedup-'printed' and toast success BEFORE a fire-and-forget enqueue whose
// failures were only console.warn'd. A failed enqueue was therefore dropped
// silently forever, behind a misleading success toast.

test('enqueuePrintJobs reports success by inspecting each IpcResult, not just non-throw', () => {
  const hook = source();

  // Both print IPC calls return IpcResult { success }, so a {success:false}
  // result (no throw) must be treated as a failure.
  assert.match(
    hook,
    /kitchenResult\??\.success === true/,
    'kitchen enqueue must inspect result.success, not just catch throws',
  );
  assert.match(
    hook,
    /receiptResult\??\.success === true/,
    'receipt enqueue must inspect result.success, not just catch throws',
  );
  // The function must report an overall success boolean.
  assert.match(
    hook,
    /Promise<boolean>/,
    'enqueuePrintJobs must return a success boolean',
  );
  assert.match(
    hook,
    /return kitchenOk && receiptOk/,
    'overall success requires BOTH the kitchen ticket and the receipt to enqueue',
  );
});

test('the order is marked printed only AFTER a successful enqueue (no silent drop)', () => {
  const hook = source();

  // The enqueue is awaited, not fire-and-forget.
  assert.match(
    hook,
    /const enqueued = await enqueuePrintJobs\(/,
    'enqueuePrintJobs must be awaited so its result gates dedup + toast',
  );
  assert.doesNotMatch(
    hook,
    /void\s+enqueuePrintJobs\(/,
    'fire-and-forget enqueue drops failures silently',
  );

  // The dedup mark must appear AFTER the awaited enqueue (only on success).
  assert.match(
    hook,
    /await enqueuePrintJobs\([\s\S]{0,600}?printedOrdersRef\.current\.set\(/,
    'the order must be dedup-marked only after a successful enqueue',
  );
  // ...and never claimed before the enqueue resolves.
  assert.doesNotMatch(
    hook,
    /printedOrdersRef\.current\.set\([\s\S]{0,160}?await enqueuePrintJobs\(/,
    'must not dedup-mark the order before enqueuing it',
  );
});

test('a failed enqueue surfaces an error toast instead of a false success', () => {
  const hook = source();

  // Success toast is downstream of the awaited enqueue.
  assert.match(
    hook,
    /await enqueuePrintJobs\([\s\S]*?toast\.success\(/,
    'the success toast must fire only after a successful enqueue',
  );
  // A failure path exists and tells the operator to check the queue.
  assert.match(
    hook,
    /toast\.error\(/,
    'a failed enqueue must surface an error toast, not stay silent',
  );
  assert.match(
    hook,
    /kioskAutoPrint\.printFailedToast/,
    'the failure toast must use a dedicated localized key',
  );
});

// Regression (review of #4): a repeatedly-failing order must not re-chime or stack
// error toasts on every realtime-update re-fire, and a throw must never orphan the
// in-flight claim (which the prune interval does not touch).
test('a repeatedly-failing order chimes once, updates one stable toast, and always releases its in-flight claim', () => {
  const hook = source();

  assert.match(
    hook,
    /notifiedOrdersRef/,
    'first-sighting chime must be tracked separately from print success',
  );
  assert.match(
    hook,
    /if \(notifiedOrdersRef\.current\.has\(orderData\.id\)\)\s*\{\s*return;/,
    'the chime must fire at most once per order, not on every re-fire of the arrival events',
  );
  assert.match(
    hook,
    /kiosk-print-failed-\$\{orderData\.id\}/,
    'the failure toast must use a stable per-order id so retries update one toast instead of stacking',
  );
  assert.match(
    hook,
    /finally\s*\{[\s\S]{0,160}?inFlightOrdersRef\.current\.delete\(orderData\.id\)/,
    'the in-flight claim must be released in a finally so a throw cannot permanently block the order',
  );
});

// Founder report 06/09: the slip came out of the printer while the approval
// modal was still asking for a prep time — i.e. before anyone had accepted the
// order (and while it could still be declined). Arrival must only chime; the
// print belongs to the approval handler.
test('arriving kiosk orders are announced but never printed on arrival', () => {
  const hook = source();

  const effect = hook.slice(hook.indexOf('useEffect(() => {'));
  assert.ok(effect.length > 0, 'the arrival listener effect must exist');

  assert.doesNotMatch(
    effect,
    /enqueuePrintJobs\(/,
    'the arrival listeners must not enqueue print jobs — printing waits for approval',
  );
  assert.doesNotMatch(
    effect,
    /printApprovedKioskOrder\(/,
    'the arrival listeners must not print either, directly or indirectly',
  );

  // The chime and the "order received" toast stay on arrival.
  assert.match(
    effect,
    /playKioskNotificationSound\(\)/,
    'an arriving kiosk order must still chime so the operator opens the approval panel',
  );
  assert.match(
    effect,
    /kioskAutoPrint\.newOrderToast/,
    'an arriving kiosk order must still raise the "received" toast',
  );
});

test('the hook exposes an approval-time printer that ignores non-kiosk orders', () => {
  const hook = source();

  assert.match(
    hook,
    /const printApprovedKioskOrder = useCallback\(/,
    'the approval-time printer must be exposed as a stable callback',
  );
  assert.match(
    hook,
    /return \{ kioskOrderCount, printApprovedKioskOrder \}/,
    'the printer must be returned so the approval handler can call it',
  );
  // Non-kiosk orders must fall straight through: efood/Wolt, phone and counter
  // orders keep their existing print behaviour.
  assert.match(
    hook,
    /printApprovedKioskOrder = useCallback\([\s\S]{0,900}?if \(!isKioskOrder\(orderData\)\) return;/,
    'the approval-time printer must ignore non-kiosk orders',
  );
  assert.match(
    hook,
    /export function isKioskOrder/,
    'isKioskOrder must be exported so the approval handler can gate on it',
  );
});

test('the approval handler prints kiosk orders only after a successful approval', () => {
  const dashboard = readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
    'utf8',
  );

  const approveHandler = dashboard.slice(
    dashboard.indexOf('const handleApproveOrder = async ('),
    dashboard.indexOf('const handleDeclineOrder = async ('),
  );
  assert.ok(approveHandler.length > 0, 'handleApproveOrder must exist');

  // Gated on the approval succeeding...
  assert.match(
    approveHandler,
    /const ok = await approveOrder\([\s\S]*?printApprovedKioskOrder\(/,
    'the print must happen after the approval call, not before it',
  );
  // ...and on the order actually being a kiosk order.
  assert.match(
    approveHandler,
    /isKioskOrder\(selectedOrderForApproval\)[\s\S]{0,240}?printApprovedKioskOrder\(/,
    'only kiosk orders may be printed from the shared approval handler',
  );
  // Ordering is what puts the prep time on the ticket: the Rust print command
  // takes only the order id and rebuilds the document from the local row, so
  // `approveOrder` must have persisted estimated_time before the print is
  // enqueued. The order object is passed along for the kiosk check and toast.
  assert.match(
    approveHandler,
    /printApprovedKioskOrder\(\{[\s\S]{0,200}?estimatedTime,/,
    'the approved prep time must travel with the order handed to the printer',
  );
  // A declined order must never print.
  const declineHandler = dashboard.slice(
    dashboard.indexOf('const handleDeclineOrder = async ('),
    dashboard.indexOf('const handleDriverAssignment = async ('),
  );
  assert.doesNotMatch(
    declineHandler,
    /printApprovedKioskOrder\(/,
    'declining an order must never print it',
  );
});
