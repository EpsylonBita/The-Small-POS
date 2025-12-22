/**
 * Property-Based Tests for Version Control and Conflict Detection
 * 
 * **Feature: pos-customer-address-sync-fix**
 * 
 * These tests verify version control and conflict detection behavior
 * for customer address synchronization.
 */

import * as fc from 'fast-check';
import { CustomerSyncService } from '../../../shared/services/CustomerSyncService';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

/**
 * Generate a valid UUID v4
 */
function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mock Supabase client for testing address operations with version control
 */
function createMockSupabaseClient() {
  const addresses: Map<string, any> = new Map();
  const conflicts: Map<string, any> = new Map();

  return {
    from: (table: string) => {
      if (table === 'customer_addresses') {
        return {
          insert: (data: any) => ({
            select: () => ({
              single: async () => {
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
          update: (data: any) => ({
            eq: (field: string, value: any) => {
              // Store the first eq condition
              const conditions: Record<string, any> = { [field]: value };
              return {
                eq: (field2: string, value2: any) => {
                  conditions[field2] = value2;
                  return {
                    select: () => ({
                      single: async () => {
                        // Find address by id
                        const addressId = conditions['id'];
                        const expectedVersion = conditions['version'];
                        const address = addresses.get(addressId);
                        
                        if (!address) {
                          return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                        }
                        
                        // Check version match (optimistic locking)
                        if (address.version !== expectedVersion) {
                          return { data: null, error: { code: 'PGRST116', message: 'Version mismatch' } };
                        }
                        
                        // Update the address
                        const updatedAddress = {
                          ...address,
                          ...data,
                          version: address.version + 1,
                          updated_at: new Date().toISOString(),
                        };
                        addresses.set(addressId, updatedAddress);
                        return { data: updatedAddress, error: null };
                      },
                    }),
                  };
                },
              };
            },
          }),
          select: (fields?: string) => ({
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
      if (table === 'customer_sync_conflicts') {
        return {
          insert: (data: any) => ({
            select: () => ({
              single: async () => {
                const id = generateUUID();
                const conflictData = {
                  id,
                  ...data,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                };
                conflicts.set(id, conflictData);
                return { data: conflictData, error: null };
              },
            }),
          }),
          select: (fields?: string) => ({
            eq: (field: string, value: string) => ({
              single: async () => {
                const conflict = conflicts.get(value);
                if (conflict) {
                  return { data: conflict, error: null };
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
    _conflicts: conflicts,
  };
}

// Arbitraries
const customerIdArb = fc.uuid();
const streetAddressArb = fc.string({ minLength: 5, maxLength: 100 });
const cityArb = fc.string({ minLength: 2, maxLength: 50 });
const postalCodeArb = fc.stringMatching(/^[0-9]{5}$/);
const floorNumberArb = fc.oneof(fc.constant(null), fc.stringMatching(/^[0-9]{1,2}$/));
const addressTypeArb: fc.Arbitrary<'home' | 'work' | 'other'> = fc.constantFrom('home', 'work', 'other');
const deliveryNotesArb = fc.oneof(fc.constant(null), fc.string({ minLength: 0, maxLength: 200 }));

const addressArb = fc.record({
  street_address: streetAddressArb,
  city: cityArb,
  postal_code: postalCodeArb,
  floor_number: floorNumberArb,
  address_type: addressTypeArb,
  is_default: fc.boolean(),
  delivery_notes: deliveryNotesArb,
});

describe('Version Control Property Tests', () => {
  /**
   * **Feature: pos-customer-address-sync-fix, Property 5: New Address Version Invariant**
   * **Validates: Requirements 4.1**
   * 
   * Property: For any newly created address, the version field should equal 1.
   */
  it('Property 5: New Address Version Invariant - new addresses always have version=1', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        async (customerId, addressInput) => {
          const mockClient = createMockSupabaseClient();
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal', organizationId: 'test-org' }
          );

          const savedAddress = await service.addAddress(customerId, addressInput);

          // Version should ALWAYS be 1 for new addresses
          expect(savedAddress.version).toBe(1);
        }
      ),
      { verbose: true }
    );
  });


  /**
   * **Feature: pos-customer-address-sync-fix, Property 6: Version Mismatch Detection**
   * **Validates: Requirements 4.2, 4.3**
   * 
   * Property: For any address update where the provided version does not match
   * the current database version, the operation should return a conflict result
   * (not succeed silently).
   */
  it('Property 6: Version Mismatch Detection - conflict returned on version mismatch', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        addressArb,
        fc.integer({ min: 2, max: 100 }), // Wrong version (not 1)
        async (customerId, initialAddress, updateAddress, wrongVersion) => {
          const mockClient = createMockSupabaseClient();
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal', organizationId: 'test-org' }
          );

          // First, create an address (version will be 1)
          const savedAddress = await service.addAddress(customerId, initialAddress);
          expect(savedAddress.version).toBe(1);

          // Try to update with wrong version (not 1)
          const result = await service.updateAddress(
            savedAddress.id,
            updateAddress,
            wrongVersion // This is NOT the current version (1)
          );

          // Should return a conflict result, not succeed
          expect(result).toHaveProperty('conflict', true);
          expect(result).toHaveProperty('conflictId');
          expect(result).toHaveProperty('localVersion', wrongVersion);
          expect(result).toHaveProperty('remoteVersion', 1);
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property 6a: Successful update with correct version
   * **Validates: Requirements 4.2**
   * 
   * Property: For any address update where the provided version matches
   * the current database version, the operation should succeed.
   */
  it('Property 6a: Successful update with correct version', async () => {
    await fc.assert(
      fc.asyncProperty(
        customerIdArb,
        addressArb,
        addressArb,
        async (customerId, initialAddress, updateAddress) => {
          const mockClient = createMockSupabaseClient();
          const service = new CustomerSyncService(
            mockClient as any,
            'pos-system',
            { terminalId: 'test-terminal', organizationId: 'test-org' }
          );

          // Create an address (version will be 1)
          const savedAddress = await service.addAddress(customerId, initialAddress);
          expect(savedAddress.version).toBe(1);

          // Update with correct version (1)
          const result = await service.updateAddress(
            savedAddress.id,
            updateAddress,
            1 // Correct version
          );

          // Should NOT be a conflict
          expect(result).not.toHaveProperty('conflict');
          
          // Should have updated fields
          if ('street_address' in result) {
            expect(result.street_address).toBe(updateAddress.street_address);
          }
        }
      ),
      { verbose: true }
    );
  });
});
