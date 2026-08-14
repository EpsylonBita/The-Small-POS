import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { requireSuccessfulPrintQueueMutation } from '../../src/renderer/utils/print-queue-mutation';

const projectRoot = process.cwd();
const read = (...segments: string[]) =>
  readFileSync(path.join(projectRoot, ...segments), 'utf8');

const panel = () =>
  read('src', 'renderer', 'components', 'printing', 'PrintQueuePanel.tsx');
const printQueueHook = () => read('src', 'renderer', 'hooks', 'usePrintQueue.ts');
const eventBridge = () => read('src', 'lib', 'event-bridge.ts');
const appEvents = () => read('src', 'renderer', 'hooks', 'useAppEvents.ts');
const orderApproval = () =>
  read('src', 'renderer', 'components', 'order', 'OrderApprovalPanel.tsx');

// Regression (audit #5): the panel loaded jobs exactly once (one-shot useEffect)
// with no interval and no event subscription, and lived only in Settings, so a
// stuck queue was invisible until the operator manually hit Refresh.

test('PrintQueuePanel delegates live refresh and request sequencing to usePrintQueue', () => {
  const source = panel();

  assert.match(source, /usePrintQueue\(\{ limit, offset: 0 \}\)/);
  assert.doesNotMatch(source, /setInterval\(|clearInterval\(|getBridge\(|loadSeqRef/);

  const hook = printQueueHook();
  assert.match(hook, /printer:queue-changed/);
  assert.match(hook, /VISIBLE_POLL_MS = 5_000/);
  assert.match(hook, /sequence !== requestSequenceRef\.current/);
});

test('PrintQueuePanel renders native whole-queue counts without recomputing a visible subset', () => {
  const source = panel();

  assert.match(source, /queue\.counts\.active/);
  assert.match(source, /queue\.counts\.failed/);
  assert.match(source, /queue\.counts\.stale/);
  assert.match(source, /queue\.counts\.history/);
  assert.doesNotMatch(source, /failedCount|\.filter\(.*status/);
});

test('print-worker-alert is registered on the event bridge so onEvent can deliver it', () => {
  // onEvent is a no-op for channels absent from EVENT_MAP, so the backend
  // "print-worker-alert" event is undeliverable until it is registered here.
  assert.match(
    eventBridge(),
    /'print-worker-alert'/,
    'print-worker-alert must be an EVENT_MAP entry',
  );
});

test('useAppEvents raises a global operator toast when the print worker is failing', () => {
  const source = appEvents();

  assert.match(
    source,
    /'print-worker-alert'/,
    'the app-level event hook must subscribe to print-worker-alert (fires even when the panel is closed)',
  );
  assert.match(
    source,
    /settings\.printQueue\.workerAlert/,
    'the global alert must use a localized message',
  );
  // A stable toast id keeps the repeating alert from stacking.
  assert.match(
    source,
    /id: 'print-worker-alert'/,
    'the alert toast must use a stable id so repeated alerts collapse',
  );
  // The alert must NOT fire on the customer/kitchen display webviews.
  assert.match(
    source,
    /isExternalDisplayWebview\(\)/,
    'the operator alert must be suppressed on external-display (customer/kitchen) screens',
  );
});

// Regression (review of #5): a silent background poll can race a mutation's refresh;
// out-of-order responses must not clobber fresher state.
test('usePrintQueue drops out-of-order load responses (last-write-wins)', () => {
  const source = printQueueHook();

  assert.match(source, /requestSequenceRef/, 'a monotonic request token must guard against stale responses');
  assert.match(
    source,
    /sequence !== requestSequenceRef\.current/,
    'a stale load response must be dropped instead of clobbering fresher state',
  );
});

// Native counts cover the full query and intentionally overlap; pagination is
// expanded from offset zero so inserts cannot shift an appended page.
test('the panel expands the live queue from offset zero without rewriting native totals', () => {
  const source = panel();

  assert.match(source, /usePrintQueue\(\{ limit, offset: 0 \}\)/);
  assert.match(source, /Math\.min\(MAX_LIMIT, current \+ LIMIT_STEP\)/);
  assert.match(source, /queue\.pagination\.total/);
  assert.doesNotMatch(source, /offset:\s*limit|setJobs\(|\.concat\(/);
});

test('queue controls reject backend success:false responses instead of showing a false success toast', () => {
  assert.throws(
    () =>
      requireSuccessfulPrintQueueMutation(
        { success: false, error: 'queue state was not changed' },
        'fallback',
      ),
    /queue state was not changed/,
  );
  assert.throws(
    () => requireSuccessfulPrintQueueMutation(undefined, 'queue command failed'),
    /queue command failed/,
  );
  assert.deepEqual(
    requireSuccessfulPrintQueueMutation(
      { success: true, affected: 1, activeStopsRequested: 1 },
      'fallback',
    ),
    { success: true, affected: 1, activeStopsRequested: 1 },
  );
});

// #6: proactively surface a queue that is globally paused at startup.
test('useAppEvents warns at startup when the print queue is globally paused', () => {
  const source = appEvents();

  assert.match(source, /pausedAtStartup/, 'a paused-at-startup warning key must be used');
  assert.match(source, /queuePaused/, 'the startup check must read the queue paused flag');
  assert.match(
    source,
    /isExternalDisplayWebview\(\)/,
    'the startup warning must be gated off external-display screens',
  );
});

// #9: a de-duped reprint must not claim a fresh print success.
test('a duplicate reprint is surfaced distinctly, not as a fresh print success', () => {
  const source = orderApproval();

  assert.match(source, /result\?\.duplicate/, 'the reprint path must inspect the duplicate flag');
  assert.match(
    source,
    /printAlreadyQueued/,
    'a duplicate must show a distinct "already queued" message, not "printed successfully"',
  );
  // A disabled print action returns { success:true, skipped:true } — also not a success.
  assert.match(source, /result\?\.skipped/, 'the reprint path must inspect the skipped flag');
  assert.match(
    source,
    /printSkipped/,
    'a skipped (disabled) print must show a distinct message, not "printed successfully"',
  );
});
