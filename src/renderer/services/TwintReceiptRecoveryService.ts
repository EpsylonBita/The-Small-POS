import { getBridge } from '../../lib';
import type { UnsavedChargedPaymentSummary } from '../../lib/ipc-adapter';
import { currentTwintScope, loadTwintManualConfiguration, type TwintManualConfiguration } from './TwintManualQrService';
import { ordinaryCollectionView, probeOrdinaryOwner, retainedOrdinaryOwner } from '../hooks/useOrderStore';
import { giftCardCheckoutService, type GiftCardOrdinaryHold } from './GiftCardCheckoutService';

export async function loadPendingTwintReceipts(orderId?: string): Promise<UnsavedChargedPaymentSummary[]> {
  const scope = currentTwintScope();
  const reply = await getBridge().payments.listUnsavedPayments();
  if (!scope || !reply?.success || !Array.isArray(reply.payments) || currentTwintScope() !== scope) throw new Error('TWINT_RECEIPT_STATUS_UNAVAILABLE');
  return reply.payments.filter(value => value.method === 'twint' && (orderId
    ? value.kind === 'manual_twint_payment' && value.orderId === orderId
    : value.kind === 'manual_twint_checkout'));
}

export async function saveOriginalTwintReceipt(receipt: UnsavedChargedPaymentSummary): Promise<boolean> {
  const scope = currentTwintScope();
  if (!scope || receipt.manualScope !== scope || receipt.currency !== 'CHF' || !receipt.manualReceiptConfirmed) return false;
  const result = await getBridge().payments.saveUnsavedPayments({ idempotencyKey: receipt.idempotencyKey });
  const saved = currentTwintScope() === scope && result?.success === true && result.saved === 1 && result.unsaved.length === 0;
  if (saved && receipt.kind === 'manual_twint_payment') {
    const [organizationId,,terminalId]=scope.split('|');
    const owner=retainedOrdinaryOwner({organizationId,terminalId},receipt.orderId);
    if (owner && ordinaryCollectionView(owner)?.original?.idempotencyKey === receipt.idempotencyKey) {
      await probeOrdinaryOwner(owner,async()=>{
        const snapshot=await getBridge().payments.getSettlementSnapshot(receipt.orderId);
        return snapshot?.success && Array.isArray(snapshot.completedPayments) ? {completedPayments:snapshot.completedPayments,value:snapshot} : null;
      });
    }
  }
  return saved && currentTwintScope() === scope;
}

export type TwintAdmission =
  | { admitted: true; configuration: TwintManualConfiguration }
  | { admitted: false; code: string };

/**
 * Asked when the cashier taps TWINT, BEFORE the QR is shown (fix review
 * 06/10/2026): the QR used to come first, so every refusal of the receipt's
 * save came after the customer had paid. The fresh scoped configuration, the
 * durable receipts and, for an existing order, the native admission (the same
 * checks the receipt's save runs: a payment of the order not saved yet, an
 * unresolved card SALE or gift debit, an edit in progress, platform-held
 * money, the order's unit and outstanding balance) must all agree. Once the
 * QR is shown, a confirmed receipt is journaled whatever changes.
 */
export async function admitTwintCollection(params: {
  orderId?: string | null;
  amount: number;
  hold?: GiftCardOrdinaryHold | null;
}): Promise<TwintAdmission> {
  const scope = currentTwintScope();
  if (!scope || typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { admitted: false, code: 'TWINT_CONFIGURATION_UNAVAILABLE' };
  }
  const configuration = await loadTwintManualConfiguration().catch(() => null);
  if (!configuration || configuration.scope !== scope) {
    return { admitted: false, code: 'TWINT_CONFIGURATION_UNAVAILABLE' };
  }
  const orderId = params.orderId?.trim() || undefined;
  let pending: UnsavedChargedPaymentSummary[];
  try {
    pending = await loadPendingTwintReceipts(orderId);
  } catch {
    return { admitted: false, code: 'TWINT_RECEIPT_STATUS_UNAVAILABLE' };
  }
  if (pending.length > 0) return { admitted: false, code: 'TWINT_RECEIPT_PENDING' };
  if (orderId) {
    let snapshot: { twintAdmission?: { admitted?: unknown; code?: unknown; outstandingCents?: unknown } } | null;
    try {
      snapshot = await getBridge().invoke('payment:get-settlement-snapshot', { orderId, twintAdmission: true });
    } catch {
      return { admitted: false, code: 'TWINT_ADMISSION_UNAVAILABLE' };
    }
    const verdict = snapshot?.twintAdmission;
    if (verdict?.admitted !== true) {
      return { admitted: false, code: typeof verdict?.code === 'string' ? verdict.code : 'TWINT_ADMISSION_UNAVAILABLE' };
    }
    if (verdict.outstandingCents !== Math.round(params.amount * 100)) {
      return { admitted: false, code: 'TWINT_RECEIPT_OUTSTANDING_AMOUNT_CHANGED' };
    }
  }
  if (params.hold) {
    // The gift check the collection runs right before its write, asked now:
    // after the customer paid it may not refuse the receipt into thin air.
    const preflight = await giftCardCheckoutService.preflightOrdinaryCollection(params.hold).catch(() => null);
    if (!preflight?.proceed) return { admitted: false, code: preflight?.code ?? 'GIFT_CARD_RECOVERY_REQUIRED' };
  }
  if (currentTwintScope() !== scope) return { admitted: false, code: 'TWINT_RECEIPT_SCOPE_CHANGED' };
  return { admitted: true, configuration };
}

/** The receipt-admission codes the till explains in plain words. */
export type TwintAdmissionReason = 'notSaved' | 'reconcile' | 'platformHeld' | 'amountChanged' | 'pending' | 'unavailable';

export function twintAdmissionReason(code: string): TwintAdmissionReason {
  if (code === 'TWINT_RECEIPT_PENDING') return 'pending';
  if (code === 'PAYMENT_NOT_SAVED_PENDING') return 'notSaved';
  if (code === 'PLATFORM_HELD_NOT_COLLECTABLE') return 'platformHeld';
  if (code === 'TWINT_RECEIPT_OUTSTANDING_AMOUNT_CHANGED') return 'amountChanged';
  if ([
    'DIRECT_SALE_RECONCILIATION_REQUIRED',
    'FOLIO_CHARGE_RECONCILIATION_REQUIRED',
    'ORDER_EDIT_SETTLEMENT_PENDING',
    'TABLE_CANCELLATION_PENDING',
    'TWINT_RECEIPT_ORDER_CONTEXT_CHANGED',
  ].includes(code) || code.startsWith('GIFT_CARD_')) return 'reconcile';
  return 'unavailable';
}

/** The manager's way out for a TWINT receipt that can never be saved. */
export const TWINT_RETURNED_TO_CUSTOMER = 'twint_returned_to_customer';

export interface TwintReturnResult {
  success: boolean;
  idempotencyKey: string;
  orderId?: string | null;
  outcome: typeof TWINT_RETURNED_TO_CUSTOMER;
  result: 'resolved' | 'already_resolved' | 'saved' | 'not_found';
  resolvedAt: string;
  remainingUnsavedPayments: number;
}

/**
 * "Returned via TWINT outside the POS": a manager's own PIN records that the
 * customer got the money back through TWINT. Nothing is charged or refunded
 * here; native writes the audit, then removes the receipt, which then counts
 * nowhere. The PIN goes with this one decision (native verifies it, also
 * while a cashier is still on shift) and is never kept. Throws the native
 * refusal (approval, reference, eligibility).
 */
export function resolveReturnedTwintReceipt(params: {
  idempotencyKey: string;
  reference: string;
  resolvedBy?: string | null;
  managerPin?: string | null;
}): Promise<TwintReturnResult> {
  const managerPin = params.managerPin?.trim();
  return getBridge().invoke('payment:resolve-unsaved', {
    idempotencyKey: params.idempotencyKey,
    outcome: TWINT_RETURNED_TO_CUSTOMER,
    reference: params.reference,
    resolvedBy: params.resolvedBy ?? null,
    ...(managerPin ? { managerPin } : {}),
  });
}

export interface TwintReturnedReceipt {
  idempotencyKey: string;
  orderId: string;
  kind: string;
  amountCents: number;
  currency: string | null;
  capturedAt: string | null;
  resolvedAt: string;
  resolvedBy: string | null;
  reference: string | null;
}

/** TWINT receipts returned outside the POS since `since` (the Z window). */
export async function listTwintReturnedOutsidePos(since: string | null): Promise<TwintReturnedReceipt[]> {
  const reply = await getBridge().invoke('payment:list-unsaved', { twintReturnedSince: since });
  if (!reply?.success || !Array.isArray(reply.twintReturnedOutsidePos)) throw new Error('TWINT_RETURNS_UNAVAILABLE');
  return reply.twintReturnedOutsidePos as TwintReturnedReceipt[];
}
