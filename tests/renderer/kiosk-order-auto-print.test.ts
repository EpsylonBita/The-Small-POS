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
    /if \(!notifiedOrdersRef\.current\.has\(orderData\.id\)\)/,
    'the chime must fire at most once per order, not on every failed-enqueue retry',
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
