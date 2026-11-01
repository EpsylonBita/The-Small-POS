import { describe, expect, it } from 'vitest';
import { refundFinishesCompletedOrder } from '../OrderRefundCancellation';

const cash = { id: 'cash', status: 'completed', method: 'cash' };
const base = { status: 'completed', payments: [cash], balances: { cash: { remaining: 4, verified: true } }, paymentId: 'cash', amount: 4 };

describe('full customer return routing', () => {
  it('uses the retained remainder after earlier returns', () => {
    expect(refundFinishesCompletedOrder(base)).toBe(true);
  });
  it('keeps partial refunds and active orders on the refund screen', () => {
    expect(refundFinishesCompletedOrder({ ...base, amount: 2 })).toBe(false);
    expect(refundFinishesCompletedOrder({ ...base, status: 'pending' })).toBe(false);
  });
  it('requires every other completed receipt to be fully returned', () => {
    const input = { ...base, payments: [cash, { ...cash, id: 'other' }],
      balances: { ...base.balances, other: { remaining: 1, verified: true } } };
    expect(refundFinishesCompletedOrder(input)).toBe(false);
    input.balances.other.remaining = 0;
    expect(refundFinishesCompletedOrder(input)).toBe(true);
  });
  it('never interprets unreadable or missing balances as zero retained money', () => {
    expect(refundFinishesCompletedOrder({ ...base, balances: {} })).toBe(false);
    expect(refundFinishesCompletedOrder({ ...base, balances: { cash: { remaining: 4 } } })).toBe(false);
  });
  it('leaves gift originals and platform-held money on their own return paths', () => {
    expect(refundFinishesCompletedOrder({ ...base, payments: [{ ...cash, method: 'gift_card' }] })).toBe(false);
    expect(refundFinishesCompletedOrder({ ...base, payments: [{ ...cash, platformSettlement: true }] })).toBe(false);
  });
  it('does not require another return of a refunded receipt', () => {
    expect(refundFinishesCompletedOrder({ ...base, payments: [cash, { ...cash, id: 'returned', status: 'refunded' }] })).toBe(true);
  });
});
