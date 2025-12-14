/**
 * POS Payment Sync Queue Tests
 *
 * These tests focus on the logic that prepares and enqueues
 * pos_payments items into the generic sync_queue, without touching
 * any Electron-specific APIs.
 */

import { enqueuePosPaymentSync } from '../main/payment-sync-queue';

interface RecordedSyncCall {
  tableName: string;
  recordId: string;
  operation: { type: string; data: any };
  data: any;
}

describe('enqueuePosPaymentSync', () => {
  test('enqueues correct payload when externalTransactionId is provided', async () => {
    const calls: RecordedSyncCall[] = [];
    const db = {
      addToSyncQueue: (
        tableName: string,
        recordId: string,
        operation: { type: string; data: any },
        data: any,
      ) => {
        calls.push({ tableName, recordId, operation, data });
      },
    };

    await enqueuePosPaymentSync({
      db,
      orderId: 'order-1',
      transactionId: 'tx-1',
      amount: 12.5,
      paymentMethod: 'card',
      externalTransactionId: 'terminal-abc-123',
      metadata: { source: 'test' },
    });

    expect(calls.length).toBe(1);
    const call = calls[0];

    expect(call.tableName).toBe('pos_payments');
    expect(call.recordId).toBe('tx-1');
    expect(call.operation.type).toBe('CREATE');
    expect(call.operation.data).toEqual(call.data);

    expect(call.data).toMatchObject({
      local_order_id: 'order-1',
      transaction_id: 'tx-1',
      amount: 12.5,
      payment_method: 'card',
      external_transaction_id: 'terminal-abc-123',
      metadata: { source: 'test' },
    });
    expect(call.data.idempotency_key).toContain('order-1:tx-1:card');
  });

  test('falls back to transactionId when externalTransactionId is missing', async () => {
    const calls: RecordedSyncCall[] = [];
    const db = {
      addToSyncQueue: (
        tableName: string,
        recordId: string,
        operation: { type: string; data: any },
        data: any,
      ) => {
        calls.push({ tableName, recordId, operation, data });
      },
    };

    await enqueuePosPaymentSync({
      db,
      orderId: 'order-2',
      transactionId: 'tx-2',
      amount: 5,
      paymentMethod: 'cash',
    });

    const call = calls[0];
    expect(call.data.external_transaction_id).toBe('tx-2');
    expect(call.data.idempotency_key).toContain('order-2:tx-2:cash');
  });

  test('does not throw if db.addToSyncQueue throws', async () => {
    const db = {
      addToSyncQueue: () => {
        throw new Error('DB is unavailable');
      },
    };

    await expect(
      enqueuePosPaymentSync({
        db,
        orderId: 'order-3',
        transactionId: 'tx-3',
        amount: 9,
        paymentMethod: 'cash',
      }),
    ).resolves.toBeUndefined();
  });
});

