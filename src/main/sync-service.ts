import { DatabaseManager, SyncQueue } from './database';
import { BrowserWindow } from 'electron';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../shared/supabase-config';
import { CustomerService } from './services/CustomerService';
import { SettingsService } from './services/SettingsService';
import { ORDER_STATUSES, mapStatusForPOS, isValidOrderStatus, mapStatusForSupabase, coerceIncomingStatus } from '../shared/types/order-status';

// Sub-services
import { NetworkMonitor } from './services/sync/NetworkMonitor';
import { OrderSyncService } from './services/sync/OrderSyncService';
import { InventorySyncService } from './services/sync/InventorySyncService';
import { ConfigurationSyncService } from './services/sync/ConfigurationSyncService';
import { InterTerminalCommunicationService } from './services/sync/InterTerminalCommunicationService';
import { FeatureService } from './services/FeatureService';

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

    // Prioritize orders
    const prioritized = [...syncQueue].sort((a: any, b: any) => {
      const aIsOrder = a.table_name === 'orders';
      const bIsOrder = b.table_name === 'orders';
      if (aIsOrder && !bIsOrder) return -1;
      if (!aIsOrder && bIsOrder) return 1;
      return 0;
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
        // Placeholder: In a real refactor, this would go to CustomerSyncService
        break;
      default:
        break;
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
      const { error } = await this.supabase
        .from('staff_payments')
        .upsert({
          id: data.id,
          staff_shift_id: data.staff_shift_id,
          paid_to_staff_id: data.paid_to_staff_id,
          paid_by_cashier_shift_id: data.paid_by_cashier_shift_id,
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

      const { error } = await this.supabase
        .from('shift_expenses')
        .upsert({
          id: data.id,
          staff_shift_id: data.staff_shift_id,
          staff_id: data.staff_id,
          branch_id: data.branch_id,
          category: data.expense_type, // Map expense_type to category
          expense_date: expenseDate, // Required field in Supabase
          amount: data.amount,
          description: data.description,
          status: data.status,
          approved_by: data.approved_by,
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