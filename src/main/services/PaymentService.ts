import Database from 'better-sqlite3';
import { BaseService } from './BaseService';

// Database row interfaces
interface PaymentTransactionRow {
  id: string;
  order_id: string;
  amount: number;
  payment_method: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  gateway_transaction_id?: string;
  gateway_response?: string;
  processed_at: string;
  refunded_amount: number;
  metadata?: string;
  created_at: string;
  updated_at: string;
}

interface PaymentReceiptRow {
  id: string;
  transaction_id: string;
  receipt_number: string;
  order_details: string;
  subtotal: number;
  tax: number;
  delivery_fee: number;
  total_amount: number;
  payment_method: string;
  cash_received?: number;
  change_given?: number;
  printed: boolean;
  emailed: boolean;
  email_address?: string;
  created_at: string;
}

interface PaymentRefundRow {
  id: string;
  transaction_id: string;
  amount: number;
  reason?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  gateway_refund_id?: string;
  processed_at: string;
  created_at: string;
}

interface DailySalesRow {
  net_sales: number;
  gross_sales: number;
  tax_amount: number;
  total_refunds: number;
  transaction_count: number;
  total_amount: number;
  refund_amount: number;
  refund_count: number;
}

interface PaymentFilter {
  fromDate?: string;
  toDate?: string;
  paymentMethod?: string;
  status?: string;
}

export interface PaymentTransaction {
  id: string;
  order_id: string;
  amount: number;
  payment_method: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  gateway_transaction_id?: string;
  gateway_response?: string;
  processed_at: string;
  refunded_amount: number;
  metadata?: string; // JSON string
  created_at: string;
  updated_at: string;
}

export interface PaymentReceipt {
  id: string;
  transaction_id: string;
  receipt_number: string;
  order_details: string; // JSON string
  subtotal: number;
  tax: number;
  delivery_fee: number;
  total_amount: number;
  payment_method: string;
  cash_received?: number;
  change_given?: number;
  printed: boolean;
  emailed: boolean;
  email_address?: string;
  created_at: string;
}

export interface PaymentRefund {
  id: string;
  transaction_id: string;
  amount: number;
  reason?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  gateway_refund_id?: string;
  processed_at: string;
  created_at: string;
}

export class PaymentService extends BaseService {
  constructor(database: Database.Database) {
    super(database);
  }

  // Payment Transaction Management
  createTransaction(transactionData: Partial<PaymentTransaction>): PaymentTransaction {
    return this.executeTransaction(() => {
      this.validateRequired(transactionData, ['order_id', 'amount', 'payment_method']);

      const transaction: PaymentTransaction = {
        id: this.generateId(),
        order_id: transactionData.order_id!,
        amount: transactionData.amount!,
        payment_method: transactionData.payment_method!,
        status: transactionData.status || 'pending',
        gateway_transaction_id: transactionData.gateway_transaction_id,
        gateway_response: transactionData.gateway_response,
        processed_at: this.getCurrentTimestamp(),
        refunded_amount: 0,
        metadata: transactionData.metadata,
        created_at: this.getCurrentTimestamp(),
        updated_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT INTO payment_transactions (
          id, order_id, amount, payment_method, status,
          gateway_transaction_id, gateway_response, processed_at,
          refunded_amount, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        transaction.id, transaction.order_id, transaction.amount,
        transaction.payment_method, transaction.status, transaction.gateway_transaction_id,
        transaction.gateway_response, transaction.processed_at, transaction.refunded_amount,
        transaction.metadata, transaction.created_at, transaction.updated_at
      );

      return transaction;
    });
  }

  getTransaction(id: string): PaymentTransaction | null {
    const stmt = this.db.prepare('SELECT * FROM payment_transactions WHERE id = ?');
    const row = stmt.get(id) as PaymentTransactionRow | undefined;
    
    if (!row) return null;
    
    return this.mapRowToTransaction(row);
  }

  getTransactionsByOrder(orderId: string): PaymentTransaction[] {
    const stmt = this.db.prepare('SELECT * FROM payment_transactions WHERE order_id = ?');
    const rows = stmt.all(orderId) as PaymentTransactionRow[];
    
    return rows.map(row => this.mapRowToTransaction(row));
  }

  updateTransactionStatus(id: string, status: PaymentTransaction['status'], gatewayResponse?: string): boolean {
    return this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE payment_transactions SET 
          status = ?, 
          gateway_response = ?,
          updated_at = ?
        WHERE id = ?
      `);
      
      const result = stmt.run(status, gatewayResponse, this.getCurrentTimestamp(), id);
      return result.changes > 0;
    });
  }

  // Receipt Management
  createReceipt(receiptData: Partial<PaymentReceipt>): PaymentReceipt {
    return this.executeTransaction(() => {
      this.validateRequired(receiptData, [
        'transaction_id', 'order_details', 'subtotal', 
        'tax', 'total_amount', 'payment_method'
      ]);

      const receipt: PaymentReceipt = {
        id: this.generateId(),
        transaction_id: receiptData.transaction_id!,
        receipt_number: this.generateReceiptNumber(),
        order_details: receiptData.order_details!,
        subtotal: receiptData.subtotal!,
        tax: receiptData.tax!,
        delivery_fee: receiptData.delivery_fee || 0,
        total_amount: receiptData.total_amount!,
        payment_method: receiptData.payment_method!,
        cash_received: receiptData.cash_received,
        change_given: receiptData.change_given,
        printed: false,
        emailed: false,
        email_address: receiptData.email_address,
        created_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT INTO payment_receipts (
          id, transaction_id, receipt_number, order_details,
          subtotal, tax, delivery_fee, total_amount, payment_method,
          cash_received, change_given, printed, emailed,
          email_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        receipt.id, receipt.transaction_id, receipt.receipt_number,
        receipt.order_details, receipt.subtotal, receipt.tax,
        receipt.delivery_fee, receipt.total_amount, receipt.payment_method,
        receipt.cash_received, receipt.change_given, receipt.printed,
        receipt.emailed, receipt.email_address, receipt.created_at
      );

      return receipt;
    });
  }

  getReceipt(id: string): PaymentReceipt | null {
    const stmt = this.db.prepare('SELECT * FROM payment_receipts WHERE id = ?');
    const row = stmt.get(id) as PaymentReceiptRow | undefined;
    
    if (!row) return null;
    
    return this.mapRowToReceipt(row);
  }

  getReceiptByTransaction(transactionId: string): PaymentReceipt | null {
    const stmt = this.db.prepare('SELECT * FROM payment_receipts WHERE transaction_id = ?');
    const row = stmt.get(transactionId) as PaymentReceiptRow | undefined;
    
    if (!row) return null;
    
    return this.mapRowToReceipt(row);
  }

  markReceiptPrinted(id: string): boolean {
    const stmt = this.db.prepare('UPDATE payment_receipts SET printed = 1 WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  markReceiptEmailed(id: string): boolean {
    const stmt = this.db.prepare('UPDATE payment_receipts SET emailed = 1 WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Refund Management
  createRefund(refundData: Partial<PaymentRefund>): PaymentRefund {
    return this.executeTransaction(() => {
      this.validateRequired(refundData, ['transaction_id', 'amount']);

      const refund: PaymentRefund = {
        id: this.generateId(),
        transaction_id: refundData.transaction_id!,
        amount: refundData.amount!,
        reason: refundData.reason,
        status: refundData.status || 'pending',
        gateway_refund_id: refundData.gateway_refund_id,
        processed_at: this.getCurrentTimestamp(),
        created_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT INTO payment_refunds (
          id, transaction_id, amount, reason, status,
          gateway_refund_id, processed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        refund.id, refund.transaction_id, refund.amount,
        refund.reason, refund.status, refund.gateway_refund_id,
        refund.processed_at, refund.created_at
      );

      // Update the original transaction's refunded amount
      this.updateTransactionRefundAmount(refund.transaction_id, refund.amount);

      return refund;
    });
  }

  getRefund(id: string): PaymentRefund | null {
    const stmt = this.db.prepare('SELECT * FROM payment_refunds WHERE id = ?');
    const row = stmt.get(id) as PaymentRefundRow | undefined;
    
    if (!row) return null;
    
    return this.mapRowToRefund(row);
  }

  getRefundsByTransaction(transactionId: string): PaymentRefund[] {
    const stmt = this.db.prepare('SELECT * FROM payment_refunds WHERE transaction_id = ?');
    const rows = stmt.all(transactionId) as PaymentRefundRow[];
    
    return rows.map(row => this.mapRowToRefund(row));
  }

  updateRefundStatus(id: string, status: PaymentRefund['status']): boolean {
    const stmt = this.db.prepare('UPDATE payment_refunds SET status = ? WHERE id = ?');
    const result = stmt.run(status, id);
    return result.changes > 0;
  }

  private updateTransactionRefundAmount(transactionId: string, refundAmount: number): void {
    const stmt = this.db.prepare(`
      UPDATE payment_transactions SET 
        refunded_amount = refunded_amount + ?,
        updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(refundAmount, this.getCurrentTimestamp(), transactionId);
  }

  // Reporting and Analytics
  getDailySales(date: string): {
    total_amount: number;
    transaction_count: number;
    refund_amount: number;
    refund_count: number;
  } {
    const salesStmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_amount,
        COUNT(*) as transaction_count
      FROM payment_transactions 
      WHERE date(created_at) = ? AND status = 'completed'
    `);

    const refundStmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(amount), 0) as refund_amount,
        COUNT(*) as refund_count
      FROM payment_refunds 
      WHERE date(created_at) = ? AND status = 'completed'
    `);

    const sales = salesStmt.get(date) as { total_amount: number; transaction_count: number } | undefined;
    const refunds = refundStmt.get(date) as { refund_amount: number; refund_count: number } | undefined;

    return {
      total_amount: sales?.total_amount || 0,
      transaction_count: sales?.transaction_count || 0,
      refund_amount: refunds?.refund_amount || 0,
      refund_count: refunds?.refund_count || 0
    };
  }

  getPaymentMethodStats(date?: string): Array<{
    payment_method: string;
    total_amount: number;
    transaction_count: number;
  }> {
    let query = `
      SELECT 
        payment_method,
        SUM(amount) as total_amount,
        COUNT(*) as transaction_count
      FROM payment_transactions 
      WHERE status = 'completed'
    `;
    
    const params: (string | number)[] = [];
    
    if (date) {
      query += ' AND date(created_at) = ?';
      params.push(date);
    }
    
    query += ' GROUP BY payment_method ORDER BY total_amount DESC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Array<{
      payment_method: string;
      total_amount: number;
      transaction_count: number;
    }>;
  }

  private generateReceiptNumber(): string {
    const today = new Date();
    const prefix = today.toISOString().slice(0, 10).replace(/-/g, '');
    const timestamp = Date.now().toString().slice(-6);
    return `RCP-${prefix}-${timestamp}`;
  }

  private mapRowToTransaction(row: PaymentTransactionRow): PaymentTransaction {
    return {
      id: row.id,
      order_id: row.order_id,
      amount: row.amount,
      payment_method: row.payment_method,
      status: row.status,
      gateway_transaction_id: row.gateway_transaction_id,
      gateway_response: row.gateway_response,
      processed_at: row.processed_at,
      refunded_amount: row.refunded_amount,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapRowToReceipt(row: PaymentReceiptRow): PaymentReceipt {
    return {
      id: row.id,
      transaction_id: row.transaction_id,
      receipt_number: row.receipt_number,
      order_details: row.order_details,
      subtotal: row.subtotal,
      tax: row.tax,
      delivery_fee: row.delivery_fee,
      total_amount: row.total_amount,
      payment_method: row.payment_method,
      cash_received: row.cash_received,
      change_given: row.change_given,
      printed: Boolean(row.printed),
      emailed: Boolean(row.emailed),
      email_address: row.email_address,
      created_at: row.created_at
    };
  }

  private mapRowToRefund(row: PaymentRefundRow): PaymentRefund {
    return {
      id: row.id,
      transaction_id: row.transaction_id,
      amount: row.amount,
      reason: row.reason,
      status: row.status,
      gateway_refund_id: row.gateway_refund_id,
      processed_at: row.processed_at,
      created_at: row.created_at
    };
  }
}