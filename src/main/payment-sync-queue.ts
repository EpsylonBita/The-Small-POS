// Helper for enqueuing POS payments into the local sync queue.
// Kept separate from Electron-specific code so it can be unit tested
// without requiring the Electron runtime.

interface PaymentSyncQueueDb {
  addToSyncQueue: (
    tableName: string,
    recordId: string,
    operation: { type: 'CREATE' | 'UPDATE' | 'DELETE'; data: Record<string, any> },
    data: Record<string, any>
  ) => Promise<void> | void;
}

interface EnqueuePosPaymentParams {
  db: PaymentSyncQueueDb;
  orderId: string;
  transactionId: string;
  amount: number;
  paymentMethod: 'cash' | 'card';
  externalTransactionId?: string;
  metadata?: any;
}

/**
 * Enqueue a POS payment for durable sync to the Admin Dashboard.
 *
 * This writes an entry into the generic sync_queue table with table_name
 * "pos_payments" and a payload that matches the /api/pos/payments contract
 * on the Admin Dashboard side. The actual sync is handled by SyncService.
 */
export async function enqueuePosPaymentSync(params: EnqueuePosPaymentParams): Promise<void> {
  const { db, orderId, transactionId, amount, paymentMethod, externalTransactionId, metadata } = params;

  try {
    const baseKey = `${orderId}:${transactionId}:${paymentMethod}`;
    const idempotencyKey = externalTransactionId
      ? `${baseKey}:${externalTransactionId}`
      : baseKey;

    const payload = {
      local_order_id: orderId,
      transaction_id: transactionId,
      amount,
      payment_method: paymentMethod,
      external_transaction_id: externalTransactionId || transactionId,
      idempotency_key: idempotencyKey,
      metadata,
    };

    await db.addToSyncQueue(
      'pos_payments',
      transactionId,
      { type: 'CREATE', data: payload },
      payload,
    );
  } catch (error) {
    console.error('Failed to enqueue POS payment for sync', error);
  }
}

