// Declare global Window interface
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    electron?: {
      ipcRenderer: {
        on: (channel: string, callback: (data: any) => void) => void;
        removeListener: (channel: string, callback: (data: any) => void) => void;
        removeAllListeners: (channel: string) => void;
        invoke: (channel: string, ...args: any[]) => Promise<any>;
      };
      clipboard?: {
        readText: () => Promise<string>;
        writeText: (text: string) => Promise<void>;
      };
    };
    isElectron?: boolean;
  }
}

// IPC API available in renderer via preload
interface ElectronAPI {
  // Window controls
  minimize: () => Promise<boolean> | void;
  maximize: () => Promise<boolean> | void;
  close: () => Promise<boolean> | void;

  // Settings
  getSettings: () => Promise<any>;
  updateSettings: (payload: { settingType: string; settings: any }) => Promise<any>;

  // Auth
  login: (pin: string, staffId?: string) => Promise<any>;
  logout: () => Promise<any>;

  // System
  getSystemInfo: () => Promise<any>;

  // Sync and Network Status
  getSyncStatus?: () => Promise<any>;
  onSyncStatus?: (callback: (status: any) => void) => void;
  onNetworkStatus?: (callback: (status: any) => void) => void;
  removeSyncStatusListener?: (callback?: (status: any) => void) => void;
  removeNetworkStatusListener?: (callback?: (status: any) => void) => void;
  forceSync?: () => Promise<void>;
  openSyncLogs?: () => void;

  // Sync Notifications
  onSettingsUpdate?: (callback: (settings: any) => void) => void;
  onStaffPermissionUpdate?: (callback: (permissions: any) => void) => void;
  onHardwareConfigUpdate?: (callback: (config: any) => void) => void;
  onRestartRequired?: (callback: (notification: any) => void) => void;
  onSyncError?: (callback: (error: any) => void) => void;
  onSyncComplete?: (callback: (result: any) => void) => void;
  removeSettingsUpdateListener?: (callback?: (settings: any) => void) => void;
  removeStaffPermissionUpdateListener?: (callback?: (permissions: any) => void) => void;
  removeHardwareConfigUpdateListener?: (callback?: (config: any) => void) => void;
  removeRestartRequiredListener?: (callback?: (notification: any) => void) => void;
  removeSyncErrorListener?: (callback?: (error: any) => void) => void;
  removeSyncCompleteListener?: (callback?: (result: any) => void) => void;
  requestRestart?: () => void;

  // Notifications
  showNotification?: (options: { title: string; body: string; type?: string } | string, body?: string) => void;

  // Error Handling
  saveOrderForRetry?: (order: any) => Promise<{ success: boolean; error?: string }>;
  getPendingOrders?: () => Promise<any[]>;

  // Customer Service
  customerLookup?: (phone: string) => Promise<any>;
  customerSearch?: (query: string) => Promise<any>;
  customerClearExpiredCache?: () => Promise<any>;
  customerGetCacheStats?: () => Promise<any>;
  customerLookupByPhone?: (phone: string) => Promise<any>;
  customerInvalidateCache?: (phone: string) => Promise<void>;
  customerClearCache?: () => Promise<void>;

  // Order real-time events
  onOrderCreated?: (callback: (data: any) => void) => void;
  removeOrderCreatedListener?: (callback: (data: any) => void) => void;

  // Customer real-time events
  onCustomerCreated?: (callback: (data: any) => void) => void;
  removeCustomerCreatedListener?: (callback: (data: any) => void) => void;
  onCustomerUpdated?: (callback: (data: any) => void) => void;
  removeCustomerUpdatedListener?: (callback: (data: any) => void) => void;
  onCustomerDeleted?: (callback: (data: any) => void) => void;
  removeCustomerDeletedListener?: (callback: (data: any) => void) => void;

  // Settings helpers
  getDiscountMaxPercentage?: () => Promise<number>;
  getTaxRatePercentage?: () => Promise<number>;
  setDiscountMaxPercentage?: (percentage: number) => Promise<{ success: boolean; error?: string }>;
  setTaxRatePercentage?: (percentage: number) => Promise<{ success: boolean; error?: string }>;

  // Terminal settings helpers
  getTerminalSettings?: () => Promise<any>;
  getTerminalSetting?: (category: string, key: string) => Promise<any>;
  getTerminalBranchId?: () => Promise<string | null>;
  getTerminalId?: () => Promise<string | null>;
  getTerminalApiKey?: () => Promise<string | null>;
  refreshTerminalSettings?: () => Promise<void>;

  // Shift management
  openShift?: (...args: any[]) => Promise<any>;
  closeShift?: (...args: any[]) => Promise<any>;
  getActiveShift?: (staffId: string) => Promise<any>;
  getShiftSummary?: (shiftId: string, options?: { skipBackfill?: boolean }) => Promise<any>;
  recordExpense?: (...args: any[]) => Promise<any>;
  getExpenses?: (shiftId: string) => Promise<any>;
  getShiftExpenses?: (shiftId: string) => Promise<any>;
  /** Maintenance: Backfill driver earnings for a specific shift or date */
  backfillDriverEarnings?: (params: { shiftId?: string; date?: string }) => Promise<{
    success: boolean;
    message?: string;
    processed?: number;
    total?: number;
    error?: string;
  }>;

  // Driver management
  getActiveDrivers?: (branchId: string) => Promise<any[]>;
  recordDriverEarning?: (...args: any[]) => Promise<any>;
  getDriverEarnings?: (shiftId: string) => Promise<any[]>;
  getDriverShiftSummary?: (shiftId: string) => Promise<any>;

  // Conflict and retry management
  getOrderConflicts?: () => Promise<any>;
  resolveOrderConflict?: (conflictId: string, strategy: string, data?: any) => Promise<any>;
  forceOrderSyncRetry?: (orderId: string) => Promise<any>;
  getOrderRetryInfo?: (orderId: string) => Promise<any>;

  // Printing
  printReceipt?: (receiptData: any, type?: string) => Promise<any>;


  // Order type update
  updateOrderType?: (orderId: string, orderType: string) => Promise<{ success: boolean; orderId?: string; orderType?: string; error?: string }>;
  // Reports
  getTodayStatistics?: (branchId: string) => Promise<any>;
  getSalesTrend?: (params: { branchId: string; days: number }) => Promise<any>;
  getTopItems?: (params: { branchId: string; date?: string; limit?: number }) => Promise<any>;
  generateZReport?: (params: { branchId: string; date?: string }) => Promise<any>;
  getDailyStaffPerformance?: (params: { branchId: string; date?: string }) => Promise<any>;
  submitZReport?: (params: { branchId: string; date?: string }) => Promise<{ success: boolean; id?: string; error?: string }>;

  // Real-time order updates
  onOrderRealtimeUpdate: (callback: (orderData: any) => void) => void;
  onOrderStatusUpdated: (callback: (data: { orderId: string; status: string }) => void) => void;
  onOrderDeleted: (callback: (data: { orderId: string }) => void) => void;
  onOrderPaymentUpdated: (callback: (data: any) => void) => void;

  // Cleanup functions for real-time listeners
  removeOrderRealtimeUpdateListener?: (callback: (orderData: any) => void) => void;
  removeOrderStatusUpdatedListener?: (callback: (data: { orderId: string; status: string }) => void) => void;
  removeOrderDeletedListener?: (callback: (data: { orderId: string }) => void) => void;
  removeOrderPaymentUpdatedListener?: (callback: (data: any) => void) => void;

  // IPC Renderer (for advanced usage)
  ipcRenderer?: {
    on: (channel: string, callback: (data: any) => void) => void;
    removeListener: (channel: string, callback: (data: any) => void) => void;
    removeAllListeners: (channel: string) => void;
    invoke: (channel: string, ...args: any[]) => Promise<any>;
  };

  // =========================================================================
  // Auto-Updater Methods (Requirements: 2.1, 2.4, 2.5)
  // =========================================================================

  /**
   * Listen for menu-triggered update check event
   * @param callback - Function to call when update check is triggered from menu
   * @returns Cleanup function to remove the listener
   */
  onMenuCheckForUpdates?: (callback: () => void) => () => void;

  /**
   * Listen for update checking status
   * @param callback - Function to call when checking starts
   * @returns Cleanup function to remove the listener
   */
  onUpdateChecking?: (callback: () => void) => () => void;

  /**
   * Listen for update available event
   * @param callback - Function to call with update info
   * @returns Cleanup function to remove the listener
   */
  onUpdateAvailable?: (callback: (info: UpdateInfo) => void) => () => void;

  /**
   * Listen for update not available event
   * @param callback - Function to call when no update is available
   * @returns Cleanup function to remove the listener
   */
  onUpdateNotAvailable?: (callback: (info: UpdateInfo) => void) => () => void;

  /**
   * Listen for download progress
   * @param callback - Function to call with progress info
   * @returns Cleanup function to remove the listener
   */
  onDownloadProgress?: (callback: (progress: ProgressInfo) => void) => () => void;

  /**
   * Listen for update downloaded event
   * @param callback - Function to call when update is downloaded
   * @returns Cleanup function to remove the listener
   */
  onUpdateDownloaded?: (callback: (info: UpdateInfo) => void) => () => void;

  /**
   * Listen for update error event
   * @param callback - Function to call with error info
   * @returns Cleanup function to remove the listener
   */
  onUpdateError?: (callback: (error: { message: string }) => void) => () => void;

  /**
   * Check for updates
   * @returns Promise resolving to update info or null
   */
  checkForUpdates?: () => Promise<UpdateInfo | null>;

  /**
   * Download the available update
   * @returns Promise that resolves when download starts
   */
  downloadUpdate?: () => Promise<void>;

  /**
   * Cancel the current download
   */
  cancelDownload?: () => void;

  /**
   * Install the downloaded update (quits and installs)
   */
  installUpdate?: () => void;

  /**
   * Get the current update state
   * @returns Promise resolving to the current update state
   */
  getUpdateState?: () => Promise<UpdateState>;

  /**
   * Set the update channel (stable or beta)
   * @param channel - The channel to set
   */
  setUpdateChannel?: (channel: 'stable' | 'beta') => void;
}

// Update-related types
interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes?: string | ReleaseNoteInfo[];
  releaseName?: string;
}

interface ReleaseNoteInfo {
  version: string;
  note: string;
}

interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  updateInfo?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

// Intentionally no export here so this file contributes to the global namespace
