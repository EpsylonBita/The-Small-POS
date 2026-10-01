/**
 * GiftCardCheckoutService - pays an existing, synced, unpaid order with a gift
 * card through the native `gift_card_*` checkout commands.
 *
 * Authority rules:
 * - Native owns the idempotency key, the durable attempt journal, the
 *   canonical payment import and the fiscal journal. This service never
 *   generates a key, never records a gift payment through the generic payment,
 *   EFT or management redeem paths and keeps no persisted attempt store.
 * - The per-order admission below only mirrors the last native answer in
 *   memory. It starts `unknown` after every restart, so native recovery
 *   (`gift_card_reconcile_order`) runs before any fresh debit, and an
 *   uncertain answer blocks both gift and ordinary collection until native
 *   recovery reports no unresolved attempt. In-memory generation counters
 *   keep an older answer from overwriting newer admission or receipt state,
 *   and every returned admission is read after the call's last await.
 * - One in-memory collection hold per organization, terminal and order is
 *   shared by gift debits and ordinary cash/card collection. It is claimed
 *   synchronously before the first await and kept through the send and its
 *   canonical outcome; while it exists no other gift or ordinary send may
 *   start. Only its owner settles it, except that native recovery may settle
 *   an uncertain gift hold; nothing settles an uncertain ordinary hold for
 *   its owner. Unmount, module or auth changes and elapsed time never release
 *   a hold. Holds are not persisted: after a restart none exists, so they add
 *   no durable authority.
 * - Card numbers are bearer credentials. They only travel inside the redeem
 *   payload and are never logged, returned, cached or persisted.
 * - Financial settlement and fiscal progress are separate: a pending,
 *   unsupported, unavailable or failed receipt never changes paid financial
 *   truth, and a pending receipt never becomes another gift debit.
 */

import { getBridge } from '../../lib';
import type {
  GiftCardCheckoutSplit,
  GiftCardFiscalReadinessRequest,
  GiftCardFiscalStatus,
  GiftCardOrderRequest,
  GiftCardRedeemForOrderRequest,
} from '../../lib/ipc-contracts';
import {
  GIFT_CARD_MAX_AMOUNT_CENTS,
  normalizeCurrencyCode,
  normalizeGiftCardNumber,
  type GiftCard,
  type GiftCardScope,
} from './GiftCardsApiService';

/** The native entry points this service needs; tests inject a fake. */
export interface GiftCardCheckoutBridge {
  giftCardCheckout: {
    redeemForOrder(payload: GiftCardRedeemForOrderRequest): Promise<unknown>;
    reconcileOrder(payload: GiftCardOrderRequest): Promise<unknown>;
    fiscalReadiness(payload?: GiftCardFiscalReadinessRequest): Promise<unknown>;
    fiscalFinalize(payload: GiftCardOrderRequest): Promise<unknown>;
    fiscalReconcile(payload: GiftCardOrderRequest): Promise<unknown>;
  };
  payments: {
    getSettlementSnapshot(orderId: string): Promise<unknown>;
  };
}

/**
 * - `unknown`: no native answer in this session; recover first.
 * - `checking`: native recovery is in flight.
 * - `clear`: native reports no unresolved attempt for the order.
 * - `submitting`: a gift debit is in flight.
 * - `unresolved`: native retains an unresolved attempt, or its answer was lost.
 */
export type GiftCardAdmissionState = 'unknown' | 'checking' | 'clear' | 'submitting' | 'unresolved';

export interface GiftCardAdmission {
  organizationId: string | null;
  terminalId: string | null;
  orderId: string;
  state: GiftCardAdmissionState;
  /** A gift fiscal receipt is unresolved; only fiscal reconciliation may follow. */
  fiscalPending: boolean;
  /** A fresh gift debit may be sent now. */
  giftDebitAllowed: boolean;
  /**
   * Ordinary cash/card collection may start without risking a second charge.
   * False while any hold exists; the holder asks `preflightOrdinaryCollection`.
   */
  ordinaryCollectionAllowed: boolean;
  /** Native or local code behind the state; never a secret. */
  code: string | null;
  /** The order's collection hold, if any. Separate from native gift and fiscal state. */
  reservation: GiftCardReservation | null;
}

export type GiftCardReservationKind = 'gift' | 'ordinary';

/**
 * - `busy`: the holder is working and may still send.
 * - `unknown`: a send may have happened and its outcome is not known.
 */
export type GiftCardReservationStatus = 'busy' | 'unknown';

/** Display view of a hold; it carries no ownership handle and no secret. */
export interface GiftCardReservation {
  kind: GiftCardReservationKind;
  status: GiftCardReservationStatus;
  code: string | null;
}

/**
 * Ownership of one order's ordinary collection, checked by object identity:
 * a copy, an older hold or another order's hold never settles it. Memory
 * only; never persist, log or send it anywhere.
 */
export interface GiftCardOrdinaryHold {
  readonly organizationId: string;
  readonly terminalId: string;
  readonly orderId: string;
  /** Local claim sequence, separate from admission generations; never an idempotency key. */
  readonly generation: number;
}

export type GiftCardOrdinaryClaim =
  | { claimed: true; hold: GiftCardOrdinaryHold; admission: GiftCardAdmission }
  | { claimed: false; code: string; admission: GiftCardAdmission };

/** The holder's own go-ahead; every other caller still sees the order reserved. */
export interface GiftCardOrdinaryPreflight {
  /** True only for the current busy hold once native reports no unresolved gift attempt. */
  proceed: boolean;
  code: string | null;
  /** Read after the last await. */
  admission: GiftCardAdmission;
}

/**
 * How the holder's collection ended:
 * - `not_sent` / `before_send`: nothing could have reached the terminal or the
 *   payment write yet. Refused once the hold is `unknown`.
 * - `not_sent` / `original_operation`: authoritative evidence about the
 *   original attempt shows no money moved. A rejection, timeout, empty query
 *   or unpaid ledger is not that evidence once a send may have happened.
 * - `completed`: the payment was recorded or adopted and canonically reconciled.
 * - `unknown`: a send may have happened; the hold stays and blocks the order.
 */
export type GiftCardOrdinaryResolution =
  | { outcome: 'not_sent'; basis: 'before_send' | 'original_operation' }
  | { outcome: 'completed' }
  | { outcome: 'unknown'; code?: string | null };

export interface GiftCardOrdinaryRelease {
  /** False when the hold is not the order's current one, or the resolution was refused. */
  applied: boolean;
  code: string | null;
  admission: GiftCardAdmission;
}

/** A canonical payment native already booked. Callers must never re-record it. */
export interface GiftCardAdoptedPayment {
  localPaymentId: string;
  remotePaymentId: string | null;
  method: 'gift_card';
  amountCents: number;
  currency: string;
  transactionRef: string | null;
}

export interface GiftCardCoveragePayment {
  paymentId: string;
  amountCents: number;
  currency: string | null;
  transactionRef: string | null;
  refundedCents: number;
}

/** Coverage read from the existing native settlement snapshot, never computed here. */
export interface GiftCardOrderCoverage {
  orderId: string;
  orderTotalCents: number;
  netPaidCents: number;
  outstandingCents: number;
  generation: string;
  giftPayments: GiftCardCoveragePayment[];
  /** True only when the snapshot shows nothing outstanding on a positive total. */
  fullyCovered: boolean;
}

export type GiftCardFiscalSource = 'redeem' | 'readiness' | 'finalize' | 'reconcile';
export type GiftCardFiscalNextAction = 'none' | 'finalize' | 'reconcile' | 'recheck';

/** Readiness only: whether the route would take a fresh gift debit now. Never this order's receipt. */
export interface GiftCardFreshDebitReadiness {
  status: GiftCardFiscalStatus | 'unrecognized';
  code: string | null;
}

export interface GiftCardFiscalOutcome {
  orderId: string;
  source: GiftCardFiscalSource;
  /** This order's receipt state; for readiness it is read from the nested `order`. */
  status: GiftCardFiscalStatus | 'invocation_failed' | 'unrecognized';
  code: string | null;
  operationId: string | null;
  requiresFinalize: boolean;
  requiresReconciliation: boolean;
  retryable: boolean;
  certified: boolean;
  /** The only fiscal step the native answer permits; never a money retry. */
  nextAction: GiftCardFiscalNextAction;
  /** The route's top-level readiness answer; `null` for every other source. */
  freshDebit: GiftCardFreshDebitReadiness | null;
}

export type GiftCardFiscalCall =
  | {
      sent: true;
      fiscal: GiftCardFiscalOutcome;
      /** False when a newer fiscal call for the order was issued meanwhile; its answer governs. */
      current: boolean;
    }
  | { sent: false; code: string };

export type GiftCardTenderRefusal =
  | 'scope'
  | 'order'
  | 'unsynced'
  | 'module'
  | 'offline'
  | 'unavailable'
  | 'card_number'
  | 'not_found'
  | 'amount'
  | 'currency'
  | 'balance'
  | 'expired'
  | 'inactive'
  | 'exceeds_outstanding'
  | 'nothing_due'
  | 'item_split'
  | 'split'
  | 'coverage_unavailable'
  | 'admission'
  | 'fiscal_pending'
  | 'staff'
  | 'readiness'
  | 'rejected';

export interface GiftCardTenderInput {
  orderId: string;
  /** Memory-only bearer credential. */
  cardNumber: string;
  amountCents: number;
  /** Uppercase ISO 4217 currency captured from the order. */
  currency: string;
  /** Amount-split portion this tender pays, if any. */
  split?: GiftCardCheckoutSplit | null;
  /** A non-empty item selection is refused: native gift supports amount splits only. */
  selectedItemIds?: readonly string[] | null;
  /** The card as read by the preceding lookup. */
  card: Pick<GiftCard, 'balance' | 'currency' | 'status' | 'expiresAt'>;
}

export type GiftCardRedeemOutcome =
  | {
      kind: 'applied';
      orderId: string;
      payment: GiftCardAdoptedPayment;
      replayed: boolean;
      recovered: boolean;
      coverage: GiftCardOrderCoverage | null;
      fiscal: GiftCardFiscalOutcome | null;
      admission: GiftCardAdmission;
    }
  | {
      kind: 'refused';
      orderId: string;
      refusal: GiftCardTenderRefusal;
      code: string | null;
      /** False when refused locally before anything reached native. */
      sent: boolean;
      admission: GiftCardAdmission;
    }
  | { kind: 'unresolved'; orderId: string; code: string | null; admission: GiftCardAdmission };

export interface GiftCardRecoveryOutcome {
  orderId: string;
  /** Read after this recovery's last await, so it never predates newer work on the order. */
  admission: GiftCardAdmission;
  /** Canonical payments native imported for the order during recovery, once each. */
  adopted: GiftCardAdoptedPayment[];
  coverage: GiftCardOrderCoverage | null;
  code: string | null;
}

/**
 * Secret-free checkout callback contract. Financial adoption, fiscal progress
 * and admission are reported separately; none of them carries a card number.
 */
export type GiftCardTenderEvent =
  | {
      type: 'financial';
      orderId: string;
      source: 'redeem' | 'recovery';
      adopted: GiftCardAdoptedPayment[];
      coverage: GiftCardOrderCoverage | null;
    }
  | { type: 'fiscal'; orderId: string; fiscal: GiftCardFiscalOutcome }
  | { type: 'admission'; orderId: string; admission: GiftCardAdmission };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const UPPERCASE_ISO_PATTERN = /^[A-Z]{3}$/;
const FISCAL_STATUSES: readonly string[] = [
  'not_required',
  'unsupported',
  'unavailable',
  'ready',
  'partial',
  'pending',
  'approved',
  'error',
];
const ORDER_STATE_UNREADABLE = 'GIFT_CARD_FISCAL_ORDER_STATE_UNREADABLE';
const ORDER_STATE_CONTRADICTORY = 'GIFT_CARD_FISCAL_ORDER_STATE_CONTRADICTORY';

/** Ordered: the first match wins. Unmatched codes are `rejected`. */
const REFUSAL_PATTERNS: ReadonlyArray<[RegExp, GiftCardTenderRefusal]> = [
  [/STAFF|ACTOR/, 'staff'],
  [/MODULE/, 'module'],
  [/PRIOR_RECEIPT|FISCAL_RECONCILIATION_REQUIRED/, 'fiscal_pending'],
  [/FISCAL/, 'readiness'],
  [/CURRENCY/, 'currency'],
  [/EXPIRED/, 'expired'],
  [/INSUFFICIENT|BALANCE/, 'balance'],
  [/ITEM/, 'item_split'],
  [/SPLIT/, 'split'],
  [/SYNC|REMOTE_ORDER/, 'unsynced'],
  [/NOT_FOUND/, 'not_found'],
  [/OFFLINE|NETWORK|UNREACHABLE/, 'offline'],
  [/INACTIVE|NOT_ACTIVE|BLOCKED|DISABLED|CANCELLED|VOIDED/, 'inactive'],
  [/UNREADABLE|UNAVAILABLE|SCHEMA|NOT_CONFIGURED/, 'unavailable'],
  [/OUTSTANDING|EXCEEDS|OVERPAY/, 'exceeds_outstanding'],
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asCode = (value: unknown): string | null => {
  const code = asString(value);
  return code && CODE_PATTERN.test(code) ? code : null;
};

const asFiscalStatus = (value: unknown): GiftCardFiscalStatus | null => {
  const status = asString(value);
  return status && FISCAL_STATUSES.includes(status) ? (status as GiftCardFiscalStatus) : null;
};

function majorToCents(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Anything missing or unreadable is `null`, so an empty answer fails closed. */
function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The direct redeem `payment`, which states its method: anything else is refused. */
function readCanonicalPayment(value: unknown): GiftCardAdoptedPayment | null {
  const outer = asRecord(value);
  const record = outer.payment !== undefined ? asRecord(outer.payment) : outer;
  const localPaymentId = asString(record.localPaymentId);
  const currency = normalizeCurrencyCode(record.currency);
  const amountCents = record.amountCents;
  if (!localPaymentId || record.method !== 'gift_card' || !currency) return null;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return null;
  }
  return {
    localPaymentId,
    remotePaymentId: asString(record.remotePaymentId),
    method: 'gift_card',
    amountCents,
    currency,
    transactionRef: asString(record.transactionRef),
  };
}

/**
 * One `applied` row of native `gift_card_reconcile_order`, exactly
 * `{idempotencyKey, localPaymentId, remotePaymentId, amountCents, currency}`.
 * That command imports gift card attempts only, so it proves the method; it
 * reports no transaction reference and none is invented. A missing or
 * malformed field, or an explicit other method, drops the row. The native
 * idempotency key is never copied.
 */
function readRecoveredPayment(value: unknown): GiftCardAdoptedPayment | null {
  const row = asRecord(value);
  const localPaymentId = asString(row.localPaymentId);
  const { amountCents, currency, method, remotePaymentId } = row;
  if (!localPaymentId) return null;
  if (method !== undefined && method !== null && method !== 'gift_card') return null;
  if (typeof currency !== 'string' || !UPPERCASE_ISO_PATTERN.test(currency)) return null;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return null;
  }
  if (remotePaymentId !== undefined && remotePaymentId !== null && asString(remotePaymentId) === null) {
    return null;
  }
  return {
    localPaymentId,
    remotePaymentId: asString(remotePaymentId),
    method: 'gift_card',
    amountCents,
    currency,
    transactionRef: asString(row.transactionRef),
  };
}

function readRecoveredPayments(value: unknown): { adopted: GiftCardAdoptedPayment[]; unreadable: boolean } {
  const adopted: GiftCardAdoptedPayment[] = [];
  let unreadable = false;
  for (const row of Array.isArray(value) ? value : []) {
    const payment = readRecoveredPayment(row);
    if (!payment) {
      unreadable = true;
    } else if (!adopted.some((known) => known.localPaymentId === payment.localPaymentId)) {
      // Each canonical payment is reported once.
      adopted.push(payment);
    }
  }
  return { adopted, unreadable };
}

function mapCoverage(value: unknown, orderId: string): GiftCardOrderCoverage | null {
  const snapshot = asRecord(value);
  if (snapshot.success !== true || asString(snapshot.orderId) !== orderId) return null;
  const orderTotalCents = majorToCents(snapshot.orderTotal);
  const netPaidCents = majorToCents(snapshot.netPaid);
  const outstandingCents = majorToCents(snapshot.outstandingAmount);
  if (orderTotalCents === null || netPaidCents === null || outstandingCents === null) return null;
  if (!Array.isArray(snapshot.completedPayments)) return null;
  const giftPayments = snapshot.completedPayments
    .map(asRecord)
    .filter((row) => row.method === 'gift_card')
    .map((row) => ({
      paymentId: asString(row.id) ?? '',
      amountCents: majorToCents(row.amount) ?? 0,
      currency: normalizeCurrencyCode(row.currency),
      transactionRef: asString(row.transactionRef),
      refundedCents: majorToCents(row.refundedAmount) ?? 0,
    }));
  return {
    orderId,
    orderTotalCents,
    netPaidCents,
    outstandingCents,
    generation: asString(snapshot.generation) ?? '',
    giftPayments,
    fullyCovered: orderTotalCents > 0 && outstandingCents <= 0,
  };
}

function fiscalNextAction(
  status: GiftCardFiscalOutcome['status'],
  source: GiftCardFiscalSource,
  requiresFinalize: boolean,
  requiresReconciliation: boolean,
  retryable: boolean,
): GiftCardFiscalNextAction {
  if (requiresReconciliation) return 'reconcile';
  // An unknown dispatch is only probed, never resent.
  if (status === 'pending') return requiresFinalize ? 'finalize' : 'reconcile';
  // An unreadable finalize answer may hide a dispatched receipt.
  if (status === 'unrecognized') return source === 'finalize' ? 'reconcile' : 'recheck';
  if (status === 'unavailable') return 'recheck';
  if (requiresFinalize || status === 'ready') return 'finalize';
  if (status === 'error' && retryable) return 'finalize';
  return 'none';
}

/** Flat dispositions: redeem `fiscal`, finalize and fiscal reconcile. */
function classifyFlat(
  record: Record<string, unknown>,
  source: GiftCardFiscalSource,
  orderId: string,
): GiftCardFiscalOutcome {
  const echoed = asString(record.orderId);
  const foreign = echoed !== null && echoed !== orderId;
  const status = foreign ? 'unrecognized' : asFiscalStatus(record.status) ?? 'unrecognized';
  const requiresFinalize = !foreign && record.requiresFinalize === true;
  const requiresReconciliation = !foreign && record.requiresReconciliation === true;
  const retryable = !foreign && record.retryable === true;
  return {
    orderId,
    source,
    status,
    code: foreign ? 'GIFT_CARD_FISCAL_ORDER_MISMATCH' : asCode(record.code),
    operationId: foreign ? null : asString(record.operationId),
    requiresFinalize,
    requiresReconciliation,
    retryable,
    certified: !foreign && record.certified === true,
    nextAction: fiscalNextAction(status, source, requiresFinalize, requiresReconciliation, retryable),
    freshDebit: null,
  };
}

/**
 * Order-scoped `gift_card_fiscal_readiness` wraps two answers. The top level
 * says whether the route would take a fresh gift debit now; any live gift
 * receipt turns it `unsupported`/ALREADY_STARTED. `order` is this order's own
 * receipt and drives the next step: a pending receipt is only probed, even on
 * an unavailable route; an approval stays approved; a partial settlement waits
 * for ordinary collection. A ready order may be finalized only while the route
 * is ready too, so route and configuration refusals stand. Missing, foreign or
 * contradictory order state never finalizes.
 */
function classifyReadiness(record: Record<string, unknown>, orderId: string): GiftCardFiscalOutcome {
  const route = asFiscalStatus(record.status);
  const routeCode = asCode(record.code);
  const order = asRecord(record.order);
  const bound = asString(record.orderId) === orderId && asString(order.orderId) === orderId;
  const state = bound ? asFiscalStatus(order.status) : null;
  const operationId = bound ? asString(order.operationId) : null;
  const finalizeFlag = order.requiresFinalize === true;
  const reconcileFlag = order.requiresReconciliation === true;
  const result = (
    status: GiftCardFiscalOutcome['status'],
    code: string | null,
    nextAction: GiftCardFiscalNextAction,
    certified = false,
  ): GiftCardFiscalOutcome => ({
    orderId,
    source: 'readiness',
    status,
    code,
    operationId,
    requiresFinalize: nextAction === 'finalize',
    requiresReconciliation: nextAction === 'reconcile',
    retryable: false,
    certified,
    nextAction,
    freshDebit: { status: route ?? 'unrecognized', code: routeCode },
  });
  // Probe a receipt this order may have started; otherwise read again.
  const unreadable = (code: string, started = false) =>
    result('unrecognized', code, bound && (started || reconcileFlag || operationId !== null) ? 'reconcile' : 'recheck');

  if (!state) return unreadable(ORDER_STATE_UNREADABLE);
  const code = asCode(order.code);
  switch (state) {
    case 'pending':
      // The started operation is retained and only probed, never resent.
      return result('pending', code, 'reconcile');
    case 'approved':
      return finalizeFlag || reconcileFlag || order.alreadyIssued === false
        ? unreadable(ORDER_STATE_CONTRADICTORY)
        : result('approved', code, 'none', order.certified === true);
    case 'ready':
      // Native reports ALREADY_STARTED only while this order has a live receipt operation.
      if (routeCode === 'GIFT_CARD_FISCAL_ALREADY_STARTED') return unreadable(ORDER_STATE_CONTRADICTORY, true);
      if (!finalizeFlag || reconcileFlag) return unreadable(ORDER_STATE_CONTRADICTORY);
      if (route === 'ready') return result('ready', code, 'finalize');
      if (route === 'unsupported') return result('unsupported', routeCode, 'none');
      if (route === 'unavailable' || route === 'error') return result(route, routeCode, 'recheck');
      if (route === 'pending') return result('pending', routeCode, 'reconcile');
      return unreadable(ORDER_STATE_CONTRADICTORY);
    case 'unavailable':
    case 'error':
      return finalizeFlag || reconcileFlag ? unreadable(ORDER_STATE_CONTRADICTORY) : result(state, code, 'recheck');
    default:
      // partial, not_required or unsupported: nothing this order may issue now.
      return finalizeFlag || reconcileFlag ? unreadable(ORDER_STATE_CONTRADICTORY) : result(state, code, 'none');
  }
}

export function classifyGiftCardFiscal(
  value: unknown,
  source: GiftCardFiscalSource,
  orderId: string,
): GiftCardFiscalOutcome {
  const record = asRecord(value);
  return source === 'readiness' ? classifyReadiness(record, orderId) : classifyFlat(record, source, orderId);
}

function fiscalInvocationFailed(source: GiftCardFiscalSource, orderId: string): GiftCardFiscalOutcome {
  // A lost finalize answer may hide a dispatched receipt: probe it, never resend.
  const nextAction: GiftCardFiscalNextAction = source === 'readiness' ? 'recheck' : 'reconcile';
  return {
    orderId,
    source,
    status: 'invocation_failed',
    code: 'GIFT_CARD_FISCAL_IPC_FAILED',
    operationId: null,
    requiresFinalize: false,
    requiresReconciliation: nextAction === 'reconcile',
    retryable: false,
    certified: false,
    nextAction,
    freshDebit: null,
  };
}

export function classifyGiftCardRefusal(code: string | null): GiftCardTenderRefusal {
  if (!code) return 'rejected';
  return REFUSAL_PATTERNS.find(([pattern]) => pattern.test(code))?.[1] ?? 'rejected';
}

interface ScopeParts {
  organizationId: string | null;
  terminalId: string | null;
}

const scopeParts = (scope: GiftCardScope | null | undefined): ScopeParts => ({
  organizationId: asString(scope?.organizationId),
  terminalId: asString(scope?.terminalId),
});

/** Stable per-organization, per-terminal, per-order key used to fence results. */
export function giftCardOrderKey(scope: GiftCardScope | null | undefined, orderId: string): string {
  const parts = scopeParts(scope);
  return JSON.stringify([parts.organizationId, parts.terminalId, asString(orderId)]);
}

/** The same key for an admission snapshot, so any caller can fence its results. */
export function giftCardAdmissionKey(
  admission: Pick<GiftCardAdmission, 'organizationId' | 'terminalId' | 'orderId'>,
): string {
  return JSON.stringify([admission.organizationId, admission.terminalId, asString(admission.orderId)]);
}

interface AdmissionEntry extends ScopeParts {
  orderId: string;
  state: GiftCardAdmissionState;
  fiscalPending: boolean;
  fiscalNext: GiftCardFiscalNextAction | null;
  code: string | null;
  /** Shared only while the native reconcile call is in flight. */
  recovery: Promise<GiftCardRecoveryOutcome> | null;
  /** Bumped on every admission change; a recovery applies only if unchanged since it began. */
  generation: number;
  /** Bumped per fiscal call or redeem receipt; only the latest one's answer applies. */
  fiscalTurn: number;
  /** The collection hold; independent of `generation`, which recovery advances. */
  holder: HoldRecord | null;
}

interface HoldRecord {
  kind: GiftCardReservationKind;
  status: GiftCardReservationStatus;
  code: string | null;
  /** The ordinary owner's handle; a gift hold stays inside `redeem`. */
  handle: GiftCardOrdinaryHold | null;
}

const holdCode = (holder: HoldRecord): string =>
  holder.status === 'busy' ? 'GIFT_CARD_COLLECTION_IN_PROGRESS' : 'GIFT_CARD_COLLECTION_OUTCOME_UNKNOWN';

const holdKey = (hold: GiftCardOrdinaryHold): string =>
  JSON.stringify([asString(hold?.organizationId), asString(hold?.terminalId), asString(hold?.orderId)]);

type NativeReply = { ok: true; raw: unknown } | { ok: false };

type LocalTender =
  | { refusal: GiftCardTenderRefusal; code: string }
  | { cardNumber: string; amountCents: number; currency: string; split: GiftCardCheckoutSplit | null };

export interface GiftCardCheckoutServiceOptions {
  bridge?: () => GiftCardCheckoutBridge;
  now?: () => number;
}

export class GiftCardCheckoutService {
  private readonly entries = new Map<string, AdmissionEntry>();
  private readonly listeners = new Set<(admission: GiftCardAdmission) => void>();
  private readonly bridge: () => GiftCardCheckoutBridge;
  private readonly now: () => number;
  private holdSequence = 0;

  constructor(options: GiftCardCheckoutServiceOptions = {}) {
    this.bridge = options.bridge ?? (() => getBridge());
    this.now = options.now ?? Date.now;
  }

  getAdmission(scope: GiftCardScope, orderId: string): GiftCardAdmission {
    const id = asString(orderId);
    return this.snapshot(id ? this.entry(scopeParts(scope), id) : this.blankEntry(scopeParts(scope), ''));
  }

  /** Observe admission changes for every order, including those from stale callers. */
  subscribe(listener: (admission: GiftCardAdmission) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Native recovery: imports retained canonical attempts; never a new debit. */
  recoverOrder(scope: GiftCardScope, orderId: string): Promise<GiftCardRecoveryOutcome> {
    const parts = scopeParts(scope);
    const id = asString(orderId);
    if (!id) {
      const admission = this.snapshot(this.blankEntry(parts, ''));
      return Promise.resolve({ orderId: '', admission, adopted: [], coverage: null, code: 'GIFT_CARD_ORDER_REQUIRED' });
    }
    return this.recoverEntry(this.entry(parts, id));
  }

  /**
   * The admission check an ordinary cash/card collection makes first. It
   * returns at once when native already reported the order clear; otherwise
   * it runs native recovery and admits only a clear answer. The result is
   * always the order's current admission, read after the last await.
   */
  async admitOrdinaryCollection(scope: GiftCardScope, orderId: string): Promise<GiftCardAdmission> {
    const id = asString(orderId);
    if (!id) return this.snapshot(this.blankEntry(scopeParts(scope), ''));
    const entry = this.entry(scopeParts(scope), id);
    if (entry.state !== 'clear' && entry.state !== 'submitting') await this.recoverOrder(scope, id);
    return this.snapshot(entry);
  }

  /**
   * Holds the order for one ordinary cash/card collection. Synchronous: call
   * it before any await (recovery, print policy, terminal discovery), whatever
   * native admission currently says. Refused while any gift or ordinary hold
   * exists for the order.
   */
  claimOrdinaryCollection(scope: GiftCardScope, orderId: string): GiftCardOrdinaryClaim {
    const parts = scopeParts(scope);
    const id = asString(orderId);
    if (!id) {
      return { claimed: false, code: 'GIFT_CARD_ORDER_REQUIRED', admission: this.snapshot(this.blankEntry(parts, '')) };
    }
    const entry = this.entry(parts, id);
    const refuse = (code: string): GiftCardOrdinaryClaim => ({ claimed: false, code, admission: this.snapshot(entry) });
    if (!parts.organizationId || !parts.terminalId) return refuse('GIFT_CARD_TERMINAL_SCOPE_REQUIRED');
    if (entry.holder) return refuse(holdCode(entry.holder));
    if (entry.state === 'submitting') return refuse('GIFT_CARD_REDEEM_IN_FLIGHT');
    const hold: GiftCardOrdinaryHold = Object.freeze({
      organizationId: parts.organizationId,
      terminalId: parts.terminalId,
      orderId: id,
      generation: ++this.holdSequence,
    });
    this.claimHold(entry, 'ordinary', hold);
    this.emit(entry);
    return { claimed: true, hold, admission: this.snapshot(entry) };
  }

  /** The hold's status while it is still the order's current one; `null` otherwise. */
  ordinaryHoldStatus(hold: GiftCardOrdinaryHold): GiftCardReservationStatus | null {
    return this.heldBy(hold)?.holder.status ?? null;
  }

  /**
   * The holder's own go-ahead, run after its claim and again right before the
   * send if it awaited anything since. Runs native gift recovery unless native
   * already reported the order clear. An `unknown` hold never proceeds.
   */
  async preflightOrdinaryCollection(hold: GiftCardOrdinaryHold): Promise<GiftCardOrdinaryPreflight> {
    const owned = this.heldBy(hold);
    if (!owned) return { proceed: false, code: 'GIFT_CARD_HOLD_NOT_CURRENT', admission: this.holdAdmission(hold) };
    const { entry, holder } = owned;
    if (holder.status === 'busy' && entry.state !== 'clear') await this.recoverEntry(entry);
    // Read after the last await: the owner may have settled or marked its hold meanwhile.
    const admission = this.snapshot(entry);
    if (entry.holder !== holder) return { proceed: false, code: 'GIFT_CARD_HOLD_NOT_CURRENT', admission };
    if (holder.status !== 'busy') return { proceed: false, code: holdCode(holder), admission };
    if (entry.state !== 'clear') {
      return { proceed: false, code: entry.code ?? 'GIFT_CARD_RECOVERY_REQUIRED', admission };
    }
    return { proceed: true, code: null, admission };
  }

  /**
   * Settles the holder's collection. Only the current hold settles; a copy, an
   * older hold or another order's hold changes nothing. An `unknown` hold is
   * released only by `completed` or original-operation `not_sent`.
   */
  resolveOrdinaryCollection(
    hold: GiftCardOrdinaryHold,
    resolution: GiftCardOrdinaryResolution,
  ): GiftCardOrdinaryRelease {
    const owned = this.heldBy(hold);
    if (!owned) return { applied: false, code: 'GIFT_CARD_HOLD_NOT_CURRENT', admission: this.holdAdmission(hold) };
    const { entry, holder } = owned;
    if (resolution && resolution.outcome === 'unknown') {
      this.retainHold(entry, holder, asCode(resolution.code) ?? 'GIFT_CARD_ORDINARY_OUTCOME_UNKNOWN');
      this.emit(entry);
      return { applied: true, code: holder.code, admission: this.snapshot(entry) };
    }
    const settled =
      !!resolution &&
      (resolution.outcome === 'completed' ||
        (resolution.outcome === 'not_sent' &&
          (resolution.basis === 'original_operation' ||
            (resolution.basis === 'before_send' && holder.status === 'busy'))));
    // A send may have happened: anything else keeps the hold.
    if (!settled) return { applied: false, code: holdCode(holder), admission: this.snapshot(entry) };
    this.releaseHold(entry, holder);
    this.emit(entry);
    return { applied: true, code: null, admission: this.snapshot(entry) };
  }

  async readCoverage(orderId: string): Promise<GiftCardOrderCoverage | null> {
    const id = asString(orderId);
    if (!id) return null;
    try {
      return mapCoverage(await this.bridge().payments.getSettlementSnapshot(id), id);
    } catch {
      return null;
    }
  }

  async redeem(scope: GiftCardScope, input: GiftCardTenderInput): Promise<GiftCardRedeemOutcome> {
    const parts = scopeParts(scope);
    const orderId = asString(input.orderId);
    const refuse = (
      entry: AdmissionEntry,
      refusal: GiftCardTenderRefusal,
      code: string | null,
      sent = false,
    ): GiftCardRedeemOutcome => ({ kind: 'refused', orderId: entry.orderId, refusal, code, sent, admission: this.snapshot(entry) });

    if (!orderId) return refuse(this.blankEntry(parts, ''), 'order', 'GIFT_CARD_ORDER_REQUIRED');
    const entry = this.entry(parts, orderId);
    if (!parts.organizationId || !parts.terminalId) {
      return refuse(entry, 'scope', 'GIFT_CARD_TERMINAL_SCOPE_REQUIRED');
    }
    const tender = this.validate(input);
    if ('refusal' in tender) return refuse(entry, tender.refusal, tender.code);
    // Any gift or ordinary hold blocks a new debit, whatever native admission says.
    if (entry.holder) return refuse(entry, 'admission', holdCode(entry.holder));
    if (entry.state !== 'clear') return refuse(entry, 'admission', 'GIFT_CARD_RECOVERY_REQUIRED');
    if (entry.fiscalPending) return refuse(entry, 'fiscal_pending', 'GIFT_CARD_FISCAL_RECEIPT_PENDING');

    // Hold the order before the coverage read so neither a second tap nor an
    // ordinary collection can race it. A refusal here sent nothing.
    const holder = this.claimHold(entry, 'gift', null);
    this.update(entry, 'submitting', null);
    const notSent = (refusal: GiftCardTenderRefusal, code: string): GiftCardRedeemOutcome => {
      this.releaseHold(entry, holder);
      this.update(entry, 'clear', null);
      return refuse(entry, refusal, code);
    };
    const coverage = await this.readCoverage(orderId);
    if (!coverage) return notSent('coverage_unavailable', 'GIFT_CARD_COVERAGE_UNAVAILABLE');
    if (coverage.outstandingCents <= 0) return notSent('nothing_due', 'GIFT_CARD_NOTHING_OUTSTANDING');
    if (tender.amountCents > coverage.outstandingCents) {
      return notSent('exceeds_outstanding', 'GIFT_CARD_AMOUNT_EXCEEDS_OUTSTANDING');
    }

    const payload: GiftCardRedeemForOrderRequest = {
      orderId,
      cardNumber: tender.cardNumber,
      amount: tender.amountCents / 100,
      currency: tender.currency,
      ...(tender.split ? { split: tender.split } : {}),
    };
    let raw: unknown;
    try {
      raw = await this.bridge().giftCardCheckout.redeemForOrder(payload);
    } catch {
      // No logging: the payload carries the card number. A lost answer may
      // hide a sent debit, so only native recovery can release the order.
      return this.unresolved(entry, holder,'GIFT_CARD_REDEEM_OUTCOME_UNCERTAIN');
    }

    const response = asRecord(raw);
    const code = asCode(response.code) ?? asCode(response.serverCode);
    const echoedOrderId = asString(response.orderId);
    if (echoedOrderId && echoedOrderId !== orderId) {
      return this.unresolved(entry, holder,'GIFT_CARD_REDEEM_ORDER_MISMATCH');
    }
    const payment = response.success === true ? readCanonicalPayment(response.payment) : null;
    if (payment) {
      const pending = response.reconciliationPending === true;
      const fiscal =
        response.fiscal === undefined || response.fiscal === null
          ? null
          : classifyGiftCardFiscal(response.fiscal, 'redeem', orderId);
      if (fiscal) this.noteFiscal(entry, fiscal, ++entry.fiscalTurn);
      const pendingCode = code ?? 'GIFT_CARD_RECONCILIATION_PENDING';
      // Native booked the canonical payment. If its reconciliation is still
      // open the hold stays, and only native recovery of this attempt settles it.
      if (pending) this.retainHold(entry, holder, pendingCode);
      else this.releaseHold(entry, holder);
      this.update(entry, pending ? 'unresolved' : 'clear', pending ? pendingCode : null);
      return {
        kind: 'applied',
        orderId,
        payment,
        replayed: response.replayed === true,
        recovered: response.recovered === true,
        coverage: await this.readCoverage(orderId),
        fiscal,
        admission: this.snapshot(entry),
      };
    }
    if (response.success !== false || response.reconciliationPending === true || code === 'GIFT_CARD_OUTCOME_UNKNOWN') {
      return this.unresolved(entry, holder,code ?? 'GIFT_CARD_REDEEM_OUTCOME_UNCERTAIN');
    }

    const refusal = classifyGiftCardRefusal(code);
    if (refusal === 'fiscal_pending') {
      entry.fiscalPending = true;
      entry.fiscalNext = 'reconcile';
    }
    // Native refused the debit outright, so the hold ends. An unclassified
    // refusal still needs a fresh native recovery before anything else.
    this.releaseHold(entry, holder);
    this.update(entry, refusal === 'rejected' ? 'unknown' : 'clear', code);
    return refuse(entry, refusal, code, true);
  }

  fiscalReadiness(scope: GiftCardScope, orderId: string): Promise<GiftCardFiscalCall> {
    return this.fiscalCall(scope, orderId, 'readiness');
  }

  /** Allowed only when the last native fiscal answer permits a finalize; one dispatch per permission. */
  finalizeFiscal(scope: GiftCardScope, orderId: string): Promise<GiftCardFiscalCall> {
    return this.fiscalCall(scope, orderId, 'finalize');
  }

  /** Read/probe only; retains the original fiscal operation. */
  reconcileFiscal(scope: GiftCardScope, orderId: string): Promise<GiftCardFiscalCall> {
    return this.fiscalCall(scope, orderId, 'reconcile');
  }

  private async fiscalCall(
    scope: GiftCardScope,
    orderId: string,
    source: Exclude<GiftCardFiscalSource, 'redeem'>,
  ): Promise<GiftCardFiscalCall> {
    const id = asString(orderId);
    if (!id) return { sent: false, code: 'GIFT_CARD_ORDER_REQUIRED' };
    const entry = this.entry(scopeParts(scope), id);
    if (source === 'finalize' && entry.fiscalNext !== 'finalize') {
      return { sent: false, code: 'GIFT_CARD_FISCAL_FINALIZE_NOT_PERMITTED' };
    }
    const turn = ++entry.fiscalTurn;
    // The permission is spent: a second finalize waits for a new native answer.
    if (source === 'finalize') entry.fiscalNext = null;
    let fiscal: GiftCardFiscalOutcome;
    try {
      const commands = this.bridge().giftCardCheckout;
      const raw =
        source === 'readiness'
          ? await commands.fiscalReadiness({ orderId: id })
          : source === 'finalize'
            ? await commands.fiscalFinalize({ orderId: id })
            : await commands.fiscalReconcile({ orderId: id });
      fiscal = classifyGiftCardFiscal(raw, source, id);
    } catch {
      fiscal = fiscalInvocationFailed(source, id);
    }
    const current = this.noteFiscal(entry, fiscal, turn);
    if (current) this.emit(entry);
    return { sent: true, fiscal, current };
  }

  private recoverEntry(entry: AdmissionEntry): Promise<GiftCardRecoveryOutcome> {
    // Join a native check only while it is in flight: once native answered, a
    // later request asks again, so a newer attempt is never vouched for by it.
    if (entry.recovery) return entry.recovery;
    if (entry.state === 'submitting') {
      return Promise.resolve({
        orderId: entry.orderId,
        admission: this.snapshot(entry),
        adopted: [],
        coverage: null,
        code: 'GIFT_CARD_REDEEM_IN_FLIGHT',
      });
    }
    this.update(entry, 'checking', entry.code);
    const generation = entry.generation;
    // Only a hold that already existed when this check began may be settled by it.
    const holder = entry.holder;
    const run: Promise<GiftCardRecoveryOutcome> = this.askNative(entry.orderId).then((reply) => {
      if (entry.recovery === run) entry.recovery = null;
      return this.finishRecovery(entry, generation, holder, reply);
    });
    entry.recovery = run;
    return run;
  }

  private async askNative(orderId: string): Promise<NativeReply> {
    try {
      return { ok: true, raw: await this.bridge().giftCardCheckout.reconcileOrder({ orderId }) };
    } catch {
      return { ok: false };
    }
  }

  private async finishRecovery(
    entry: AdmissionEntry,
    generation: number,
    holder: HoldRecord | null,
    reply: NativeReply,
  ): Promise<GiftCardRecoveryOutcome> {
    let adopted: GiftCardAdoptedPayment[] = [];
    let code: string | null = 'GIFT_CARD_RECOVERY_UNAVAILABLE';
    if (!reply.ok) {
      this.settle(entry, generation, 'unresolved', code);
    } else {
      const response = asRecord(reply.raw);
      const echoed = asString(response.orderId);
      const foreign = echoed !== null && echoed !== entry.orderId;
      const nativeCode = foreign ? 'GIFT_CARD_RECOVERY_ORDER_MISMATCH' : asCode(response.code);
      const read = foreign ? { adopted: [], unreadable: false } : readRecoveredPayments(response.applied);
      adopted = read.adopted;
      code = nativeCode ?? (read.unreadable ? 'GIFT_CARD_RECOVERY_PAYMENT_UNREADABLE' : null);
      const clear =
        !foreign &&
        response.success === true &&
        response.reconciliationPending !== true &&
        countOf(response.unresolved) === 0;
      // Native settles only the uncertain gift hold this check began under:
      // never an ordinary hold, and never a newer one.
      if (clear && entry.generation === generation && holder?.kind === 'gift' && holder.status === 'unknown') {
        this.releaseHold(entry, holder);
      }
      this.settle(entry, generation, clear ? 'clear' : 'unresolved', clear ? null : nativeCode ?? 'GIFT_CARD_RECONCILIATION_PENDING');
    }
    const coverage = await this.readCoverage(entry.orderId);
    // Read after the last await: newer work on this order may have changed it meanwhile.
    return { orderId: entry.orderId, admission: this.snapshot(entry), adopted, coverage, code };
  }

  private validate(input: GiftCardTenderInput): LocalTender {
    if (input.selectedItemIds && input.selectedItemIds.length > 0) {
      return { refusal: 'item_split', code: 'GIFT_CARD_ITEM_SPLIT_UNSUPPORTED' };
    }
    let split: GiftCardCheckoutSplit | null = null;
    if (input.split) {
      const groupId = asString(input.split.groupId);
      const portionId = asString(input.split.portionId);
      if (!groupId || !portionId) return { refusal: 'split', code: 'GIFT_CARD_SPLIT_INVALID' };
      split = { groupId, portionId };
    }
    const cardNumber = normalizeGiftCardNumber(input.cardNumber);
    if (!cardNumber) return { refusal: 'card_number', code: 'GIFT_CARD_NUMBER_INVALID' };
    const amountCents = input.amountCents;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > GIFT_CARD_MAX_AMOUNT_CENTS) {
      return { refusal: 'amount', code: 'GIFT_CARD_AMOUNT_INVALID' };
    }
    const currency = typeof input.currency === 'string' ? input.currency : '';
    if (!UPPERCASE_ISO_PATTERN.test(currency)) return { refusal: 'currency', code: 'GIFT_CARD_CURRENCY_REQUIRED' };
    if (normalizeCurrencyCode(input.card?.currency) !== currency) {
      return { refusal: 'currency', code: 'GIFT_CARD_CURRENCY_MISMATCH' };
    }
    const status = asString(input.card?.status)?.toLowerCase() ?? '';
    if (status === 'expired') return { refusal: 'expired', code: 'GIFT_CARD_EXPIRED' };
    if (status !== 'active') return { refusal: 'inactive', code: 'GIFT_CARD_INACTIVE' };
    const expiresAt = asString(input.card?.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= this.now()) return { refusal: 'expired', code: 'GIFT_CARD_EXPIRED' };
    const balanceCents = majorToCents(input.card?.balance);
    if (balanceCents === null || balanceCents < amountCents) {
      return { refusal: 'balance', code: 'GIFT_CARD_INSUFFICIENT_BALANCE' };
    }
    return { cardNumber, amountCents, currency, split };
  }

  /** Applies a fiscal answer unless a newer fiscal call for the order was issued since. */
  private noteFiscal(entry: AdmissionEntry, fiscal: GiftCardFiscalOutcome, turn: number): boolean {
    if (turn !== entry.fiscalTurn) return false;
    const unreadable = fiscal.status === 'unrecognized' || fiscal.status === 'invocation_failed';
    entry.fiscalNext = fiscal.nextAction;
    // An unreadable answer never releases a receipt already known to be pending.
    entry.fiscalPending = fiscal.nextAction === 'reconcile' || (unreadable && entry.fiscalPending);
    return true;
  }

  private unresolved(entry: AdmissionEntry, holder: HoldRecord, code: string): GiftCardRedeemOutcome {
    // A lost or uncertain answer may hide a debit: the hold stays until native recovery settles it.
    this.retainHold(entry, holder, code);
    this.update(entry, 'unresolved', code);
    return { kind: 'unresolved', orderId: entry.orderId, code, admission: this.snapshot(entry) };
  }

  private blankEntry(parts: ScopeParts, orderId: string): AdmissionEntry {
    return {
      ...parts,
      orderId,
      state: 'unknown',
      fiscalPending: false,
      fiscalNext: null,
      code: null,
      recovery: null,
      generation: 0,
      fiscalTurn: 0,
      holder: null,
    };
  }

  private entry(parts: ScopeParts, orderId: string): AdmissionEntry {
    const key = JSON.stringify([parts.organizationId, parts.terminalId, orderId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.blankEntry(parts, orderId);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** A recovery answer applies only while nothing changed the order since that recovery began. */
  private settle(
    entry: AdmissionEntry,
    generation: number,
    state: GiftCardAdmissionState,
    code: string | null,
  ): void {
    if (entry.generation === generation) this.update(entry, state, code);
  }

  /** Callers emit through their own admission update. */
  private claimHold(
    entry: AdmissionEntry,
    kind: GiftCardReservationKind,
    handle: GiftCardOrdinaryHold | null,
  ): HoldRecord {
    const holder: HoldRecord = { kind, status: 'busy', code: null, handle };
    entry.holder = holder;
    return holder;
  }

  /** Ends the hold only while it is still the order's current one. */
  private releaseHold(entry: AdmissionEntry, holder: HoldRecord): void {
    if (entry.holder === holder) entry.holder = null;
  }

  /** A send may have happened and its outcome is not known: keep the hold. */
  private retainHold(entry: AdmissionEntry, holder: HoldRecord, code: string): void {
    if (entry.holder !== holder) return;
    holder.status = 'unknown';
    holder.code = code;
  }

  /** The order an ordinary hold owns, only while that exact hold object is current. */
  private heldBy(hold: GiftCardOrdinaryHold): { entry: AdmissionEntry; holder: HoldRecord } | null {
    const entry = hold && typeof hold === 'object' ? this.entries.get(holdKey(hold)) : undefined;
    const holder = entry?.holder;
    return entry && holder && holder.handle === hold ? { entry, holder } : null;
  }

  private holdAdmission(hold: GiftCardOrdinaryHold): GiftCardAdmission {
    const entry = hold && typeof hold === 'object' ? this.entries.get(holdKey(hold)) : undefined;
    const parts = { organizationId: asString(hold?.organizationId), terminalId: asString(hold?.terminalId) };
    return this.snapshot(entry ?? this.blankEntry(parts, asString(hold?.orderId) ?? ''));
  }

  private update(entry: AdmissionEntry, state: GiftCardAdmissionState, code: string | null): void {
    entry.generation += 1;
    entry.state = state;
    entry.code = code;
    this.emit(entry);
  }

  private emit(entry: AdmissionEntry): void {
    const admission = this.snapshot(entry);
    for (const listener of [...this.listeners]) {
      try {
        listener(admission);
      } catch {
        // A listener failure never changes money state.
      }
    }
  }

  private snapshot(entry: AdmissionEntry): GiftCardAdmission {
    const holder = entry.holder;
    return {
      organizationId: entry.organizationId,
      terminalId: entry.terminalId,
      orderId: entry.orderId,
      state: entry.state,
      fiscalPending: entry.fiscalPending,
      giftDebitAllowed: entry.state === 'clear' && !entry.fiscalPending && !holder,
      ordinaryCollectionAllowed: entry.state === 'clear' && !holder,
      code: entry.code,
      reservation: holder ? { kind: holder.kind, status: holder.status, code: holder.code } : null,
    };
  }
}

export const giftCardCheckoutService = new GiftCardCheckoutService();

export default giftCardCheckoutService;
