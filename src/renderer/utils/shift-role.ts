export type StaffShiftRole = 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';

/** Admin staff directories call the table-service role waiter; the shift ledger uses server. */
export function normalizeShiftRole(role: string | null | undefined): StaffShiftRole | null {
  const normalized = role?.trim().toLowerCase();
  if (normalized === 'waiter') return 'server';
  return ['cashier', 'manager', 'driver', 'kitchen', 'server'].includes(normalized ?? '')
    ? normalized as StaffShiftRole
    : null;
}
