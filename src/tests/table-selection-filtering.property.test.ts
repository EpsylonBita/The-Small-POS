/**
 * Property-Based Tests for Table Selection Filtering
 * 
 * **Feature: pos-tables-reservations-sync, Property 3: Table Selection Filtering**
 * **Validates: Requirements 3.5**
 * 
 * Property: For any set of tables with various statuses, the table selector SHALL 
 * display only tables with status 'available' or 'reserved', excluding 'occupied' 
 * and 'cleaning' tables.
 */

import * as fc from 'fast-check';
import { filterSelectableTables } from '../renderer/components/tables/TableSelector';

// Configure fast-check for minimum 100 iterations as per design document
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// =============================================
// TYPES
// =============================================

export type TableStatus = 'available' | 'occupied' | 'reserved' | 'cleaning';
export type TableShape = 'rectangle' | 'circle' | 'square' | 'custom';

export interface RestaurantTable {
  id: string;
  organizationId: string;
  branchId: string;
  tableNumber: number;
  capacity: number;
  status: TableStatus;
  positionX: number | null;
  positionY: number | null;
  shape: TableShape | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================
// ARBITRARIES
// =============================================

/** Arbitrary for generating table statuses */
const tableStatusArb: fc.Arbitrary<TableStatus> = fc.constantFrom(
  'available', 'occupied', 'reserved', 'cleaning'
);


/** Arbitrary for selectable statuses (available, reserved) */
const selectableStatusArb: fc.Arbitrary<TableStatus> = fc.constantFrom('available', 'reserved');

/** Arbitrary for non-selectable statuses (occupied, cleaning) */
const nonSelectableStatusArb: fc.Arbitrary<TableStatus> = fc.constantFrom('occupied', 'cleaning');

/** Arbitrary for table shapes */
const tableShapeArb: fc.Arbitrary<TableShape | null> = fc.constantFrom('rectangle', 'circle', 'square', 'custom', null);

/** Arbitrary for generating valid ISO date strings */
const validDateStringArb = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(ts => new Date(ts).toISOString());

/** Arbitrary for generating a single RestaurantTable */
const restaurantTableArb: fc.Arbitrary<RestaurantTable> = fc.record({
  id: fc.uuid(),
  organizationId: fc.uuid(),
  branchId: fc.uuid(),
  tableNumber: fc.integer({ min: 1, max: 100 }),
  capacity: fc.integer({ min: 1, max: 20 }),
  status: tableStatusArb,
  positionX: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
  positionY: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
  shape: tableShapeArb,
  notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
  createdAt: validDateStringArb,
  updatedAt: validDateStringArb,
});

/** Arbitrary for generating a table with a specific status */
const tableWithStatusArb = (status: TableStatus): fc.Arbitrary<RestaurantTable> =>
  fc.record({
    id: fc.uuid(),
    organizationId: fc.uuid(),
    branchId: fc.uuid(),
    tableNumber: fc.integer({ min: 1, max: 100 }),
    capacity: fc.integer({ min: 1, max: 20 }),
    status: fc.constant(status),
    positionX: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
    positionY: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }),
    shape: tableShapeArb,
    notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
    createdAt: validDateStringArb,
    updatedAt: validDateStringArb,
  });

/** Arbitrary for generating a list of tables */
const tablesListArb: fc.Arbitrary<RestaurantTable[]> = fc.array(restaurantTableArb, { 
  minLength: 0, 
  maxLength: 50 
});


// =============================================
// PROPERTY TESTS
// =============================================

describe('Table Selection Filtering Property Tests', () => {
  /**
   * **Feature: pos-tables-reservations-sync, Property 3: Table Selection Filtering**
   * **Validates: Requirements 3.5**
   */
  describe('Property 3: Table Selection Filtering', () => {
    
    /**
     * Requirements 3.5: Filter to show only available and reserved tables
     * All filtered tables must have status 'available' or 'reserved'
     */
    it('SHALL display only tables with status available or reserved', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            
            // All filtered tables must have selectable status
            filtered.forEach(table => {
              expect(['available', 'reserved']).toContain(table.status);
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Requirements 3.5: Exclude occupied and cleaning tables
     * No filtered table should have status 'occupied' or 'cleaning'
     */
    it('SHALL exclude tables with status occupied or cleaning', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            
            // No filtered table should have non-selectable status
            filtered.forEach(table => {
              expect(['occupied', 'cleaning']).not.toContain(table.status);
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * All available tables from input must appear in filtered result
     */
    it('SHALL include all available tables from input', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            const availableTables = tables.filter(t => t.status === 'available');
            
            // All available tables should be in filtered result
            availableTables.forEach(availableTable => {
              const found = filtered.find(t => t.id === availableTable.id);
              expect(found).toBeDefined();
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * All reserved tables from input must appear in filtered result
     */
    it('SHALL include all reserved tables from input', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            const reservedTables = tables.filter(t => t.status === 'reserved');
            
            // All reserved tables should be in filtered result
            reservedTables.forEach(reservedTable => {
              const found = filtered.find(t => t.id === reservedTable.id);
              expect(found).toBeDefined();
            });
          }
        ),
        { verbose: true }
      );
    });


    /**
     * Filtered count equals sum of available and reserved tables
     */
    it('filtered count SHALL equal sum of available and reserved tables', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            const expectedCount = tables.filter(t => 
              t.status === 'available' || t.status === 'reserved'
            ).length;
            
            expect(filtered.length).toBe(expectedCount);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Filtering preserves table data integrity
     */
    it('filtering SHALL preserve table data integrity', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          (tables) => {
            const filtered = filterSelectableTables(tables);
            
            // Each filtered table must exist in original list with same data
            filtered.forEach(filteredTable => {
              const original = tables.find(t => t.id === filteredTable.id);
              expect(original).toBeDefined();
              expect(filteredTable).toEqual(original);
            });
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Empty input produces empty output
     */
    it('empty input SHALL produce empty output', () => {
      const filtered = filterSelectableTables([]);
      expect(filtered.length).toBe(0);
    });

    /**
     * Tables with only non-selectable statuses produce empty output
     */
    it('tables with only occupied/cleaning status SHALL produce empty output', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              tableWithStatusArb('occupied'),
              tableWithStatusArb('cleaning')
            ),
            { minLength: 1, maxLength: 20 }
          ),
          (tables) => {
            const filtered = filterSelectableTables(tables);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Tables with only selectable statuses are all included
     */
    it('tables with only available/reserved status SHALL all be included', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              tableWithStatusArb('available'),
              tableWithStatusArb('reserved')
            ),
            { minLength: 1, maxLength: 20 }
          ),
          (tables) => {
            const filtered = filterSelectableTables(tables);
            expect(filtered.length).toBe(tables.length);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Custom filter statuses work correctly
     */
    it('custom filter statuses SHALL work correctly', () => {
      fc.assert(
        fc.property(
          tablesListArb,
          fc.subarray(['available', 'occupied', 'reserved', 'cleaning'] as TableStatus[]),
          (tables, allowedStatuses) => {
            const filtered = filterSelectableTables(tables, allowedStatuses);
            
            // All filtered tables must have one of the allowed statuses
            filtered.forEach(table => {
              expect(allowedStatuses).toContain(table.status);
            });
            
            // Count should match
            const expectedCount = tables.filter(t => allowedStatuses.includes(t.status)).length;
            expect(filtered.length).toBe(expectedCount);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Available table is always included in default filter
     */
    it('available table SHALL always be included in default filter', () => {
      fc.assert(
        fc.property(
          tableWithStatusArb('available'),
          (table) => {
            const filtered = filterSelectableTables([table]);
            expect(filtered.length).toBe(1);
            expect(filtered[0].id).toBe(table.id);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Reserved table is always included in default filter
     */
    it('reserved table SHALL always be included in default filter', () => {
      fc.assert(
        fc.property(
          tableWithStatusArb('reserved'),
          (table) => {
            const filtered = filterSelectableTables([table]);
            expect(filtered.length).toBe(1);
            expect(filtered[0].id).toBe(table.id);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Occupied table is always excluded in default filter
     */
    it('occupied table SHALL always be excluded in default filter', () => {
      fc.assert(
        fc.property(
          tableWithStatusArb('occupied'),
          (table) => {
            const filtered = filterSelectableTables([table]);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Cleaning table is always excluded in default filter
     */
    it('cleaning table SHALL always be excluded in default filter', () => {
      fc.assert(
        fc.property(
          tableWithStatusArb('cleaning'),
          (table) => {
            const filtered = filterSelectableTables([table]);
            expect(filtered.length).toBe(0);
          }
        ),
        { verbose: true }
      );
    });
  });
});
