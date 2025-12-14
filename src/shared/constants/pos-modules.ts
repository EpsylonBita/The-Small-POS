/**
 * POS Implemented Modules Registry
 * 
 * This file defines which modules have actual implementations in the POS system.
 * Only modules in these registries should appear in navigation, even if other
 * modules are enabled in the admin dashboard.
 * 
 * @see Requirements 2.1, 2.2, 2.3, 1.4
 */

/**
 * Core modules that are always available regardless of organization settings.
 * These modules are essential for POS operation and should always be displayed.
 * 
 * @see Requirements 2.3, 1.4
 */
export const CORE_MODULES: Set<string> = new Set([
  'dashboard',
  'settings',
]);

/**
 * Modules that have actual implementations in the POS system.
 * Only these modules should appear in navigation, even if other
 * modules are enabled in the admin dashboard.
 */
export const POS_IMPLEMENTED_MODULES: Set<string> = new Set([
  // Core modules (always available)
  'dashboard',
  'settings',

  // Implemented modules
  'menu',
  'users',        // Staff management
  'reports',
  'analytics',    // Business analytics dashboard
  'orders',       // Order management

  // Delivery module (enables delivery orders and pricing)
  'delivery',
  'delivery_zones', // Delivery zone management

  // Marketing & Loyalty
  'coupons',      // Coupon management
  'loyalty',      // Loyalty program

  // Restaurant vertical
  'tables',
  'reservations',

  // Hotel vertical
  'rooms',
  'housekeeping',
  'guest_billing',

  // Salon vertical
  'appointments',
  'staff_schedule',
  'service_catalog',

  // Fast-food vertical
  'drive_through',
  'quick_pos',

  // Retail vertical
  'product_catalog',

  // Operations & Back-office
  'suppliers',      // Supplier management
  'inventory',      // Inventory tracking
  'kitchen_display', // Kitchen Display System (KDS)
]);

/**
 * Modules that are planned but not yet implemented.
 * These will show as "Coming Soon" if enabled in the admin dashboard.
 */
export const POS_COMING_SOON_MODULES: Set<string> = new Set([
  'branches',
  'customer_web',
  'customer_app',
]);

/**
 * Check if a module has an actual implementation in the POS system.
 * 
 * @param moduleId - The module identifier to check
 * @returns true if the module is implemented in the POS system
 */
export function isModuleImplemented(moduleId: string): boolean {
  return POS_IMPLEMENTED_MODULES.has(moduleId);
}

/**
 * Check if a module is planned but not yet implemented.
 * 
 * @param moduleId - The module identifier to check
 * @returns true if the module is coming soon
 */
export function isModuleComingSoon(moduleId: string): boolean {
  return POS_COMING_SOON_MODULES.has(moduleId);
}

/**
 * Check if a module should appear in navigation.
 * A module appears in navigation if it's either implemented or coming soon.
 * 
 * @param moduleId - The module identifier to check
 * @returns true if the module should appear in navigation
 */
export function shouldShowInNavigation(moduleId: string): boolean {
  return isModuleImplemented(moduleId) || isModuleComingSoon(moduleId);
}

/**
 * Check if a module is a core module.
 * Core modules are always available regardless of organization settings.
 * 
 * @param moduleId - The module identifier to check
 * @returns true if the module is a core module
 * @see Requirements 2.3, 1.4
 */
export function isCoreModule(moduleId: string): boolean {
  return CORE_MODULES.has(moduleId);
}

/**
 * Get the list of core module IDs.
 * 
 * @returns Array of core module IDs
 * @see Requirements 2.3, 1.4
 */
export function getCoreModuleIds(): string[] {
  return Array.from(CORE_MODULES);
}

/**
 * Interface for items that can be sorted by sort order.
 * Used by sortBySortOrder function.
 */
export interface SortableItem {
  sortOrder?: number | null;
}

/**
 * Default sort order value for items without a defined sortOrder.
 * Items without sortOrder will be placed at the end of the sorted list.
 * 
 * @see Requirements 2.4
 */
export const DEFAULT_SORT_ORDER = Number.MAX_SAFE_INTEGER;

/**
 * Sort items by their sortOrder property in ascending order.
 * Items without sortOrder (undefined/null) are placed at the end.
 * 
 * This is a pure function that returns a new sorted array without
 * modifying the original.
 * 
 * @param items - Array of items with optional sortOrder property
 * @returns New array sorted by sortOrder ascending
 * @see Requirements 2.4
 */
export function sortBySortOrder<T extends SortableItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const sortOrderA = a.sortOrder ?? DEFAULT_SORT_ORDER;
    const sortOrderB = b.sortOrder ?? DEFAULT_SORT_ORDER;
    return sortOrderA - sortOrderB;
  });
}

/**
 * Get the effective sort order for an item.
 * Returns DEFAULT_SORT_ORDER if sortOrder is undefined or null.
 * 
 * @param sortOrder - The sort order value (may be undefined or null)
 * @returns The effective sort order value
 * @see Requirements 2.4
 */
export function getEffectiveSortOrder(sortOrder: number | null | undefined): number {
  return sortOrder ?? DEFAULT_SORT_ORDER;
}

/**
 * Interface for items that can be identified by module ID.
 * Used by module removal functions.
 */
export interface IdentifiableModule {
  module_id: string;
}

/**
 * Result of computing module changes between previous and current state.
 */
export interface ModuleChangeResult<T> {
  /** Modules that are in current but not in previous (newly added) */
  added: T[];
  /** Modules that are in previous but not in current (removed/deactivated) */
  removed: T[];
  /** Modules that are in both previous and current (unchanged) */
  retained: T[];
}

/**
 * Compute which modules have been added, removed, or retained between
 * a previous state and a current state.
 * 
 * This is used to detect module deactivation - when a module was previously
 * in the navigation but is no longer in the latest API response.
 * 
 * @param previousModules - The previous set of modules
 * @param currentModules - The current set of modules from API
 * @returns Object containing added, removed, and retained modules
 * @see Requirements 3.4
 */
export function computeModuleChanges<T extends IdentifiableModule>(
  previousModules: T[],
  currentModules: T[]
): ModuleChangeResult<T> {
  const previousIds = new Set(previousModules.map(m => m.module_id));
  const currentIds = new Set(currentModules.map(m => m.module_id));
  
  const added: T[] = currentModules.filter(m => !previousIds.has(m.module_id));
  const removed: T[] = previousModules.filter(m => !currentIds.has(m.module_id));
  const retained: T[] = currentModules.filter(m => previousIds.has(m.module_id));
  
  return { added, removed, retained };
}

/**
 * Get the IDs of modules that have been removed (deactivated).
 * 
 * @param previousModuleIds - Set of previous module IDs
 * @param currentModuleIds - Set of current module IDs from API
 * @returns Array of module IDs that were removed
 * @see Requirements 3.4
 */
export function getRemovedModuleIds(
  previousModuleIds: Set<string>,
  currentModuleIds: Set<string>
): string[] {
  const removed: string[] = [];
  for (const id of previousModuleIds) {
    if (!currentModuleIds.has(id)) {
      removed.push(id);
    }
  }
  return removed;
}

/**
 * Filter out modules that are not in the allowed set.
 * Used to remove deactivated modules from navigation.
 * 
 * @param modules - Array of modules to filter
 * @param allowedIds - Set of module IDs that are allowed
 * @returns Filtered array containing only allowed modules
 * @see Requirements 3.4
 */
export function filterToAllowedModules<T extends IdentifiableModule>(
  modules: T[],
  allowedIds: Set<string>
): T[] {
  return modules.filter(m => allowedIds.has(m.module_id));
}
