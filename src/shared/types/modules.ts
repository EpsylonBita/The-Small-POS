/**
 * Module Types for POS System
 *
 * Re-exports canonical types from shared for type safety.
 * POS-specific types are defined locally where they differ from shared.
 */

// Re-export canonical types from shared
export type {
  ModuleId as SharedModuleId,
  ModuleCategory,
  ModuleMetadata as SharedModuleMetadata,
  EnabledModule as SharedEnabledModule,
  ModuleResolutionResult as SharedModuleResolutionResult,
  ModuleResolutionOptions,
} from '../../../../shared/types/modules';

// Re-export BusinessType from shared (via organization)
export type { BusinessType } from './organization';

// Re-export FeatureFlag from shared (via features)
export type { FeatureFlag } from './features';

/**
 * POS-specific ModuleId that extends the shared union with string.
 * This allows POS to accept any module IDs from sync endpoints that may
 * not yet be defined in the shared ModuleId union (e.g., new modules added
 * via admin dashboard before shared types are updated).
 */
export type POSModuleId = import('../../../../shared/types/modules').ModuleId | string;

// Also export as ModuleId for backward compatibility
export type ModuleId = POSModuleId;

/**
 * Simplified ModuleMetadata for POS system use.
 * Extends the shared type pattern but is optimized for POS needs.
 */
export interface ModuleMetadata {
  id: POSModuleId;
  name: string;
  description: string;
  category: import('../../../../shared/types/modules').ModuleCategory;
  isCore: boolean;
  showInNavigation: boolean;
  sortOrder: number;
  requiredFeatures: string[];
  compatibleBusinessTypes: string[];
  route?: string;
  icon?: string;
  posEnabled?: boolean;
}

/**
 * Enabled module with access status for POS
 */
export interface EnabledModule {
  module: ModuleMetadata;
  isEnabled: boolean;
  isLocked: boolean;
  requiredPlan?: string;
  isPurchased?: boolean;
  isPosEnabled?: boolean;
  missingFeatures?: string[];
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
  category: import('../../../../shared/types/modules').ModuleCategory | string;
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
 * Module resolution result for POS
 */
export interface ModuleResolutionResult {
  enabledModules: EnabledModule[];
  lockedModules: EnabledModule[];
  businessType: import('./organization').BusinessType;
  currentPlan: string;
  totalModulesForVertical: number;
}
