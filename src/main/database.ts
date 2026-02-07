import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

// Import the new DatabaseService
import { DatabaseService } from './services/DatabaseService';

// Re-export types from services for backward compatibility
export type { Order, OrderItem } from './services/OrderService';
export type { StaffSession } from './services/StaffService';
export type { SyncQueue } from './services/SyncQueueService';
export type { LocalSettings, POSLocalConfig } from './services/SettingsService';
export type { PaymentTransaction, PaymentReceipt, PaymentRefund } from './services/PaymentService';

// Import types for local use
import type { Order, OrderItem } from './services/OrderService';
import type { StaffSession } from './services/StaffService';
import type { PaymentTransaction, PaymentReceipt, PaymentRefund } from './services/PaymentService';

// Additional types for database operations
interface OrderFilters {
  status?: string;
  fromDate?: string;
  toDate?: string;
  customerId?: string;
  paymentStatus?: string;
  afterTimestamp?: string; // Filter orders created after this ISO timestamp (for Z-Report filtering)
}

interface OrderUpdateData {
  status?: 'pending' | 'preparing' | 'ready' | 'completed';
  payment_status?: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  payment_method?: string;
  payment_transaction_id?: string;
  supabase_id?: string;
  [key: string]: any;
}

interface SyncOperation {
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  data: Record<string, any>;
}

type StaffRole = 'admin' | 'staff';

interface SettingsCategory {
  category: 'terminal' | 'restaurant' | 'payment';
  key: string;
  value: any;
}

interface SyncItemUpdate {
  status: 'success' | 'failed';
  error_message?: string;
}

// Legacy DatabaseManager - deprecated, use DatabaseService instead
export class DatabaseManager {
  private databaseService: DatabaseService;

  constructor() {
    this.databaseService = new DatabaseService();
  }

  get db() {
    return (this.databaseService as any).db;
  }

  // Get the DatabaseService instance for services that need it
  getDatabaseService(): DatabaseService {
    return this.databaseService;
  }

  get orders() {
    return this.databaseService.orders;
  }

  get staff() {
    return this.databaseService.staff;
  }

  get sync() {
    return this.databaseService.sync;
  }

  get settings() {
    return this.databaseService.settings;
  }

  get payments() {
    return this.databaseService.payments;
  }

  get customerCacheService() {
    return this.databaseService.customerCache;
  }

  async initialize(): Promise<void> {
    return this.databaseService.initialize();
  }

  async initializeWithFallback(): Promise<{ success: boolean; usedFallback: boolean; error?: any }> {
    return this.databaseService.initializeWithFallback();
  }

  async close(): Promise<void> {
    return this.databaseService.close();
  }

  async healthCheck() {
    return this.databaseService.healthCheck();
  }

  async getDetailedStats() {
    return this.databaseService.getDetailedStats();
  }

  // Legacy methods for backward compatibility
  async addOrder(orderData: Partial<Order>) {
    return this.databaseService.orders.createOrder(orderData);
  }

  async getOrder(id: string) {
    return this.databaseService.orders.getOrder(id);
  }

  async getOrderBySupabaseId(supabaseId: string) {
    return this.databaseService.orders.getOrderBySupabaseId(supabaseId);
  }

  async getAllOrders(filters?: OrderFilters) {
    return this.databaseService.orders.getAllOrders(filters);
  }

  async updateOrder(id: string, updates: OrderUpdateData) {
    return this.databaseService.orders.updateOrder(id, updates);
  }

  async deleteOrder(id: string) {
    return this.databaseService.orders.deleteOrder(id);
  }

  async updateOrderStatus(id: string, status: Order['status']) {
    return this.databaseService.orders.updateOrderStatus(id, status);
  }

  async getOrdersByStatus(status: Order['status']) {
    return this.databaseService.orders.getOrdersByStatus(status);
  }

  async getTodaysOrders() {
    return this.databaseService.orders.getTodaysOrders();
  }

  async createStaffSession(staffId: string, pin: string, role: StaffRole) {
    return this.databaseService.staff.createSession(staffId, pin, role);
  }

  async validateStaffPin(staffId: string, pin: string) {
    return this.databaseService.staff.validatePin(staffId, pin);
  }

  async getActiveStaffSession(staffId: string) {
    return this.databaseService.staff.getActiveSession(staffId);
  }

  async endStaffSession(sessionId: string) {
    return this.databaseService.staff.endSession(sessionId);
  }

  async isStaffLoggedIn(staffId: string) {
    return this.databaseService.staff.isStaffLoggedIn(staffId);
  }

  async addToSyncQueue(tableName: string, recordId: string, operation: SyncOperation, data: Record<string, any>) {
    // Map high-level operation types to sync_queue allowed values
    const op: 'insert' | 'update' | 'delete' =
      operation.type === 'CREATE' ? 'insert' :
      operation.type === 'UPDATE' ? 'update' :
      'delete';
    return this.databaseService.sync.addToSyncQueue(tableName, recordId, op, data);
  }

  async getPendingSyncItems(limit?: number) {
    return this.databaseService.sync.getPendingSyncItems(limit);
  }

  async markSyncSuccess(syncId: string) {
    return this.databaseService.sync.markSyncSuccess(syncId);
  }

  async markSyncFailed(syncId: string, errorMessage: string) {
    return this.databaseService.sync.markSyncFailed(syncId, errorMessage);
  }

  async getSetting(category: SettingsCategory['category'], key: string, defaultValue?: any) {
    return this.databaseService.settings.getSetting(category, key, defaultValue);
  }

  async setSetting(category: SettingsCategory['category'], key: string, value: any) {
    return this.databaseService.settings.setSetting(category, key, value);
  }

  async getAllSettings(category?: SettingsCategory['category']) {
    return this.databaseService.settings.getAllSettings(category);
  }

  // Missing auth/session methods
  async getActiveSession(staffId?: string) {
    if (staffId) {
      return this.databaseService.staff.getActiveSession(staffId);
    }
    // If no staffId provided, get the first active session (legacy behavior)
    const stmt = (this.databaseService as any).db.prepare(`
      SELECT * FROM staff_sessions
      WHERE is_active = 1
      ORDER BY login_time DESC
      LIMIT 1
    `);
    return stmt.get() as StaffSession | undefined;
  }

  async endSession(sessionId: string) {
    return this.databaseService.staff.endSession(sessionId);
  }

  // Missing order methods
  async getOrders(filters?: OrderFilters) {
    return this.databaseService.orders.getAllOrders(filters);
  }

  async getOrderById(id: string) {
    return this.databaseService.orders.getOrder(id);
  }

  async insertOrder(orderData: Partial<Order>) {
    return this.databaseService.orders.createOrder(orderData);
  }

  async updateOrderPaymentStatus(orderId: string, status: 'pending' | 'completed' | 'processing' | 'failed' | 'refunded', paymentMethod?: string, transactionId?: string) {
    const updateData: OrderUpdateData = { payment_status: status };
    if (paymentMethod) updateData.payment_method = paymentMethod;
    if (transactionId) updateData.payment_transaction_id = transactionId;
    return this.databaseService.orders.updateOrder(orderId, updateData);
  }

  // Missing payment methods
  async insertPaymentTransaction(transactionData: Partial<PaymentTransaction>) {
    return this.databaseService.payments.createTransaction(transactionData);
  }

  async insertPaymentReceipt(receiptData: Partial<PaymentReceipt>) {
    return this.databaseService.payments.createReceipt(receiptData);
  }

  async insertPaymentRefund(refundData: Partial<PaymentRefund>) {
    return this.databaseService.payments.createRefund(refundData);
  }

  async updateReceiptStatus(receiptId: string, printed: boolean = false, emailed: boolean = false) {
    if (printed) {
      return this.databaseService.payments.markReceiptPrinted(receiptId);
    }
    if (emailed) {
      return this.databaseService.payments.markReceiptEmailed(receiptId);
    }
  }

  async getPaymentTransaction(transactionId: string) {
    return this.databaseService.payments.getTransaction(transactionId);
  }

  async getPaymentRefundsByTransactionId(transactionId: string) {
    return this.databaseService.payments.getRefundsByTransaction(transactionId);
  }

  async getPaymentTransactionsByOrderId(orderId: string) {
    return this.databaseService.payments.getTransactionsByOrder(orderId);
  }

  async getPaymentReceiptByNumber(receiptNumber: string) {
    // This method doesn't exist in PaymentService, implement a workaround
    const stmt = (this.databaseService as any).db.prepare('SELECT * FROM payment_receipts WHERE receipt_number = ?');
    return stmt.get(receiptNumber) as PaymentReceipt | undefined;
  }

  // Customer methods for address resolution
  /**
   * Get customer by ID with addresses - used by order-crud-handlers for address fallback resolution
   * Returns customer with both legacy address field and addresses array from customer_addresses table
   */
  async getCustomerById(customerId: string): Promise<any | null> {
    try {
      if (!this.databaseService.customers) {
        console.warn('[DatabaseManager.getCustomerById] CustomerDataService not initialized');
        return null;
      }
      return this.databaseService.customers.getCustomerById(customerId);
    } catch (error) {
      console.error('[DatabaseManager.getCustomerById] Failed to get customer:', error);
      return null;
    }
  }

  // Subcategories cache methods for offline item name resolution
  cacheSubcategory(id: string, name: string, name_en?: string, name_el?: string, category_id?: string): void {
    return this.databaseService.cacheSubcategory(id, name, name_en, name_el, category_id);
  }

  getSubcategoryFromCache(id: string): { id: string; name: string; name_en?: string; name_el?: string; category_id?: string } | null {
    return this.databaseService.getSubcategoryFromCache(id);
  }

  bulkCacheSubcategories(subcategories: Array<{ id: string; name: string; name_en?: string; name_el?: string; category_id?: string }>): void {
    return this.databaseService.bulkCacheSubcategories(subcategories);
  }

  clearOldSubcategoriesCache(olderThanDays: number = 30): number {
    return this.databaseService.clearOldSubcategoriesCache(olderThanDays);
  }

  /**
   * Delete subcategories from cache by IDs (for cache eviction during incremental sync)
   */
  deleteSubcategoriesFromCache(ids: string[]): number {
    return this.databaseService.deleteSubcategoriesFromCache(ids);
  }

  /**
   * Apply branch-specific price/availability overrides to cached subcategories
   */
  applyBranchOverrides(overrides: Array<{
    subcategory_id: string;
    price_override?: number | null;
    availability_override?: boolean | null;
    updated_at: string;
  }>): number {
    return this.databaseService.applyBranchOverrides(overrides);
  }

  getAllCachedSubcategories(): Array<{ id: string; name: string; name_en?: string; name_el?: string; category_id?: string; updated_at: string }> {
    return this.databaseService.getAllCachedSubcategories();
  }

  // Order retry methods for error handling
  async saveOrderForRetry(orderData: any) {
    try {
      // Save order to a retry queue table
      const stmt = (this.databaseService as any).db.prepare(`
        INSERT OR REPLACE INTO order_retry_queue (
          id, order_data, created_at, attempts, last_attempt
        ) VALUES (?, ?, ?, ?, ?)
      `);

      const id = orderData.id || `retry-${Date.now()}`;
      const now = new Date().toISOString();

      stmt.run(id, JSON.stringify(orderData), now, 0, null);
      return { success: true, id };
    } catch (error) {
      console.error('Failed to save order for retry:', error);
      throw error;
    }
  }

  async getPendingOrders() {
    try {
      const stmt = (this.databaseService as any).db.prepare(`
        SELECT * FROM order_retry_queue
        WHERE attempts < 3
        ORDER BY created_at ASC
      `);

      const rows = stmt.all();
      return rows.map((row: any) => ({
        ...row,
        order_data: JSON.parse(row.order_data)
      }));
    } catch (error) {
      console.error('Failed to get pending orders:', error);
      return [];
    }
  }

  // Missing settings methods
  async getLocalSettings() {
    return this.databaseService.settings.getAllSettings();
  }

  async updateLocalSettings(settingType: string, settings: Record<string, any>) {
    // Map setting types to proper categories
    const categoryMap: Record<string, SettingsCategory['category']> = {
      'pos': 'terminal',
      'restaurant': 'restaurant',
      'payment': 'payment',
      'general': 'terminal'
    };

    const category = categoryMap[settingType] || 'terminal';

    for (const [key, value] of Object.entries(settings)) {
      this.databaseService.settings.setSetting(category, key, value);
    }
  }

  async updatePOSLocalConfig(terminalId: string | Record<string, any>, configType?: string, configKey?: string, configValue?: any) {
    if (configKey && configValue !== undefined) {
      // Single config update
      this.databaseService.settings.setSetting('terminal', configKey, configValue);
    } else if (typeof terminalId === 'object') {
      // Legacy: first parameter is config object
      for (const [key, value] of Object.entries(terminalId)) {
        this.databaseService.settings.setSetting('terminal', key, value);
      }
    }
  }

  async updateRestaurantLocalConfig(restaurantId: string | Record<string, any>, configKey?: string, configValue?: any) {
    if (configKey && configValue !== undefined) {
      // Single config update
      this.databaseService.settings.setSetting('restaurant', configKey, configValue);
    } else if (typeof restaurantId === 'object') {
      // Legacy: first parameter is config object
      for (const [key, value] of Object.entries(restaurantId)) {
        this.databaseService.settings.setSetting('restaurant', key, value);
      }
    }
  }

  async updatePaymentLocalConfig(config: Record<string, any> | string, configKey?: string) {
    if (configKey && typeof config === 'string') {
      // Single config update
      this.databaseService.settings.setSetting('payment', configKey, config);
    } else if (typeof config === 'object') {
      // Config object
      for (const [key, value] of Object.entries(config)) {
        this.databaseService.settings.setSetting('payment', key, value);
      }
    }
  }

  // Missing sync methods
  async clearOldSyncQueue() {
    return this.databaseService.sync.cleanupOldSyncItems();
  }

  async getSyncQueue() {
    return this.databaseService.sync.getPendingSyncItems();
  }

  async getSyncStatsForTable(tableName: string) {
    return this.databaseService.sync.getTableSyncStats(tableName);
  }


  async updateSyncQueueItem(syncId: string, success: boolean | SyncItemUpdate, errorMessage?: string) {
    if (typeof success === 'boolean') {
      if (success) {
        return this.databaseService.sync.markSyncSuccess(syncId);
      } else {
        return this.databaseService.sync.markSyncFailed(syncId, errorMessage || 'Unknown error');
      }
    } else {
      // Legacy object format
      const updates = success;
      if (updates.status === 'success') {
        return this.databaseService.sync.markSyncSuccess(syncId);
      } else if (updates.status === 'failed') {
        return this.databaseService.sync.markSyncFailed(syncId, updates.error_message || 'Unknown error');
      }
    }
  }

  async updateOrderSupabaseId(orderId: string, supabaseId: string) {
    return this.databaseService.orders.updateOrder(orderId, { supabase_id: supabaseId });
  }

  // Legacy compatibility method for main.ts
  async executeQuery(query: string, params?: any[]): Promise<any> {
    try {
      const db = (this.databaseService as any).db;
      if (!db) {
        throw new Error('Database not initialized');
      }

      // Determine if it's a SELECT query or a modification query
      const trimmedQuery = query.trim().toLowerCase();

      if (trimmedQuery.startsWith('select')) {
        // For SELECT queries, return all results
        const stmt = db.prepare(query);
        return params ? stmt.all(...params) : stmt.all();
      } else {
        // For INSERT, UPDATE, DELETE queries, return the result info
        const stmt = db.prepare(query);
        return params ? stmt.run(...params) : stmt.run();
      }
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }
}

// Export the new DatabaseService as the primary interface
export { DatabaseService };

// Create a singleton instance for backward compatibility
let databaseInstance: DatabaseManager | null = null;

export function getDatabaseManager(): DatabaseManager {
  if (!databaseInstance) {
    databaseInstance = new DatabaseManager();
  }
  return databaseInstance;
}

export function getDatabaseService(): DatabaseService {
  return new DatabaseService();
}