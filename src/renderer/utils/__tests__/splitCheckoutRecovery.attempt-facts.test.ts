import { describe, expect, it, vi } from 'vitest';

import { reconcileOutstandingPaymentAttempt } from '../splitCheckoutRecovery';

const GENERATION = 'a'.repeat(64);

const ledgerBridge = (snapshot: Record<string, unknown> = {}) => ({
  payments: {
    getSettlementSnapshot: vi.fn(async (orderId: string) => ({
      success: true as const,
      orderId,
      orderTotal: 20,
      netPaid: 0,
      outstandingAmount: 20,
      completedPayments: [] as any[],
      generation: GENERATION,
      ...snapshot,
    })),
  },
});

describe('reconcileOutstandingPaymentAttempt attempt facts', () => {
  it('keeps approved and reconciliation flags even when the ledger still reads unpaid', async () => {
    const bridge = ledgerBridge();
    const result = await reconcileOutstandingPaymentAttempt({
      recordPayment: async () => ({
        success: false,
        paymentApproved: true,
        paymentPersisted: false,
        requiresReconciliation: true,
        errorCode: 'PAYMENT_RECONCILIATION_REQUIRED',
        fiscalCheckout: { status: 'pending' },
      }),
      bridge,
      orderId: 'order-facts-1',
      fallbackOrderTotal: 20,
    });

    expect(result.kind).toBe('unpaid');
    expect(result.recordPaymentFailed).toBe(true);
    expect(result.attempt).toEqual({
      dispatched: true,
      replyLost: false,
      success: false,
      paymentApproved: true,
      paymentPersisted: false,
      requiresReconciliation: true,
      paymentId: null,
      code: 'PAYMENT_RECONCILIATION_REQUIRED',
      fiscalCheckout: { status: 'pending' },
    });
  });

  it('marks a thrown write as a lost reply even when the ledger reads settled', async () => {
    const bridge = ledgerBridge({
      netPaid: 20,
      outstandingAmount: 0,
      completedPayments: [{ id: 'pay-other', status: 'completed', amount: 20 }],
    });
    const result = await reconcileOutstandingPaymentAttempt({
      recordPayment: async () => {
        throw new Error('transport closed');
      },
      bridge,
      orderId: 'order-facts-2',
      fallbackOrderTotal: 20,
    });

    expect(result.kind).toBe('settled');
    expect(result.recordPaymentFailed).toBe(true);
    expect(result.attempt).toMatchObject({
      dispatched: true,
      replyLost: true,
      success: null,
      paymentApproved: null,
      paymentPersisted: null,
      paymentId: null,
    });
  });

  it('reads a nested payment id and drops a malformed reply code', async () => {
    const result = await reconcileOutstandingPaymentAttempt({
      recordPayment: async () => ({ success: true, data: { paymentId: ' pay-1 ' }, code: 'not a code' }),
      bridge: ledgerBridge(),
      orderId: 'order-facts-3',
      fallbackOrderTotal: 20,
    });

    expect(result.attempt.paymentId).toBe('pay-1');
    expect(result.attempt.success).toBe(true);
    expect(result.attempt.code).toBeNull();
  });

  it('never writes on a snapshot-only probe and reports nothing dispatched', async () => {
    const recordPayment = vi.fn(async () => ({ success: true, paymentId: 'pay-never' }));
    const result = await reconcileOutstandingPaymentAttempt({
      recordPayment,
      snapshotOnly: true,
      bridge: ledgerBridge(),
      orderId: 'order-facts-4',
      fallbackOrderTotal: 20,
    });

    expect(recordPayment).not.toHaveBeenCalled();
    expect(result.recordPaymentFailed).toBe(false);
    expect(result.attempt.dispatched).toBe(false);
    expect(result.attempt.replyLost).toBe(false);
  });

  it('stays unknown on an unreadable ledger and still carries the write facts', async () => {
    const result = await reconcileOutstandingPaymentAttempt({
      recordPayment: async () => ({ success: true, paymentId: 'pay-2' }),
      bridge: ledgerBridge({ generation: 'not-a-generation' }),
      orderId: 'order-facts-5',
      fallbackOrderTotal: 20,
    });

    expect(result.kind).toBe('unknown');
    expect(result.attempt).toMatchObject({ dispatched: true, success: true, paymentId: 'pay-2' });
    expect('settlement' in result).toBe(false);
  });
});
