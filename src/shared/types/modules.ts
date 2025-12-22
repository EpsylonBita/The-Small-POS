/**
 * Module Types for POS System
 * 
 * Complete type definitions for module management in the POS system.
 */

export type ModuleId = string;

export type ModuleCategory = 'core' | 'vertical' | 'addon';

export type BusinessType = 'restaurant' | 'hotel' | 'retail' | 'cafe' | 'bar' | 'bakery' | 'food_truck' | 'fast_food' | 'salon' | 'bar_cafe' | 'chain' | 'franchise';

export type FeatureFlag = string;

export interface ModuleMetadata {
  id: ModuleId;
  name: string;
  description: string;
  category: ModuleCategory;
  isCore: boolean;
  showInNavigation: boolean;
  sortOrder: number;
  requiredFeatures: string[];
  compatibleBusinessTypes: string[] | BusinessType[];
  route?: string;
  icon?: string;
  posEnabled?: boolean;
}

/**
 * Enabled module with access status
 */
export interface EnabledModule {
  module: ModuleMetadata;
  isEnabled: boolean;
  isLocked: boolean;
  requiredPlan?: string;
  isPurchased?: boolean;
  isPosEnabled?: boolean;
  missingFeatures?: FeatureFlag[];
}

/**
 * POS Module Info - module data from admin dashboard API
 */
export interface POSModuleInfo {
  id: string;
  module_id: string;
  name: string;
  display_name: string;
  description: string;
  category: ModuleCategory | string;
  is_core: boolean;
  is_enabled: boolean;
  is_locked: boolean;
  is_purchased?: boolean;
  pos_enabled?: boolean;
  required_plan?: string;
  route?: string;
  icon?: string;
  sort_order: number;
  show_in_navigation?: boolean;
  compatible_business_types?: string[];
}

/**
 * Response from admin dashboard modules API
 */
export interface POSModulesEnabledResponse {
  success: boolean;
  modules: POSModuleInfo[];
  organization_id: string;
  terminal_id: string;
  timestamp: string;
  stats?: {
    total_modules: number;
    core_modules_count: number;
    purchased_modules_count: number;
  };
  processing_time_ms?: number;
}

/**
 * Module resolution result
 */
export interface ModuleResolutionResult {
  enabledModules: EnabledModule[];
  lockedModules: EnabledModule[];
  businessType: BusinessType;
  currentPlan: string;
  totalModulesForVertical: number;
}

/**
 * Module resolution options
 */
export interface ModuleResolutionOptions {
  includeLocked?: boolean;
  category?: ModuleCategory;
  navigationOnly?: boolean;
}
