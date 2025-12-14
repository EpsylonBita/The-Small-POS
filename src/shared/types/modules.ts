/**
 * Module types for POS system
 * 
 * These types mirror the shared/types/modules.ts definitions
 * for use within the POS system's isolated TypeScript context.
 */

/**
 * Module category types
 */
export type ModuleCategory = 
  | 'core'
  | 'operations'
  | 'management'
  | 'analytics'
  | 'integrations'
  | 'customer'
  | 'staff'
  | 'inventory'
  | 'marketing'
  | 'finance';

/**
 * Business type for module compatibility
 */
export type BusinessType = 
  | 'fast_food'
  | 'restaurant'
  | 'hotel'
  | 'salon'
  | 'retail'
  | 'cafe'
  | 'bar'
  | 'bakery'
  | 'food_truck'
  | 'catering';

/**
 * Module information returned by POS sync endpoints
 */
export interface POSModuleInfo {
  id: string;
  module_id: string;
  name: string;
  display_name: string;
  description: string | null;
  icon: string;
  category: ModuleCategory;
  route: string;
  is_core: boolean;
  is_purchased: boolean;
  pos_enabled: boolean;
  show_in_navigation: boolean;
  sort_order: number;
  features: Record<string, unknown>;
  metadata: Record<string, unknown>;
  compatible_business_types: BusinessType[];
  purchased_at?: string;
  updated_at: string;
  /** Module dependencies (only returned by /sync endpoint) */
  dependencies?: unknown[];
  /** Required features for this module (only returned by /sync endpoint) */
  required_features?: string[];
  /** Timestamp when module was last synced to POS (only returned by /sync endpoint) */
  last_synced_at?: string;
}

/**
 * Response from POS modules enabled endpoint
 */
export interface POSModulesEnabledResponse {
  success: boolean;
  modules: POSModuleInfo[];
  organization_id: string;
  terminal_id: string;
  timestamp: string;
  stats: {
    total_modules: number;
    core_modules_count: number;
    purchased_modules_count: number;
  };
  processing_time_ms: number;
}

/**
 * Cache data structure for storing modules locally
 */
export interface ModuleCacheData {
  /** Modules fetched from admin dashboard API */
  apiModules: POSModuleInfo[];
  /** Organization ID */
  organizationId: string;
  /** Terminal ID */
  terminalId: string;
  /** Cache timestamp (Unix ms) */
  timestamp: number;
  /** API response timestamp for sync tracking */
  apiTimestamp: string;
}
