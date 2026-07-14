import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const read = (...segments: string[]) =>
  readFileSync(path.join(projectRoot, ...segments), 'utf8');

const panel = () =>
  read('src', 'renderer', 'components', 'printing', 'PrintQueuePanel.tsx');
const eventBridge = () => read('src', 'lib', 'event-bridge.ts');
const appEvents = () => read('src', 'renderer', 'hooks', 'useAppEvents.ts');
const orderApproval = () =>
  read('src', 'renderer', 'components', 'order', 'OrderApprovalPanel.tsx');

// Regression (audit #5): the panel loaded jobs exactly once (one-shot useEffect)
// with no interval and no event subscription, and lived only in Settings, so a
// stuck queue was invisible until the operator manually hit Refresh.

test('PrintQueuePanel auto-refreshes on an interval with cleanup', () => {
  const source = panel();

  assert.match(source, /setInterval\(/, 'the panel must poll for live queue status');
  assert.match(
    source,
    /clearInterval\(/,
    'the poll interval must be cleared on unmount to avoid a leak',
  );
  // Background polls must be silent (no loading spinner flicker, no toast spam).
  assert.match(
    source,
    /loadQueue\(\{ silent: true \}\)/,
    'the interval must call loadQueue in silent mode',
  );
  assert.match(
    source,
    /silent/,
    'loadQueue must support a silent background path distinct from the manual load',
  );
});

test('PrintQueuePanel surfaces stuck jobs in the UI', () => {
  const source = panel();

  assert.match(
    source,
    /failedCount/,
    'the panel must derive a count of failed/stuck jobs',
  );
  assert.match(
    source,
    /=== 'failed'/,
    'the stuck-job count is based on failed job status',
  );
  assert.match(
    source,
    /settings\.printQueue\.stuckWarning/,
    'a localized stuck-jobs warning must be shown',
  );
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
test('the panel drops out-of-order load responses (last-write-wins)', () => {
  const source = panel();

  assert.match(source, /loadSeqRef/, 'a monotonic request token must guard against stale responses');
  assert.match(
    source,
    /seq !== loadSeqRef\.current/,
    'a stale load response must be dropped instead of clobbering fresher state',
  );
});

// Regression (review of #5): the banner must not point at failed jobs outside the
// rendered window (which have no reachable Retry/Cancel control).
test('the stuck-jobs banner counts only the visible, rendered jobs', () => {
  const source = panel();

  assert.match(source, /visibleJobs/, 'the render and the count must use the same visible window');
  assert.match(
    source,
    /visibleJobs\.filter\(/,
    'failedCount must be derived from the rendered slice so the banner is not misleading',
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
