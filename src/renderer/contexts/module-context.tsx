'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import type { BusinessType } from '../../../../shared/types/organization';
import type {
  ModuleId,
  EnabledModule,
  ModuleMetadata,
  FeatureFlag,
  POSModuleInfo,
  POSModulesEnabledResponse,
} from '../../../../shared/types/modules';
import {
  resolveEnabledModules,
  getModuleMetadata,
  type FeatureAccessChecker,
} from '../../../../shared/services/moduleRegistry';
import {
  FEATURE_PLAN_MAP,
  STARTER_FEATURES,
} from '../../../../shared/types/features';
import {
  POS_IMPLEMENTED_MODULES,
  POS_COMING_SOON_MODULES,
  CORE_MODULES,
  shouldShowInNavigation,
  isCoreModule,
  getCoreModuleIds,
  getRemovedModuleIds,
} from '../../shared/constants/pos-modules';

// =============================================
// TYPES
// =============================================

/**
 * Navigation-ready module entry with precomputed access flags.
 * Used by NavigationSidebar to avoid recomputing access on each render.
 */
export interface NavigationModule {
  module: ModuleMetadata;
  isEnabled: boolean;
  isLocked: boolean;
  requiredPlan?: string;
}

interface ModuleContextType {
  /** Current organization's business type */
  businessType: BusinessType | null;
  /** Current organization ID */
  organizationId: string | null;
  /** Modules user can access */
  enabledModules: EnabledModule[];
  /** Modules requiring upgrade */
  lockedModules: EnabledModule[];
  /** Whether module resolution is in progress */
  isLoading: boolean;
  /** Error message if resolution failed */
  error: string | null;
  /** Force refresh module resolution */
  refreshModules: () => Promise<void>;
  /** Check if specific module is enabled */
  isModuleEnabled: (moduleId: ModuleId) => boolean;
  /** Precomputed navigation-ready modules, filtered by showInNavigation and sorted by sortOrder */
  navigationModules: NavigationModule[];
  /** Sync modules from admin dashboard API */
  syncModulesFromAdmin: () => Promise<void>;
  /** API modules fetched from admin dashboard */
  apiModules: POSModuleInfo[];
  /** Whether sync is in progress */
  isSyncing: boolean;
}

interface ModuleProviderProps {
  children: ReactNode;
}

/**
 * Cache data structure - stores only module IDs to decouple from EnabledModule type evolution.
 * Full EnabledModule objects are reconstructed from MODULE_REGISTRY on cache load.
 */
interface ModuleCacheData {
  enabledModuleIds: ModuleId[];
  lockedModuleIds: ModuleId[];
  /** Required plans for locked modules, keyed by module ID */
  lockedModulePlans: Record<string, string>;
  businessType: BusinessType;
  organizationId: string;
  timestamp: number;
  /** Modules fetched from admin dashboard API (Requirements 5.1, 5.2) */
  apiModules?: POSModuleInfo[];
  /** API response timestamp for sync tracking */
  apiTimestamp?: string;
}

// =============================================
// CONSTANTS
// =============================================

const CACHE_KEY = 'pos-modules-cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Default core module metadata for fallback scenarios.
 * Used when API returns empty or no core modules.
 * 
 * @see Requirements 2.3, 1.4
 */
const DEFAULT_CORE_MODULE_METADATA: Record<string, ModuleMetadata> = {
  dashboard: {
    id: 'dashboard' as ModuleId,
    name: 'Dashboard',
    description: 'Main dashboard overview',
    icon: 'LayoutDashboard',
    route: '/dashboard',
    category: 'core',
    requiredFeatures: [],
    compatibleBusinessTypes: [],
    isCore: true,
    sortOrder: 0,
    showInNavigation: true,
    posEnabled: true,
  },
  settings: {
    id: 'settings' as ModuleId,
    name: 'Settings',
    description: 'System settings and configuration',
    icon: 'Settings',
    route: '/settings',
    category: 'core',
    requiredFeatures: [],
    compatibleBusinessTypes: [],
    isCore: true,
    sortOrder: 999,
    showInNavigation: true,
    posEnabled: true,
  },
};

/**
 * Ensure core modules are always present in the enabled modules list.
 * If a core module is missing, it will be added with default metadata.
 * 
 * @param modules - Current enabled modules
 * @returns Enabled modules with core modules guaranteed
 * @see Requirements 2.3, 1.4
 */
function ensureCoreModulesPresent(modules: EnabledModule[]): EnabledModule[] {
  const moduleIds = new Set<string>(modules.map(m => m.module.id));
  const result = [...modules];
  
  for (const coreModuleId of getCoreModuleIds()) {
    if (!moduleIds.has(coreModuleId)) {
      // Core module is missing - add it with default or registry metadata
      const metadata = getModuleMetadata(coreModuleId as ModuleId) || 
                       DEFAULT_CORE_MODULE_METADATA[coreModuleId];
      
      if (metadata) {
        result.push({
          module: metadata,
          isEnabled: true,
          isLocked: false,
        });
        console.log(`[ModuleContext] Added missing core module: ${coreModuleId}`);
      }
    }
  }
  
  return result;
}

// =============================================
// CONTEXT
// =============================================

const ModuleContext = createContext<ModuleContextType | undefined>(undefined);

// =============================================
// SIMPLIFIED FEATURE CHECKER
// =============================================

/**
 * Simplified feature checker for POS.
 * Since POS doesn't have the admin-dashboard's feature-gates middleware,
 * we use a simplified approach based on the FEATURE_PLAN_MAP configuration.
 *
 * For POS terminals, we assume Starter plan by default. Features requiring
 * Professional or Enterprise plans will be marked as locked, allowing the
 * UI to show upgrade prompts appropriately.
 *
 * In the future, this can be enhanced to fetch the actual organization's
 * subscription plan from the main process or Supabase.
 */
const createSimplifiedFeatureChecker = (): FeatureAccessChecker => {
  return async (
    _organizationId: string,
    feature: FeatureFlag
  ): Promise<{ allowed: boolean; currentPlan?: string; requiredPlan?: string }> => {
    const currentPlan = 'Starter';

    // Check if this feature is available on Starter plan
    const isStarterFeature = STARTER_FEATURES.includes(feature);

    if (isStarterFeature) {
      return { allowed: true, currentPlan };
    }

    // Feature requires a higher plan - get the required plan from the map
    const requiredPlan = FEATURE_PLAN_MAP[feature] || 'Professional';

    return {
      allowed: false,
      currentPlan,
      requiredPlan,
    };
  };
};

// =============================================
// PROVIDER COMPONENT
// =============================================

export const ModuleProvider: React.FC<ModuleProviderProps> = ({ children }) => {
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [enabledModules, setEnabledModules] = useState<EnabledModule[]>([]);
  const [lockedModules, setLockedModules] = useState<EnabledModule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiModules, setApiModules] = useState<POSModuleInfo[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Ref to track sync in progress (doesn't cause re-renders)
  const isSyncingRef = useRef(false);
  // Ref to store previous apiModules for comparison without causing re-renders
  const prevApiModulesRef = useRef<POSModuleInfo[]>([]);

  /**
   * Reconstruct EnabledModule array from cached module IDs.
   * Looks up each ID in MODULE_REGISTRY and drops unknown IDs.
   */
  const reconstructModulesFromIds = useCallback(
    (
      moduleIds: ModuleId[],
      lockedPlans: Record<string, string>
    ): { enabled: EnabledModule[]; locked: EnabledModule[] } => {
      const enabled: EnabledModule[] = [];
      const locked: EnabledModule[] = [];

      for (const id of moduleIds) {
        const metadata = getModuleMetadata(id);
        if (metadata) {
          const requiredPlan = lockedPlans[id];
          if (requiredPlan) {
            locked.push({
              module: metadata,
              isEnabled: false,
              isLocked: true,
              requiredPlan,
            });
          } else {
            enabled.push({
              module: metadata,
              isEnabled: true,
              isLocked: false,
            });
          }
        } else {
          console.warn('[ModuleContext] Unknown module ID in cache, dropping:', id);
        }
      }

      return { enabled, locked };
    },
    []
  );

  /**
   * Save modules to localStorage cache.
   * Stores only module IDs to decouple from EnabledModule type evolution.
   * Also stores apiModules if provided.
   * 
   * Requirements: 5.1, 5.2
   */
  const saveToCache = useCallback(
    (
      modules: EnabledModule[],
      locked: EnabledModule[],
      bType: BusinessType,
      orgId: string,
      apiMods?: POSModuleInfo[],
      apiTs?: string
    ) => {
      try {
        // Extract only module IDs for storage
        const enabledModuleIds = modules.map((m) => m.module.id);
        const lockedModuleIds = locked.map((m) => m.module.id);

        // Store required plans for locked modules
        const lockedModulePlans: Record<string, string> = {};
        for (const m of locked) {
          if (m.requiredPlan) {
            lockedModulePlans[m.module.id] = m.requiredPlan;
          }
        }

        const cacheData: ModuleCacheData = {
          enabledModuleIds,
          lockedModuleIds,
          lockedModulePlans,
          businessType: bType,
          organizationId: orgId,
          timestamp: Date.now(),
          apiModules: apiMods,
          apiTimestamp: apiTs,
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
      } catch (err) {
        console.warn('[ModuleContext] Failed to save cache:', err);
      }
    },
    []
  );

  /**
   * Transform POSModuleInfo[] from API to EnabledModule[] format.
   * Filters modules using POS_IMPLEMENTED_MODULES registry.
   * 
   * Requirements: 1.1, 1.2, 2.1
   */
  const transformApiModules = useCallback(
    (modules: POSModuleInfo[]): EnabledModule[] => {
      return modules
        // Filter to only POS-enabled modules (Requirement 2.1)
        .filter((m) => m.pos_enabled)
        // Filter to only modules implemented in POS or coming soon (Requirement 2.1)
        .filter((m) => shouldShowInNavigation(m.module_id))
        .map((apiModule): EnabledModule => {
          // Try to get metadata from registry first
          const registryMetadata = getModuleMetadata(apiModule.module_id as ModuleId);
          
          // Build module metadata from API data or registry
          // Map API category to ModuleMetadata category
          const apiCategory = apiModule.category as string;
          const mappedCategory = apiCategory === 'core' ? 'core' as const : 
                                 apiCategory === 'vertical' ? 'vertical' as const : 'addon' as const;
          
          const moduleMetadata: ModuleMetadata = registryMetadata || {
            id: apiModule.module_id as ModuleId,
            name: apiModule.display_name,
            description: apiModule.description || '',
            icon: apiModule.icon,
            route: apiModule.route,
            category: mappedCategory,
            requiredFeatures: [],
            compatibleBusinessTypes: apiModule.compatible_business_types as BusinessType[],
            isCore: apiModule.is_core,
            sortOrder: apiModule.sort_order,
            showInNavigation: apiModule.show_in_navigation,
            posEnabled: apiModule.pos_enabled,
          };

          return {
            module: moduleMetadata,
            isEnabled: true,
            isLocked: false,
            isPurchased: apiModule.is_purchased,
            isPosEnabled: apiModule.pos_enabled,
          };
        });
    },
    []
  );

  /**
   * Sync modules from admin dashboard API via IPC.
   * Handles module removal on deactivation by comparing previous and current state.
   * 
   * Requirements: 1.1, 1.2, 2.1, 3.4
   */
  const syncModulesFromAdmin = useCallback(async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) {
      console.warn('[ModuleContext] IPC not available, skipping admin sync');
      return;
    }

    // Prevent concurrent syncs - if already syncing, skip (use ref to avoid re-renders)
    if (isSyncingRef.current) {
      console.log('[ModuleContext] Sync already in progress, skipping');
      return;
    }

    isSyncingRef.current = true;
    setIsSyncing(true);

    try {
      // Fetch modules from admin dashboard via IPC
      const result = await window.electron.ipcRenderer.invoke('modules:fetch-from-admin');

      if (result.success && result.modules) {
        const response = result.modules as POSModulesEnabledResponse;
        
        // Get previous module IDs for comparison using ref (Requirement 3.4)
        const previousModuleIds = new Set(prevApiModulesRef.current.map(m => m.module_id));
        const currentModuleIds = new Set(response.modules.map(m => m.module_id));
        
        // Detect removed modules (Requirement 3.4)
        const removedModuleIds = getRemovedModuleIds(previousModuleIds, currentModuleIds);
        if (removedModuleIds.length > 0) {
          console.log('[ModuleContext] Modules removed/deactivated:', removedModuleIds);
        }
        
        // Update ref for next comparison
        prevApiModulesRef.current = response.modules;
        
        // Store raw API modules
        setApiModules(response.modules);

        // Transform to EnabledModule format with POS filtering
        const transformed = transformApiModules(response.modules);
        
        // Update enabled modules with API data
        // This automatically removes modules not in the latest API response (Requirement 3.4)
        setEnabledModules(transformed);
        
        // Clear locked modules when using API data (API already filters)
        setLockedModules([]);

        // Save to cache for future cache-first loading (Requirement 5.2)
        if (businessType && organizationId) {
          saveToCache(
            transformed,
            [],
            businessType,
            organizationId,
            response.modules,
            response.timestamp
          );
        }

        console.log('[ModuleContext] Synced modules from admin:', {
          total: response.modules.length,
          posEnabled: transformed.length,
          removed: removedModuleIds.length,
          fromCache: result.fromCache,
        });
      } else {
        console.warn('[ModuleContext] Failed to sync from admin:', result.error);
        // Don't clear existing modules on failure - keep cached data
      }
    } catch (err) {
      console.error('[ModuleContext] Error syncing from admin:', err);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
    // Note: Using refs for apiModules comparison and sync guard to prevent infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformApiModules, businessType, organizationId, saveToCache]);

  /**
   * Load cached modules from localStorage.
   * Reconstructs EnabledModule objects from stored IDs using MODULE_REGISTRY.
   * Also loads apiModules if available in cache.
   * 
   * Requirements: 5.1, 5.2
   */
  const loadFromCache = useCallback((): {
    enabledModules: EnabledModule[];
    lockedModules: EnabledModule[];
    businessType: BusinessType;
    organizationId: string;
    apiModules?: POSModuleInfo[];
  } | null => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;

      const data: ModuleCacheData = JSON.parse(cached);

      // Check if cache is still valid (Requirement 5.1 - 24 hour TTL)
      if (Date.now() - data.timestamp > CACHE_TTL_MS) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }

      // If we have API modules in cache, use them directly
      if (data.apiModules && data.apiModules.length > 0) {
        const transformed = transformApiModules(data.apiModules);
        return {
          enabledModules: transformed,
          lockedModules: [],
          businessType: data.businessType,
          organizationId: data.organizationId,
          apiModules: data.apiModules,
        };
      }

      // Fallback: Reconstruct EnabledModule arrays from IDs
      const allIds = [...data.enabledModuleIds, ...data.lockedModuleIds];
      const { enabled, locked } = reconstructModulesFromIds(
        allIds as ModuleId[],
        data.lockedModulePlans || {}
      );

      // Filter enabled vs locked based on original arrays
      const enabledSet = new Set(data.enabledModuleIds);

      const enabledModules = enabled.filter((m) => enabledSet.has(m.module.id));
      const lockedModules: EnabledModule[] = [];

      // Rebuild locked modules with their required plans
      for (const id of data.lockedModuleIds) {
        const metadata = getModuleMetadata(id as ModuleId);
        if (metadata) {
          lockedModules.push({
            module: metadata,
            isEnabled: false,
            isLocked: true,
            requiredPlan: data.lockedModulePlans[id],
          });
        }
      }

      return {
        enabledModules,
        lockedModules,
        businessType: data.businessType,
        organizationId: data.organizationId,
      };
    } catch {
      return null;
    }
  }, [reconstructModulesFromIds, transformApiModules]);

  // Known valid business types for runtime validation
  // Must match BusinessType from shared/types/organization.ts
  const VALID_BUSINESS_TYPES: BusinessType[] = [
    'fast_food',
    'restaurant',
    'hotel',
    'salon',
    'bar_cafe',
    'food_truck',
    'chain',
    'franchise',
    'retail',
  ];

  /**
   * Validate that a value is a known business type
   */
  const isValidBusinessType = (value: unknown): value is BusinessType => {
    return typeof value === 'string' && VALID_BUSINESS_TYPES.includes(value as BusinessType);
  };

  /**
   * Resolve modules from main process
   */
  const resolveModules = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Fetch organization ID from main process
      const orgId = await window.electron?.ipcRenderer.invoke(
        'terminal-config:get-organization-id'
      );

      // Fetch business type from main process
      const bType = await window.electron?.ipcRenderer.invoke(
        'terminal-config:get-business-type'
      );

      // Handle missing organization ID
      if (!orgId) {
        console.log('[ModuleContext] Organization ID not available, using cached modules');
        
        const cached = loadFromCache();
        if (cached) {
          setBusinessType(cached.businessType);
          setOrganizationId(cached.organizationId);
          setEnabledModules(cached.enabledModules);
          setLockedModules(cached.lockedModules);
          console.log('[ModuleContext] Loaded cached modules (missing org ID)');
        }
        
        setError('Organization ID not available');
        setIsLoading(false);
        return;
      }

      // Handle missing business type (org exists but no business type)
      if (!bType) {
        console.warn('[ModuleContext] Business type not available for organization:', orgId);
        
        const cached = loadFromCache();
        if (cached) {
          setBusinessType(cached.businessType);
          setOrganizationId(cached.organizationId);
          setEnabledModules(cached.enabledModules);
          setLockedModules(cached.lockedModules);
          console.log('[ModuleContext] Using cached modules (missing business type)');
        }
        
        setOrganizationId(orgId);
        setError('Business type not available');
        setIsLoading(false);
        return;
      }

      // Validate business type before using it
      if (!isValidBusinessType(bType)) {
        console.error('[ModuleContext] Invalid business type received:', bType);
        
        const cached = loadFromCache();
        if (cached) {
          setBusinessType(cached.businessType);
          setOrganizationId(cached.organizationId);
          setEnabledModules(cached.enabledModules);
          setLockedModules(cached.lockedModules);
        }
        
        setOrganizationId(orgId);
        setError(`Invalid business type: ${bType}`);
        setIsLoading(false);
        return;
      }

      setOrganizationId(orgId);
      setBusinessType(bType);

      // Resolve modules using the simplified feature checker
      const featureChecker = createSimplifiedFeatureChecker();
      const result = await resolveEnabledModules(
        orgId,
        bType,
        featureChecker,
        { includeLocked: true, navigationOnly: false }
      );

      setEnabledModules(result.enabledModules);
      setLockedModules(result.lockedModules);

      // Cache the result (bType is validated at this point)
      saveToCache(
        result.enabledModules,
        result.lockedModules,
        bType,
        orgId
      );

      console.log('[ModuleContext] Modules resolved:', {
        enabled: result.enabledModules.length,
        locked: result.lockedModules.length,
        businessType: bType,
      });
    } catch (err) {
      console.error('[ModuleContext] Failed to resolve modules:', err);

      // Fall back to cached data on error
      const cached = loadFromCache();
      if (cached) {
        setBusinessType(cached.businessType);
        setOrganizationId(cached.organizationId);
        setEnabledModules(cached.enabledModules);
        setLockedModules(cached.lockedModules);
        console.log('[ModuleContext] Using cached modules due to error');
      } else {
        setError('Failed to resolve modules');
      }
    } finally {
      setIsLoading(false);
    }
  }, [loadFromCache, saveToCache]);

  /**
   * Force refresh modules
   */
  const refreshModules = useCallback(async () => {
    // Clear cache before refreshing
    localStorage.removeItem(CACHE_KEY);
    await resolveModules();
  }, [resolveModules]);

  /**
   * Check if a specific module is enabled
   */
  const isModuleEnabled = useCallback(
    (moduleId: ModuleId): boolean => {
      return enabledModules.some((m) => m.module.id === moduleId);
    },
    [enabledModules]
  );

  /**
   * Initialize on mount with cache-first loading strategy.
   * 
   * Cache-First Loading Flow (Requirements 5.2, 5.3):
   * 1. Immediately load cached modules for instant UI (synchronous)
   * 2. Set isLoading to false if cache is valid (UI is ready)
   * 3. Trigger background API fetch without blocking UI
   * 4. Update state when API response arrives (reactive update)
   * 
   * This ensures the UI is responsive immediately while fresh data
   * is fetched in the background.
   */
  useEffect(() => {
    let isMounted = true;
    
    // Step 1: Load cached modules immediately for instant UI (Requirement 5.2)
    const cached = loadFromCache();
    const hasCachedData = cached !== null;
    
    if (hasCachedData) {
      setBusinessType(cached.businessType);
      setOrganizationId(cached.organizationId);
      setEnabledModules(cached.enabledModules);
      setLockedModules(cached.lockedModules);
      if (cached.apiModules) {
        setApiModules(cached.apiModules);
      }
      // Step 2: If we have valid cache, UI is ready - set loading to false
      setIsLoading(false);
      console.log('[ModuleContext] Cache-first: Loaded cached modules immediately');
    }

    // Step 3: Trigger background API fetch without blocking UI (Requirement 5.3)
    const fetchInBackground = async () => {
      try {
        // If no cache, we need to wait for resolution (show loading state)
        if (!hasCachedData) {
          await resolveModules();
        } else {
          // With cache, resolve in background without blocking
          resolveModules().catch((err) => {
            console.warn('[ModuleContext] Background resolve failed:', err);
          });
        }
        
        // Step 4: Sync from admin in background - updates state reactively
        if (isMounted) {
          syncModulesFromAdmin().catch((err) => {
            console.warn('[ModuleContext] Background admin sync failed:', err);
          });
        }
      } catch (err) {
        console.error('[ModuleContext] Background fetch error:', err);
      }
    };

    fetchInBackground();

    return () => {
      isMounted = false;
    };
    // Note: syncModulesFromAdmin excluded from deps - only want to run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadFromCache, resolveModules]);

  // Listen for terminal settings updates (Requirement 3.3)
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleSettingsUpdate = () => {
      console.log('[ModuleContext] Terminal settings updated, refreshing modules');
      refreshModules();
      syncModulesFromAdmin();
    };

    window.electron.ipcRenderer.on('terminal-settings-updated', handleSettingsUpdate);

    return () => {
      window.electron?.ipcRenderer.removeListener(
        'terminal-settings-updated',
        handleSettingsUpdate
      );
    };
  }, [refreshModules, syncModulesFromAdmin]);

  // Listen for module refresh events from AdminDashboardSyncService (Requirement 3.1, 3.2)
  // This event is emitted after settings sync to coordinate module updates
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleModuleRefresh = (data: { reason: string; timestamp: string }) => {
      console.log('[ModuleContext] Module refresh requested:', data.reason);
      // Only sync modules, don't do a full refresh to avoid redundant work
      syncModulesFromAdmin();
    };

    window.electron.ipcRenderer.on('modules:refresh-needed', handleModuleRefresh);

    return () => {
      window.electron?.ipcRenderer.removeListener(
        'modules:refresh-needed',
        handleModuleRefresh
      );
    };
  }, [syncModulesFromAdmin]);

  /**
   * Precomputed navigation-ready modules.
   * Combines enabled and locked modules, filters by showInNavigation,
   * sorts by sortOrder ascending (modules without sortOrder default to end),
   * and includes access flags.
   * Core modules (dashboard, settings) are always included regardless of API response.
   * This eliminates the need for NavigationSidebar to recompute on each render.
   * 
   * @see Requirements 2.3, 1.4, 2.4
   */
  const navigationModules = useMemo((): NavigationModule[] => {
    // Ensure core modules are always present (Requirement 2.3, 1.4)
    const modulesWithCore = ensureCoreModulesPresent(enabledModules);
    
    // Create a map of enabled module IDs for quick lookup
    const enabledIds = new Set(modulesWithCore.map((m) => m.module.id));
    
    // Create a map of locked modules with their required plans
    const lockedMap = new Map<string, string>();
    for (const m of lockedModules) {
      if (m.requiredPlan) {
        lockedMap.set(m.module.id, m.requiredPlan);
      }
    }

    // Combine all modules (enabled + locked) that should show in navigation
    const allNavModules: NavigationModule[] = [];

    // Add enabled modules (including guaranteed core modules)
    for (const m of modulesWithCore) {
      if (m.module.showInNavigation) {
        allNavModules.push({
          module: m.module,
          isEnabled: true,
          isLocked: false,
        });
      }
    }

    // Add locked modules (not already in enabled)
    for (const m of lockedModules) {
      if (m.module.showInNavigation && !enabledIds.has(m.module.id)) {
        allNavModules.push({
          module: m.module,
          isEnabled: false,
          isLocked: true,
          requiredPlan: m.requiredPlan,
        });
      }
    }

    // Sort by sortOrder ascending (Requirement 2.4)
    // Modules without sortOrder (undefined/null) default to end (Number.MAX_SAFE_INTEGER)
    return allNavModules.sort((a, b) => {
      const sortOrderA = a.module.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const sortOrderB = b.module.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return sortOrderA - sortOrderB;
    });
  }, [enabledModules, lockedModules]);

  const value: ModuleContextType = {
    businessType,
    organizationId,
    enabledModules,
    lockedModules,
    isLoading,
    error,
    refreshModules,
    isModuleEnabled,
    navigationModules,
    syncModulesFromAdmin,
    apiModules,
    isSyncing,
  };

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
};

// =============================================
// HOOKS
// =============================================

/**
 * Hook to access the full module context
 */
export const useModules = (): ModuleContextType => {
  const context = useContext(ModuleContext);
  if (context === undefined) {
    throw new Error('useModules must be used within a ModuleProvider');
  }
  return context;
};

// =============================================
// STATIC UTILITIES
// =============================================

/**
 * Module access result type
 */
export interface ModuleAccessResult {
  isEnabled: boolean;
  isLocked: boolean;
  module: ModuleMetadata | undefined;
  requiredPlan: string | undefined;
}

/**
 * Static utility to check module access without using hooks.
 * Use this in loops, callbacks, or other places where hooks cannot be called.
 * For component-level access checks, prefer useModuleAccess hook.
 */
export const getModuleAccessStatic = (
  enabledModules: EnabledModule[],
  lockedModules: EnabledModule[],
  moduleId: string
): ModuleAccessResult => {
  const enabledModule = enabledModules.find((m) => m.module.id === moduleId);
  const lockedModule = lockedModules.find((m) => m.module.id === moduleId);

  if (enabledModule) {
    return {
      isEnabled: true,
      isLocked: false,
      module: enabledModule.module,
      requiredPlan: undefined,
    };
  }

  if (lockedModule) {
    return {
      isEnabled: false,
      isLocked: true,
      module: lockedModule.module,
      requiredPlan: lockedModule.requiredPlan,
    };
  }

  // Module not found in either list - get metadata directly
  const metadata = getModuleMetadata(moduleId as ModuleId);
  return {
    isEnabled: false,
    isLocked: false,
    module: metadata || undefined,
    requiredPlan: undefined,
  };
};

/**
 * Hook to check access for a specific module.
 * Internally uses getModuleAccessStatic for centralized logic.
 */
export const useModuleAccess = (moduleId: ModuleId): ModuleAccessResult => {
  const { enabledModules, lockedModules } = useModules();
  return getModuleAccessStatic(enabledModules, lockedModules, moduleId);
};
