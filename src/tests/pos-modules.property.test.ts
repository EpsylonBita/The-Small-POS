/**
 * Property-Based Tests for POS Modules Registry
 * 
 * **Feature: pos-module-sync, Property 9: POS Implementation Filter**
 * **Validates: Requirements 2.1**
 * 
 * This test verifies that for any module returned from the API, it SHALL only
 * appear in navigation if it exists in the POS_IMPLEMENTED_MODULES or
 * POS_COMING_SOON_MODULES registry.
 */

import * as fc from 'fast-check';
import {
  POS_IMPLEMENTED_MODULES,
  POS_COMING_SOON_MODULES,
  isModuleImplemented,
  isModuleComingSoon,
  shouldShowInNavigation,
} from '../shared/constants/pos-modules';
import { POSModuleInfo, ModuleCategory, BusinessType } from '../shared/types/modules';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

/**
 * Arbitrary for generating valid module categories
 */
const moduleCategoryArb: fc.Arbitrary<ModuleCategory> = fc.constantFrom(
  'core',
  'vertical',
  'addon'
);

/**
 * Arbitrary for generating valid business types
 */
const businessTypeArb: fc.Arbitrary<BusinessType> = fc.constantFrom(
  'restaurant',
  'hotel',
  'retail',
  'cafe',
  'bar',
  'bakery',
  'food_truck',
  'fast_food',
  'salon',
  'bar_cafe',
  'chain',
  'franchise'
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
const posModuleInfoArb = (moduleIdArb: fc.Arbitrary<string>): fc.Arbitrary<POSModuleInfo> =>
  fc.record({
    id: fc.uuid(),
    module_id: moduleIdArb,
    name: moduleIdArb,
    display_name: fc.string({ minLength: 1, maxLength: 50 }),
    description: fc.string({ maxLength: 200 }),
    icon: fc.stringMatching(/^[a-z-]+$/),
    category: moduleCategoryArb,
    route: fc.stringMatching(/^\/[a-z-]+$/),
    is_core: fc.boolean(),
    is_enabled: fc.boolean(),
    is_locked: fc.boolean(),
    is_purchased: fc.boolean(),
    pos_enabled: fc.boolean(),
    show_in_navigation: fc.boolean(),
    sort_order: fc.integer({ min: 0, max: 100 }),
    compatible_business_types: fc.array(businessTypeArb, { minLength: 1, maxLength: 5 }),
  });

/**
 * Filter function that determines if a module should appear in navigation
 * based on the POS implementation registry.
 * This is the function under test.
 */
function filterModulesForNavigation(modules: POSModuleInfo[]): POSModuleInfo[] {
  return modules.filter((module) => shouldShowInNavigation(module.module_id));
}

describe('POS Modules Registry Property Tests', () => {
  /**
   * **Feature: pos-module-sync, Property 9: POS Implementation Filter**
   * **Validates: Requirements 2.1**
   * 
   * Property: For any module returned from the API, it SHALL only appear in
   * navigation if it exists in the POS_IMPLEMENTED_MODULES or POS_COMING_SOON_MODULES registry.
   */
  describe('Property 9: POS Implementation Filter', () => {
    it('implemented modules should always pass the filter', async () => {
      await fc.assert(
        fc.asyncProperty(
          posModuleInfoArb(implementedModuleIdArb),
          async (module) => {
            const result = filterModulesForNavigation([module]);
            
            // Implemented modules should always be included
            expect(result).toHaveLength(1);
            expect(result[0].module_id).toBe(module.module_id);
            expect(isModuleImplemented(module.module_id)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('coming soon modules should always pass the filter', async () => {
      await fc.assert(
        fc.asyncProperty(
          posModuleInfoArb(comingSoonModuleIdArb),
          async (module) => {
            const result = filterModulesForNavigation([module]);
            
            // Coming soon modules should be included
            expect(result).toHaveLength(1);
            expect(result[0].module_id).toBe(module.module_id);
            expect(isModuleComingSoon(module.module_id)).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('unknown modules should never pass the filter', async () => {
      await fc.assert(
        fc.asyncProperty(
          posModuleInfoArb(unknownModuleIdArb),
          async (module) => {
            const result = filterModulesForNavigation([module]);
            
            // Unknown modules should be excluded
            expect(result).toHaveLength(0);
            expect(isModuleImplemented(module.module_id)).toBe(false);
            expect(isModuleComingSoon(module.module_id)).toBe(false);
          }
        ),
        { verbose: true }
      );
    });

    it('mixed modules should only include implemented and coming soon', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(anyModuleIdArb), { minLength: 1, maxLength: 20 }),
          async (modules) => {
            const result = filterModulesForNavigation(modules);
            
            // All filtered modules should be in one of the registries
            for (const module of result) {
              expect(shouldShowInNavigation(module.module_id)).toBe(true);
            }
            
            // Count expected modules
            const expectedCount = modules.filter(
              (m) => POS_IMPLEMENTED_MODULES.has(m.module_id) || POS_COMING_SOON_MODULES.has(m.module_id)
            ).length;
            
            expect(result.length).toBe(expectedCount);
          }
        ),
        { verbose: true }
      );
    });

    it('filter preserves module data integrity', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(posModuleInfoArb(implementedModuleIdArb), { minLength: 1, maxLength: 10 }),
          async (modules) => {
            const result = filterModulesForNavigation(modules);
            
            // Each filtered module should have identical data to the original
            for (let i = 0; i < result.length; i++) {
              expect(result[i]).toEqual(modules[i]);
            }
          }
        ),
        { verbose: true }
      );
    });
  });

  /**
   * Helper function tests
   */
  describe('Helper Functions', () => {
    it('isModuleImplemented returns true only for implemented modules', async () => {
      await fc.assert(
        fc.asyncProperty(anyModuleIdArb, async (moduleId) => {
          const result = isModuleImplemented(moduleId);
          expect(result).toBe(POS_IMPLEMENTED_MODULES.has(moduleId));
        }),
        { verbose: true }
      );
    });

    it('isModuleComingSoon returns true only for coming soon modules', async () => {
      await fc.assert(
        fc.asyncProperty(anyModuleIdArb, async (moduleId) => {
          const result = isModuleComingSoon(moduleId);
          expect(result).toBe(POS_COMING_SOON_MODULES.has(moduleId));
        }),
        { verbose: true }
      );
    });

    it('shouldShowInNavigation returns true for implemented OR coming soon', async () => {
      await fc.assert(
        fc.asyncProperty(anyModuleIdArb, async (moduleId) => {
          const result = shouldShowInNavigation(moduleId);
          const expected = POS_IMPLEMENTED_MODULES.has(moduleId) || POS_COMING_SOON_MODULES.has(moduleId);
          expect(result).toBe(expected);
        }),
        { verbose: true }
      );
    });

    it('implemented and coming soon sets are disjoint', () => {
      // This is a structural property - no module should be in both sets
      for (const moduleId of POS_IMPLEMENTED_MODULES) {
        expect(POS_COMING_SOON_MODULES.has(moduleId)).toBe(false);
      }
      for (const moduleId of POS_COMING_SOON_MODULES) {
        expect(POS_IMPLEMENTED_MODULES.has(moduleId)).toBe(false);
      }
    });
  });
});
