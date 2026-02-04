/**
 * ModuleSyncService - Handles fetching and syncing modules from admin dashboard
 *
 * This service is responsible for:
 * - Fetching enabled modules from the admin dashboard API
 * - Handling HTTP errors gracefully with fallback to cache
 * - Periodic sync to keep modules up-to-date
 * - Manual force sync capability
 * - Real-time sync via Supabase Realtime subscriptions
 * - Connection status monitoring and automatic reconnection
 *
 * Requirements: 1.1, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 10.5
 *
 * @see tickets/e6d8aa4d-3abf-42ae-a33b-34d83daee1e1-Phase_3.2__Enhance_Real-Time_Module_Sync_with_Supabase_Realtime.md
 */

import { BrowserWindow } from 'electron';
import { DatabaseManager } from '../database';
import { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../../shared/supabase-config';
import {
  OfflineModuleQueue,
  createBrowserOfflineQueue,
  ModuleAction,
  ModuleActionType,
} from '../../../../shared/services/OfflineModuleQueue';
import {
  validateDependencies,
  getDependencyStatus,
} from '../../../../shared/utils/moduleDependencies';
import { normalizeModuleId } from '../../../../shared/modules/registry';
import type { POSModulesEnabledResponse } from '../../shared/types/modules';

/**
 * Realtime connection status
 */
export type RealtimeConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ModuleSyncServiceConfig {
  adminDashboardUrl: string;
  syncIntervalMs?: number; // Default: 2 minutes (120000ms)
  fetchTimeoutMs?: number; // Default: 30 seconds (30000ms)
  /** Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Base delay in milliseconds between reconnection attempts (default: 2000) */
  reconnectDelayMs?: number;
}

/**
 * Dependency issue tracked during sync
 * Parity with: POSSystemMobile/src/services/ModuleSyncService.ts
 */
export interface DependencyIssue {
  moduleId: string;
  status: 'missing' | 'partial';
  missingDeps: string[];
}

export interface ModuleSyncResult {
  success: boolean;
  modules: POSModulesEnabledResponse | null;
  error?: string;
  fromCache?: boolean;
  /** Dependency issues found during validation (parity with mobile) */
  dependencyIssues?: DependencyIssue[];
}

/**
 * Service for syncing modules from the admin dashboard API
 */
export class ModuleSyncService {
  private config: Required<ModuleSyncServiceConfig>;
  private databaseManager: DatabaseManager | null = null;
  private mainWindow: BrowserWindow | null = null;
  private periodicSyncInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  // Supabase Realtime properties
  private supabaseClient: SupabaseClient | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private realtimeConnectionStatus: RealtimeConnectionStatus = 'disconnected';
  private organizationId: string | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectStableTimeout: NodeJS.Timeout | null = null;
  private readonly reconnectStableMs: number = 30000;
  private channelToken: number = 0;
  // Configurable reconnection constants
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;

  // Offline queue - uses shared OfflineModuleQueue service
  private offlineQueue: OfflineModuleQueue | null = null;
  private isOnline: boolean = true;

  constructor(config: ModuleSyncServiceConfig) {
    this.config = {
      adminDashboardUrl: config.adminDashboardUrl.replace(/\/$/, ''),
      syncIntervalMs: config.syncIntervalMs ?? 120000, // 2 minutes
      fetchTimeoutMs: config.fetchTimeoutMs ?? 30000, // 30 seconds
      maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
      reconnectDelayMs: config.reconnectDelayMs ?? 2000,
    };
    // Set configurable reconnection values with defaults
    this.maxReconnectAttempts = this.config.maxReconnectAttempts;
    this.reconnectDelayMs = this.config.reconnectDelayMs;

    // Initialize Supabase client
    this.initializeSupabaseClient();

    // Initialize offline queue with browser storage adapter
    this.initializeOfflineQueue();
  }

  /**
   * Initialize the shared offline queue for browser/Electron environment
   */
  private initializeOfflineQueue(): void {
    try {
      this.offlineQueue = createBrowserOfflineQueue();

      // Set up the action processor
      this.offlineQueue.setProcessor(async (action: ModuleAction) => {
        console.log('[ModuleSyncService] Processing queued action:', action);
        // Process action by syncing with server
        await this.forceSync();
      });

      // Subscribe to queue events for logging
      this.offlineQueue.on((event) => {
        switch (event.type) {
          case 'action-queued':
            console.log('[ModuleSyncService] Action queued:', event.payload);
            this.notifyRenderer('modules:action-queued', event.payload);
            break;
          case 'action-completed':
            console.log('[ModuleSyncService] Action completed:', event.payload);
            this.notifyRenderer('modules:action-completed', event.payload);
            break;
          case 'action-failed':
            console.warn('[ModuleSyncService] Action failed:', event.payload);
            this.notifyRenderer('modules:action-failed', event.payload);
            break;
          case 'queue-processing-start':
            console.log('[ModuleSyncService] Processing offline queue:', event.payload);
            break;
          case 'queue-processing-complete':
            console.log('[ModuleSyncService] Offline queue processing complete:', event.payload);
            break;
          case 'online-status-changed':
            this.notifyRenderer('modules:network-status', event.payload);
            break;
        }
      });

      // Listen for online/offline events in Electron
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          this.isOnline = true;
          this.offlineQueue?.setOnlineStatus(true);
          console.log('[ModuleSyncService] Browser online');
        });
        window.addEventListener('offline', () => {
          this.isOnline = false;
          this.offlineQueue?.setOnlineStatus(false);
          console.log('[ModuleSyncService] Browser offline');
        });
      }

      console.log('[ModuleSyncService] Offline queue initialized');
    } catch (error) {
      console.error('[ModuleSyncService] Failed to initialize offline queue:', error);
    }
  }

  /**
   * Initialize the Supabase client for real-time subscriptions
   */
  private initializeSupabaseClient(): void {
    try {
      if (!isSupabaseConfigured()) {
        console.warn('[ModuleSyncService] Supabase config incomplete, realtime disabled');
        return;
      }

      this.supabaseClient = getSupabaseClient();
      console.log('[ModuleSyncService] Supabase client initialized for realtime (shared)');
    } catch (error) {
      console.error('[ModuleSyncService] Failed to initialize Supabase client:', error);
    }
  }

  /**
   * Set the database manager for accessing terminal settings
   */
  setDatabaseManager(databaseManager: DatabaseManager): void {
    this.databaseManager = databaseManager;
  }

  /**
   * Set the main window for sending IPC notifications
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Fetch enabled modules from admin dashboard API
   *
   * @param terminalId - The terminal identifier
   * @param apiKey - The terminal's API key
   * @returns Promise<POSModulesEnabledResponse | null> - The API response or null on error
   *
   * Requirements: 1.1, 4.1, 4.2, 4.3, 4.4
   */
  async fetchEnabledModules(
    terminalId: string,
    apiKey: string
  ): Promise<POSModulesEnabledResponse | null> {
    // Validate inputs
    if (!terminalId || !apiKey) {
      console.warn('[ModuleSyncService] Missing terminalId or apiKey, skipping fetch');
      return null;
    }

    // Include terminal_id as query parameter (required by API)
    const url = `${this.config.adminDashboardUrl}/api/pos/modules/enabled?terminal_id=${encodeURIComponent(terminalId)}`;
    
    // Create abort controller for timeout (Requirement 4.2)
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, this.config.fetchTimeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': terminalId,
        'x-pos-api-key': apiKey,
      };

      console.log(`[ModuleSyncService] Fetching modules from ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      // Handle HTTP status codes (Requirements 4.1, 4.3, 4.4)
      if (!response.ok) {
        return this.handleHttpError(response.status, terminalId);
      }

      // Parse and validate response (Requirement 1.1)
      const data = await response.json();
      
      if (!this.isValidResponse(data)) {
        console.error('[ModuleSyncService] Invalid API response structure');
        return null;
      }

      console.log(`[ModuleSyncService] Successfully fetched ${data.modules?.length ?? 0} modules`);
      
      // Notify renderer of successful sync
      this.notifyRenderer('modules:sync-complete', {
        moduleCount: data.modules?.length ?? 0,
        timestamp: data.timestamp,
      });

      return data as POSModulesEnabledResponse;

    } catch (error) {
      clearTimeout(timeoutId);
      
      // Handle timeout (Requirement 4.2)
      if (error instanceof Error && error.name === 'AbortError') {
        console.error(`[ModuleSyncService] Request timed out after ${this.config.fetchTimeoutMs}ms`);
        this.notifyRenderer('modules:sync-error', {
          error: 'Request timed out',
          terminalId,
        });
        return null;
      }

      // Handle network errors (Requirement 4.1)
      console.error('[ModuleSyncService] Network error:', error);
      this.notifyRenderer('modules:sync-error', {
        error: error instanceof Error ? error.message : 'Network error',
        terminalId,
      });
      return null;
    }
  }

  /**
   * Handle HTTP error responses
   * 
   * @param status - HTTP status code
   * @param terminalId - Terminal ID for logging
   * @returns null (always returns null for error cases)
   * 
   * Requirements: 4.1, 4.3, 4.4
   */
  private handleHttpError(status: number, terminalId: string): null {
    switch (status) {
      case 401:
        // Authentication failed (Requirement 4.3)
        console.warn(`[ModuleSyncService] Authentication failed (401) for terminal ${terminalId}`);
        this.notifyRenderer('modules:sync-error', {
          error: 'Authentication failed',
          status: 401,
          terminalId,
        });
        break;

      case 404:
        // Terminal not found (Requirement 4.4)
        console.error(`[ModuleSyncService] Terminal not found (404): ${terminalId}`);
        this.notifyRenderer('modules:sync-error', {
          error: 'Terminal not found',
          status: 404,
          terminalId,
        });
        break;

      default:
        // Server errors (5xx) and other errors (Requirement 4.1)
        console.error(`[ModuleSyncService] HTTP error ${status} for terminal ${terminalId}`);
        this.notifyRenderer('modules:sync-error', {
          error: `HTTP error ${status}`,
          status,
          terminalId,
        });
        break;
    }

    return null;
  }

  /**
   * Validate the API response structure
   */
  private isValidResponse(data: unknown): data is POSModulesEnabledResponse {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const response = data as Record<string, unknown>;
    
    return (
      typeof response.success === 'boolean' &&
      Array.isArray(response.modules) &&
      typeof response.organization_id === 'string' &&
      typeof response.terminal_id === 'string' &&
      typeof response.timestamp === 'string'
    );
  }

  /**
   * Start periodic sync (every 2 minutes by default)
   * 
   * Requirements: 3.1, 3.2
   */
  startPeriodicSync(): void {
    if (this.periodicSyncInterval) {
      console.warn('[ModuleSyncService] Periodic sync already running');
      return;
    }

    console.log(`[ModuleSyncService] Starting periodic sync (interval: ${this.config.syncIntervalMs}ms)`);
    
    this.isRunning = true;
    this.periodicSyncInterval = setInterval(async () => {
      await this.forceSync();
    }, this.config.syncIntervalMs);

    // Trigger initial sync
    this.forceSync();
  }

  /**
   * Stop periodic sync
   * 
   * Requirements: 3.1, 3.2
   */
  stopPeriodicSync(): void {
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
    }
    this.isRunning = false;
    console.log('[ModuleSyncService] Periodic sync stopped');
  }

  /**
   * Force an immediate sync
   * 
   * Requirements: 3.1, 3.2
   */
  async forceSync(): Promise<ModuleSyncResult> {
    const dbSvc = this.databaseManager?.getDatabaseService?.();
    
    if (!dbSvc?.settings) {
      console.warn('[ModuleSyncService] Database service not available');
      return {
        success: false,
        modules: null,
        error: 'Database service not available',
      };
    }

    try {
      // Get terminal credentials from settings with fallback to environment variables
      const terminalId = (await dbSvc.settings.getSetting('terminal', 'terminal_id', '') as string) 
        || process.env.TERMINAL_ID 
        || '';
      const apiKey = (await dbSvc.settings.getSetting('terminal', 'pos_api_key', '') as string)
        || process.env.POS_API_KEY
        || process.env.POS_API_SHARED_KEY
        || '';

      if (!terminalId || !apiKey) {
        console.warn('[ModuleSyncService] Terminal not configured, skipping sync', {
          hasTerminalId: !!terminalId,
          hasApiKey: !!apiKey,
        });
        return {
          success: false,
          modules: null,
          error: 'Terminal not configured',
        };
      }

      const response = await this.fetchEnabledModules(terminalId, apiKey);

      if (response) {
        // Post-sync dependency validation
        // Validate that all enabled modules have their required dependencies met
        // Normalize module IDs to canonical form for consistent comparisons
        const enabledModuleIds = response.modules?.map(m => normalizeModuleId(m.module_id) || m.module_id) || [];
        const dependencyWarnings: Array<{ moduleId: string; status: 'missing' | 'partial'; missingDeps: string[] }> = [];

        for (const moduleId of enabledModuleIds) {
          const status = getDependencyStatus(moduleId, enabledModuleIds);
          if (status === 'missing' || status === 'partial') {
            const validation = validateDependencies(moduleId, enabledModuleIds, { includeRecommended: false });
            const missingDeps = validation.missing_dependencies.map(d => d.module_id as string);
            if (missingDeps.length > 0) {
              dependencyWarnings.push({ moduleId, status, missingDeps });
            }
          }
        }

        // Log and notify about dependency issues
        // Enhanced: Also emit high-priority error event for critical issues (parity with mobile)
        if (dependencyWarnings.length > 0) {
          console.warn('[ModuleSyncService] Post-sync dependency validation found issues:', dependencyWarnings);

          // Count critical issues (required deps missing)
          const criticalCount = dependencyWarnings.filter(w => w.status === 'missing').length;
          const affectedModules = dependencyWarnings.map(w => w.moduleId);

          this.notifyRenderer('modules:dependency-warnings', {
            warnings: dependencyWarnings,
            timestamp: new Date().toISOString(),
          });

          // Emit high-priority error event for critical dependencies (parity with mobile)
          if (criticalCount > 0) {
            this.notifyRenderer('modules:dependency-error', {
              warnings: dependencyWarnings,
              criticalCount,
              affectedModules,
              timestamp: Date.now(),
            });
          }
        }

        // Subscribe to realtime changes once we have the organization ID
        if (response.organization_id && !this.realtimeChannel) {
          this.subscribeToRealtimeChanges(response.organization_id);
        }

        return {
          success: true,
          modules: response,
          dependencyIssues: dependencyWarnings.length > 0 ? dependencyWarnings : undefined,
        };
      }

      return {
        success: false,
        modules: null,
        error: 'Failed to fetch modules',
      };

    } catch (error) {
      console.error('[ModuleSyncService] Force sync failed:', error);
      return {
        success: false,
        modules: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check if periodic sync is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get the current sync configuration
   */
  getConfig(): Required<ModuleSyncServiceConfig> {
    return { ...this.config };
  }

  /**
   * Notify the renderer process of events
   */
  private notifyRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // ===========================================================================
  // SUPABASE REALTIME METHODS
  // ===========================================================================

  /**
   * Subscribe to real-time module changes for an organization.
   * This provides instant updates when modules are added, removed, or modified.
   *
   * @param orgId - The organization ID to subscribe to
   */
  subscribeToRealtimeChanges(orgId: string): void {
    if (!this.supabaseClient) {
      console.warn('[ModuleSyncService] Supabase client not initialized, cannot subscribe to realtime');
      return;
    }

    // Store organization ID
    this.organizationId = orgId;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Clean up existing subscription
    this.unsubscribeFromRealtime();

    console.log(`[ModuleSyncService] Subscribing to realtime changes for org: ${orgId}`);
    this.updateRealtimeStatus('connecting');

    const channelName = `pos-org-modules-${orgId}`;
    const token = ++this.channelToken;

    const channel = this.supabaseClient
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'organization_modules',
          filter: `organization_id=eq.${orgId}`,
        },
        async (payload) => {
          console.log('[ModuleSyncService] Realtime module change detected:', payload.eventType);

          // Notify renderer of realtime change
          this.notifyRenderer('modules:realtime-change', {
            eventType: payload.eventType,
            organizationId: orgId,
            timestamp: new Date().toISOString(),
          });

          // Trigger a sync to get the updated modules
          await this.forceSync();
        }
      )
      .subscribe((status, err) => {
        if (this.realtimeChannel !== channel || token !== this.channelToken) {
          return;
        }

        const errorMessage = err?.message || '';
        console.log('[ModuleSyncService] Realtime subscription status:', status, errorMessage || '');

        switch (status) {
          case 'SUBSCRIBED':
            this.markConnectionStable();
            this.updateRealtimeStatus('connected');
            break;
          case 'CLOSED':
            this.clearStableConnectionTimer();
            this.updateRealtimeStatus('disconnected');
            this.attemptReconnect({ errorMessage });
            break;
          case 'CHANNEL_ERROR':
            // Detect rate limiting for appropriate backoff
            const isRateLimit = this.isRateLimitError(errorMessage);
            this.clearStableConnectionTimer();
            this.updateRealtimeStatus('error');
            this.attemptReconnect({ isRateLimit, errorMessage });
            break;
          case 'TIMED_OUT':
            this.clearStableConnectionTimer();
            this.updateRealtimeStatus('disconnected');
            this.attemptReconnect({ errorMessage });
            break;
        }
      });

    this.realtimeChannel = channel;
  }

  /**
   * Unsubscribe from real-time module changes
   */
  unsubscribeFromRealtime(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.clearStableConnectionTimer();

    if (this.realtimeChannel && this.supabaseClient) {
      this.supabaseClient.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }

    this.updateRealtimeStatus('disconnected');
    console.log('[ModuleSyncService] Unsubscribed from realtime');
  }

  /**
   * Check if an error message indicates rate limiting
   * Parity with: POSSystemMobile/src/services/RealtimeSubscriptionManager.ts
   */
  private isRateLimitError(message: string): boolean {
    const rateLimitPatterns = [
      'rate limit',
      'too many',
      'throttle',
      'quota exceeded',
      '429',
      'too many requests',
    ];
    const lowerMessage = message.toLowerCase();
    return rateLimitPatterns.some(pattern => lowerMessage.includes(pattern));
  }

  /**
   * Attempt to reconnect to real-time with exponential backoff
   * Enhanced with rate limit awareness (parity with mobile)
   */
  private attemptReconnect(options?: { isRateLimit?: boolean; errorMessage?: string }): void {
    if (!this.organizationId) {
      return;
    }

    if (this.reconnectTimeout) {
      return;
    }

    const isRateLimit = options?.isRateLimit ||
      (options?.errorMessage && this.isRateLimitError(options.errorMessage));

    // Allow more attempts for rate limits to eventually recover
    const maxAttempts = isRateLimit
      ? this.maxReconnectAttempts * 2
      : this.maxReconnectAttempts;

    if (this.reconnectAttempts >= maxAttempts) {
      console.warn(`[ModuleSyncService] Max reconnect attempts (${maxAttempts}) reached`, { isRateLimit });
      this.updateRealtimeStatus('error');
      return;
    }

    // Use longer delays for rate limits (10x normal)
    const baseDelay = isRateLimit
      ? this.reconnectDelayMs * 10  // 20 seconds base for rate limits
      : this.reconnectDelayMs;

    // Use longer max delay for rate limits (5 minutes)
    const maxDelay = isRateLimit ? 5 * 60 * 1000 : 60000;

    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);

    // Add jitter (±10%)
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(delay + jitter);

    console.log(`[ModuleSyncService] Attempting realtime reconnect in ${finalDelay}ms (attempt ${this.reconnectAttempts + 1}/${maxAttempts})`, { isRateLimit });

    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      if (this.organizationId) {
        this.subscribeToRealtimeChanges(this.organizationId);
      }
    }, finalDelay);
  }

  /**
   * Reset reconnect attempts only after the connection has stayed up for a while.
   */
  private markConnectionStable(): void {
    this.clearStableConnectionTimer();

    this.reconnectStableTimeout = setTimeout(() => {
      this.reconnectAttempts = 0;
      this.reconnectStableTimeout = null;
    }, this.reconnectStableMs);
  }

  private clearStableConnectionTimer(): void {
    if (this.reconnectStableTimeout) {
      clearTimeout(this.reconnectStableTimeout);
      this.reconnectStableTimeout = null;
    }
  }

  /**
   * Update the realtime connection status and notify renderer
   */
  private updateRealtimeStatus(status: RealtimeConnectionStatus): void {
    this.realtimeConnectionStatus = status;
    this.notifyRenderer('modules:realtime-status', { status });
  }

  /**
   * Get the current realtime connection status
   */
  getRealtimeConnectionStatus(): RealtimeConnectionStatus {
    return this.realtimeConnectionStatus;
  }

  /**
   * Check if realtime is connected
   */
  isRealtimeConnected(): boolean {
    return this.realtimeConnectionStatus === 'connected';
  }

  // ===========================================================================
  // OFFLINE QUEUE METHODS
  // ===========================================================================

  /**
   * Queue an action for later processing when offline
   */
  async queueOfflineAction(
    type: ModuleActionType,
    moduleId: string,
    organizationId: string
  ): Promise<void> {
    if (!this.offlineQueue) {
      console.warn('[ModuleSyncService] Offline queue not initialized');
      return;
    }

    await this.offlineQueue.queueAction({
      type,
      moduleId,
      organizationId,
    });

    console.log('[ModuleSyncService] Action queued for offline:', { type, moduleId, organizationId });
  }

  /**
   * Process queued offline actions
   */
  async processOfflineQueue(): Promise<void> {
    if (!this.offlineQueue) {
      return;
    }

    await this.offlineQueue.processQueue();
  }

  /**
   * Get the current offline queue
   */
  getOfflineQueue(): ModuleAction[] {
    return this.offlineQueue?.getQueue() ?? [];
  }

  /**
   * Check if the device is currently online
   */
  getOnlineStatus(): boolean {
    return this.offlineQueue?.getOnlineStatus() ?? this.isOnline;
  }

  /**
   * Check if there are queued actions for a specific module
   */
  hasQueuedActionForModule(organizationId: string, moduleId: string): boolean {
    return this.offlineQueue?.hasQueuedActionForModule(organizationId, moduleId) ?? false;
  }

  // ===========================================================================
  // CLEANUP
  // ===========================================================================

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopPeriodicSync();
    this.unsubscribeFromRealtime();

    // Dispose offline queue
    if (this.offlineQueue) {
      this.offlineQueue.dispose();
      this.offlineQueue = null;
    }

    this.mainWindow = null;
    this.databaseManager = null;
    this.supabaseClient = null;
  }
}
