/**
 * Property-Based Tests for Customer Address Sync
 * 
 * **Feature: pos-customer-address-sync-fix, Property 1: Address Round-Trip Consistency**
 * **Validates: Requirements 1.1, 3.1, 3.2, 3.3, 3.4**
 * 
 * This test verifies that for any valid customer address with all fields populated,
 * saving the address via `addAddress` and then retrieving it should preserve all
 * field values (street_address, city, postal_code, floor_number, address_type, 
 * is_default, delivery_notes).
 */

import * as fc from 'fast-check';
import { CustomerSyncService } from '../shared/services/CustomerSyncService';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

/**
 * Mock Supabase client for testing address operations
 */
function createMockSupabaseClient() {
  const addresses: Map<string, any> = new Map();
  let addressIdCounter = 1;

  return {
    from: (table: string) => {
      if (table === 'customer_addresses') {
        return {
          insert: (data: any) => ({
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
          }),
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
      };
    },
    // Store for test verification
    _addresses: addresses,
  };
}

/**
 * Generate a valid UUID v4
 * This simulates what Supabase/PostgreSQL would generate for new records
 */
function generateUUID(): string {
  // Generate random bytes and format as UUID v4
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  
  // Set version (4) and variant (8, 9, a, or b)
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx
  
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mock Supabase client that generates proper UUIDs (simulating real Supabase behavior)
 * This is used for Property 2 testing to verify UUID generation
 */
function createMockSupabaseClientWithUUID() {
  const addresses: Map<string, any> = new Map();

  return {
    from: (table: string) => {
      if (table === 'customer_addresses') {
        return {
          insert: (data: any) => ({
            select: () => ({
              single: async () => {
                // Generate a proper UUID like Supabase would
                const id = generateUUID();
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
          }),
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
      };
    },
    _addresses: addresses,
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
 * Arbitrary for generating valid floor numbers
 */
const floorNumberArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.stringMatching(/^[0-9]{1,2}$/)
);

/**
 * Arbitrary for generating valid address types
 */
const addressTypeArb: fc.Arbitrary<'home' | 'work' | 'other'> = fc.constantFrom('home', 'work', 'other');

/**
 * Arbitrary for generating delivery notes
 */
const deliveryNotesArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.string({ minLength: 0, maxLength: 200 })
);

/**
 * Arbitrary for generating complete address objects
 */
const addressArb = fc.record({
  street_address: streetAddressArb,
  city: cityArb,
  postal_code: postalCodeArb,
  floor_number: floorNumberArb,
  address_type: addressTypeArb,
  is_default: fc.boolean(),
  delivery_notes: deliveryNotesArb,
});

describe('Customer Address Sync Property Tests', () => {
  /**
   * **Feature: pos-customer-address-sync-fix, Property 1: Address Round-Trip Consistency**
   * **Validates: Requirements 1.1, 3.1, 3.2, 3.3, 3.4**
   * 
   * Property: For any valid customer address with all fields populated,
   * saving the address via `addAddress` and then retrieving it should preserve
   * all field values (street_address, city, postal_code, floor_number, 
   * address_type, is_default, delivery_notes).
   */
  it('Property 1: Address Round-Trip Consistency - all fields preserved after save', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        async (customerId, addressInput) => {
          // Create mock Supabase client
          const mockClient = createMockSupabaseClient();
          
          // Create service instance
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal', organizationId: 'test-org' }
          );

          // Add address
          const savedAddress = await service.addAddress(customerId, addressInput);

          // Verify all fields are preserved
          // street_address should be preserved (mapped from street_address input)
          expect(savedAddress.street_address).toBe(addressInput.street_address);
          
          // city should be preserved
          expect(savedAddress.city).toBe(addressInput.city);
          
          // postal_code should be preserved
          expect(savedAddress.postal_code).toBe(addressInput.postal_code);
          
          // floor_number should be preserved
          expect(savedAddress.floor_number).toBe(addressInput.floor_number);
          
          // address_type should be preserved
          expect(savedAddress.address_type).toBe(addressInput.address_type);
          
          // is_default should be preserved
          expect(savedAddress.is_default).toBe(addressInput.is_default);
          
          // delivery_notes should be preserved
          expect(savedAddress.delivery_notes).toBe(addressInput.delivery_notes);
          
          // customer_id should be set correctly
          expect(savedAddress.customer_id).toBe(customerId);
          
          // version should be initialized to 1 for new addresses
          expect(savedAddress.version).toBe(1);
          
          // id should be a valid string (not empty)
          expect(savedAddress.id).toBeTruthy();
          expect(typeof savedAddress.id).toBe('string');
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property 1a: Field alias compatibility - 'street' maps to 'street_address'
   * **Validates: Requirements 3.1, 6.2**
   */
  it('Property 1a: Field alias - street maps to street_address', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        streetAddressArb,
        cityArb,
        async (customerId, street, city) => {
          const mockClient = createMockSupabaseClient();
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal' }
          );

          // Use 'street' field name (alias)
          const addressInput = {
            street, // Using alias
            city,
            address_type: 'home' as const,
            is_default: false,
          };

          const savedAddress = await service.addAddress(customerId, addressInput);

          // street_address should contain the value from 'street' input
          expect(savedAddress.street_address).toBe(street);
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property 1b: New addresses have version=1
   * **Validates: Requirements 4.1**
   */
  it('Property 1b: New addresses have version=1', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        async (customerId, addressInput) => {
          const mockClient = createMockSupabaseClient();
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal' }
          );

          const savedAddress = await service.addAddress(customerId, addressInput);

          // Version should always be 1 for new addresses
          expect(savedAddress.version).toBe(1);
        }
      ),
      { verbose: true }
    );
  });

  /**
   * **Feature: pos-customer-address-sync-fix, Property 2: Valid UUID Generation**
   * **Validates: Requirements 1.3**
   * 
   * Property: For any address created via `addAddress`, the returned address ID
   * should be a valid UUID (not a timestamp-based fake ID like `addr-1234567890`).
   * 
   * A valid UUID follows the format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   * where x is a hexadecimal digit (0-9, a-f).
   */
  it('Property 2: Valid UUID Generation - address IDs are valid UUIDs', async () => {
    // UUID v4 regex pattern
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // General UUID regex (any version)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Fake ID pattern to reject
    const fakeIdPattern = /^addr-\d+$/;

    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        async (customerId, addressInput) => {
          // Create mock Supabase client that returns UUID-like IDs (simulating real Supabase)
          const mockClient = createMockSupabaseClientWithUUID();
          
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal', organizationId: 'test-org' }
          );

          const savedAddress = await service.addAddress(customerId, addressInput);

          // ID should exist and be a string
          expect(savedAddress.id).toBeTruthy();
          expect(typeof savedAddress.id).toBe('string');

          // ID should NOT be a fake timestamp-based ID
          expect(savedAddress.id).not.toMatch(fakeIdPattern);

          // ID should be a valid UUID format
          expect(savedAddress.id).toMatch(uuidRegex);
        }
      ),
      { verbose: true }
    );
  });
});
