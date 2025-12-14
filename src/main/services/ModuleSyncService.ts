/**
 * ModuleSyncService - Handles fetching and syncing modules from admin dashboard
 * 
 * This service is responsible for:
 * - Fetching enabled modules from the admin dashboard API
 * - Handling HTTP errors gracefully with fallback to cache
 * - Periodic sync to keep modules up-to-date
 * - Manual force sync capability
 * 
 * Requirements: 1.1, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4
 */

import { BrowserWindow } from 'electron';
import { DatabaseManager } from '../database';
import type { POSModulesEnabledResponse } from '../../shared/types/modules';

export interface ModuleSyncServiceConfig {
  adminDashboardUrl: string;
  syncIntervalMs?: number; // Default: 2 minutes (120000ms)
  fetchTimeoutMs?: number; // Default: 30 seconds (30000ms)
}

export interface ModuleSyncResult {
  success: boolean;
  modules: POSModulesEnabledResponse | null;
  error?: string;
  fromCache?: boolean;
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

  constructor(config: ModuleSyncServiceConfig) {
    this.config = {
      adminDashboardUrl: config.adminDashboardUrl.replace(/\/$/, ''),
      syncIntervalMs: config.syncIntervalMs ?? 120000, // 2 minutes
      fetchTimeoutMs: config.fetchTimeoutMs ?? 30000, // 30 seconds
    };
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
        return {
          success: true,
          modules: response,
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

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopPeriodicSync();
    this.mainWindow = null;
    this.databaseManager = null;
  }
}
