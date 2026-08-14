import { describe, expect, it, vi } from 'vitest';

import { loadPaymentEditRoute, routePaymentEdit } from '../paymentEditRouting';

describe('routePaymentEdit', () => {
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
