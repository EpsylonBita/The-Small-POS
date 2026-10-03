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
 */
import { isBoxPlatform, isBoxRejectionReason, type BoxRejectionReason } from '../../../../../shared/box-order-contract';

export { BOX_REJECTION_REASONS, isBoxRejectionReason } from '../../../../../shared/box-order-contract';
export type { BoxRejectionReason } from '../../../../../shared/box-order-contract';

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
    return next === 'pending';
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
