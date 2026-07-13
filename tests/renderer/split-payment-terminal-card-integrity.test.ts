import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  createInFlightGuard,
  toTerminalCardPortion,
} from '../../src/renderer/utils/splitPaymentSettlement.ts';

const modalSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'SplitPaymentModal.tsx'),
  'utf8',
);

// --- Gap review 2026-07-10, P0-01 (double charge) and P0-02 (card recorded as cash). ---
//
// P0-01: handleTerminalCardPayment used to arm its re-entry guard via React state
// (portion.status = 'processing') only AFTER two awaited pre-flight sequences, so a
// double-tap on the Card button launched two concurrent bridge.ecr.processPayment
// calls — and the Rust device mutex QUEUES the second exchange instead of rejecting
// it, so the customer's card was charged twice. The fix is a synchronous in-flight
// guard (a ref, not state) acquired before the first await and released in finally.
//
// P0-02: the recordPayment closure captured the `portion` object from BEFORE
// setPortionMethod(..., 'card') ran, so every first-attempt terminal payment was
// persisted with method 'cash' and a cashReceived amount. The fix normalizes the
// captured portion through toTerminalCardPortion and threads THAT object through
// settlement and completion.

// ---------------------------------------------------------------------------
// Behavioral contract: createInFlightGuard
// ---------------------------------------------------------------------------

test('P0-01: in-flight guard rejects a second acquire for the SAME portion while the first is in flight', () => {
  const guard = createInFlightGuard();
  assert.equal(guard.acquire('portion-1'), true, 'first acquire must succeed');
  assert.equal(guard.acquire('portion-1'), false, 'double-tap on the same portion must be rejected');
});

test('P0-01: in-flight guard rejects an acquire for a DIFFERENT portion while one is in flight (one physical terminal)', () => {
  const guard = createInFlightGuard();
  assert.equal(guard.acquire('portion-1'), true);
  assert.equal(guard.acquire('portion-2'), false, 'a second concurrent terminal charge must be rejected regardless of portion');
});

test('P0-01: releasing the active portion unlocks the guard for the next charge', () => {
  const guard = createInFlightGuard();
  assert.equal(guard.acquire('portion-1'), true);
  guard.release('portion-1');
  assert.equal(guard.acquire('portion-2'), true, 'after release the next charge must be allowed');
});

test('P0-01: releasing a non-active id does NOT unlock the active charge', () => {
  const guard = createInFlightGuard();
  assert.equal(guard.acquire('portion-1'), true);
  guard.release('portion-2');
  assert.equal(guard.acquire('portion-3'), false, 'releasing an id that is not in flight must not unlock the guard');
});

// ---------------------------------------------------------------------------
// Behavioral contract: toTerminalCardPortion
// ---------------------------------------------------------------------------

const draftCashPortion = () => ({
  id: 'portion-9',
  label: 'Person 1',
  method: 'cash' as const,
  status: 'draft' as const,
  amount: 42.5,
  grossAmount: 45,
  discountAmount: 2.5,
  items: [{ name: 'Souvlaki', quantity: 2, totalPrice: 45 }],
  paymentOrigin: 'manual' as const,
});

test('P0-02: toTerminalCardPortion normalizes method/origin/device/status for the terminal charge', () => {
  const portion = draftCashPortion();
  const card = toTerminalCardPortion(portion, 'ecr-device-7');
  assert.equal(card.method, 'card', 'a terminal charge must be recorded as card, never the stale draft default cash');
  assert.equal(card.paymentOrigin, 'terminal');
  assert.equal(card.terminalDeviceId, 'ecr-device-7');
  assert.equal(card.status, 'processing');
});

test('P0-02: toTerminalCardPortion preserves the financial identity of the portion', () => {
  const portion = draftCashPortion();
  const card = toTerminalCardPortion(portion, 'ecr-device-7');
  assert.equal(card.id, portion.id);
  assert.equal(card.label, portion.label);
  assert.equal(card.amount, 42.5);
  assert.equal(card.grossAmount, 45);
  assert.equal(card.discountAmount, 2.5);
  assert.deepEqual(card.items, portion.items);
});

test('P0-02: toTerminalCardPortion does not mutate its input', () => {
  const portion = draftCashPortion();
  toTerminalCardPortion(portion, 'ecr-device-7');
  assert.equal(portion.method, 'cash', 'input portion must be left untouched');
  assert.equal(portion.status, 'draft');
  assert.equal(portion.paymentOrigin, 'manual');
});

// ---------------------------------------------------------------------------
// Source contract: SplitPaymentModal must actually be wired to both fixes.
// ---------------------------------------------------------------------------

const handlerSource = (() => {
  const start = modalSource.indexOf('const handleTerminalCardPayment');
  const end = modalSource.indexOf('const handleConfirm');
  assert.ok(start >= 0 && end > start, 'handleTerminalCardPayment must precede handleConfirm in the modal source');
  return modalSource.slice(start, end);
})();

test('P0-01: the modal acquires the synchronous guard BEFORE the first pre-flight await in handleTerminalCardPayment', () => {
  const acquireAt = handlerSource.indexOf('terminalChargeGuard.acquire(portionId)');
  const firstAwaitAt = handlerSource.indexOf('await ensureLatestOutstanding');
  assert.ok(acquireAt >= 0, 'handleTerminalCardPayment must acquire the in-flight guard');
  assert.ok(firstAwaitAt >= 0, 'handler is expected to await the outstanding pre-flight check');
  assert.ok(
    acquireAt < firstAwaitAt,
    'the guard must be acquired synchronously before the pre-flight IPC — arming it after an await reopens the double-tap window',
  );
  // A refactor that swallows the acquire result would pass the position check
  // while reintroducing the bug — pin the reject-and-return wiring.
  assert.match(handlerSource, /if \(!terminalChargeGuard\.acquire\(portionId\)\) \{ toast\.error[\s\S]{0,160}?return; \}/);
});

test('P0-01: the guard is released in a finally block so declined/failed charges unlock the terminal', () => {
  assert.match(handlerSource, /finally\s*\{[^}]*terminalChargeGuard\.release\(portionId\)/);
});

test('P0-01 (round 2): the guard is MODULE-scoped so closing/reopening the modal mid-charge cannot mint a fresh unlocked guard', () => {
  assert.match(
    modalSource,
    /\nconst terminalChargeGuard: InFlightGuard = createInFlightGuard\(\);/,
    'the guard must live at module scope, outside the component',
  );
  assert.doesNotMatch(
    modalSource,
    /useRef[^\n]*createInFlightGuard|terminalChargeGuardRef/,
    'a per-instance ref dies on unmount while the charge keeps running headless',
  );
});

// ---------------------------------------------------------------------------
// Round 2 P0: Confirm Split must hold the SAME guard as the terminal charge.
// During a Card tap's pre-flight IPC the portion is still 'draft' and the
// state-based canConfirm checks pass, so an un-guarded Confirm records the
// portion as a manual payment while the terminal flow charges the card too.
// ---------------------------------------------------------------------------

const confirmSource = (() => {
  const start = modalSource.indexOf('const handleConfirm');
  const end = modalSource.indexOf('const MethodToggle');
  assert.ok(start >= 0 && end > start, 'handleConfirm must precede MethodToggle in the modal source');
  return modalSource.slice(start, end);
})();

test('round 2 P0: handleConfirm acquires the shared guard synchronously before its first await', () => {
  const acquireAt = confirmSource.indexOf('terminalChargeGuard.acquire(CONFIRM_SETTLEMENT_GUARD_ID)');
  const firstAwaitAt = confirmSource.indexOf('await ensureLatestOutstanding');
  assert.ok(acquireAt >= 0, 'handleConfirm must acquire the shared in-flight guard');
  assert.ok(firstAwaitAt >= 0, 'handleConfirm is expected to await the outstanding pre-flight check');
  assert.ok(acquireAt < firstAwaitAt, 'the confirm settlement must be rejected while a terminal charge is in flight');
  assert.match(confirmSource, /if \(!terminalChargeGuard\.acquire\(CONFIRM_SETTLEMENT_GUARD_ID\)\) \{ toast\.error[\s\S]{0,160}?return; \}/);
});

test('round 2 P0: handleConfirm releases the shared guard in finally', () => {
  assert.match(confirmSource, /finally\s*\{[^}]*terminalChargeGuard\.release\(CONFIRM_SETTLEMENT_GUARD_ID\)/);
});

test('round 2 P0 (behavioral): a confirm settlement and a terminal charge are mutually exclusive on the shared guard', () => {
  const guard = createInFlightGuard();
  assert.equal(guard.acquire('portion-1'), true);
  assert.equal(guard.acquire('__confirm-settlement__'), false, 'Confirm must be rejected while a card charge is in flight');
  guard.release('portion-1');
  assert.equal(guard.acquire('__confirm-settlement__'), true);
  assert.equal(guard.acquire('portion-1'), false, 'a card charge must be rejected while a confirm settlement runs');
});

// ---------------------------------------------------------------------------
// Round 2 P1: the modal must be un-closable and its financial inputs locked
// for the WHOLE guarded window (the pre-flight IPC runs before
// portion.status flips to 'processing', which is what the old locks keyed on).
// ---------------------------------------------------------------------------

test('round 2 P1: modal close (X and Escape) is locked while a terminal charge is in flight', () => {
  assert.match(modalSource, /onClose=\{processingPortionId \|\| isProcessing \|\| isTerminalChargeInFlight \? \(\) => undefined : onClose\}/);
  assert.match(modalSource, /closeOnEscape=\{!processingPortionId && !isProcessing && !isTerminalChargeInFlight\}/);
});

test('round 2 P1: the in-flight flag is armed with the guard and cleared in finally', () => {
  const acquireAt = handlerSource.indexOf('terminalChargeGuard.acquire(portionId)');
  const flagAt = handlerSource.indexOf('setIsTerminalChargeInFlight(true)');
  const firstAwaitAt = handlerSource.indexOf('await ensureLatestOutstanding');
  assert.ok(flagAt > acquireAt && flagAt < firstAwaitAt, 'the render-visible flag must be set between acquire and the first await');
  assert.match(handlerSource, /finally\s*\{[\s\S]{0,200}?setIsTerminalChargeInFlight\(false\)/);
});

test('round 2 P3: amount edits, method toggles, and add-person are locked during the guarded window (stale-amount charge)', () => {
  assert.match(modalSource, /disabled=\{portion\.status !== 'draft' \|\| isProcessing \|\| isTerminalChargeInFlight\}/);
  assert.match(modalSource, /const locked = portion\.status !== 'draft' \|\| isProcessing \|\| isTerminalChargeInFlight;/);
  assert.match(modalSource, /disabled=\{Boolean\(processingPortionId\) \|\| isProcessing \|\| isTerminalChargeInFlight\}/);
  assert.match(modalSource, /&& !isTerminalChargeInFlight, \[anyItemsAssigned/);
});

test('P0-02: settlement and recording use the normalized card portion, never the stale draft capture', () => {
  assert.match(
    handlerSource,
    /const cardPortion = toTerminalCardPortion\(portion, terminal\.deviceId\)/,
    'the handler must normalize the captured portion for the terminal charge',
  );
  assert.match(
    handlerSource,
    /settleTerminalPortion\(orderFinancials, cardPortion/,
    'settlement must operate on the card portion',
  );
  assert.match(
    handlerSource,
    /recordPayment: \(transactionId\) => recordPortionPayment\(cardPortion, 'terminal', transactionId/,
    'recordPayment must persist the card portion (method card), not the stale draft (method cash)',
  );
  assert.doesNotMatch(
    handlerSource,
    /recordPortionPayment\(portion, 'terminal'/,
    'the stale-closure record call (the P0-02 bug) must be gone',
  );
});

test('P0-02: completion after a terminal charge reports the card portion to onSplitComplete', () => {
  assert.match(
    handlerSource,
    /completeAndClose\(\[\{ \.\.\.cardPortion, status: 'paid'/,
    'the completed-portion record must carry method card / origin terminal, not the stale draft fields',
  );
  assert.doesNotMatch(handlerSource, /completeAndClose\(\[\{ \.\.\.portion, status: 'paid'/);
});

test('P0-02: the portion state update reuses the same normalization helper (single source of truth)', () => {
  assert.match(
    handlerSource,
    /updatePortion\(portionId, \(current\) => toTerminalCardPortion\(current, terminal!\.deviceId\)\)/,
  );
});
