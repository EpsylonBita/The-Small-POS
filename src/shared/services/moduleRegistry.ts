/**
 * Module Registry (POS-local stub)
 */

import type { ModuleId, EnabledModule, ModuleMetadata } from '../types/modules';

export type FeatureAccessChecker = (
  organizationId: string,
  feature: any
) => Promise<{ allowed: boolean; currentPlan?: string; requiredPlan?: string }>;

export interface ResolveModulesOptions {
  includeLocked?: boolean;
  navigationOnly?: boolean;
}

export interface ResolveModulesResult {
  enabledModules: EnabledModule[];
  lockedModules: EnabledModule[];
}

/**
 * Default module metadata for core modules
 */
const DEFAULT_MODULES: Record<string, ModuleMetadata> = {
  dashboard: {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Main dashboard overview',
    icon: 'LayoutDashboard',
    route: '/dashboard',
    category: 'core',
    isCore: true,
    sortOrder: 0,
    showInNavigation: true,
    posEnabled: true,
  },
  orders: {
    id: 'orders',
    name: 'Orders',
    description: 'Order management',
    icon: 'ShoppingCart',
    route: '/orders',
    category: 'core',
    isCore: true,
    sortOrder: 1,
    showInNavigation: true,
    posEnabled: true,
  },
  menu: {
    id: 'menu',
    name: 'Menu',
    description: 'Menu management',
    icon: 'UtensilsCrossed',
    route: '/menu',
    category: 'core',
    isCore: true,
    sortOrder: 2,
    showInNavigation: true,
    posEnabled: true,
  },
  settings: {
    id: 'settings',
    name: 'Settings',
    description: 'System settings and configuration',
    icon: 'Settings',
    route: '/settings',
    category: 'core',
    isCore: true,
    sortOrder: 999,
    showInNavigation: true,
    posEnabled: true,
  },
};

/**
 * Resolve enabled modules for an organization
 * Returns both enabled and locked modules
 */
export async function resolveEnabledModules(
  organizationId: string,
  businessType: string,
  featureChecker: FeatureAccessChecker,
  options: ResolveModulesOptions = {}
): Promise<ResolveModulesResult> {
  // For POS stub, return default core modules as enabled
  const enabledModules: EnabledModule[] = Object.values(DEFAULT_MODULES).map(metadata => ({
    module: metadata,
    isEnabled: true,
    isLocked: false,
    moduleId: metadata.id,
    moduleName: metadata.name,
    isActive: true,
    isPosEnabled: true,
  }));

  const lockedModules: EnabledModule[] = [];

  return {
    enabledModules,
    lockedModules,
  };
}

/**
 * Get metadata for a specific module
 */
export function getModuleMetadata(moduleId: ModuleId): ModuleMetadata | null {
  if (DEFAULT_MODULES[moduleId]) {
    return DEFAULT_MODULES[moduleId];
  }
  
  // Return generic metadata for unknown modules
  return {
    id: moduleId,
    name: moduleId,
    description: '',
    icon: 'Package',
    category: 'other',
    showInNavigation: true,
    posEnabled: true,
  };
}
