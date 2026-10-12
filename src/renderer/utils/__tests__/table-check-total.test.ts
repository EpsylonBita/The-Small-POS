import { describe, expect, it } from 'vitest';
import type { RestaurantTable } from '../../types/tables';
import { sumTableCheckDue } from '../table-check-total';

const table = (id: string, due: number, session?: string, overrides: Partial<RestaurantTable> = {}) => ({
  id, organizationId: 'org', branchId: 'branch', tableSessionId: session,
  unpaidBalance: due, ...overrides,
} as RestaurantTable);
const due = (row: RestaurantTable) => row.unpaidBalance ?? 0;

describe('table check outstanding total', () => {
  it('counts a merged P02/P05 check once without hiding the two occupied tables', () => {
    const rows = [table('P01', 69, 'old'), table('P02', 21, 'merged'),
      table('P04', 10.5, 'waiter-b'), table('P05', 21, 'merged')];
    expect(sumTableCheckDue(rows, due)).toBe(100.5);
    expect(rows).toHaveLength(4);
  });
  it('counts separate split sessions of the same parent independently', () => {
    const rows = [table('P02', 10.5, 'source', { currentOrderId: 'same-parent' }),
      table('P05', 10.5, 'split', { currentOrderId: 'same-parent' })];
    expect(sumTableCheckDue(rows, due)).toBe(21);
  });
  it('keeps shared-check identity scoped to organization and branch', () => {
    const rows = [table('P02', 21, 'same-id'), table('P05', 21, 'same-id', { branchId: 'other' }),
      table('P06', 21, 'same-id', { organizationId: 'other' })];
    expect(sumTableCheckDue(rows, due)).toBe(63);
  });
  it('preserves individual legacy balances without a session identity', () => {
    expect(sumTableCheckDue([table('P02', 21), table('P05', 21)], due)).toBe(42);
  });
  it('counts a shared check when only its secondary table is in the selected floor', () => {
    expect(sumTableCheckDue([table('P05', 21, 'merged')], due)).toBe(21);
  });
  it('counts the remaining shared balance after a partial collection', () => {
    expect(sumTableCheckDue([table('P01', 69, 'old'), table('P02', 15, 'merged'),
      table('P04', 10.5, 'waiter-b'), table('P05', 15, 'merged')], due)).toBe(94.5);
  });
});
