/**
 * Module Registry Service for POS System
 * 
 * Provides module resolution and metadata lookup for the POS system.
 */

import type { 
  ModuleId, 
  ModuleMetadata, 
  EnabledModule,
  ModuleResolutionResult,
  ModuleResolutionOptions,
  BusinessType,
  FeatureFlag
} from '../types/modules';

/**
 * Feature access checker type
 */
export type FeatureAccessChecker = (
  organizationId: string,
  feature: FeatureFlag
) => Promise<{ allowed: boolean; currentPlan?: string; requiredPlan?: string }>;

/**
 * Get module metadata by ID - stub implementation
 */
export function getModuleMetadata(moduleId: ModuleId): ModuleMetadata | null {
  // Map known module icons
  const iconMap: Record<string, string> = {
    dashboard: 'LayoutDashboard',
    settings: 'Settings',
    orders: 'ClipboardList',
    menu: 'BookOpen',
    users: 'Users',
    analytics: 'BarChart3',
    reports: 'FileText',
    inventory: 'Package',
    tables: 'LayoutGrid',
    reservations: 'Calendar',
    kitchen: 'ChefHat',
    kiosk: 'Monitor',
    delivery: 'Truck',
    loyalty: 'Gift',
    staff: 'UserCog',
  };

  // Return a basic stub for any module
  return {
    id: moduleId,
    name: moduleId.charAt(0).toUpperCase() + moduleId.slice(1).replace(/-/g, ' '),
    description: '',
    category: 'addon',
    isCore: moduleId === 'dashboard' || moduleId === 'settings',
    showInNavigation: true,
    sortOrder: 0,
    requiredFeatures: [],
    compatibleBusinessTypes: [],
    icon: iconMap[moduleId] || 'Package',
  };
}

/**
 * Resolve enabled modules for an organization - stub implementation
 * In POS, modules are fetched from admin dashboard API, so this is a fallback
 */
export async function resolveEnabledModules(
  _organizationId: string,
  businessType: BusinessType,
  _checkFeatureAccess: FeatureAccessChecker,
  _options: ModuleResolutionOptions = {}
): Promise<ModuleResolutionResult> {
  // Return minimal default modules for POS
  const coreModules: EnabledModule[] = [
    {
      module: {
        id: 'dashboard',
        name: 'Dashboard',
        description: 'Main dashboard',
        category: 'core',
        isCore: true,
        showInNavigation: true,
        sortOrder: 0,
        requiredFeatures: [],
        compatibleBusinessTypes: [],
        route: '/dashboard',
        icon: 'LayoutDashboard',
      },
      isEnabled: true,
      isLocked: false,
    },
    {
      module: {
        id: 'settings',
        name: 'Settings',
        description: 'System settings',
        category: 'core',
        isCore: true,
        showInNavigation: true,
        sortOrder: 999,
        requiredFeatures: [],
        compatibleBusinessTypes: [],
        route: '/settings',
        icon: 'Settings',
      },
      isEnabled: true,
      isLocked: false,
    },
  ];

  return {
    enabledModules: coreModules,
    lockedModules: [],
    businessType,
    currentPlan: 'Starter',
    totalModulesForVertical: coreModules.length,
  };
}
