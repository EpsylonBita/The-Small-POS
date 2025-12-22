/**
 * Property-Based Tests for Field Alias Compatibility
 * 
 * **Feature: pos-customer-address-sync-fix, Property 7: Field Alias Compatibility**
 * **Validates: Requirements 6.2, 6.3**
 * 
 * This test verifies that for any address input using either `street` or `street_address`
 * field names, and either `notes` or `delivery_notes` field names, the address should be
 * saved correctly with the canonical database field names.
 */

import * as fc from 'fast-check';
import { CustomerSyncService } from '../shared/services/CustomerSyncService';
import './propertyTestConfig';

/**
 * Mock Supabase client for testing address operations
 * Captures the actual data sent to the database for verification
 */
function createMockSupabaseClient() {
  const addresses: Map<string, any> = new Map();
  let addressIdCounter = 1;
  let lastInsertedData: any = null;

  return {
    from: (table: string) => {
      if (table === 'customer_addresses') {
        return {
          insert: (data: any) => {
            lastInsertedData = data;
            return {
              select: () => ({
                single: async () => {
                  const id = `addr-${addressIdCounter++}`;
                  const addressData = {
                    id,
                    ...data,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  };
                  addresses.set(id, addressData);
                  return { data: addressData, error: null };
                },
              }),
            };
          },
          update: (data: any) => {
            lastInsertedData = data;
            return {
              eq: (field: string, value: string) => ({
                eq: (field2: string, value2: any) => ({
                  select: () => ({
                    single: async () => {
                      const address = addresses.get(value);
                      if (address && address.version === value2) {
                        const updatedAddress = { ...address, ...data };
                        addresses.set(value, updatedAddress);
                        return { data: updatedAddress, error: null };
                      }
                      return { data: null, error: { code: 'PGRST116', message: 'Not found or version mismatch' } };
                    },
                  }),
                }),
              }),
            };
          },
          select: (fields: string) => ({
            eq: (field: string, value: string) => ({
              single: async () => {
                const address = addresses.get(value);
                if (address) {
                  return { data: address, error: null };
                }
                return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
              },
            }),
          }),
        };
      }
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }) }),
      };
    },
    // Expose for test verification
    _addresses: addresses,
    _getLastInsertedData: () => lastInsertedData,
  };
}

/**
 * Arbitrary for generating valid customer IDs (UUIDs)
 */
const customerIdArb: fc.Arbitrary<string> = fc.uuid();

/**
 * Arbitrary for generating valid street addresses
 */
const streetAddressArb: fc.Arbitrary<string> = fc.string({ minLength: 5, maxLength: 100 });

/**
 * Arbitrary for generating valid city names
 */
const cityArb: fc.Arbitrary<string> = fc.string({ minLength: 2, maxLength: 50 });

/**
 * Arbitrary for generating valid postal codes
 */
const postalCodeArb: fc.Arbitrary<string> = fc.stringMatching(/^[0-9]{5}$/);

/**
 * Arbitrary for generating valid address types
 */
const addressTypeArb: fc.Arbitrary<'home' | 'work' | 'other'> = fc.constantFrom('home', 'work', 'other');

/**
 * Arbitrary for generating delivery notes
 */
const notesArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

describe('Field Alias Compatibility Property Tests', () => {
  /**
   * **Feature: pos-customer-address-sync-fix, Property 7: Field Alias Compatibility**
   * **Validates: Requirements 6.2, 6.3**
   * 
   * Property: For any address input using either `street` or `street_address` field names,
   * and either `notes` or `delivery_notes` field names, the address should be saved
   * correctly with the canonical database field names.
   */
  describe('Property 7: Field Alias Compatibility', () => {
    /**
     * Task 6.1: Test field alias support - street maps to street_address
     * **Validates: Requirements 3.1, 6.2**
     */
    it('Property 7a: street alias maps to street_address in database', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          cityArb,
          async (customerId, streetValue, city) => {
            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Use 'street' field name (alias)
            const addressInput = {
              street: streetValue, // Using alias
              city,
              address_type: 'home' as const,
              is_default: false,
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify the database received street_address (canonical name)
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.street_address).toBe(streetValue);
            
            // Verify the returned address has street_address populated
            expect(savedAddress.street_address).toBe(streetValue);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Task 6.1: Test field alias support - street_address is used directly
     * **Validates: Requirements 3.1, 6.2**
     */
    it('Property 7b: street_address is used directly when provided', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          cityArb,
          async (customerId, streetValue, city) => {
            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Use 'street_address' field name (canonical)
            const addressInput = {
              street_address: streetValue, // Using canonical name
              city,
              address_type: 'home' as const,
              is_default: false,
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify the database received street_address
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.street_address).toBe(streetValue);
            
            // Verify the returned address has street_address populated
            expect(savedAddress.street_address).toBe(streetValue);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Task 6.1: Test field alias support - notes maps to delivery_notes
     * **Validates: Requirements 3.2, 6.3**
     * 
     * Note: This test verifies that the 'notes' alias is properly mapped to 'delivery_notes'
     * in the database. The current implementation may need to be updated to support this.
     */
    it('Property 7c: notes alias maps to delivery_notes in database', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          cityArb,
          notesArb,
          async (customerId, streetValue, city, notesValue) => {
            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Use 'notes' field name (alias)
            const addressInput = {
              street_address: streetValue,
              city,
              address_type: 'home' as const,
              is_default: false,
              notes: notesValue, // Using alias
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify the database received delivery_notes (canonical name)
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.delivery_notes).toBe(notesValue);
            
            // Verify the returned address has delivery_notes populated
            expect(savedAddress.delivery_notes).toBe(notesValue);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Task 6.1: Test field alias support - delivery_notes is used directly
     * **Validates: Requirements 3.2, 6.3**
     */
    it('Property 7d: delivery_notes is used directly when provided', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          cityArb,
          notesArb,
          async (customerId, streetValue, city, notesValue) => {
            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Use 'delivery_notes' field name (canonical)
            const addressInput = {
              street_address: streetValue,
              city,
              address_type: 'home' as const,
              is_default: false,
              delivery_notes: notesValue, // Using canonical name
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify the database received delivery_notes
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.delivery_notes).toBe(notesValue);
            
            // Verify the returned address has delivery_notes populated
            expect(savedAddress.delivery_notes).toBe(notesValue);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property 7e: Both aliases work together in a single address
     * **Validates: Requirements 3.1, 3.2, 6.2, 6.3**
     */
    it('Property 7e: Both street and notes aliases work together', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          cityArb,
          notesArb,
          async (customerId, streetValue, city, notesValue) => {
            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Use both aliases
            const addressInput = {
              street: streetValue, // Using alias
              city,
              address_type: 'home' as const,
              is_default: false,
              notes: notesValue, // Using alias
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify the database received canonical names
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.street_address).toBe(streetValue);
            expect(insertedData.delivery_notes).toBe(notesValue);
            
            // Verify the returned address has canonical fields populated
            expect(savedAddress.street_address).toBe(streetValue);
            expect(savedAddress.delivery_notes).toBe(notesValue);
          }
        ),
        { verbose: true }
      );
    });

    /**
     * Property 7f: Canonical names take precedence over aliases when both provided
     * **Validates: Requirements 6.2, 6.3**
     */
    it('Property 7f: Canonical names take precedence over aliases', async () => {
      await fc.assert(
        fc.asyncProperty(
          customerIdArb,
          streetAddressArb,
          streetAddressArb,
          cityArb,
          notesArb,
          notesArb,
          async (customerId, streetAlias, streetCanonical, city, notesAlias, notesCanonical) => {
            // Skip if values are the same (can't test precedence)
            fc.pre(streetAlias !== streetCanonical);
            fc.pre(notesAlias !== notesCanonical);

            const mockClient = createMockSupabaseClient();
            const service = new CustomerSyncService(
              mockClient as any,
              'pos-system',
              { terminalId: 'test-terminal', organizationId: 'test-org' }
            );

            // Provide both alias and canonical names
            const addressInput = {
              street: streetAlias,
              street_address: streetCanonical, // Canonical should win
              city,
              address_type: 'home' as const,
              is_default: false,
              notes: notesAlias,
              delivery_notes: notesCanonical, // Canonical should win
            };

            const savedAddress = await service.addAddress(customerId, addressInput);

            // Verify canonical names take precedence
            const insertedData = mockClient._getLastInsertedData();
            expect(insertedData.street_address).toBe(streetCanonical);
            expect(insertedData.delivery_notes).toBe(notesCanonical);
          }
        ),
        { verbose: true }
      );
    });
  });
});
