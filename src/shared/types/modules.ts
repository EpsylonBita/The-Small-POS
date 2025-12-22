/**
 * Module Types for POS System
 * 
 * Type definitions for module management in the POS system.
 */

export type ModuleId = string;

export type ModuleCategory = 'core' | 'vertical' | 'addon';

export type BusinessType = 'restaurant' | 'hotel' | 'retail' | 'cafe' | 'bar' | 'bakery' | 'food_truck';

export interface ModuleMetadata {
  id: ModuleId;
  name: string;
  description: string;
  category: ModuleCategory;
  isCore: boolean;
  showInNavigation: boolean;
  sortOrder: number;
  requiredFeatures: string[];
  compatibleBusinessTypes: string[];
  route?: string;
}

/**
 * POS Module Info - module data from admin dashboard API
 */
export interface POSModuleInfo {
  id: string;
  name: string;
  description: string;
  category: ModuleCategory;
  is_core: boolean;
  is_enabled: boolean;
  is_locked: boolean;
  is_purchased?: boolean;
  required_plan?: string;
  route?: string;
  icon?: string;
  sort_order: number;
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
