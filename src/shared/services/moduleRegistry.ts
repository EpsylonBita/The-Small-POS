/**
 * Module Registry Stub for POS System
 * 
 * Minimal stub to satisfy imports. The POS system doesn't use the full
 * module registry - this is just for components that reference it.
 */

import type { ModuleId, ModuleMetadata } from '../types/modules';

/**
 * Get module metadata by ID - stub implementation
 */
export function getModuleMetadata(moduleId: ModuleId): ModuleMetadata | null {
  // Return a basic stub for any module
  return {
    id: moduleId,
    name: moduleId.charAt(0).toUpperCase() + moduleId.slice(1).replace(/-/g, ' '),
    description: '',
    category: 'addon',
    isCore: false,
    showInNavigation: false,
    sortOrder: 0,
    requiredFeatures: [],
    compatibleBusinessTypes: [],
  };
}
