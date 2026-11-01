/** This only chooses the UI handoff. Native cancellation preflight still proves
 * manual provenance, current balances, currency, scope and approval. */
export function refundFinishesCompletedOrder(input: {
  status: unknown;
  payments: Array<{ id: string; status: string; method: string; platformSettlement?: boolean }>;
  balances: Record<string, { remaining: number; verified?: boolean }>;
  paymentId: string;
  amount: number;
}): boolean {
  if (!['completed', 'delivered'].includes(String(input.status).toLowerCase())) return false;
  const active = input.payments.filter(p => p.status === 'completed');
  return active.some(p => p.id === input.paymentId) && active.every(p => {
    if (p.platformSettlement || p.method === 'gift_card') return false;
    if (input.balances[p.id]?.verified !== true) return false;
    const remaining = input.balances[p.id]?.remaining;
    if (!Number.isFinite(remaining) || remaining < 0) return false;
    return Math.round(remaining * 100) === (p.id === input.paymentId ? Math.round(input.amount * 100) : 0);
  });
}
