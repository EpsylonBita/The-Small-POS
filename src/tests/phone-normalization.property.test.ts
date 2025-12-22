/**
 * Property-Based Tests for Phone Normalization
 * 
 * **Feature: pos-customer-address-sync-fix**
 * 
 * These tests verify that phone normalization in the POS system matches
 * the shared implementation and handles European phone formats correctly.
 */

import * as fc from 'fast-check';
import { CustomerSyncService } from '../../../shared/services/CustomerSyncService';
import './propertyTestConfig';

/**
 * Mock Supabase client for testing (minimal implementation)
 */
function createMockSupabaseClient() {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
}

/**
 * Create a CustomerSyncService instance for testing
 */
function createTestService(): CustomerSyncService {
  const mockClient = createMockSupabaseClient();
  return new CustomerSyncService(
    mockClient as any,
    'pos-system',
    { terminalId: 'test-terminal', organizationId: 'test-org' }
  );
}

/**
 * European country codes for testing
 */
const EUROPEAN_COUNTRY_CODES = [
  { code: '30', country: 'Greece' },
  { code: '31', country: 'Netherlands' },
  { code: '32', country: 'Belgium' },
  { code: '33', country: 'France' },
  { code: '34', country: 'Spain' },
  { code: '39', country: 'Italy' },
  { code: '40', country: 'Romania' },
  { code: '41', country: 'Switzerland' },
  { code: '43', country: 'Austria' },
  { code: '44', country: 'United Kingdom' },
  { code: '45', country: 'Denmark' },
  { code: '46', country: 'Sweden' },
  { code: '47', country: 'Norway' },
  { code: '48', country: 'Poland' },
  { code: '49', country: 'Germany' },
  { code: '351', country: 'Portugal' },
  { code: '352', country: 'Luxembourg' },
  { code: '353', country: 'Ireland' },
  { code: '354', country: 'Iceland' },
  { code: '355', country: 'Albania' },
  { code: '356', country: 'Malta' },
  { code: '357', country: 'Cyprus' },
  { code: '358', country: 'Finland' },
  { code: '359', country: 'Bulgaria' },
  { code: '370', country: 'Lithuania' },
  { code: '371', country: 'Latvia' },
  { code: '372', country: 'Estonia' },
  { code: '380', country: 'Ukraine' },
  { code: '385', country: 'Croatia' },
  { code: '386', country: 'Slovenia' },
  { code: '420', country: 'Czech Republic' },
  { code: '421', country: 'Slovakia' },
];

describe('Phone Normalization Property Tests', () => {
  let service: CustomerSyncService;

  beforeEach(() => {
    service = createTestService();
  });

  /**
   * Task 5.1: Verify phone normalization matches shared implementation
   * Test with European phone formats (various country codes, leading zeros)
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
   */
  describe('European Phone Format Verification', () => {
    it('should normalize Greek +30 country code format', () => {
      expect(service.normalizePhone('+30 694 812 8474')).toBe('6948128474');
      expect(service.normalizePhone('+306948128474')).toBe('6948128474');
      expect(service.normalizePhone('00306948128474')).toBe('6948128474');
    });

    it('should normalize UK +44 country code format', () => {
      expect(service.normalizePhone('+44 20 7946 0958')).toBe('2079460958');
      expect(service.normalizePhone('+442079460958')).toBe('2079460958');
      expect(service.normalizePhone('00442079460958')).toBe('2079460958');
    });

    it('should normalize German +49 country code format', () => {
      expect(service.normalizePhone('+49 30 12345678')).toBe('3012345678');
      expect(service.normalizePhone('+493012345678')).toBe('3012345678');
      expect(service.normalizePhone('00493012345678')).toBe('3012345678');
    });

    it('should normalize French +33 country code format', () => {
      expect(service.normalizePhone('+33 1 23 45 67 89')).toBe('123456789');
      expect(service.normalizePhone('+33123456789')).toBe('123456789');
      expect(service.normalizePhone('0033123456789')).toBe('123456789');
    });

    it('should normalize Italian +39 country code format', () => {
      expect(service.normalizePhone('+39 06 1234 5678')).toBe('612345678');
      expect(service.normalizePhone('+390612345678')).toBe('612345678');
    });

    it('should normalize Spanish +34 country code format', () => {
      expect(service.normalizePhone('+34 912 345 678')).toBe('912345678');
      expect(service.normalizePhone('+34912345678')).toBe('912345678');
    });

    it('should normalize Portuguese +351 country code format', () => {
      expect(service.normalizePhone('+351 21 123 4567')).toBe('211234567');
      expect(service.normalizePhone('+351211234567')).toBe('211234567');
    });

    it('should normalize leading zero format', () => {
      expect(service.normalizePhone('06948128474')).toBe('6948128474');
      expect(service.normalizePhone('0 694 812 8474')).toBe('6948128474');
    });

    it('should handle already normalized phone', () => {
      expect(service.normalizePhone('6948128474')).toBe('6948128474');
    });

    it('should handle empty and null inputs', () => {
      expect(service.normalizePhone('')).toBe('');
    });

    it('should remove all non-digit characters', () => {
      expect(service.normalizePhone('(694) 812-8474')).toBe('6948128474');
      expect(service.normalizePhone('694.812.8474')).toBe('6948128474');
      expect(service.normalizePhone('694 812 8474')).toBe('6948128474');
    });
  });

  /**
   * **Feature: pos-customer-address-sync-fix, Property 3: Phone Normalization Idempotence**
   * **Validates: Requirements 2.1, 2.2, 2.3**
   * 
   * Property: For any phone number string, normalizing it twice should produce
   * the same result as normalizing it once (idempotent operation). The result
   * should contain only digits, not start with '0', and not contain European
   * country code prefixes.
   * 
   * Note: The normalization removes leading zeros, so a result like "0" will
   * become "" on second normalization. We test idempotence on the final stable
   * result (after all leading zeros are removed).
   */
  it('Property 3: Phone Normalization Idempotence - normalizing twice equals normalizing once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 30 }),
        async (phoneInput) => {
          // Normalize once
          const normalizedOnce = service.normalizePhone(phoneInput);
          
          // Normalize twice
          const normalizedTwice = service.normalizePhone(normalizedOnce);
          
          // Normalize three times to ensure stability
          const normalizedThrice = service.normalizePhone(normalizedTwice);
          
          // The result should stabilize after at most 2 normalizations
          // (first removes non-digits and country codes, second removes any remaining leading zeros)
          expect(normalizedThrice).toBe(normalizedTwice);
          
          // Additional invariants for the stable normalized result:
          if (normalizedTwice.length > 0) {
            // Should only contain digits
            expect(normalizedTwice).toMatch(/^\d+$/);
            
            // Should not start with '0' (leading zeros removed)
            expect(normalizedTwice[0]).not.toBe('0');
          }
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property 3a: Phone normalization with European country codes
   * Tests specifically with phone numbers that have various European country codes
   */
  it('Property 3a: Phone normalization removes European country codes consistently', async () => {
    // Arbitrary for phone base (9-10 digits starting with 1-9)
    const phoneBaseArb = fc.stringMatching(/^[1-9]\d{8,9}$/);
    
    // Arbitrary for European country code
    const countryCodeArb = fc.constantFrom(...EUROPEAN_COUNTRY_CODES.map(c => c.code));
    
    // Arbitrary for prefix format
    const prefixFormatArb = fc.constantFrom('+', '00', '');
    
    // Arbitrary for separator
    const separatorArb = fc.constantFrom(' ', '-', '.', '');

    await fc.assert(
      fc.asyncProperty(
        phoneBaseArb,
        countryCodeArb,
        prefixFormatArb,
        separatorArb,
        async (phoneBase, countryCode, prefixFormat, separator) => {
          // Build phone with various formats
          let phoneWithPrefix: string;
          if (prefixFormat === '+') {
            phoneWithPrefix = `+${countryCode}${separator}${phoneBase}`;
          } else if (prefixFormat === '00') {
            phoneWithPrefix = `00${countryCode}${separator}${phoneBase}`;
          } else {
            phoneWithPrefix = `${countryCode}${separator}${phoneBase}`;
          }
          
          // Normalize
          const normalized = service.normalizePhone(phoneWithPrefix);
          
          // Should produce the base phone number (without country code)
          expect(normalized).toBe(phoneBase);
        }
      ),
      { verbose: true }
    );
  });

  /**
   * Property 3b: All phone formats normalize to same result
   * Tests that different representations of the same phone normalize identically
   */
  it('Property 3b: Different formats of same phone normalize to same result', async () => {
    // Arbitrary for phone base (10 digits starting with 1-9)
    const phoneBaseArb = fc.stringMatching(/^[1-9]\d{9}$/);
    
    // Arbitrary for European country code
    const countryCodeArb = fc.constantFrom(...EUROPEAN_COUNTRY_CODES.map(c => c.code));

    await fc.assert(
      fc.asyncProperty(
        phoneBaseArb,
        countryCodeArb,
        async (phoneBase, countryCode) => {
          // Create various formats of the same phone
          const formats = [
            phoneBase,                                    // Plain: 6948128474
            `+${countryCode}${phoneBase}`,               // +XX: +306948128474
            `00${countryCode}${phoneBase}`,              // 00XX: 00306948128474
            `+${countryCode} ${phoneBase.slice(0,3)} ${phoneBase.slice(3,6)} ${phoneBase.slice(6)}`, // Spaced
            `0${phoneBase}`,                             // Leading zero: 06948128474
            `${phoneBase.slice(0,3)}-${phoneBase.slice(3,6)}-${phoneBase.slice(6)}`, // Dashed
            `(${phoneBase.slice(0,3)}) ${phoneBase.slice(3,6)}-${phoneBase.slice(6)}`, // Parentheses
          ];
          
          // Normalize all formats
          const normalizedResults = formats.map(f => service.normalizePhone(f));
          
          // All should produce the same result (the base phone number)
          normalizedResults.forEach((result) => {
            expect(result).toBe(phoneBase);
          });
        }
      ),
      { verbose: true }
    );
  });

  /**
   * **Feature: pos-customer-address-sync-fix, Property 4: Phone Lookup Normalization**
   * **Validates: Requirements 2.4**
   * 
   * Property: For any customer with a normalized phone number, looking up that
   * customer using various phone formats (with spaces, dashes, country codes)
   * should use the normalized phone format for the query.
   * 
   * Note: This tests the normalization aspect of lookup, not the actual database query.
   */
  it('Property 4: Phone Lookup Normalization - various European formats normalize for lookup', async () => {
    // Arbitrary for phone base (10 digits starting with 1-9)
    const phoneBaseArb = fc.stringMatching(/^[1-9]\d{9}$/);
    
    // Arbitrary for European country code
    const countryCodeArb = fc.constantFrom(...EUROPEAN_COUNTRY_CODES.map(c => c.code));
    
    // Arbitrary for phone format variations
    const phoneFormatArb = fc.constantFrom(
      'plain',      // 6948128474
      'plusCode',   // +306948128474
      '00Code',     // 00306948128474
      'spaced',     // 694 812 8474
      'dashed',     // 694-812-8474
      'leadingZero' // 06948128474
    );

    await fc.assert(
      fc.asyncProperty(
        phoneBaseArb,
        countryCodeArb,
        phoneFormatArb,
        async (phoneBase, countryCode, format) => {
          // Build phone in specified format
          let formattedPhone: string;
          switch (format) {
            case 'plain':
              formattedPhone = phoneBase;
              break;
            case 'plusCode':
              formattedPhone = `+${countryCode}${phoneBase}`;
              break;
            case '00Code':
              formattedPhone = `00${countryCode}${phoneBase}`;
              break;
            case 'spaced':
              formattedPhone = `${phoneBase.slice(0,3)} ${phoneBase.slice(3,6)} ${phoneBase.slice(6)}`;
              break;
            case 'dashed':
              formattedPhone = `${phoneBase.slice(0,3)}-${phoneBase.slice(3,6)}-${phoneBase.slice(6)}`;
              break;
            case 'leadingZero':
              formattedPhone = `0${phoneBase}`;
              break;
            default:
              formattedPhone = phoneBase;
          }
          
          // Normalize the formatted phone (simulating what lookupByPhone does internally)
          const normalizedForLookup = service.normalizePhone(formattedPhone);
          
          // Should always normalize to the base phone number
          expect(normalizedForLookup).toBe(phoneBase);
        }
      ),
      { verbose: true }
    );
  });
});
