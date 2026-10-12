export interface PendingWaiterReturn {
  id: string;
  staff_id: string;
  staff_name: string;
  terminal_id: string;
  currency: string;
  closing_cash_amount: number;
  expected_cash_amount: number;
  receiving_cashier_shift_id: string;
}

export async function readPendingWaiterReturns(shifts: { pendingCashReturns(): Promise<unknown> }) {
  const response = await shifts.pendingCashReturns() as any;
  const payload = response?.data ?? response;
  if (payload?.success !== true || typeof payload.requires_receipt_check !== 'boolean' || !Array.isArray(payload.returns)
    || !Number.isSafeInteger(payload.active_waiter_count) || payload.active_waiter_count < 0) {
    throw new Error('REMOTE_HANDOVER_FIGURES_UNAVAILABLE');
  }
  const rows: PendingWaiterReturn[] = payload.returns;
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row?.id || ids.has(row.id) || !row.staff_id || !row.receiving_cashier_shift_id || !/^[A-Z]{3}$/.test(row.currency)
      || !Number.isFinite(row.closing_cash_amount) || row.closing_cash_amount <= 0 || !Number.isFinite(row.expected_cash_amount)) {
      throw new Error('REMOTE_HANDOVER_FIGURES_UNAVAILABLE');
    }
    ids.add(row.id);
  }
  return { required: payload.requires_receipt_check as boolean, active: payload.active_waiter_count as number, returns: rows };
}
