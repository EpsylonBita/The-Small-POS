/**
 * IPC Abstraction Layer for The Small POS
 *
 * Provides a platform-agnostic bridge between the React renderer and the
 * native backend (Tauri or Electron). Existing Electron components call
 * `window.electron.ipcRenderer.invoke(channel, ...args)` -- the compat shim
 * in `electron-compat.ts` routes those calls through this adapter so the
 * same React code runs on both runtimes.
 *
 * Architecture:
 *   PlatformBridge (interface)
 *     ├── TauriBridge    (uses @tauri-apps/api/core invoke)
 *     ├── ElectronBridge (passthrough to real Electron IPC)
 *     └── BrowserStub    (rejects all calls with descriptive errors)
 *
 * Each sub-bridge groups commands by namespace matching the Electron IPC
 * channel naming convention: `namespace:action`.
 */

import { detectPlatform } from './platform-detect';

// ============================================================================
// Payload & Response Types
// ============================================================================

// -- Generic -----------------------------------------------------------------

export interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// -- Auth / Staff Auth -------------------------------------------------------

export interface AuthLoginPayload {
  pin: string;
}

export interface AuthLoginResponse {
  success: boolean;
  user?: {
    staffId: string;
    staffName: string;
    role: { name: string; permissions?: string[] };
    branchId: string;
    terminalId: string;
    sessionId: string;
    organizationId?: string;
  };
  error?: string;
}

export interface SessionValidationResponse {
  valid: boolean;
  reason?: string;
}

// -- Settings / Terminal Config ----------------------------------------------

export interface TerminalSettings {
  [key: string]: any;
}

export interface UpdateTerminalCredentialsPayload {
  terminalId: string;
  apiKey: string;
  adminUrl?: string;
  branchId?: string;
  organizationId?: string;
}

// -- Orders ------------------------------------------------------------------

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  notes?: string;
  modifiers?: Array<{ name: string; price: number }>;
}

export interface Order {
  id: string;
  order_number?: string;
  status: string;
  order_type: string;
  items: OrderItem[];
  total: number;
  subtotal: number;
  tax?: number;
  discount?: number;
  payment_status?: string;
  payment_method?: string;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  driver_id?: string;
  table_id?: string;
  created_at: string;
  updated_at?: string;
  source?: string;
  branch_id?: string;
  staff_id?: string;
  notes?: string;
  sync_status?: string;
}

export interface CreateOrderPayload {
  items: OrderItem[];
  order_type: string;
  payment_method?: string;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  table_id?: string;
  notes?: string;
  discount?: number;
  staff_id?: string;
  driver_id?: string;
}

// -- Sync --------------------------------------------------------------------

export interface SyncStatus {
  isOnline: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
  syncErrors: number;
}

export interface NetworkStatus {
  isOnline: boolean;
  type?: string;
  effectiveType?: string;
}

// -- Customer ----------------------------------------------------------------

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  addresses?: CustomerAddress[];
  total_orders?: number;
  total_spent?: number;
  is_banned?: boolean;
  notes?: string;
  version?: number;
}

export interface CustomerAddress {
  id: string;
  address: string;
  city?: string;
  postal_code?: string;
  lat?: number;
  lng?: number;
  is_default?: boolean;
}

// -- Payments ----------------------------------------------------------------

export interface RecordPaymentParams {
  orderId: string;
  method: 'cash' | 'card' | 'other';
  amount: number;
  cashReceived?: number;
  changeGiven?: number;
  transactionRef?: string;
  staffId?: string;
  staffShiftId?: string;
}

// -- Shifts ------------------------------------------------------------------

export interface OpenShiftParams {
  staffId: string;
  openingCash: number;
  branchId: string;
  terminalId: string;
  roleType?: string;
  startingAmount?: number;
}

export interface CloseShiftParams {
  shiftId: string;
  closingCash: number;
  closedBy: string;
  paymentAmount?: number;
}

export interface RecordExpenseParams {
  shiftId: string;
  amount: number;
  expenseType: string;
  description?: string;
  receiptNumber?: string;
}

export interface RecordStaffPaymentParams {
  cashierShiftId: string;
  recipientShiftId: string;
  recipientStaffId: string;
  recipientStaffName: string;
  recipientRole: string;
  amount: number;
  paymentType: string;
  notes?: string;
}

// -- Menu --------------------------------------------------------------------

export interface MenuCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface MenuUpdatePayload {
  id: string;
  [key: string]: any;
}

// -- Modules -----------------------------------------------------------------

export interface ModuleSyncResponse {
  success: boolean;
  modules: Array<{
    id: string;
    name: string;
    is_enabled: boolean;
    plan_required?: string;
  }>;
  disabled_module_ids: string[];
  sync_timestamp: string;
  is_incremental: boolean;
}

// -- ECR (Payment Terminals) -------------------------------------------------

export interface EcrPaymentOptions {
  deviceId?: string;
  orderId?: string;
  tipAmount?: number;
  currency?: string;
  reference?: string;
}

export interface EcrRefundOptions {
  deviceId?: string;
  orderId?: string;
  originalTransactionId?: string;
  currency?: string;
}

// -- Window / Update ---------------------------------------------------------

export interface WindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
}

export interface UpdateState {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  ready: boolean;
  error: string | null;
  progress: number;
  updateInfo: any;
}

// -- Printer -----------------------------------------------------------------

export interface PrinterConfig {
  id: string;
  name: string;
  type: string;
  connectionType: string;
  address?: string;
  port?: number;
  isDefault?: boolean;
  roles?: string[];
}

// ============================================================================
// PlatformBridge Interface
// ============================================================================

/**
 * The canonical interface for all backend commands.
 *
 * Each namespace mirrors the Electron IPC channel prefix.
 * Implementations convert calls to the native invoke mechanism.
 *
 * Every method from the Electron preload's allowedInvokes list plus
 * the convenience wrappers on `window.electronAPI` is represented here.
 */
export interface PlatformBridge {
  // -- App lifecycle ---------------------------------------------------------
  app: {
    shutdown(): Promise<void>;
    restart(): Promise<void>;
    getVersion(): Promise<any>;
    getShutdownStatus(): Promise<{ shuttingDown: boolean }>;
  };

  // -- System ----------------------------------------------------------------
  system: {
    getInfo(): Promise<{ platform: string; arch: string; version: string }>;
  };

  // -- Auth ------------------------------------------------------------------
  auth: {
    login(pin: string): Promise<AuthLoginResponse>;
    logout(): Promise<void>;
    getCurrentSession(): Promise<any>;
    validateSession(): Promise<SessionValidationResponse>;
    hasPermission(permission: string): Promise<boolean>;
    getSessionStats(): Promise<any>;
    setupPin(pin: string): Promise<IpcResult>;
  };

  // -- Staff auth ------------------------------------------------------------
  staffAuth: {
    authenticatePin(pin: string): Promise<IpcResult>;
    getSession(): Promise<any>;
    getCurrent(): Promise<any>;
    hasPermission(permission: string): Promise<boolean>;
    hasAnyPermission(permissions: string[]): Promise<boolean>;
    logout(): Promise<void>;
    validateSession(): Promise<SessionValidationResponse>;
    trackActivity(): Promise<void>;
  };

  // -- Orders ----------------------------------------------------------------
  orders: {
    getAll(): Promise<Order[]>;
    getById(orderId: string): Promise<Order | null>;
    getByCustomerPhone(phone: string): Promise<any>;
    create(payload: CreateOrderPayload): Promise<IpcResult<Order>>;
    updateStatus(orderId: string, status: string): Promise<IpcResult>;
    updateItems(orderId: string, items: OrderItem[]): Promise<IpcResult>;
    delete(orderId: string): Promise<IpcResult>;
    saveFromRemote(order: any): Promise<IpcResult>;
    saveForRetry(order: any): Promise<IpcResult>;
    getRetryQueue(): Promise<any[]>;
    processRetryQueue(): Promise<IpcResult>;
    approve(orderId: string, estimatedTime?: number): Promise<IpcResult>;
    decline(orderId: string, reason: string): Promise<IpcResult>;
    assignDriver(orderId: string, driverId: string, notes?: string): Promise<IpcResult>;
    notifyPlatformReady(orderId: string): Promise<IpcResult>;
    updatePreparation(orderId: string, stage: string, progress: number, message?: string): Promise<IpcResult>;
    updateType(orderId: string, orderType: string): Promise<IpcResult>;
    fetchItemsFromSupabase(orderId: string): Promise<IpcResult>;
    getConflicts(): Promise<any[]>;
    resolveConflict(conflictId: string, strategy: string, data?: any): Promise<IpcResult>;
    forceSyncRetry(orderId: string): Promise<IpcResult>;
    getRetryInfo(orderId: string): Promise<any>;
    clearAll(): Promise<IpcResult>;
  };

  // -- Payments --------------------------------------------------------------
  payments: {
    updatePaymentStatus(orderId: string, status: string, method?: string): Promise<IpcResult>;
    printReceipt(receiptData: any, type?: string): Promise<IpcResult>;
    printKitchenTicket(ticketData: any): Promise<IpcResult>;
    recordPayment(params: RecordPaymentParams): Promise<IpcResult>;
    voidPayment(paymentId: string, reason: string, voidedBy?: string): Promise<IpcResult>;
    getOrderPayments(orderId: string): Promise<any[]>;
    getReceiptPreview(orderId: string): Promise<IpcResult<{ html: string }>>;
  };

  // -- Sync ------------------------------------------------------------------
  sync: {
    getStatus(): Promise<SyncStatus>;
    force(): Promise<void>;
    getNetworkStatus(): Promise<NetworkStatus>;
    getInterTerminalStatus(): Promise<any>;
    clearAll(): Promise<IpcResult>;
    clearFailed(): Promise<IpcResult>;
    clearOldOrders(): Promise<IpcResult>;
    clearAllOrders(): Promise<IpcResult>;
    cleanupDeletedOrders(): Promise<IpcResult>;
    getFinancialStats(): Promise<any>;
    getFailedFinancialItems(limit?: number): Promise<any[]>;
    retryFinancialItem(syncId: string): Promise<IpcResult>;
    retryAllFailedFinancial(): Promise<IpcResult>;
    getUnsyncedFinancialSummary(): Promise<any>;
    validateFinancialIntegrity(): Promise<IpcResult>;
    requeueOrphanedFinancial(): Promise<IpcResult>;
    testParentConnection(): Promise<IpcResult>;
    rediscoverParent(): Promise<IpcResult>;
    fetchTables(): Promise<any>;
    fetchReservations(): Promise<any>;
    fetchSuppliers(): Promise<any>;
    fetchAnalytics(): Promise<any>;
    fetchOrders(): Promise<any>;
    fetchRooms(options?: any): Promise<any>;
    updateRoomStatus(roomId: string, status: string): Promise<any>;
    fetchDriveThru(options?: any): Promise<any>;
    updateDriveThruOrderStatus(orderId: string, status: string): Promise<any>;
  };

  // -- Customers -------------------------------------------------------------
  customers: {
    invalidateCache(phone: string): Promise<void>;
    getCacheStats(): Promise<any>;
    clearCache(): Promise<void>;
    lookupByPhone(phone: string): Promise<Customer | null>;
    lookupById(customerId: string): Promise<Customer | null>;
    search(query: string): Promise<Customer[]>;
    create(data: Partial<Customer>): Promise<IpcResult<Customer>>;
    update(customerId: string, updates: Partial<Customer>, currentVersion: number): Promise<IpcResult>;
    updateBanStatus(customerId: string, isBanned: boolean): Promise<IpcResult>;
    addAddress(customerId: string, address: Partial<CustomerAddress>): Promise<IpcResult>;
    updateAddress(addressId: string, updates: Partial<CustomerAddress>, currentVersion: number): Promise<IpcResult>;
    resolveConflict(conflictId: string, strategy: string, data?: any): Promise<IpcResult>;
    getConflicts(filters?: any): Promise<any[]>;
  };

  // -- Settings --------------------------------------------------------------
  settings: {
    get(key?: string): Promise<any>;
    getLocal(key?: string): Promise<any>;
    updateLocal(key: string, value: any): Promise<IpcResult>;
    set(key: string, value: any): Promise<IpcResult>;
    getDiscountMax(): Promise<number>;
    setDiscountMax(percentage: number): Promise<IpcResult>;
    getTaxRate(): Promise<number>;
    setTaxRate(percentage: number): Promise<IpcResult>;
    getLanguage(): Promise<string>;
    setLanguage(lang: string): Promise<IpcResult>;
    getAdminUrl(): Promise<string>;
    clearConnection(): Promise<IpcResult>;
    updateTerminalCredentials(payload: UpdateTerminalCredentialsPayload): Promise<IpcResult>;
    isConfigured(): Promise<boolean>;
    factoryReset(): Promise<IpcResult>;
  };

  // -- Terminal config -------------------------------------------------------
  terminalConfig: {
    getSettings(): Promise<TerminalSettings>;
    getSetting(section: string, key: string): Promise<any>;
    getBranchId(): Promise<string>;
    getTerminalId(): Promise<string>;
    refresh(): Promise<IpcResult>;
    getOrganizationId(): Promise<string>;
    getBusinessType(): Promise<string>;
    getFullConfig(): Promise<any>;
  };

  // -- Shifts ----------------------------------------------------------------
  shifts: {
    open(params: OpenShiftParams): Promise<IpcResult>;
    close(params: CloseShiftParams): Promise<IpcResult>;
    getActive(staffId: string): Promise<any>;
    getActiveByTerminal(branchId: string, terminalId: string): Promise<any>;
    getActiveByTerminalLoose(terminalId: string): Promise<any>;
    getActiveCashierByTerminal(branchId: string, terminalId: string): Promise<any>;
    listStaffForCheckin(): Promise<any>;
    getStaffRoles(): Promise<any>;
    getSummary(shiftId: string, options?: { skipBackfill?: boolean }): Promise<any>;
    recordExpense(params: RecordExpenseParams): Promise<IpcResult>;
    getExpenses(shiftId: string): Promise<any[]>;
    recordStaffPayment(params: RecordStaffPaymentParams): Promise<IpcResult>;
    getStaffPayments(cashierShiftId: string): Promise<any[]>;
    getStaffPaymentsByStaff(params: any): Promise<any[]>;
    getStaffPaymentTotalForDate(staffId: string, date: string): Promise<any>;
    getScheduledShifts(params: any): Promise<any[]>;
    getTodayScheduledShifts(branchId: string): Promise<any[]>;
    backfillDriverEarnings(params: { shiftId?: string; date?: string }): Promise<IpcResult>;
  };

  // -- Drivers ---------------------------------------------------------------
  drivers: {
    recordEarning(params: any): Promise<IpcResult>;
    getEarnings(shiftId: string): Promise<any[]>;
    getShiftSummary(shiftId: string): Promise<any>;
    getActive(branchId: string): Promise<any[]>;
  };

  // -- Delivery zones --------------------------------------------------------
  deliveryZones: {
    trackValidation(data: any): Promise<IpcResult>;
    getAnalytics(filters?: any): Promise<any>;
    requestOverride(data: any): Promise<IpcResult>;
  };

  // -- Reports ---------------------------------------------------------------
  reports: {
    getTodayStatistics(params: { branchId: string }): Promise<any>;
    getSalesTrend(params: { branchId: string; days: number }): Promise<any>;
    getTopItems(params: { branchId: string; date?: string; limit?: number }): Promise<any>;
    getWeeklyTopItems(params: { branchId: string; limit?: number }): Promise<any>;
    generateZReport(params: { branchId: string; date?: string }): Promise<any>;
    getDailyStaffPerformance(params: { branchId: string; date?: string }): Promise<any>;
    submitZReport(params: { branchId: string; date?: string }): Promise<IpcResult>;
  };

  // -- Menu ------------------------------------------------------------------
  menu: {
    sync(): Promise<any>;
    getCategories(): Promise<MenuCategory[]>;
    getSubcategories(): Promise<any[]>;
    getIngredients(): Promise<any[]>;
    getSubcategoryIngredients(subcategoryId: string): Promise<any[]>;
    getCombos(): Promise<any[]>;
    updateCategory(id: string, updates: any): Promise<IpcResult>;
    updateSubcategory(id: string, updates: any): Promise<IpcResult>;
    updateIngredient(id: string, updates: any): Promise<IpcResult>;
    updateCombo(id: string, updates: any): Promise<IpcResult>;
    triggerCheckForUpdates(): Promise<void>;
  };

  // -- Printer ---------------------------------------------------------------
  printer: {
    listSystemPrinters(): Promise<any[]>;
    scanNetwork(): Promise<any[]>;
    scanBluetooth(): Promise<any[]>;
    discover(types?: string[]): Promise<PrinterConfig[]>;
    add(config: Partial<PrinterConfig>): Promise<IpcResult>;
    update(printerId: string, updates: Partial<PrinterConfig>): Promise<IpcResult>;
    remove(printerId: string): Promise<IpcResult>;
    getAll(): Promise<PrinterConfig[]>;
    get(printerId: string): Promise<PrinterConfig | null>;
    getStatus(printerId: string): Promise<any>;
    getAllStatuses(): Promise<any>;
    submitJob(job: any): Promise<IpcResult>;
    cancelJob(jobId: string): Promise<IpcResult>;
    retryJob(jobId: string): Promise<IpcResult>;
    test(printerId: string): Promise<IpcResult>;
    testGreekDirect(mode: string, printerName?: string): Promise<IpcResult>;
    diagnostics(printerId: string): Promise<any>;
    bluetoothStatus(): Promise<{ available: boolean; error?: string }>;
    openCashDrawer(printerId?: string, drawerNumber?: 1 | 2): Promise<IpcResult>;
    // Printer profiles (Tauri-native)
    createProfile(profile: any): Promise<IpcResult>;
    updateProfile(profile: any): Promise<IpcResult>;
    deleteProfile(profileId: string): Promise<IpcResult>;
    listProfiles(): Promise<any>;
    getProfile(profileId: string): Promise<any>;
    setDefaultProfile(profileId: string): Promise<IpcResult>;
    getDefaultProfile(): Promise<any>;
    reprintJob(jobId: string): Promise<IpcResult>;
  };

  // -- ECR (Payment Terminal) ------------------------------------------------
  ecr: {
    discoverDevices(connectionTypes?: string[], timeout?: number): Promise<any[]>;
    getDevices(): Promise<any[]>;
    getDevice(deviceId: string): Promise<any>;
    addDevice(config: any): Promise<IpcResult>;
    updateDevice(deviceId: string, updates: any): Promise<IpcResult>;
    removeDevice(deviceId: string): Promise<IpcResult>;
    getDefaultTerminal(): Promise<any>;
    connectDevice(deviceId: string): Promise<IpcResult>;
    disconnectDevice(deviceId: string): Promise<IpcResult>;
    getDeviceStatus(deviceId: string): Promise<any>;
    getAllStatuses(): Promise<any>;
    processPayment(amount: number, options?: EcrPaymentOptions): Promise<IpcResult>;
    processRefund(amount: number, options?: EcrRefundOptions): Promise<IpcResult>;
    voidTransaction(transactionId: string, deviceId?: string): Promise<IpcResult>;
    cancelTransaction(deviceId: string): Promise<IpcResult>;
    settlement(deviceId?: string): Promise<IpcResult>;
    getRecentTransactions(limit?: number): Promise<any[]>;
    queryTransactions(filters: any): Promise<any[]>;
    getTransactionStats(filters?: any): Promise<any>;
    getTransactionForOrder(orderId: string): Promise<any>;
  };

  // -- Modules ---------------------------------------------------------------
  modules: {
    fetchFromAdmin(): Promise<IpcResult>;
    getCached(): Promise<IpcResult>;
    saveCache(modules: any[]): Promise<IpcResult>;
  };

  // -- Updates ---------------------------------------------------------------
  updates: {
    check(): Promise<void>;
    download(): Promise<void>;
    cancelDownload(): Promise<void>;
    install(): Promise<void>;
    getState(): Promise<Partial<UpdateState>>;
    setChannel(channel: 'stable' | 'beta'): Promise<IpcResult>;
  };

  // -- Window ----------------------------------------------------------------
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    toggleFullscreen(): Promise<void>;
    getState(): Promise<WindowState>;
    reload(): Promise<void>;
    forceReload(): Promise<void>;
    toggleDevtools(): Promise<void>;
    zoomIn(): Promise<void>;
    zoomOut(): Promise<void>;
    zoomReset(): Promise<void>;
  };

  // -- Admin API (generic authenticated fetch) -------------------------------
  adminApi: {
    fetchFromAdmin(path: string, options?: { method?: string; body?: any; headers?: Record<string, string> }): Promise<any>;
  };

  // -- Database --------------------------------------------------------------
  database: {
    healthCheck(): Promise<IpcResult>;
    getStats(): Promise<any>;
    reset(): Promise<IpcResult>;
    clearOperationalData(): Promise<IpcResult>;
  };

  // -- Clipboard -------------------------------------------------------------
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };

  // -- Notifications ---------------------------------------------------------
  notifications: {
    show(data: any): Promise<void>;
  };

  // -- Screen capture --------------------------------------------------------
  screenCapture: {
    getSources(options: { types: string[] }): Promise<any>;
  };

  // -- Geolocation -----------------------------------------------------------
  geo: {
    ip(): Promise<any>;
  };

  // -- Labels ----------------------------------------------------------------
  labels: {
    print(request: any, printerId?: string): Promise<IpcResult>;
    printBatch(items: any[], labelType?: string, printerId?: string): Promise<IpcResult>;
  };

  // -- Refunds / Adjustments -------------------------------------------------
  refunds: {
    refundPayment(params: {
      paymentId: string;
      amount: number;
      reason: string;
      staffId?: string;
      orderId?: string;
    }): Promise<IpcResult>;
    listOrderAdjustments(orderId: string): Promise<any[]>;
    getPaymentBalance(paymentId: string): Promise<{
      originalAmount: number;
      totalRefunds: number;
      remaining: number;
    }>;
  };

  // -- Diagnostics -----------------------------------------------------------
  diagnostics: {
    getAbout(): Promise<any>;
    getSystemHealth(): Promise<any>;
    export(): Promise<IpcResult<{ path: string }>>;
  };

  /**
   * Raw invoke for channels not yet typed.
   * Prefer adding a typed method to the appropriate namespace instead.
   */
  invoke(channel: string, ...args: any[]): Promise<any>;
}

// ============================================================================
// Complete Channel -> Bridge method mapping
// ============================================================================

/**
 * Maps every known Electron IPC channel to its PlatformBridge path.
 * Used by the compatibility shim to route `ipcRenderer.invoke(channel, ...args)`
 * calls to typed bridge methods.
 */
export const CHANNEL_MAP: Record<string, string> = {
  // App
  'app:shutdown': 'app.shutdown',
  'app:restart': 'app.restart',
  'app:get-version': 'app.getVersion',
  'app:get-shutdown-status': 'app.getShutdownStatus',

  // System
  'system:get-info': 'system.getInfo',

  // Auth
  'auth:login': 'auth.login',
  'auth:logout': 'auth.logout',
  'auth:get-current-session': 'auth.getCurrentSession',
  'auth:validate-session': 'auth.validateSession',
  'auth:has-permission': 'auth.hasPermission',
  'auth:get-session-stats': 'auth.getSessionStats',
  'auth:setup-pin': 'auth.setupPin',

  // Staff auth
  'staff-auth:authenticate-pin': 'staffAuth.authenticatePin',
  'staff-auth:get-session': 'staffAuth.getSession',
  'staff-auth:get-current': 'staffAuth.getCurrent',
  'staff-auth:has-permission': 'staffAuth.hasPermission',
  'staff-auth:has-any-permission': 'staffAuth.hasAnyPermission',
  'staff-auth:logout': 'staffAuth.logout',
  'staff-auth:validate-session': 'staffAuth.validateSession',
  'staff-auth:track-activity': 'staffAuth.trackActivity',

  // Orders
  'order:get-all': 'orders.getAll',
  'order:get-by-id': 'orders.getById',
  'order:create': 'orders.create',
  'order:update-status': 'orders.updateStatus',
  'order:update-items': 'orders.updateItems',
  'order:delete': 'orders.delete',
  'order:save-from-remote': 'orders.saveFromRemote',
  'order:save-for-retry': 'orders.saveForRetry',
  'order:get-retry-queue': 'orders.getRetryQueue',
  'order:process-retry-queue': 'orders.processRetryQueue',
  'order:approve': 'orders.approve',
  'order:decline': 'orders.decline',
  'order:assign-driver': 'orders.assignDriver',
  'order:notify-platform-ready': 'orders.notifyPlatformReady',
  'order:update-preparation': 'orders.updatePreparation',
  'order:update-type': 'orders.updateType',
  'order:get-by-customer-phone': 'orders.getByCustomerPhone',
  'order:fetch-items-from-supabase': 'orders.fetchItemsFromSupabase',
  'orders:get-conflicts': 'orders.getConflicts',
  'orders:resolve-conflict': 'orders.resolveConflict',
  'orders:force-sync-retry': 'orders.forceSyncRetry',
  'orders:get-retry-info': 'orders.getRetryInfo',
  'orders:clear-all': 'orders.clearAll',

  // Payments
  'payment:update-payment-status': 'payments.updatePaymentStatus',
  'payment:print-receipt': 'payments.printReceipt',
  'kitchen:print-ticket': 'payments.printKitchenTicket',
  'payment:record': 'payments.recordPayment',
  'payment:void': 'payments.voidPayment',
  'payment:get-order-payments': 'payments.getOrderPayments',
  'payment:get-receipt-preview': 'payments.getReceiptPreview',

  // Sync
  'sync:get-status': 'sync.getStatus',
  'sync:force': 'sync.force',
  'sync:get-network-status': 'sync.getNetworkStatus',
  'sync:get-inter-terminal-status': 'sync.getInterTerminalStatus',
  'sync:clear-all': 'sync.clearAll',
  'sync:clear-failed': 'sync.clearFailed',
  'sync:clear-old-orders': 'sync.clearOldOrders',
  'sync:clear-all-orders': 'sync.clearAllOrders',
  'sync:cleanup-deleted-orders': 'sync.cleanupDeletedOrders',
  'sync:get-financial-stats': 'sync.getFinancialStats',
  'sync:get-failed-financial-items': 'sync.getFailedFinancialItems',
  'sync:retry-financial-item': 'sync.retryFinancialItem',
  'sync:retry-all-failed-financial': 'sync.retryAllFailedFinancial',
  'sync:get-unsynced-financial-summary': 'sync.getUnsyncedFinancialSummary',
  'sync:validate-financial-integrity': 'sync.validateFinancialIntegrity',
  'sync:requeue-orphaned-financial': 'sync.requeueOrphanedFinancial',
  'sync:test-parent-connection': 'sync.testParentConnection',
  'sync:rediscover-parent': 'sync.rediscoverParent',
  'sync:fetch-tables': 'sync.fetchTables',
  'sync:fetch-reservations': 'sync.fetchReservations',
  'sync:validate-pending-orders': 'sync.validatePendingOrders',
  'sync:remove-invalid-orders': 'sync.removeInvalidOrders',
  'sync:fetch-suppliers': 'sync.fetchSuppliers',
  'sync:fetch-analytics': 'sync.fetchAnalytics',
  'sync:fetch-orders': 'sync.fetchOrders',
  'sync:fetch-rooms': 'sync.fetchRooms',
  'sync:update-room-status': 'sync.updateRoomStatus',
  'sync:fetch-drive-thru': 'sync.fetchDriveThru',
  'sync:update-drive-thru-order-status': 'sync.updateDriveThruOrderStatus',

  // Customers
  'customer:invalidate-cache': 'customers.invalidateCache',
  'customer:get-cache-stats': 'customers.getCacheStats',
  'customer:clear-cache': 'customers.clearCache',
  'customer:lookup-by-phone': 'customers.lookupByPhone',
  'customer:lookup-by-id': 'customers.lookupById',
  'customer:search': 'customers.search',
  'customer:create': 'customers.create',
  'customer:update': 'customers.update',
  'customer:update-ban-status': 'customers.updateBanStatus',
  'customer:add-address': 'customers.addAddress',
  'customer:update-address': 'customers.updateAddress',
  'customer:resolve-conflict': 'customers.resolveConflict',
  'customer:get-conflicts': 'customers.getConflicts',

  // Settings
  'get-settings': 'settings.get',
  'update-settings': 'settings.set',
  'settings:get': 'settings.get',
  'settings:get-local': 'settings.getLocal',
  'settings:update-local': 'settings.updateLocal',
  'settings:set': 'settings.set',
  'settings:get-discount-max': 'settings.getDiscountMax',
  'settings:set-discount-max': 'settings.setDiscountMax',
  'settings:get-tax-rate': 'settings.getTaxRate',
  'settings:set-tax-rate': 'settings.setTaxRate',
  'settings:get-language': 'settings.getLanguage',
  'settings:set-language': 'settings.setLanguage',
  'settings:get-admin-url': 'settings.getAdminUrl',
  'settings:clear-connection': 'settings.clearConnection',
  'settings:update-terminal-credentials': 'settings.updateTerminalCredentials',
  'settings:is-configured': 'settings.isConfigured',
  'settings:factory-reset': 'settings.factoryReset',

  // Terminal config
  'terminal-config:get-settings': 'terminalConfig.getSettings',
  'terminal-config:get-setting': 'terminalConfig.getSetting',
  'terminal-config:get-branch-id': 'terminalConfig.getBranchId',
  'terminal-config:get-terminal-id': 'terminalConfig.getTerminalId',
  'terminal-config:refresh': 'terminalConfig.refresh',
  'terminal-config:get-organization-id': 'terminalConfig.getOrganizationId',
  'terminal-config:get-business-type': 'terminalConfig.getBusinessType',
  'terminal-config:get-full-config': 'terminalConfig.getFullConfig',

  // Shifts
  'shift:open': 'shifts.open',
  'shift:close': 'shifts.close',
  'shift:get-active': 'shifts.getActive',
  'shift:get-active-by-terminal': 'shifts.getActiveByTerminal',
  'shift:get-active-by-terminal-loose': 'shifts.getActiveByTerminalLoose',
  'shift:get-active-cashier-by-terminal': 'shifts.getActiveCashierByTerminal',
  'shift:list-staff-for-checkin': 'shifts.listStaffForCheckin',
  'shift:get-staff-roles': 'shifts.getStaffRoles',
  'shift:get-summary': 'shifts.getSummary',
  'shift:record-expense': 'shifts.recordExpense',
  'shift:get-expenses': 'shifts.getExpenses',
  'shift:record-staff-payment': 'shifts.recordStaffPayment',
  'shift:get-staff-payments': 'shifts.getStaffPayments',
  'shift:get-staff-payments-by-staff': 'shifts.getStaffPaymentsByStaff',
  'shift:get-staff-payment-total-for-date': 'shifts.getStaffPaymentTotalForDate',
  'shift:get-scheduled-shifts': 'shifts.getScheduledShifts',
  'shift:get-today-scheduled-shifts': 'shifts.getTodayScheduledShifts',
  'shift:backfill-driver-earnings': 'shifts.backfillDriverEarnings',

  // Drivers
  'driver:record-earning': 'drivers.recordEarning',
  'driver:get-earnings': 'drivers.getEarnings',
  'driver:get-shift-summary': 'drivers.getShiftSummary',
  'driver:get-active': 'drivers.getActive',

  // Delivery zones
  'delivery-zone:track-validation': 'deliveryZones.trackValidation',
  'delivery-zone:get-analytics': 'deliveryZones.getAnalytics',
  'delivery-zone:request-override': 'deliveryZones.requestOverride',

  // Reports
  'report:get-today-statistics': 'reports.getTodayStatistics',
  'report:get-sales-trend': 'reports.getSalesTrend',
  'report:get-top-items': 'reports.getTopItems',
  'report:get-weekly-top-items': 'reports.getWeeklyTopItems',
  'report:generate-z-report': 'reports.generateZReport',
  'report:get-daily-staff-performance': 'reports.getDailyStaffPerformance',
  'report:submit-z-report': 'reports.submitZReport',

  // Product dashboard metrics
  'inventory:get-stock-metrics': 'inventory.getStockMetrics',
  'products:get-catalog-count': 'products.getCatalogCount',

  // Menu
  'menu:get-categories': 'menu.getCategories',
  'menu:get-subcategories': 'menu.getSubcategories',
  'menu:get-ingredients': 'menu.getIngredients',
  'menu:get-subcategory-ingredients': 'menu.getSubcategoryIngredients',
  'menu:get-combos': 'menu.getCombos',
  'menu:sync': 'menu.sync',
  'menu:update-category': 'menu.updateCategory',
  'menu:update-subcategory': 'menu.updateSubcategory',
  'menu:update-ingredient': 'menu.updateIngredient',
  'menu:update-combo': 'menu.updateCombo',
  'menu:trigger-check-for-updates': 'menu.triggerCheckForUpdates',

  // Printer
  'printer:list-system-printers': 'printer.listSystemPrinters',
  'printer:scan-network': 'printer.scanNetwork',
  'printer:scan-bluetooth': 'printer.scanBluetooth',
  'printer:discover': 'printer.discover',
  'printer:add': 'printer.add',
  'printer:update': 'printer.update',
  'printer:remove': 'printer.remove',
  'printer:get-all': 'printer.getAll',
  'printer:get': 'printer.get',
  'printer:get-status': 'printer.getStatus',
  'printer:get-all-statuses': 'printer.getAllStatuses',
  'printer:submit-job': 'printer.submitJob',
  'printer:cancel-job': 'printer.cancelJob',
  'printer:retry-job': 'printer.retryJob',
  'printer:test': 'printer.test',
  'printer:test-greek-direct': 'printer.testGreekDirect',
  'printer:diagnostics': 'printer.diagnostics',
  'printer:bluetooth-status': 'printer.bluetoothStatus',
  'printer:open-cash-drawer': 'printer.openCashDrawer',

  // Printer profiles (Tauri-native)
  'printer:create-profile': 'printer.createProfile',
  'printer:update-profile': 'printer.updateProfile',
  'printer:delete-profile': 'printer.deleteProfile',
  'printer:list-profiles': 'printer.listProfiles',
  'printer:get-profile': 'printer.getProfile',
  'printer:set-default-profile': 'printer.setDefaultProfile',
  'printer:get-default-profile': 'printer.getDefaultProfile',
  'print:reprint-job': 'printer.reprintJob',

  // ECR
  'ecr:discover-devices': 'ecr.discoverDevices',
  'ecr:get-devices': 'ecr.getDevices',
  'ecr:get-device': 'ecr.getDevice',
  'ecr:add-device': 'ecr.addDevice',
  'ecr:update-device': 'ecr.updateDevice',
  'ecr:remove-device': 'ecr.removeDevice',
  'ecr:get-default-terminal': 'ecr.getDefaultTerminal',
  'ecr:connect-device': 'ecr.connectDevice',
  'ecr:disconnect-device': 'ecr.disconnectDevice',
  'ecr:get-device-status': 'ecr.getDeviceStatus',
  'ecr:get-all-statuses': 'ecr.getAllStatuses',
  'ecr:process-payment': 'ecr.processPayment',
  'ecr:process-refund': 'ecr.processRefund',
  'ecr:void-transaction': 'ecr.voidTransaction',
  'ecr:cancel-transaction': 'ecr.cancelTransaction',
  'ecr:settlement': 'ecr.settlement',
  'ecr:get-recent-transactions': 'ecr.getRecentTransactions',
  'ecr:query-transactions': 'ecr.queryTransactions',
  'ecr:get-transaction-stats': 'ecr.getTransactionStats',
  'ecr:get-transaction-for-order': 'ecr.getTransactionForOrder',

  // Modules
  'modules:fetch-from-admin': 'modules.fetchFromAdmin',
  'modules:get-cached': 'modules.getCached',
  'modules:save-cache': 'modules.saveCache',

  // Updates
  'update:check': 'updates.check',
  'update:download': 'updates.download',
  'update:cancel-download': 'updates.cancelDownload',
  'update:install': 'updates.install',
  'update:get-state': 'updates.getState',
  'update:set-channel': 'updates.setChannel',

  // Window
  'window-minimize': 'window.minimize',
  'window-maximize': 'window.maximize',
  'window-close': 'window.close',
  'window-toggle-fullscreen': 'window.toggleFullscreen',
  'window-get-state': 'window.getState',
  'window-reload': 'window.reload',
  'window-force-reload': 'window.forceReload',
  'window-toggle-devtools': 'window.toggleDevtools',
  'window-zoom-in': 'window.zoomIn',
  'window-zoom-out': 'window.zoomOut',
  'window-zoom-reset': 'window.zoomReset',

  // Admin API
  'api:fetch-from-admin': 'adminApi.fetchFromAdmin',

  // Database
  'database:health-check': 'database.healthCheck',
  'database:get-stats': 'database.getStats',
  'database:reset': 'database.reset',
  'database:clear-operational-data': 'database.clearOperationalData',

  // Clipboard
  'clipboard:read-text': 'clipboard.readText',
  'clipboard:write-text': 'clipboard.writeText',

  // Notifications
  'show-notification': 'notifications.show',

  // Screen capture
  'screen-capture:get-sources': 'screenCapture.getSources',

  // Refunds / Adjustments
  'refund:payment': 'refunds.refundPayment',
  'refund:list-order-adjustments': 'refunds.listOrderAdjustments',
  'refund:get-payment-balance': 'refunds.getPaymentBalance',

  // Diagnostics
  'diagnostics:get-about': 'diagnostics.getAbout',
  'diagnostics:get-system-health': 'diagnostics.getSystemHealth',
  'diagnostics:export': 'diagnostics.export',

  // Service dashboard metrics
  'rooms:get-availability': 'rooms.getAvailability',
  'appointments:get-today-metrics': 'appointments.getTodayMetrics',

  // Geo
  'geo:ip': 'geo.ip',

  // Labels
  'label:print': 'labels.print',
  'label:print-batch': 'labels.printBatch',
};

// ============================================================================
// TauriBridge Implementation
// ============================================================================

/**
 * Tauri implementation of PlatformBridge.
 *
 * Maps each typed method to a Tauri `invoke()` call. The Rust command names
 * use snake_case by convention, derived from the Electron channel names.
 *
 * Example: Electron `auth:login` -> Tauri command `auth_login`
 */
export class TauriBridge implements PlatformBridge {
  private tauriInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;

  constructor() {
    this.tauriInvoke = async (cmd: string, args?: Record<string, unknown>) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke(cmd, args);
    };
  }

  private toCmd(channel: string): string {
    return channel.replace(/[:\-]/g, '_');
  }

  // Raw invoke -- packs positional args into { arg0, arg1, ... } to match
  // the Rust command signatures which use arg0: Option<Value>, arg1: Option<Value>, etc.
  async invoke(channel: string, ...args: any[]): Promise<any> {
    const cmd = this.toCmd(channel);
    if (args.length === 0) return this.tauriInvoke(cmd);
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i++) payload[`arg${i}`] = args[i];
    return this.tauriInvoke(cmd, payload);
  }

  // Shorthand for namespaced invoke
  private inv(channel: string, ...args: any[]) {
    return this.invoke(channel, ...args);
  }

  app = {
    shutdown: () => this.inv('app:shutdown'),
    restart: () => this.inv('app:restart'),
    getVersion: () => this.inv('app:get-version'),
    getShutdownStatus: () => this.inv('app:get-shutdown-status'),
  };

  system = {
    getInfo: () => this.inv('system:get-info'),
  };

  auth = {
    login: (pin: string) => this.inv('auth:login', pin),
    logout: () => this.inv('auth:logout'),
    getCurrentSession: () => this.inv('auth:get-current-session'),
    validateSession: () => this.inv('auth:validate-session'),
    hasPermission: (p: string) => this.inv('auth:has-permission', p),
    getSessionStats: () => this.inv('auth:get-session-stats'),
    setupPin: (pin: string) => this.inv('auth:setup-pin', pin),
  };

  staffAuth = {
    authenticatePin: (pin: string) => this.inv('staff-auth:authenticate-pin', pin),
    getSession: () => this.inv('staff-auth:get-session'),
    getCurrent: () => this.inv('staff-auth:get-current'),
    hasPermission: (p: string) => this.inv('staff-auth:has-permission', p),
    hasAnyPermission: (ps: string[]) => this.inv('staff-auth:has-any-permission', ps),
    logout: () => this.inv('staff-auth:logout'),
    validateSession: () => this.inv('staff-auth:validate-session'),
    trackActivity: () => this.inv('staff-auth:track-activity'),
  };

  orders = {
    getAll: () => this.inv('order:get-all'),
    getById: (id: string) => this.inv('order:get-by-id', id),
    getByCustomerPhone: (phone: string) => this.inv('order:get-by-customer-phone', phone),
    create: (p: CreateOrderPayload) => this.inv('order:create', p),
    updateStatus: (id: string, s: string) => this.inv('order:update-status', id, s),
    updateItems: (id: string, items: OrderItem[]) => this.inv('order:update-items', id, items),
    delete: (id: string) => this.inv('order:delete', id),
    saveFromRemote: (o: any) => this.inv('order:save-from-remote', o),
    saveForRetry: (o: any) => this.inv('order:save-for-retry', o),
    getRetryQueue: () => this.inv('order:get-retry-queue'),
    processRetryQueue: () => this.inv('order:process-retry-queue'),
    approve: (id: string, t?: number) => this.inv('order:approve', id, t),
    decline: (id: string, r: string) => this.inv('order:decline', id, r),
    assignDriver: (id: string, d: string, n?: string) => this.inv('order:assign-driver', id, d, n),
    notifyPlatformReady: (id: string) => this.inv('order:notify-platform-ready', id),
    updatePreparation: (id: string, s: string, p: number, m?: string) => this.inv('order:update-preparation', id, s, p, m),
    updateType: (id: string, t: string) => this.inv('order:update-type', id, t),
    fetchItemsFromSupabase: (id: string) => this.inv('order:fetch-items-from-supabase', id),
    getConflicts: () => this.inv('orders:get-conflicts'),
    resolveConflict: (cid: string, s: string, d?: any) => this.inv('orders:resolve-conflict', cid, s, d),
    forceSyncRetry: (id: string) => this.inv('orders:force-sync-retry', id),
    getRetryInfo: (id: string) => this.inv('orders:get-retry-info', id),
    clearAll: () => this.inv('orders:clear-all'),
  };

  payments = {
    updatePaymentStatus: (id: string, s: string, m?: string) => this.inv('payment:update-payment-status', id, s, m),
    printReceipt: (data: any, type?: string) => this.inv('payment:print-receipt', data, type),
    printKitchenTicket: (data: any) => this.inv('kitchen:print-ticket', data),
    recordPayment: (p: RecordPaymentParams) => this.inv('payment:record', p),
    voidPayment: (id: string, reason: string, by?: string) => this.inv('payment:void', id, reason, by),
    getOrderPayments: (orderId: string) => this.inv('payment:get-order-payments', orderId),
    getReceiptPreview: (orderId: string) => this.inv('payment:get-receipt-preview', orderId),
  };

  sync = {
    getStatus: () => this.inv('sync:get-status'),
    force: () => this.inv('sync:force'),
    getNetworkStatus: () => this.inv('sync:get-network-status'),
    getInterTerminalStatus: () => this.inv('sync:get-inter-terminal-status'),
    clearAll: () => this.inv('sync:clear-all'),
    clearFailed: () => this.inv('sync:clear-failed'),
    clearOldOrders: () => this.inv('sync:clear-old-orders'),
    clearAllOrders: () => this.inv('sync:clear-all-orders'),
    cleanupDeletedOrders: () => this.inv('sync:cleanup-deleted-orders'),
    getFinancialStats: () => this.inv('sync:get-financial-stats'),
    getFailedFinancialItems: (limit?: number) => this.inv('sync:get-failed-financial-items', limit),
    retryFinancialItem: (id: string) => this.inv('sync:retry-financial-item', id),
    retryAllFailedFinancial: () => this.inv('sync:retry-all-failed-financial'),
    getUnsyncedFinancialSummary: () => this.inv('sync:get-unsynced-financial-summary'),
    validateFinancialIntegrity: () => this.inv('sync:validate-financial-integrity'),
    requeueOrphanedFinancial: () => this.inv('sync:requeue-orphaned-financial'),
    testParentConnection: () => this.inv('sync:test-parent-connection'),
    rediscoverParent: () => this.inv('sync:rediscover-parent'),
    fetchTables: () => this.inv('sync:fetch-tables'),
    fetchReservations: () => this.inv('sync:fetch-reservations'),
    fetchSuppliers: () => this.inv('sync:fetch-suppliers'),
    fetchAnalytics: () => this.inv('sync:fetch-analytics'),
    fetchOrders: () => this.inv('sync:fetch-orders'),
    fetchRooms: (opts?: any) => this.inv('sync:fetch-rooms', opts),
    updateRoomStatus: (roomId: string, status: string) => this.inv('sync:update-room-status', roomId, status),
    fetchDriveThru: (opts?: any) => this.inv('sync:fetch-drive-thru', opts),
    updateDriveThruOrderStatus: (id: string, status: string) => this.inv('sync:update-drive-thru-order-status', id, status),
  };

  customers = {
    invalidateCache: (phone: string) => this.inv('customer:invalidate-cache', phone),
    getCacheStats: () => this.inv('customer:get-cache-stats'),
    clearCache: () => this.inv('customer:clear-cache'),
    lookupByPhone: (phone: string) => this.inv('customer:lookup-by-phone', phone),
    lookupById: (id: string) => this.inv('customer:lookup-by-id', id),
    search: (q: string) => this.inv('customer:search', q),
    create: (d: Partial<Customer>) => this.inv('customer:create', d),
    update: (id: string, u: Partial<Customer>, v: number) => this.inv('customer:update', id, u, v),
    updateBanStatus: (id: string, b: boolean) => this.inv('customer:update-ban-status', id, b),
    addAddress: (id: string, a: Partial<CustomerAddress>) => this.inv('customer:add-address', id, a),
    updateAddress: (id: string, u: Partial<CustomerAddress>, v: number) => this.inv('customer:update-address', id, u, v),
    resolveConflict: (cid: string, s: string, d?: any) => this.inv('customer:resolve-conflict', cid, s, d),
    getConflicts: (f?: any) => this.inv('customer:get-conflicts', f),
  };

  settings = {
    get: (k?: string) => k ? this.inv('settings:get', k) : this.inv('get-settings'),
    getLocal: (k?: string) => k ? this.inv('settings:get-local', k) : this.inv('settings:get-local'),
    updateLocal: (k: string, v: any) => this.inv('settings:update-local', k, v),
    set: (k: string, v: any) => this.inv('settings:set', k, v),
    getDiscountMax: () => this.inv('settings:get-discount-max'),
    setDiscountMax: (p: number) => this.inv('settings:set-discount-max', p),
    getTaxRate: () => this.inv('settings:get-tax-rate'),
    setTaxRate: (p: number) => this.inv('settings:set-tax-rate', p),
    getLanguage: () => this.inv('settings:get-language'),
    setLanguage: (l: string) => this.inv('settings:set-language', l),
    getAdminUrl: () => this.inv('settings:get-admin-url'),
    clearConnection: () => this.inv('settings:clear-connection'),
    updateTerminalCredentials: (p: UpdateTerminalCredentialsPayload) => this.inv('settings:update-terminal-credentials', p),
    isConfigured: () => this.inv('settings:is-configured'),
    factoryReset: () => this.inv('settings:factory-reset'),
  };

  terminalConfig = {
    getSettings: () => this.inv('terminal-config:get-settings'),
    getSetting: (s: string, k: string) => this.inv('terminal-config:get-setting', s, k),
    getBranchId: () => this.inv('terminal-config:get-branch-id'),
    getTerminalId: () => this.inv('terminal-config:get-terminal-id'),
    refresh: () => this.inv('terminal-config:refresh'),
    getOrganizationId: () => this.inv('terminal-config:get-organization-id'),
    getBusinessType: () => this.inv('terminal-config:get-business-type'),
    getFullConfig: () => this.inv('terminal-config:get-full-config'),
  };

  shifts = {
    open: (p: OpenShiftParams) => this.inv('shift:open', p),
    close: (p: CloseShiftParams) => this.inv('shift:close', p),
    getActive: (staffId: string) => this.inv('shift:get-active', staffId),
    getActiveByTerminal: (b: string, t: string) => this.inv('shift:get-active-by-terminal', b, t),
    getActiveByTerminalLoose: (t: string) => this.inv('shift:get-active-by-terminal-loose', t),
    getActiveCashierByTerminal: (b: string, t: string) => this.inv('shift:get-active-cashier-by-terminal', b, t),
    listStaffForCheckin: (branchId?: string) => this.inv('shift:list-staff-for-checkin', branchId),
    getStaffRoles: (staffIds?: string[]) => this.inv('shift:get-staff-roles', staffIds),
    getSummary: (id: string, opts?: { skipBackfill?: boolean }) => this.inv('shift:get-summary', id, opts),
    recordExpense: (p: RecordExpenseParams) => this.inv('shift:record-expense', p),
    getExpenses: (id: string) => this.inv('shift:get-expenses', id),
    recordStaffPayment: (p: RecordStaffPaymentParams) => this.inv('shift:record-staff-payment', p),
    getStaffPayments: (id: string) => this.inv('shift:get-staff-payments', id),
    getStaffPaymentsByStaff: (params: any) => this.inv('shift:get-staff-payments-by-staff', params),
    getStaffPaymentTotalForDate: (staffId: string, date: string) => this.inv('shift:get-staff-payment-total-for-date', staffId, date),
    getScheduledShifts: (params: any) => this.inv('shift:get-scheduled-shifts', params),
    getTodayScheduledShifts: (branchId: string) => this.inv('shift:get-today-scheduled-shifts', branchId),
    backfillDriverEarnings: (p: { shiftId?: string; date?: string }) => this.inv('shift:backfill-driver-earnings', p),
  };

  drivers = {
    recordEarning: (p: any) => this.inv('driver:record-earning', p),
    getEarnings: (id: string) => this.inv('driver:get-earnings', id),
    getShiftSummary: (id: string) => this.inv('driver:get-shift-summary', id),
    getActive: (branchId: string) => this.inv('driver:get-active', branchId),
  };

  deliveryZones = {
    trackValidation: (d: any) => this.inv('delivery-zone:track-validation', d),
    getAnalytics: (f?: any) => this.inv('delivery-zone:get-analytics', f),
    requestOverride: (d: any) => this.inv('delivery-zone:request-override', d),
  };

  reports = {
    getTodayStatistics: (p: { branchId: string }) => this.inv('report:get-today-statistics', p),
    getSalesTrend: (p: { branchId: string; days: number }) => this.inv('report:get-sales-trend', p),
    getTopItems: (p: { branchId: string; date?: string; limit?: number }) => this.inv('report:get-top-items', p),
    getWeeklyTopItems: (p: { branchId: string; limit?: number }) => this.inv('report:get-weekly-top-items', p),
    generateZReport: (p: { branchId: string; date?: string }) => this.inv('report:generate-z-report', p),
    getDailyStaffPerformance: (p: { branchId: string; date?: string }) => this.inv('report:get-daily-staff-performance', p),
    submitZReport: (p: { branchId: string; date?: string }) => this.inv('report:submit-z-report', p),
  };

  menu = {
    sync: () => this.inv('menu:sync'),
    getCategories: () => this.inv('menu:get-categories'),
    getSubcategories: () => this.inv('menu:get-subcategories'),
    getIngredients: () => this.inv('menu:get-ingredients'),
    getSubcategoryIngredients: (id: string) => this.inv('menu:get-subcategory-ingredients', id),
    getCombos: () => this.inv('menu:get-combos'),
    updateCategory: (id: string, u: any) => this.inv('menu:update-category', id, u),
    updateSubcategory: (id: string, u: any) => this.inv('menu:update-subcategory', id, u),
    updateIngredient: (id: string, u: any) => this.inv('menu:update-ingredient', id, u),
    updateCombo: (id: string, u: any) => this.inv('menu:update-combo', id, u),
    triggerCheckForUpdates: () => this.inv('menu:trigger-check-for-updates'),
  };

  printer = {
    listSystemPrinters: () => this.inv('printer:list-system-printers'),
    scanNetwork: () => this.inv('printer:scan-network'),
    scanBluetooth: () => this.inv('printer:scan-bluetooth'),
    discover: (types?: string[]) => this.inv('printer:discover', types),
    add: (c: Partial<PrinterConfig>) => this.inv('printer:add', c),
    update: (id: string, u: Partial<PrinterConfig>) => this.inv('printer:update', id, u),
    remove: (id: string) => this.inv('printer:remove', id),
    getAll: () => this.inv('printer:get-all'),
    get: (id: string) => this.inv('printer:get', id),
    getStatus: (id: string) => this.inv('printer:get-status', id),
    getAllStatuses: () => this.inv('printer:get-all-statuses'),
    submitJob: (j: any) => this.inv('printer:submit-job', j),
    cancelJob: (id: string) => this.inv('printer:cancel-job', id),
    retryJob: (id: string) => this.inv('printer:retry-job', id),
    test: (id: string) => this.inv('printer:test', id),
    testGreekDirect: (mode: string, name?: string) => this.inv('printer:test-greek-direct', mode, name),
    diagnostics: (id: string) => this.inv('printer:diagnostics', id),
    bluetoothStatus: () => this.inv('printer:bluetooth-status'),
    openCashDrawer: (id?: string, drawer?: 1 | 2) => this.inv('printer:open-cash-drawer', id, drawer),
    createProfile: (p: any) => this.inv('printer:create-profile', p),
    updateProfile: (p: any) => this.inv('printer:update-profile', p),
    deleteProfile: (id: string) => this.inv('printer:delete-profile', id),
    listProfiles: () => this.inv('printer:list-profiles'),
    getProfile: (id: string) => this.inv('printer:get-profile', id),
    setDefaultProfile: (id: string) => this.inv('printer:set-default-profile', id),
    getDefaultProfile: () => this.inv('printer:get-default-profile'),
    reprintJob: (id: string) => this.inv('print:reprint-job', id),
  };

  ecr = {
    discoverDevices: (types?: string[], timeout?: number) => this.inv('ecr:discover-devices', types, timeout),
    getDevices: () => this.inv('ecr:get-devices'),
    getDevice: (id: string) => this.inv('ecr:get-device', id),
    addDevice: (c: any) => this.inv('ecr:add-device', c),
    updateDevice: (id: string, u: any) => this.inv('ecr:update-device', id, u),
    removeDevice: (id: string) => this.inv('ecr:remove-device', id),
    getDefaultTerminal: () => this.inv('ecr:get-default-terminal'),
    connectDevice: (id: string) => this.inv('ecr:connect-device', id),
    disconnectDevice: (id: string) => this.inv('ecr:disconnect-device', id),
    getDeviceStatus: (id: string) => this.inv('ecr:get-device-status', id),
    getAllStatuses: () => this.inv('ecr:get-all-statuses'),
    processPayment: (amt: number, o?: EcrPaymentOptions) => this.inv('ecr:process-payment', amt, o),
    processRefund: (amt: number, o?: EcrRefundOptions) => this.inv('ecr:process-refund', amt, o),
    voidTransaction: (tid: string, did?: string) => this.inv('ecr:void-transaction', tid, did),
    cancelTransaction: (did: string) => this.inv('ecr:cancel-transaction', did),
    settlement: (did?: string) => this.inv('ecr:settlement', did),
    getRecentTransactions: (limit?: number) => this.inv('ecr:get-recent-transactions', limit),
    queryTransactions: (f: any) => this.inv('ecr:query-transactions', f),
    getTransactionStats: (f?: any) => this.inv('ecr:get-transaction-stats', f),
    getTransactionForOrder: (oid: string) => this.inv('ecr:get-transaction-for-order', oid),
  };

  modules = {
    fetchFromAdmin: () => this.inv('modules:fetch-from-admin'),
    getCached: () => this.inv('modules:get-cached'),
    saveCache: (m: any[]) => this.inv('modules:save-cache', m),
  };

  updates = {
    check: () => this.inv('update:check'),
    download: () => this.inv('update:download'),
    cancelDownload: () => this.inv('update:cancel-download'),
    install: () => this.inv('update:install'),
    getState: () => this.inv('update:get-state'),
    setChannel: (ch: 'stable' | 'beta') => this.inv('update:set-channel', ch),
  };

  window = {
    minimize: () => this.inv('window-minimize'),
    maximize: () => this.inv('window-maximize'),
    close: () => this.inv('window-close'),
    toggleFullscreen: () => this.inv('window-toggle-fullscreen'),
    getState: () => this.inv('window-get-state'),
    reload: async () => { globalThis.location.reload(); },
    forceReload: async () => { globalThis.location.reload(); },
    toggleDevtools: () => this.inv('window-toggle-devtools'),
    zoomIn: () => this.inv('window-zoom-in'),
    zoomOut: () => this.inv('window-zoom-out'),
    zoomReset: () => this.inv('window-zoom-reset'),
  };

  adminApi = {
    fetchFromAdmin: (path: string, opts?: any) => this.inv('api:fetch-from-admin', path, opts),
  };

  database = {
    healthCheck: () => this.inv('database:health-check'),
    getStats: () => this.inv('database:get-stats'),
    reset: () => this.inv('database:reset'),
    clearOperationalData: () => this.inv('database:clear-operational-data'),
  };

  clipboard = {
    readText: () => this.inv('clipboard:read-text'),
    writeText: (text: string) => this.inv('clipboard:write-text', text),
  };

  notifications = {
    show: (data: any) => this.inv('show-notification', data),
  };

  screenCapture = {
    getSources: (opts: { types: string[] }) => this.inv('screen-capture:get-sources', opts),
  };

  geo = {
    ip: () => this.inv('geo:ip'),
  };

  labels = {
    print: (req: any, pid?: string) => this.inv('label:print', req, pid),
    printBatch: (items: any[], lt?: string, pid?: string) => this.inv('label:print-batch', items, lt, pid),
  };

  refunds = {
    refundPayment: (params: { paymentId: string; amount: number; reason: string; staffId?: string; orderId?: string }) =>
      this.inv('refund:payment', params),
    listOrderAdjustments: (orderId: string) => this.inv('refund:list-order-adjustments', orderId),
    getPaymentBalance: (paymentId: string) => this.inv('refund:get-payment-balance', paymentId),
  };

  diagnostics = {
    getAbout: () => this.inv('diagnostics:get-about'),
    getSystemHealth: () => this.inv('diagnostics:get-system-health'),
    export: () => this.inv('diagnostics:export'),
  };
}

// ============================================================================
// ElectronBridge Implementation
// ============================================================================

/**
 * Electron passthrough bridge.
 *
 * Delegates every call to the real `window.electron.ipcRenderer.invoke()`.
 * This is used when running inside the existing Electron shell so the typed
 * interface still works but no behavior changes.
 */
export class ElectronBridge implements PlatformBridge {
  private ipc(channel: string, ...args: any[]): Promise<any> {
    const electron =
      (window as any).electron?.ipcRenderer ??
      (window as any).electronAPI?.ipcRenderer;
    if (!electron) {
      return Promise.reject(new Error(`Electron IPC not available for channel: ${channel}`));
    }
    return electron.invoke(channel, ...args);
  }

  async invoke(channel: string, ...args: any[]): Promise<any> {
    return this.ipc(channel, ...args);
  }

  app = {
    shutdown: () => this.ipc('app:shutdown'),
    restart: () => this.ipc('app:restart'),
    getVersion: () => this.ipc('app:get-version'),
    getShutdownStatus: () => this.ipc('app:get-shutdown-status'),
  };

  system = {
    getInfo: () => this.ipc('system:get-info'),
  };

  auth = {
    login: (pin: string) => this.ipc('auth:login', pin),
    logout: () => this.ipc('auth:logout'),
    getCurrentSession: () => this.ipc('auth:get-current-session'),
    validateSession: () => this.ipc('auth:validate-session'),
    hasPermission: (p: string) => this.ipc('auth:has-permission', p),
    getSessionStats: () => this.ipc('auth:get-session-stats'),
    setupPin: (pin: string) => this.ipc('auth:setup-pin', pin),
  };

  staffAuth = {
    authenticatePin: (pin: string) => this.ipc('staff-auth:authenticate-pin', pin),
    getSession: () => this.ipc('staff-auth:get-session'),
    getCurrent: () => this.ipc('staff-auth:get-current'),
    hasPermission: (p: string) => this.ipc('staff-auth:has-permission', p),
    hasAnyPermission: (ps: string[]) => this.ipc('staff-auth:has-any-permission', ps),
    logout: () => this.ipc('staff-auth:logout'),
    validateSession: () => this.ipc('staff-auth:validate-session'),
    trackActivity: () => this.ipc('staff-auth:track-activity'),
  };

  orders = {
    getAll: () => this.ipc('order:get-all'),
    getById: (id: string) => this.ipc('order:get-by-id', id),
    getByCustomerPhone: (phone: string) => this.ipc('order:get-by-customer-phone', phone),
    create: (p: CreateOrderPayload) => this.ipc('order:create', p),
    updateStatus: (id: string, s: string) => this.ipc('order:update-status', id, s),
    updateItems: (id: string, items: OrderItem[]) => this.ipc('order:update-items', id, items),
    delete: (id: string) => this.ipc('order:delete', id),
    saveFromRemote: (o: any) => this.ipc('order:save-from-remote', o),
    saveForRetry: (o: any) => this.ipc('order:save-for-retry', o),
    getRetryQueue: () => this.ipc('order:get-retry-queue'),
    processRetryQueue: () => this.ipc('order:process-retry-queue'),
    approve: (id: string, t?: number) => this.ipc('order:approve', id, t),
    decline: (id: string, r: string) => this.ipc('order:decline', id, r),
    assignDriver: (id: string, d: string, n?: string) => this.ipc('order:assign-driver', id, d, n),
    notifyPlatformReady: (id: string) => this.ipc('order:notify-platform-ready', id),
    updatePreparation: (id: string, s: string, p: number, m?: string) => this.ipc('order:update-preparation', id, s, p, m),
    updateType: (id: string, t: string) => this.ipc('order:update-type', id, t),
    fetchItemsFromSupabase: (id: string) => this.ipc('order:fetch-items-from-supabase', id),
    getConflicts: () => this.ipc('orders:get-conflicts'),
    resolveConflict: (cid: string, s: string, d?: any) => this.ipc('orders:resolve-conflict', cid, s, d),
    forceSyncRetry: (id: string) => this.ipc('orders:force-sync-retry', id),
    getRetryInfo: (id: string) => this.ipc('orders:get-retry-info', id),
    clearAll: () => this.ipc('orders:clear-all'),
  };

  payments = {
    updatePaymentStatus: (id: string, s: string, m?: string) => this.ipc('payment:update-payment-status', id, s, m),
    printReceipt: (data: any, type?: string) => this.ipc('payment:print-receipt', data, type),
    printKitchenTicket: (data: any) => this.ipc('kitchen:print-ticket', data),
    recordPayment: (p: RecordPaymentParams) => this.ipc('payment:record', p),
    voidPayment: (id: string, reason: string, by?: string) => this.ipc('payment:void', id, reason, by),
    getOrderPayments: (orderId: string) => this.ipc('payment:get-order-payments', orderId),
    getReceiptPreview: (orderId: string) => this.ipc('payment:get-receipt-preview', orderId),
  };

  sync = {
    getStatus: () => this.ipc('sync:get-status'),
    force: () => this.ipc('sync:force'),
    getNetworkStatus: () => this.ipc('sync:get-network-status'),
    getInterTerminalStatus: () => this.ipc('sync:get-inter-terminal-status'),
    clearAll: () => this.ipc('sync:clear-all'),
    clearFailed: () => this.ipc('sync:clear-failed'),
    clearOldOrders: () => this.ipc('sync:clear-old-orders'),
    clearAllOrders: () => this.ipc('sync:clear-all-orders'),
    cleanupDeletedOrders: () => this.ipc('sync:cleanup-deleted-orders'),
    getFinancialStats: () => this.ipc('sync:get-financial-stats'),
    getFailedFinancialItems: (limit?: number) => this.ipc('sync:get-failed-financial-items', limit),
    retryFinancialItem: (id: string) => this.ipc('sync:retry-financial-item', id),
    retryAllFailedFinancial: () => this.ipc('sync:retry-all-failed-financial'),
    getUnsyncedFinancialSummary: () => this.ipc('sync:get-unsynced-financial-summary'),
    validateFinancialIntegrity: () => this.ipc('sync:validate-financial-integrity'),
    requeueOrphanedFinancial: () => this.ipc('sync:requeue-orphaned-financial'),
    testParentConnection: () => this.ipc('sync:test-parent-connection'),
    rediscoverParent: () => this.ipc('sync:rediscover-parent'),
    fetchTables: () => this.ipc('sync:fetch-tables'),
    fetchReservations: () => this.ipc('sync:fetch-reservations'),
    fetchSuppliers: () => this.ipc('sync:fetch-suppliers'),
    fetchAnalytics: () => this.ipc('sync:fetch-analytics'),
    fetchOrders: () => this.ipc('sync:fetch-orders'),
    fetchRooms: (opts?: any) => this.ipc('sync:fetch-rooms', opts),
    updateRoomStatus: (roomId: string, status: string) => this.ipc('sync:update-room-status', roomId, status),
    fetchDriveThru: (opts?: any) => this.ipc('sync:fetch-drive-thru', opts),
    updateDriveThruOrderStatus: (id: string, status: string) => this.ipc('sync:update-drive-thru-order-status', id, status),
  };

  customers = {
    invalidateCache: (phone: string) => this.ipc('customer:invalidate-cache', phone),
    getCacheStats: () => this.ipc('customer:get-cache-stats'),
    clearCache: () => this.ipc('customer:clear-cache'),
    lookupByPhone: (phone: string) => this.ipc('customer:lookup-by-phone', phone),
    lookupById: (id: string) => this.ipc('customer:lookup-by-id', id),
    search: (q: string) => this.ipc('customer:search', q),
    create: (d: Partial<Customer>) => this.ipc('customer:create', d),
    update: (id: string, u: Partial<Customer>, v: number) => this.ipc('customer:update', id, u, v),
    updateBanStatus: (id: string, b: boolean) => this.ipc('customer:update-ban-status', id, b),
    addAddress: (id: string, a: Partial<CustomerAddress>) => this.ipc('customer:add-address', id, a),
    updateAddress: (id: string, u: Partial<CustomerAddress>, v: number) => this.ipc('customer:update-address', id, u, v),
    resolveConflict: (cid: string, s: string, d?: any) => this.ipc('customer:resolve-conflict', cid, s, d),
    getConflicts: (f?: any) => this.ipc('customer:get-conflicts', f),
  };

  settings = {
    get: (k?: string) => k ? this.ipc('settings:get', k) : this.ipc('get-settings'),
    getLocal: (k?: string) => k ? this.ipc('settings:get-local', k) : this.ipc('settings:get-local'),
    updateLocal: (k: string, v: any) => this.ipc('settings:update-local', k, v),
    set: (k: string, v: any) => this.ipc('settings:set', k, v),
    getDiscountMax: () => this.ipc('settings:get-discount-max'),
    setDiscountMax: (p: number) => this.ipc('settings:set-discount-max', p),
    getTaxRate: () => this.ipc('settings:get-tax-rate'),
    setTaxRate: (p: number) => this.ipc('settings:set-tax-rate', p),
    getLanguage: () => this.ipc('settings:get-language'),
    setLanguage: (l: string) => this.ipc('settings:set-language', l),
    getAdminUrl: () => this.ipc('settings:get-admin-url'),
    clearConnection: () => this.ipc('settings:clear-connection'),
    updateTerminalCredentials: (p: UpdateTerminalCredentialsPayload) => this.ipc('settings:update-terminal-credentials', p),
    isConfigured: () => this.ipc('settings:is-configured'),
    factoryReset: () => this.ipc('settings:factory-reset'),
  };

  terminalConfig = {
    getSettings: () => this.ipc('terminal-config:get-settings'),
    getSetting: (s: string, k: string) => this.ipc('terminal-config:get-setting', s, k),
    getBranchId: () => this.ipc('terminal-config:get-branch-id'),
    getTerminalId: () => this.ipc('terminal-config:get-terminal-id'),
    refresh: () => this.ipc('terminal-config:refresh'),
    getOrganizationId: () => this.ipc('terminal-config:get-organization-id'),
    getBusinessType: () => this.ipc('terminal-config:get-business-type'),
    getFullConfig: () => this.ipc('terminal-config:get-full-config'),
  };

  shifts = {
    open: (p: OpenShiftParams) => this.ipc('shift:open', p),
    close: (p: CloseShiftParams) => this.ipc('shift:close', p),
    getActive: (staffId: string) => this.ipc('shift:get-active', staffId),
    getActiveByTerminal: (b: string, t: string) => this.ipc('shift:get-active-by-terminal', b, t),
    getActiveByTerminalLoose: (t: string) => this.ipc('shift:get-active-by-terminal-loose', t),
    getActiveCashierByTerminal: (b: string, t: string) => this.ipc('shift:get-active-cashier-by-terminal', b, t),
    listStaffForCheckin: (branchId?: string) => this.ipc('shift:list-staff-for-checkin', branchId),
    getStaffRoles: (staffIds?: string[]) => this.ipc('shift:get-staff-roles', staffIds),
    getSummary: (id: string, opts?: { skipBackfill?: boolean }) => this.ipc('shift:get-summary', id, opts),
    recordExpense: (p: RecordExpenseParams) => this.ipc('shift:record-expense', p),
    getExpenses: (id: string) => this.ipc('shift:get-expenses', id),
    recordStaffPayment: (p: RecordStaffPaymentParams) => this.ipc('shift:record-staff-payment', p),
    getStaffPayments: (id: string) => this.ipc('shift:get-staff-payments', id),
    getStaffPaymentsByStaff: (params: any) => this.ipc('shift:get-staff-payments-by-staff', params),
    getStaffPaymentTotalForDate: (staffId: string, date: string) => this.ipc('shift:get-staff-payment-total-for-date', staffId, date),
    getScheduledShifts: (params: any) => this.ipc('shift:get-scheduled-shifts', params),
    getTodayScheduledShifts: (branchId: string) => this.ipc('shift:get-today-scheduled-shifts', branchId),
    backfillDriverEarnings: (p: { shiftId?: string; date?: string }) => this.ipc('shift:backfill-driver-earnings', p),
  };

  drivers = {
    recordEarning: (p: any) => this.ipc('driver:record-earning', p),
    getEarnings: (id: string) => this.ipc('driver:get-earnings', id),
    getShiftSummary: (id: string) => this.ipc('driver:get-shift-summary', id),
    getActive: (branchId: string) => this.ipc('driver:get-active', branchId),
  };

  deliveryZones = {
    trackValidation: (d: any) => this.ipc('delivery-zone:track-validation', d),
    getAnalytics: (f?: any) => this.ipc('delivery-zone:get-analytics', f),
    requestOverride: (d: any) => this.ipc('delivery-zone:request-override', d),
  };

  reports = {
    getTodayStatistics: (p: { branchId: string }) => this.ipc('report:get-today-statistics', p),
    getSalesTrend: (p: { branchId: string; days: number }) => this.ipc('report:get-sales-trend', p),
    getTopItems: (p: { branchId: string; date?: string; limit?: number }) => this.ipc('report:get-top-items', p),
    getWeeklyTopItems: (p: { branchId: string; limit?: number }) => this.ipc('report:get-weekly-top-items', p),
    generateZReport: (p: { branchId: string; date?: string }) => this.ipc('report:generate-z-report', p),
    getDailyStaffPerformance: (p: { branchId: string; date?: string }) => this.ipc('report:get-daily-staff-performance', p),
    submitZReport: (p: { branchId: string; date?: string }) => this.ipc('report:submit-z-report', p),
  };

  menu = {
    sync: () => this.ipc('menu:sync'),
    getCategories: () => this.ipc('menu:get-categories'),
    getSubcategories: () => this.ipc('menu:get-subcategories'),
    getIngredients: () => this.ipc('menu:get-ingredients'),
    getSubcategoryIngredients: (id: string) => this.ipc('menu:get-subcategory-ingredients', id),
    getCombos: () => this.ipc('menu:get-combos'),
    updateCategory: (id: string, u: any) => this.ipc('menu:update-category', id, u),
    updateSubcategory: (id: string, u: any) => this.ipc('menu:update-subcategory', id, u),
    updateIngredient: (id: string, u: any) => this.ipc('menu:update-ingredient', id, u),
    updateCombo: (id: string, u: any) => this.ipc('menu:update-combo', id, u),
    triggerCheckForUpdates: () => this.ipc('menu:trigger-check-for-updates'),
  };

  printer = {
    listSystemPrinters: () => this.ipc('printer:list-system-printers'),
    scanNetwork: () => this.ipc('printer:scan-network'),
    scanBluetooth: () => this.ipc('printer:scan-bluetooth'),
    discover: (types?: string[]) => this.ipc('printer:discover', types),
    add: (c: Partial<PrinterConfig>) => this.ipc('printer:add', c),
    update: (id: string, u: Partial<PrinterConfig>) => this.ipc('printer:update', id, u),
    remove: (id: string) => this.ipc('printer:remove', id),
    getAll: () => this.ipc('printer:get-all'),
    get: (id: string) => this.ipc('printer:get', id),
    getStatus: (id: string) => this.ipc('printer:get-status', id),
    getAllStatuses: () => this.ipc('printer:get-all-statuses'),
    submitJob: (j: any) => this.ipc('printer:submit-job', j),
    cancelJob: (id: string) => this.ipc('printer:cancel-job', id),
    retryJob: (id: string) => this.ipc('printer:retry-job', id),
    test: (id: string) => this.ipc('printer:test', id),
    testGreekDirect: (mode: string, name?: string) => this.ipc('printer:test-greek-direct', mode, name),
    diagnostics: (id: string) => this.ipc('printer:diagnostics', id),
    bluetoothStatus: () => this.ipc('printer:bluetooth-status'),
    openCashDrawer: (id?: string, drawer?: 1 | 2) => this.ipc('printer:open-cash-drawer', id, drawer),
    createProfile: (p: any) => this.ipc('printer:create-profile', p),
    updateProfile: (p: any) => this.ipc('printer:update-profile', p),
    deleteProfile: (id: string) => this.ipc('printer:delete-profile', id),
    listProfiles: () => this.ipc('printer:list-profiles'),
    getProfile: (id: string) => this.ipc('printer:get-profile', id),
    setDefaultProfile: (id: string) => this.ipc('printer:set-default-profile', id),
    getDefaultProfile: () => this.ipc('printer:get-default-profile'),
    reprintJob: (id: string) => this.ipc('print:reprint-job', id),
  };

  ecr = {
    discoverDevices: (types?: string[], timeout?: number) => this.ipc('ecr:discover-devices', types, timeout),
    getDevices: () => this.ipc('ecr:get-devices'),
    getDevice: (id: string) => this.ipc('ecr:get-device', id),
    addDevice: (c: any) => this.ipc('ecr:add-device', c),
    updateDevice: (id: string, u: any) => this.ipc('ecr:update-device', id, u),
    removeDevice: (id: string) => this.ipc('ecr:remove-device', id),
    getDefaultTerminal: () => this.ipc('ecr:get-default-terminal'),
    connectDevice: (id: string) => this.ipc('ecr:connect-device', id),
    disconnectDevice: (id: string) => this.ipc('ecr:disconnect-device', id),
    getDeviceStatus: (id: string) => this.ipc('ecr:get-device-status', id),
    getAllStatuses: () => this.ipc('ecr:get-all-statuses'),
    processPayment: (amt: number, o?: EcrPaymentOptions) => this.ipc('ecr:process-payment', amt, o),
    processRefund: (amt: number, o?: EcrRefundOptions) => this.ipc('ecr:process-refund', amt, o),
    voidTransaction: (tid: string, did?: string) => this.ipc('ecr:void-transaction', tid, did),
    cancelTransaction: (did: string) => this.ipc('ecr:cancel-transaction', did),
    settlement: (did?: string) => this.ipc('ecr:settlement', did),
    getRecentTransactions: (limit?: number) => this.ipc('ecr:get-recent-transactions', limit),
    queryTransactions: (f: any) => this.ipc('ecr:query-transactions', f),
    getTransactionStats: (f?: any) => this.ipc('ecr:get-transaction-stats', f),
    getTransactionForOrder: (oid: string) => this.ipc('ecr:get-transaction-for-order', oid),
  };

  modules = {
    fetchFromAdmin: () => this.ipc('modules:fetch-from-admin'),
    getCached: () => this.ipc('modules:get-cached'),
    saveCache: (m: any[]) => this.ipc('modules:save-cache', m),
  };

  updates = {
    check: () => this.ipc('update:check'),
    download: () => this.ipc('update:download'),
    cancelDownload: () => this.ipc('update:cancel-download'),
    install: () => this.ipc('update:install'),
    getState: () => this.ipc('update:get-state'),
    setChannel: (ch: 'stable' | 'beta') => this.ipc('update:set-channel', ch),
  };

  window = {
    minimize: () => this.ipc('window-minimize'),
    maximize: () => this.ipc('window-maximize'),
    close: () => this.ipc('window-close'),
    toggleFullscreen: () => this.ipc('window-toggle-fullscreen'),
    getState: () => this.ipc('window-get-state'),
    reload: () => this.ipc('window-reload'),
    forceReload: () => this.ipc('window-force-reload'),
    toggleDevtools: () => this.ipc('window-toggle-devtools'),
    zoomIn: () => this.ipc('window-zoom-in'),
    zoomOut: () => this.ipc('window-zoom-out'),
    zoomReset: () => this.ipc('window-zoom-reset'),
  };

  adminApi = {
    fetchFromAdmin: (path: string, opts?: any) => this.ipc('api:fetch-from-admin', path, opts),
  };

  database = {
    healthCheck: () => this.ipc('database:health-check'),
    getStats: () => this.ipc('database:get-stats'),
    reset: () => this.ipc('database:reset'),
    clearOperationalData: () => this.ipc('database:clear-operational-data'),
  };

  clipboard = {
    readText: () => this.ipc('clipboard:read-text'),
    writeText: (text: string) => this.ipc('clipboard:write-text', text),
  };

  notifications = {
    show: (data: any) => this.ipc('show-notification', data),
  };

  screenCapture = {
    getSources: (opts: { types: string[] }) => this.ipc('screen-capture:get-sources', opts),
  };

  geo = {
    ip: () => this.ipc('geo:ip'),
  };

  labels = {
    print: (req: any, pid?: string) => this.ipc('label:print', req, pid),
    printBatch: (items: any[], lt?: string, pid?: string) => this.ipc('label:print-batch', items, lt, pid),
  };

  refunds = {
    refundPayment: (params: { paymentId: string; amount: number; reason: string; staffId?: string; orderId?: string }) =>
      this.ipc('refund:payment', params),
    listOrderAdjustments: (orderId: string) => this.ipc('refund:list-order-adjustments', orderId),
    getPaymentBalance: (paymentId: string) => this.ipc('refund:get-payment-balance', paymentId),
  };

  diagnostics = {
    getAbout: () => this.ipc('diagnostics:get-about'),
    getSystemHealth: () => this.ipc('diagnostics:get-system-health'),
    export: () => this.ipc('diagnostics:export'),
  };
}

// ============================================================================
// Bridge Singleton
// ============================================================================

let _bridge: PlatformBridge | null = null;

/**
 * Get the platform bridge singleton.
 * Automatically selects TauriBridge or ElectronBridge based on the runtime.
 */
export function getBridge(): PlatformBridge {
  if (_bridge) return _bridge;

  const platform = detectPlatform();

  switch (platform) {
    case 'tauri':
      _bridge = new TauriBridge();
      break;
    case 'electron':
      _bridge = new ElectronBridge();
      break;
    case 'browser':
      // In browser mode, create a proxy stub that logs warnings
      _bridge = createBrowserStub();
      break;
  }

  return _bridge;
}

/** Alias for getBridge() to match the requested API. */
export function createBridge(): PlatformBridge {
  return getBridge();
}

/**
 * Override the bridge singleton (useful for testing).
 */
export function setBridge(bridge: PlatformBridge): void {
  _bridge = bridge;
}

/**
 * Reset the cached bridge (useful for testing).
 */
export function resetBridge(): void {
  _bridge = null;
}

/**
 * Creates a Proxy-based stub where every call rejects with a descriptive error.
 * Useful for running the UI in a plain browser during development.
 */
function createBrowserStub(): PlatformBridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'invoke') {
        return (...args: unknown[]) => {
          console.warn(`[BrowserStub] IPC invoke not available in browser:`, args);
          return Promise.reject(new Error('IPC not available in browser environment'));
        };
      }
      return new Proxy({}, {
        get(_t, method) {
          return (...args: unknown[]) => {
            console.warn(`[BrowserStub] ${String(prop)}.${String(method)} not available in browser`, args);
            return Promise.reject(
              new Error(`${String(prop)}.${String(method)} is not available in browser environment`)
            );
          };
        },
      });
    },
  };

  return new Proxy({}, handler) as PlatformBridge;
}
