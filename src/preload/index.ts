/**
 * Secure Preload Script for POS System
 *
 * This script runs in a privileged context and exposes a safe, minimal IPC surface
 * to the renderer process using contextBridge. It implements strict whitelisting
 * of allowed channels and methods to prevent security vulnerabilities.
 *
 * Security principles:
 * - Only whitelisted channels can be listened to
 * - Only whitelisted methods can be invoked
 * - No direct access to Node.js APIs from renderer
 * - All IPC communication is validated and sanitized
 * - Dangerous channels automatically disabled in production builds
 */

// SECURITY: desktopCapturer removed - screen capture now goes through IPC with consent dialog
import { contextBridge, ipcRenderer, IpcRendererEvent, clipboard } from 'electron';
import type { RecordStaffPaymentParams, RecordStaffPaymentResponse, StaffPayment } from '../renderer/types/shift';
import { filterAllowedInvokes } from './ipc-security';

// Whitelisted event channels that renderer can listen to
const ALLOWED_CHANNELS = [
  // Control commands
  'control-command-received',
  'app-shutdown-initiated',
  'app-restart-initiated',
  'app-close',
  'terminal-disabled',
  'terminal-enabled',
  'app:reset',

  // Auto-updater events
  'update-available',
  'update-downloaded',
  'update-error',

  // Order events
  'order-realtime-update',
  'order-status-updated',
  'order-created',
  'order-deleted',
  'order-payment-updated',

  // Customer events
  'customer-created',
  'customer-updated',
  'customer-deleted',
  'customer-realtime-update',
  'customer-sync-conflict',
  'customer-conflict-resolved',

  // Conflict and retry events
  'order-sync-conflict',
  'order-conflict-resolved',
  'sync-retry-scheduled',
  'orders-cleared',

  // Sync events
  'sync:status',
  'network:status',
  'settings:update',
  'staff:permission-update',
  'hardware-config:update',
  'app:restart-required',
  'sync:error',
  'sync:complete',

  // Shift events
  'shift-updated',

  // Database health
  'database-health-update',

  // Terminal settings
  'terminal-settings-updated',
  'terminal-credentials-updated',

  // Session management
  'session-timeout',

  // Menu management
  'menu:sync',

  // Screen capture
  'screen-capture:start',
  'screen-capture:stop',

  // Module sync events
  'modules:sync-complete',
  'modules:sync-error',
  'modules:refresh-needed',

  // Printer status events
  'printer:status-changed',

  // Terminal config events (heartbeat updates)
  'terminal-config-updated',

  // ECR (Payment Terminal) events
  'ecr:event:device-connected',
  'ecr:event:device-disconnected',
  'ecr:event:device-status-changed',
  'ecr:event:transaction-started',
  'ecr:event:transaction-status',
  'ecr:event:transaction-completed',
  'ecr:event:display-message',
  'ecr:event:error',

  // Auto-updater events
  'update-checking',
  'update-available',
  'update-not-available',
  'update-error',
  'download-progress',
  'update-downloaded',

  // Menu-triggered events
  'menu:check-for-updates',
] as const;

// Type for allowed channels
type AllowedChannel = typeof ALLOWED_CHANNELS[number];

// Validate that a channel is in the whitelist
function isAllowedChannel(channel: string): channel is AllowedChannel {
  return ALLOWED_CHANNELS.includes(channel as AllowedChannel);
}

// Map to track callback -> subscription wrapper for proper removal
const listenerMap = new Map<string, Map<(data: any) => void, (event: IpcRendererEvent, data: any) => void>>();

/**
 * Secure IPC API exposed to renderer process
 */
const electronAPI = {
  /**
   * IPC Renderer methods for secure communication
   */
  ipcRenderer: {
    /**
     * Register a listener for whitelisted channels
     * @param channel - The event channel to listen to (must be whitelisted)
     * @param callback - Function to call when event is received
     */
    on: (channel: string, callback: (data: any) => void) => {
      if (!isAllowedChannel(channel)) {
        console.error(`Attempted to listen to non-whitelisted channel: ${channel}`);
        return;
      }

      const subscription = (_event: IpcRendererEvent, data: any) => {
        // Debug logging for update events
        if (channel.startsWith('update-')) {
          console.log(`[Preload] Received ${channel} event:`, data);
        }
        // Some events (like update-checking) don't send data - that's OK
        try {
          callback(data);
          if (channel.startsWith('update-')) {
            console.log(`[Preload] Successfully called callback for ${channel}`);
          }
        } catch (err) {
          console.error(`[Preload] Error in callback for ${channel}:`, err);
        }
      };

      // Store the mapping so we can remove it later
      if (!listenerMap.has(channel)) {
        listenerMap.set(channel, new Map());
      }
      listenerMap.get(channel)!.set(callback, subscription);

      ipcRenderer.on(channel, subscription);
      if (channel.startsWith('update-')) {
        console.log(`[Preload] Registered listener for ${channel}`);
      }
    },

    /**
     * Remove a listener from a channel
     * @param channel - The event channel to remove listener from
     * @param callback - The callback function to remove
     */
    removeListener: (channel: string, callback: (data: any) => void) => {
      if (!isAllowedChannel(channel)) {
        console.error(`Attempted to remove listener from non-whitelisted channel: ${channel}`);
        return;
      }

      // Get the actual subscription wrapper that was registered
      const channelListeners = listenerMap.get(channel);
      if (channelListeners) {
        const subscription = channelListeners.get(callback);
        if (subscription) {
          ipcRenderer.removeListener(channel, subscription);
          channelListeners.delete(callback);
          if (channel.startsWith('update-')) {
            console.log(`[Preload] Removed listener for ${channel}`);
          }
        }
      }
    },

    /**
     * Remove all listeners from a channel
     * @param channel - The event channel to clear
     */
    removeAllListeners: (channel: string) => {
      if (!isAllowedChannel(channel)) {
        console.error(`Attempted to remove all listeners from non-whitelisted channel: ${channel}`);
        return;
      }

      ipcRenderer.removeAllListeners(channel);
      // Clear the listener map for this channel
      listenerMap.delete(channel);
    },

    /**
     * Invoke an IPC method and wait for response
     * @param channel - The IPC method to invoke
     * @param args - Arguments to pass to the method
     */
    invoke: async (channel: string, ...args: any[]): Promise<any> => {
      // Whitelist of allowed invoke channels
      const allowedInvokes = [
        // App control
        'app:shutdown',
        'app:restart',
        'app:get-shutdown-status',
        'app:get-version',

        // Window controls
        'window-minimize',
        'window-maximize',
        'window-close',
        'window-toggle-fullscreen',
        'window-get-state',
        'window-reload',
        'window-force-reload',
        'window-toggle-devtools',
        'window-zoom-in',
        'window-zoom-out',
        'window-zoom-reset',

        // Auth
        'auth:login',
        'auth:logout',
        'auth:get-current-session',
        'auth:validate-session',
        'auth:has-permission',
        'auth:get-session-stats',
        'auth:setup-pin',

        // Orders
        'order:get-all',
        'order:get-by-id',
        'order:create',
        'order:update-status',
        'order:update-items',
        'order:delete',
        'order:save-from-remote',
        'order:save-for-retry',
        'order:get-retry-queue',
        'order:process-retry-queue',
        'order:approve',
        'order:decline',
        'order:assign-driver',
        'order:notify-platform-ready',
        'order:update-preparation',
        'order:update-type',
        'order:fetch-items-from-supabase',

        // Conflict resolution and retry management
        'orders:get-conflicts',
        'orders:resolve-conflict',
        'orders:force-sync-retry',
        'orders:get-retry-info',
        'orders:clear-all',

        // Payments
        'payment:update-payment-status',
        'payment:print-receipt',
        'kitchen:print-ticket',

        // Sync
        'sync:get-status',
        'sync:force',
        'sync:get-network-status',
        'sync:get-inter-terminal-status',
        'sync:clear-all',
        'sync:clear-failed',
        'sync:clear-old-orders',
        'sync:clear-all-orders',
        'sync:cleanup-deleted-orders',
        'sync:get-financial-stats',
        'sync:get-failed-financial-items',
        'sync:retry-financial-item',
        'sync:retry-all-failed-financial',
        'sync:get-unsynced-financial-summary',
        'sync:validate-financial-integrity',
        'sync:requeue-orphaned-financial',
        'sync:test-parent-connection',
        'sync:rediscover-parent',

        // Admin dashboard sync endpoints
        'sync:fetch-tables',
        'sync:fetch-reservations',
        'sync:fetch-suppliers',
        'sync:fetch-analytics',
        'sync:fetch-orders',

        // Customer cache and CRUD/conflicts
        'customer:invalidate-cache',
        'customer:get-cache-stats',
        'customer:clear-cache',
        'customer:lookup-by-phone',
        'customer:lookup-by-id',
        'customer:search',
        'customer:create',
        'customer:update',
        'customer:update-ban-status',
        'customer:add-address',
        'customer:update-address',
        'customer:resolve-conflict',
        'customer:get-conflicts',

        // Settings
        'get-settings',
        'update-settings',
        'settings:get',
        'settings:get-local',
        'settings:update-local',
        'settings:set',
        'settings:get-discount-max',
        'settings:set-discount-max',
        'settings:get-tax-rate',
        'settings:set-tax-rate',
        'settings:get-language',
        'settings:set-language',
        'settings:update-terminal-credentials',
        'settings:is-configured',
        'settings:factory-reset',

        // System
        'system:get-info',

        // Staff auth
        'auth:login',
        'staff-auth:authenticate-pin',
        'staff-auth:get-session',
        'staff-auth:get-current',
        'staff-auth:has-permission',
        'staff-auth:has-any-permission',
        'staff-auth:logout',
        'staff-auth:validate-session',
        'staff-auth:track-activity',

        // Shifts
        'shift:open',
        'shift:close',
        'shift:get-active',
        'shift:get-active-by-terminal',
        'shift:get-active-by-terminal-loose',
        'shift:get-active-cashier-by-terminal',
        'shift:list-staff-for-checkin',
        'shift:get-staff-roles',

        'shift:get-summary',
        'shift:record-expense',
        'shift:get-expenses',
        'shift:record-staff-payment',
        'shift:get-staff-payments',
        'shift:backfill-driver-earnings',

        // Drivers
        'driver:record-earning',
        'driver:get-earnings',
        'driver:get-shift-summary',
        'driver:get-active',

        // Delivery zone validation
        'delivery-zone:track-validation',
        'delivery-zone:get-analytics',
        'delivery-zone:request-override',

        // Database

        'database:health-check',
        'database:get-stats',
        'database:reset',
        'database:clear-operational-data',

        // Terminal config
        'terminal-config:get-settings',
        'terminal-config:get-setting',
        'terminal-config:get-branch-id',
        'terminal-config:get-terminal-id',
        'terminal-config:refresh',
        'terminal-config:get-organization-id',
        'terminal-config:get-business-type',
        'terminal-config:get-full-config',

        // Settings
        'settings:get-admin-url',
        'settings:clear-connection',
        'settings:update-terminal-credentials',

        // Notifications
        'show-notification',

        // Updates
        'update:install',
        'update:get-state',
        'update:check',
        'update:download',
        'update:cancel-download',
        'update:set-channel',

        // Reports
        'report:get-today-statistics',
        'report:get-sales-trend',
        'report:get-top-items',
        'report:get-weekly-top-items',
        'report:generate-z-report',
        'report:get-daily-staff-performance',
        'report:submit-z-report',

        // Screen capture
        'screen-capture:get-sources',

        // SECURITY: Removed 'input:inject' - critical security vulnerability
        // Remote input injection is extremely dangerous and can lead to full system compromise
        // If remote support is needed, implement specific, validated actions instead

        // Geolocation
        'geo:ip',

        // Menu management
        'menu:get-categories',
        'menu:get-subcategories',
        'menu:get-ingredients',
        'menu:get-combos',
        'menu:update-category',
        'menu:update-subcategory',
        'menu:update-ingredient',
        'menu:update-combo',
        'menu:trigger-check-for-updates',

        // Printers / device discovery (legacy)
        'printer:list-system-printers',
        'printer:scan-network',
        'printer:scan-bluetooth',

        // Printer Manager operations
        'printer:discover',
        'printer:add',
        'printer:update',
        'printer:remove',
        'printer:get-all',
        'printer:get',
        'printer:get-status',
        'printer:get-all-statuses',
        'printer:submit-job',
        'printer:cancel-job',
        'printer:retry-job',
        'printer:test',
        'printer:test-greek-direct',
        'printer:diagnostics',
        'printer:bluetooth-status',

        // Clipboard
        'clipboard:read-text',
        'clipboard:write-text',

        // Module sync
        'modules:fetch-from-admin',
        'modules:get-cached',
        'modules:save-cache',

        // Admin API fetch (authenticated requests)
        'api:fetch-from-admin',

        // ECR (Payment Terminal) management
        'ecr:discover-devices',
        'ecr:get-devices',
        'ecr:get-device',
        'ecr:add-device',
        'ecr:update-device',
        'ecr:remove-device',
        'ecr:get-default-terminal',
        'ecr:connect-device',
        'ecr:disconnect-device',
        'ecr:get-device-status',
        'ecr:get-all-statuses',
        'ecr:process-payment',
        'ecr:process-refund',
        'ecr:void-transaction',
        'ecr:cancel-transaction',
        'ecr:settlement',
        'ecr:get-recent-transactions',
        'ecr:query-transactions',
        'ecr:get-transaction-stats',
        'ecr:get-transaction-for-order',

        // Cash drawer
        'printer:open-cash-drawer',
      ];

      // Filter out dangerous channels in production builds
      const filteredInvokes = filterAllowedInvokes(allowedInvokes);

      if (!filteredInvokes.includes(channel)) {
        console.error(`Attempted to invoke non-whitelisted method: ${channel}`);
        throw new Error(`Unauthorized IPC invoke: ${channel}`);
      }

      return ipcRenderer.invoke(channel, ...args);
    },
  },

  // Clipboard operations via IPC
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read-text'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  },

  // Event listener helper methods for orders
  onOrderRealtimeUpdate: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('order-realtime-update', subscription);
  },

  removeOrderRealtimeUpdateListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-realtime-update', callback);
  },

  onOrderStatusUpdated: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('order-status-updated', subscription);
  },

  removeOrderStatusUpdatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-status-updated', callback);
  },

  onOrderDeleted: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('order-deleted', subscription);
  },

  removeOrderDeletedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-deleted', callback);
  },

  onOrderPaymentUpdated: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('order-payment-updated', subscription);
  },

  removeOrderPaymentUpdatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-payment-updated', callback);
  },

  onOrderUpdated: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => {
      console.log('📥 Preload received order-updated:', data);
      callback(data);
    };
    ipcRenderer.on('order-updated', subscription);
    return () => ipcRenderer.removeListener('order-updated', subscription);
  },

  removeOrderUpdatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-updated', callback);
  },

  onOrderCreated: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => {
      console.log('📥 Preload received order-created:', data);
      callback(data);
    };
    ipcRenderer.on('order-created', subscription);
    return () => ipcRenderer.removeListener('order-created', subscription);
  },

  removeOrderCreatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('order-created', callback);
  },

  // Helper methods for common operations
  getDiscountMaxPercentage: async () => {
    return ipcRenderer.invoke('settings:get-discount-max');
  },

  getTaxRatePercentage: async () => {
    return ipcRenderer.invoke('settings:get-tax-rate');
  },

  setDiscountMaxPercentage: async (percentage: number) => {
    return ipcRenderer.invoke('settings:set-discount-max', percentage);
  },

  setTaxRatePercentage: async (percentage: number) => {
    return ipcRenderer.invoke('settings:set-tax-rate', percentage);
  },

  // Conflict and retry management methods
  getOrderConflicts: () => {
    return ipcRenderer.invoke('orders:get-conflicts');
  },

  resolveOrderConflict: (conflictId: string, strategy: string, data?: any) => {
    return ipcRenderer.invoke('orders:resolve-conflict', conflictId, strategy, data);
  },

  forceOrderSyncRetry: (orderId: string) => {
    return ipcRenderer.invoke('orders:force-sync-retry', orderId);
  },

  getOrderRetryInfo: (orderId: string) => {
    return ipcRenderer.invoke('orders:get-retry-info', orderId);
  },

  // Shift management methods
  /**
   * Opens a new shift.
   * @deprecated Positional arguments are deprecated. Use the object argument form: openShift({ staffId, ... })
   */
  openShift: (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'object') {
      return ipcRenderer.invoke('shift:open', args[0]);
    }
    const [staffId, openingCash, branchId, terminalId, roleType, startingAmount] = args;
    return ipcRenderer.invoke('shift:open', { staffId, openingCash, branchId, terminalId, roleType, startingAmount });
  },

  /**
   * Close a shift with optional payment amount for driver wage recording
   * @param params.shiftId - The shift ID to close
   * @param params.closingCash - Closing cash amount
   * @param params.closedBy - Staff ID who closed the shift
   * @param params.paymentAmount - Optional payment amount for driver wage during checkout
   */
  closeShift: (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'object') {
      return ipcRenderer.invoke('shift:close', args[0]);
    }
    const [shiftId, closingCash, closedBy, paymentAmount] = args;
    return ipcRenderer.invoke('shift:close', { shiftId, closingCash, closedBy, paymentAmount });
  },

  getActiveShift: (staffId: string) => {
    return ipcRenderer.invoke('shift:get-active', staffId);
  },

  getActiveShiftByTerminal: (branchId: string, terminalId: string) => {
    return ipcRenderer.invoke('shift:get-active-by-terminal', branchId, terminalId);
  },

  getActiveCashierByTerminal: (branchId: string, terminalId: string) => {
    return ipcRenderer.invoke('shift:get-active-cashier-by-terminal', branchId, terminalId);
  },

  getActiveShiftByTerminalLoose: (terminalId: string) => {
    return ipcRenderer.invoke('shift:get-active-by-terminal-loose', terminalId);
  },

  // Get all locally active shifts (debugging utility)
  getAllActiveShifts: () => {
    return ipcRenderer.invoke('shift:get-all-active');
  },

  // Close all local active shifts (cleanup utility - marks as abandoned)
  closeAllActiveShifts: () => {
    return ipcRenderer.invoke('shift:close-all-active');
  },

  /**
   * Get shift summary with optional configuration
   * @param shiftId The shift ID to get summary for
   * @param options Optional configuration
   * @param options.skipBackfill If true, skips driver earnings backfill (faster for non-checkout reads)
   */
  getShiftSummary: (shiftId: string, options?: { skipBackfill?: boolean }) => {
    return ipcRenderer.invoke('shift:get-summary', shiftId, options);
  },

  recordExpense: (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'object') {
      return ipcRenderer.invoke('shift:record-expense', args[0]);
    }
    const [shiftId, amount, expenseType, description, receiptNumber] = args;
    return ipcRenderer.invoke('shift:record-expense', { shiftId, amount, expenseType, description, receiptNumber });
  },

  getExpenses: (shiftId: string) => {
    return ipcRenderer.invoke('shift:get-expenses', shiftId);
  },

  getShiftExpenses: (shiftId: string) => {
    return ipcRenderer.invoke('shift:get-expenses', shiftId);
  },

  /**
   * Record a staff payment from the cashier's drawer
   * @param params - Payment parameters conforming to RecordStaffPaymentParams
   * @returns Promise resolving to RecordStaffPaymentResponse
   */
  recordStaffPayment: (params: RecordStaffPaymentParams): Promise<RecordStaffPaymentResponse> => {
    return ipcRenderer.invoke('shift:record-staff-payment', params);
  },

  /**
   * Get all staff payments recorded by a specific cashier shift
   * @param cashierShiftId - The cashier's shift ID
   * @returns Promise resolving to array of StaffPayment records
   */
  getStaffPayments: (cashierShiftId: string): Promise<StaffPayment[]> => {
    return ipcRenderer.invoke('shift:get-staff-payments', cashierShiftId);
  },

  /**
   * Maintenance: Backfill driver earnings for a specific shift or date.
   * This is an admin/maintenance action to run backfill outside of interactive UI paths.
   * @param params.shiftId - Optional specific driver shift ID to backfill
   * @param params.date - Optional date string (YYYY-MM-DD) to backfill all driver shifts for that day
   * @returns Promise resolving to { success, message?, processed?, total?, error? }
   */
  backfillDriverEarnings: (params: { shiftId?: string; date?: string }): Promise<{
    success: boolean;
    message?: string;
    processed?: number;
    total?: number;
    error?: string;
  }> => {
    return ipcRenderer.invoke('shift:backfill-driver-earnings', params);
  },

  printCheckout: (shiftId: string, roleType: string, terminalName?: string) => {
    return ipcRenderer.invoke('shift:print-checkout', { shiftId, roleType, terminalName });
  },

  printZReport: (snapshot: any, terminalName?: string) => {
    return ipcRenderer.invoke('report:print-z-report', { snapshot, terminalName });
  },

  // Driver management methods
  getActiveDrivers: (branchId: string) => {
    return ipcRenderer.invoke('driver:get-active', branchId);
  },

  recordDriverEarning: (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'object') {
      return ipcRenderer.invoke('driver:record-earning', args[0]);
    }
    const [shiftId, orderId, amount, earningType] = args;
    return ipcRenderer.invoke('driver:record-earning', { shiftId, orderId, amount, earningType });
  },

  getDriverEarnings: (shiftId: string) => {
    return ipcRenderer.invoke('driver:get-earnings', shiftId);
  },

  getDriverShiftSummary: (shiftId: string) => {
    return ipcRenderer.invoke('driver:get-shift-summary', shiftId);
  },

  // Delivery zone validation methods
  trackDeliveryValidation: (data: {
    zoneId?: string;
    address: string;
    coordinates?: { lat: number; lng: number };
    result: string;
    orderAmount?: number;
    deliveryFee?: number;
    source: string;
    terminalId?: string;
    staffId?: string;
    overrideApplied?: boolean;
    overrideReason?: string;
    responseTimeMs: number;
    timestamp: string;
  }) => {
    return ipcRenderer.invoke('delivery-zone:track-validation', data);
  },

  getDeliveryZoneAnalytics: (filters?: {
    zoneId?: string;
    dateFrom?: string;
    dateTo?: string;
    periodType?: string;
  }) => {
    return ipcRenderer.invoke('delivery-zone:get-analytics', filters);
  },

  requestDeliveryOverride: (data: {
    orderId?: string;
    address: { lat: number; lng: number };
    reason: string;
    customDeliveryFee?: number;
    staffId: string;
  }) => {
    return ipcRenderer.invoke('delivery-zone:request-override', data);
  },

  // Order approval workflow methods
  approveOrder: (orderId: string, estimatedTime?: number) => {
    return ipcRenderer.invoke('order:approve', orderId, estimatedTime);
  },

  declineOrder: (orderId: string, reason: string) => {
    return ipcRenderer.invoke('order:decline', orderId, reason);
  },

  assignDriverToOrder: (orderId: string, driverId: string, notes?: string) => {
    return ipcRenderer.invoke('order:assign-driver', orderId, driverId, notes);
  },

  // Notify external platform that order is ready for pickup
  notifyPlatformReady: (orderId: string) => {
    return ipcRenderer.invoke('order:notify-platform-ready', orderId);
  },

  updateOrderPreparation: (orderId: string, stage: string, progress: number, message?: string) => {
    return ipcRenderer.invoke('order:update-preparation', orderId, stage, progress, message);
  },

  updateOrderType: (orderId: string, orderType: string) => {
    return ipcRenderer.invoke('order:update-type', orderId, orderType);
  },

  // Diagnostic tools
  checkDeliveredOrders: () => {
    return ipcRenderer.invoke('diagnostic:check-delivered-orders');
  },

  fixMissingDriverIds: (driverId: string) => {
    return ipcRenderer.invoke('diagnostic:fix-missing-driver-ids', driverId);
  },

  forceSyncOrders: (orderIds: string[]) => {
    return ipcRenderer.invoke('diagnostic:force-sync-orders', orderIds);
  },

  markEarningsSynced: (earningIds: string[]) => {
    return ipcRenderer.invoke('diagnostic:mark-earnings-synced', earningIds);
  },

  markAllUnsyncedEarnings: () => {
    return ipcRenderer.invoke('diagnostic:mark-all-unsynced-earnings');
  },

  // Printing
  printReceipt: (receiptData: any, type: string = 'customer') => {
    return ipcRenderer.invoke('payment:print-receipt', receiptData, type);
  },

  // Customer cache management methods
  customerInvalidateCache: (phone: string) => {
    return ipcRenderer.invoke('customer:invalidate-cache', phone);
  },

  customerGetCacheStats: () => {
    return ipcRenderer.invoke('customer:get-cache-stats');
  },

  customerClearCache: () => {
    return ipcRenderer.invoke('customer:clear-cache');
  },

  // Customer lookup methods
  customerLookupByPhone: (phone: string) => {
    return ipcRenderer.invoke('customer:lookup-by-phone', phone);
  },

  customerLookupById: (customerId: string) => {
    return ipcRenderer.invoke('customer:lookup-by-id', customerId);
  },

  customerSearch: (query: string) => {
    return ipcRenderer.invoke('customer:search', query);
  },

  // Customer real-time event listeners
  onCustomerCreated: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('customer-created', subscription);
  },

  removeCustomerCreatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('customer-created', callback);
  },

  onCustomerUpdated: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('customer-updated', subscription);
  },

  removeCustomerUpdatedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('customer-updated', callback);
  },

  onCustomerDeleted: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('customer-deleted', subscription);
  },

  removeCustomerDeletedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('customer-deleted', callback);
  },

  // Customer CRUD/conflict wrappers
  customerCreate: (data: any) => {
    return ipcRenderer.invoke('customer:create', data);
  },

  customerUpdate: (customerId: string, updates: any, currentVersion: number) => {
    return ipcRenderer.invoke('customer:update', customerId, updates, currentVersion);
  },

  customerAddAddress: (customerId: string, address: any) => {
    return ipcRenderer.invoke('customer:add-address', customerId, address);
  },

  customerUpdateAddress: (addressId: string, updates: any, currentVersion: number) => {
    return ipcRenderer.invoke('customer:update-address', addressId, updates, currentVersion);
  },

  customerResolveConflict: (conflictId: string, strategy: string, data?: any) => {
    return ipcRenderer.invoke('customer:resolve-conflict', conflictId, strategy, data);
  },

  customerGetConflicts: (filters?: any) => {
    return ipcRenderer.invoke('customer:get-conflicts', filters);
  },

  // Sync methods
  getSyncStatus: () => {
    return ipcRenderer.invoke('sync:get-status');
  },

  forceSync: () => {
    return ipcRenderer.invoke('sync:force');
  },

  getFinancialSyncStats: () => {
    return ipcRenderer.invoke('sync:get-financial-stats');
  },

  getFailedFinancialSyncItems: (limit?: number) => {
    return ipcRenderer.invoke('sync:get-failed-financial-items', limit);
  },

  retryFinancialSyncItem: (syncId: string) => {
    return ipcRenderer.invoke('sync:retry-financial-item', syncId);
  },

  retryAllFailedFinancialSyncs: () => {
    return ipcRenderer.invoke('sync:retry-all-failed-financial');
  },

  getNetworkStatus: () => {
    return ipcRenderer.invoke('sync:get-network-status');
  },

  // Terminal settings helpers
  getTerminalSettings: () => {
    return ipcRenderer.invoke('terminal-config:get-settings')
  },
  getTerminalSetting: (category: string, key: string) => {
    return ipcRenderer.invoke('terminal-config:get-setting', category, key)
  },
  getTerminalBranchId: () => {
    return ipcRenderer.invoke('terminal-config:get-branch-id')
  },
  getTerminalId: () => {
    return ipcRenderer.invoke('terminal-config:get-terminal-id')
  },
  getTerminalApiKey: async () => {
    // Retrieve the API key from terminal settings (stored as terminal.pos_api_key)
    return ipcRenderer.invoke('terminal-config:get-setting', 'terminal', 'pos_api_key')
  },
  refreshTerminalSettings: () => {
    return ipcRenderer.invoke('terminal-config:refresh')
  },
  onTerminalSettingsUpdated: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on('terminal-settings-updated', subscription)
    return () => ipcRenderer.removeListener('terminal-settings-updated', subscription)
  },

  // Listen for terminal config updates (branch_id, organization_id from heartbeat)
  onTerminalConfigUpdated: (callback: (data: { branch_id?: string; organization_id?: string }) => void) => {
    const subscription = (_event: any, data: any) => {
      console.log('[Preload] Received terminal-config-updated:', data);
      callback(data);
    };
    ipcRenderer.on('terminal-config-updated', subscription);
    return () => ipcRenderer.removeListener('terminal-config-updated', subscription);
  },

  onCustomerConflictDetected: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data);
    ipcRenderer.on('customer-sync-conflict', subscription);
  },

  removeCustomerConflictDetectedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('customer-sync-conflict', callback);
  },

  // Report methods
  getTodayStatistics: (branchId: string) => {
    return ipcRenderer.invoke('report:get-today-statistics', { branchId });
  },

  getSalesTrend: (params: { branchId: string; days: number }) => {
    return ipcRenderer.invoke('report:get-sales-trend', params);
  },

  getTopItems: (params: { branchId: string; date?: string; limit?: number }) => {
    return ipcRenderer.invoke('report:get-top-items', params);
  },

  getWeeklyTopItems: (params: { branchId: string; limit?: number }) => {
    return ipcRenderer.invoke('report:get-weekly-top-items', params);
  },

  generateZReport: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:generate-z-report', params);
  },

  getDailyStaffPerformance: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:get-daily-staff-performance', params);
  },

  getHourlySales: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:get-hourly-sales', params);
  },

  getPaymentMethodBreakdown: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:get-payment-method-breakdown', params);
  },

  getOrderTypeBreakdown: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:get-order-type-breakdown', params);
  },

  submitZReport: (params: { branchId: string; date?: string }) => {
    return ipcRenderer.invoke('report:submit-z-report', params);
  },

  // Screen capture - SECURITY: Use IPC to go through main process consent dialog
  // Direct desktopCapturer access is removed for security
  screenCapture: {
    // Request screen capture permission through main process (shows consent dialog)
    getSources: (options: { types: ('screen' | 'window')[] }) =>
      ipcRenderer.invoke('screen-capture:get-sources', options),
  },

  // =========================================================================
  // Printer Manager Methods
  // =========================================================================

  /**
   * Discover available printers
   * @param types - Optional array of printer types to discover
   */
  printerDiscover: (types?: string[]) => {
    return ipcRenderer.invoke('printer:discover', types);
  },

  /**
   * Add a new printer configuration
   * @param config - Printer configuration
   */
  printerAdd: (config: any) => {
    return ipcRenderer.invoke('printer:add', config);
  },

  /**
   * Update an existing printer configuration
   * @param printerId - The printer ID to update
   * @param updates - Partial configuration updates
   */
  printerUpdate: (printerId: string, updates: any) => {
    return ipcRenderer.invoke('printer:update', printerId, updates);
  },

  /**
   * Remove a printer configuration
   * @param printerId - The printer ID to remove
   */
  printerRemove: (printerId: string) => {
    return ipcRenderer.invoke('printer:remove', printerId);
  },

  /**
   * Get all printer configurations
   */
  printerGetAll: () => {
    return ipcRenderer.invoke('printer:get-all');
  },

  /**
   * Get the status of a specific printer
   * @param printerId - The printer ID
   */
  printerGetStatus: (printerId: string) => {
    return ipcRenderer.invoke('printer:get-status', printerId);
  },

  /**
   * Get all printer statuses
   */
  printerGetAllStatuses: () => {
    return ipcRenderer.invoke('printer:get-all-statuses');
  },

  /**
   * Submit a print job
   * @param job - The print job to submit
   */
  printerSubmitJob: (job: any) => {
    return ipcRenderer.invoke('printer:submit-job', job);
  },

  /**
   * Cancel a print job
   * @param jobId - The job ID to cancel
   */
  printerCancelJob: (jobId: string) => {
    return ipcRenderer.invoke('printer:cancel-job', jobId);
  },

  /**
   * Retry a failed print job
   * @param jobId - The job ID to retry
   */
  printerRetryJob: (jobId: string) => {
    return ipcRenderer.invoke('printer:retry-job', jobId);
  },

  /**
   * Send a test print to a printer
   * @param printerId - The printer ID
   */
  printerTest: (printerId: string) => {
    return ipcRenderer.invoke('printer:test', printerId);
  },

  /**
   * Test Greek printing with different encoding modes
   * @param mode - Encoding mode: 'ascii', 'cp737', 'cp1253', or 'utf8'
   * @param printerName - Windows printer name (default: 'POS-80')
   * 
   * Usage from DevTools console:
   *   window.electronAPI.printerTestGreekDirect('ascii')           // ASCII only test
   *   window.electronAPI.printerTestGreekDirect('cp737')           // CP737 Greek encoding
   *   window.electronAPI.printerTestGreekDirect('cp1253')          // Windows-1253 Greek
   *   window.electronAPI.printerTestGreekDirect('utf8')            // UTF-8
   *   window.electronAPI.printerTestGreekDirect('ascii', 'POS-80 RAW') // Specify printer
   */
  printerTestGreekDirect: (mode: string = 'ascii', printerName: string = 'POS-80') => {
    return ipcRenderer.invoke('printer:test-greek-direct', mode, printerName);
  },

  /**
   * Get diagnostics for a printer
   * @param printerId - The printer ID
   */
  printerGetDiagnostics: (printerId: string) => {
    return ipcRenderer.invoke('printer:diagnostics', printerId);
  },

  /**
   * Get Bluetooth availability status
   * @returns Object with available flag and optional error message
   */
  printerGetBluetoothStatus: () => {
    return ipcRenderer.invoke('printer:bluetooth-status');
  },

  // =========================================================================
  // Label Printing Methods
  // =========================================================================

  /**
   * Print a label (barcode, shelf, or price)
   * @param request - Label print request with type and data
   * @param printerId - Optional specific printer ID
   */
  printLabel: (request: {
    type: 'barcode' | 'shelf' | 'price';
    barcode?: string;
    barcodeType?: string;
    productName: string;
    productPrice?: number;
    productSku?: string;
    productDescription?: string;
    showName?: boolean;
    showPrice?: boolean;
    quantity?: number;
    size?: 'small' | 'medium' | 'large';
    template?: 'standard' | 'compact' | 'detailed' | 'price-focus';
    oldPrice?: number;
    showSaleIndicator?: boolean;
  }, printerId?: string) => {
    return ipcRenderer.invoke('label:print', request, printerId);
  },

  /**
   * Print batch labels for multiple products
   * @param items - Array of products with quantities
   * @param labelType - Type of label to print
   * @param printerId - Optional specific printer ID
   */
  printBatchLabels: (items: Array<{
    product: {
      name: string;
      sku?: string;
      barcode?: string;
      barcodeType?: string;
      price: number;
      description?: string;
    };
    quantity: number;
  }>, labelType: 'barcode' | 'shelf' | 'price' = 'barcode', printerId?: string) => {
    return ipcRenderer.invoke('label:print-batch', items, labelType, printerId);
  },

  /**
   * Listen for printer status changes
   * @param callback - Function to call when status changes
   */
  onPrinterStatusChanged: (callback: (data: { printerId: string; status: any }) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('printer:status-changed', subscription);
    return () => ipcRenderer.removeListener('printer:status-changed', subscription);
  },

  /**
   * Remove printer status change listener
   * @param callback - The callback to remove
   */
  removePrinterStatusChangedListener: (callback: (data: any) => void) => {
    ipcRenderer.removeListener('printer:status-changed', callback);
  },

  // =========================================================================
  // Auto-Updater Methods
  // =========================================================================

  /**
   * Listen for menu-triggered update check event
   * @param callback - Function to call when update check is triggered from menu
   */
  onMenuCheckForUpdates: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('menu:check-for-updates', subscription);
    return () => ipcRenderer.removeListener('menu:check-for-updates', subscription);
  },

  /**
   * Listen for update checking status
   * @param callback - Function to call when checking starts
   */
  onUpdateChecking: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('update-checking', subscription);
    return () => ipcRenderer.removeListener('update-checking', subscription);
  },

  /**
   * Listen for update available event
   * @param callback - Function to call with update info
   */
  onUpdateAvailable: (callback: (info: any) => void) => {
    const subscription = (_event: IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('update-available', subscription);
    return () => ipcRenderer.removeListener('update-available', subscription);
  },

  /**
   * Listen for update not available event
   * @param callback - Function to call when no update is available
   */
  onUpdateNotAvailable: (callback: (info: any) => void) => {
    const subscription = (_event: IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('update-not-available', subscription);
    return () => ipcRenderer.removeListener('update-not-available', subscription);
  },

  /**
   * Listen for download progress
   * @param callback - Function to call with progress info
   */
  onDownloadProgress: (callback: (progress: any) => void) => {
    const subscription = (_event: IpcRendererEvent, progress: any) => callback(progress);
    ipcRenderer.on('download-progress', subscription);
    return () => ipcRenderer.removeListener('download-progress', subscription);
  },

  /**
   * Listen for update downloaded event
   * @param callback - Function to call when update is downloaded
   */
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const subscription = (_event: IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('update-downloaded', subscription);
    return () => ipcRenderer.removeListener('update-downloaded', subscription);
  },

  /**
   * Listen for update error event
   * @param callback - Function to call with error info
   */
  onUpdateError: (callback: (error: { message: string }) => void) => {
    const subscription = (_event: IpcRendererEvent, error: any) => callback(error);
    ipcRenderer.on('update-error', subscription);
    return () => ipcRenderer.removeListener('update-error', subscription);
  },

  /**
   * Check for updates
   */
  checkForUpdates: () => {
    return ipcRenderer.invoke('update:check');
  },

  /**
   * Download the available update
   */
  downloadUpdate: () => {
    return ipcRenderer.invoke('update:download');
  },

  /**
   * Cancel the current download
   */
  cancelDownload: () => {
    return ipcRenderer.invoke('update:cancel-download');
  },

  /**
   * Install the downloaded update (quits and installs)
   */
  installUpdate: () => {
    return ipcRenderer.invoke('update:install');
  },

  /**
   * Get the current update state
   */
  getUpdateState: () => {
    return ipcRenderer.invoke('update:get-state');
  },

  /**
   * Set the update channel (stable or beta)
   * @param channel - The channel to set
   */
  setUpdateChannel: (channel: 'stable' | 'beta') => {
    return ipcRenderer.invoke('update:set-channel', channel);
  },

  // =========================================================================
  // Admin Dashboard API Methods
  // =========================================================================

  /**
   * Fetch data from the admin dashboard API with terminal authentication
   * @param path - API path (e.g., '/api/pos/inventory')
   * @param options - Optional fetch options (method, body, headers)
   * @returns Promise resolving to the API response
   */
  fetchFromApi: async (path: string, options?: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
  }): Promise<any> => {
    return ipcRenderer.invoke('api:fetch-from-admin', path, options);
  },

  // =========================================================================
  // ECR (Payment Terminal) Methods
  // =========================================================================

  /**
   * Discover available payment terminals
   * @param connectionTypes - Optional array of connection types to search
   * @param timeout - Optional timeout in milliseconds
   */
  ecrDiscoverDevices: (connectionTypes?: string[], timeout?: number) => {
    return ipcRenderer.invoke('ecr:discover-devices', connectionTypes, timeout);
  },

  /**
   * Get all configured ECR devices
   */
  ecrGetDevices: () => {
    return ipcRenderer.invoke('ecr:get-devices');
  },

  /**
   * Get a specific ECR device
   * @param deviceId - The device ID
   */
  ecrGetDevice: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:get-device', deviceId);
  },

  /**
   * Add a new ECR device
   * @param config - Device configuration
   */
  ecrAddDevice: (config: any) => {
    return ipcRenderer.invoke('ecr:add-device', config);
  },

  /**
   * Update an ECR device
   * @param deviceId - The device ID
   * @param updates - Partial updates
   */
  ecrUpdateDevice: (deviceId: string, updates: any) => {
    return ipcRenderer.invoke('ecr:update-device', deviceId, updates);
  },

  /**
   * Remove an ECR device
   * @param deviceId - The device ID
   */
  ecrRemoveDevice: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:remove-device', deviceId);
  },

  /**
   * Get the default payment terminal
   */
  ecrGetDefaultTerminal: () => {
    return ipcRenderer.invoke('ecr:get-default-terminal');
  },

  /**
   * Connect to an ECR device
   * @param deviceId - The device ID
   */
  ecrConnectDevice: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:connect-device', deviceId);
  },

  /**
   * Disconnect from an ECR device
   * @param deviceId - The device ID
   */
  ecrDisconnectDevice: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:disconnect-device', deviceId);
  },

  /**
   * Get the status of an ECR device
   * @param deviceId - The device ID
   */
  ecrGetDeviceStatus: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:get-device-status', deviceId);
  },

  /**
   * Get all ECR device statuses
   */
  ecrGetAllStatuses: () => {
    return ipcRenderer.invoke('ecr:get-all-statuses');
  },

  /**
   * Process a card payment
   * @param amount - Amount in cents
   * @param options - Optional parameters (deviceId, orderId, tipAmount, currency)
   */
  ecrProcessPayment: (amount: number, options?: {
    deviceId?: string;
    orderId?: string;
    tipAmount?: number;
    currency?: string;
    reference?: string;
  }) => {
    return ipcRenderer.invoke('ecr:process-payment', amount, options);
  },

  /**
   * Process a refund
   * @param amount - Amount in cents
   * @param options - Optional parameters
   */
  ecrProcessRefund: (amount: number, options?: {
    deviceId?: string;
    orderId?: string;
    originalTransactionId?: string;
    currency?: string;
  }) => {
    return ipcRenderer.invoke('ecr:process-refund', amount, options);
  },

  /**
   * Void a transaction
   * @param transactionId - The transaction ID to void
   * @param deviceId - Optional device ID
   */
  ecrVoidTransaction: (transactionId: string, deviceId?: string) => {
    return ipcRenderer.invoke('ecr:void-transaction', transactionId, deviceId);
  },

  /**
   * Cancel an in-progress transaction
   * @param deviceId - The device ID
   */
  ecrCancelTransaction: (deviceId: string) => {
    return ipcRenderer.invoke('ecr:cancel-transaction', deviceId);
  },

  /**
   * Perform end-of-day settlement
   * @param deviceId - Optional device ID (uses default if not specified)
   */
  ecrSettlement: (deviceId?: string) => {
    return ipcRenderer.invoke('ecr:settlement', deviceId);
  },

  /**
   * Get recent transactions
   * @param limit - Maximum number of transactions to return
   */
  ecrGetRecentTransactions: (limit?: number) => {
    return ipcRenderer.invoke('ecr:get-recent-transactions', limit);
  },

  /**
   * Query transactions with filters
   * @param filters - Transaction filters
   */
  ecrQueryTransactions: (filters: any) => {
    return ipcRenderer.invoke('ecr:query-transactions', filters);
  },

  /**
   * Get transaction statistics
   * @param filters - Optional filters
   */
  ecrGetTransactionStats: (filters?: any) => {
    return ipcRenderer.invoke('ecr:get-transaction-stats', filters);
  },

  /**
   * Get the transaction associated with an order
   * @param orderId - The order ID
   */
  ecrGetTransactionForOrder: (orderId: string) => {
    return ipcRenderer.invoke('ecr:get-transaction-for-order', orderId);
  },

  /**
   * Listen for ECR device connected events
   * @param callback - Function to call when a device connects
   */
  onEcrDeviceConnected: (callback: (deviceId: string) => void) => {
    const subscription = (_event: IpcRendererEvent, deviceId: string) => callback(deviceId);
    ipcRenderer.on('ecr:event:device-connected', subscription);
    return () => ipcRenderer.removeListener('ecr:event:device-connected', subscription);
  },

  /**
   * Listen for ECR device disconnected events
   * @param callback - Function to call when a device disconnects
   */
  onEcrDeviceDisconnected: (callback: (deviceId: string) => void) => {
    const subscription = (_event: IpcRendererEvent, deviceId: string) => callback(deviceId);
    ipcRenderer.on('ecr:event:device-disconnected', subscription);
    return () => ipcRenderer.removeListener('ecr:event:device-disconnected', subscription);
  },

  /**
   * Listen for ECR device status changes
   * @param callback - Function to call when status changes
   */
  onEcrDeviceStatusChanged: (callback: (deviceId: string, status: any) => void) => {
    const subscription = (_event: IpcRendererEvent, deviceId: string, status: any) => callback(deviceId, status);
    ipcRenderer.on('ecr:event:device-status-changed', subscription);
    return () => ipcRenderer.removeListener('ecr:event:device-status-changed', subscription);
  },

  /**
   * Listen for ECR transaction completion events
   * @param callback - Function to call when a transaction completes
   */
  onEcrTransactionCompleted: (callback: (data: any) => void) => {
    const subscription = (_event: IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('ecr:event:transaction-completed', subscription);
    return () => ipcRenderer.removeListener('ecr:event:transaction-completed', subscription);
  },

  /**
   * Listen for ECR display messages
   * @param callback - Function to call when a display message is received
   */
  onEcrDisplayMessage: (callback: (deviceId: string, message: string) => void) => {
    const subscription = (_event: IpcRendererEvent, deviceId: string, message: string) => callback(deviceId, message);
    ipcRenderer.on('ecr:event:display-message', subscription);
    return () => ipcRenderer.removeListener('ecr:event:display-message', subscription);
  },

  /**
   * Listen for ECR errors
   * @param callback - Function to call when an error occurs
   */
  onEcrError: (callback: (deviceId: string, error: string) => void) => {
    const subscription = (_event: IpcRendererEvent, deviceId: string, error: string) => callback(deviceId, error);
    ipcRenderer.on('ecr:event:error', subscription);
    return () => ipcRenderer.removeListener('ecr:event:error', subscription);
  },

  // =========================================================================
  // Cash Drawer Methods
  // =========================================================================

  /**
   * Open the cash drawer connected to a receipt printer
   * @param printerId - Optional printer ID (uses default if not specified)
   * @param drawerNumber - Optional drawer number (1 or 2, default 1)
   */
  openCashDrawer: (printerId?: string, drawerNumber?: 1 | 2) => {
    return ipcRenderer.invoke('printer:open-cash-drawer', printerId, drawerNumber);
  },
};

// Top-level convenience wrappers that delegate to whitelisted ipcRenderer methods
; (electronAPI as any).on = (channel: string, callback: (data: any) => void) => {
  if (!isAllowedChannel(channel)) {
    console.error(`Attempted to listen to non-whitelisted channel: ${channel}`)
    return
  }
  const subscription = (_event: IpcRendererEvent, data: any) => {
    // Add safety check for undefined data
    if (data === undefined || data === null) {
      console.warn(`[IPC] Received undefined/null data on channel: ${channel}`)
      return
    }
    callback(data)
  }
  ipcRenderer.on(channel, subscription)
}

  ; (electronAPI as any).off = (channel: string, callback: (data: any) => void) => {
    if (!isAllowedChannel(channel)) {
      console.error(`Attempted to remove listener from non-whitelisted channel: ${channel}`)

      return
    }
    ipcRenderer.removeListener(channel, callback)
  }

  ; (electronAPI as any).removeAllListeners = (channel: string) => {
    if (!isAllowedChannel(channel)) {
      console.error(`Attempted to remove all listeners from non-whitelisted channel: ${channel}`)
      return
    }
    ipcRenderer.removeAllListeners(channel)
  }

  // Delegate to whitelisted invoke implementation above
  ; (electronAPI as any).invoke = async (channel: string, ...args: any[]) => {
    return (electronAPI as any).ipcRenderer.invoke(channel, ...args)
  }

  // Strictly whitelist send channels (empty by default)
  ; (electronAPI as any).send = (channel: string, ...args: any[]) => {
    const allowedSends: readonly string[] = [
      // e.g., 'some-fire-and-forget-channel'
    ]
    if (!allowedSends.includes(channel)) {
      console.error(`Attempted to send on non-whitelisted channel: ${channel}`)
      throw new Error(`Unauthorized IPC send: ${channel}`)
    }
    ipcRenderer.send(channel, ...args)
  }


// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('electron', electronAPI);

// Also expose a flag to indicate Electron environment
contextBridge.exposeInMainWorld('isElectron', true);

// Log successful preload initialization (only in development)
if (process.env.NODE_ENV === 'development') {
  console.log('✅ Secure preload script initialized');
  console.log(`📋 Whitelisted channels: ${ALLOWED_CHANNELS.length}`);
}



// Export the ElectronAPI type for renderer type-safety
export type ElectronAPI = typeof electronAPI & {
  on: (channel: string, callback: (data: any) => void) => void
  off: (channel: string, callback: (data: any) => void) => void
  removeAllListeners: (channel: string) => void
  invoke: (channel: string, ...args: any[]) => Promise<any>
  send: (channel: string, ...args: any[]) => void
}
