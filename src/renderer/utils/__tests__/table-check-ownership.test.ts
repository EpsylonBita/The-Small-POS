import { describe, expect, it } from 'vitest';
import { buildUnpaidAmountByItemId, hydrateTableCheckItems, mergeTableCheckPayments, paymentBelongsToTableSession, sumTableCheckLineTotals } from '../tableCheckPayments';

describe('split table check ownership', () => {
  const original = [{ id: 'item-1', menu_item_id: 'menu-1', name: 'QA', quantity: 3, unit_price: 10, total_price: 30 }];

  it('keeps 2 x 10 at source and 1 x 10 at target across repeated hydration from a stale full local order', () => {
    const source = [{ order_item_id: 'item-1', quantity: 2, status: 'open' }];
    const target = [{ order_item_id: 'item-1', quantity: 1, status: 'open' }];
    let sourceItems = original;
    let targetItems = original;
    for (let reopen = 0; reopen < 3; reopen += 1) {
      sourceItems = hydrateTableCheckItems(sourceItems, original, source) as typeof original;
      targetItems = hydrateTableCheckItems(targetItems, original, target) as typeof original;
      expect(sourceItems[0].quantity).toBe(2);
      expect(targetItems[0].quantity).toBe(1);
      expect(sumTableCheckLineTotals(sourceItems)).toBe(20);
      expect(sumTableCheckLineTotals(targetItems)).toBe(10);
    }
  });

  it('does not resurrect a fully transferred source and preserves destination effective pricing', () => {
    expect(hydrateTableCheckItems([], original, [{ order_item_id: 'item-1', quantity: 3, status: 'transferred' }])).toEqual([]);
    const items = hydrateTableCheckItems(original, original, [{
      order_item_id: 'item-1', quantity: 1, status: 'open', metadata: { effective_unit_price: 8, original_unit_price: 10 },
    }]);
    expect(sumTableCheckLineTotals(items)).toBe(8);
  });

  it('attributes explicit and legacy receipts to only their owning check', () => {
    const payments = [{ table_session_id: 'source', amount: 15 }, { tableSessionId: 'source', amount: 15 }, { amount: 4 }];
    expect(payments.filter(payment => paymentBelongsToTableSession(payment, 'target', 'source'))).toEqual([]);
    expect(payments.filter(payment => paymentBelongsToTableSession(payment, 'source', 'source'))).toHaveLength(3);
    expect(paymentBelongsToTableSession({ amount: 4 }, 'target')).toBe(false);
  });

  it('deduplicates a synced receipt while retaining a distinct pending receipt', () => {
    const remote = [{ id: 'remote-1', metadata: { local_payment_id: 'local-1' }, amount: 5, table_session_id: 'source' }];
    const local = [{ id: 'local-1', remote_payment_id: 'remote-1', amount: 5, table_session_id: 'source' },
      { id: 'local-2', amount: 3, table_session_id: 'source' }];
    expect(mergeTableCheckPayments<Record<string, unknown>>(remote, local).reduce((sum, row) => sum + Number(row.amount), 0)).toBe(8);
  });

  it('uses stable paid item identity when a split check no longer has the original line indexes', () => {
    const items = [{ id: 'second-line', total: 10 }];
    const paid = [{ order_item_id: 'second-line', itemIndex: 1, itemAmount: 5 }];
    expect(buildUnpaidAmountByItemId(items, paid, 5, item => item.total).get('second-line')).toBe(5);
    expect(buildUnpaidAmountByItemId(items, [{ order_item_id: 'first-line', itemIndex: 0, itemAmount: 5 }], 0, item => item.total).get('second-line')).toBe(10);
  });

  it('keeps a pending source receipt during an authoritative compatible merge without assigning it to another partial check', () => {
    const payment = { table_session_id: 'old-owner', amount: 5 };
    expect(paymentBelongsToTableSession(payment, 'merged-owner', 'merged-owner', ['old-owner'])).toBe(true);
    expect(paymentBelongsToTableSession(payment, 'partial-target', 'merged-owner', ['old-owner'])).toBe(false);
  });
});
