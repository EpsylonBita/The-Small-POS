/**
 * SyncService - Synchronization with Supabase and inter-terminal communication
 *
 * Migrated from sync-service.ts to services directory for consistent organization.
 */

import { DatabaseManager, SyncQueue } from '../database';
import { BrowserWindow } from 'electron';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../shared/supabase-config';
import { CustomerService } from './CustomerService';
import { SettingsService } from './SettingsService';
import { ORDER_STATUSES, mapStatusForPOS, isValidOrderStatus, mapStatusForSupabase, coerceIncomingStatus } from '../../shared/types/order-status';

// Sub-services
import { NetworkMonitor } from './sync/NetworkMonitor';
import { OrderSyncService } from './sync/OrderSyncService';
import { InventorySyncService } from './sync/InventorySyncService';
import { ConfigurationSyncService } from './sync/ConfigurationSyncService';
import { InterTerminalCommunicationService } from './sync/InterTerminalCommunicationService';
import { FeatureService } from './FeatureService';

export interface SyncStatus {
  isOnline: boolean;
  lastSync: string | null;
  pendingItems: number;
  syncInProgress: boolean;
  error: string | null;
  terminalHealth: number;
  settingsVersion: number;
  menuVersion: number;
  pendingPaymentItems: number;
  failedPaymentItems: number;
}

export interface EnhancedSyncRequest {
  terminal_id: string;
  sync_types: ('staff_permissions' | 'hardware_config' | 'menu_availability' | 'restaurant_settings')[];
  force_sync?: boolean;
  version_check?: boolean;
}

export interface TerminalHeartbeatData {
  terminal_id: string;
  name: string;
  location: string;
  status: 'online' | 'offline' | 'syncing' | 'error' | 'maintenance';
  version: string;
  uptime: number;
  memory_usage: number;
  cpu_usage: number;
  disk_usage: number;
  network_interface: string;
  ip_address: string;
  mac_address: string;
  os_platform: string;
  os_release: string;
  app_version: string;
  last_heartbeat: string;
  active_staff_id?: string;
  shift_id?: string;
  pending_orders: number;
  completed_orders_today: number;
  total_sales_today: number;
  cash_drawer_balance: number;
  printer_status: 'ok' | 'error' | 'warning' | 'offline';
  scanner_status: 'ok' | 'error' | 'warning' | 'offline';
  card_reader_status: 'ok' | 'error' | 'warning' | 'offline';
  latency_ms: number;
  performance_metrics: {
    avg_response_time_ms: number;
    orders_per_hour: number;
    error_rate: number;
  };
  avg_response_time_ms: number;
  orders_per_hour: number;
  error_rate: number;
}

export class SyncService {
  private supabase: SupabaseClient;
  private dbManager: DatabaseManager;
  private customerService: CustomerService | null = null;
  private settingsService: SettingsService | null = null;
  private mainWindow: BrowserWindow | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private isOnline: boolean = true;
  private syncInProgress: boolean = false;
  private lastSync: string | null = null;
  private terminalId: string;
  private branchId: string | null = null;

  // Sub-services
  private networkMonitor: NetworkMonitor;
  private orderSyncService: OrderSyncService;
  private inventorySyncService: InventorySyncService;
  private configurationSyncService: ConfigurationSyncService;
  private interTerminalService: InterTerminalCommunicationService;
  private featureService: FeatureService;

  // Metrics
  private networkMetrics = {
    latency_ms: 0,
    packet_loss: 0,
    bandwidth_mbps: 0,
    connection_quality: 'unknown'
  };

  constructor(
    dbManager: DatabaseManager,
    customerService?: CustomerService,
    settingsService?: SettingsService,
    terminalId?: string,
    featureService?: FeatureService
  ) {
    this.dbManager = dbManager;
    this.customerService = customerService || null;
    this.settingsService = settingsService || null;
    this.featureService = featureService || new FeatureService((dbManager as any).db || (dbManager.getDatabaseService() as any).db);
    if (!featureService && settingsService) {
      this.featureService.setSettingsService(settingsService);
    }

    this.supabase = getSupabaseClient();

    // Get terminal ID from settings or env or default
    // Persisted settings (from connection string) take priority over env vars
    const dbSvc = this.dbManager.getDatabaseService();
    const persistedTerminalId = dbSvc.settings.getSetting('terminal', 'terminal_id', '');
    this.terminalId = terminalId || persistedTerminalId || process.env.TERMINAL_ID || 'terminal-001';
    this.branchId = dbSvc.settings.getSetting('terminal', 'branch_id', null) as string | null;

    // Initialize sub-services
    this.networkMonitor = new NetworkMonitor(dbManager);
    this.orderSyncService = new OrderSyncService(dbManager, this.supabase, this.terminalId);
    this.inventorySyncService = new InventorySyncService();
    this.configurationSyncService = new ConfigurationSyncService(this.settingsService!);

    // Initialize InterTerminal service
    const interTerminalPort = this.settingsService?.getInterTerminalPort() || 8765;
    this.interTerminalService = new InterTerminalCommunicationService(dbManager, this.featureService, interTerminalPort);

    // Check if enabled before initializing (Comment 3)
    const interTerminalEnabled = this.settingsService?.isInterTerminalSyncEnabled() ?? true;
    if (interTerminalEnabled) {
      this.interTerminalService.initialize().catch(err => console.error('Failed to init inter-terminal service:', err));
    }

    // Inject dependencies into OrderSyncService
    this.orderSyncService.setInterTerminalService(this.interTerminalService);
    this.orderSyncService.setFeatureService(this.featureService);

    // Initialize status
    this.isOnline = navigator.onLine;

    // Setup network monitoring
    this.setupNetworkMonitoring();
  }

  public setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
    this.networkMonitor.setMainWindow(window);
    this.orderSyncService.setMainWindow(window);
    this.inventorySyncService.setMainWindow(window);
    this.configurationSyncService.setMainWindow(window);
    this.interTerminalService.setMainWindow(window);
  }

  /**
   * Set the organization ID for RLS compliance on order sync.
   * This should be called when terminal settings are loaded.
   */
  public setOrganizationId(orgId: string | null): void {
    this.orderSyncService.setOrganizationId(orgId);
  }

  private setupNetworkMonitoring() {
    this.networkMonitor.startMonitoring();
    // Poll for local status update
    setInterval(() => {
      const online = this.networkMonitor.getIsOnline();
      if (this.isOnline !== online) {
        this.isOnline = online;
        if (this.isOnline) {
          this.startSync();
        }
      }
    }, 1000);
  }

  public async startAutoSync(intervalMs: number = 30000) {
    if (this.syncInterval) return;

    // Initial sync
    this.startSync();

    this.syncInterval = setInterval(() => {
      this.startSync();
    }, intervalMs);
  }

  public stopAutoSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.networkMonitor.stopMonitoring();
    this.interTerminalService.cleanup();
  }

  public async startSync(): Promise<void> {
    if (this.syncInProgress || !this.isOnline) return;

    this.syncInProgress = true;
    this.notifyRenderer('sync:status', await this.getSyncStatus());

    try {
      // 1. Backfill missing orders
      await this.orderSyncService.backfillMissingOrdersQueue();

      // 2. Sync local to remote
      await this.syncLocalToRemote();

      // 3. Sync remote to local (simplified for now, mostly handled by realtime)
      this.lastSync = new Date().toISOString();
      this.notifyRenderer('sync:complete', { timestamp: this.lastSync });
    } catch (error) {
      console.error('Sync failed:', error);
      this.notifyRenderer('sync:error', { error: (error as Error).message });
    } finally {
      this.syncInProgress = false;
      this.notifyRenderer('sync:status', await this.getSyncStatus());
    }
  }

  private async syncLocalToRemote(): Promise<void> {
    const syncQueue = await this.dbManager.getSyncQueue();

    // Priority order: orders first, then staff_shifts (parent), then child records (expenses, payments, earnings)
    const tablePriority: Record<string, number> = {
      'orders': 1,
      'staff_shifts': 2,       // Must sync before child records
      'cash_drawer_sessions': 3,
      'staff_payments': 4,     // Child of staff_shifts
      'shift_expenses': 4,     // Child of staff_shifts
      'driver_earnings': 4,    // Child of staff_shifts
    };

    const prioritized = [...syncQueue].sort((a: any, b: any) => {
      const aPriority = tablePriority[a.table_name] ?? 99;
      const bPriority = tablePriority[b.table_name] ?? 99;
      return aPriority - bPriority;
    });

    for (const item of prioritized) {
      try {
        await this.processSyncQueueItem(item);
        await this.dbManager.updateSyncQueueItem(item.id, true);
      } catch (error) {
        console.error(`Failed to sync item ${item.id}:`, error);
        await this.dbManager.updateSyncQueueItem(item.id, false, (error as Error).message);
      }
    }
  }

  private updateLocalSupabaseId(table: string, id: string, supabaseId: string) {
    try {
      const db = (this.dbManager as any).db || (this.dbManager.getDatabaseService() as any).db;
      if (db) {
        // Only update if column exists (it should due to migration)
        try {
          db.prepare(`UPDATE ${table} SET supabase_id = ? WHERE id = ?`).run(supabaseId, id);
        } catch (e) {
          // Ignore logic if column missing (shouldn't happen with migration)
        }
      }
    } catch (err) {
      console.warn(`[SyncService] Failed to update local supabase_id for ${table} ${id}:`, err);
    }
  }

  private async processSyncQueueItem(item: SyncQueue): Promise<void> {
    const data = JSON.parse(item.data);

    switch (item.table_name) {
      case 'orders':
        await this.orderSyncService.syncOrder(item.operation, item.record_id, data);
        break;
      case 'staff_shifts':
        await this.syncStaffShift(item.operation, item.record_id, data);
        break;
      case 'cash_drawer_sessions':
        await this.syncCashDrawerSession(item.operation, item.record_id, data);
        break;
      case 'driver_earnings':
        await this.syncDriverEarning(item.operation, item.record_id, data);
        break;
      case 'staff_payments':
        await this.syncStaffPayment(item.operation, item.record_id, data);
        break;
      case 'shift_expenses':
        await this.syncShiftExpense(item.operation, item.record_id, data);
        break;
      case 'customers':
        await this.syncCustomer(item.operation, item.record_id, data);
        break;
      case 'customer_addresses':
        await this.syncCustomerAddress(item.operation, item.record_id, data);
        break;
      default:
        break;
    }
  }

  private async syncCustomer(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert' || operation === 'update') {
      const { error } = await this.supabase
        .from('customers')
        .upsert({
          id: data.id,
          full_name: data.full_name || data.name,
          phone: data.phone,
          email: data.email || null,
          address: data.address || null,
          postal_code: data.postal_code || null,
          loyalty_points: data.loyalty_points || 0,
          total_orders: data.total_orders || 0,
          last_order_date: data.last_order_date || null,
          version: data.version || 1,
          updated_by: data.updated_by || 'pos-system',
          last_synced_at: new Date().toISOString(),
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });

      if (error) throw new Error(`Failed to sync customer: ${error.message}`);
      this.updateLocalSupabaseId('customers', data.id, data.id);

    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('customers')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete customer: ${error.message}`);
    }
  }

  private async syncCustomerAddress(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert' || operation === 'update') {
      const { error } = await this.supabase
        .from('customer_addresses')
        .upsert({
          id: data.id,
          customer_id: data.customer_id,
          street_address: data.street_address || data.street,
          city: data.city,
          postal_code: data.postal_code || null,
          country: data.country || null,
          floor_number: data.floor_number || null,
          address_type: data.address_type || 'delivery',
          is_default: data.is_default || false,
          delivery_notes: data.delivery_notes || null,
          version: data.version || 1,
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });

      if (error) throw new Error(`Failed to sync customer address: ${error.message}`);
      this.updateLocalSupabaseId('customer_addresses', data.id, data.id);

    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('customer_addresses')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete customer address: ${error.message}`);
    }
  }

  private async syncStaffShift(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert') {
      // Extract shift_date from check_in_time (YYYY-MM-DD format)
      const shiftDate = data.check_in_time ? data.check_in_time.split('T')[0] : new Date().toISOString().split('T')[0];

      const { error } = await this.supabase
        .from('staff_shifts')
        .upsert({
          id: data.id,
          staff_id: data.staff_id,
          staff_name: data.staff_name,
          branch_id: data.branch_id,
          terminal_id: data.terminal_id,
          role_type: data.role_type,
          shift_date: shiftDate, // Required column in Supabase
          check_in_time: data.check_in_time,
          opening_cash_amount: data.opening_cash_amount,
          status: data.status,
          is_day_start: data.is_day_start || false,
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });

      if (error) throw new Error(`Failed to sync staff shift (insert): ${error.message}`);
      this.updateLocalSupabaseId('staff_shifts', data.id, data.id);

    } else if (operation === 'update') {
      // For updates, only update specific fields
      const updateData: Record<string, any> = {
        updated_at: data.updated_at || new Date().toISOString()
      };

      // Only include fields that are present in data
      if (data.check_out_time !== undefined) updateData.check_out_time = data.check_out_time;
      if (data.closing_cash_amount !== undefined) updateData.closing_cash_amount = data.closing_cash_amount;
      if (data.expected_cash_amount !== undefined) updateData.expected_cash_amount = data.expected_cash_amount;
      if (data.cash_variance !== undefined) updateData.cash_variance = data.cash_variance;
      if (data.payment_amount !== undefined) updateData.payment_amount = data.payment_amount;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.closed_by !== undefined) updateData.closed_by = data.closed_by;
      if (data.is_day_start !== undefined) updateData.is_day_start = data.is_day_start;
      if (data.transferred_to_cashier_shift_id !== undefined) updateData.transferred_to_cashier_shift_id = data.transferred_to_cashier_shift_id;
      if (data.is_transfer_pending !== undefined) updateData.is_transfer_pending = data.is_transfer_pending;

      const { error } = await this.supabase
        .from('staff_shifts')
        .update(updateData)
        .eq('id', recordId);

      if (error) throw new Error(`Failed to sync staff shift (update): ${error.message}`);

    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('staff_shifts')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete staff shift: ${error.message}`);
    }
  }

  private async syncCashDrawerSession(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert') {
      // Extract session_date from opened_at (YYYY-MM-DD format)
      const sessionDate = data.opened_at ? data.opened_at.split('T')[0] : new Date().toISOString().split('T')[0];

      const { error } = await this.supabase
        .from('cash_drawer_sessions')
        .upsert({
          id: data.id,
          staff_shift_id: data.staff_shift_id,
          cashier_id: data.cashier_id,
          branch_id: data.branch_id,
          terminal_id: data.terminal_id,
          session_date: sessionDate, // Required column in Supabase
          opening_amount: data.opening_amount,
          total_cash_sales: data.total_cash_sales || 0,
          total_card_sales: data.total_card_sales || 0,
          total_refunds: data.total_refunds || 0,
          total_expenses: data.total_expenses || 0,
          cash_drops: data.cash_drops || 0,
          driver_cash_given: data.driver_cash_given || 0,
          driver_cash_returned: data.driver_cash_returned || 0,
          total_staff_payments: data.total_staff_payments || 0,
          opened_at: data.opened_at,
          reconciled: data.reconciled || false,
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });

      if (error) throw new Error(`Failed to sync cash drawer session (insert): ${error.message}`);
      this.updateLocalSupabaseId('cash_drawer_sessions', data.id, data.id);

    } else if (operation === 'update') {
      const updateData: Record<string, any> = {
        updated_at: data.updated_at || new Date().toISOString()
      };

      // Only include fields that are present in data
      if (data.closing_amount !== undefined) updateData.closing_amount = data.closing_amount;
      if (data.expected_amount !== undefined) updateData.expected_amount = data.expected_amount;
      if (data.variance_amount !== undefined) updateData.variance_amount = data.variance_amount;
      if (data.closed_at !== undefined) updateData.closed_at = data.closed_at;
      if (data.total_cash_sales !== undefined) updateData.total_cash_sales = data.total_cash_sales;
      if (data.total_card_sales !== undefined) updateData.total_card_sales = data.total_card_sales;
      if (data.total_expenses !== undefined) updateData.total_expenses = data.total_expenses;
      if (data.total_staff_payments !== undefined) updateData.total_staff_payments = data.total_staff_payments;
      if (data.driver_cash_given !== undefined) updateData.driver_cash_given = data.driver_cash_given;
      if (data.driver_cash_returned !== undefined) updateData.driver_cash_returned = data.driver_cash_returned;
      if (data.reconciled !== undefined) updateData.reconciled = data.reconciled;

      const { error } = await this.supabase
        .from('cash_drawer_sessions')
        .update(updateData)
        .eq('id', recordId);

      if (error) throw new Error(`Failed to sync cash drawer session (update): ${error.message}`);

    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('cash_drawer_sessions')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete cash drawer session: ${error.message}`);
    }
  }

  private async syncDriverEarning(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert' || operation === 'update') {
      // Upsert to handle idempotency
      const { error } = await this.supabase
        .from('driver_earnings')
        .upsert({
          id: data.id,
          driver_id: data.driver_id,
          staff_shift_id: data.staff_shift_id,
          order_id: data.order_id,
          branch_id: data.branch_id,
          delivery_fee: data.delivery_fee,
          tip_amount: data.tip_amount,
          total_earning: data.total_earning,
          payment_method: data.payment_method,
          cash_collected: data.cash_collected,
          card_amount: data.card_amount,
          cash_to_return: data.cash_to_return,
          order_details: data.order_details,
          settled: data.settled,
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });

      if (error) {
        throw new Error(`Failed to sync driver earning: ${error.message}`);
      }

      // Update local record to mark as synced
      this.updateLocalSupabaseId('driver_earnings', data.id, data.id);

    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('driver_earnings')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete driver earning: ${error.message}`);
    }
  }

  private async syncStaffPayment(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert' || operation === 'update') {
      // Validate UUIDs - skip invalid ones (e.g., "no-pin-user")
      const isValidUUID = (val: any) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

      // Check if referenced shifts exist in Supabase, set to NULL if not
      let staffShiftId = isValidUUID(data.staff_shift_id) ? data.staff_shift_id : null;
      let cashierShiftId = isValidUUID(data.paid_by_cashier_shift_id) ? data.paid_by_cashier_shift_id : null;
      let paidToStaffId = isValidUUID(data.paid_to_staff_id) ? data.paid_to_staff_id : null;

      // Verify shifts exist in Supabase (set to NULL if not found to avoid FK violation)
      if (staffShiftId || cashierShiftId) {
        const shiftIds = [staffShiftId, cashierShiftId].filter(Boolean);
        const { data: existingShifts } = await this.supabase
          .from('staff_shifts')
          .select('id')
          .in('id', shiftIds);
        const existingIds = new Set((existingShifts || []).map((s: any) => s.id));
        if (staffShiftId && !existingIds.has(staffShiftId)) staffShiftId = null;
        if (cashierShiftId && !existingIds.has(cashierShiftId)) cashierShiftId = null;
      }

      // Verify staff exists
      if (paidToStaffId) {
        const { data: existingStaff } = await this.supabase
          .from('staff')
          .select('id')
          .eq('id', paidToStaffId)
          .single();
        if (!existingStaff) paidToStaffId = null;
      }

      const { error } = await this.supabase
        .from('staff_payments')
        .upsert({
          id: data.id,
          staff_shift_id: staffShiftId,
          paid_to_staff_id: paidToStaffId,
          paid_by_cashier_shift_id: cashierShiftId,
          amount: data.amount,
          payment_type: data.payment_type,
          notes: data.notes,
          created_at: data.created_at,
          updated_at: data.updated_at
        });

      if (error) throw new Error(`Failed to sync staff payment: ${error.message}`);

      this.updateLocalSupabaseId('staff_payments', data.id, data.id);
    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('staff_payments')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete staff payment: ${error.message}`);
    }
  }

  private async syncShiftExpense(operation: string, recordId: string, data: any): Promise<void> {
    if (operation === 'insert' || operation === 'update') {
      // Map POS fields to Supabase schema:
      // - expense_type -> category
      // - Add expense_date (required in Supabase)
      // - Remove receipt_number and updated_at (not in Supabase)
      const expenseDate = data.created_at ? data.created_at.split('T')[0] : new Date().toISOString().split('T')[0];

      // Validate UUIDs
      const isValidUUID = (val: any) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

      let staffShiftId = isValidUUID(data.staff_shift_id) ? data.staff_shift_id : null;

      // Verify shift exists in Supabase (set to NULL if not found to avoid FK violation)
      if (staffShiftId) {
        const { data: existingShift } = await this.supabase
          .from('staff_shifts')
          .select('id')
          .eq('id', staffShiftId)
          .single();
        if (!existingShift) staffShiftId = null;
      }

      const { error } = await this.supabase
        .from('shift_expenses')
        .upsert({
          id: data.id,
          staff_shift_id: staffShiftId,
          staff_id: isValidUUID(data.staff_id) ? data.staff_id : null,
          branch_id: isValidUUID(data.branch_id) ? data.branch_id : null,
          category: data.expense_type, // Map expense_type to category
          expense_date: expenseDate, // Required field in Supabase
          amount: data.amount,
          description: data.description,
          status: data.status,
          approved_by: isValidUUID(data.approved_by) ? data.approved_by : null,
          approved_at: data.approved_at,
          rejection_reason: data.rejection_reason,
          created_at: data.created_at
        });

      if (error) throw new Error(`Failed to sync shift expense: ${error.message}`);

      this.updateLocalSupabaseId('shift_expenses', data.id, data.id);
    } else if (operation === 'delete') {
      const { error } = await this.supabase
        .from('shift_expenses')
        .delete()
        .eq('id', recordId);

      if (error) throw new Error(`Failed to delete shift expense: ${error.message}`);
    }
  }

  // Realtime subscriptions
  public setupRealtimeSubscriptions() {
    this.setupEnhancedSyncSubscriptions();
  }

  private async setupEnhancedSyncSubscriptions() {
    // Subscribe to 'enhanced_sync_queue'
    const channel = this.supabase
      .channel('enhanced_sync_queue_changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'enhanced_sync_queue',
          filter: `terminal_id=eq.${this.terminalId}`
        },
        (payload) => this.handleEnhancedSyncQueue(payload)
      )
      .subscribe();

    // Subscribe to 'pos_configurations'
    const configChannel = this.supabase
      .channel('pos_configurations_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pos_configurations'
        },
        (payload) => this.configurationSyncService.handlePOSConfigurationSync(payload)
      )
      .subscribe();
  }

  private async handleEnhancedSyncQueue(payload: any) {
    const { new: newRecord } = payload;
    if (newRecord.sync_status === 'pending') {
      await this.processEnhancedSyncItem(newRecord);
    }
  }

  private async processEnhancedSyncItem(syncItem: any) {
    const { sync_type, data_changes } = syncItem;
    switch (sync_type) {
      case 'menu_availability':
        await this.inventorySyncService.handleMenuAvailabilitySync(data_changes);
        break;
      case 'restaurant_settings':
        await this.configurationSyncService.handleRestaurantSettingsSync(data_changes);
        break;
      case 'inventory_update':
        await this.inventorySyncService.handleInventoryUpdateSync(data_changes);
        break;
      case 'staff_permissions':
        await this.configurationSyncService.handleStaffPermissionsSync({ eventType: 'INSERT', new: data_changes });
        break;
      case 'hardware_config':
        await this.configurationSyncService.handleHardwareConfigSync({ eventType: 'INSERT', new: data_changes });
        break;
    }
  }

  // Compatibility methods
  public async forceSync(timeoutMs?: number): Promise<void> {
    await this.startSync();
  }

  public async forceSyncFastLocal(timeoutMs: number): Promise<void> {
    await this.forceSync(timeoutMs);
  }

  public async pushSingleOrderNow(orderId: string, timeoutMs: number): Promise<void> {
    await this.orderSyncService.pushSingleOrderNow(orderId, timeoutMs);
  }

  public async syncAllEnhanced(force: boolean): Promise<void> {
    await this.startSync();
  }

  public async forceSyncAndWaitForEmpty(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    await this.startSync();

    // Poll until queue is empty or timeout
    while (Date.now() - startTime < timeoutMs) {
      const queue = await this.dbManager.getSyncQueue();
      if (queue.length === 0) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Sync queue not empty after timeout');
  }

  public getNetworkStatus(): boolean {
    return this.networkMonitor.getIsOnline();
  }

  public async getSyncStatus(): Promise<SyncStatus> {
    const queue = await this.dbManager.getSyncQueue();
    return {
      isOnline: this.isOnline,
      lastSync: this.lastSync,
      pendingItems: queue.length,
      syncInProgress: this.syncInProgress,
      error: null,
      terminalHealth: 100,
      settingsVersion: 1,
      menuVersion: 1,
      pendingPaymentItems: 0,
      failedPaymentItems: 0
    };
  }

  public getInterTerminalStatus() {
    const parentInfo = this.interTerminalService.getParentTerminalInfo();
    const isParentReachable = this.interTerminalService.isParentReachableSync();

    // Accurate routing mode based on connectivity (Comment 2)
    const isMobile = this.featureService.isMobileWaiter();
    const routingMode = isMobile
      ? (parentInfo && isParentReachable ? 'via_parent' : 'direct_cloud')
      : 'main';

    return {
      parentInfo,
      isParentReachable,
      routingMode
    };
  }

  public async testParentConnection(): Promise<boolean> {
    if (this.interTerminalService) {
      return this.interTerminalService.isParentReachable();
    }
    return false;
  }

  public rediscoverParent(): void {
    if (this.interTerminalService && this.featureService.isMobileWaiter()) {
      const enabled = this.settingsService?.isInterTerminalSyncEnabled() ?? true;
      if (enabled) {
        // initialize() now safely calls cleanup() first (Comment 4)
        this.interTerminalService.initialize();
      }
    }
  }

  public async prepareForShutdown() {
    this.stopAutoSync();
  }

  private notifyRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}
