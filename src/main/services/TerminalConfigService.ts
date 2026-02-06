/**
 * TerminalConfigService
 *
 * Manages terminal-specific configuration from pos_configurations table
 * Features:
 * - Load settings for current terminal
 * - Subscribe to realtime updates
 * - Cache settings in local DB
 * - Expose settings retrieval methods
 */

import { supabase } from '../../shared/supabase';
import { isSupabaseConfigured, setSupabaseContext } from '../../shared/supabase-config';
import { DatabaseManager } from '../database';
import { RealtimeChannel } from '@supabase/supabase-js';
import type { BusinessType } from '../../shared/types/organization';

export interface TerminalSettings {
  terminal_id: string;
  branch_id?: string;
  organization_id?: string;
  business_type?: BusinessType | null;
  settings: Record<string, any>;
  version: number;
  last_updated: string;
}

export class TerminalConfigService {
  private db: DatabaseManager;
  private terminalId: string;
  private currentSettings: TerminalSettings | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private onUpdate?: (settings: TerminalSettings) => void;

  private syncTerminalSettingsToLocalSettings(settings: TerminalSettings): void {
    try {
      const dbSvc = this.db.getDatabaseService?.();
      const settingsSvc = dbSvc?.settings;
      if (!settingsSvc) return;

      if (settings.terminal_id) {
        settingsSvc.setSetting('terminal', 'terminal_id', settings.terminal_id);
      }
      if (settings.branch_id) {
        settingsSvc.setSetting('terminal', 'branch_id', settings.branch_id);
      }
      if (settings.organization_id) {
        settingsSvc.setSetting('terminal', 'organization_id', settings.organization_id);
      }

      setSupabaseContext({
        terminalId: settings.terminal_id,
        organizationId: settings.organization_id || undefined,
        branchId: settings.branch_id || undefined,
        clientType: 'desktop',
      });
    } catch (error) {
      console.warn('[TerminalConfigService] Failed to sync terminal settings to local settings:', error);
    }
  }

  constructor(terminalId: string, dbManager: DatabaseManager) {
    this.terminalId = terminalId;
    this.db = dbManager;
  }

  /**
   * Initialize the service - load settings and subscribe to updates
   */
  async initialize(): Promise<void> {
    console.log('[TerminalConfigService] Initializing for terminal:', this.terminalId);

    // Ensure database is initialized
    if (!this.db.db) {
      await this.db.initialize();
    }

    // Load initial settings
    await this.loadSettings();

    // Subscribe to realtime updates
    await this.subscribeToUpdates();
  }

  /**
   * Load settings from Supabase and cache in local DB
   */
  private async loadSettings(): Promise<void> {
    try {
      console.log('[TerminalConfigService] Loading settings for terminal:', this.terminalId);

      // Query pos_configurations for this terminal
      const { data, error } = await supabase
        .from('pos_configurations')
        .select('*')
        .eq('terminal_id', this.terminalId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        // PGRST116 means no rows found, which is expected for new terminals
        if (error.code === 'PGRST116') {
          console.log('[TerminalConfigService] No settings found in Supabase (new terminal), using local cache');
        } else {
          console.error('[TerminalConfigService] Error loading settings:', error);
        }

        // Try to load from local cache if Supabase fails or has no data
        await this.loadFromLocalCache();
        return;
      }

      if (data) {
        // Resolve organization_id from branch if not present
        let organizationId = data.organization_id;
        if (!organizationId && data.branch_id) {
          organizationId = await this.resolveOrganizationId(data.branch_id);
        }

        // Resolve business_type from organization, with fallback to cached value
        let businessType: BusinessType | null = null;
        let businessTypeResolutionFailed = false;
        if (organizationId) {
          const resolvedBusinessType = await this.resolveBusinessType(organizationId);
          if (resolvedBusinessType !== null) {
            businessType = resolvedBusinessType;
          } else {
            // Resolution failed (network error or query error), use cached value as fallback
            businessTypeResolutionFailed = true;
            businessType = this.currentSettings?.business_type || null;
            if (businessType) {
              console.log('[TerminalConfigService] Using cached business_type as fallback:', businessType);
            } else {
              // Organization exists but has no resolvable business_type and no cached value
              // This can happen for new installs or if the organization record is incomplete
              // Use a safe default so terminals still receive a reasonable module set
              // Default: 'fast_food' - see database-schema.sql for documentation
              console.warn(
                '[TerminalConfigService] WARNING: Organization has no resolvable business_type and no cached value. ' +
                'Using default business_type "fast_food". Please configure the organization\'s business_type in the admin dashboard.'
              );
              businessType = 'fast_food';
              
              // Emit IPC event to notify renderer of configuration warning
              this.emitConfigurationWarning('missing_business_type', {
                organizationId,
                defaultUsed: 'fast_food',
                message: 'Organization has no business type configured. Using default "fast_food".'
              });
            }
          }
        }

        const settings: TerminalSettings = {
          terminal_id: data.terminal_id,
          branch_id: data.branch_id,
          organization_id: organizationId,
          business_type: businessType,
          settings: data.settings || {},
          version: data.version || 1,
          last_updated: data.updated_at
        };

        this.currentSettings = settings;

        // Cache in local DB, but only update business_type if resolution succeeded
        await this.cacheSettings(settings, businessTypeResolutionFailed);
        this.syncTerminalSettingsToLocalSettings(settings);

        console.log('[TerminalConfigService] Settings loaded successfully');
      } else {
        console.warn('[TerminalConfigService] No settings found for terminal');
      }
    } catch (error) {
      console.error('[TerminalConfigService] Exception loading settings:', error);
      await this.loadFromLocalCache();
    }
  }

  /**
   * Load settings from local cache
   */
  private async loadFromLocalCache(): Promise<void> {
    try {
      const stmt = this.db.db?.prepare(
        'SELECT * FROM terminal_settings WHERE terminal_id = ? ORDER BY updated_at DESC LIMIT 1'
      );
      const cached = stmt?.get(this.terminalId) as any;

      if (cached) {
        this.currentSettings = {
          terminal_id: cached.terminal_id,
          branch_id: cached.branch_id,
          organization_id: cached.organization_id || null,
          business_type: (cached.business_type as BusinessType) || null,
          settings: JSON.parse(cached.settings || '{}'),
          version: cached.version || 1,
          last_updated: cached.updated_at
        };
        this.syncTerminalSettingsToLocalSettings(this.currentSettings);
        console.log('[TerminalConfigService] Loaded settings from local cache');
      }
    } catch (error) {
      console.error('[TerminalConfigService] Error loading from cache:', error);
    }
  }

  /**
   * Cache settings in local database
   * @param settings The settings to cache
   * @param preserveBusinessType If true, preserve the existing cached business_type (used when resolution failed)
   */
  private async cacheSettings(settings: TerminalSettings, preserveBusinessType: boolean = false): Promise<void> {
    try {
      // Table schema for terminal_settings is managed centrally in DatabaseService.createTables()

      let businessTypeToCache = settings.business_type || null;

      // If we need to preserve business_type due to resolution failure, fetch the existing cached value
      if (preserveBusinessType) {
        const existingStmt = this.db.db?.prepare(
          'SELECT business_type FROM terminal_settings WHERE terminal_id = ?'
        );
        const existing = existingStmt?.get(settings.terminal_id) as any;
        if (existing?.business_type) {
          businessTypeToCache = existing.business_type;
          console.log('[TerminalConfigService] Preserving cached business_type:', businessTypeToCache);
        }
      }

      // Upsert settings
      const upsert = this.db.db?.prepare(`
        INSERT OR REPLACE INTO terminal_settings
        (terminal_id, branch_id, organization_id, business_type, settings, version, updated_at, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      upsert?.run(
        settings.terminal_id,
        settings.branch_id || null,
        settings.organization_id || null,
        businessTypeToCache,
        JSON.stringify(settings.settings),
        settings.version,
        settings.last_updated
      );

      console.log('[TerminalConfigService] Settings cached locally');
    } catch (error) {
      console.error('[TerminalConfigService] Error caching settings:', error);
    }
  }

  /**
   * Subscribe to realtime updates for this terminal
   */
  async subscribeToUpdates(): Promise<void> {
    try {
      console.log('[TerminalConfigService] Subscribing to realtime updates for:', this.terminalId);

      this.realtimeChannel = supabase
        .channel(`terminal-config:${this.terminalId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'pos_configurations',
            filter: `terminal_id=eq.${this.terminalId}`
          },
          async (payload) => {
            console.log('[TerminalConfigService] Realtime update received:', payload);

            // Refresh settings
            await this.refresh();

            // Notify listeners
            if (this.onUpdate && this.currentSettings) {
              this.onUpdate(this.currentSettings);
            }
          }
        )
        .subscribe((status) => {
          console.log('[TerminalConfigService] Subscription status:', status);
        });
    } catch (error) {
      console.error('[TerminalConfigService] Error subscribing to updates:', error);
    }
  }

  /**
   * Set callback for configuration updates
   */
  setUpdateCallback(callback: (settings: TerminalSettings) => void): void {
    this.onUpdate = callback;
  }

  /**
   * Get all settings
   */
  getSettings(): Record<string, any> {
    return this.currentSettings?.settings || {};
  }

  /**
   * Get specific setting by key (supports nested keys with dot notation)
   */
  getSetting(key: string, defaultValue?: any): any {
    if (!this.currentSettings || !this.currentSettings.settings) {
      return defaultValue;
    }

    // Support nested keys like 'payment.default_method'
    const keys = key.split('.');
    let value: any = this.currentSettings.settings;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }

    return value !== undefined ? value : defaultValue;
  }

  /**
   * Refresh settings from Supabase
   */
  async refresh(): Promise<void> {
    console.log('[TerminalConfigService] Refreshing settings');
    await this.loadSettings();
  }

  /**
   * Get current terminal ID
   */
  getTerminalId(): string {
    return this.terminalId;
  }

  /**
   * Get current branch ID
   */
  getBranchId(): string | undefined {
    return this.currentSettings?.branch_id;
  }

  /**
   * Get current organization ID
   */
  getOrganizationId(): string | undefined {
    return this.currentSettings?.organization_id;
  }

  /**
   * Get current organization's business type
   */
  getBusinessType(): BusinessType | undefined {
    return this.currentSettings?.business_type || undefined;
  }

  /**
   * Switch this service to a new terminal ID.
   * Cleans up existing subscriptions and reloads settings for the new terminal.
   */
  async switchTerminal(newTerminalId: string): Promise<void> {
    if (!newTerminalId || newTerminalId === this.terminalId) {
      console.log('[TerminalConfigService] switchTerminal called with same terminalId, refreshing');
      await this.refresh();
      return;
    }

    console.log('[TerminalConfigService] Switching terminal from', this.terminalId, 'to', newTerminalId);

    // Clean up existing subscription for old terminal
    await this.cleanup();

    // Update terminal ID and clear current settings so they are reloaded
    this.terminalId = newTerminalId;
    this.currentSettings = null;

    // Re-initialize for the new terminal (loads settings + subscribes to updates)
    await this.initialize();
  }

  /**
   * Resolve organization_id from branch_id by querying Supabase
   */
  async resolveOrganizationId(branchId: string): Promise<string | null> {
    try {
      console.log('[TerminalConfigService] Resolving organization_id for branch:', branchId);

      const { data, error } = await supabase
        .from('branches')
        .select('organization_id')
        .eq('id', branchId)
        .single();

      if (error || !data) {
        console.error('[TerminalConfigService] Error resolving organization_id:', error);
        return null;
      }

      console.log('[TerminalConfigService] Resolved organization_id:', data.organization_id);
      return data.organization_id;
    } catch (error) {
      console.error('[TerminalConfigService] Exception resolving organization_id:', error);
      return null;
    }
  }

  /**
   * Resolve business_type from organization_id by querying Supabase
   * Returns null if resolution fails (network error, query error, or organization not found)
   */
  private async resolveBusinessType(organizationId: string): Promise<BusinessType | null> {
    try {
      console.log('[TerminalConfigService] Resolving business_type for organization:', organizationId);

      const { data, error } = await supabase
        .from('organizations')
        .select('business_type')
        .eq('id', organizationId)
        .single();

      if (error) {
        console.error('[TerminalConfigService] Error resolving business_type:', error);
        return null;
      }

      if (!data) {
        console.warn('[TerminalConfigService] Organization not found:', organizationId);
        return null;
      }

      console.log('[TerminalConfigService] Resolved business_type:', data.business_type);
      return data.business_type as BusinessType | null;
    } catch (error) {
      console.error('[TerminalConfigService] Exception resolving business_type:', error);
      return null;
    }
  }

  /**
   * Emit a configuration warning to the renderer process via IPC.
   * This allows the UI to display warnings to operators about configuration issues.
   */
  private emitConfigurationWarning(
    warningType: string,
    details: Record<string, any>
  ): void {
    try {
      // Import BrowserWindow dynamically to avoid circular dependencies
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('terminal-config-warning', {
            type: warningType,
            details,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      console.log('[TerminalConfigService] Emitted configuration warning:', warningType);
    } catch (error) {
      console.error('[TerminalConfigService] Failed to emit configuration warning:', error);
    }
  }

  /**
   * Cleanup subscriptions
   */
  async cleanup(): Promise<void> {
    if (this.realtimeChannel) {
      await supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }
  /**
   * Validate if the terminal exists and is active in the backend.
   *
   * Returns:
   * - true: Terminal is valid OR is a default/new terminal that needs onboarding
   * - false: Terminal was previously registered but is now deleted/inactive (should reset)
   *
   * The key distinction is:
   * - Default terminal (terminal-001) or unconfigured terminal: allow to proceed with onboarding
   * - Previously configured terminal that's been deleted: trigger reset
   */
  async validateTerminal(): Promise<boolean> {
    try {
      console.log('[TerminalConfigService] Validating terminal:', this.terminalId);

      // Default terminal-001 is always considered "valid" for onboarding purposes
      // It's not registered in the backend, but that's expected
      if (this.terminalId === 'terminal-001') {
        console.log('[TerminalConfigService] Default terminal-001, skipping backend validation (needs onboarding)');
        return true;
      }

      // Check if Supabase is configured before attempting validation
      if (!isSupabaseConfigured()) {
        console.log('[TerminalConfigService] Supabase not configured, skipping backend validation (onboarding mode)');
        return true;
      }

      const { data, error } = await supabase
        .from('pos_terminals')
        .select('id, is_active')
        .eq('terminal_id', this.terminalId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Terminal not found in backend - this is expected for newly onboarded terminals
          // that haven't been synced yet. Allow them to proceed.
          console.log('[TerminalConfigService] Terminal not found in backend (may be newly registered):', this.terminalId);
          return true; // Allow - let the app proceed, it will sync via heartbeat
        }
        console.error('[TerminalConfigService] Error validating terminal:', error);
        // Network or other error - fail open to allow offline usage
        return true;
      }

      if (!data.is_active) {
        console.warn('[TerminalConfigService] Terminal is inactive:', this.terminalId);
        return false;
      }

      console.log('[TerminalConfigService] Terminal validated successfully:', this.terminalId);
      return true;
    } catch (error) {
      console.error('[TerminalConfigService] Exception validating terminal:', error);
      return true; // Fail open (allow) on exception to prevent blocking offline usage
    }
  }
}

export default TerminalConfigService;
