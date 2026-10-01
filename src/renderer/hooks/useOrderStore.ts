import { createElement } from 'react';
import { create } from 'zustand';
import { mapStatusForPOS, isValidOrderStatus } from '../../shared/types/order-status';
import toast from 'react-hot-toast';
import { Bell } from 'lucide-react';
import { ErrorFactory, ErrorHandler, withTimeout, withRetry, POSError } from '../../shared/utils/error-handler';
import { TIMING, RETRY, ERROR_MESSAGES } from '../../shared/constants';
import type { Order } from '../../shared/types/orders';
import { OrderService } from '../../services/OrderService';
import { getBridge, offEvent, onEvent } from '../../lib';
import {
  extractPaymentIntegrityPayload,
  summarizeUnsettledPaymentBlockers,
} from '../../lib/payment-integrity';
import type { PaymentIntegrityErrorPayload } from '../../lib/ipc-contracts';
import { pollFiscalReceiptStatus } from '../services/fiscal-status';
import { sortOrdersOldestFirst } from '../utils/order-sorting';
import { debugLog } from '../utils/debugLog';
import { getVisibleOrderNumber } from '../utils/orderNumberUtils';
import { orderNeedsApproval } from '../../../../shared/order-approval';
import {
  giftCardCheckoutService,
  giftCardOrderKey,
  type GiftCardAdmission,
  type GiftCardOrdinaryHold,
  type GiftCardOrdinaryResolution,
} from '../services/GiftCardCheckoutService';
import type { GiftCardScope } from '../services/GiftCardsApiService';

// Track self-created order IDs to suppress "new order received" toasts for own orders.
// Since Rust no longer emits order_created for self-created orders, this is a safety net
// in case order_save_from_remote echoes back our own order.
const _recentlyCreatedOrderIds = new Set<string>();

// ---------------------------------------------------------------------------
// Existing-order ordinary collection owners (memory only).
//
// The gift checkout service keeps one gift/ordinary collection hold per
// organization, public terminal and order. The records below keep each
// ordinary hold's exact token, its original operation and the raw facts of
// its reply above any modal or host lifetime, so a late authoritative result
// still settles the original hold and a remount continues it instead of
// minting another. Nothing here is persisted, logged or serialized; unmount,
// module, auth or elapsed time never clear an unknown owner.
// ---------------------------------------------------------------------------

export interface OrdinaryCollectionScope {
  organizationId?: string | null;
  terminalId?: string | null;
}

/** Fixed when the first send starts and never replaced. */
export interface OrdinaryCollectionOriginal {
  method: 'cash' | 'card';
  amount: number;
  /** Caller reference; for outstanding collection it is also the idempotency key. */
  transactionRef: string | null;
  idempotencyKey: string | null;
  /** Opaque native settlement generation the write was validated against. */
  settlementGeneration: string | null;
  /** Exact EFT transaction ID once the terminal answered. */
  terminalTransactionId: string | null;
}

/** Raw facts of the original write reply; never reduced to one failure flag. */
export interface OrdinaryCollectionFacts {
  replyLost: boolean;
  success: boolean | null;
  paymentApproved: boolean | null;
  paymentPersisted: boolean | null;
  requiresReconciliation: boolean | null;
  paymentId: string | null;
  code: string | null;
}

/** Ownership of one ordinary hold, checked by identity; never copy, log or persist it. */
export interface OrdinaryCollectionOwner {
  readonly key: string;
  readonly orderId: string;
  readonly scope: Readonly<{ organizationId: string; terminalId: string }>;
  readonly hold: GiftCardOrdinaryHold;
}

export type OrdinaryCollectionClaim =
  | { claimed: true; owner: OrdinaryCollectionOwner }
  | {
      claimed: false;
      code: string;
      admission: GiftCardAdmission;
      /** The retained owner of this order's unknown ordinary collection, if any. */
      retained: OrdinaryCollectionOwner | null;
    };

export type OrdinaryCollectionPhase = 'held' | 'preflight' | 'sending' | 'unknown';

export interface OrdinaryCollectionView {
  phase: OrdinaryCollectionPhase;
  original: OrdinaryCollectionOriginal | null;
  facts: OrdinaryCollectionFacts | null;
}

export type OrdinaryCollectionVerdict = 'completed' | 'not_sent' | 'unknown';

export type OrdinaryCollectionRun<T> =
  | { status: 'refused'; code: string }
  | { status: OrdinaryCollectionVerdict; value: T | undefined; code: string | null };

export type OrdinaryTerminalVerdict =
  | { verdict: 'approved'; transactionId: string; message: string | null }
  | { verdict: 'not_sent'; transactionId: string; message: string | null }
  | { verdict: 'unknown'; transactionId: string | null; message: string | null };

export type OrdinaryCollectionProbe<T> = {
  status: 'completed' | 'unknown' | 'not_current';
  value: T | null;
};

/** One write of a multi-write original, with its own caller reference. */
interface OrdinaryBatchWrite {
  facts: OrdinaryCollectionFacts;
  transactionRef: string | null;
}

interface OrdinaryOwnerRecord extends OrdinaryCollectionView {
  owner: OrdinaryCollectionOwner;
  probe: Promise<OrdinaryCollectionProbe<unknown>> | null;
  /** Every write of a multi-write original, in send order; empty for a single write. */
  writes: OrdinaryBatchWrite[];
}

const ORDINARY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
// Native payment refusals returned before any fiscal device call or money
// write (idempotency key and expected-settlement checks). No other code proves
// nothing moved: a fiscal checkout failure may follow the device call.
const ORDINARY_PRE_DISPATCH_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_INVALID',
  'BALANCE_CHANGED',
  'EXPECTED_SETTLEMENT_REQUIRED',
  // `payment_record` refuses a new tender first thing, before any fiscal
  // dispatch or write, while a charged payment of the order is not saved
  // (`unsaved_payments`, 30/09/2026). Nothing moved; that record holds the Z.
  'PAYMENT_NOT_SAVED_PENDING',
]);
/**
 * Native answer for money that moved on an order already covered: persisted
 * set aside for a manager to give back (`payment_review`, 30/09/2026). The
 * original operation is booked, so its ordinary hold ends, but it is never a
 * collection: the caller shows the set-aside notice (`isSetAsideOrdinaryWrite`).
 */
const PAYMENT_SET_ASIDE_CODE = 'PAYMENT_SET_ASIDE_FOR_REVIEW';
const ordinaryOwnerRecords = new Map<string, OrdinaryOwnerRecord>();
const ordinaryOwnerTokens = new WeakMap<OrdinaryCollectionOwner, OrdinaryOwnerRecord>();
const adoptedGiftPaymentIds = new Map<string, Set<string>>();

const toGiftScope = (scope: OrdinaryCollectionScope | null | undefined): GiftCardScope => ({
  organizationId: scope?.organizationId ?? null,
  terminalId: scope?.terminalId ?? null,
});
const trimmedText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const ordinaryFlag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const ordinaryCode = (...values: unknown[]): string | null => {
  for (const value of values) {
    const code = trimmedText(value);
    if (ORDINARY_CODE_PATTERN.test(code)) return code;
  }
  return null;
};

const dropOrdinaryRecord = (record: OrdinaryOwnerRecord): void => {
  if (ordinaryOwnerRecords.get(record.owner.key) === record) ordinaryOwnerRecords.delete(record.owner.key);
};

/** The owner's record while the service still holds its exact token. */
const currentOrdinaryRecord = (
  owner: OrdinaryCollectionOwner | null | undefined,
): OrdinaryOwnerRecord | null => {
  const record = owner ? ordinaryOwnerTokens.get(owner) : undefined;
  if (!record) return null;
  if (giftCardCheckoutService.ordinaryHoldStatus(record.owner.hold) === null) {
    dropOrdinaryRecord(record);
    return null;
  }
  return record;
};

const settleOrdinaryRecord = (
  record: OrdinaryOwnerRecord,
  verdict: OrdinaryCollectionVerdict,
  code: string | null,
): void => {
  const resolution: GiftCardOrdinaryResolution =
    verdict === 'completed'
      ? { outcome: 'completed' }
      : verdict === 'not_sent'
        ? { outcome: 'not_sent', basis: 'original_operation' }
        : { outcome: 'unknown', code };
  const release = giftCardCheckoutService.resolveOrdinaryCollection(record.owner.hold, resolution);
  // Keyed on the resolution sent, not the verdict: an unknown hold keeps its record.
  if (resolution.outcome !== 'unknown' && release.applied) {
    dropOrdinaryRecord(record);
    return;
  }
  record.phase = 'unknown';
};

/**
 * Claims the order for one ordinary cash/card collection. Synchronous: call it
 * before the first await (selection delay, print policy, terminal discovery,
 * recovery or write). Refused while any gift or ordinary hold exists, and
 * without a resolved organization and public terminal.
 */
export function claimOrdinaryCollectionOwner(
  scope: OrdinaryCollectionScope | null | undefined,
  orderId: string | null | undefined,
): OrdinaryCollectionClaim {
  const giftScope = toGiftScope(scope);
  const id = trimmedText(orderId);
  const claim = giftCardCheckoutService.claimOrdinaryCollection(giftScope, id);
  if (!claim.claimed) {
    return {
      claimed: false,
      code: claim.code,
      admission: claim.admission,
      retained: retainedOrdinaryOwner(scope, id),
    };
  }
  const owner: OrdinaryCollectionOwner = Object.freeze({
    key: giftCardOrderKey(giftScope, id),
    orderId: claim.hold.orderId,
    scope: Object.freeze({
      organizationId: claim.hold.organizationId,
      terminalId: claim.hold.terminalId,
    }),
    hold: claim.hold,
  });
  const record: OrdinaryOwnerRecord = { owner, phase: 'held', original: null, facts: null, probe: null, writes: [] };
  ordinaryOwnerRecords.set(owner.key, record);
  ordinaryOwnerTokens.set(owner, record);
  return { claimed: true, owner };
}

/** The retained owner of this order's unknown ordinary collection; the original, never a copy. */
export function retainedOrdinaryOwner(
  scope: OrdinaryCollectionScope | null | undefined,
  orderId: string | null | undefined,
): OrdinaryCollectionOwner | null {
  const id = trimmedText(orderId);
  if (!id) return null;
  const record = ordinaryOwnerRecords.get(giftCardOrderKey(toGiftScope(scope), id));
  if (!record || currentOrdinaryRecord(record.owner) !== record) return null;
  return record.phase === 'unknown' ? record.owner : null;
}

export function ordinaryCollectionView(
  owner: OrdinaryCollectionOwner | null | undefined,
): OrdinaryCollectionView | null {
  const record = currentOrdinaryRecord(owner);
  if (!record) return null;
  return {
    phase: record.phase,
    original: record.original ? { ...record.original } : null,
    facts: record.facts ? { ...record.facts } : null,
  };
}

/** Ends a claim nothing was sent under. Refused once the owner's send gate opened. */
export function releaseOrdinaryOwnerBeforeSend(
  owner: OrdinaryCollectionOwner | null | undefined,
): boolean {
  const record = currentOrdinaryRecord(owner);
  if (!record || record.phase !== 'held') return false;
  const release = giftCardCheckoutService.resolveOrdinaryCollection(record.owner.hold, {
    outcome: 'not_sent',
    basis: 'before_send',
  });
  if (release.applied) dropOrdinaryRecord(record);
  return release.applied;
}

/**
 * Runs the owner's one send. The gate is synchronous, so a second callback
 * sharing this owner is refused while the first runs or after it sent, and
 * never touches the hold. The holder preflight runs after every earlier await
 * and immediately before `send`; its refusal sent nothing and ends the claim.
 * `send` classifies its own raw replies; a throw after the gate may hide a
 * send and stays unknown. Unknown keeps the hold and this record so only the
 * original operation's retry can settle it.
 */
export async function runOrdinaryCollection<T>(
  owner: OrdinaryCollectionOwner,
  original: OrdinaryCollectionOriginal,
  send: () => Promise<{ verdict: OrdinaryCollectionVerdict; value: T; code?: string | null }>,
): Promise<OrdinaryCollectionRun<T>> {
  const record = currentOrdinaryRecord(owner);
  if (!record) return { status: 'refused', code: 'GIFT_CARD_HOLD_NOT_CURRENT' };
  if (record.phase !== 'held') return { status: 'refused', code: 'ORDINARY_COLLECTION_ALREADY_OWNED' };
  record.phase = 'preflight';
  let proceed = false;
  let code: string | null = null;
  try {
    const preflight = await giftCardCheckoutService.preflightOrdinaryCollection(record.owner.hold);
    proceed = preflight.proceed;
    code = preflight.code;
  } catch {
    code = 'GIFT_CARD_RECOVERY_REQUIRED';
  }
  if (!proceed || currentOrdinaryRecord(owner) !== record || record.phase !== 'preflight') {
    if (record.phase === 'preflight') {
      record.phase = 'held';
      releaseOrdinaryOwnerBeforeSend(owner);
    }
    return { status: 'refused', code: code ?? 'GIFT_CARD_HOLD_NOT_CURRENT' };
  }
  record.phase = 'sending';
  record.original = { ...original };
  let outcome: { verdict: OrdinaryCollectionVerdict; value: T | undefined; code: string | null };
  try {
    const result = await send();
    // Anything but an explicit completed/not_sent may hide a send.
    const verdict: OrdinaryCollectionVerdict =
      result.verdict === 'completed' || result.verdict === 'not_sent' ? result.verdict : 'unknown';
    outcome = { verdict, value: result.value, code: result.code ?? null };
  } catch {
    outcome = { verdict: 'unknown', value: undefined, code: 'ORDINARY_COLLECTION_OUTCOME_UNKNOWN' };
  }
  settleOrdinaryRecord(record, outcome.verdict, outcome.code);
  return { status: outcome.verdict, value: outcome.value, code: outcome.code };
}

/** Reads a native payment write reply without reducing it to one failure flag. */
export function readOrdinaryWriteReply(raw: unknown, threw = false): OrdinaryCollectionFacts {
  const reply = !threw && raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!reply) {
    return {
      replyLost: true,
      success: null,
      paymentApproved: null,
      paymentPersisted: null,
      requiresReconciliation: null,
      paymentId: null,
      code: null,
    };
  }
  const data = reply.data && typeof reply.data === 'object' ? (reply.data as Record<string, unknown>) : null;
  return {
    replyLost: false,
    success: ordinaryFlag(reply.success),
    paymentApproved: ordinaryFlag(reply.paymentApproved),
    paymentPersisted: ordinaryFlag(reply.paymentPersisted),
    requiresReconciliation: ordinaryFlag(reply.requiresReconciliation),
    paymentId: trimmedText(reply.paymentId) || trimmedText(data?.paymentId) || null,
    code: ordinaryCode(reply.errorCode, reply.code),
  };
}

/**
 * Only native's own reply classifies the original write: success with a
 * payment ID completes it, and explicit not-approved/not-persisted flags
 * prove it moved no money only together with a refusal native returns before
 * any fiscal dispatch. A fiscal checkout failure (which may follow the device
 * call), transport loss, a generic refusal or approval without booking stays
 * unknown; false flags alone never prove nothing was sent. A payment set aside
 * for review is booked (`isSetAsideOrdinaryWrite`), and a charged payment not
 * saved (`PAYMENT_NOT_SAVED`) stays unknown while its native record holds the Z.
 */
export function classifyOrdinaryWrite(
  facts: Pick<
    OrdinaryCollectionFacts,
    'replyLost' | 'success' | 'paymentApproved' | 'paymentPersisted' | 'requiresReconciliation' | 'paymentId'
  > & { code?: string | null },
): OrdinaryCollectionVerdict {
  if (facts.replyLost || facts.requiresReconciliation === true) return 'unknown';
  if (isSetAsideOrdinaryWrite(facts)) return 'completed';
  if (facts.success === true) {
    return facts.paymentId && facts.paymentPersisted !== false ? 'completed' : 'unknown';
  }
  if (
    facts.success === false &&
    facts.paymentApproved === false &&
    facts.paymentPersisted === false &&
    typeof facts.code === 'string' &&
    ORDINARY_PRE_DISPATCH_CODES.has(facts.code)
  ) {
    return 'not_sent';
  }
  return 'unknown';
}

/**
 * The write persisted money that moved as a payment set aside for review (the
 * order was already covered). Booked, never a collection: show the set-aside
 * notice and never offer the amount as still due.
 */
export function isSetAsideOrdinaryWrite(
  facts: Pick<OrdinaryCollectionFacts, 'success' | 'paymentPersisted'> & { code?: string | null },
): boolean {
  return facts.success === false && facts.paymentPersisted === true && facts.code === PAYMENT_SET_ASIDE_CODE;
}

/** Keeps the original reply facts; a later probe or retry never replaces them. */
export function noteOrdinaryWriteFacts(
  owner: OrdinaryCollectionOwner,
  facts: OrdinaryCollectionFacts,
): void {
  const record = currentOrdinaryRecord(owner);
  if (!record || record.facts) return;
  record.facts = {
    replyLost: facts.replyLost,
    success: facts.success,
    paymentApproved: facts.paymentApproved,
    paymentPersisted: facts.paymentPersisted,
    requiresReconciliation: facts.requiresReconciliation,
    paymentId: facts.paymentId,
    code: facts.code,
  };
}

/**
 * Keeps one write of a multi-write original (Split Confirm) with its own
 * reference. Every write is retained: an earlier booked write never stands in
 * for a later uncertain one.
 */
export function noteOrdinaryBatchWrite(
  owner: OrdinaryCollectionOwner,
  facts: OrdinaryCollectionFacts,
  transactionRef: string | null | undefined,
): void {
  const record = currentOrdinaryRecord(owner);
  if (!record || record.phase !== 'sending') return;
  noteOrdinaryWriteFacts(owner, facts);
  record.writes.push({ facts: { ...facts }, transactionRef: trimmedText(transactionRef) || null });
}

const completedLedgerRows = (completedPayments: readonly unknown[]): Record<string, unknown>[] =>
  completedPayments.filter((row): row is Record<string, unknown> => {
    if (!row || typeof row !== 'object') return false;
    const status = trimmedText((row as Record<string, unknown>).status).toLowerCase();
    return !status || status === 'completed' || status === 'paid';
  });

/**
 * A multi-write original is proven only when every uncertain write has its
 * own distinct completed row, by that write's payment ID or reference. The row
 * of an already booked write never proves another write, and an uncertain
 * write with neither identity leaves the batch unprovable.
 */
function ledgerHasEveryUncertainWrite(
  writes: readonly OrdinaryBatchWrite[],
  completedPayments: readonly unknown[],
): boolean {
  const rows = completedLedgerRows(completedPayments);
  const booked = new Set<string>();
  for (const write of writes) {
    if (write.facts.paymentId && classifyOrdinaryWrite(write.facts) === 'completed') booked.add(write.facts.paymentId);
  }
  const uncertain = writes.filter((write) => classifyOrdinaryWrite(write.facts) === 'unknown');
  if (uncertain.length === 0) return false;
  const used = new Set<number>();
  return uncertain.every((write) => {
    const paymentId = write.facts.paymentId;
    const ref = write.transactionRef;
    if (!paymentId && !ref) return false;
    const index = rows.findIndex((payment, position) => {
      if (used.has(position)) return false;
      const ids = [payment.id, payment.paymentId, payment.localPaymentId].map(trimmedText).filter(Boolean);
      if (ids.some((id) => booked.has(id))) return false;
      const rowRef = trimmedText(payment.transactionRef) || trimmedText(payment.transaction_ref);
      return (Boolean(paymentId) && ids.includes(paymentId as string)) || (Boolean(ref) && rowRef === ref);
    });
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}

/**
 * A direct EFT reply proves approval only with an exact transaction ID and an
 * approved status, and proves no money moved only with that ID and a final
 * declined or cancelled status. A thrown call, a generic failure or any other
 * status may hide a charge and stays unknown.
 */
export function classifyOrdinaryTerminalReply(raw: unknown, threw = false): OrdinaryTerminalVerdict {
  const reply = !threw && raw && typeof raw === 'object' ? (raw as Record<string, any>) : null;
  if (!reply) return { verdict: 'unknown', transactionId: null, message: null };
  const tx = reply.transaction ?? reply.data?.transaction ?? reply.data ?? reply;
  const transactionId =
    trimmedText(tx?.transactionId) ||
    trimmedText(tx?.id) ||
    trimmedText(reply.transactionId) ||
    trimmedText(reply.id) ||
    null;
  const status = trimmedText(tx?.status ?? reply.status).toLowerCase();
  const message = trimmedText(tx?.errorMessage ?? reply.error ?? reply.data?.error) || null;
  if (transactionId && reply.success === true && status === 'approved') {
    return { verdict: 'approved', transactionId, message };
  }
  if (
    transactionId &&
    typeof reply.success === 'boolean' &&
    (status === 'declined' || status === 'cancelled' || status === 'canceled')
  ) {
    return { verdict: 'not_sent', transactionId, message };
  }
  return { verdict: 'unknown', transactionId, message };
}

/** Records the exact EFT transaction ID of the original send; never replaced. */
export function noteOrdinaryTerminalTransaction(
  owner: OrdinaryCollectionOwner,
  transactionId: string | null | undefined,
): void {
  const record = currentOrdinaryRecord(owner);
  const id = trimmedText(transactionId);
  if (!record?.original || record.original.terminalTransactionId || !id) return;
  record.original = { ...record.original, terminalTransactionId: id };
}

/** Whether a completed canonical row is the original payment, by exact payment ID or reference. */
export function ledgerHasOriginalOrdinaryPayment(
  owner: OrdinaryCollectionOwner,
  completedPayments: readonly unknown[] | null | undefined,
): boolean {
  const record = currentOrdinaryRecord(owner);
  if (!record?.original || !Array.isArray(completedPayments)) return false;
  if (record.writes.length > 0) return ledgerHasEveryUncertainWrite(record.writes, completedPayments);
  const paymentId = record.facts?.paymentId ?? null;
  const refs = [record.original.transactionRef, record.original.terminalTransactionId].filter(
    (ref): ref is string => Boolean(ref),
  );
  if (!paymentId && refs.length === 0) return false;
  return completedPayments.some((row) => {
    if (!row || typeof row !== 'object') return false;
    const payment = row as Record<string, unknown>;
    const status = trimmedText(payment.status).toLowerCase();
    if (status && status !== 'completed' && status !== 'paid') return false;
    if (paymentId && [payment.id, payment.paymentId, payment.localPaymentId].some((value) => trimmedText(value) === paymentId)) {
      return true;
    }
    const ref = trimmedText(payment.transactionRef) || trimmedText(payment.transaction_ref);
    return Boolean(ref) && refs.includes(ref);
  });
}

/**
 * Snapshot-only continuation of the retained original: never a resend and
 * never a new key. Completed only when the canonical ledger holds the
 * original payment; anything else keeps the hold. Probes of one owner share
 * one read.
 */
export function probeOrdinaryOwner<T>(
  owner: OrdinaryCollectionOwner,
  read: () => Promise<{ completedPayments: readonly unknown[]; value: T } | null>,
): Promise<OrdinaryCollectionProbe<T>> {
  const record = currentOrdinaryRecord(owner);
  if (!record) return Promise.resolve({ status: 'not_current', value: null });
  if (record.phase !== 'unknown') return Promise.resolve({ status: 'unknown', value: null });
  if (record.probe) return record.probe as Promise<OrdinaryCollectionProbe<T>>;
  const probe = (async (): Promise<OrdinaryCollectionProbe<T>> => {
    let snapshot: { completedPayments: readonly unknown[]; value: T } | null = null;
    try {
      snapshot = await read();
    } catch {
      snapshot = null;
    }
    if (currentOrdinaryRecord(owner) !== record) {
      return { status: 'not_current', value: snapshot?.value ?? null };
    }
    if (snapshot && ledgerHasOriginalOrdinaryPayment(owner, snapshot.completedPayments)) {
      settleOrdinaryRecord(record, 'completed', null);
      return { status: 'completed', value: snapshot.value };
    }
    return { status: 'unknown', value: snapshot?.value ?? null };
  })();
  record.probe = probe;
  void probe.then(() => {
    if (record.probe === probe) record.probe = null;
  });
  return probe;
}

/**
 * Canonical gift payment IDs this renderer already adopted for the order.
 * Returns only unseen IDs so adoption stays idempotent across remounts; a
 * gift payment is never re-recorded anywhere.
 */
export function adoptGiftCardPaymentIds(
  scope: OrdinaryCollectionScope | null | undefined,
  orderId: string | null | undefined,
  paymentIds: readonly string[],
): string[] {
  const id = trimmedText(orderId);
  if (!id) return [];
  const key = giftCardOrderKey(toGiftScope(scope), id);
  const seen = adoptedGiftPaymentIds.get(key) ?? new Set<string>();
  adoptedGiftPaymentIds.set(key, seen);
  const fresh: string[] = [];
  for (const paymentId of paymentIds) {
    const value = trimmedText(paymentId);
    if (value && !seen.has(value)) {
      seen.add(value);
      fresh.push(value);
    }
  }
  return fresh;
}

const isGiftCardPaymentMethod = (method: unknown): boolean => {
  const normalized = String(method ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'gift_card' || normalized === 'giftcard' || normalized === 'gift';
};

const isCancelledOrderStatus = (status: unknown): boolean => {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
};

// Conflict and retry interfaces
interface OrderConflict {
  id: string;
  orderId: string;
  localVersion: number;
  remoteVersion: number;
  conflictType: string;
  createdAt: string;
}

interface SyncRetryInfo {
  orderId: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string;
  retryDelayMs: number;
  lastError?: string;
}

interface UpdateOrderStatusDetailedResult {
  success: boolean;
  errorMessage?: string;
  paymentIntegrityPayload?: PaymentIntegrityErrorPayload | null;
  /**
   * `ORDER_HAS_PAYMENTS`: the till refused to cancel an order money was
   * taken on (fix review 30/09/2026); the screen tells the cashier to void or
   * refund it from the order first, or to collect the rest.
   * `ORDER_PAYMENT_NOT_RECORDED`: the order is labelled paid but its payment
   * is not recorded on this till (founder rule 01/10/2026); the screen tells
   * the cashier to restore it from the server or record it first.
   */
  errorCode?: 'ORDER_HAS_PAYMENTS' | 'ORDER_PAYMENT_NOT_RECORDED';
}

/** The till's refusal to cancel an order money was taken on. */
const ORDER_HAS_PAYMENTS = 'ORDER_HAS_PAYMENTS';
/** The till's refusal to cancel a paid label with no payment record here. */
const ORDER_PAYMENT_NOT_RECORDED = 'ORDER_PAYMENT_NOT_RECORDED';

/**
 * A checkout that carries its payment can wait on the card terminal for as
 * long as the terminal's own timeout (120 s by default for the CAP driver,
 * 60 s for ZVT); the till then answers definitively. The screen used to give
 * up after 15 s and call it a failure while the terminal still waited for the
 * card: pressing Pay again started a second checkout and a second charge (fix
 * review 30/09/2026). It now waits past the terminal's timeout, and a checkout
 * still without an answer is reported as unknown, never as failed.
 */
const CHECKOUT_WITH_PAYMENT_TIMEOUT_MS = 180_000;
const CHECKOUT_OUTCOME_UNKNOWN = 'CHECKOUT_OUTCOME_UNKNOWN';
const CHECKOUT_IN_PROGRESS = 'CHECKOUT_IN_PROGRESS';

const rawErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
};

interface RoomChargeOrderResult {
  applied: boolean;
  code?: string;
  error?: string;
  folioChargeId?: string;
}

interface UpdateOrderStatusOptions {
  cancellationReason?: string;
  cancelledAt?: string;
}

// IPC response interfaces for bridge calls
interface IpcResult {
  success?: boolean;
  error?: string;
  orderId?: string;
  status?: string;
  data?: {
    orderId?: string;
    driverName?: string;
    earningCreated?: boolean;
    status?: string;
  };
  driverName?: string;
  earningCreated?: boolean;
}

// IPC result for operations that return complex error objects
interface IpcResultWithDetailedError {
  success?: boolean;
  error?: string | { userMessage?: string; message?: string };
  orderId?: string;
  status?: string;
  data?: { orderId?: string; status?: string };
}

// Define the order store interface
interface OrderStore {
  orders: Order[];
  pendingExternalOrders: Order[];
  selectedOrder: Order | null;
  isLoading: boolean;
  error: POSError | null;
  loadingOperations: Set<string>;
  filter: {
    status: string;
    orderType: string;
    searchTerm: string;
  };

  // Conflict and retry state
  conflicts: OrderConflict[];
  syncRetries: Map<string, SyncRetryInfo>;

  // Cached/computed values
  _filteredOrders: Order[] | null;
  _orderCounts: { pending: number; preparing: number; ready: number; completed: number; cancelled: number } | null;

  // Actions
  initializeOrders: () => Promise<void>;
  loadOrders: () => Promise<void>;
  getOrderById: (orderId: string) => Promise<Order | null>;
  updateOrderStatus: (orderId: string, status: Order['status'], options?: UpdateOrderStatusOptions) => Promise<boolean>;
  updateOrderStatusDetailed: (
    orderId: string,
    status: Order['status'],
    options?: UpdateOrderStatusOptions,
  ) => Promise<UpdateOrderStatusDetailedResult>;
  returnCancelledToPending: (orderId: string) => Promise<boolean>;
  createOrder: (orderData: Partial<Order>) => Promise<{
    success: boolean;
    orderId?: string;
    orderNumber?: string;
    clientRequestId?: string;
    client_request_id?: string;
    clientOrderId?: string;
    client_order_id?: string;
    error?: string;
    savedForRetry?: boolean;
    roomCharge?: RoomChargeOrderResult;
    /**
     * Item E (30/09/2026): the card was charged at checkout and the order
     * could not be saved yet. The till holds the order for "Save payment
     * again": never retry it as a new checkout (that is a second charge).
     */
    paymentNotSaved?: boolean;
    errorCode?: string;
    amountCents?: number;
    unsavedPayment?: unknown;
    /**
     * Fix review 30/09/2026: the checkout's payment has no answer yet (the
     * card terminal is still waiting, `CHECKOUT_OUTCOME_UNKNOWN`, or the same
     * checkout is still in progress, `CHECKOUT_IN_PROGRESS`). Never a
     * failure to retry as a new checkout: the screen keeps the cart and its
     * checkout id, so pressing Pay again checks the same payment.
     */
    outcomeUnknown?: boolean;
  }>;
  setSelectedOrder: (order: Order | null) => void;
  setFilter: (filter: Partial<OrderStore['filter']>) => void;
  getFilteredOrders: () => Order[];
  getOrderCounts: () => { pending: number; preparing: number; ready: number; completed: number; cancelled: number };
  refreshOrders: () => Promise<void>;
  /** Silent refresh that updates orders without triggering loading state - ideal for background polling */
  silentRefresh: () => Promise<void>;
  updatePaymentStatus: (orderId: string, paymentStatus: NonNullable<Order['paymentStatus']>, paymentMethod?: Order['paymentMethod'], transactionId?: string) => Promise<boolean>;
  processPayment: (orderId: string, paymentData: { method: Order['paymentMethod']; amount: number; [key: string]: any }) => Promise<{ success: boolean; transactionId?: string; error?: string }>;

  // Kitchen operations
  updatePreparationStatus: (orderId: string, status: 'preparing' | 'ready' | 'completed') => Promise<boolean>;
  printKitchenTicket: (orderId: string) => Promise<{ success: boolean; error?: string }>;
  getKitchenOrders: () => Order[];
  updateEstimatedTime: (orderId: string, estimatedTime: number) => Promise<boolean>;

  // Order approval operations
  approveOrder: (orderId: string, estimatedTime?: number) => Promise<boolean>;
  declineOrder: (orderId: string, reason: string) => Promise<boolean>;
  assignDriver: (orderId: string, driverId: string, notes?: string) => Promise<boolean>;
  convertToPickup: (orderId: string) => Promise<boolean>;
  updatePreparationProgress: (orderId: string, stage: string, progress: number) => Promise<boolean>;

  // Error handling
  getLastError: (operation?: string) => POSError | null;
  clearError: () => void;
  isOperationLoading: (operation: string) => boolean;

  // Conflict resolution
  getConflicts: () => OrderConflict[];
  resolveConflict: (conflictId: string, strategy: string) => Promise<boolean>;
  hasConflict: (orderId: string) => boolean;
  getSyncRetryInfo: (orderId: string) => SyncRetryInfo | null;
  getRetryCountdown: (orderId: string) => number | null;
  forceRetrySync: (orderId: string) => Promise<boolean>;

  // Internal methods
  _invalidateCache: () => void;
  _cleanup: () => void;
  _setupRealtimeListeners: () => void;
  _setLoading: (operation: string, loading: boolean) => void;
  _setError: (error: POSError | null) => void;
}

// Event listener cleanup registry
let eventListeners: Array<() => void> = [];

// Store initialization flag to prevent multiple subscriptions
let isStoreInitialized = false;

// Error handler instance
const errorHandler = ErrorHandler.getInstance();
const bridge = getBridge();

const getOrderPlugin = (order: Order): string | null => {
  return (
    order.plugin ||
    order.order_plugin ||
    order.platform ||
    order.order_platform ||
    null
  );
};

const getExternalPluginOrderId = (order: Order): string | null => {
  // The Rust bridge emits camelCase (externalPluginOrderId) while the admin
  // API sends snake_case — accept both so platform-order detection works for
  // orders from either path.
  const record = order as unknown as Record<string, unknown>;
  const candidates = [
    order.external_plugin_order_id,
    order.external_platform_order_id,
    record['externalPluginOrderId'],
    record['externalPlatformOrderId'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
};

// Pending platform orders and customer self-orders (QR / web / kiosk) wait for
// accept / decline. The rule lives in root shared/order-approval.ts so the
// Android POS applies exactly the same one.
const isPendingExternalOrder = (order: Order): boolean => orderNeedsApproval(order);

const isGhostOrder = (order?: Partial<Order> | null): boolean => {
  if (!order) return false;
  const value: unknown = order.is_ghost;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
};

const getOrderUniqueKey = (order: Order): string => {
  const plugin = getOrderPlugin(order);
  const externalId = getExternalPluginOrderId(order);
  if (externalId && plugin) {
    return `ext:${plugin}:${externalId}`;
  }
  const orderNumber = order.order_number || order.orderNumber;
  if (orderNumber) {
    return `ord:${orderNumber}`;
  }
  const supabaseId = order.supabase_id;
  if (supabaseId) {
    return `sup:${supabaseId}`;
  }
  return `id:${order?.id || Math.random().toString(36).slice(2)}`;
};

const dedupeOrders = (orders: Order[]): Order[] => {
  const byKey = new Map<string, Order>();

  const getOrderKeys = (order: Order): string[] => {
    const keys: string[] = [];
    if (order?.id) keys.push(`id:${order.id}`);

    const plugin = getOrderPlugin(order);
    const externalId = getExternalPluginOrderId(order);
    if (externalId && plugin) keys.push(`ext:${plugin}:${externalId}`);

    const orderNumber = order.order_number || order.orderNumber;
    if (orderNumber) keys.push(`ord:${orderNumber}`);

    const supabaseId = order.supabase_id;
    if (supabaseId) keys.push(`sup:${supabaseId}`);

    return keys;
  };

  const chooseOrder = (existing: Order, incoming: Order): Order => {
    const existingStatus = existing.sync_status || existing.syncStatus;
    const incomingStatus = incoming.sync_status || incoming.syncStatus;
    if (existingStatus === 'pending' && incomingStatus !== 'pending') return existing;
    if (incomingStatus === 'pending' && existingStatus !== 'pending') return incoming;

    const existingTs = new Date(existing.updated_at || existing.updatedAt || existing.created_at || existing.createdAt || 0).getTime();
    const incomingTs = new Date(incoming.updated_at || incoming.updatedAt || incoming.created_at || incoming.createdAt || 0).getTime();
    return incomingTs >= existingTs ? incoming : existing;
  };

  const replaceOrderReferences = (from: Order, to: Order) => {
    if (from === to) return;
    for (const [key, value] of byKey.entries()) {
      if (value === from) {
        byKey.set(key, to);
      }
    }
  };

  orders.forEach((order) => {
    const keys = getOrderKeys(order);
    if (keys.length === 0) {
      byKey.set(`rand:${Math.random().toString(36).slice(2)}`, order);
      return;
    }

    const existingKey = keys.find((key) => byKey.has(key));
    if (!existingKey) {
      keys.forEach((key) => byKey.set(key, order));
      return;
    }

    const existing = byKey.get(existingKey);
    if (!existing) {
      keys.forEach((key) => byKey.set(key, order));
      return;
    }

    const chosen = chooseOrder(existing, order);
    const other = chosen === existing ? order : existing;
    replaceOrderReferences(other, chosen);
    keys.forEach((key) => byKey.set(key, chosen));
  });

  return Array.from(new Set(byKey.values()));
};

const splitOrdersForQueue = (orders: Order[]): { visible: Order[]; pendingExternal: Order[] } => {
  const uniqueOrders = dedupeOrders(orders);
  const visible: Order[] = [];
  const pendingExternal: Order[] = [];

  uniqueOrders.forEach((order) => {
    if (isGhostOrder(order)) {
      return;
    }
    visible.push(order);
    if (isPendingExternalOrder(order)) {
      pendingExternal.push(order);
    }
  });

  pendingExternal.sort((a, b) => {
    const aTime = new Date(a.created_at || a.createdAt || 0).getTime();
    const bTime = new Date(b.created_at || b.createdAt || 0).getTime();
    return aTime - bTime;
  });

  return { visible: sortOrdersOldestFirst(visible), pendingExternal };
};

const splitOrdersForState = (orders: Order[]): { orders: Order[]; pendingExternalOrders: Order[] } => {
  const split = splitOrdersForQueue(orders);
  return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
};

const invokeBridgeIpc = async (channel: string, ...args: any[]): Promise<any> => {
  return bridge.invoke(channel, ...args);
};

const findOrderInState = (state: Pick<OrderStore, 'orders' | 'pendingExternalOrders'>, orderId: string): Order | null => {
  const combined = [...state.orders, ...state.pendingExternalOrders];
  return combined.find((order) => order.id === orderId) || null;
};

const findOrderIndex = (orders: Order[], incoming: Partial<Order>): number => {
  return orders.findIndex((order) =>
    order.id === incoming.id ||
    order.supabase_id === incoming.id ||
    order.supabase_id === incoming.supabase_id ||
    (order.order_number && incoming.order_number && order.order_number === incoming.order_number) ||
    (order.orderNumber && incoming.orderNumber && order.orderNumber === incoming.orderNumber)
  );
};

// Create the order store without subscribeWithSelector to avoid subscription conflicts
export const useOrderStore = create<OrderStore>()((set, get) => ({
    orders: [],
    pendingExternalOrders: [],
    selectedOrder: null,
    isLoading: false,
    error: null,
    loadingOperations: new Set<string>(),
    filter: {
      status: 'all',
      orderType: 'all',
      searchTerm: ''
    },

    // Convenience: reactivate cancelled order back to pending
    returnCancelledToPending: async (orderId: string) => {
      return await get().updateOrderStatus(orderId, 'pending');
    },

    // Conflict and retry state
    conflicts: [],
    syncRetries: new Map<string, SyncRetryInfo>(),

    // Cached values
    _filteredOrders: null,
    _orderCounts: null,

    // Error handling methods
    getLastError: (operation?: string) => {
      return get().error;
    },

    clearError: () => {
      set({ error: null });
    },

    isOperationLoading: (operation: string) => {
      return get().loadingOperations.has(operation);
    },

    _setLoading: (operation: string, loading: boolean) => {
      set((state) => {
        const newLoadingOps = new Set(state.loadingOperations);
        if (loading) {
          newLoadingOps.add(operation);
        } else {
          newLoadingOps.delete(operation);
        }
        return {
          loadingOperations: newLoadingOps,
          isLoading: newLoadingOps.size > 0
        };
      });
    },

    _setError: (error: POSError | null) => {
      set({ error });
    },

    _invalidateCache: () => {
      set({ _filteredOrders: null, _orderCounts: null });
    },

    _cleanup: () => {
      // Clean up all event listeners
      eventListeners.forEach(cleanup => cleanup());
      eventListeners = [];

      // Reset initialization flag
      isStoreInitialized = false;
      console.log('🧹 Order store cleaned up');
    },

    _setupRealtimeListeners: () => {
      if (typeof window === 'undefined') {
        console.log('⚠️ Renderer context unavailable, skipping real-time listeners setup');
        return;
      }

      console.log('📡 Setting up real-time order update listeners...');

      // Listen for real-time order updates from main process
      const handleOrderRealtimeUpdate = (orderData: Partial<Order>) => {
        debugLog('📡 Received real-time order update (remote wins):', orderData);

        // Always accept remote: merge/overwrite local snapshot with remote payload
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const existingOrderIndex = combined.findIndex(order =>
            order.id === orderData.id ||
            order.supabase_id === orderData.id ||
            (order.order_number && orderData.order_number && order.order_number === orderData.order_number)
          );

          if (existingOrderIndex >= 0) {
            const current = combined[existingOrderIndex];
            // Do not overwrite local pending changes
            if (current.sync_status === 'pending' || current.syncStatus === 'pending') {
              return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
            }
            // Only accept newer remote updates
            const currentTs = new Date(current.updatedAt || current.updated_at || 0).getTime();
            const incomingTs = new Date(orderData.updated_at || orderData.updatedAt || 0).getTime();
            if (incomingTs && currentTs && incomingTs <= currentTs) {
              return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
            }
            const updatedOrders = [...combined];
            const mappedStatus = orderData.status ? mapStatusForPOS(orderData.status) : current.status;
            const currentStatus = current.status as string;
            // Treat delivered and cancelled as final and sticky; do not revert them due to incoming non-final statuses
            const currentFinal = ['completed', 'cancelled', 'delivered'].includes(currentStatus);
            const incomingFinal = ['completed', 'cancelled', 'delivered'].includes(mappedStatus);
            const currentCancelled = currentStatus === 'cancelled' || currentStatus === 'canceled';
            const nextStatus = currentCancelled && mappedStatus !== 'cancelled'
              ? currentStatus
              : (currentFinal && !incomingFinal ? currentStatus : mappedStatus);
            updatedOrders[existingOrderIndex] = {
              ...updatedOrders[existingOrderIndex],
              ...orderData,
              status: nextStatus
            } as Order;
            const split = splitOrdersForQueue(updatedOrders);
            return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
          } else {
            // Do not add remote-only orders; trigger refresh instead
            return { orders: state.orders, pendingExternalOrders: state.pendingExternalOrders };
          }
        });

        get()._invalidateCache();
      };

      // Listen for order status updates
      const handleOrderStatusUpdate = ({ orderId, status }: { orderId: string; status: string }) => {
        console.log('📡 Received order status update:', { orderId, status });

        const incomingMapped = mapStatusForPOS(status) as Order['status'];
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updated = combined.map(order =>
            order.id === orderId
              ? (() => {
                  const currentStatus = String(order.status || '').toLowerCase();
                  const isStickyFinal = currentStatus === 'delivered' || currentStatus === 'cancelled' || currentStatus === 'canceled';
                  return {
                    ...order,
                    // Preserve delivered/cancelled status from reverting due to any non-final push
                    status: isStickyFinal ? order.status : incomingMapped,
                    updatedAt: new Date().toISOString()
                  };
                })()
              : order
          );
          const split = splitOrdersForQueue(updated);
          return { orders: split.visible, pendingExternalOrders: split.pendingExternal };
        });

        get()._invalidateCache();
      };

      // Listen for new orders from OTHER terminals (order_save_from_remote only).
      // Self-created orders are added to state directly in createOrder().
      const handleOrderCreated = (orderData: any) => {
        if (!orderData || !orderData.id) {
          // Rust sends only `{ orderId }` when it could not read the row it
          // just pulled back from the local cache. Dropping that event hid the
          // order (and its incoming-order alert) until something else
          // refreshed the list: re-read the local cache instead.
          if (typeof orderData?.orderId === 'string' && orderData.orderId.trim()) {
            console.warn('⚠️ [useOrderStore] order-created without its row, refreshing:', orderData.orderId);
            void get().silentRefresh().catch(() => {});
            return;
          }
          console.warn('⚠️ [useOrderStore] Invalid order data received:', orderData);
          return;
        }

        // Skip self-created orders (safety net)
        if (_recentlyCreatedOrderIds.has(orderData.id)) return;

        console.log('📡 [useOrderStore] Received remote order:', orderData.id);

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const existingOrderIndex = findOrderIndex(combined, orderData);

          if (existingOrderIndex >= 0) {
            const updatedOrders = [...combined];
            updatedOrders[existingOrderIndex] = { ...updatedOrders[existingOrderIndex], ...orderData };
            return splitOrdersForState(updatedOrders as Order[]);
          }

          return splitOrdersForState([...combined, orderData] as Order[]);
        });

        get()._invalidateCache();

        // Show toast for remote orders only
        toast.success(`New order #${orderData.order_number || orderData.id.slice(0, 8)} received!`, {
          duration: 5000,
          icon: createElement(Bell, { className: 'w-4 h-4 text-blue-500' })
        });
      };

      // Wave 8 H25: the generic `order-updated` subscription was REMOVED.
      // Rust never emits `order_updated`, and the event-bridge `EVENT_MAP`
      // has no mapping for it — so `onEvent('order-updated', …)` used to
      // attach a handler that could never fire. Any real order mutation
      // comes through one of the already-subscribed channels:
      //   • order-realtime-update   (supabase realtime → merged payload)
      //   • order-status-updated    (status transitions)
      //   • order-payment-updated   (payment status / method changes)
      //   • order-created / order-deleted (lifecycle)
      // If a future feature needs a "something about this order changed"
      // signal, add the Tauri emitter AND add `order_updated` to
      // `event-bridge.ts::EVENT_MAP` — do not re-add an orphan handler.

      // Listen for order deletions (handles both direct orderId and realtime payload formats)
      const handleOrderDelete = (data: { orderId?: string; old?: { id: string } }) => {
        // Support both formats: { orderId } or { old: { id } } from realtime
        const orderId = data.orderId || data.old?.id;

        if (!orderId) {
          console.warn('📡 Received order deletion with no orderId:', data);
          return;
        }

        console.log('📡 Received order deletion:', { orderId });

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.filter(order => order.id !== orderId);
          return splitOrdersForState(updatedOrders as Order[]);
        });

        get()._invalidateCache();
      };

      // Listen for payment status updates
      const handlePaymentUpdate = ({ orderId, paymentStatus, paymentMethod, transactionId }: any) => {
        console.log('📡 Received payment update:', { orderId, paymentStatus });

        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? {
                  ...order,
                  paymentStatus,
                  paymentMethod: paymentMethod || order.paymentMethod,
                  paymentTransactionId: transactionId || order.paymentTransactionId,
                  updatedAt: new Date().toISOString()
                }
              : order
          );
          return splitOrdersForState(updatedOrders as Order[]);
        });

        get()._invalidateCache();
      };

      // Listen for sync conflicts
      const handleSyncConflict = async (conflictData: any) => {
        console.log('⚠️ Received sync conflict — auto accepting remote:', conflictData);

        // Try resolving via main
        try {
          const conflictId = conflictData?.id ?? conflictData?.orderId;
          if (conflictId) {
            await bridge.orders.resolveConflict(conflictId, 'remote_wins');
          }
        } catch (e) {
          console.warn('Auto-resolve via main failed, will refresh orders:', e);
        }

        // Always refresh from server to ensure remote wins locally
        try {
          await get().loadOrders();
        } catch {}

        // Clear any existing conflicts from UI state
        set({ conflicts: [] });
      };

      // Listen for conflict resolutions
      const handleConflictResolved = ({ conflictId, orderId, strategy }: any) => {
        console.log('✅ Conflict resolved:', { conflictId, orderId, strategy });

        // Remove resolved conflict from state
        set((state) => ({
          ...state,
          conflicts: state.conflicts.filter(c => c.id !== conflictId && c.orderId !== orderId)
        }));

        get()._invalidateCache();
        toast.success(`Conflict resolved using ${strategy} strategy`);
      };

      // Listen for retry scheduling
      const handleRetryScheduled = ({ orderId, nextRetryAt, retryDelayMs, attempts }: any) => {
        console.log('🔄 Retry scheduled:', { orderId, nextRetryAt, retryDelayMs, attempts });

        set((state) => {
          const newRetries = new Map(state.syncRetries);
          newRetries.set(orderId, {
            orderId,
            nextRetryAt,
            retryDelayMs,
            attempts: attempts || (state.syncRetries.get(orderId)?.attempts || 0) + 1,
            maxAttempts: 5
          });
          return { syncRetries: newRetries };
        });
      };

      // Listen for orders cleared event
      const handleOrdersCleared = () => {
        console.log('🗑️  Orders cleared, refreshing...');
        set({ orders: [], pendingExternalOrders: [], conflicts: [] });
        get()._invalidateCache();
      };

      onEvent('order-realtime-update', handleOrderRealtimeUpdate);
      onEvent('order-status-updated', handleOrderStatusUpdate);
      onEvent('order-payment-updated', handlePaymentUpdate);
      onEvent('order-created', handleOrderCreated);
      onEvent('order-deleted', handleOrderDelete);
      onEvent('order-sync-conflict', handleSyncConflict);
      onEvent('order-conflict-resolved', handleConflictResolved);
      onEvent('sync-retry-scheduled', handleRetryScheduled);
      onEvent('orders-cleared', handleOrdersCleared);

      // Store cleanup functions
      eventListeners.push(
        () => offEvent('order-realtime-update', handleOrderRealtimeUpdate),
        () => offEvent('order-status-updated', handleOrderStatusUpdate),
        () => offEvent('order-payment-updated', handlePaymentUpdate),
        () => offEvent('order-created', handleOrderCreated),
        () => offEvent('order-deleted', handleOrderDelete),
        () => offEvent('order-sync-conflict', handleSyncConflict),
        () => offEvent('order-conflict-resolved', handleConflictResolved),
        () => offEvent('sync-retry-scheduled', handleRetryScheduled),
        () => offEvent('orders-cleared', handleOrdersCleared)
      );

      console.log('✅ Real-time order update listeners set up successfully');
    },

    initializeOrders: async () => {
      // Prevent multiple initializations
      if (isStoreInitialized) {
        console.log('📊 Order store already initialized, skipping...');
        return;
      }

      console.log('📊 Initializing order store...');
      isStoreInitialized = true;

      try {
        await get().loadOrders();

        // Set up real-time IPC listeners for order updates from main process
        get()._setupRealtimeListeners();

        console.log('✅ Order store initialized successfully with real-time updates');
      } catch (error) {
        console.error('❌ Failed to initialize order store:', error);
        isStoreInitialized = false; // Reset flag on error
        throw error;
      }
    },

    loadOrders: async () => {
      const operation = 'loadOrders';
      get()._setLoading(operation, true);
      get().clearError();

      try {
        const orderService = OrderService.getInstance();

        // Wrap with timeout and retry
        const orders = await withRetry(async () => {
          return await withTimeout(
            orderService.fetchOrders(),
            TIMING.DATABASE_QUERY_TIMEOUT,
            'Load orders'
          );
        }, RETRY.MAX_RETRY_ATTEMPTS, RETRY.RETRY_DELAY_MS);

        set(splitOrdersForState(orders));
        get()._invalidateCache();
        get()._setLoading(operation, false);
      } catch (error) {
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        // Show user-friendly error message
        const userMessage = errorHandler.getUserMessage(posError);
        console.error('Failed to load orders:', userMessage);
        toast.error(userMessage || ERROR_MESSAGES.GENERIC_ERROR);
      }
    },

    // Optimized filtered orders with caching
    getFilteredOrders: () => {
      const state = get();

      // Return cached result if available
      if (state._filteredOrders !== null) {
        return state._filteredOrders;
      }

      let filtered = state.orders;

      // Apply status filter
      if (state.filter.status !== 'all') {
        filtered = filtered.filter(order => {
          if (state.filter.status === 'cancelled' || state.filter.status === 'canceled') {
            return isCancelledOrderStatus(order.status);
          }

          return order.status === state.filter.status;
        });
      }

      // Apply order type filter
      if (state.filter.orderType !== 'all') {
        filtered = filtered.filter(order => order.orderType === state.filter.orderType);
      }

      // Apply search filter
      if (state.filter.searchTerm) {
        const searchTerm = state.filter.searchTerm.toLowerCase();
        filtered = filtered.filter(order =>
          order.orderNumber.toLowerCase().includes(searchTerm) ||
          order.customerName?.toLowerCase().includes(searchTerm) ||
          order.customerPhone?.includes(searchTerm)
        );
      }

      // Cache the result
      set({ _filteredOrders: filtered });
      return filtered;
    },

    // Optimized order counts with caching
    getOrderCounts: () => {
      const state = get();

      // Use cached result if available
      if (state._orderCounts !== null) {
        return state._orderCounts;
      }

      const counts = state.orders.reduce((acc, order) => {
        acc[order.status] = (acc[order.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const result = {
        pending: counts.pending || 0,
        preparing: counts.preparing || 0,
        ready: counts.ready || 0,
        completed: counts.completed || 0,
        cancelled: (counts.cancelled || 0) + (counts.canceled || 0),
      };

      // Cache the result
      set({ _orderCounts: result });
      return result;
    },

    setFilter: (newFilter) => {
      set((state) => ({
        filter: { ...state.filter, ...newFilter }
      }));
      get()._invalidateCache();
    },

    getOrderById: async (orderId: string) => {
      try {
        // Use local state since native API is simplified
        const state = get();
        return (
          state.orders.find(order => order.id === orderId) ||
          state.pendingExternalOrders.find(order => order.id === orderId) ||
          null
        );
      } catch (error) {
        console.error('Failed to get order by ID:', error);
        return null;
      }
    },

    updateOrderStatusDetailed: async (orderId: string, status: Order['status'], options?: UpdateOrderStatusOptions) => {
      const operation = `updateOrderStatus_${orderId}`;
      get()._setLoading(operation, true);
      get().clearError();

      try {
        // Validate inputs
        if (!orderId) {
          throw ErrorFactory.validation('Order ID is required');
        }

        const orderService = OrderService.getInstance();

        // Wrap with timeout
        const trimmedCancellationReason =
          status === 'cancelled' && typeof options?.cancellationReason === 'string'
            ? options.cancellationReason.trim()
            : '';
        const cancelledAt = status === 'cancelled' ? options?.cancelledAt : undefined;
        await withTimeout(
          orderService.updateOrderStatus(orderId, status, {
            ...(trimmedCancellationReason ? { cancellationReason: trimmedCancellationReason } : {}),
            ...(cancelledAt ? { cancelledAt } : {}),
          }),
          TIMING.DATABASE_QUERY_TIMEOUT,
          'Update order status'
        );

        // Update local state after successful API call
        const mappedLocalStatus = mapStatusForPOS(status) as Order['status'];
        const cancellationReasonPatch =
          mappedLocalStatus === 'cancelled' && trimmedCancellationReason.length > 0
            ? {
                cancellation_reason: trimmedCancellationReason,
                cancellationReason: trimmedCancellationReason,
                ...(cancelledAt ? { cancelled_at: cancelledAt, cancelledAt } : {}),
              }
            : {};
        const cancellationClearPatch =
          mappedLocalStatus === 'pending'
            ? {
                cancellation_reason: undefined,
                cancellationReason: undefined,
                cancelled_at: undefined,
                cancelledAt: undefined,
              }
            : {};
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? {
                  ...order,
                  status: mappedLocalStatus,
                  ...cancellationClearPatch,
                  ...cancellationReasonPatch,
                  updatedAt: new Date().toISOString(),
                  sync_status: 'pending' as const,
                  syncStatus: 'pending' as const
                }
              : order
          );
          return splitOrdersForState(updatedOrders);
        });


        get()._invalidateCache();
        get()._setLoading(operation, false);
        return { success: true };
      } catch (error) {
        const paymentIntegrityPayload =
          ((error as any)?.paymentIntegrityPayload as PaymentIntegrityErrorPayload | undefined) ||
          extractPaymentIntegrityPayload((error as any)?.details) ||
          extractPaymentIntegrityPayload((error as any)?.cause) ||
          extractPaymentIntegrityPayload((error as any)?.message) ||
          extractPaymentIntegrityPayload(error);
        if (paymentIntegrityPayload) {
          get()._setLoading(operation, false);
          return {
            success: false,
            errorMessage:
              paymentIntegrityPayload.error ||
              paymentIntegrityPayload.message ||
              summarizeUnsettledPaymentBlockers(paymentIntegrityPayload.blockers || []) ||
              'Order status update blocked by unsettled payment',
            paymentIntegrityPayload,
          };
        }

        // A paid label with no payment record here (founder rule
        // 01/10/2026): a typed refusal the screen explains.
        if (rawErrorText(error).includes(ORDER_PAYMENT_NOT_RECORDED)) {
          get()._setLoading(operation, false);
          return {
            success: false,
            errorCode: ORDER_PAYMENT_NOT_RECORDED,
            errorMessage: rawErrorText(error),
          };
        }

        // Money was taken on the order: a typed refusal the screen explains,
        // never a generic failure (fix review 30/09/2026).
        if (rawErrorText(error).includes(ORDER_HAS_PAYMENTS)) {
          get()._setLoading(operation, false);
          return {
            success: false,
            errorCode: ORDER_HAS_PAYMENTS,
            errorMessage: rawErrorText(error),
          };
        }

        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);
        return {
          success: false,
          errorMessage:
            errorHandler.getUserMessage(posError) || ERROR_MESSAGES.GENERIC_ERROR,
        };
      }
    },

    updateOrderStatus: async (orderId: string, status: Order['status'], options?: UpdateOrderStatusOptions) => {
      // Deliberately no toast here. The store used to announce the outcome in
      // hardcoded English while the calling screen announced the same action
      // through i18n — staff saw every action twice, in two languages. The
      // screen that owns the action owns the notification; the store only
      // reports the result.
      const result = await get().updateOrderStatusDetailed(orderId, status, options);
      if (!result.success && !result.paymentIntegrityPayload) {
        console.error('Failed to update order status:', result.errorMessage);
      }
      return result.success;
    },

    createOrder: async (orderData: Partial<Order>) => {
      const operation = 'createOrder';
      get()._setLoading(operation, true);
      get().clearError();

      try {
        // Validate order data
        if (!orderData.items || orderData.items.length === 0) {
          throw ErrorFactory.validation('Order must contain at least one item');
        }

        const orderService = OrderService.getInstance();

        // Create is side-effectful; keep timeout protection but do not retry.
        // A checkout carrying its payment waits past the card terminal's own
        // timeout (fix review 30/09/2026).
        const carriesPayment = Boolean(
          (orderData as any).initialPayment ?? (orderData as any).initial_payment,
        );
        const newOrder = await withTimeout(
          orderService.createOrder(orderData),
          carriesPayment ? CHECKOUT_WITH_PAYMENT_TIMEOUT_MS : TIMING.ORDER_CREATE_TIMEOUT,
          carriesPayment ? CHECKOUT_OUTCOME_UNKNOWN : 'Create order'
        );

        // Track the ID so handleOrderCreated ignores any echo from remote sync
        if (newOrder.id) {
          _recentlyCreatedOrderIds.add(newOrder.id);
          setTimeout(() => _recentlyCreatedOrderIds.delete(newOrder.id), 30000);
        }

        // Add to state directly (no IPC event for self-created orders)
        if (newOrder.id) {
          set((state) => {
            const combined = [...state.orders, ...state.pendingExternalOrders];
            // The label on screen comes from storage, never from the caller
            // (founder rule 30/09 and 01/10/2026: an order is never paid
            // without its payment record). When the stored order could not be
            // read back after the create, the screen says `pending` until the
            // next refresh, not the checkout's `completed` claim.
            const storedPaymentStatus =
              (newOrder as Partial<Order>).paymentStatus ??
              (newOrder as Partial<Order>).payment_status ??
              'pending';
            const orderForState = {
              ...orderData,
              ...newOrder,
              id: newOrder.id,
              paymentStatus: storedPaymentStatus,
              payment_status: storedPaymentStatus,
            } as Order;
            return splitOrdersForState([orderForState, ...combined]);
          });
        }

        get()._invalidateCache();
        get()._setLoading(operation, false);

        if ((newOrder as any).savedForRetry) {
          toast('Order saved offline and queued for sync when connectivity returns');
        }

        if (newOrder.id && !isGhostOrder(orderData) && !(newOrder as any).savedForRetry) {
          pollFiscalReceiptStatus(newOrder.id, { timeoutMs: 30000, intervalMs: 2500 })
            .then((fiscalStatus) => {
              if (!fiscalStatus) {
                return;
              }

              if (fiscalStatus.status === 'NEEDS_FIX' || fiscalStatus.status === 'REJECTED') {
                console.warn('[useOrderStore] Fiscal submission requires attention', {
                  orderId: newOrder.id,
                  status: fiscalStatus.status,
                  error: fiscalStatus.error,
                  errorCode: fiscalStatus.error_code,
                });
              }
            })
            .catch((error) => {
              console.debug('[useOrderStore] Fiscal status polling skipped', {
                orderId: newOrder.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }

        return {
          success: true,
          orderId: newOrder.id,
          orderNumber: getVisibleOrderNumber(newOrder) || newOrder.id,
          clientRequestId: (newOrder as any).clientRequestId,
          client_request_id: (newOrder as any).client_request_id,
          clientOrderId: (newOrder as any).clientOrderId,
          client_order_id: (newOrder as any).client_order_id,
          savedForRetry: Boolean((newOrder as any).savedForRetry),
          roomCharge: (newOrder as any).roomCharge,
        };
      } catch (error) {
        // A card charged at checkout whose order the till could not save yet
        // (item E): the caller tells the cashier in the store's language and
        // ends the checkout. Its details must survive, never be flattened
        // into a generic failure the screen would let the cashier retry.
        const notSaved = error as {
          paymentNotSaved?: boolean;
          amountCents?: number;
          unsavedPayment?: unknown;
          message?: string;
        } | null;
        if (notSaved?.paymentNotSaved === true) {
          get()._setLoading(operation, false);
          return {
            success: false,
            error: notSaved.message,
            savedForRetry: false,
            paymentNotSaved: true,
            errorCode: 'PAYMENT_NOT_SAVED',
            amountCents: notSaved.amountCents,
            unsavedPayment: notSaved.unsavedPayment,
          };
        }
        // The payment has no answer yet (fix review 30/09/2026): the terminal
        // is still waiting, or this same checkout is still in progress. Never
        // a failure the screen retries as a new checkout.
        const unknown = error as { message?: string; checkoutInProgress?: boolean } | null;
        if (unknown?.checkoutInProgress === true || unknown?.message === CHECKOUT_OUTCOME_UNKNOWN) {
          get()._setLoading(operation, false);
          return {
            success: false,
            error: unknown.message,
            savedForRetry: false,
            outcomeUnknown: true,
            errorCode:
              unknown.checkoutInProgress === true ? CHECKOUT_IN_PROGRESS : CHECKOUT_OUTCOME_UNKNOWN,
          };
        }
        // Handle error
        const posError = errorHandler.handle(error);
        get()._setError(posError);
        get()._setLoading(operation, false);

        const userMessage = errorHandler.getUserMessage(posError);
        return { success: false, error: userMessage, savedForRetry: false };
      }
    },

    setSelectedOrder: (order) => set({ selectedOrder: order }),

    refreshOrders: async () => {
      await get().loadOrders();
    },

    // Silent refresh - updates orders in background without loading states or toast errors
    // Ideal for fast polling (1-2 sec) without UI flicker
        silentRefresh: async () => {
      try {
        const orderService = OrderService.getInstance();
        const fetchedOrders = await orderService.fetchOrders();

        // Only update if we got valid data
        if (fetchedOrders && Array.isArray(fetchedOrders)) {
          set((state) => {
            const combinedCurrent = [...state.orders, ...state.pendingExternalOrders];
            const effectiveFetchedOrders = fetchedOrders.map((fetchedOrder) => {
              const fetchedOrderNumber = fetchedOrder.orderNumber || fetchedOrder.order_number;
              const fetchedSupabaseId = fetchedOrder.supabase_id;
              const localMatch = combinedCurrent.find((order) => {
                const orderNumber = order.orderNumber || order.order_number;
                const supabaseId = order.supabase_id;
                return order.id === fetchedOrder.id
                  || (fetchedOrderNumber && orderNumber === fetchedOrderNumber)
                  || (fetchedSupabaseId && supabaseId === fetchedSupabaseId);
              });

              if (!localMatch) return fetchedOrder;

              const localStatus = String(localMatch.status || '').toLowerCase();
              const fetchedStatus = String(fetchedOrder.status || '').toLowerCase();
              const keepLocalCancelled = (localStatus === 'cancelled' || localStatus === 'canceled')
                && fetchedStatus !== 'cancelled'
                && fetchedStatus !== 'canceled';

              return keepLocalCancelled
                ? { ...fetchedOrder, status: localMatch.status, updatedAt: localMatch.updatedAt || localMatch.updated_at }
                : fetchedOrder;
            });

            // Create lookup maps using multiple identifiers for proper deduplication
            // Orders can have different IDs locally vs in Supabase, but order_number is consistent
            const fetchedOrdersById = new Map(effectiveFetchedOrders.map(o => [o.id, o]));
            const fetchedOrdersByOrderNumber = new Map(
              effectiveFetchedOrders.filter(o => o.orderNumber || o.order_number)
                .map(o => [o.orderNumber || o.order_number, o])
            );
            const fetchedOrdersBySupabaseId = new Map(
              effectiveFetchedOrders.filter(o => o.supabase_id)
                .map(o => [o.supabase_id, o])
            );

            // Helper to check if an order exists in fetched results using any identifier
            const existsInFetched = (order: Order) => {
              const orderNum = order.orderNumber || order.order_number;
              const supabaseId = order.supabase_id;
              return fetchedOrdersById.has(order.id) ||
                     (orderNum && fetchedOrdersByOrderNumber.has(orderNum)) ||
                     (supabaseId && fetchedOrdersBySupabaseId.has(supabaseId));
            };

            // Preserve any orders in current state that aren't in the fetched list
            // This prevents race conditions where a newly created order hasn't been
            // committed to the database yet when silentRefresh runs
            const preservedOrders = combinedCurrent.filter(order => {
              // Keep orders that are not in the fetched list AND were created recently (within last 30 seconds)
              // This handles the race condition where order is created but not yet in DB query results
              if (!existsInFetched(order)) {
                const createdAt = new Date(order.createdAt || order.created_at || 0).getTime();
                const now = Date.now();
                const isRecent = (now - createdAt) < 30000; // 30 seconds
                if (isRecent) {
                  console.log(`[silentRefresh] Preserving recent order not in DB: ${order.id}, orderNumber: ${order.orderNumber || order.order_number}`);
                  return true;
                }
              }
              return false;
            });

            // Merge: fetched orders + preserved recent orders
            const mergedOrders = [...effectiveFetchedOrders, ...preservedOrders];

            // Remove duplicates using order_number as primary key (consistent across local and remote)
            // Fall back to id if order_number is not available
            const uniqueOrders = Array.from(
              new Map(mergedOrders.map(o => {
                const key = o.orderNumber || o.order_number || o.id;
                return [key, o];
              })).values()
            );

            return splitOrdersForState(uniqueOrders);
          });
          get()._invalidateCache();
        }
      } catch (error) {
        // Silently ignore errors during background refresh
        // Don't show toasts or set error states
        console.debug('Silent refresh failed (will retry):', error);
      }
    },

    updatePaymentStatus: async (orderId: string, paymentStatus: NonNullable<Order['paymentStatus']>, paymentMethod?: Order['paymentMethod'], transactionId?: string) => {
      try {
        // Update local state optimistically
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? {
                  ...order,
                  paymentStatus,
                  paymentMethod: paymentMethod || order.paymentMethod,
                  paymentTransactionId: transactionId || order.paymentTransactionId,
                  updatedAt: new Date().toISOString()
                }
              : order
          );
          return splitOrdersForState(updatedOrders as Order[]);
        });


        get()._invalidateCache();

        const response = await invokeBridgeIpc('payment:update-payment-status', {
          orderId,
          paymentStatus,
          paymentMethod,
          transactionId,
        });

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to persist payment status');
        }

        return true;
      } catch (error) {
        console.error('Failed to update payment status:', error);
        try {
          await get().silentRefresh();
        } catch (refreshError) {
          console.debug('Silent refresh after payment update failure also failed:', refreshError);
        }
        return false;
      }
    },

     processPayment: async (orderId: string, paymentData: { method: Order['paymentMethod']; amount: number; [key: string]: any }) => {
       // Gift card payments are booked only by native gift checkout. Refuse
       // before the normalization below would record one as `other`.
       if (isGiftCardPaymentMethod(paymentData?.method)) {
         return { success: false, error: 'GIFT_CARD_GENERIC_PAYMENT_REFUSED' };
       }
       try {
         const normalizedMethod = paymentData.method === 'cash' || paymentData.method === 'card'
           ? paymentData.method
           : 'other';
         const transactionId = paymentData.transactionId || paymentData.transactionRef || `txn_${Date.now()}`;
         const response = await invokeBridgeIpc('payment:record', {
           orderId,
           method: normalizedMethod,
           amount: paymentData.amount,
           currency: paymentData.currency || 'EUR',
           cashReceived: paymentData.cashReceived,
           changeGiven: paymentData.changeGiven,
           transactionRef: transactionId,
           discountAmount: paymentData.discountAmount,
           terminalApproved: paymentData.terminalApproved,
           terminalDeviceId: paymentData.terminalDeviceId,
           items: paymentData.items,
         });

         if (!response?.success) {
           throw new Error(response?.error || 'Payment processing failed');
         }

         await get().silentRefresh();
         return { success: true, transactionId };
       } catch (error) {
         console.error('Failed to process payment:', error);
         return { success: false, error: error instanceof Error ? error.message : 'Payment processing failed' };
       }
     },

    updatePreparationStatus: async (orderId: string, status: 'preparing' | 'ready' | 'completed') => {
      return await get().updateOrderStatus(orderId, status);
    },

    printKitchenTicket: async (orderId: string) => {
      try {
        const order = findOrderInState(get(), orderId);
        if (!order) {
          throw new Error('Order not found');
        }

        const result = await invokeBridgeIpc('kitchen:print-ticket', {
          id: order.id,
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          customerName: order.customerName || order.customer_name || 'Walk-in',
          orderType: order.orderType || order.order_type || 'pickup',
          tableNumber: order.tableNumber || order.table_number || null,
          notes: order.notes || order.special_instructions || null,
          createdAt: order.createdAt || order.created_at || new Date().toISOString(),
          estimatedTime: order.estimatedTime || order.estimated_time || null,
          items: order.items || [],
        });

        if (!result?.success) {
          throw new Error(result?.error || 'Kitchen print failed');
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to print kitchen ticket:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Printing failed' };
      }
    },

    getKitchenOrders: () => {
      const state = get();
      return state.orders.filter(order =>
        ['pending', 'preparing', 'ready'].includes(order.status)
      );
    },

    updateEstimatedTime: async (orderId: string, estimatedTime: number) => {
      try {
        // Update local state optimistically
        set((state) => {
          const combined = [...state.orders, ...state.pendingExternalOrders];
          const updatedOrders = combined.map(order =>
            order.id === orderId
              ? { ...order, estimatedTime, updatedAt: new Date().toISOString() }
              : order
          );
          return splitOrdersForState(updatedOrders);
        });


        get()._invalidateCache();

        const order = findOrderInState(get(), orderId);
        if (!order) {
          throw new Error('Order not found');
        }

        const currentStatus = mapStatusForPOS(order.status);
        const response = await invokeBridgeIpc('order:update-status', {
          orderId,
          status: currentStatus,
          estimatedTime,
        });

        if (!response?.success) {
          throw new Error(response?.error || 'Failed to persist estimated time');
        }

        return true;
      } catch (error) {
        console.error('Failed to update estimated time:', error);
        try {
          await get().silentRefresh();
        } catch (refreshError) {
          console.debug('Silent refresh after estimated time update failure also failed:', refreshError);
        }
        return false;
      }
    },

    // Order approval methods
    approveOrder: async (orderId: string, estimatedTime?: number) => {
      const operation = `approveOrder_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.approve(orderId, estimatedTime);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? { ...order, status: 'confirmed', estimatedTime: estimatedTime || 20, updatedAt: new Date().toISOString() }
            : order
        );
        return splitOrdersForState(updatedOrders as Order[]);
      });


          get()._invalidateCache();
          return true;
        }
        throw new Error(result?.error || 'Failed to approve order');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to approve order', { error });
        get()._setError(posError);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    declineOrder: async (orderId: string, reason: string) => {
      const operation = `declineOrder_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.decline(orderId, reason);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? {
                ...order,
                status: 'cancelled',
                cancellationReason: reason,
                updatedAt: new Date().toISOString(),
                sync_status: 'pending',
                syncStatus: 'pending'
              }
            : order
        );
        return splitOrdersForState(updatedOrders as Order[]);
      });


          get()._invalidateCache();
          return true;
        }
        throw new Error(result?.error || 'Failed to decline order');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to decline order', { error });
        get()._setError(posError);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    assignDriver: async (orderId: string, driverId: string, notes?: string) => {
      const operation = `assignDriver_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.assignDriver(orderId, driverId, notes) as unknown as IpcResult;
        const driverName = String(result?.driverName || result?.data?.driverName || '').trim();
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? (() => {
                const currentStatus = String(order.status || '').toLowerCase();
                const isCancelled = currentStatus === 'cancelled' || currentStatus === 'canceled';
                const isFinal = currentStatus === 'completed' || currentStatus === 'delivered';
                const serverStatus = String(result?.data?.status || result?.status || '').trim().toLowerCase();
                const nextStatus = isCancelled
                  ? order.status
                  : (serverStatus
                    ? (mapStatusForPOS(serverStatus) as Order['status'])
                    : (isFinal ? order.status : 'delivered' as const));
                return {
                  ...order,
                  status: nextStatus,
                  orderType: 'delivery' as const,
                  order_type: 'delivery' as const,
                  driverId,
                  driver_id: driverId,
                  driverName: driverName || order.driverName || '',
                  driver_name: driverName || (order as any).driver_name || '',
                  updatedAt: new Date().toISOString(),
                  sync_status: 'pending' as const,
                  syncStatus: 'pending' as const
                };
              })()
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          return true;
        }
        throw new Error(result?.error || 'Failed to assign driver');
      } catch (error) {
        const posError = ErrorFactory.businessLogic('Failed to assign driver', { error });
        get()._setError(posError);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    convertToPickup: async (orderId: string) => {
      const operation = `convertToPickup_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const resp = await bridge.orders.updateType(orderId, 'pickup') as unknown as IpcResultWithDetailedError;
        if (resp?.success) {
      const updatedOrderId = resp?.orderId || resp?.data?.orderId || orderId;
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === updatedOrderId
            ? (() => {
                const currentStatus = String(order.status || '').toLowerCase();
                const isFinal = currentStatus === 'completed' || currentStatus === 'delivered';
                const serverStatus = String(resp?.data?.status || resp?.status || '').trim().toLowerCase();
                return {
                  ...order,
                  orderType: 'pickup' as const,
                  order_type: 'pickup' as const,
                  status: serverStatus
                    ? (mapStatusForPOS(serverStatus) as Order['status'])
                    : (!isFinal && currentStatus === 'out_for_delivery' ? 'ready' as const : order.status),
                  driverId: undefined,
                  driver_id: undefined,
                  driverName: '',
                  driver_name: '',
                  updatedAt: new Date().toISOString(),
                  sync_status: 'pending' as const,
                  syncStatus: 'pending' as const
                };
              })()
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          toast.success('Converted to Pickup');
          return true;
        }
        const rawError = resp?.error;
        let errMsg: string;
        if (typeof rawError === 'string') {
          errMsg = rawError;
        } else if (rawError && typeof rawError === 'object') {
          errMsg = rawError.userMessage || rawError.message || JSON.stringify(rawError);
        } else {
          errMsg = 'Failed to convert';
        }
        throw new Error(errMsg);
      } catch (error: any) {
        const message = error?.message || 'Failed to convert to Pickup';
        const posError = ErrorFactory.businessLogic('Failed to convert to pickup', { error });
        get()._setError(posError);
        toast.error(message);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },



    updatePreparationProgress: async (orderId: string, stage: string, progress: number) => {
      const operation = `updateProgress_${orderId}`;
      get()._setLoading(operation, true);
      try {
        const result = await bridge.orders.updatePreparation(orderId, stage, progress);
        if (result?.success) {
      set((state) => {
        const combined = [...state.orders, ...state.pendingExternalOrders];
        const updatedOrders = combined.map(order =>
          order.id === orderId
            ? { ...order, preparationProgress: progress, updatedAt: new Date().toISOString() }
            : order
        );
        return splitOrdersForState(updatedOrders);
      });


          get()._invalidateCache();
          return true;
        }
        throw new Error(result?.error || 'Failed to update preparation progress');
      } catch (error) {
        console.error('Failed to update preparation progress:', error);
        return false;
      } finally {
        get()._setLoading(operation, false);
      }
    },

    // Conflict resolution methods
    getConflicts: () => {
      return get().conflicts;
    },

    resolveConflict: async (conflictId: string, strategy: string) => {
      try {
        const result = await bridge.orders.resolveConflict(conflictId, strategy) as unknown as IpcResult;
        if (result?.success !== false) {
          // Remove resolved conflict from state
          set((state) => ({
            ...state,
            conflicts: state.conflicts.filter(c => c.id !== conflictId)
          }));
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to resolve conflict:', error);
        return false;
      }
    },

    hasConflict: (orderId: string) => {
      return get().conflicts.some(c => c.orderId === orderId);
    },

    getSyncRetryInfo: (orderId: string) => {
      return get().syncRetries.get(orderId) || null;
    },

    getRetryCountdown: (orderId: string) => {
      const retryInfo = get().syncRetries.get(orderId);
      if (!retryInfo) return null;

      const nextRetry = new Date(retryInfo.nextRetryAt).getTime();
      const now = Date.now();
      const secondsUntilRetry = Math.max(0, Math.floor((nextRetry - now) / 1000));

      return secondsUntilRetry;
    },

    forceRetrySync: async (orderId: string) => {
      try {
        const result = await bridge.orders.forceSyncRetry(orderId) as unknown as IpcResult;
        if (result?.success !== false) {
          // Remove from retry map
          set((state) => {
            const newRetries = new Map(state.syncRetries);
            newRetries.delete(orderId);
            return { syncRetries: newRetries };
          });
          return true;
        }
        return false;
      } catch (error) {
        console.error('Failed to force retry sync:', error);
        return false;
      }
    }
  }));

// Export cleanup function for component unmounting
export const cleanupOrderStore = () => {
  const store = useOrderStore.getState();
  store._cleanup();
};
