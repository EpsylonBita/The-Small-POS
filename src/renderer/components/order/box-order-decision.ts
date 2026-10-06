/**
 * BOX (box.gr) order decisions on the desktop POS.
 *
 * The reject reasons, their predicate and the BOX platform check come from the
 * shared contract (`shared/box-order-contract.ts`, mirrored from the BOX
 * staging OpenAPI `OrderRejectionReason` enum). They are re-exported here so
 * the order components have one local import; never redefine them.
 *
 * BOX validates the reject `reason` against the exact Greek strings, so the
 * value sent upstream is always one of `BOX_REJECTION_REASONS` verbatim —
 * never a translation, a free-text note or an invented "other" value. The
 * locale keys below only drive what the operator reads.
 *
 * BOX has no ready / preparing / delivered callback, and accept / reject is
 * final upstream: a rejected BOX order cannot be reopened from the POS.
 *
 * The server owns the terminal state of a BOX decision (06/10/2026,
 * `ghost_metadata._the_small_box_decision`, state `closed`): BOX expired or
 * refused it, or the outcome is unknown and staff must check the order with
 * BOX. Such an order takes no accept / decline any more; while it is still
 * pending, staff may only close it here, without any BOX call.
 */
import {
  BOX_CLOSURE_CANCELLATION_REASONS,
  boxDecisionFailureKind,
  isBoxDecisionClosed,
  isBoxPlatform,
  isBoxRejectionReason,
  type BoxRejectionReason,
} from '../../../../../shared/box-order-contract';

export {
  BOX_CLOSURE_CANCELLATION_REASONS,
  BOX_REJECTION_REASONS,
  boxDecisionFailureKind,
  isBoxDecisionClosed,
  isBoxManualCheckRequired,
  isBoxRejectionReason,
  readBoxDecisionClosure,
  readBoxDisplayItems,
} from '../../../../../shared/box-order-contract';
export type { BoxDecisionClosure, BoxDisplayItem, BoxRejectionReason } from '../../../../../shared/box-order-contract';

export const BOX_PLUGIN_ID = 'box';

/**
 * Locale slug for each BOX reason, read as `boxOrder.reasons.<slug>`. Same
 * order as `BOX_REJECTION_REASONS`.
 */
export const BOX_REJECTION_REASON_LABEL_KEYS: Readonly<Record<BoxRejectionReason, string>> = Object.freeze({
  'Υψηλός Φόρτος Παραγγελιών': 'highOrderVolume',
  'Δεν υπάρχει διανομέας': 'noCourierAvailable',
  'Μη Διαθέσιμο Προϊόν': 'productUnavailable',
  'Εκτός ορίων εξυπηρέτησης': 'outsideServiceArea',
  'Λάθος τιμή σε προϊόν': 'wrongProductPrice',
  'Κλείνουμε Σύντομα': 'closingSoon',
  'Λόγω κακοκαιρίας': 'badWeather',
});

/** The i18n key of the operator-facing label for a BOX reason. */
export function boxRejectionReasonLabelKey(reason: BoxRejectionReason): string {
  return `boxOrder.reasons.${BOX_REJECTION_REASON_LABEL_KEYS[reason]}`;
}

const BOX_CLOSURE_CANCELLATION_REASON_SET: ReadonlySet<string> = new Set<string>(
  Object.values(BOX_CLOSURE_CANCELLATION_REASONS),
);

/**
 * The i18n key (`boxOrder.closedReasons.<code>`) of a cancellation reason the
 * server or this till wrote when a BOX decision closed. Null for any other
 * reason: those are staff's own words or a BOX reason, shown as written.
 */
export function boxClosedReasonLabelKey(cancellationReason: unknown): string | null {
  const code = typeof cancellationReason === 'string' ? cancellationReason.trim() : '';
  return BOX_CLOSURE_CANCELLATION_REASON_SET.has(code) ? `boxOrder.closedReasons.${code}` : null;
}

const ERROR_TEXT_MAX_DEPTH = 4;

/** The texts an error value carries: a string, its message / code and its nested causes. */
function collectErrorTexts(value: unknown, texts: string[], depth: number, seen: Set<unknown>): void {
  if (typeof value === 'string') {
    if (value) texts.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || depth > ERROR_TEXT_MAX_DEPTH || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  // POSError keeps what was thrown in `details.error`; others nest a cause.
  for (const key of ['message', 'code', 'error', 'details', 'originalError', 'cause']) {
    collectErrorTexts(record[key], texts, depth + 1, seen);
  }
}

/**
 * What a failed BOX accept / decline means to staff, from any of the errors
 * around it: what the caller threw and the order store's last error (whose
 * `details.error` keeps the native refusal, e.g. "BOX decision refused (HTTP
 * 400, BOX_DECISION_MANUAL_CHECK); refresh the order"). Null: an ordinary
 * failure that may be retried while the order is pending.
 */
export function classifyBoxDecisionFailure(...errors: unknown[]): 'closed' | 'manual_check' | null {
  const texts: string[] = [];
  for (const error of errors) collectErrorTexts(error, texts, 0, new Set());
  return boxDecisionFailureKind(texts.join('\n'));
}

/** The operator message of a failed BOX decision of that kind. */
export function boxDecisionFailureMessageKey(kind: 'closed' | 'manual_check' | null): string {
  if (kind === 'manual_check') return 'boxOrder.manualCheck';
  if (kind === 'closed') return 'boxOrder.decisionClosed';
  return 'boxOrder.decisionUnconfirmed';
}

// Bridge payloads are camelCase, the admin API is snake_case; the first
// non-empty value wins, matching how the order components read the platform.
const BOX_ORDER_SOURCE_FIELDS = Object.freeze([
  'plugin',
  'order_plugin',
  'orderPlugin',
  'platform',
  'order_platform',
  'orderPlatform',
] as const);

/** True when the order came from BOX (`box`, any casing, surrounding spaces ignored). */
export function isBoxOrder(order: unknown): boolean {
  if (!order || typeof order !== 'object') {
    return false;
  }
  const record = order as Record<string, unknown>;
  for (const field of BOX_ORDER_SOURCE_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') {
      return isBoxPlatform(value);
    }
  }
  const rawMetadata = record.ghost_metadata ?? record.ghostMetadata;
  let metadata: unknown = rawMetadata;
  if (typeof rawMetadata === 'string') {
    try { metadata = JSON.parse(rawMetadata); } catch { return false; }
  }
  if (!metadata || typeof metadata !== 'object') return false;
  const foodDelivery = (metadata as Record<string, unknown>).food_delivery;
  if (!foodDelivery || typeof foodDelivery !== 'object') return false;
  return isBoxPlatform((foodDelivery as Record<string, unknown>).platform);
}

/** Guard shared mutation boundaries, before bridge or local persistence. */
export function boxOrderStatusMutationAllowed(
  order: unknown,
  nextStatus: string,
  decision?: { kind: 'accept'; estimatedTime?: number } | { kind: 'reject'; reason?: unknown },
): boolean {
  if (!isBoxOrder(order)) return true;
  const current = String((order as Record<string, unknown>).status ?? '').toLowerCase();
  const next = nextStatus.toLowerCase();
  if (decision) {
    if (current !== 'pending') return false;
    return decision.kind === 'accept'
      ? next === 'confirmed' && Number.isInteger(decision.estimatedTime) && Number(decision.estimatedTime) > 0
      : next === 'cancelled' && isBoxRejectionReason(decision.reason);
  }
  if (['cancelled', 'canceled', 'rejected'].includes(current)) return false;
  if (current === 'pending') {
    // The server closed the decision (no accept / decline is possible any
    // more): staff may close the order here, a plain local cancel that never
    // reaches BOX. An open decision is only accepted or declined.
    return next === 'pending' || ((next === 'cancelled' || next === 'canceled') && isBoxDecisionClosed(order));
  }
  // Local ready/completed/driver fulfillment remain usable after acceptance.
  return next !== 'cancelled' && next !== 'canceled' && next !== 'rejected' && next !== 'pending';
}

/** A false result is a failed BOX decision, so callers must retain the panel. */
export async function runBoxApprovalDecision(decide: () => Promise<boolean>, afterSuccess: () => Promise<void> | void): Promise<void> {
  if (!(await decide())) throw new Error('BOX decision failed');
  await afterSuccess();
}

/** Return false without a provider call; callers must not report notification. */
export async function notifyOrderPlatformReady(order: unknown, notify: () => Promise<unknown>): Promise<boolean> {
  if (isBoxOrder(order)) return false;
  await notify();
  return true;
}
