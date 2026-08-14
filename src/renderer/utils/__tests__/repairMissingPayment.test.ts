import { describe, expect, it, vi } from 'vitest';

import {
  MissingPaymentRepairError,
  repairMissingPayment,
} from '../repairMissingPayment';

const SETTLEMENT_GENERATION = 'a'.repeat(64);

describe('repairMissingPayment', () => {
  it('collects the authoritative outstanding balance through the normal payment pipeline', async () => {
    const recordPayment = vi.fn().mockResolvedValue({
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.5,
      settlement: {
        orderTotal: 18.5,
        netPaid: 18.5,
        outstandingAmount: 0,
        completedPayments: [{ id: 'payment-1', status: 'completed' }],
      },
    });

    const result = await repairMissingPayment({ recordPayment }, {
      orderId: 'order-1',
      method: 'card',
      amount: 17,
      transactionRef: 'renderer-placeholder',
      expectedSettlementGeneration: SETTLEMENT_GENERATION,
    });

    expect(recordPayment).toHaveBeenCalledOnce();
    expect(recordPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      method: 'card',
      amount: 17,
      transactionRef: 'renderer-placeholder',
      expectedSettlementGeneration: SETTLEMENT_GENERATION,
      collectOutstandingBalance: true,
    });
    expect(result).toEqual({
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.5,
      settlement: {
        orderTotal: 18.5,
        netPaid: 18.5,
        outstandingAmount: 0,
        completedPayments: [{ id: 'payment-1', status: 'completed' }],
      },
    });
  });

  it('passes cash tender evidence while native recomputes the authoritative change', async () => {
    const recordPayment = vi.fn().mockResolvedValue({
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'cash',
      amount: 18.5,
      settlement: {
        orderTotal: 18.5,
        netPaid: 18.5,
        outstandingAmount: 0,
        completedPayments: [{ id: 'payment-1', status: 'completed' }],
      },
    });

    await repairMissingPayment({ recordPayment }, {
      orderId: 'order-1',
      method: 'cash',
      amount: 18.5,
      cashReceived: 20,
      changeGiven: 1.5,
      expectedSettlementGeneration: SETTLEMENT_GENERATION,
    });

    expect(recordPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      method: 'cash',
      amount: 18.5,
      cashReceived: 20,
      changeGiven: 1.5,
      expectedSettlementGeneration: SETTLEMENT_GENERATION,
      collectOutstandingBalance: true,
    });
  });

  it('rejects cash collection locally when the tender is below the displayed amount', async () => {
    const recordPayment = vi.fn();

    await expect(
      repairMissingPayment({ recordPayment }, {
        orderId: 'order-1',
        method: 'cash',
        amount: 18.5,
        cashReceived: 10,
        expectedSettlementGeneration: SETTLEMENT_GENERATION,
      }),
    ).rejects.toBeInstanceOf(MissingPaymentRepairError);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('rejects a success response while an exact one-cent balance remains', async () => {
    const recordPayment = vi.fn().mockResolvedValue({
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.49,
      settlement: {
        orderTotal: 18.5,
        netPaid: 18.49,
        outstandingAmount: 0.01,
        completedPayments: [{ id: 'payment-1', status: 'completed' }],
      },
    });

    await expect(
      repairMissingPayment({ recordPayment }, {
        orderId: 'order-1',
        method: 'card',
        amount: 18.5,
        expectedSettlementGeneration: SETTLEMENT_GENERATION,
      }),
    ).rejects.toBeInstanceOf(MissingPaymentRepairError);
  });

  it.each([
    {
      success: true,
      orderId: 'different-order',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.5,
      settlement: { orderTotal: 18.5, netPaid: 18.5, outstandingAmount: 0, completedPayments: [] },
    },
    {
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'cash',
      amount: 18.5,
      settlement: { orderTotal: 18.5, netPaid: 18.5, outstandingAmount: 0, completedPayments: [] },
    },
    {
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.5,
      settlement: { orderTotal: 20, netPaid: 18.5, outstandingAmount: 1.5, completedPayments: [] },
    },
    {
      success: true,
      orderId: 'order-1',
      paymentId: 'payment-1',
      method: 'card',
      amount: 18.5,
      settlement: { orderTotal: 18.5, netPaid: 18.5, outstandingAmount: 0, completedPayments: [] },
    },
  ])('rejects mismatched, still-outstanding, or ledger-less success responses', async (response) => {
    await expect(
      repairMissingPayment({ recordPayment: vi.fn().mockResolvedValue(response) }, {
        orderId: 'order-1', method: 'card', amount: 18.5,
        expectedSettlementGeneration: SETTLEMENT_GENERATION,
      }),
    ).rejects.toBeInstanceOf(MissingPaymentRepairError);
  });

  it.each([
    { success: false, error: 'Bearer customer@example.com' },
    { success: true, orderId: 'order-1', method: 'cash' },
    null,
  ])('fails closed for rejected or malformed collection results', async (response) => {
    const recordPayment = vi.fn().mockResolvedValue(response);

    await expect(
      repairMissingPayment({ recordPayment }, {
        orderId: 'order-1',
        method: 'cash',
        amount: 18.5,
        expectedSettlementGeneration: SETTLEMENT_GENERATION,
      }),
    ).rejects.toBeInstanceOf(MissingPaymentRepairError);
  });

  it('does not expose a thrown backend message through its public error', async () => {
    const recordPayment = vi
      .fn()
      .mockRejectedValue(new Error('HTTP 500 Bearer customer@example.com'));

    await expect(
      repairMissingPayment({ recordPayment }, {
        orderId: 'order-1',
        method: 'cash',
        amount: 18.5,
        expectedSettlementGeneration: SETTLEMENT_GENERATION,
      }),
    ).rejects.toMatchObject({
      name: 'MissingPaymentRepairError',
      message: 'PAYMENT_REPAIR_FAILED',
    });
  });
});
