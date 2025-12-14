/**
 * useAcquiredModules Hook
 * 
 * React hook for accessing acquired modules in the POS system.
 * Wraps the ModuleContext with a React Query-like interface for caching
 * and provides module data with appropriate stale time handling.
 * 
 * Requirements: 2.2, 10.5
 * - 2.2: Display Delivery option based on acquired Delivery module
 * - 10.5: Query organization's acquired modules from database
 * 
 * @see .kiro/specs/pos-tables-reservations-sync/design.md - ModuleService interface
 */

import { useMemo, useCallback } from 'react';
import { useModules } from '../contexts/module-context';
import type { AcquiredModule } from '../../../../shared/services/ModuleService';

/**
 * Module IDs for common modules
 */
export const MODULE_IDS = {
  DELIVERY: 'delivery', // Module ID for delivery functionality (enables delivery orders and pricing)
  DELIVERY_ZONES: 'delivery_zones', // Module ID for delivery zone management (optional enhancement)
  TABLES: 'tables',
  RESERVATIONS: 'reservations',
  ROOMS: 'rooms',
  APPOINTMENTS: 'appointments',
  DRIVE_THRU: 'drive_through', // Module ID uses underscore
  POS: 'pos',
  MENU: 'menu',
  ORDERS: 'orders',
  CUSTOMERS: 'customers',
  STAFF: 'staff',
  ANALYTICS: 'analytics',
  INVENTORY: 'inventory',
  LOYALTY: 'loyalty',
  MARKETING: 'marketing',
  RETAIL: 'retail',
  PRODUCT_CATALOG: 'product_catalog', // Module ID for retail product catalog
} as const;

export type ModuleIdType = typeof MODULE_IDS[keyof typeof MODULE_IDS];

/**
 * Return type for useAcquiredModules hook
 */
export interface UseAcquiredModulesReturn {
  /** List of acquired modules for the organization */
  modules: AcquiredModule[];
  /** Whether module data is being loaded */
  isLoading: boolean;
  /** Error message if module fetch failed */
  error: string | null;
  /** Whether a sync operation is in progress */
  isSyncing: boolean;
  /** Check if a specific module is acquired */
  hasModule: (moduleId: string) => boolean;
  /** Check if the Delivery module is acquired */
  hasDeliveryModule: boolean;
  /** Check if the Tables module is acquired */
  hasTablesModule: boolean;
  /** Check if the Rooms module is acquired */
  hasRoomsModule: boolean;
  /** Check if the Appointments module is acquired */
  hasAppointmentsModule: boolean;
  /** Refresh modules from the server */
  refetch: () => Promise<void>;
}

/**
 * Configuration options for useAcquiredModules
 */
export interface UseAcquiredModulesOptions {
  /** 
   * Stale time in milliseconds before data is considered stale
   * Default: 5 minutes (300000ms)
   * Note: The underlying ModuleContext uses a 24-hour cache TTL,
   * but this stale time controls when background refetches are triggered
   */
  staleTime?: number;
  /** Whether to enable automatic refetching on window focus */
  refetchOnWindowFocus?: boolean;
}

/**
 * Default stale time for module data (5 minutes)
 * Module data doesn't change frequently, so a longer stale time is appropriate
 * 
 * Note: This constant is exported for use by consumers who want to configure
 * their own caching behavior or for future React Query integration.
 */
export const DEFAULT_STALE_TIME = 5 * 60 * 1000; // 5 minutes

/**
 * Hook to access acquired modules for the current organization.
 * 
 * This hook wraps the ModuleContext and provides a React Query-like interface
 * with caching and stale time handling. It transforms the internal module
 * representation to the AcquiredModule interface from ModuleService.
 * 
 * @param options - Configuration options
 * @returns Module data and utility functions
 * 
 * @example
 * ```tsx
 * const { modules, hasModule, hasDeliveryModule, isLoading } = useAcquiredModules();
 * 
 * if (isLoading) return <Spinner />;
 * 
 * return (
 *   <div>
 *     {hasDeliveryModule && <DeliveryOption />}
 *     {hasModule('tables') && <TablesOption />}
 *   </div>
 * );
 * ```
 */
export function useAcquiredModules(
  options: UseAcquiredModulesOptions = {}
): UseAcquiredModulesReturn {
  const {
    // staleTime = DEFAULT_STALE_TIME, // Reserved for future React Query integration
    // refetchOnWindowFocus = true, // Reserved for future React Query integration
  } = options;

  // Get module data from the existing ModuleContext
  const {
    enabledModules,
    isLoading,
    error,
    isSyncing,
    refreshModules,
    syncModulesFromAdmin,
    isModuleEnabled,
  } = useModules();

  /**
   * Transform enabled modules to AcquiredModule format
   * This provides compatibility with the ModuleService interface
   */
  const modules = useMemo((): AcquiredModule[] => {
    return enabledModules.map((enabledModule) => ({
      moduleId: enabledModule.module.id,
      moduleName: enabledModule.module.name,
      isActive: enabledModule.isEnabled,
      isPosEnabled: enabledModule.isPosEnabled ?? enabledModule.module.posEnabled ?? true,
      purchasedAt: undefined, // Not available in current context
      expiresAt: null,
    }));
  }, [enabledModules]);

  /**
   * Check if a specific module is acquired
   */
  const hasModule = useCallback(
    (moduleId: string): boolean => {
      return isModuleEnabled(moduleId as any);
    },
    [isModuleEnabled]
  );

  /**
   * Convenience flags for common modules
   */
  const hasDeliveryModule = useMemo(
    () => hasModule(MODULE_IDS.DELIVERY),
    [hasModule]
  );

  const hasTablesModule = useMemo(
    () => hasModule(MODULE_IDS.TABLES),
    [hasModule]
  );

  const hasRoomsModule = useMemo(
    () => hasModule(MODULE_IDS.ROOMS),
    [hasModule]
  );

  const hasAppointmentsModule = useMemo(
    () => hasModule(MODULE_IDS.APPOINTMENTS),
    [hasModule]
  );

  /**
   * Refetch modules from the server
   * Combines both local refresh and admin sync
   */
  const refetch = useCallback(async (): Promise<void> => {
    await refreshModules();
    await syncModulesFromAdmin();
  }, [refreshModules, syncModulesFromAdmin]);

  return {
    modules,
    isLoading,
    error,
    isSyncing,
    hasModule,
    hasDeliveryModule,
    hasTablesModule,
    hasRoomsModule,
    hasAppointmentsModule,
    refetch,
  };
}

export default useAcquiredModules;
