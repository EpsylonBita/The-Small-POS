import { getBridge } from '../../lib';
import type { CancellationReturnChannel } from '../components/modals/OrderCancellationModal';

export interface TableCancellationPlan {
  orderId: string;
  tableSessionId: string;
  requiresReturn: boolean;
  requiresHandback: boolean;
  amountCents: number;
  currency: string;
  generation: string;
  requestId: string;
  pending?: boolean;
  /**
   * The server refused this saved cancellation: nothing was returned and it
   * is never sent again. A manager clears it before a new attempt.
   */
  refused?: boolean;
  refusalCode?: string | null;
  reason?: string;
  returnChannel?: CancellationReturnChannel;
}

export async function prepareTableCancellation(orderId: string, tableSessionId: string): Promise<TableCancellationPlan> {
  const bridge = getBridge();
  const plan = await bridge.invoke('order_prepare_manual_cancel', { orderId, tableSessionId });
  if (plan?.success !== true || typeof plan.orderId !== 'string' || !plan.orderId || plan.tableSessionId !== tableSessionId
    || typeof plan.generation !== 'string' || typeof plan.requestId !== 'string' || !plan.requestId
    || !Number.isSafeInteger(plan.amountCents) || plan.amountCents < 0
    || (plan.pending && (!plan.reason?.trim() || (plan.requiresReturn && !['cash_drawer', 'bank'].includes(plan.returnChannel))))
    || (plan.requiresReturn && (plan.amountCents <= 0 || !/^[A-Z]{3}$/.test(plan.currency)))) {
    throw new Error('CANCELLATION_PAYMENT_CHANGED');
  }
  if (plan.orderId !== orderId) {
    // Native preparation resolves a canonical UUID to this till's local order.
    // Prove that alias and its check from the native ledger; never accept an
    // arbitrary returned ID or rewrite the retained plan/event identity.
    const local = await bridge.orders.getById(orderId) as unknown as Record<string, unknown> | null;
    if (!local || local.id !== plan.orderId || (local.supabase_id ?? local.supabaseId) !== orderId
      || (local.table_session_id ?? local.tableSessionId) !== tableSessionId) {
      throw new Error('CANCELLATION_PAYMENT_CHANGED');
    }
  }
  return plan;
}

export function tableCancellationFields(plan: TableCancellationPlan, returnChannel?: CancellationReturnChannel) {
  // A refused attempt is never sent again; a manager clears it first.
  if (plan.refused) throw new Error('TABLE_CANCELLATION_REFUSED');
  if (plan.pending && returnChannel !== plan.returnChannel) throw new Error('CANCELLATION_REQUEST_CONFLICT');
  if (plan.requiresReturn && !returnChannel) throw new Error('CANCELLATION_RETURN_CHANNEL_REQUIRED');
  return {
    clientEventId: plan.requestId,
    ...((plan.requiresReturn || plan.requiresHandback) ? {
      manualCancellation: { generation: plan.generation, returnChannel: returnChannel ?? 'cash_drawer' },
    } : {}),
  };
}

/**
 * Ask the till to clear a saved table cancellation that never applied money
 * (refused by the server, never sent, or proven uncommitted). A staff
 * member's own PIN approves it; nothing is charged, returned or cancelled.
 */
export async function releaseRefusedTableCancellation(
  plan: Pick<TableCancellationPlan, 'orderId' | 'tableSessionId' | 'requestId' | 'reason'>,
  managerPin?: string,
) {
  const params = {
    orderId: plan.orderId,
    reason: plan.reason?.trim() || 'Refused table cancellation cleared',
    tableSessionId: plan.tableSessionId,
    managerPin,
    releaseRefusedCancellation: { clientEventId: plan.requestId },
  };
  const result = await getBridge().orders.cancelWithApproval(params);
  if (result?.success !== true || (result as { released?: unknown }).released !== true) {
    throw new Error('TABLE_CANCELLATION_PENDING');
  }
  return result;
}
