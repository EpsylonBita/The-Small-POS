import Database from 'better-sqlite3';
import { BaseService } from './BaseService';
import type { SettingsService } from './SettingsService';

/**
 * Terminal feature flags interface
 * Defines which features are enabled/disabled for a terminal
 */
export interface TerminalFeatures {
  [key: string]: boolean | undefined;
  cashDrawer: boolean;
  zReportExecution: boolean;
  cashPayments: boolean;
  cardPayments: boolean;
  orderCreation: boolean;
  orderModification: boolean;
  discounts: boolean;
  refunds: boolean;
  expenses: boolean;
  staffPayments: boolean;
  reports: boolean;
  settings: boolean;
}

/**
 * Terminal type enum
 */
export type TerminalType = 'main' | 'mobile_waiter';

/**
 * Terminal configuration interface
 */
export interface TerminalConfig {
  terminalType: TerminalType | null;
  parentTerminalId: string | null;
  features: TerminalFeatures;
}

/**
 * Default features for main POS terminal (all features enabled)
 */
const DEFAULT_MAIN_FEATURES: TerminalFeatures = {
  cashDrawer: true,
  zReportExecution: true,
  cashPayments: true,
  cardPayments: true,
  orderCreation: true,
  orderModification: true,
  discounts: true,
  refunds: true,
  expenses: true,
  staffPayments: true,
  reports: true,
  settings: true,
};

/**
 * Default features for mobile waiter terminal (limited set)
 */
const DEFAULT_MOBILE_WAITER_FEATURES: TerminalFeatures = {
  cashDrawer: false,
  zReportExecution: false,
  cashPayments: false,  // No cash handling on mobile
  cardPayments: true,
  orderCreation: true,
  orderModification: true,
  discounts: false,     // Configurable by admin
  refunds: false,       // Configurable by admin
  expenses: false,
  staffPayments: false,
  reports: false,       // Configurable by admin
  settings: false,      // Configurable by admin
};

/**
 * FeatureService - Manages feature flags for POS terminals
 *
 * Provides centralized feature management with support for:
 * - Main POS terminals (full feature set)
 * - Mobile waiter terminals (limited feature set)
 * - Custom feature configurations from admin dashboard
 */
import { FEATURE_KEY_MAPPING, mapServerFeaturesToLocal as mapServerToLocal } from '../../shared/feature-mapping';

export class FeatureService extends BaseService {
  private settingsService: SettingsService | null = null;
  private cachedFeatures: TerminalFeatures | null = null;
  private cachedTerminalType: TerminalType | null = null;
  // Initialize as undefined so first access can trigger a settings load
  private cachedParentTerminalId: string | null | undefined = undefined;

  constructor(database: Database.Database) {
    super(database);
  }

  /**
   * Set the SettingsService reference for reading cached settings
   */
  setSettingsService(settingsService: SettingsService): void {
    this.settingsService = settingsService;
    // Load initial features from settings
    this.loadFeaturesFromSettings();
  }

  /**
   * Load features from SettingsService cache
   */
  private loadFeaturesFromSettings(): void {
    if (!this.settingsService) {
      console.warn('[FeatureService] SettingsService not available, using defaults');
      return;
    }

    try {
      // Load terminal type
      const terminalType = this.settingsService.getSetting<TerminalType>(
        'terminal',
        'terminal_type',
        'main'
      );
      this.cachedTerminalType = terminalType;

      // Load parent terminal ID
      const parentTerminalId = this.settingsService.getSetting<string | null>(
        'terminal',
        'parent_terminal_id',
        null
      );
      this.cachedParentTerminalId = parentTerminalId;

      // Load enabled features
      const enabledFeatures = this.settingsService.getSetting<Record<string, boolean> | null>(
        'terminal',
        'enabled_features',
        null
      );

      if (enabledFeatures) {
        // Merge with defaults to ensure all feature keys exist
        const defaultFeatures = this.getDefaultFeatures(terminalType || 'main');
        this.cachedFeatures = {
          ...defaultFeatures,
          ...mapServerToLocal<TerminalFeatures>(enabledFeatures, FEATURE_KEY_MAPPING as Record<string, keyof TerminalFeatures>),
        };
      } else {
        // Use defaults based on terminal type
        this.cachedFeatures = this.getDefaultFeatures(terminalType || 'main');
      }

      console.log('[FeatureService] Features loaded:', {
        terminalType: this.cachedTerminalType,
        parentTerminalId: this.cachedParentTerminalId,
        features: this.cachedFeatures,
      });
    } catch (error) {
      console.error('[FeatureService] Error loading features:', error);
      this.cachedFeatures = DEFAULT_MAIN_FEATURES;
    }
  }

  // Mapping logic has been extracted to shared/feature-mapping.ts to avoid drift between main and renderer

  /**
   * Get default features based on terminal type
   */
  getDefaultFeatures(terminalType: TerminalType): TerminalFeatures {
    if (terminalType === 'mobile_waiter') {
      return { ...DEFAULT_MOBILE_WAITER_FEATURES };
    }
    return { ...DEFAULT_MAIN_FEATURES };
  }

  /**
   * Get all feature flags
   */
  getFeatures(): TerminalFeatures {
    if (!this.cachedFeatures) {
      this.loadFeaturesFromSettings();
    }
    return this.cachedFeatures || DEFAULT_MAIN_FEATURES;
  }

  /**
   * Check if a specific feature is enabled
   */
  isFeatureEnabled(featureName: keyof TerminalFeatures): boolean {
    const features = this.getFeatures();
    return features[featureName] ?? false;
  }

  /**
   * Update feature flags in cache and persist to settings
   */
  updateFeatures(features: Partial<TerminalFeatures>): void {
    const currentFeatures = this.getFeatures();
    this.cachedFeatures = {
      ...currentFeatures,
      ...features,
    };

    // Persist to settings if available
    if (this.settingsService) {
      this.settingsService.setSetting('terminal', 'enabled_features', this.cachedFeatures);
    }

    console.log('[FeatureService] Features updated:', this.cachedFeatures);
  }

  /**
   * Get terminal type
   */
  getTerminalType(): TerminalType | null {
    if (this.cachedTerminalType === null) {
      this.loadFeaturesFromSettings();
    }
    return this.cachedTerminalType;
  }

  /**
   * Set terminal type and update features accordingly
   */
  setTerminalType(type: TerminalType): void {
    this.cachedTerminalType = type;

    // Update features to match new terminal type (if not already customized)
    if (this.settingsService) {
      this.settingsService.setSetting('terminal', 'terminal_type', type);

      // If no custom features are set, apply defaults for the new type
      const existingFeatures = this.settingsService.getSetting<Record<string, boolean> | null>(
        'terminal',
        'enabled_features',
        null
      );

      if (!existingFeatures) {
        this.cachedFeatures = this.getDefaultFeatures(type);
        this.settingsService.setSetting('terminal', 'enabled_features', this.cachedFeatures);
      }
    }

    console.log('[FeatureService] Terminal type set to:', type);
  }

  /**
   * Get parent terminal ID (for mobile waiter terminals)
   */
  getParentTerminalId(): string | null {
    if (this.cachedParentTerminalId === undefined) {
      this.loadFeaturesFromSettings();
    }
    return this.cachedParentTerminalId ?? null;
  }

  /**
   * Set parent terminal ID
   */
  setParentTerminalId(parentId: string | null): void {
    this.cachedParentTerminalId = parentId;

    if (this.settingsService) {
      this.settingsService.setSetting('terminal', 'parent_terminal_id', parentId);
    }

    console.log('[FeatureService] Parent terminal ID set to:', parentId);
  }

  /**
   * Get full terminal configuration
   */
  getTerminalConfig(): TerminalConfig {
    return {
      terminalType: this.getTerminalType(),
      parentTerminalId: this.getParentTerminalId(),
      features: this.getFeatures(),
    };
  }

  /**
   * Update terminal configuration from admin dashboard sync
   */
  updateTerminalConfig(config: {
    terminal_type?: TerminalType;
    parent_terminal_id?: string | null;
    enabled_features?: Record<string, boolean>;
  }): void {
    if (config.terminal_type) {
      this.cachedTerminalType = config.terminal_type;
      if (this.settingsService) {
        this.settingsService.setSetting('terminal', 'terminal_type', config.terminal_type);
      }
    }

    if (config.parent_terminal_id !== undefined) {
      this.cachedParentTerminalId = config.parent_terminal_id;
      if (this.settingsService) {
        this.settingsService.setSetting('terminal', 'parent_terminal_id', config.parent_terminal_id);
      }
    }

    if (config.enabled_features) {
      const defaultFeatures = this.getDefaultFeatures(this.cachedTerminalType || 'main');
      this.cachedFeatures = {
        ...defaultFeatures,
        ...mapServerToLocal<TerminalFeatures>(config.enabled_features, FEATURE_KEY_MAPPING as Record<string, keyof TerminalFeatures>),
      };
      if (this.settingsService) {
        this.settingsService.setSetting('terminal', 'enabled_features', this.cachedFeatures);
      }
    }

    console.log('[FeatureService] Terminal config updated:', {
      terminalType: this.cachedTerminalType,
      parentTerminalId: this.cachedParentTerminalId,
      features: this.cachedFeatures,
    });
  }

  /**
   * Check if this is a mobile waiter terminal
   */
  isMobileWaiter(): boolean {
    return this.getTerminalType() === 'mobile_waiter';
  }

  /**
   * Check if this is a main terminal
   */
  isMainTerminal(): boolean {
    return this.getTerminalType() === 'main' || this.getTerminalType() === null;
  }

  /**
   * Refresh features from settings (call after settings sync)
   */
  refresh(): void {
    this.loadFeaturesFromSettings();
  }
}
