/**
 * Electron Compatibility Shim
 *
 * Installs `window.electron` and `window.electronAPI` on the global scope
 * so that existing Electron-era components can call
 * `window.electron.ipcRenderer.invoke(channel, ...args)` without changes.
 *
 * Under the hood every call is routed through the PlatformBridge, which
 * delegates to the appropriate backend (Tauri invoke or real Electron IPC).
 *
 * Usage:
 *   // Call once at app startup, before React renders
 *   import { installElectronCompat } from './lib/electron-compat';
 *   installElectronCompat();
 */

import { getBridge, CHANNEL_MAP, type PlatformBridge } from './ipc-adapter';
import { isTauri, isElectron } from './platform-detect';

// ============================================================================
// Event emitter for push-style IPC (`ipcRenderer.on`)
// ============================================================================

type Listener = (data: any) => void;

class SimpleEventEmitter {
  private listeners = new Map<string, Set<Listener>>();

  on(channel: string, listener: Listener): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel)!.add(listener);
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  removeAllListeners(channel: string): void {
    this.listeners.delete(channel);
  }

  emit(channel: string, data: any): void {
    this.listeners.get(channel)?.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        console.error(`[ElectronCompat] Error in listener for "${channel}":`, err);
      }
    });
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

/** Global event bus used by the compat shim and the Tauri event bridge. */
export const eventBus = new SimpleEventEmitter();

// ============================================================================
// Resolve a channel through the typed bridge
// ============================================================================

function resolveChannelInvoke(
  bridge: PlatformBridge,
  channel: string,
  args: any[]
): Promise<any> {
  const path = CHANNEL_MAP[channel];

  if (path) {
    // Walk the dot-separated path to reach the method
    const parts = path.split('.');
    let target: any = bridge;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
      if (!target) break;
    }
    const method = target?.[parts[parts.length - 1]];
    if (typeof method === 'function') {
      return method(...args);
    }
  }

  // Fallback to raw invoke for unmapped channels
  return bridge.invoke(channel, ...args);
}

// ============================================================================
// Build the compatibility objects
// ============================================================================

function buildIpcRenderer(bridge: PlatformBridge) {
  return {
    invoke: (channel: string, ...args: any[]): Promise<any> => {
      return resolveChannelInvoke(bridge, channel, args);
    },

    on: (channel: string, callback: Listener): void => {
      eventBus.on(channel, callback);
    },

    removeListener: (channel: string, callback: Listener): void => {
      eventBus.removeListener(channel, callback);
    },

    removeAllListeners: (channel: string): void => {
      eventBus.removeAllListeners(channel);
    },
  };
}

/**
 * Build the `window.electronAPI` compatibility object.
 *
 * The Electron preload exposes many convenience methods directly on
 * `window.electronAPI` (e.g. `getTerminalId()`, `forceSync()`).
 * This object provides those same method signatures backed by the bridge.
 */
function buildElectronAPI(bridge: PlatformBridge, ipcRenderer: ReturnType<typeof buildIpcRenderer>) {
  // Direct method mappings for `window.electronAPI.someMethod()` calls.
  // Derived from the Electron preload script's exported convenience methods.
  const directMethods: Record<string, any> = {
    // IPC access
    ipcRenderer,
    invoke: ipcRenderer.invoke,
    on: ipcRenderer.on,
    off: ipcRenderer.removeListener,
    removeAllListeners: ipcRenderer.removeAllListeners,

    // Clipboard
    clipboard: {
      readText: () => bridge.clipboard.readText(),
      writeText: (text: string) => bridge.clipboard.writeText(text),
    },

    // Screen capture
    screenCapture: {
      getSources: (opts: { types: string[] }) => bridge.screenCapture.getSources(opts),
    },

    // Terminal identity
    getTerminalSettings: () => bridge.terminalConfig.getSettings(),
    getTerminalSetting: (category: string, key: string) => bridge.terminalConfig.getSetting(category, key),
    getTerminalBranchId: () => bridge.terminalConfig.getBranchId(),
    getTerminalId: () => bridge.terminalConfig.getTerminalId(),
    getTerminalApiKey: () => bridge.terminalConfig.getSetting('terminal', 'pos_api_key'),
    refreshTerminalSettings: () => bridge.terminalConfig.refresh(),

    // Auth
    getDiscountMaxPercentage: () => bridge.settings.getDiscountMax(),
    getTaxRatePercentage: () => bridge.settings.getTaxRate(),
    setDiscountMaxPercentage: (p: number) => bridge.settings.setDiscountMax(p),
    setTaxRatePercentage: (p: number) => bridge.settings.setTaxRate(p),

    // Order conflict/retry wrappers
    getOrderConflicts: () => bridge.orders.getConflicts(),
    resolveOrderConflict: (cid: string, s: string, d?: any) => bridge.orders.resolveConflict(cid, s, d),
    forceOrderSyncRetry: (oid: string) => bridge.orders.forceSyncRetry(oid),
    getOrderRetryInfo: (oid: string) => bridge.orders.getRetryInfo(oid),

    // Shift wrappers
    openShift: (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'object') return bridge.shifts.open(args[0]);
      const [staffId, openingCash, branchId, terminalId, roleType, startingAmount] = args;
      return bridge.shifts.open({ staffId, openingCash, branchId, terminalId, roleType, startingAmount });
    },
    closeShift: (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'object') return bridge.shifts.close(args[0]);
      const [shiftId, closingCash, closedBy, paymentAmount] = args;
      return bridge.shifts.close({ shiftId, closingCash, closedBy, paymentAmount });
    },
    getActiveShift: (staffId: string) => bridge.shifts.getActive(staffId),
    getActiveShiftByTerminal: (b: string, t: string) => bridge.shifts.getActiveByTerminal(b, t),
    getActiveCashierByTerminal: (b: string, t: string) => bridge.shifts.getActiveCashierByTerminal(b, t),
    getActiveShiftByTerminalLoose: (t: string) => bridge.shifts.getActiveByTerminalLoose(t),
    getShiftSummary: (id: string, opts?: { skipBackfill?: boolean }) => bridge.shifts.getSummary(id, opts),
    recordExpense: (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'object') return bridge.shifts.recordExpense(args[0]);
      const [shiftId, amount, expenseType, description, receiptNumber] = args;
      return bridge.shifts.recordExpense({ shiftId, amount, expenseType, description, receiptNumber });
    },
    getExpenses: (shiftId: string) => bridge.shifts.getExpenses(shiftId),
    getShiftExpenses: (shiftId: string) => bridge.shifts.getExpenses(shiftId),
    recordStaffPayment: (params: any) => bridge.shifts.recordStaffPayment(params),
    getStaffPayments: (cashierShiftId: string) => bridge.shifts.getStaffPayments(cashierShiftId),
    getStaffPaymentsByStaff: (params: any) => bridge.shifts.getStaffPaymentsByStaff(params),
    getStaffPaymentTotalForDate: (staffId: string, date: string) => bridge.shifts.getStaffPaymentTotalForDate(staffId, date),
    getScheduledShifts: (params: any) => bridge.shifts.getScheduledShifts(params),
    getTodayScheduledShifts: (branchId: string) => bridge.shifts.getTodayScheduledShifts(branchId),
    backfillDriverEarnings: (params: any) => bridge.shifts.backfillDriverEarnings(params),

    // Driver wrappers
    getActiveDrivers: (branchId: string) => bridge.drivers.getActive(branchId),
    recordDriverEarning: (...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'object') return bridge.drivers.recordEarning(args[0]);
      const [shiftId, orderId, amount, earningType] = args;
      return bridge.drivers.recordEarning({ shiftId, orderId, amount, earningType });
    },
    getDriverEarnings: (shiftId: string) => bridge.drivers.getEarnings(shiftId),
    getDriverShiftSummary: (shiftId: string) => bridge.drivers.getShiftSummary(shiftId),

    // Delivery zone wrappers
    trackDeliveryValidation: (data: any) => bridge.deliveryZones.trackValidation(data),
    getDeliveryZoneAnalytics: (filters?: any) => bridge.deliveryZones.getAnalytics(filters),
    requestDeliveryOverride: (data: any) => bridge.deliveryZones.requestOverride(data),

    // Order approval wrappers
    approveOrder: (id: string, t?: number) => bridge.orders.approve(id, t),
    declineOrder: (id: string, r: string) => bridge.orders.decline(id, r),
    assignDriverToOrder: (id: string, d: string, n?: string) => bridge.orders.assignDriver(id, d, n),
    notifyPlatformReady: (id: string) => bridge.orders.notifyPlatformReady(id),
    updateOrderPreparation: (id: string, s: string, p: number, m?: string) => bridge.orders.updatePreparation(id, s, p, m),
    updateOrderType: (id: string, t: string) => bridge.orders.updateType(id, t),
    getOrdersByCustomerPhone: (phone: string) => bridge.orders.getByCustomerPhone(phone),

    // Payment wrappers
    recordPayment: (data: any) => bridge.payments.recordPayment(data),
    voidPayment: (id: string, reason: string, by?: string) => bridge.payments.voidPayment(id, reason, by),
    getOrderPayments: (orderId: string) => bridge.payments.getOrderPayments(orderId),
    getReceiptPreview: (orderId: string) => bridge.payments.getReceiptPreview(orderId),

    // Refund wrappers
    refundPayment: (params: any) => bridge.refunds.refundPayment(params),
    listOrderAdjustments: (orderId: string) => bridge.refunds.listOrderAdjustments(orderId),
    getPaymentBalance: (paymentId: string) => bridge.refunds.getPaymentBalance(paymentId),

    // Printing wrappers
    printReceipt: (data: any, type?: string) => bridge.payments.printReceipt(data, type),

    // Customer wrappers
    customerInvalidateCache: (phone: string) => bridge.customers.invalidateCache(phone),
    customerGetCacheStats: () => bridge.customers.getCacheStats(),
    customerClearCache: () => bridge.customers.clearCache(),
    customerLookupByPhone: (phone: string) => bridge.customers.lookupByPhone(phone),
    customerLookupById: (id: string) => bridge.customers.lookupById(id),
    customerSearch: (q: string) => bridge.customers.search(q),
    customerCreate: (data: any) => bridge.customers.create(data),
    customerUpdate: (id: string, u: any, v: number) => bridge.customers.update(id, u, v),
    customerAddAddress: (id: string, a: any) => bridge.customers.addAddress(id, a),
    customerUpdateAddress: (id: string, u: any, v: number) => bridge.customers.updateAddress(id, u, v),
    customerResolveConflict: (cid: string, s: string, d?: any) => bridge.customers.resolveConflict(cid, s, d),
    customerGetConflicts: (f?: any) => bridge.customers.getConflicts(f),

    // Sync wrappers
    getSyncStatus: () => bridge.sync.getStatus(),
    forceSync: () => bridge.sync.force(),
    getFinancialSyncStats: () => bridge.sync.getFinancialStats(),
    getFailedFinancialSyncItems: (limit?: number) => bridge.sync.getFailedFinancialItems(limit),
    retryFinancialSyncItem: (id: string) => bridge.sync.retryFinancialItem(id),
    retryAllFailedFinancialSyncs: () => bridge.sync.retryAllFailedFinancial(),
    getNetworkStatus: () => bridge.sync.getNetworkStatus(),

    // Report wrappers
    getTodayStatistics: (branchId: string) => bridge.reports.getTodayStatistics({ branchId }),
    getSalesTrend: (params: any) => bridge.reports.getSalesTrend(params),
    getTopItems: (params: any) => bridge.reports.getTopItems(params),
    getWeeklyTopItems: (params: any) => bridge.reports.getWeeklyTopItems(params),
    generateZReport: (params: any) => bridge.reports.generateZReport(params),
    getDailyStaffPerformance: (params: any) => bridge.reports.getDailyStaffPerformance(params),
    submitZReport: (params: any) => bridge.reports.submitZReport(params),

    // Printer wrappers
    printerDiscover: (types?: string[]) => bridge.printer.discover(types),
    printerAdd: (config: any) => bridge.printer.add(config),
    printerUpdate: (id: string, u: any) => bridge.printer.update(id, u),
    printerRemove: (id: string) => bridge.printer.remove(id),
    printerGetAll: () => bridge.printer.getAll(),
    printerGetStatus: (id: string) => bridge.printer.getStatus(id),
    printerGetAllStatuses: () => bridge.printer.getAllStatuses(),
    printerSubmitJob: (job: any) => bridge.printer.submitJob(job),
    printerCancelJob: (id: string) => bridge.printer.cancelJob(id),
    printerRetryJob: (id: string) => bridge.printer.retryJob(id),
    printerTest: (id: string) => bridge.printer.test(id),
    printerTestGreekDirect: (mode: string, name?: string) => bridge.printer.testGreekDirect(mode, name),
    printerGetDiagnostics: (id: string) => bridge.printer.diagnostics(id),
    printerGetBluetoothStatus: () => bridge.printer.bluetoothStatus(),
    openCashDrawer: (id?: string, drawer?: 1 | 2) => bridge.printer.openCashDrawer(id, drawer),

    // Printer profile management (Tauri-native)
    printerListSystemPrinters: () => bridge.printer.listSystemPrinters(),
    printerCreateProfile: (p: any) => bridge.printer.createProfile(p),
    printerUpdateProfile: (p: any) => bridge.printer.updateProfile(p),
    printerDeleteProfile: (id: string) => bridge.printer.deleteProfile(id),
    printerListProfiles: () => bridge.printer.listProfiles(),
    printerGetProfile: (id: string) => bridge.printer.getProfile(id),
    printerSetDefaultProfile: (id: string) => bridge.printer.setDefaultProfile(id),
    printerGetDefaultProfile: () => bridge.printer.getDefaultProfile(),
    printerReprintJob: (id: string) => bridge.printer.reprintJob(id),

    // Label printing
    printLabel: (req: any, pid?: string) => bridge.labels.print(req, pid),
    printBatchLabels: (items: any[], lt?: string, pid?: string) => bridge.labels.printBatch(items, lt, pid),

    // Auto-updater wrappers
    checkForUpdates: () => bridge.updates.check(),
    downloadUpdate: () => bridge.updates.download(),
    cancelDownload: () => bridge.updates.cancelDownload(),
    installUpdate: () => bridge.updates.install(),
    getUpdateState: () => bridge.updates.getState(),
    setUpdateChannel: (ch: 'stable' | 'beta') => bridge.updates.setChannel(ch),

    // Admin API
    fetchFromApi: (path: string, opts?: any) => bridge.adminApi.fetchFromAdmin(path, opts),

    // ECR wrappers
    ecrDiscoverDevices: (types?: string[], timeout?: number) => bridge.ecr.discoverDevices(types, timeout),
    ecrGetDevices: () => bridge.ecr.getDevices(),
    ecrGetDevice: (id: string) => bridge.ecr.getDevice(id),
    ecrAddDevice: (c: any) => bridge.ecr.addDevice(c),
    ecrUpdateDevice: (id: string, u: any) => bridge.ecr.updateDevice(id, u),
    ecrRemoveDevice: (id: string) => bridge.ecr.removeDevice(id),
    ecrGetDefaultTerminal: () => bridge.ecr.getDefaultTerminal(),
    ecrConnectDevice: (id: string) => bridge.ecr.connectDevice(id),
    ecrDisconnectDevice: (id: string) => bridge.ecr.disconnectDevice(id),
    ecrGetDeviceStatus: (id: string) => bridge.ecr.getDeviceStatus(id),
    ecrGetAllStatuses: () => bridge.ecr.getAllStatuses(),
    ecrProcessPayment: (amt: number, o?: any) => bridge.ecr.processPayment(amt, o),
    ecrProcessRefund: (amt: number, o?: any) => bridge.ecr.processRefund(amt, o),
    ecrVoidTransaction: (tid: string, did?: string) => bridge.ecr.voidTransaction(tid, did),
    ecrCancelTransaction: (did: string) => bridge.ecr.cancelTransaction(did),
    ecrSettlement: (did?: string) => bridge.ecr.settlement(did),
    ecrGetRecentTransactions: (limit?: number) => bridge.ecr.getRecentTransactions(limit),
    ecrQueryTransactions: (f: any) => bridge.ecr.queryTransactions(f),
    ecrGetTransactionStats: (f?: any) => bridge.ecr.getTransactionStats(f),
    ecrGetTransactionForOrder: (oid: string) => bridge.ecr.getTransactionForOrder(oid),

    // Event subscription helpers (return unsubscribe functions)
    onOrderRealtimeUpdate: (cb: Listener) => {
      eventBus.on('order-realtime-update', cb);
      return () => eventBus.removeListener('order-realtime-update', cb);
    },
    onOrderStatusUpdated: (cb: Listener) => {
      eventBus.on('order-status-updated', cb);
      return () => eventBus.removeListener('order-status-updated', cb);
    },
    onOrderCreated: (cb: Listener) => {
      eventBus.on('order-created', cb);
      return () => eventBus.removeListener('order-created', cb);
    },
    onOrderUpdated: (cb: Listener) => {
      eventBus.on('order-updated', cb);
      return () => eventBus.removeListener('order-updated', cb);
    },
    onOrderDeleted: (cb: Listener) => {
      eventBus.on('order-deleted', cb);
      return () => eventBus.removeListener('order-deleted', cb);
    },
    onOrderPaymentUpdated: (cb: Listener) => {
      eventBus.on('order-payment-updated', cb);
      return () => eventBus.removeListener('order-payment-updated', cb);
    },
    removeOrderRealtimeUpdateListener: (cb: Listener) => eventBus.removeListener('order-realtime-update', cb),
    removeOrderStatusUpdatedListener: (cb: Listener) => eventBus.removeListener('order-status-updated', cb),
    removeOrderDeletedListener: (cb: Listener) => eventBus.removeListener('order-deleted', cb),
    removeOrderPaymentUpdatedListener: (cb: Listener) => eventBus.removeListener('order-payment-updated', cb),
    removeOrderCreatedListener: (cb: Listener) => eventBus.removeListener('order-created', cb),
    removeOrderUpdatedListener: (cb: Listener) => eventBus.removeListener('order-updated', cb),

    // Customer event helpers
    onCustomerCreated: (cb: Listener) => { eventBus.on('customer-created', cb); },
    removeCustomerCreatedListener: (cb: Listener) => eventBus.removeListener('customer-created', cb),
    onCustomerUpdated: (cb: Listener) => { eventBus.on('customer-updated', cb); },
    removeCustomerUpdatedListener: (cb: Listener) => eventBus.removeListener('customer-updated', cb),
    onCustomerDeleted: (cb: Listener) => { eventBus.on('customer-deleted', cb); },
    removeCustomerDeletedListener: (cb: Listener) => eventBus.removeListener('customer-deleted', cb),
    onCustomerConflictDetected: (cb: Listener) => { eventBus.on('customer-sync-conflict', cb); },
    removeCustomerConflictDetectedListener: (cb: Listener) => eventBus.removeListener('customer-sync-conflict', cb),

    // Terminal settings event
    onTerminalSettingsUpdated: (cb: Listener) => {
      eventBus.on('terminal-settings-updated', cb);
      return () => eventBus.removeListener('terminal-settings-updated', cb);
    },
    onTerminalConfigUpdated: (cb: Listener) => {
      eventBus.on('terminal-config-updated', cb);
      return () => eventBus.removeListener('terminal-config-updated', cb);
    },

    // Printer status event
    onPrinterStatusChanged: (cb: Listener) => {
      eventBus.on('printer:status-changed', cb);
      return () => eventBus.removeListener('printer:status-changed', cb);
    },
    removePrinterStatusChangedListener: (cb: Listener) => eventBus.removeListener('printer:status-changed', cb),

    // ECR event helpers
    onEcrDeviceConnected: (cb: Listener) => {
      eventBus.on('ecr:event:device-connected', cb);
      return () => eventBus.removeListener('ecr:event:device-connected', cb);
    },
    onEcrDeviceDisconnected: (cb: Listener) => {
      eventBus.on('ecr:event:device-disconnected', cb);
      return () => eventBus.removeListener('ecr:event:device-disconnected', cb);
    },
    onEcrDeviceStatusChanged: (cb: Listener) => {
      eventBus.on('ecr:event:device-status-changed', cb);
      return () => eventBus.removeListener('ecr:event:device-status-changed', cb);
    },
    onEcrTransactionCompleted: (cb: Listener) => {
      eventBus.on('ecr:event:transaction-completed', cb);
      return () => eventBus.removeListener('ecr:event:transaction-completed', cb);
    },
    onEcrDisplayMessage: (cb: Listener) => {
      eventBus.on('ecr:event:display-message', cb);
      return () => eventBus.removeListener('ecr:event:display-message', cb);
    },
    onEcrError: (cb: Listener) => {
      eventBus.on('ecr:event:error', cb);
      return () => eventBus.removeListener('ecr:event:error', cb);
    },

    // Auto-updater event helpers
    onMenuCheckForUpdates: (cb: Listener) => {
      eventBus.on('menu:check-for-updates', cb);
      return () => eventBus.removeListener('menu:check-for-updates', cb);
    },
    onUpdateChecking: (cb: Listener) => {
      eventBus.on('update-checking', cb);
      return () => eventBus.removeListener('update-checking', cb);
    },
    onUpdateAvailable: (cb: Listener) => {
      eventBus.on('update-available', cb);
      return () => eventBus.removeListener('update-available', cb);
    },
    onUpdateNotAvailable: (cb: Listener) => {
      eventBus.on('update-not-available', cb);
      return () => eventBus.removeListener('update-not-available', cb);
    },
    onDownloadProgress: (cb: Listener) => {
      eventBus.on('download-progress', cb);
      return () => eventBus.removeListener('download-progress', cb);
    },
    onUpdateDownloaded: (cb: Listener) => {
      eventBus.on('update-downloaded', cb);
      return () => eventBus.removeListener('update-downloaded', cb);
    },
    onUpdateError: (cb: Listener) => {
      eventBus.on('update-error', cb);
      return () => eventBus.removeListener('update-error', cb);
    },
  };

  // Use a Proxy so unknown property accesses return a function that
  // delegates to bridge.invoke(). This catches any direct method calls
  // on electronAPI that we haven't explicitly mapped above.
  return new Proxy(directMethods, {
    get(target: any, prop: string) {
      if (prop in target) return target[prop];

      // Event listener patterns (on*, remove*Listener) are not Tauri
      // commands — return no-ops to avoid "Command not found" errors.
      if (/^on[A-Z]/.test(prop) || /^remove\w+Listener$/.test(prop)) {
        return (..._args: any[]) => { /* no-op event stub */ };
      }

      // Return a function that tries to invoke the property name as a channel
      return (...args: any[]) => {
        console.warn(
          `[ElectronCompat] Unmapped electronAPI method "${prop}" called. ` +
          `Add it to directMethods in electron-compat.ts for type safety.`
        );
        return bridge.invoke(prop, ...args);
      };
    },
  });
}

// ============================================================================
// Install
// ============================================================================

let _installed = false;

/**
 * Install the Electron compatibility shim on `window`.
 *
 * After this call:
 *   - `window.electron.ipcRenderer.invoke(channel, ...args)` works
 *   - `window.electron.ipcRenderer.on(channel, cb)` works
 *   - `window.electronAPI.someMethod()` works
 *   - `window.isElectron` is `true`
 *
 * Safe to call multiple times; only installs once.
 * In a real Electron environment, merges with existing objects rather
 * than overwriting them.
 */
export function installElectronCompat(): void {
  if (_installed) return;
  _installed = true;

  const bridge = getBridge();
  const ipcRenderer = buildIpcRenderer(bridge);

  if (isElectron()) {
    // In Electron, the real objects already exist. We only need to ensure
    // the typed bridge is accessible. Don't overwrite real IPC.
    console.log('[ElectronCompat] Running in Electron - bridge available via getBridge()');
    return;
  }

  // In Tauri or browser mode, install the compat shim
  const win = window as any;

  win.electron = {
    ipcRenderer,
    clipboard: {
      readText: () => bridge.clipboard.readText(),
      writeText: (text: string) => bridge.clipboard.writeText(text),
    },
  };

  win.electronAPI = buildElectronAPI(bridge, ipcRenderer);
  win.isElectron = true;

  console.log('[ElectronCompat] Compatibility shim installed for', isTauri() ? 'Tauri' : 'browser');
}

/**
 * Reset installation state (useful for testing).
 */
export function resetElectronCompat(): void {
  _installed = false;
}
