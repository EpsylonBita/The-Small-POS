/**
 * Module Types Stub for POS System
 * 
 * Minimal type definitions to satisfy imports.
 */

export type ModuleId = string;

export type ModuleCategory = 'core' | 'vertical' | 'addon';

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
