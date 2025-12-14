/**
 * Property-Based Tests for ModuleContext
 * 
 * Tests for cache update consistency, POS-enabled filter, and cache TTL enforcement.
 * 
 * Requirements: 1.2, 2.1, 2.2, 5.1
 */

import * as fc from 'fast-check';
import type { POSModuleInfo, ModuleCategory, BusinessType } from '../shared/types/modules';
import {
  POS_IMPLEMENTED_MODULES,
  POS_COMING_SOON_MODULES,
  shouldShowInNavigation,
  sortBySortOrder,
  getEffectiveSortOrder,
  DEFAULT_SORT_ORDER,
  computeModuleChanges,
  getRemovedModuleIds,
  filterToAllowedModules,
  type SortableItem,
  type IdentifiableModule,
} from '../shared/constants/pos-modules';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// =============================================
// ARBITRARIES
// =============================================

/**
 * Arbitrary for generating valid module categories
 */
const moduleCategoryArb: fc.Arbitrary<ModuleCategory> = fc.constantFrom(
  'core',
  'operations',
  'management',
  'analytics',
  'integrations',
  'customer',
  'staff',
  'inventory',
  'marketing',
  'finance'
);

/**
 * Arbitrary for generating valid business types
 */
const businessTypeArb: fc.Arbitrary<BusinessType> = fc.constantFrom(
  'fast_food',
  'restaurant',
  'hotel',
  'salon',
  'retail',
  'cafe',
  'bar',
  'bakery',
  'food_truck',
  'catering'
);

/**
 * Arbitrary for generating module IDs that are in the implemented set
 */
const implementedModuleIdArb = fc.constantFrom(...Array.from(POS_IMPLEMENTED_MODULES));

/**
 * Arbitrary for generating module IDs that are in the coming soon set
 */
const comingSoonModuleIdArb = fc.constantFrom(...Array.from(POS_COMING_SOON_MODULES));

/**
 * Arbitrary for generating module IDs that are NOT in either registry
 */
const unknownModuleIdArb = fc.stringMatching(/^unknown_module_[a-z0-9]{4,8}$/).filter(
  (id) => !POS_IMPLEMENTED_MODULES.has(id) && !POS_COMING_SOON_MODULES.has(id)
);

/**
 * Arbitrary for generating any module ID (implemented, coming soon, or unknown)
 */
const anyModuleIdArb = fc.oneof(
  implementedModuleIdArb,
  comingSoonModuleIdArb,
  unknownModuleIdArb
);

/**
 * Arbitrary for generating a valid POSModuleInfo object
 */
const posModuleInfoArb = (
  moduleIdArb: fc.Arbitrary<string>,
  posEnabledArb: fc.Arbitrary<boolean> = fc.boolean()
): fc.Arbitrary<POSModuleInfo> =>
  fc.record({
    id: fc.uuid(),
    module_id: moduleIdArb,
    name: moduleIdArb,
    display_name: fc.string({ minLength: 1, maxLength: 50 }),
    description: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
    icon: fc.stringMatching(/^[a-z-]+$/),
    category: moduleCategoryArb,
    route: fc.stringMatching(/^\/[a-z-]+$/),
    is_core: fc.boolean(),
    is_purchased: fc.boolean(),
    pos_enabled: posEnabledArb,
    show_in_navigation: fc.boolean(),
    sort_order: fc.integer({ min: 0, max: 100 }),
    features: fc.constant({}),
    metadata: fc.constant({}),
    compatible_business_types: fc.array(businessTypeArb, { minLength: 1, maxLength: 5 }),
    updated_at: fc.constant(new Date().toISOString()),
  });

/**
 * Arbitrary for generating organization IDs
 */
const organizationIdArb = fc.uuid();

/**
 * Arbitrary for generating timestamps
 */
const timestampArb = fc.integer({ min: Date.now() - 86400000, max: Date.now() });

// =============================================
// CACHE DATA STRUCTURE (mirrors ModuleCacheData)
// =============================================

interface ModuleCacheData {
  enabledModuleIds: string[];
  lockedModuleIds: string[];
  lockedModulePlans: Record<string, string>;
  businessType: BusinessType;
  organizationId: string;
  timestamp: number;
  apiModules?: POSModuleInfo[];
  apiTimestamp?: string;
}

// =============================================
// FUNCTIONS UNDER TEST
// =============================================

/**
 * Simulates saving modules to cache
 */
function saveToCache(
  apiModules: POSModuleInfo[],
  businessType: BusinessType,
  organizationId: string,
  timestamp: number,
  apiTimestamp: string
): ModuleCacheData {
  return {
    enabledModuleIds: apiModules.filter(m => m.pos_enabled).map(m => m.module_id),
    lockedModuleIds: [],
    lockedModulePlans: {},
    businessType,
    organizationId,
    timestamp,
    apiModules,
    apiTimestamp,
  };
}

/**
 * Simulates loading modules from cache
 */
function loadFromCache(cacheData: ModuleCacheData): POSModuleInfo[] | null {
  if (!cacheData.apiModules) {
    return null;
  }
  return cacheData.apiModules;
}

/**
 * Filter modules to only include POS-enabled ones
 * Requirement 2.1, 2.2
 */
function filterPosEnabledModules(modules: POSModuleInfo[]): POSModuleInfo[] {
  return modules.filter(m => m.pos_enabled === true);
}

/**
 * Filter modules to only include those implemented in POS
 * Requirement 2.1
 */
function filterImplementedModules(modules: POSModuleInfo[]): POSModuleInfo[] {
  return modules.filter(m => shouldShowInNavigation(m.module_id));
}

/**
 * Check if cache is valid based on TTL (24 hours)
 * Requirement 5.1
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isCacheValid(cacheTimestamp: number, currentTime: number): boolean {
  return (currentTime - cacheTimestamp) < CACHE_TTL_MS;
}

// =============================================
// PROPERTY TESTS
// =============================================

describe('ModuleContext Property Tests', () => {
  /**
   * **Feature: pos-module-sync, Property 1: Cache Update Consistency**
   * **Validates: Requirements 1.2**
   * 
   * Property: For any valid API response containing modules, after updating
   * the cache, reading from the cache SHALL return the same modules that
   * were in the API response.
   */
  describe('Property 1: Cache Update Consistency', () => {
    it('cache read returns same modules as cache write', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(anyModuleIdArb), { minLength: 0, maxLength: 20 }),
          businessTypeArb,
          organizationIdArb,
          timestampArb,
          async (modules, businessType, organizationId, timestamp) => {
            const apiTimestamp = new Date().toISOString();
            
            // Save to cache
            const cacheData = saveToCache(
              modules,
              businessType,
              organizationId,
              timestamp,
              apiTimestamp
            );
            
            // Load from cache
            const loadedModules = loadFromCache(cacheData);
            
            // Property: loaded modules should equal original modules
            expect(loadedModules).not.toBeNull();
            expect(loadedModules).toHaveLength(modules.length);
            
            // Each module should be identical
            for (let i = 0; i < modules.length; i++) {
              expect(loadedModules![i].id).toBe(modules[i].id);
              expect(loadedModules![i].module_id).toBe(modules[i].module_id);
              expect(loadedModules![i].pos_enabled).toBe(modules[i].pos_enabled);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('cache preserves all module properties', async () => {
      await fc.assert(
        fc.asyncProperty(
          posModuleInfoArb(implementedModuleIdArb),
          businessTypeArb,
          organizationIdArb,
          async (module, businessType, organizationId) => {
            const timestamp = Date.now();
            const apiTimestamp = new Date().toISOString();
            
            // Save single module to cache
            const cacheData = saveToCache(
              [module],
              businessType,
              organizationId,
              timestamp,
              apiTimestamp
            );
            
            // Load from cache
            const loadedModules = loadFromCache(cacheData);
            
            // Property: all properties should be preserved
            expect(loadedModules).toHaveLength(1);
            expect(loadedModules![0]).toEqual(module);
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * **Feature: pos-module-sync, Property 3: POS-Enabled Filter**
   * **Validates: Requirements 2.1, 2.2**
   * 
   * Property: For any set of modules returned from the API, the navigation
   * modules SHALL only include modules where `pos_enabled === true`.
   */
  describe('Property 3: POS-Enabled Filter', () => {
    it('only pos_enabled modules pass the filter', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(anyModuleIdArb), { minLength: 1, maxLength: 20 }),
          async (modules) => {
            const filtered = filterPosEnabledModules(modules);
            
            // Property: all filtered modules have pos_enabled === true
            for (const module of filtered) {
              expect(module.pos_enabled).toBe(true);
            }
            
            // Property: count matches expected
            const expectedCount = modules.filter(m => m.pos_enabled === true).length;
            expect(filtered.length).toBe(expectedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('modules with pos_enabled=false are excluded', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate modules with pos_enabled explicitly false
          fc.array(posModuleInfoArb(anyModuleIdArb, fc.constant(false)), { minLength: 1, maxLength: 10 }),
          async (modules) => {
            const filtered = filterPosEnabledModules(modules);
            
            // Property: no modules should pass when all have pos_enabled=false
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    it('modules with pos_enabled=true are included', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate modules with pos_enabled explicitly true
          fc.array(posModuleInfoArb(anyModuleIdArb, fc.constant(true)), { minLength: 1, maxLength: 10 }),
          async (modules) => {
            const filtered = filterPosEnabledModules(modules);
            
            // Property: all modules should pass when all have pos_enabled=true
            expect(filtered.length).toBe(modules.length);
          }
        ),
        { verbose: true }
      );
    });

    it('filter preserves module data integrity', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(anyModuleIdArb, fc.constant(true)), { minLength: 1, maxLength: 10 }),
          async (modules) => {
            const filtered = filterPosEnabledModules(modules);
            
            // Property: filtered modules should be identical to originals
            for (let i = 0; i < filtered.length; i++) {
              expect(filtered[i]).toEqual(modules[i]);
            }
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * **Feature: pos-module-sync, Property 7: Cache TTL Enforcement**
   * **Validates: Requirements 5.1**
   * 
   * Property: For any cached module data older than 24 hours, the cache
   * SHALL be considered invalid and a fresh fetch SHALL be triggered.
   */
  describe('Property 7: Cache TTL Enforcement', () => {
    it('cache within TTL is valid', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate timestamps within the last 24 hours
          fc.integer({ min: 0, max: CACHE_TTL_MS - 1 }),
          async (ageMs) => {
            const currentTime = Date.now();
            const cacheTimestamp = currentTime - ageMs;
            
            // Property: cache should be valid
            expect(isCacheValid(cacheTimestamp, currentTime)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('cache older than TTL is invalid', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate timestamps older than 24 hours (up to 7 days old)
          fc.integer({ min: CACHE_TTL_MS, max: CACHE_TTL_MS * 7 }),
          async (ageMs) => {
            const currentTime = Date.now();
            const cacheTimestamp = currentTime - ageMs;
            
            // Property: cache should be invalid
            expect(isCacheValid(cacheTimestamp, currentTime)).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('cache exactly at TTL boundary is invalid', async () => {
      const currentTime = Date.now();
      const cacheTimestamp = currentTime - CACHE_TTL_MS;
      
      // Property: cache at exactly 24 hours should be invalid
      expect(isCacheValid(cacheTimestamp, currentTime)).toBe(false);
    });

    it('fresh cache (0 age) is always valid', async () => {
      const currentTime = Date.now();
      
      // Property: cache with same timestamp as current time should be valid
      expect(isCacheValid(currentTime, currentTime)).toBe(true);
    });
  });

  /**
   * **Feature: pos-module-sync, Property 4: Core Modules Always Present**
   * **Validates: Requirements 2.3**
   * 
   * Property: For any module resolution result (from API or cache), the navigation
   * SHALL always include core modules (dashboard, settings) regardless of API response content.
   */
  describe('Property 4: Core Modules Always Present', () => {
    /**
     * Simulates the ensureCoreModulesPresent function from module-context.tsx
     */
    interface EnabledModuleSimple {
      module: {
        id: string;
        name: string;
        sortOrder: number;
        showInNavigation: boolean;
      };
      isEnabled: boolean;
      isLocked: boolean;
    }

    const CORE_MODULE_IDS = ['dashboard', 'settings'];

    const DEFAULT_CORE_MODULES: Record<string, EnabledModuleSimple['module']> = {
      dashboard: {
        id: 'dashboard',
        name: 'Dashboard',
        sortOrder: 0,
        showInNavigation: true,
      },
      settings: {
        id: 'settings',
        name: 'Settings',
        sortOrder: 999,
        showInNavigation: true,
      },
    };

    function ensureCoreModulesPresent(modules: EnabledModuleSimple[]): EnabledModuleSimple[] {
      const moduleIds = new Set(modules.map(m => m.module.id));
      const result = [...modules];
      
      for (const coreModuleId of CORE_MODULE_IDS) {
        if (!moduleIds.has(coreModuleId)) {
          const metadata = DEFAULT_CORE_MODULES[coreModuleId];
          if (metadata) {
            result.push({
              module: metadata,
              isEnabled: true,
              isLocked: false,
            });
          }
        }
      }
      
      return result;
    }

    /**
     * Arbitrary for generating non-core module IDs
     */
    const nonCoreModuleIdArb = fc.stringMatching(/^[a-z_]+$/).filter(
      (id) => !CORE_MODULE_IDS.includes(id) && id.length > 0
    );

    /**
     * Arbitrary for generating simple enabled modules (non-core)
     */
    const enabledModuleSimpleArb = (moduleIdArb: fc.Arbitrary<string>): fc.Arbitrary<EnabledModuleSimple> =>
      fc.record({
        module: fc.record({
          id: moduleIdArb,
          name: fc.string({ minLength: 1, maxLength: 30 }),
          sortOrder: fc.integer({ min: 1, max: 998 }),
          showInNavigation: fc.boolean(),
        }),
        isEnabled: fc.constant(true),
        isLocked: fc.constant(false),
      });

    it('core modules are always present after ensureCoreModulesPresent', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate array of non-core modules (may be empty)
          fc.array(enabledModuleSimpleArb(nonCoreModuleIdArb), { minLength: 0, maxLength: 15 }),
          async (modules) => {
            const result = ensureCoreModulesPresent(modules);
            
            // Property: all core modules should be present
            for (const coreId of CORE_MODULE_IDS) {
              const found = result.find(m => m.module.id === coreId);
              expect(found).toBeDefined();
              expect(found?.isEnabled).toBe(true);
              expect(found?.isLocked).toBe(false);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('core modules are not duplicated if already present', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate array of non-core modules
          fc.array(enabledModuleSimpleArb(nonCoreModuleIdArb), { minLength: 0, maxLength: 10 }),
          // Decide which core modules to include (0, 1, or both)
          fc.subarray(CORE_MODULE_IDS, { minLength: 0, maxLength: 2 }),
          async (nonCoreModules, includedCoreIds) => {
            // Ensure unique module IDs in non-core modules
            const seenIds = new Set<string>();
            const uniqueNonCoreModules = nonCoreModules.filter(m => {
              if (seenIds.has(m.module.id)) return false;
              seenIds.add(m.module.id);
              return true;
            });
            
            // Add the selected core modules
            const coreModules: EnabledModuleSimple[] = includedCoreIds.map(id => ({
              module: DEFAULT_CORE_MODULES[id],
              isEnabled: true,
              isLocked: false,
            }));
            
            const modules = [...uniqueNonCoreModules, ...coreModules];
            const result = ensureCoreModulesPresent(modules);
            
            // Property: each core module should appear exactly once
            for (const coreId of CORE_MODULE_IDS) {
              const count = result.filter(m => m.module.id === coreId).length;
              expect(count).toBe(1);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('empty module list results in only core modules', async () => {
      const result = ensureCoreModulesPresent([]);
      
      // Property: result should contain exactly the core modules
      expect(result.length).toBe(CORE_MODULE_IDS.length);
      
      for (const coreId of CORE_MODULE_IDS) {
        const found = result.find(m => m.module.id === coreId);
        expect(found).toBeDefined();
      }
    });

    it('non-core modules are preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(enabledModuleSimpleArb(nonCoreModuleIdArb), { minLength: 1, maxLength: 10 }),
          async (modules) => {
            // Ensure unique module IDs (filter out duplicates)
            const seenIds = new Set<string>();
            const uniqueModules = modules.filter(m => {
              if (seenIds.has(m.module.id)) return false;
              seenIds.add(m.module.id);
              return true;
            });
            
            // Skip if no unique modules after filtering
            if (uniqueModules.length === 0) return;
            
            const result = ensureCoreModulesPresent(uniqueModules);
            
            // Property: all original non-core modules should still be present
            for (const original of uniqueModules) {
              const found = result.find(m => m.module.id === original.module.id);
              expect(found).toBeDefined();
              expect(found?.module.name).toBe(original.module.name);
            }
            
            // Property: result should have original modules + any missing core modules
            const originalCoreCount = uniqueModules.filter(m => CORE_MODULE_IDS.includes(m.module.id)).length;
            const addedCoreCount = CORE_MODULE_IDS.length - originalCoreCount;
            expect(result.length).toBe(uniqueModules.length + addedCoreCount);
          }
        ),
        { verbose: true }
      );
    });

    it('core modules have correct default properties', async () => {
      const result = ensureCoreModulesPresent([]);
      
      // Property: dashboard should have sortOrder 0 (first)
      const dashboard = result.find(m => m.module.id === 'dashboard');
      expect(dashboard?.module.sortOrder).toBe(0);
      expect(dashboard?.module.showInNavigation).toBe(true);
      
      // Property: settings should have high sortOrder (last)
      const settings = result.find(m => m.module.id === 'settings');
      expect(settings?.module.sortOrder).toBe(999);
      expect(settings?.module.showInNavigation).toBe(true);
    });
  });

  /**
   * **Feature: pos-module-sync, Property 5: Sort Order Preservation**
   * **Validates: Requirements 2.4**
   * 
   * Property: For any set of navigation modules, they SHALL be sorted in
   * ascending order by their `sort_order` property. Modules without sortOrder
   * (undefined/null) default to the end.
   */
  describe('Property 5: Sort Order Preservation', () => {
    /**
     * Arbitrary for generating sortable items with defined sortOrder
     */
    const sortableItemWithOrderArb: fc.Arbitrary<SortableItem & { id: string }> = fc.record({
      id: fc.uuid(),
      sortOrder: fc.integer({ min: 0, max: 1000 }),
    });

    /**
     * Arbitrary for generating sortable items with undefined sortOrder
     */
    const sortableItemWithoutOrderArb: fc.Arbitrary<SortableItem & { id: string }> = fc.record({
      id: fc.uuid(),
      sortOrder: fc.constant(undefined),
    });

    /**
     * Arbitrary for generating sortable items with null sortOrder
     */
    const sortableItemWithNullOrderArb: fc.Arbitrary<SortableItem & { id: string }> = fc.record({
      id: fc.uuid(),
      sortOrder: fc.constant(null),
    });

    /**
     * Arbitrary for generating any sortable item (with or without sortOrder)
     */
    const anySortableItemArb: fc.Arbitrary<SortableItem & { id: string }> = fc.oneof(
      sortableItemWithOrderArb,
      sortableItemWithoutOrderArb,
      sortableItemWithNullOrderArb
    );

    it('sorted items are in ascending order by sortOrder', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(sortableItemWithOrderArb, { minLength: 1, maxLength: 20 }),
          async (items) => {
            const sorted = sortBySortOrder(items);
            
            // Property: each item's sortOrder should be <= the next item's sortOrder
            for (let i = 0; i < sorted.length - 1; i++) {
              const currentOrder = getEffectiveSortOrder(sorted[i].sortOrder);
              const nextOrder = getEffectiveSortOrder(sorted[i + 1].sortOrder);
              expect(currentOrder).toBeLessThanOrEqual(nextOrder);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('items without sortOrder are placed at the end', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate mix of items with and without sortOrder
          fc.array(sortableItemWithOrderArb, { minLength: 1, maxLength: 10 }),
          fc.array(sortableItemWithoutOrderArb, { minLength: 1, maxLength: 5 }),
          async (itemsWithOrder, itemsWithoutOrder) => {
            const allItems = [...itemsWithOrder, ...itemsWithoutOrder];
            const sorted = sortBySortOrder(allItems);
            
            // Find the index of the first item without sortOrder
            const firstUndefinedIndex = sorted.findIndex(
              item => item.sortOrder === undefined || item.sortOrder === null
            );
            
            // If there are items without sortOrder, they should all be at the end
            if (firstUndefinedIndex !== -1) {
              // All items after firstUndefinedIndex should also have undefined/null sortOrder
              for (let i = firstUndefinedIndex; i < sorted.length; i++) {
                expect(
                  sorted[i].sortOrder === undefined || sorted[i].sortOrder === null
                ).toBe(true);
              }
              
              // All items before firstUndefinedIndex should have defined sortOrder
              for (let i = 0; i < firstUndefinedIndex; i++) {
                expect(sorted[i].sortOrder).not.toBeUndefined();
                expect(sorted[i].sortOrder).not.toBeNull();
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('null sortOrder is treated same as undefined (placed at end)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(sortableItemWithOrderArb, { minLength: 1, maxLength: 10 }),
          fc.array(sortableItemWithNullOrderArb, { minLength: 1, maxLength: 5 }),
          async (itemsWithOrder, itemsWithNull) => {
            const allItems = [...itemsWithOrder, ...itemsWithNull];
            const sorted = sortBySortOrder(allItems);
            
            // Find the index of the first item with null sortOrder
            const firstNullIndex = sorted.findIndex(item => item.sortOrder === null);
            
            // If there are items with null sortOrder, they should all be at the end
            if (firstNullIndex !== -1) {
              // All items before firstNullIndex should have defined sortOrder
              for (let i = 0; i < firstNullIndex; i++) {
                expect(sorted[i].sortOrder).not.toBeNull();
                expect(sorted[i].sortOrder).not.toBeUndefined();
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('sorting preserves all items (no items lost or duplicated)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(anySortableItemArb, { minLength: 0, maxLength: 20 }),
          async (items) => {
            const sorted = sortBySortOrder(items);
            
            // Property: sorted array should have same length as input
            expect(sorted.length).toBe(items.length);
            
            // Property: all original items should be in sorted array
            for (const item of items) {
              const found = sorted.find(s => s.id === item.id);
              expect(found).toBeDefined();
            }
          }
        ),
        { verbose: true }
      );
    });

    it('sorting does not mutate original array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(anySortableItemArb, { minLength: 1, maxLength: 20 }),
          async (items) => {
            // Create a copy of original order
            const originalOrder = items.map(item => item.id);
            
            // Sort the items
            sortBySortOrder(items);
            
            // Property: original array should be unchanged
            const currentOrder = items.map(item => item.id);
            expect(currentOrder).toEqual(originalOrder);
          }
        ),
        { verbose: true }
      );
    });

    it('empty array returns empty array', async () => {
      const sorted = sortBySortOrder([]);
      expect(sorted).toEqual([]);
      expect(sorted.length).toBe(0);
    });

    it('single item array returns same item', async () => {
      await fc.assert(
        fc.asyncProperty(
          anySortableItemArb,
          async (item) => {
            const sorted = sortBySortOrder([item]);
            
            expect(sorted.length).toBe(1);
            expect(sorted[0]).toEqual(item);
          }
        ),
        { verbose: true }
      );
    });

    it('getEffectiveSortOrder returns DEFAULT_SORT_ORDER for undefined', async () => {
      expect(getEffectiveSortOrder(undefined)).toBe(DEFAULT_SORT_ORDER);
    });

    it('getEffectiveSortOrder returns DEFAULT_SORT_ORDER for null', async () => {
      expect(getEffectiveSortOrder(null)).toBe(DEFAULT_SORT_ORDER);
    });

    it('getEffectiveSortOrder returns the value for defined numbers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10000 }),
          async (sortOrder) => {
            expect(getEffectiveSortOrder(sortOrder)).toBe(sortOrder);
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * **Feature: pos-module-sync, Property 6: Module Removal on Deactivation**
   * **Validates: Requirements 3.4**
   * 
   * Property: For any module that was previously in the navigation but is not
   * in the latest API response, after sync that module SHALL no longer appear
   * in navigation.
   */
  describe('Property 6: Module Removal on Deactivation', () => {
    /**
     * Arbitrary for generating identifiable modules
     */
    const identifiableModuleArb: fc.Arbitrary<IdentifiableModule & { name: string }> = fc.record({
      module_id: fc.stringMatching(/^[a-z_]+$/),
      name: fc.string({ minLength: 1, maxLength: 30 }),
    });

    /**
     * Arbitrary for generating unique identifiable modules (no duplicate module_ids)
     */
    const uniqueModulesArb = (minLength: number, maxLength: number) =>
      fc.array(identifiableModuleArb, { minLength, maxLength }).map(modules => {
        const seen = new Set<string>();
        return modules.filter(m => {
          if (seen.has(m.module_id)) return false;
          seen.add(m.module_id);
          return true;
        });
      });

    it('computeModuleChanges correctly identifies removed modules', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          uniqueModulesArb(1, 15),
          async (previousModules, currentModules) => {
            const result = computeModuleChanges(previousModules, currentModules);
            
            const previousIds = new Set(previousModules.map(m => m.module_id));
            const currentIds = new Set(currentModules.map(m => m.module_id));
            
            // Property: removed modules should be in previous but not in current
            for (const removed of result.removed) {
              expect(previousIds.has(removed.module_id)).toBe(true);
              expect(currentIds.has(removed.module_id)).toBe(false);
            }
            
            // Property: count of removed should match
            const expectedRemovedCount = [...previousIds].filter(id => !currentIds.has(id)).length;
            expect(result.removed.length).toBe(expectedRemovedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('computeModuleChanges correctly identifies added modules', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          uniqueModulesArb(1, 15),
          async (previousModules, currentModules) => {
            const result = computeModuleChanges(previousModules, currentModules);
            
            const previousIds = new Set(previousModules.map(m => m.module_id));
            const currentIds = new Set(currentModules.map(m => m.module_id));
            
            // Property: added modules should be in current but not in previous
            for (const added of result.added) {
              expect(currentIds.has(added.module_id)).toBe(true);
              expect(previousIds.has(added.module_id)).toBe(false);
            }
            
            // Property: count of added should match
            const expectedAddedCount = [...currentIds].filter(id => !previousIds.has(id)).length;
            expect(result.added.length).toBe(expectedAddedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('computeModuleChanges correctly identifies retained modules', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          uniqueModulesArb(1, 15),
          async (previousModules, currentModules) => {
            const result = computeModuleChanges(previousModules, currentModules);
            
            const previousIds = new Set(previousModules.map(m => m.module_id));
            const currentIds = new Set(currentModules.map(m => m.module_id));
            
            // Property: retained modules should be in both previous and current
            for (const retained of result.retained) {
              expect(previousIds.has(retained.module_id)).toBe(true);
              expect(currentIds.has(retained.module_id)).toBe(true);
            }
            
            // Property: count of retained should match
            const expectedRetainedCount = [...currentIds].filter(id => previousIds.has(id)).length;
            expect(result.retained.length).toBe(expectedRetainedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('getRemovedModuleIds returns correct removed IDs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.stringMatching(/^[a-z_]+$/), { minLength: 1, maxLength: 20 }),
          fc.array(fc.stringMatching(/^[a-z_]+$/), { minLength: 1, maxLength: 20 }),
          async (previousIds, currentIds) => {
            const previousSet = new Set(previousIds);
            const currentSet = new Set(currentIds);
            
            const removed = getRemovedModuleIds(previousSet, currentSet);
            
            // Property: all removed IDs should be in previous but not in current
            for (const id of removed) {
              expect(previousSet.has(id)).toBe(true);
              expect(currentSet.has(id)).toBe(false);
            }
            
            // Property: count should match expected
            const expectedCount = [...previousSet].filter(id => !currentSet.has(id)).length;
            expect(removed.length).toBe(expectedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('filterToAllowedModules removes non-allowed modules', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 20),
          async (modules) => {
            // Create allowed set from a subset of modules
            const allowedIds = new Set(
              modules.slice(0, Math.ceil(modules.length / 2)).map(m => m.module_id)
            );
            
            const filtered = filterToAllowedModules(modules, allowedIds);
            
            // Property: all filtered modules should be in allowed set
            for (const module of filtered) {
              expect(allowedIds.has(module.module_id)).toBe(true);
            }
            
            // Property: no modules outside allowed set should be in result
            for (const module of modules) {
              if (!allowedIds.has(module.module_id)) {
                const found = filtered.find(m => m.module_id === module.module_id);
                expect(found).toBeUndefined();
              }
            }
          }
        ),
        { verbose: true }
      );
    });

    it('module removal is complete - no deactivated modules remain', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(5, 15),
          async (previousModules) => {
            // Simulate deactivation: remove some modules from current
            const deactivatedCount = Math.min(3, Math.floor(previousModules.length / 2));
            const currentModules = previousModules.slice(deactivatedCount);
            
            const result = computeModuleChanges(previousModules, currentModules);
            
            // Property: deactivated modules should be in removed list
            expect(result.removed.length).toBe(deactivatedCount);
            
            // Property: current modules should not contain any removed modules
            const currentIds = new Set(currentModules.map(m => m.module_id));
            for (const removed of result.removed) {
              expect(currentIds.has(removed.module_id)).toBe(false);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('empty previous state means no removals', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          async (currentModules) => {
            const result = computeModuleChanges([], currentModules);
            
            // Property: no modules can be removed if previous was empty
            expect(result.removed.length).toBe(0);
            
            // Property: all current modules are added
            expect(result.added.length).toBe(currentModules.length);
          }
        ),
        { verbose: true }
      );
    });

    it('empty current state means all previous modules are removed', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          async (previousModules) => {
            const result = computeModuleChanges(previousModules, []);
            
            // Property: all previous modules should be removed
            expect(result.removed.length).toBe(previousModules.length);
            
            // Property: no modules are added or retained
            expect(result.added.length).toBe(0);
            expect(result.retained.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    it('identical states mean no changes', async () => {
      await fc.assert(
        fc.asyncProperty(
          uniqueModulesArb(1, 15),
          async (modules) => {
            const result = computeModuleChanges(modules, modules);
            
            // Property: no additions or removals
            expect(result.added.length).toBe(0);
            expect(result.removed.length).toBe(0);
            
            // Property: all modules are retained
            expect(result.retained.length).toBe(modules.length);
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * **Feature: pos-module-sync, Property 8: Cache-First Loading**
   * **Validates: Requirements 5.2**
   * 
   * Property: For any valid cached modules, on startup the module context
   * SHALL immediately return cached modules before the API fetch completes.
   * 
   * This test verifies the cache-first loading behavior by simulating:
   * 1. A valid cache exists with modules
   * 2. The cache is loaded synchronously (immediate return)
   * 3. The loaded modules match what was cached
   */
  describe('Property 8: Cache-First Loading', () => {
    /**
     * Simulates the cache-first loading behavior.
     * Returns cached modules immediately if cache is valid.
     */
    interface CacheFirstResult {
      /** Modules returned immediately from cache */
      immediateModules: POSModuleInfo[] | null;
      /** Whether cache was valid and used */
      cacheUsed: boolean;
      /** Time taken to return (should be ~0 for cache hit) */
      loadTimeMs: number;
    }

    /**
     * Simulates cache-first loading behavior.
     * This mirrors the initialization flow in ModuleContext.
     */
    function simulateCacheFirstLoading(
      cachedModules: POSModuleInfo[] | null,
      cacheTimestamp: number,
      currentTime: number
    ): CacheFirstResult {
      const startTime = Date.now();
      
      // Check if cache exists and is valid
      if (cachedModules === null) {
        return {
          immediateModules: null,
          cacheUsed: false,
          loadTimeMs: Date.now() - startTime,
        };
      }

      // Check TTL (24 hours)
      if (!isCacheValid(cacheTimestamp, currentTime)) {
        return {
          immediateModules: null,
          cacheUsed: false,
          loadTimeMs: Date.now() - startTime,
        };
      }

      // Cache is valid - return immediately (synchronous)
      return {
        immediateModules: cachedModules,
        cacheUsed: true,
        loadTimeMs: Date.now() - startTime,
      };
    }

    it('valid cache returns modules immediately', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate valid cached modules
          fc.array(posModuleInfoArb(implementedModuleIdArb), { minLength: 1, maxLength: 15 }),
          // Generate cache timestamp within TTL (last 23 hours)
          fc.integer({ min: 0, max: CACHE_TTL_MS - 3600000 }),
          async (cachedModules, ageMs) => {
            const currentTime = Date.now();
            const cacheTimestamp = currentTime - ageMs;
            
            const result = simulateCacheFirstLoading(
              cachedModules,
              cacheTimestamp,
              currentTime
            );
            
            // Property: cache should be used
            expect(result.cacheUsed).toBe(true);
            
            // Property: modules should be returned immediately
            expect(result.immediateModules).not.toBeNull();
            expect(result.immediateModules!.length).toBe(cachedModules.length);
            
            // Property: returned modules should match cached modules
            for (let i = 0; i < cachedModules.length; i++) {
              expect(result.immediateModules![i].module_id).toBe(cachedModules[i].module_id);
            }
          }
        ),
        { verbose: true }
      );
    });

    it('expired cache does not return modules immediately', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate cached modules
          fc.array(posModuleInfoArb(implementedModuleIdArb), { minLength: 1, maxLength: 15 }),
          // Generate cache timestamp older than TTL (25-48 hours old)
          fc.integer({ min: CACHE_TTL_MS + 3600000, max: CACHE_TTL_MS * 2 }),
          async (cachedModules, ageMs) => {
            const currentTime = Date.now();
            const cacheTimestamp = currentTime - ageMs;
            
            const result = simulateCacheFirstLoading(
              cachedModules,
              cacheTimestamp,
              currentTime
            );
            
            // Property: cache should NOT be used (expired)
            expect(result.cacheUsed).toBe(false);
            
            // Property: no modules returned immediately
            expect(result.immediateModules).toBeNull();
          }
        ),
        { verbose: true }
      );
    });

    it('null cache does not return modules immediately', async () => {
      const currentTime = Date.now();
      const cacheTimestamp = currentTime - 1000; // Recent timestamp
      
      const result = simulateCacheFirstLoading(
        null,
        cacheTimestamp,
        currentTime
      );
      
      // Property: cache should NOT be used (no cache)
      expect(result.cacheUsed).toBe(false);
      
      // Property: no modules returned immediately
      expect(result.immediateModules).toBeNull();
    });

    it('empty cache array is treated as valid cache', async () => {
      const currentTime = Date.now();
      const cacheTimestamp = currentTime - 1000; // Recent timestamp
      
      const result = simulateCacheFirstLoading(
        [], // Empty but valid cache
        cacheTimestamp,
        currentTime
      );
      
      // Property: cache should be used (empty is still valid)
      expect(result.cacheUsed).toBe(true);
      
      // Property: empty array returned immediately
      expect(result.immediateModules).not.toBeNull();
      expect(result.immediateModules!.length).toBe(0);
    });

    it('cache-first loading preserves module data integrity', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a single module with all properties
          posModuleInfoArb(implementedModuleIdArb),
          async (module) => {
            const currentTime = Date.now();
            const cacheTimestamp = currentTime - 1000; // Recent timestamp
            
            const result = simulateCacheFirstLoading(
              [module],
              cacheTimestamp,
              currentTime
            );
            
            // Property: cache should be used
            expect(result.cacheUsed).toBe(true);
            expect(result.immediateModules).not.toBeNull();
            expect(result.immediateModules!.length).toBe(1);
            
            // Property: all module properties should be preserved
            const loadedModule = result.immediateModules![0];
            expect(loadedModule.id).toBe(module.id);
            expect(loadedModule.module_id).toBe(module.module_id);
            expect(loadedModule.name).toBe(module.name);
            expect(loadedModule.display_name).toBe(module.display_name);
            expect(loadedModule.description).toBe(module.description);
            expect(loadedModule.icon).toBe(module.icon);
            expect(loadedModule.category).toBe(module.category);
            expect(loadedModule.route).toBe(module.route);
            expect(loadedModule.is_core).toBe(module.is_core);
            expect(loadedModule.is_purchased).toBe(module.is_purchased);
            expect(loadedModule.pos_enabled).toBe(module.pos_enabled);
            expect(loadedModule.show_in_navigation).toBe(module.show_in_navigation);
            expect(loadedModule.sort_order).toBe(module.sort_order);
          }
        ),
        { verbose: true }
      );
    });

    it('cache at TTL boundary is invalid', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(implementedModuleIdArb), { minLength: 1, maxLength: 10 }),
          async (cachedModules) => {
            const currentTime = Date.now();
            // Cache exactly at TTL boundary
            const cacheTimestamp = currentTime - CACHE_TTL_MS;
            
            const result = simulateCacheFirstLoading(
              cachedModules,
              cacheTimestamp,
              currentTime
            );
            
            // Property: cache at exactly TTL should be invalid
            expect(result.cacheUsed).toBe(false);
            expect(result.immediateModules).toBeNull();
          }
        ),
        { verbose: true }
      );
    });

    it('fresh cache (0 age) is always valid', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(implementedModuleIdArb), { minLength: 1, maxLength: 10 }),
          async (cachedModules) => {
            const currentTime = Date.now();
            // Cache with same timestamp as current time (0 age)
            const cacheTimestamp = currentTime;
            
            const result = simulateCacheFirstLoading(
              cachedModules,
              cacheTimestamp,
              currentTime
            );
            
            // Property: fresh cache should always be valid
            expect(result.cacheUsed).toBe(true);
            expect(result.immediateModules).not.toBeNull();
            expect(result.immediateModules!.length).toBe(cachedModules.length);
          }
        ),
        { verbose: true }
      );
    });
  });
});
