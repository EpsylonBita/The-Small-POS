import { describe, expect, it, vi } from 'vitest';

import { loadPaymentEditRoute, routePaymentEdit } from '../paymentEditRouting';

describe('routePaymentEdit', () => {
  it.each([
    { id: 'returned', method: 'cash', status: 'refunded', amount: 4 },
    { id: 'partial-refund', method: 'card', status: 'completed', amount: 8, refundedAmount: 4 },
    { id: 'void', method: 'cash', status: 'voided', amount: 4 },
    // Fix review 30/09/2026: set aside as a possible duplicate, under review.
    { id: 'set-aside', method: 'cash', status: 'duplicate_review', amount: 4 },
  ])('explains why an adjusted ledger cannot change tender: $id', (adjusted) => {
    expect(routePaymentEdit(
      { status: 'pending', paymentStatus: 'paid' },
      [{ id: 'paid', method: 'card', status: 'completed', amount: 4 }, adjusted],
    )).toEqual({ kind: 'blocked', reason: 'adjusted' });
  });
  it('routes a non-cancelled pending order with no payment rows to missing-payment collection', () => {
    expect(
      routePaymentEdit(
        { status: 'pending', paymentStatus: 'pending', paymentMethod: 'pending' },
        [],
      ),
    ).toEqual({ kind: 'collect-missing' });
  });

  it('keeps completed cash/card rows on the existing payment-edit path', () => {
    expect(
      routePaymentEdit(
        { status: 'completed', paymentStatus: 'paid', paymentMethod: 'cash' },
        [
          {
            id: 'payment-1',
            method: 'cash',
            status: 'completed',
            amount: 18.5,
            transactionRef: 'SAFE-REFERENCE',
          },
        ],
      ),
    ).toEqual({
      kind: 'edit-existing',
      currentMethod: 'cash',
      payments: [
        {
          id: 'payment-1',
          method: 'cash',
          amount: 18.5,
          transactionRef: 'SAFE-REFERENCE',
        },
      ],
    });
  });

  it('does not offer collection or editing for cancelled orders', () => {
    expect(
      routePaymentEdit(
        { status: 'cancelled', paymentStatus: 'pending', paymentMethod: 'pending' },
        [],
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('fails closed when rows exist but none is a completed cash/card payment', () => {
    expect(
      routePaymentEdit(
        { status: 'pending', paymentStatus: 'pending', paymentMethod: 'pending' },
        [{ id: 'failed-payment', method: 'cash', status: 'failed', amount: 18.5 }],
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it('routes a partially-paid order with completed rows to outstanding collection before row editing', () => {
    expect(
      routePaymentEdit(
        { status: 'pending', paymentStatus: 'partially_paid', paymentMethod: 'cash' },
        [{ id: 'payment-1', method: 'cash', status: 'completed', amount: 8 }],
      ),
    ).toEqual({ kind: 'collect-missing' });
  });

  it('loads the selected order ledger through the bridge before choosing collection', async () => {
    const getOrderPayments = vi.fn().mockResolvedValue([]);
    const order = {
      id: 'order-without-payment',
      status: 'pending',
      paymentStatus: 'pending',
    };

    await expect(
      loadPaymentEditRoute({ payments: { getOrderPayments } }, order),
    ).resolves.toEqual({ kind: 'collect-missing' });
    expect(getOrderPayments).toHaveBeenCalledOnce();
    expect(getOrderPayments).toHaveBeenCalledWith('order-without-payment');
  });

  it.each(['paid', 'refunded'])('does not collect a zero-row %s order', (paymentStatus) => {
    expect(
      routePaymentEdit(
        { status: 'completed', paymentStatus, paymentMethod: 'pending' },
        [],
      ),
    ).toEqual({ kind: 'blocked' });
  });

  it.each(['refunded', 'voided', 'cancelled'])('does not edit retained rows for a %s payment state', (paymentStatus) => {
    expect(
      routePaymentEdit(
        { status: 'completed', paymentStatus, paymentMethod: 'cash' },
        [{ id: 'retained-payment', method: 'cash', status: 'completed', amount: 18.5 }],
      ),
    ).toEqual({ kind: 'blocked' });
  });
});

// Shared rule R4 (round 3 review, 01/10/2026): "Record the payment" is never
// offered for an order whose money the delivery platform holds. Edit options
// -> payment routed a platform-held order with a pending or partly paid label
// and no till row to the cash/card missing-payment repair; the till refused it
// only when the disposition was known, the server refused it again otherwise
// and set it aside again.
describe('routePaymentEdit on platform-held money (R4)', () => {
  const prepaid = JSON.stringify({ food_delivery: { prepaid: true, payment_method: 'online' } });

  it.each(['pending', 'partially_paid'])(
    'never routes a prepaid platform order (%s) to the missing-payment collection',
    (paymentStatus) => {
      expect(
        routePaymentEdit(
          {
            id: 'ord-efood',
            status: 'pending',
            paymentStatus,
            plugin: 'efood',
            external_plugin_order_id: 'efood-1',
            ghost_metadata: prepaid,
          },
          [],
        ),
      ).toEqual({ kind: 'blocked', reason: 'platform_held' });
    },
  );

  it('never routes an order the server refused a till payment on as platform-held', () => {
    expect(
      routePaymentEdit(
        { id: 'ord-held', status: 'pending', paymentStatus: 'partially_paid', plugin: 'wolt' },
        [
          {
            id: 'pay-held',
            method: 'card',
            status: 'duplicate_review',
            amount: 12,
            platformHeldSetAside: true,
          },
        ],
      ),
    ).toEqual({ kind: 'blocked', reason: 'platform_held' });
  });

  it('still routes a store order, an own-driver platform order and a hand-tagged Wolt order', () => {
    for (const order of [
      { id: 'ord-store', status: 'pending', paymentStatus: 'pending' },
      {
        id: 'ord-own-driver',
        status: 'pending',
        paymentStatus: 'pending',
        plugin: 'efood',
        ghost_metadata: JSON.stringify({
          food_delivery: { payment_method: 'cash', delivery_provider: 'vendor_delivery' },
        }),
      },
      { id: 'ord-hand-wolt', status: 'pending', paymentStatus: 'pending', plugin: 'pos' },
    ]) {
      expect(routePaymentEdit(order, [])).toEqual({ kind: 'collect-missing' });
    }
  });
});
