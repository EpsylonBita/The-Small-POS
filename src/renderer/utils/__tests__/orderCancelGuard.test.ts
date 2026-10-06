import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix review 30/09/2026 (founder rule): the dashboard asks which selected
// orders money was taken on before it asks for a cancel reason; those are
// never cancelled (void or refund the payment first, or collect the rest).

const { getSettlementSnapshot } = vi.hoisted(() => ({ getSettlementSnapshot: vi.fn() }));

vi.mock('../../../lib', () => ({
  getBridge: () => ({ payments: { getSettlementSnapshot } }),
}));

import {
  cancelRefusalFromSnapshot,
  findCancelRefusals,
  findOrdersWithMoneyTaken,
  hasTableServiceEvidence,
} from '../orderCancelGuard';

// Review 06/10/2026: a kiosk eat-in order is dine-in with no table. Treating
// every dine-in order as a table check refused its cancellation with
// TABLE_CANCEL_SYNC_REQUIRED (offline TABLE_MANUAL_CANCELLATION_UNAVAILABLE).
describe('hasTableServiceEvidence', () => {
  it('decides by table evidence, never by the dine-in label alone', () => {
    expect(hasTableServiceEvidence({ orderType: 'dine-in' })).toBe(false);
    expect(hasTableServiceEvidence({ order_type: 'dine_in', table_number: '  ' })).toBe(false);
    expect(hasTableServiceEvidence({ orderType: 'dine-in', tableSessionId: 'session' })).toBe(true);
    expect(hasTableServiceEvidence({ order_type: 'dine-in', table_session_id: 'session' })).toBe(true);
    expect(hasTableServiceEvidence({ orderType: 'dine-in', table_id: 'table' })).toBe(true);
    expect(hasTableServiceEvidence({ orderType: 'dine-in', tableNumber: '7' })).toBe(true);
    expect(hasTableServiceEvidence({ order_type: 'dine-in', table_number: 7 })).toBe(true);
    // A detached pickup keeps ordinary cancellation ownership.
    expect(hasTableServiceEvidence({ orderType: 'pickup', tableNumber: '7' })).toBe(false);
    expect(hasTableServiceEvidence(undefined)).toBe(false);
  });
});

describe('findOrdersWithMoneyTaken', () => {
  beforeEach(() => {
    getSettlementSnapshot.mockReset();
  });

  it('names the orders with money taken on them', async () => {
    getSettlementSnapshot.mockImplementation(async (orderId: string) => ({
      success: true,
      orderId,
      orderTotal: 13,
      netPaid: orderId === 'order-part-paid' ? 5 : 0,
      outstandingAmount: orderId === 'order-part-paid' ? 8 : 13,
      completedPayments: [],
      generation: 'g',
    }));

    await expect(findOrdersWithMoneyTaken(['order-unpaid', 'order-part-paid'])).resolves.toEqual([
      'order-part-paid',
    ]);
  });

  it('leaves an order whose ledger cannot be read to the till', async () => {
    getSettlementSnapshot.mockRejectedValue(new Error('database is locked'));

    await expect(findOrdersWithMoneyTaken(['order-unknown'])).resolves.toEqual([]);
  });
});

// Founder rule 30/09 and 01/10/2026: an order labelled paid with no payment
// record on this till is not cancelled either. The till names the refusal in
// the settlement snapshot, and the dashboard tells the cashier before the
// reason is asked (restore it from the server, or record the payment).
describe('findCancelRefusals', () => {
  beforeEach(() => {
    getSettlementSnapshot.mockReset();
  });

  it('separates a paid label with no record from money taken', async () => {
    getSettlementSnapshot.mockImplementation(async (orderId: string) => ({
      success: true,
      orderId,
      orderTotal: 10,
      netPaid: orderId === 'order-cash' ? 10 : 0,
      outstandingAmount: orderId === 'order-cash' ? 0 : 10,
      completedPayments: [],
      generation: 'g',
      cancelRefusal:
        orderId === 'order-paid-no-record'
          ? 'ORDER_PAYMENT_NOT_RECORDED'
          : orderId === 'order-cash'
            ? 'ORDER_HAS_PAYMENTS'
            : null,
    }));

    await expect(
      findCancelRefusals(['order-paid-no-record', 'order-cash', 'order-open']),
    ).resolves.toEqual({
      hasPayments: ['order-cash'],
      notRecorded: ['order-paid-no-record'],
    });
  });
});

// Round 2 review (01/10/2026): a platform order's settlement row (written by
// the server at ingest) counts in `netPaid`, but the till does not refuse its
// decline (`cancelRefusal: null`). The screen used to refuse it anyway from
// `netPaid`, a dead end; it now trusts the refusal the till names, and falls
// back to `netPaid` only when the snapshot names none (an older till, or a
// ledger it could not read).
describe('cancelRefusalFromSnapshot', () => {
  it('trusts the till: a platform settlement is no refusal', () => {
    expect(cancelRefusalFromSnapshot({ netPaid: 12, outstandingAmount: 0, cancelRefusal: null })).toBeNull();
  });

  it('names the till refusals', () => {
    expect(cancelRefusalFromSnapshot({ netPaid: 0, cancelRefusal: 'ORDER_PAYMENT_NOT_RECORDED' })).toBe(
      'ORDER_PAYMENT_NOT_RECORDED',
    );
    expect(cancelRefusalFromSnapshot({ netPaid: 5, cancelRefusal: 'ORDER_HAS_PAYMENTS' })).toBe('ORDER_HAS_PAYMENTS');
  });

  it('falls back to the money taken when the till names nothing', () => {
    expect(cancelRefusalFromSnapshot({ netPaid: 5 })).toBe('ORDER_HAS_PAYMENTS');
    expect(cancelRefusalFromSnapshot({ netPaid: 0 })).toBeNull();
  });

  it('lets the dashboard decline a platform order its settlement covers', async () => {
    getSettlementSnapshot.mockReset();
    getSettlementSnapshot.mockResolvedValue({
      success: true,
      orderId: 'order-efood-settled',
      orderTotal: 12,
      netPaid: 12,
      outstandingAmount: 0,
      completedPayments: [],
      generation: 'g',
      cancelRefusal: null,
    });

    await expect(findCancelRefusals(['order-efood-settled'])).resolves.toEqual({
      hasPayments: [],
      notRecorded: [],
    });
  });
});
