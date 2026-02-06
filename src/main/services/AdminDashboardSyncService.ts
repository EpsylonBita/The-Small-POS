/**
 * AdminDashboardSyncService - Sync with admin dashboard API
 *
 * Migrated from admin-dashboard-sync-service.ts to services directory for consistent organization.
 */

import { DatabaseManager } from '../database';
import { BrowserWindow } from 'electron';
import os from 'os';
import { serviceRegistry } from '../service-registry';


export interface AdminDashboardSyncStatus {
  isOnline: boolean;
  lastSync: string | null;
  pendingItems: number;
  syncInProgress: boolean;
  error: string | null;
  terminalHealth: number;
  settingsVersion: number;
  menuVersion: number;
}

export interface TerminalHeartbeat {
  terminal_id: string;
  status: 'online' | 'offline' | 'maintenance';
  health_score: number;
  cpu_usage: number;
  memory_usage: number;
  queue_length: number;
  last_order_time: string | null;
  version: string;
  name?: string;
  location: string;
  network_latency: number;
  organization_id?: string;
  terminal_type?: 'main' | 'mobile_waiter';
  parent_terminal_id?: string;
  sync_stats?: {
    driver_earnings: { pending: number; failed: number };
    staff_payments: { pending: number; failed: number };
    shift_expenses: { pending: number; failed: number };
  };
}

interface PendingSyncOperation {
  id?: string;
  table_name?: string;
  operation?: string;
  sync_status?: string;
  [key: string]: unknown;
}

export class AdminDashboardSyncService {
  private dbManager: DatabaseManager;
  private mainWindow: BrowserWindow | null = null;
  private terminalId: string;
  private adminDashboardUrl: string;
  private isOnline: boolean = false;
  private lastSync: string | null = null;
  private syncInProgress: boolean = false;
  private syncInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pendingItems: number = 0;
  private error: string | null = null;
  private terminalHealth: number = 0;
  private settingsVersion: number = 0;
  private menuVersion: number = 0;
  private cpuSample = process.cpuUsage();
  private cpuSampleTimestamp = Date.now();
  private lastCpuUsage: number = 0;
  private lastMemoryUsage: number = 0;

  constructor(dbManager: DatabaseManager, terminalId?: string, adminDashboardUrl?: string) {
    this.dbManager = dbManager;
    this.terminalId = terminalId || process.env.TERMINAL_ID || 'terminal-001';

    // Try to load admin dashboard URL from local settings first
    const storedUrl = this.loadStoredAdminUrl();
    this.adminDashboardUrl = storedUrl || adminDashboardUrl || process.env.ADMIN_DASHBOARD_URL || 'http://localhost:3001';

    console.log(`[AdminDashboardSyncService] Using admin dashboard URL: ${this.adminDashboardUrl}`);
    this.setupNetworkMonitoring();
    this.startHeartbeat();
  }

  /**
   * Load admin dashboard URL from local settings
   */
  private loadStoredAdminUrl(): string | null {
    try {
      const dbSvc = this.dbManager?.getDatabaseService?.();
      if (dbSvc?.settings) {
        const url = dbSvc.settings.getSetting('terminal', 'admin_dashboard_url', null) as string | null;
        if (url) {
          console.log(`[AdminDashboardSyncService] Loaded stored admin URL: ${url}`);
          return url;
        }
      }
    } catch (e) {
      console.warn('[AdminDashboardSyncService] Failed to load stored admin URL:', e);
    }
    return null;
  }

  /**
   * Update the admin dashboard URL dynamically
   */
  setAdminDashboardUrl(url: string): void {
    console.log(`[AdminDashboardSyncService] Setting admin dashboard URL: ${url}`);
    this.adminDashboardUrl = url;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Update terminal ID and API key when connection settings change
   * This ensures the sync service uses the latest credentials
   * Performs a factory reset to clear old branch data
   */
  async updateTerminalCredentials(terminalId: string, apiKey: string, adminDashboardUrl?: string): Promise<void> {
    console.log(`[AdminDashboardSyncService] Updating terminal credentials: ${terminalId}`);

    // Store the admin URL before factory reset (if provided)
    const urlToStore = adminDashboardUrl || this.adminDashboardUrl;
    console.log(`[AdminDashboardSyncService] Admin URL to preserve: ${urlToStore}`);

    // 1. Perform factory reset FIRST to clear everything (including old ID)
    try {
      console.log('[AdminDashboardSyncService] Performing factory reset to clear old branch data...');
      const dbSvc = this.dbManager?.getDatabaseService?.();
      if (dbSvc) {
        await dbSvc.factoryReset();
      }
    } catch (resetError) {
      console.warn('[AdminDashboardSyncService] Factory reset warning:', resetError);
      // Continue even if reset fails
    }

    // 2. Set new credentials in memory
    this.terminalId = terminalId;
    this.lastSync = null;

    // Update admin URL in memory if provided
    if (adminDashboardUrl) {
      this.adminDashboardUrl = adminDashboardUrl;
    }
    // Ensure ModuleSyncService uses the latest admin URL
    const moduleSyncService = serviceRegistry.moduleSyncService;
    if (moduleSyncService && adminDashboardUrl) {
      moduleSyncService.setAdminDashboardUrl(adminDashboardUrl);
    }

    // 3. Persist new credentials to the fresh database (AFTER factory reset)
    try {
      const dbSvc = this.dbManager?.getDatabaseService?.();
      if (dbSvc?.settings) {
        dbSvc.settings.setSetting('terminal', 'terminal_id', terminalId);
        dbSvc.settings.setSetting('terminal', 'pos_api_key', apiKey);
        // IMPORTANT: Save admin_dashboard_url AFTER factory reset
        if (urlToStore) {
          dbSvc.settings.setSetting('terminal', 'admin_dashboard_url', urlToStore);
          console.log(`[AdminDashboardSyncService] Admin URL persisted: ${urlToStore}`);
        }
        console.log('[AdminDashboardSyncService] New credentials persisted to local settings');
      }
    } catch (persistError) {
      console.error('[AdminDashboardSyncService] Failed to persist new credentials:', persistError);
    }

    // 3.1. Notify renderer to refresh its in-memory terminal credential cache immediately
    // This avoids waiting for the next settings refresh cycle before authenticated API calls
    this.notifyRenderer('terminal-credentials-updated', { terminalId, apiKey, adminDashboardUrl: urlToStore });

    // 4. Test connection with new credentials
    await this.testConnection();

    // 5. If online, trigger immediate sync
    if (this.isOnline) {
      console.log('[AdminDashboardSyncService] Connection successful, triggering full sync with new credentials');
      await this.startSync();
    }
  }

  private async setupNetworkMonitoring(): Promise<void> {
    // Test connection to admin dashboard
    await this.testConnection();

    // Start auto-sync if online
    if (this.isOnline) {
      this.startAutoSync();
    }
  }

  private async testConnection(): Promise<void> {
    try {
      const base = this.adminDashboardUrl.replace(/\/$/, '');
      // Health check doesn't require authentication - use basic headers only
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': this.terminalId
      };

      const healthCandidates = [
        `${base}/api/health`,
        `${base}/health`,
        `${base}/api/status`,
        `${base}/healthz`
      ];

      let ok = false;
      let lastErr: any = null;
      for (const url of healthCandidates) {
        try {
          const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(5000) });
          if (response.ok) { ok = true; break; }
          lastErr = new Error(`HTTP ${response.status} @ ${url}`);
        } catch (e) { lastErr = e; }
      }

      if (ok) {
        this.isOnline = true;
        this.error = null;
        console.log('✅ Connected to admin dashboard');
      } else {
        throw lastErr || new Error('Health check failed');
      }
    } catch (error) {
      this.isOnline = false;
      this.error = error instanceof Error ? error.message : 'Connection failed';
      console.error('❌ Failed to connect to admin dashboard:', this.error);
    }

    this.notifyRenderer('sync:status', await this.getSyncStatus());
  }

  private async resolveTerminalName(): Promise<string> {
    try {
      const envName = process.env.TERMINAL_NAME;
      if (envName && envName.trim()) return envName.trim();
      if (this.dbManager?.getLocalSettings) {
        const all = await this.dbManager.getLocalSettings();
        const entry = Array.isArray(all)
          ? all.find((s: any) => s.setting_category === 'terminal' && s.setting_key === 'name')
          : null;
        if (entry && entry.setting_value) {
          try {
            const parsed = JSON.parse(entry.setting_value);
            if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
          } catch {
            if (typeof entry.setting_value === 'string' && entry.setting_value.trim()) return entry.setting_value.trim();
          }
        }
      }
    } catch { }
    const suffix = this.terminalId?.split('-')[1] || '001';
    return `POS Terminal ${suffix}`;
  }

  private resolveTerminalLocation(): string {
    const envLoc = process.env.TERMINAL_LOCATION;
    if (envLoc && envLoc.trim()) return envLoc.trim();
    try { return os.hostname() || 'Unknown Location'; } catch { return 'Unknown Location'; }
  }


  private async sendHeartbeat(): Promise<void> {
    if (!this.isOnline) return;

    try {
      const dbSvc = this.dbManager?.getDatabaseService?.();
      const storedTid = (await (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', this.terminalId))) || this.terminalId;

      // Resolve organization_id from local settings
      const organizationId = (await (dbSvc?.settings?.getSetting?.('terminal', 'organization_id', null))) as string | null;

      // Resolve terminal type and parent terminal ID for mobile waiter support
      const terminalType = dbSvc?.settings?.getTerminalType?.() as 'main' | 'mobile_waiter' | null;
      const parentTerminalId = dbSvc?.settings?.getParentTerminalId?.() as string | null;

      // Get financial sync stats
      let financialStats;
      try {
        if (this.dbManager) {
          financialStats = this.dbManager.getDatabaseService().sync.getFinancialSyncStats();
        }
      } catch (e) {
        console.warn('Failed to get financial sync stats for heartbeat', e);
      }

      // Keep queue and health metrics current for heartbeat payload.
      this.pendingItems = await this.getPendingItemsCount();
      const cpuUsage = this.getCpuUsage();
      const memoryUsage = this.getMemoryUsage();
      const healthScore = this.calculateHealthScore(cpuUsage, memoryUsage, this.pendingItems);

      const heartbeatData: TerminalHeartbeat = {
        terminal_id: storedTid,
        status: 'online',
        health_score: healthScore,
        cpu_usage: cpuUsage,
        memory_usage: memoryUsage,
        queue_length: this.pendingItems,
        last_order_time: await this.getLastOrderTime(),
        version: '1.0.0',
        name: await this.resolveTerminalName(),
        location: this.resolveTerminalLocation(),
        network_latency: await this.measureLatency(),
        organization_id: organizationId || undefined,
        terminal_type: terminalType || undefined,
        parent_terminal_id: parentTerminalId || undefined,
        sync_stats: financialStats
      };

      const base = this.adminDashboardUrl.replace(/\/$/, '');
      const token = process.env.ADMIN_API_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN;

      // IMPORTANT: Only use per-terminal API key from settings
      // Each terminal has its own unique API key for security
      const apiKey = ((await (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', ''))) || '').toString();

      // Skip heartbeat if no API key is configured (terminal not yet configured)
      if (!apiKey) {
        console.log('[Heartbeat] No API key configured, skipping heartbeat (terminal needs onboarding)');
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': storedTid as string
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (apiKey) headers['x-pos-api-key'] = apiKey;

      const response = await fetch(`${base}/api/pos/terminal-heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(heartbeatData),
        signal: AbortSignal.timeout(20000) // 20 second timeout (increased from 10s for slower networks)
      });

      if (!response.ok) {
        // Log the error but don't trigger factory reset for connection/auth issues
        // Factory reset should ONLY happen via explicit command from admin dashboard
        let responseBody: any = null;
        try {
          const bodyText = await response.text();
          console.warn(`[Heartbeat] Server returned HTTP ${response.status}${bodyText ? ` - ${bodyText}` : ''}`);
          responseBody = JSON.parse(bodyText);
        } catch {
          console.warn(`[Heartbeat] Server returned HTTP ${response.status} (could not parse body)`);
        }

        // Even on 401, check if server sent factory_reset command (for deleted terminals)
        if (responseBody?.pending_commands && Array.isArray(responseBody.pending_commands)) {
          for (const cmd of responseBody.pending_commands) {
            const command = cmd.command?.toLowerCase() || '';
            const metadata = cmd.metadata || {};
            const isFactoryReset =
              command === 'factory_reset' ||
              command === 'wipe' ||
              command === 'reset' ||
              (command === 'disable' && metadata.action === 'factory_reset');

            if (isFactoryReset) {
              console.warn('[Heartbeat] Received FACTORY RESET command for deleted terminal', { command, metadata });
              try {
                const dbSvc = this.dbManager?.getDatabaseService?.();
                if (dbSvc) {
                  await dbSvc.factoryReset();
                  this.notifyRenderer('app:reset', { reason: 'terminal_deleted', commandId: cmd.id });
                }
              } catch (resetError) {
                console.error('[Heartbeat] Factory reset failed:', resetError);
              }
              return;
            }
          }
        }

        // For 401/404, just log and continue - terminal may be temporarily unreachable
        // or credentials may need to be re-entered via settings
        if (response.status === 401 || response.status === 404) {
          console.warn('[Heartbeat] Terminal authentication failed or not found. Check terminal configuration.');
          // Don't throw - allow offline operation
          return;
        }

        throw new Error(`Heartbeat failed: HTTP ${response.status}`);
      }

      const result = await response.json();
      console.log('💓 Heartbeat sent successfully');

      // Check for explicit reset/wipe command in pending_commands from admin dashboard
      // This is the ONLY way factory reset should be triggered - via explicit admin command
      if (result.pending_commands && Array.isArray(result.pending_commands)) {
        for (const cmd of result.pending_commands) {
          const command = cmd.command?.toLowerCase() || '';
          const metadata = cmd.metadata || {};

          // Check for factory_reset command OR disable command with factory_reset metadata
          const isFactoryReset =
            command === 'factory_reset' ||
            command === 'wipe' ||
            command === 'reset' ||
            (command === 'disable' && metadata.action === 'factory_reset');

          if (isFactoryReset) {
            console.warn('[Heartbeat] Received explicit FACTORY RESET command from admin dashboard', {
              command,
              metadata,
              commandId: cmd.id
            });
            try {
              const dbSvc = this.dbManager?.getDatabaseService?.();
              if (dbSvc) {
                await dbSvc.factoryReset();
                this.notifyRenderer('app:reset', { reason: 'admin_command', commandId: cmd.id });
              }
            } catch (resetError) {
              console.error('[Heartbeat] Factory reset command failed:', resetError);
            }
            return;
          }
        }
      }

      // Legacy check for direct command in response (backward compatibility)
      if (result.command === 'reset' || result.action === 'reset') {
        console.warn('[Heartbeat] Received explicit RESET command from server (legacy format)');
        try {
          const dbSvc = this.dbManager?.getDatabaseService?.();
          if (dbSvc) {
            await dbSvc.factoryReset();
            this.notifyRenderer('app:reset', { reason: 'remote_command' });
          }
        } catch (resetError) {
          console.error('[Heartbeat] Remote reset command failed:', resetError);
        }
        return;
      }

      // Store terminal config (branch_id and organization_id) from heartbeat response
      // This ensures POS always has the correct branch/org association from the server
      if (result.terminal) {
        const dbSvcForTerminal = this.dbManager?.getDatabaseService?.();
        if (dbSvcForTerminal?.settings) {
          if (result.terminal.branch_id) {
            dbSvcForTerminal.settings.setSetting('terminal', 'branch_id', result.terminal.branch_id);
            console.log('[Heartbeat] Stored branch_id from server:', result.terminal.branch_id);
          }
          if (result.terminal.organization_id) {
            dbSvcForTerminal.settings.setSetting('terminal', 'organization_id', result.terminal.organization_id);
            console.log('[Heartbeat] Stored organization_id from server:', result.terminal.organization_id);
          }

          // Notify renderer about terminal config update so it can reload settings
          if (result.terminal.branch_id || result.terminal.organization_id) {
            this.notifyRenderer('terminal-config-updated', {
              branch_id: result.terminal.branch_id,
              organization_id: result.terminal.organization_id
            });
          }
        }
      }

      // Process any pending sync operations from the response
      if (result.pending_sync_operations && result.pending_sync_operations.length > 0) {
        console.log(`📥 Received ${result.pending_sync_operations.length} pending sync operations`);
        await this.handlePendingSyncOperations(result.pending_sync_operations as PendingSyncOperation[]);
      }

    } catch (error) {
      console.error('❌ Heartbeat failed:', error);
      this.error = error instanceof Error ? error.message : 'Heartbeat failed';
    }
  }

  private startHeartbeat(): void {
    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 30000);

    // Send initial heartbeat
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async startSync(): Promise<void> {
    if (this.syncInProgress || !this.isOnline) {
      return;
    }

    this.syncInProgress = true;
    this.error = null;
    this.notifyRenderer('sync:status', await this.getSyncStatus());

    try {
      console.log('🔄 Starting sync with admin dashboard...');

      // IMPORTANT: Send heartbeat FIRST to ensure terminal exists in database with api_key_hash
      // This is required before any other API calls that need terminal authentication
      // The heartbeat creates/updates the terminal record with the API key hash
      console.log('💓 Sending initial heartbeat to register terminal...');
      await this.sendHeartbeat();

      // Small delay to ensure database write completes
      await new Promise(resolve => setTimeout(resolve, 500));

      // Sync menu data (now terminal exists with api_key_hash)
      await this.syncMenuData();

      // Small delay between sync calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Sync settings
      await this.syncSettings();

      // Note: Orders are synced via SupabaseSyncService, not via admin dashboard API

      this.lastSync = new Date().toISOString();
      console.log('✅ Sync completed successfully');
      this.notifyRenderer('sync:complete', { timestamp: this.lastSync });

      // Coordinate module sync after settings sync (Requirement 3.1, 3.2)
      // This ensures modules are refreshed when admin dashboard sync completes
      this.triggerModuleSync();

    } catch (error) {
      console.error('❌ Sync failed:', error);
      this.error = error instanceof Error ? error.message : 'Sync failed';
      this.notifyRenderer('sync:error', { error: this.error });
    } finally {
      this.syncInProgress = false;
      this.notifyRenderer('sync:status', await this.getSyncStatus());
    }
  }

  /**
   * Trigger module sync via ModuleSyncService
   * Coordinates periodic sync timing between AdminDashboardSyncService and ModuleSyncService
   *
   * Requirements: 3.1, 3.2
   */
  private triggerModuleSync(): void {
    try {
      const moduleSyncService = serviceRegistry.moduleSyncService;
      if (moduleSyncService) {
        // Use forceSync to trigger immediate module refresh
        // This coordinates with the periodic sync to avoid redundant API calls
        moduleSyncService.forceSync().catch((err) => {
          console.warn('[AdminDashboardSyncService] Module sync failed:', err);
        });
        console.log('[AdminDashboardSyncService] Triggered module sync after settings sync');
      }
    } catch (error) {
      console.warn('[AdminDashboardSyncService] Failed to trigger module sync:', error);
    }
  }

  private async handlePendingSyncOperations(operations: PendingSyncOperation[]): Promise<void> {
    if (!Array.isArray(operations) || operations.length === 0) return;

    // Surface pending operations to renderer for diagnostics/UI visibility.
    this.notifyRenderer('sync:pending-operations', {
      count: operations.length,
      operations
    });

    // menu_sync_queue items represent menu state changes; trigger an immediate menu refresh.
    const menuTables = new Set([
      'menu_categories',
      'subcategories',
      'ingredients',
      'branch_menu_overrides',
      'branch_overrides'
    ]);
    const hasMenuOperations = operations.some((op) =>
      menuTables.has(String(op.table_name || '').toLowerCase())
    );

    if (!hasMenuOperations || this.syncInProgress) return;

    try {
      await this.syncMenuData();
      this.notifyRenderer('sync:menu-refresh', {
        source: 'heartbeat_pending_sync_operations',
        count: operations.length
      });
    } catch (error) {
      console.warn('[AdminDashboardSyncService] Failed to process pending menu sync operations', error);
    }
  }

  private async syncMenuData(): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        const base = this.adminDashboardUrl.replace(/\/$/, '');
        const token = process.env.ADMIN_API_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN;
        const dbSvc = this.dbManager?.getDatabaseService?.();
        const storedTid = (await (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', this.terminalId))) || this.terminalId;
        // IMPORTANT: Only use per-terminal API key from settings
        // Each terminal has its own unique API key for security
        const apiKey = ((await (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', ''))) || '').toString();
        const localOrgId = (await (dbSvc?.settings?.getSetting?.('terminal', 'organization_id', null))) as string | null;

        // Skip menu sync if no API key is configured (terminal not yet configured)
        if (!apiKey) {
          console.log('[Menu Sync] No API key configured, skipping menu sync (terminal needs onboarding)');
          return;
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-terminal-id': storedTid as string
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (apiKey) headers['x-pos-api-key'] = apiKey;

        const response = await fetch(`${base}/api/pos/menu-sync?terminal_id=${encodeURIComponent(storedTid as string)}&last_sync=${this.lastSync || ''}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000) // 30 second timeout
        });

        // Handle rate limiting with exponential backoff
        if (response.status === 429) {
          retryCount++;
          if (retryCount < maxRetries) {
            const backoffMs = Math.min(5000 * Math.pow(2, retryCount), 30000); // 10s, 20s, max 30s
            console.warn(`⏳ Rate limited (429), retrying in ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          throw new Error(`Menu sync failed: HTTP 429 (rate limited after ${maxRetries} retries)`);
        }

        if (!response.ok) {
          throw new Error(`Menu sync failed: HTTP ${response.status}`);
        }

        const menuData = await response.json();

        const remoteOrgId = (menuData as any).organization_id as string | undefined;
        if (remoteOrgId) {
          if (localOrgId && localOrgId !== remoteOrgId) {
            console.warn('⚠️ Organization ID mismatch between local settings and menu sync response', {
              localOrgId,
              remoteOrgId
            });
          }

          try {
            if (dbSvc?.settings) {
              await dbSvc.settings.setSetting('terminal', 'organization_id', remoteOrgId);
            }
          } catch (orgError) {
            console.warn('Failed to persist organization_id from menu sync', orgError);
          }
        }

        if (menuData.success && menuData.menu_data) {
          // Update local database with menu data
          console.log(`📋 Received menu updates: ${menuData.sync_stats?.categories_updated ?? 0} categories, ${menuData.sync_stats?.subcategories_updated ?? 0} items`);

          const dbSvc = this.dbManager.getDatabaseService();
          if (dbSvc && menuData.menu_data) {
            // Cache updated subcategories
            const subcategories = menuData.menu_data.subcategories || [];
            if (Array.isArray(subcategories) && subcategories.length > 0) {
              const cacheItems = subcategories.map((item: any) => ({
                id: item.id,
                name: item.name,
                name_en: item.name_en,
                name_el: item.name_el,
                category_id: item.category_id || item.categoryId
              }));
              dbSvc.bulkCacheSubcategories(cacheItems);
              console.log(`[AdminDashboardSyncService] Persisted ${cacheItems.length} subcategories to cache`);
            } else {
              console.warn('[AdminDashboardSyncService] No subcategories found in menu update', Object.keys(menuData.menu_data));
            }

            // Process deleted/deactivated items for cache eviction
            if (menuData.deleted_items) {
              const { category_ids, subcategory_ids, ingredient_ids } = menuData.deleted_items as {
                category_ids?: string[];
                subcategory_ids?: string[];
                ingredient_ids?: string[];
              };

              if (Array.isArray(subcategory_ids) && subcategory_ids.length > 0) {
                const evicted = dbSvc.deleteSubcategoriesFromCache(subcategory_ids);
                console.log(`[AdminDashboardSyncService] Evicted ${evicted} deactivated subcategories from cache`);
              }

              // Log category/ingredient eviction counts for debugging
              if (Array.isArray(category_ids) && category_ids.length > 0) {
                console.log(`[AdminDashboardSyncService] ${category_ids.length} categories marked for eviction (client-side)`);
              }
              if (Array.isArray(ingredient_ids) && ingredient_ids.length > 0) {
                console.log(`[AdminDashboardSyncService] ${ingredient_ids.length} ingredients marked for eviction (client-side)`);
              }

              // Notify renderer to clear these items from UI state
              this.notifyRenderer('menu:items-deleted', {
                category_ids: category_ids || [],
                subcategory_ids: subcategory_ids || [],
                ingredient_ids: ingredient_ids || [],
              });
            }

            // Process branch-specific overrides
            if (menuData.menu_data.branch_overrides && Array.isArray(menuData.menu_data.branch_overrides)) {
              const overrides = menuData.menu_data.branch_overrides as Array<{
                subcategory_id: string;
                price_override?: number | null;
                availability_override?: boolean | null;
                updated_at: string;
              }>;
              if (overrides.length > 0) {
                const applied = dbSvc.applyBranchOverrides(overrides);
                console.log(`[AdminDashboardSyncService] Applied ${applied} branch overrides`);

                // Notify renderer about price/availability changes
                this.notifyRenderer('menu:branch-overrides', { overrides });
              }
            }
          }
          this.menuVersion++;
        }

        // Success - break out of retry loop
        return;

      } catch (error) {
        // If it's a rate limit error and we have retries left, the while loop will continue
        if (retryCount >= maxRetries - 1 || !(error instanceof Error && error.message.includes('429'))) {
          console.error('❌ Menu sync failed:', error);
          throw error;
        }
        // Otherwise, increment and let the while loop retry
        retryCount++;
        const backoffMs = Math.min(5000 * Math.pow(2, retryCount), 30000);
        console.warn(`⏳ Menu sync error, retrying in ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async syncSettings(): Promise<void> {
    try {
      if (!this.isOnline) {
        await this.testConnection();
        if (!this.isOnline) throw new Error('Admin dashboard offline');
      }

      const urlBase = this.adminDashboardUrl.replace(/\/$/, '');

      // Use the correct settings endpoint: /api/pos/settings/{terminal_id}
      const dbSvc = this.dbManager?.getDatabaseService?.();
      const storedTid = (await (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', this.terminalId))) || this.terminalId;
      const endpoint = `${urlBase}/api/pos/settings/${encodeURIComponent(storedTid as string)}`;

      const token = process.env.ADMIN_API_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN;

      // IMPORTANT: Only use per-terminal API key from settings
      const apiKey = ((await (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', ''))) || '').toString();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': storedTid as string
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (apiKey) headers['x-pos-api-key'] = apiKey;

      // Fetch settings using GET request to the correct endpoint with retry for rate limiting
      let res: Response | null = null;
      let settingsRetryCount = 0;
      const maxSettingsRetries = 3;

      while (settingsRetryCount < maxSettingsRetries) {
        res = await fetch(endpoint, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000)
        });

        // Handle rate limiting with exponential backoff
        if (res.status === 429) {
          settingsRetryCount++;
          if (settingsRetryCount < maxSettingsRetries) {
            const backoffMs = Math.min(5000 * Math.pow(2, settingsRetryCount), 30000);
            console.warn(`⏳ Settings sync rate limited (429), retrying in ${backoffMs / 1000}s... (attempt ${settingsRetryCount}/${maxSettingsRetries})`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
        }
        break;
      }

      if (!res || !res.ok) {
        throw new Error(`Failed to fetch settings: HTTP ${res?.status ?? 'unknown'} from ${endpoint}`);
      }

      const settingsPayload = await res.json();

      // Normalize possible payload shapes
      const normalize = (payload: any) => {
        if (!payload) return {} as any;
        // Common shape: { success, settings: { restaurant, terminal, payment, versions? } }
        if (payload.settings) return payload.settings;
        // Sometimes directly categories
        const candidateKeys = ['restaurant', 'terminal', 'payment', 'pos', 'hardware', 'printer', 'tax', 'discount', 'receipt', 'inventory', 'staff'];
        const anyKey = candidateKeys.some(k => k in payload);
        if (anyKey) return payload;
        return payload; // fallback
      };

      const settingsData = normalize(settingsPayload);

      // Store branch_id if returned from API
      if (settingsPayload.branch_id) {
        const dbSvcForBranch = this.dbManager?.getDatabaseService?.();
        if (dbSvcForBranch?.settings) {
          dbSvcForBranch.settings.setSetting('terminal', 'branch_id', settingsPayload.branch_id);
          console.log('[Settings Sync] Stored branch_id:', settingsPayload.branch_id);
        }
      }

      // Extract and store terminal type, parent terminal ID, and enabled features
      // These are used for mobile waiter terminal support
      const terminalConfig: {
        terminal_type?: 'main' | 'mobile_waiter';
        parent_terminal_id?: string | null;
        enabled_features?: Record<string, boolean>;
      } = {};

      // Check for terminal configuration in response
      if (settingsPayload.terminal_type === 'main' || settingsPayload.terminal_type === 'mobile_waiter') {
        terminalConfig.terminal_type = settingsPayload.terminal_type;
      }
      if (settingsPayload.parent_terminal_id !== undefined) {
        terminalConfig.parent_terminal_id = settingsPayload.parent_terminal_id;
      }
      if (settingsPayload.enabled_features) {
        terminalConfig.enabled_features = settingsPayload.enabled_features;
      }

      // Also check inside terminal settings object
      const terminalSettingsObj = settingsData.terminal || settingsData.pos || {};
      if (terminalSettingsObj.terminal_type === 'main' || terminalSettingsObj.terminal_type === 'mobile_waiter') {
        terminalConfig.terminal_type = terminalSettingsObj.terminal_type;
      }
      if (terminalSettingsObj.parent_terminal_id !== undefined) {
        terminalConfig.parent_terminal_id = terminalSettingsObj.parent_terminal_id;
      }
      if (terminalSettingsObj.enabled_features) {
        terminalConfig.enabled_features = terminalSettingsObj.enabled_features;
      }

      // If terminal configuration was found, store it and notify renderer
      if (terminalConfig.terminal_type || terminalConfig.enabled_features) {
        const dbSvcForTerminal = this.dbManager?.getDatabaseService?.();
        if (dbSvcForTerminal?.settings) {
          dbSvcForTerminal.settings.updateTerminalConfig(terminalConfig);
          console.log('[Settings Sync] Stored terminal config:', terminalConfig);
        }

        // Notify FeatureService to refresh and notify renderer
        this.notifyRenderer('terminal-config-updated', {
          terminal_type: terminalConfig.terminal_type,
          parent_terminal_id: terminalConfig.parent_terminal_id,
          enabled_features: terminalConfig.enabled_features,
        });

        // Refresh FeatureService if available
        const featureService = serviceRegistry.featureService;
        if (featureService) {
          // Reload from persisted settings to keep a single source of truth
          featureService.refresh();
        }
      }

      // Apply restaurant settings
      if (settingsData.restaurant && typeof settingsData.restaurant === 'object') {
        await this.dbManager.updateRestaurantLocalConfig(settingsData.restaurant);
        this.notifyRenderer('settings:update', { type: 'restaurant', settings: settingsData.restaurant });
        this.notifyRenderer('settings:update:restaurant', { settings: settingsData.restaurant });

      }

      // Apply terminal/POS settings
      const terminalSettings = settingsData.terminal || settingsData.pos;
      if (terminalSettings && typeof terminalSettings === 'object') {
        this.notifyRenderer('settings:update:terminal', { settings: terminalSettings });

        await this.dbManager.updatePOSLocalConfig(terminalSettings);
        this.notifyRenderer('settings:update', { type: 'terminal', settings: terminalSettings });
      }

      this.notifyRenderer('settings:update:payment', { settings: settingsData.payment });

      // Apply payment settings
      if (settingsData.payment) {
        await this.dbManager.updatePaymentLocalConfig(settingsData.payment);
        this.notifyRenderer('settings:update', { type: 'payment', settings: settingsData.payment });
      }

      // Optional category blocks
      const categoryBlocks: Record<string, any> = {
        tax: settingsData.tax,
        discount: settingsData.discount,
        receipt: settingsData.receipt,
        inventory: settingsData.inventory,
        staff: settingsData.staff,
        printer: settingsData.printer,
        hardware: settingsData.hardware,
      };

      for (const [category, block] of Object.entries(categoryBlocks)) {
        if (block && typeof block === 'object') {
          // Reuse POS local config for terminal-scoped settings
          await this.dbManager.updatePOSLocalConfig(block);
          this.notifyRenderer('settings:update', { type: category, settings: block });
          this.notifyRenderer(`settings:update:${category}`, { settings: block });
        }
      }

      // Bump local versions heuristically if provided
      const versions = settingsData.versions || settingsPayload.versions || null;
      if (versions && typeof versions === 'object') {
        // No-op here; local versioning is handled by db updates elsewhere.
      }

      this.settingsVersion++;
      this.lastSync = new Date().toISOString();
      this.notifyRenderer('sync:status', await this.getSyncStatus());

      // Emit module refresh event after settings sync (Requirement 3.3)
      // This triggers ModuleContext to refresh modules when settings change
      this.notifyRenderer('modules:refresh-needed', {
        reason: 'settings_sync',
        timestamp: this.lastSync,
      });

      console.log('✅ Settings synced from Admin API');
    } catch (error) {
      console.error('❌ Settings sync failed:', error);
      this.error = error instanceof Error ? error.message : 'Settings sync failed';
      this.notifyRenderer('sync:error', { error: this.error });
      throw error;
    }
  }

  // Push POS settings upstream to Admin (per-terminal auth)
  async pushSettingsToAdmin(category: string, settings: Record<string, any>, incrementVersion: boolean = true): Promise<{ success: boolean; error?: string }> {
    try {
      const base = this.adminDashboardUrl.replace(/\/$/, '')
      const dbSvc = this.dbManager?.getDatabaseService?.()
      const storedTid = (await (dbSvc?.settings?.getSetting?.('terminal', 'terminal_id', this.terminalId))) || this.terminalId
      const apiKey = ((await (dbSvc?.settings?.getSetting?.('terminal', 'pos_api_key', ''))) || '').toString()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-terminal-id': storedTid as string
      }
      if (apiKey) headers['x-pos-api-key'] = apiKey

      // Flatten into array of updates for the API
      const settingsArray = Object.entries(settings || {}).map(([key, value]) => ({ category, key, value }))

      const res = await fetch(`${base}/api/pos/settings/${encodeURIComponent(storedTid as string)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ settings: settingsArray, increment_version: incrementVersion }),
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) {
        let err: any = null
        try { err = await res.json() } catch { }
        throw new Error(err?.error || `HTTP ${res.status}`)
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }




  async forceSync(): Promise<void> {
    await this.testConnection();
    if (this.isOnline) {
      // Reset lastSync to force full data refresh
      this.lastSync = null;
      await this.startSync();
    } else {
      throw new Error('Cannot sync while offline');
    }
  }

  async getSyncStatus(): Promise<AdminDashboardSyncStatus> {
    this.pendingItems = await this.getPendingItemsCount();
    const cpuUsage = this.getCpuUsage();
    const memoryUsage = this.getMemoryUsage();
    this.terminalHealth = this.calculateHealthScore(cpuUsage, memoryUsage, this.pendingItems);

    return {
      isOnline: this.isOnline,
      lastSync: this.lastSync,
      pendingItems: this.pendingItems,
      syncInProgress: this.syncInProgress,
      error: this.error,
      terminalHealth: this.terminalHealth,
      settingsVersion: this.settingsVersion,
      menuVersion: this.menuVersion
    };
  }

  getNetworkStatus(): boolean {
    return this.isOnline;
  }

  startAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    // Auto-sync every 2 minutes when online
    this.syncInterval = setInterval(() => {
      if (this.isOnline && !this.syncInProgress) {
        this.startSync();
      }
    }, 120000);
  }

  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  cleanup(): void {
    this.stopAutoSync();
    this.stopHeartbeat();
  }

  private notifyRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // Helper methods
  private async getPendingItemsCount(): Promise<number> {
    try {
      const dbSvc = this.dbManager?.getDatabaseService?.();
      if (!dbSvc?.sync) return 0;

      const stats = dbSvc.sync.getSyncStats();
      const pending = Number(stats?.pending ?? 0);
      return Number.isFinite(pending) && pending > 0 ? pending : 0;
    } catch (error) {
      console.warn('[AdminDashboardSyncService] Failed to read pending sync queue count', error);
      return 0;
    }
  }

  private calculateHealthScore(cpuUsage: number = this.lastCpuUsage, memoryUsage: number = this.lastMemoryUsage, pendingItems: number = this.pendingItems): number {
    if (!this.isOnline) return 0;

    let score = 100;

    if (cpuUsage >= 90) score -= 25;
    else if (cpuUsage >= 75) score -= 15;
    else if (cpuUsage >= 60) score -= 8;

    if (memoryUsage >= 90) score -= 25;
    else if (memoryUsage >= 80) score -= 15;
    else if (memoryUsage >= 70) score -= 8;

    if (pendingItems >= 100) score -= 20;
    else if (pendingItems >= 50) score -= 10;
    else if (pendingItems >= 20) score -= 5;

    if (this.error) score -= 10;

    if (score < 0) return 0;
    if (score > 100) return 100;
    return Math.round(score);
  }

  private getCpuUsage(): number {
    const now = Date.now();
    const elapsedMicros = Math.max(1, (now - this.cpuSampleTimestamp) * 1000);
    const currentUsage = process.cpuUsage();
    const userDelta = currentUsage.user - this.cpuSample.user;
    const systemDelta = currentUsage.system - this.cpuSample.system;

    this.cpuSample = currentUsage;
    this.cpuSampleTimestamp = now;

    const cpuCoreCount = Math.max(1, os.cpus().length);
    const processCpuPercent = ((userDelta + systemDelta) / elapsedMicros / cpuCoreCount) * 100;
    const boundedCpuPercent = Math.max(0, Math.min(100, Number.isFinite(processCpuPercent) ? processCpuPercent : 0));

    this.lastCpuUsage = Math.round(boundedCpuPercent * 10) / 10;
    return this.lastCpuUsage;
  }

  private getMemoryUsage(): number {
    const totalMemory = os.totalmem();
    if (!totalMemory) {
      this.lastMemoryUsage = 0;
      return 0;
    }

    const usedMemory = totalMemory - os.freemem();
    const memoryPercent = (usedMemory / totalMemory) * 100;
    const boundedMemoryPercent = Math.max(0, Math.min(100, Number.isFinite(memoryPercent) ? memoryPercent : 0));

    this.lastMemoryUsage = Math.round(boundedMemoryPercent * 10) / 10;
    return this.lastMemoryUsage;
  }

  private async getLastOrderTime(): Promise<string | null> {
    try {
      const dbSvc = this.dbManager?.getDatabaseService?.();
      const db = (dbSvc as unknown as {
        db?: { prepare: (sql: string) => { get: () => { last_order_time?: string | null } | undefined } }
      })?.db;

      if (!db?.prepare) return null;

      const row = db.prepare('SELECT MAX(created_at) as last_order_time FROM orders').get();
      return row?.last_order_time || null;
    } catch (error) {
      console.warn('[AdminDashboardSyncService] Failed to resolve last order time', error);
      return null;
    }
  }

  private async measureLatency(): Promise<number> {
    const start = Date.now();
    try {
      await fetch(`${this.adminDashboardUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      return Date.now() - start;
    } catch {
      return 9999; // High latency if failed
    }
  }
}
