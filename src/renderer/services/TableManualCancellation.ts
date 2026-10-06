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
  reason?: string;
  returnChannel?: CancellationReturnChannel;
}

export async function prepareTableCancellation(orderId: string, tableSessionId: string): Promise<TableCancellationPlan> {
  const plan = await getBridge().invoke('order_prepare_manual_cancel', { orderId, tableSessionId });
  if (plan?.success !== true || plan.orderId !== orderId || plan.tableSessionId !== tableSessionId
    || typeof plan.generation !== 'string' || typeof plan.requestId !== 'string' || !plan.requestId
    || !Number.isSafeInteger(plan.amountCents) || plan.amountCents < 0
    || (plan.pending && (!plan.reason?.trim() || (plan.requiresReturn && !['cash_drawer', 'bank'].includes(plan.returnChannel))))
    || (plan.requiresReturn && (plan.amountCents <= 0 || !/^[A-Z]{3}$/.test(plan.currency)))) {
    throw new Error('CANCELLATION_PAYMENT_CHANGED');
  }
  return plan;
}

export function tableCancellationFields(plan: TableCancellationPlan, returnChannel?: CancellationReturnChannel) {
  if (plan.pending && returnChannel !== plan.returnChannel) throw new Error('CANCELLATION_REQUEST_CONFLICT');
  if (plan.requiresReturn && !returnChannel) throw new Error('CANCELLATION_RETURN_CHANNEL_REQUIRED');
  return {
    clientEventId: plan.requestId,
    ...((plan.requiresReturn || plan.requiresHandback) ? {
      manualCancellation: { generation: plan.generation, returnChannel: returnChannel ?? 'cash_drawer' },
    } : {}),
  };
}
