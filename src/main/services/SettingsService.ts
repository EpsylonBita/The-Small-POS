import Database from 'better-sqlite3';
import { BaseService } from './BaseService';
import type { PrinterManager } from '../printer/services/PrinterManager';

// Database row interfaces
interface SettingsRow {
  id: string;
  setting_category: SettingCategory;
  setting_key: string;
  setting_value: string;
  last_sync: string;
  created_at: string;
  updated_at: string;
}

interface POSConfigRow {
  id: string;
  terminal_id: string;
  config_key: string;
  config_value: string;
  last_sync: string;
  created_at: string;
  updated_at: string;
}

interface SettingsFilter {
  category?: SettingCategory;
  key?: string;
}

export interface LocalSettings {
  id: string;
  setting_category: string; // 'terminal', 'printer', 'tax', 'discount', 'receipt', 'payment', 'inventory', 'staff', 'restaurant'
  setting_key: string;
  setting_value: string; // JSON string
  last_sync: string;
  created_at: string;
  updated_at: string;
}

export interface POSLocalConfig {
  id: string;
  terminal_id: string;
  config_key: string;
  config_value: string;
  last_sync: string;
  created_at: string;
  updated_at: string;
}

export type SettingCategory =
  | 'terminal'
  | 'printer'
  | 'tax'
  | 'discount'
  | 'receipt'
  | 'payment'
  | 'inventory'
  | 'staff'
  | 'restaurant'
  | 'system';

export class SettingsService extends BaseService {
  private printerManager: PrinterManager | null = null;

  constructor(database: Database.Database) {
    super(database);
    this.initializeDefaultSettings();
    this.cleanupDeprecatedSettings();
  }

  /**
   * Set the PrinterManager reference for settings export/import integration
   * @param printerManager - The PrinterManager instance
   * 
   * Requirements: 8.5
   */
  setPrinterManager(printerManager: PrinterManager | null): void {
    this.printerManager = printerManager;
  }

  // Initialize default settings on first run
  private initializeDefaultSettings(): void {
    try {
      // Check if discount max percentage setting exists
      const existingSetting = this.getSetting<number>('discount', 'max_discount_percentage');

      if (existingSetting === null) {
        // Set default max discount percentage to 30%
        this.setSetting('discount', 'max_discount_percentage', 30);
        console.log('Initialized default discount settings: max_discount_percentage = 30');
      }

      // Check if tax rate setting exists
      const existingTaxRate = this.getSetting<number>('tax', 'tax_rate_percentage');

      if (existingTaxRate === null) {
        // Set default tax rate to 24% (Greek VAT)
        this.setSetting('tax', 'tax_rate_percentage', 24);
        console.log('Initialized default tax settings: tax_rate_percentage = 24');
      }
    } catch (error) {
      console.error('Error initializing default settings:', error);
    }
  }

  // Cleanup deprecated settings from previous versions
  private cleanupDeprecatedSettings(): void {
    try {
      // Remove deprecated 'next_expected_opening' setting
      // This setting was used for automatic opening amount carry-forward from previous day's closing
      // but has been removed in favor of manual opening cash entry each day
      const deleted = this.deleteSetting('terminal', 'next_expected_opening');
      if (deleted) {
        console.log('Cleaned up deprecated setting: terminal.next_expected_opening');
      }
    } catch (error) {
      console.error('Error cleaning up deprecated settings:', error);
    }
  }

  // Local Settings Management
  setSetting(category: SettingCategory, key: string, value: unknown): void {
    this.executeTransaction(() => {
      const setting: LocalSettings = {
        id: this.generateId(),
        setting_category: category,
        setting_key: key,
        setting_value: JSON.stringify(value),
        last_sync: this.getCurrentTimestamp(),
        created_at: this.getCurrentTimestamp(),
        updated_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO local_settings (
          id, setting_category, setting_key, setting_value, 
          last_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        setting.id, setting.setting_category, setting.setting_key,
        setting.setting_value, setting.last_sync, setting.created_at,
        setting.updated_at
      );
    });
  }

  getSetting<T = unknown>(category: SettingCategory, key: string, defaultValue?: T): T | null {
    const stmt = this.db.prepare(`
      SELECT setting_value FROM local_settings 
      WHERE setting_category = ? AND setting_key = ?
    `);

    const row = stmt.get(category, key) as SettingsRow | undefined;

    if (!row) {
      return defaultValue !== undefined ? defaultValue : null;
    }

    try {
      return JSON.parse(row.setting_value);
    } catch (error) {
      console.error('Error parsing setting value:', error);
      return defaultValue !== undefined ? defaultValue : null;
    }
  }

  getAllSettings(category?: SettingCategory): LocalSettings[] {
    let query = 'SELECT * FROM local_settings';
    const params: (string | number)[] = [];

    if (category) {
      query += ' WHERE setting_category = ?';
      params.push(category);
    }

    query += ' ORDER BY setting_category, setting_key';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as SettingsRow[];

    return rows.map(row => this.mapRowToSetting(row));
  }

  deleteSetting(category: SettingCategory, key: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM local_settings 
      WHERE setting_category = ? AND setting_key = ?
    `);

    const result = stmt.run(category, key);
    return result.changes > 0;
  }

  clearCategorySettings(category: SettingCategory): number {
    const stmt = this.db.prepare(`
      DELETE FROM local_settings 
      WHERE setting_category = ?
    `);

    const result = stmt.run(category);
    return result.changes;
  }

  // POS Configuration Management
  setPOSConfig(terminalId: string, configKey: string, configValue: unknown): void {
    this.executeTransaction(() => {
      const config: POSLocalConfig = {
        id: this.generateId(),
        terminal_id: terminalId,
        config_key: configKey,
        config_value: JSON.stringify(configValue),
        last_sync: this.getCurrentTimestamp(),
        created_at: this.getCurrentTimestamp(),
        updated_at: this.getCurrentTimestamp()
      };

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO pos_local_config (
          id, terminal_id, config_key, config_value, 
          last_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        config.id, config.terminal_id, config.config_key,
        config.config_value, config.last_sync, config.created_at,
        config.updated_at
      );
    });
  }

  getPOSConfig<T = unknown>(terminalId: string, configKey: string, defaultValue?: T): T | null {
    const stmt = this.db.prepare(`
      SELECT config_value FROM pos_local_config 
      WHERE terminal_id = ? AND config_key = ?
    `);

    const row = stmt.get(terminalId, configKey) as POSConfigRow | undefined;

    if (!row) {
      return defaultValue !== undefined ? defaultValue : null;
    }

    try {
      return JSON.parse(row.config_value);
    } catch (error) {
      console.error('Error parsing config value:', error);
      return defaultValue !== undefined ? defaultValue : null;
    }
  }

  getAllPOSConfigs(terminalId?: string): POSLocalConfig[] {
    let query = 'SELECT * FROM pos_local_config';
    const params: (string | number)[] = [];

    if (terminalId) {
      query += ' WHERE terminal_id = ?';
      params.push(terminalId);
    }

    query += ' ORDER BY terminal_id, config_key';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as POSConfigRow[];

    return rows.map(row => this.mapRowToPOSConfig(row));
  }

  deletePOSConfig(terminalId: string, configKey: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM pos_local_config 
      WHERE terminal_id = ? AND config_key = ?
    `);

    const result = stmt.run(terminalId, configKey);
    return result.changes > 0;
  }

  clearTerminalConfigs(terminalId: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM pos_local_config 
      WHERE terminal_id = ?
    `);

    const result = stmt.run(terminalId);
    return result.changes;
  }

  // Bulk operations for settings sync
  bulkUpdateSettings(settings: Array<{
    category: SettingCategory;
    key: string;
    value: unknown;
  }>): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO local_settings (
          id, setting_category, setting_key, setting_value, 
          last_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = this.getCurrentTimestamp();

      for (const setting of settings) {
        stmt.run(
          this.generateId(),
          setting.category,
          setting.key,
          JSON.stringify(setting.value),
          now,
          now,
          now
        );
      }
    });
  }

  bulkUpdatePOSConfigs(configs: Array<{
    terminalId: string;
    configKey: string;
    configValue: unknown;
  }>): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO pos_local_config (
          id, terminal_id, config_key, config_value, 
          last_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = this.getCurrentTimestamp();

      for (const config of configs) {
        stmt.run(
          this.generateId(),
          config.terminalId,
          config.configKey,
          JSON.stringify(config.configValue),
          now,
          now,
          now
        );
      }
    });
  }

  // Legacy compatibility methods for main.ts
  async getSettings(): Promise<Record<string, any>> {
    const settings = this.getAllSettings();
    const result: Record<string, any> = {};

    for (const setting of settings) {
      const key = `${setting.setting_category}.${setting.setting_key}`;
      try {
        result[key] = JSON.parse(setting.setting_value);
      } catch (error) {
        result[key] = setting.setting_value;
      }
    }

    return result;
  }

  async updateSettings(settings: Record<string, any>): Promise<void> {
    this.executeTransaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        const [category, settingKey] = key.split('.');
        if (category && settingKey) {
          this.setSetting(category as SettingCategory, settingKey, value);
        }
      }
    });
  }

  // Main window reference for sync service compatibility
  setMainWindow(mainWindow: any): void {
    // This method is for compatibility with sync service
    // The SettingsService doesn't need the main window reference
    // but we provide this method to satisfy the interface
  }

  // Export/Import functionality
  /**
   * Export all settings including printer configurations
   * 
   * Requirements: 8.5
   */
  exportSettings(): {
    local_settings: LocalSettings[];
    pos_configs: POSLocalConfig[];
    printer_settings?: {
      printers: any[];
      routing: any;
    };
  } {
    const result: {
      local_settings: LocalSettings[];
      pos_configs: POSLocalConfig[];
      printer_settings?: {
        printers: any[];
        routing: any;
      };
    } = {
      local_settings: this.getAllSettings(),
      pos_configs: this.getAllPOSConfigs()
    };

    // Include printer settings if PrinterManager is available
    if (this.printerManager) {
      try {
        result.printer_settings = this.printerManager.exportSettings();
      } catch (error) {
        console.error('Error exporting printer settings:', error);
      }
    }

    return result;
  }

  /**
   * Import settings including printer configurations
   * 
   * @param data - The settings data to import
   * @param options - Import options
   * @param options.replacePrinters - If true, replace all printer configs; if false, merge (default: false)
   * 
   * Requirements: 8.5
   */
  importSettings(
    data: {
      local_settings?: LocalSettings[];
      pos_configs?: POSLocalConfig[];
      printer_settings?: {
        printers?: any[];
        routing?: any;
      };
    },
    options?: {
      replacePrinters?: boolean;
    }
  ): { printersImported?: number } {
    const result: { printersImported?: number } = {};

    this.executeTransaction(() => {
      // Import local settings
      if (data.local_settings) {
        const settingsToImport = data.local_settings.map(setting => ({
          category: setting.setting_category as SettingCategory,
          key: setting.setting_key,
          value: JSON.parse(setting.setting_value)
        }));

        this.bulkUpdateSettings(settingsToImport);
      }

      // Import POS configs
      if (data.pos_configs) {
        const configsToImport = data.pos_configs.map(config => ({
          terminalId: config.terminal_id,
          configKey: config.config_key,
          configValue: JSON.parse(config.config_value)
        }));

        this.bulkUpdatePOSConfigs(configsToImport);
      }
    });

    // Import printer settings if PrinterManager is available
    // This is done outside the transaction since PrinterManager has its own persistence
    if (data.printer_settings && this.printerManager) {
      try {
        const printerResult = this.printerManager.importSettings(
          data.printer_settings,
          options?.replacePrinters ?? false
        );
        result.printersImported = printerResult.printersImported;
      } catch (error) {
        console.error('Error importing printer settings:', error);
      }
    }

    return result;
  }

  private mapRowToSetting(row: SettingsRow): LocalSettings {
    return {
      id: row.id,
      setting_category: row.setting_category,
      setting_key: row.setting_key,
      setting_value: row.setting_value,
      last_sync: row.last_sync,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapRowToPOSConfig(row: POSConfigRow): POSLocalConfig {
    return {
      id: row.id,
      terminal_id: row.terminal_id,
      config_key: row.config_key,
      config_value: row.config_value,
      last_sync: row.last_sync,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // Discount Settings Helper Methods
  getDiscountMaxPercentage(): number {
    const value = this.getSetting<number>('discount', 'max_discount_percentage', 30);
    return value !== null ? value : 30;
  }

  setDiscountMaxPercentage(percentage: number): void {
    // Validate percentage (0-100)
    if (percentage < 0 || percentage > 100) {
      throw new Error('Discount percentage must be between 0 and 100');
    }
    this.setSetting('discount', 'max_discount_percentage', percentage);
  }

  // Tax Settings Helper Methods
  getTaxRatePercentage(): number {
    const value = this.getSetting<number>('tax', 'tax_rate_percentage', 24);
    return value !== null ? value : 24;
  }

  setTaxRatePercentage(percentage: number): void {
    // Validate percentage (0-100)
    if (percentage < 0 || percentage > 100) {
      throw new Error('Tax rate percentage must be between 0 and 100');
    }
    this.setSetting('tax', 'tax_rate_percentage', percentage);
  }

  // Version Tracking Methods
  getSettingsVersion(category: SettingCategory): number {
    const version = this.getSetting<number>(category, '_version', 0);
    return version !== null ? version : 0;
  }

  setSettingsVersion(category: SettingCategory, version: number): void {
    this.setSetting(category, '_version', version);
  }

  getAllSettingsVersions(): Record<SettingCategory, number> {
    const categories: SettingCategory[] = [
      'terminal', 'printer', 'tax', 'discount', 'receipt',
      'payment', 'inventory', 'staff', 'restaurant'
    ];

    const versions: Partial<Record<SettingCategory, number>> = {};
    for (const category of categories) {
      versions[category] = this.getSettingsVersion(category);
    }

    return versions as Record<SettingCategory, number>;
  }

  getLastSyncTime(category: SettingCategory): string | null {
    const syncTime = this.getSetting<string>(category, '_last_sync');
    return syncTime !== null ? syncTime : null;
  }

  updateSyncMetadata(category: SettingCategory, version: number, timestamp: string): void {
    this.executeTransaction(() => {
      this.setSettingsVersion(category, version);
      this.setSetting(category, '_last_sync', timestamp);
    });
  }

  // Terminal Type and Feature Management Methods

  /**
   * Get terminal type from settings
   * @returns 'main' | 'mobile_waiter' | null
   */
  getTerminalType(): 'main' | 'mobile_waiter' | null {
    return this.getSetting<'main' | 'mobile_waiter'>('terminal', 'terminal_type', 'main');
  }

  /**
   * Set terminal type
   * @param type - 'main' or 'mobile_waiter'
   */
  setTerminalType(type: 'main' | 'mobile_waiter'): void {
    this.setSetting('terminal', 'terminal_type', type);
  }

  /**
   * Get parent terminal ID (for mobile waiter terminals)
   * @returns Parent terminal UUID or null
   */
  getParentTerminalId(): string | null {
    return this.getSetting<string>('terminal', 'parent_terminal_id') ?? null;
  }

  /**
   * Set parent terminal ID
   * @param parentId - Parent terminal UUID or null
   */
  setParentTerminalId(parentId: string | null): void {
    this.setSetting('terminal', 'parent_terminal_id', parentId);
  }

  /**
   * Get enabled features as object
   * @returns Feature flags object
   */
  getEnabledFeatures(): Record<string, boolean> {
    return this.getSetting<Record<string, boolean>>('terminal', 'enabled_features', {}) ?? {};
  }

  /**
   * Set enabled features
   * @param features - Feature flags object
   */
  setEnabledFeatures(features: Record<string, boolean>): void {
    this.setSetting('terminal', 'enabled_features', features);
  }

  /**
   * Bulk update terminal configuration
   * @param config - Terminal configuration object
   */
  updateTerminalConfig(config: {
    terminal_type?: 'main' | 'mobile_waiter';
    parent_terminal_id?: string | null;
    enabled_features?: Record<string, boolean>;
  }): void {
    this.executeTransaction(() => {
      if (config.terminal_type) {
        // Runtime guard to ensure only known union values are persisted
        if (config.terminal_type === 'main' || config.terminal_type === 'mobile_waiter') {
          this.setSetting('terminal', 'terminal_type', config.terminal_type);
        } else {
          console.warn('[SettingsService] Ignoring unknown terminal_type:', config.terminal_type);
        }
      }
      if (config.parent_terminal_id !== undefined) {
        this.setSetting('terminal', 'parent_terminal_id', config.parent_terminal_id);
      }
      if (config.enabled_features) {
        this.setSetting('terminal', 'enabled_features', config.enabled_features);
      }
    });

    console.log('[SettingsService] Terminal config updated:', config);
  }

  // Inter-terminal Communication Settings
  getInterTerminalPort(): number {
    return this.getSetting<number>('terminal', 'inter_terminal_port', 8765) || 8765;
  }

  setInterTerminalPort(port: number): void {
    this.setSetting('terminal', 'inter_terminal_port', port);
  }

  getParentDiscoveryTimeoutMs(): number {
    return this.getSetting<number>('terminal', 'parent_discovery_timeout_ms', 10000) || 10000;
  }

  setParentDiscoveryTimeoutMs(timeoutMs: number): void {
    this.setSetting('terminal', 'parent_discovery_timeout_ms', timeoutMs);
  }

  getParentConnectionRetryIntervalMs(): number {
    return this.getSetting<number>('terminal', 'parent_connection_retry_interval_ms', 5000) || 5000;
  }

  setParentConnectionRetryIntervalMs(intervalMs: number): void {
    this.setSetting('terminal', 'parent_connection_retry_interval_ms', intervalMs);
  }

  isInterTerminalSyncEnabled(): boolean {
    return this.getSetting<boolean>('terminal', 'enable_inter_terminal_sync', true) ?? true;
  }

  setInterTerminalSyncEnabled(enabled: boolean): void {
    this.setSetting('terminal', 'enable_inter_terminal_sync', enabled);
  }

  getInterTerminalSecret(): string {
    return this.getSetting<string>('terminal', 'inter_terminal_secret', 'default-insecure-secret') || 'default-insecure-secret';
  }

  setInterTerminalSecret(secret: string): void {
    this.setSetting('terminal', 'inter_terminal_secret', secret);
  }

  // Language Settings Helper Methods
  getLanguage(): 'en' | 'el' {
    const value = this.getSetting<'en' | 'el'>('terminal', 'language', 'en');
    console.log(`[SettingsService] getLanguage() - raw value: "${value}", returning: "${value !== null ? value : 'en'}"`);
    return value !== null ? value : 'en';
  }

  setLanguage(language: 'en' | 'el'): void {
    console.log(`[SettingsService] setLanguage() called with: "${language}"`);
    // Validate language
    if (language !== 'en' && language !== 'el') {
      console.error(`[SettingsService] Invalid language: "${language}"`);
      throw new Error('Language must be either "en" or "el"');
    }
    this.setSetting('terminal', 'language', language);
    console.log(`[SettingsService] Language saved to database: "${language}"`);
    
    // Verify it was saved
    const savedValue = this.getSetting<'en' | 'el'>('terminal', 'language', 'en');
    console.log(`[SettingsService] Verification - saved value: "${savedValue}"`);
  }

  compareSettings(
    category: SettingCategory,
    remoteSettings: Record<string, any>
  ): { added: string[]; modified: string[]; removed: string[] } {
    const localSettings = this.getAllSettings(category);
    const localKeys = new Set(
      localSettings
        .map(s => s.setting_key)
        .filter(k => !k.startsWith('_')) // Exclude metadata keys
    );
    const remoteKeys = new Set(Object.keys(remoteSettings));

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find added and modified keys
    for (const key of remoteKeys) {
      if (!localKeys.has(key)) {
        added.push(key);
      } else {
        // Compare values
        const localValue = this.getSetting(category, key);
        const remoteValue = remoteSettings[key];
        if (JSON.stringify(localValue) !== JSON.stringify(remoteValue)) {
          modified.push(key);
        }
      }
    }

    // Find removed keys
    for (const key of localKeys) {
      if (!remoteKeys.has(key)) {
        removed.push(key);
      }
    }

    return { added, modified, removed };
  }

  // Enhanced setSetting with version tracking
  setSettingWithVersion(
    category: SettingCategory,
    key: string,
    value: unknown,
    version?: number
  ): boolean {
    // Check version before updating (optimistic locking)
    if (version !== undefined) {
      const currentVersion = this.getSettingsVersion(category);
      if (version <= currentVersion) {
        console.log(
          `Skipping setting update for ${category}.${key}: ` +
          `version ${version} <= current version ${currentVersion}`
        );
        return false;
      }
    }

    this.setSetting(category, key, value);

    if (version !== undefined) {
      this.setSettingsVersion(category, version);
    }

    return true;
  }

  // Enhanced bulkUpdateSettings with version tracking
  bulkUpdateSettingsWithVersion(
    settings: Array<{
      category: SettingCategory;
      key: string;
      value: unknown;
    }>,
    version?: number
  ): void {
    this.executeTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO local_settings (
          id, setting_category, setting_key, setting_value,
          last_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = this.getCurrentTimestamp();

      for (const setting of settings) {
        stmt.run(
          this.generateId(),
          setting.category,
          setting.key,
          JSON.stringify(setting.value),
          now,
          now,
          now
        );
      }

      // Update version for each category if provided
      if (version !== undefined) {
        const categories = new Set(settings.map(s => s.category));
        for (const category of categories) {
          this.setSettingsVersion(category, version);
          this.setSetting(category, '_last_sync', now);
        }
      }
    });
  }
}