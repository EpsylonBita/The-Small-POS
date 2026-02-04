/**
 * Transaction Log Service
 *
 * Manages persistence and retrieval of ECR transaction records.
 *
 * @module ecr/services/TransactionLogService
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  ECRTransaction,
  ECRTransactionRequest,
  ECRTransactionResponse,
  SerializedECRTransaction,
} from '../../../../../shared/types/ecr';
import {
  ECRTransactionStatus,
  ECRTransactionType,
  deserializeECRTransaction,
} from '../../../../../shared/types/ecr';

/**
 * Transaction query filters
 */
export interface TransactionFilters {
  deviceId?: string;
  orderId?: string;
  status?: ECRTransactionStatus;
  transactionType?: ECRTransactionType;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Transaction statistics
 */
export interface TransactionStats {
  totalCount: number;
  approvedCount: number;
  declinedCount: number;
  totalAmount: number;
  averageAmount: number;
}

/**
 * TransactionLogService - Manages ECR transaction history
 */
export class TransactionLogService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a new transaction record
   */
  create(
    request: ECRTransactionRequest,
    deviceId: string
  ): ECRTransaction {
    const transaction: ECRTransaction = {
      id: request.transactionId || uuidv4(),
      deviceId,
      orderId: request.orderId,
      transactionType: request.type as ECRTransactionType,
      amount: request.amount,
      tipAmount: request.tipAmount,
      currency: request.currency || 'EUR',
      status: ECRTransactionStatus.PENDING,
      startedAt: new Date(),
      createdAt: new Date(),
    };

    this.db.prepare(`
      INSERT INTO ecr_transactions (
        id, device_id, order_id, transaction_type, amount, tip_amount,
        currency, status, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transaction.id,
      transaction.deviceId,
      transaction.orderId ?? null,
      transaction.transactionType,
      transaction.amount,
      transaction.tipAmount ?? null,
      transaction.currency,
      transaction.status,
      transaction.startedAt.toISOString(),
      transaction.createdAt.toISOString()
    );

    return transaction;
  }

  /**
   * Update transaction with response
   */
  updateWithResponse(
    transactionId: string,
    response: ECRTransactionResponse
  ): ECRTransaction | null {
    const existing = this.getById(transactionId);
    if (!existing) return null;

    this.db.prepare(`
      UPDATE ecr_transactions SET
        status = ?,
        authorization_code = ?,
        terminal_reference = ?,
        card_type = ?,
        card_last_four = ?,
        entry_method = ?,
        cardholder_name = ?,
        customer_receipt_data = ?,
        merchant_receipt_data = ?,
        error_message = ?,
        error_code = ?,
        raw_response = ?,
        completed_at = ?
      WHERE id = ?
    `).run(
      response.status,
      response.authorizationCode ?? null,
      response.terminalReference ?? null,
      response.cardType ?? null,
      response.cardLastFour ?? null,
      response.entryMethod ?? null,
      response.cardholderName ?? null,
      response.customerReceiptData ? JSON.stringify(response.customerReceiptData) : null,
      response.merchantReceiptData ? JSON.stringify(response.merchantReceiptData) : null,
      response.errorMessage ?? null,
      response.errorCode ?? null,
      response.rawResponse ? JSON.stringify(response.rawResponse) : null,
      response.completedAt?.toISOString() ?? new Date().toISOString(),
      transactionId
    );

    return this.getById(transactionId);
  }

  /**
   * Update transaction status
   */
  updateStatus(transactionId: string, status: ECRTransactionStatus): void {
    this.db.prepare(`
      UPDATE ecr_transactions SET status = ? WHERE id = ?
    `).run(status, transactionId);
  }

  /**
   * Get transaction by ID
   */
  getById(id: string): ECRTransaction | null {
    const row = this.db.prepare(`
      SELECT * FROM ecr_transactions WHERE id = ?
    `).get(id) as SerializedECRTransaction | undefined;

    if (!row) return null;

    return deserializeECRTransaction(row);
  }

  /**
   * Get transaction by order ID
   */
  getByOrderId(orderId: string): ECRTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM ecr_transactions
      WHERE order_id = ?
      ORDER BY created_at DESC
    `).all(orderId) as SerializedECRTransaction[];

    return rows.map(deserializeECRTransaction);
  }

  /**
   * Get approved transaction for order
   */
  getApprovedForOrder(orderId: string): ECRTransaction | null {
    const row = this.db.prepare(`
      SELECT * FROM ecr_transactions
      WHERE order_id = ? AND status = 'approved'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(orderId) as SerializedECRTransaction | undefined;

    if (!row) return null;

    return deserializeECRTransaction(row);
  }

  /**
   * Query transactions with filters
   */
  query(filters: TransactionFilters = {}): ECRTransaction[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }

    if (filters.orderId) {
      conditions.push('order_id = ?');
      params.push(filters.orderId);
    }

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }

    if (filters.transactionType) {
      conditions.push('transaction_type = ?');
      params.push(filters.transactionType);
    }

    if (filters.startDate) {
      conditions.push('started_at >= ?');
      params.push(filters.startDate.toISOString());
    }

    if (filters.endDate) {
      conditions.push('started_at <= ?');
      params.push(filters.endDate.toISOString());
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM ecr_transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SerializedECRTransaction[];

    return rows.map(deserializeECRTransaction);
  }

  /**
   * Get recent transactions
   */
  getRecent(limit: number = 20): ECRTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM ecr_transactions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as SerializedECRTransaction[];

    return rows.map(deserializeECRTransaction);
  }

  /**
   * Get transactions for a specific device
   */
  getByDevice(deviceId: string, limit: number = 50): ECRTransaction[] {
    const rows = this.db.prepare(`
      SELECT * FROM ecr_transactions
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(deviceId, limit) as SerializedECRTransaction[];

    return rows.map(deserializeECRTransaction);
  }

  /**
   * Get transaction statistics
   */
  getStats(filters: Omit<TransactionFilters, 'limit' | 'offset'> = {}): TransactionStats {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }

    if (filters.startDate) {
      conditions.push('started_at >= ?');
      params.push(filters.startDate.toISOString());
    }

    if (filters.endDate) {
      conditions.push('started_at <= ?');
      params.push(filters.endDate.toISOString());
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_count,
        SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) as declined_count,
        SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) as total_amount,
        AVG(CASE WHEN status = 'approved' THEN amount ELSE NULL END) as average_amount
      FROM ecr_transactions
      ${whereClause}
    `).get(...params) as {
      total_count: number;
      approved_count: number;
      declined_count: number;
      total_amount: number;
      average_amount: number | null;
    };

    return {
      totalCount: row.total_count,
      approvedCount: row.approved_count,
      declinedCount: row.declined_count,
      totalAmount: row.total_amount ?? 0,
      averageAmount: row.average_amount ?? 0,
    };
  }

  /**
   * Get daily totals for a date range
   */
  getDailyTotals(
    startDate: Date,
    endDate: Date,
    deviceId?: string
  ): Array<{ date: string; count: number; amount: number }> {
    const conditions: string[] = [
      "status = 'approved'",
      "started_at >= ?",
      "started_at <= ?",
    ];
    const params: unknown[] = [startDate.toISOString(), endDate.toISOString()];

    if (deviceId) {
      conditions.push('device_id = ?');
      params.push(deviceId);
    }

    const rows = this.db.prepare(`
      SELECT
        date(started_at) as date,
        COUNT(*) as count,
        SUM(amount) as amount
      FROM ecr_transactions
      WHERE ${conditions.join(' AND ')}
      GROUP BY date(started_at)
      ORDER BY date
    `).all(...params) as Array<{ date: string; count: number; amount: number }>;

    return rows;
  }

  /**
   * Clean up old transactions
   */
  cleanup(olderThanDays: number = 90): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = this.db.prepare(`
      DELETE FROM ecr_transactions
      WHERE created_at < ?
    `).run(cutoff.toISOString());

    return result.changes;
  }
}
