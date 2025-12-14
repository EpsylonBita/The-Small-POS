/**
 * Module types for POS system (flexible stubs)
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
  | 'finance'
  | 'vertical'
  | 'addon'
  | 'other';

export type BusinessType = string;

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
  dependencies?: unknown[];
  required_features?: string[];
  last_synced_at?: string;
  [key: string]: any;
}

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

export interface ModuleCacheData {
  apiModules: POSModuleInfo[];
  organizationId: string;
  terminalId: string;
  timestamp: number;
  apiTimestamp: string;
}

export type ModuleId = string;

export interface ModuleMetadata {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  route?: string;
  requiredFeatures?: string[];
  compatibleBusinessTypes?: BusinessType[];
  isCore?: boolean;
  sortOrder?: number;
  showInNavigation?: boolean;
  posEnabled?: boolean;
  [key: string]: unknown;
}

export interface EnabledModule {
  module: ModuleMetadata;
  isEnabled: boolean;
  isLocked: boolean;
  moduleId?: string;
  moduleName?: string;
  isActive?: boolean;
  isPosEnabled?: boolean;
  isPurchased?: boolean;
  purchasedAt?: string;
  expiresAt?: string | null;
  requiredPlan?: string;
  [key: string]: any;
}

// FeatureFlag is just a string identifier in POS
export type FeatureFlag = string;
