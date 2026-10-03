import { getBridge } from '../../lib';
import type { UnsavedChargedPaymentSummary } from '../../lib/ipc-adapter';
import { currentTwintScope } from './TwintManualQrService';
import { ordinaryCollectionView, probeOrdinaryOwner, retainedOrdinaryOwner } from '../hooks/useOrderStore';

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
