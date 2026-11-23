export interface KeptTips {
  version: 1;
  roleType: 'waiter' | 'driver';
  totalCents: number;
  payoutCents: number;
  lines: Array<{
    paymentId: string | null;
    orderId: string;
    orderNumber: string | null;
    tableCode: string | null;
    method: string;
    cents: number;
  }>;
}

export function readKeptTips(value: unknown): KeptTips | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const tips = value as KeptTips;
  if (tips.version !== 1 || (tips.roleType !== 'waiter' && tips.roleType !== 'driver')
    || !Number.isSafeInteger(tips.totalCents) || tips.totalCents < 0
    || !Number.isSafeInteger(tips.payoutCents) || tips.payoutCents < 0
    || !Array.isArray(tips.lines)
    || !tips.lines.every(line => line && typeof line.orderId === 'string'
      && (line.tableCode === null || typeof line.tableCode === 'string')
      && (line.orderNumber === null || typeof line.orderNumber === 'string')
      && Number.isSafeInteger(line.cents) && line.cents > 0)
    || tips.totalCents !== tips.lines.reduce((sum, line) => sum + line.cents, 0)) {
    return undefined;
  }
  return tips;
}

export function isWaiterRole(role: unknown): boolean {
  return role === 'waiter' || role === 'server';
}

export function phoneDrawerPayout(figures: {version?: number; payoutCents?: number} | null): number {
  const cents = figures?.version === 2 ? figures.payoutCents ?? 0 : 0;
  return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : 0;
}
