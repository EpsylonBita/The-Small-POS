/**
 * Property-Based Tests for Printer Configuration Validation
 *
 * **Feature: pos-printer-drivers, Property 11: Network Configuration Validation**
 * **Validates: Requirements 2.1**
 *
 * This test verifies that for any network printer configuration, the system
 * should accept valid IPv4 addresses with ports in range 1-65535, and reject
 * invalid IP addresses or out-of-range ports.
 */

import * as fc from 'fast-check';
import {
  isValidIPv4,
  isValidPort,
  isValidMACAddress,
  isValidRFCOMMChannel,
  isValidUSBId,
  validateNetworkIP,
  validatePort,
  validateMACAddress,
  validateRFCOMMChannel,
  validateUSBIds,
  validateNetworkConnectionDetails,
  validateBluetoothConnectionDetails,
  validateUSBConnectionDetails,
  normalizeMACAddress,
} from '../main/printer/types/validation';
import { NetworkConnectionDetails, BluetoothConnectionDetails, USBConnectionDetails } from '../main/printer/types';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Arbitraries for generating valid and invalid values
// ============================================================================

/**
 * Arbitrary for generating valid IPv4 octets (0-255)
 */
const validOctetArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

/**
 * Arbitrary for generating invalid IPv4 octets (outside 0-255)
 */
const invalidOctetArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: -1 }),
  fc.integer({ min: 256, max: 1000 })
);

/**
 * Arbitrary for generating valid IPv4 addresses
 */
const validIPv4Arb: fc.Arbitrary<string> = fc
  .tuple(validOctetArb, validOctetArb, validOctetArb, validOctetArb)
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/**
 * Arbitrary for generating valid IPv4 addresses suitable for network printers
 * (excludes 0.0.0.0 and 255.255.255.255)
 */
const validNetworkIPArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1, max: 254 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 })
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/**
 * Arbitrary for generating invalid IPv4 addresses (malformed)
 */
const invalidIPv4FormatArb: fc.Arbitrary<string> = fc.oneof(
  // Too few octets
  fc.tuple(validOctetArb, validOctetArb).map(([a, b]) => `${a}.${b}`),
  fc.tuple(validOctetArb, validOctetArb, validOctetArb).map(([a, b, c]) => `${a}.${b}.${c}`),
  // Too many octets
  fc.tuple(validOctetArb, validOctetArb, validOctetArb, validOctetArb, validOctetArb).map(
    ([a, b, c, d, e]) => `${a}.${b}.${c}.${d}.${e}`
  ),
  // Non-numeric
  fc.constant('abc.def.ghi.jkl'),
  fc.constant('192.168.1.abc'),
  // Empty or whitespace
  fc.constant(''),
  fc.constant('   '),
  // Invalid separators
  fc.tuple(validOctetArb, validOctetArb, validOctetArb, validOctetArb).map(
    ([a, b, c, d]) => `${a}:${b}:${c}:${d}`
  )
);

/**
 * Arbitrary for generating valid port numbers (1-65535)
 */
const validPortArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 65535 });

/**
 * Arbitrary for generating invalid port numbers
 */
const invalidPortArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),
  fc.integer({ min: 65536, max: 100000 })
);

/**
 * Arbitrary for generating valid MAC addresses (colon-separated)
 */
const validMACColonArb: fc.Arbitrary<string> = fc
  .array(
    fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, '0').toUpperCase()),
    { minLength: 6, maxLength: 6 }
  )
  .map((parts) => parts.join(':'));

/**
 * Arbitrary for generating valid MAC addresses (dash-separated)
 */
const validMACDashArb: fc.Arbitrary<string> = fc
  .array(
    fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, '0').toUpperCase()),
    { minLength: 6, maxLength: 6 }
  )
  .map((parts) => parts.join('-'));

/**
 * Arbitrary for generating valid MAC addresses (no separator)
 */
const validMACNoSepArb: fc.Arbitrary<string> = fc
  .array(
    fc.integer({ min: 0, max: 255 }).map((n) => n.toString(16).padStart(2, '0').toUpperCase()),
    { minLength: 6, maxLength: 6 }
  )
  .map((parts) => parts.join(''));

/**
 * Arbitrary for generating any valid MAC address format
 */
const validMACArb: fc.Arbitrary<string> = fc.oneof(
  validMACColonArb,
  validMACDashArb,
  validMACNoSepArb
);

/**
 * Arbitrary for generating invalid MAC addresses
 * Note: Mixed separators (AA:BB-CC:DD-EE:FF) are actually valid per the regex
 * as they still match the colon or dash pattern for each pair
 */
const invalidMACArb: fc.Arbitrary<string> = fc.oneof(
  // Too short
  fc.constant('AA:BB:CC:DD:EE'),
  fc.constant('AABBCCDDEE'),
  // Too long
  fc.constant('AA:BB:CC:DD:EE:FF:GG'),
  fc.constant('AABBCCDDEEFFGG'),
  // Invalid characters
  fc.constant('GG:HH:II:JJ:KK:LL'),
  fc.constant('ZZ:YY:XX:WW:VV:UU'),
  // Empty
  fc.constant('')
);

/**
 * Arbitrary for generating valid RFCOMM channels (1-30)
 */
const validRFCOMMArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 30 });

/**
 * Arbitrary for generating invalid RFCOMM channels
 */
const invalidRFCOMMArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -100, max: 0 }),
  fc.integer({ min: 31, max: 100 })
);

/**
 * Arbitrary for generating valid USB IDs (0-65535)
 */
const validUSBIdArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 65535 });

/**
 * Arbitrary for generating invalid USB IDs
 */
const invalidUSBIdArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: -1 }),
  fc.integer({ min: 65536, max: 100000 })
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Printer Validation Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 11: Network Configuration Validation**
   * **Validates: Requirements 2.1**
   */
  describe('Property 11: Network Configuration Validation', () => {
    describe('IPv4 Address Validation', () => {
      it('accepts all valid IPv4 addresses', async () => {
        await fc.assert(
          fc.asyncProperty(validIPv4Arb, async (ip) => {
            expect(isValidIPv4(ip)).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('rejects malformed IPv4 addresses', async () => {
        await fc.assert(
          fc.asyncProperty(invalidIPv4FormatArb, async (ip) => {
            expect(isValidIPv4(ip)).toBe(false);
          }),
          { verbose: true }
        );
      });

      it('validates network IP addresses (excludes reserved)', async () => {
        await fc.assert(
          fc.asyncProperty(validNetworkIPArb, async (ip) => {
            const result = validateNetworkIP(ip);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
          }),
          { verbose: true }
        );
      });

      it('rejects 0.0.0.0 for network printers', () => {
        const result = validateNetworkIP('0.0.0.0');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('IP address 0.0.0.0 is not allowed');
      });

      it('rejects 255.255.255.255 for network printers', () => {
        const result = validateNetworkIP('255.255.255.255');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Broadcast address 255.255.255.255 is not allowed');
      });
    });

    describe('Port Validation', () => {
      it('accepts all valid port numbers (1-65535)', async () => {
        await fc.assert(
          fc.asyncProperty(validPortArb, async (port) => {
            expect(isValidPort(port)).toBe(true);
            const result = validatePort(port);
            expect(result.valid).toBe(true);
          }),
          { verbose: true }
        );
      });

      it('rejects invalid port numbers', async () => {
        await fc.assert(
          fc.asyncProperty(invalidPortArb, async (port) => {
            expect(isValidPort(port)).toBe(false);
            const result = validatePort(port);
            expect(result.valid).toBe(false);
          }),
          { verbose: true }
        );
      });

      it('rejects non-integer port numbers', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.double({ min: 1.1, max: 65534.9, noNaN: true }),
            async (port) => {
              // Only test actual non-integers
              if (!Number.isInteger(port)) {
                expect(isValidPort(port)).toBe(false);
              }
            }
          ),
          { verbose: true }
        );
      });
    });

    describe('Network Connection Details Validation', () => {
      it('accepts valid network connection details', async () => {
        await fc.assert(
          fc.asyncProperty(
            validNetworkIPArb,
            validPortArb,
            async (ip, port) => {
              const details: NetworkConnectionDetails = {
                type: 'network',
                ip,
                port,
              };
              const result = validateNetworkConnectionDetails(details);
              expect(result.valid).toBe(true);
            }
          ),
          { verbose: true }
        );
      });

      it('rejects network details with invalid IP', async () => {
        await fc.assert(
          fc.asyncProperty(
            invalidIPv4FormatArb,
            validPortArb,
            async (ip, port) => {
              const details: NetworkConnectionDetails = {
                type: 'network',
                ip,
                port,
              };
              const result = validateNetworkConnectionDetails(details);
              expect(result.valid).toBe(false);
            }
          ),
          { verbose: true }
        );
      });

      it('rejects network details with invalid port', async () => {
        await fc.assert(
          fc.asyncProperty(
            validNetworkIPArb,
            invalidPortArb,
            async (ip, port) => {
              const details: NetworkConnectionDetails = {
                type: 'network',
                ip,
                port,
              };
              const result = validateNetworkConnectionDetails(details);
              expect(result.valid).toBe(false);
            }
          ),
          { verbose: true }
        );
      });
    });
  });

  /**
   * Additional validation tests for completeness
   */
  describe('MAC Address Validation', () => {
    it('accepts all valid MAC address formats', async () => {
      await fc.assert(
        fc.asyncProperty(validMACArb, async (mac) => {
          expect(isValidMACAddress(mac)).toBe(true);
          const result = validateMACAddress(mac);
          expect(result.valid).toBe(true);
        }),
        { verbose: true }
      );
    });

    it('rejects invalid MAC addresses', async () => {
      await fc.assert(
        fc.asyncProperty(invalidMACArb, async (mac) => {
          expect(isValidMACAddress(mac)).toBe(false);
          const result = validateMACAddress(mac);
          expect(result.valid).toBe(false);
        }),
        { verbose: true }
      );
    });

    it('normalizes MAC addresses to uppercase colon format', async () => {
      await fc.assert(
        fc.asyncProperty(validMACArb, async (mac) => {
          const normalized = normalizeMACAddress(mac);
          expect(normalized).not.toBeNull();
          expect(normalized).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
        }),
        { verbose: true }
      );
    });
  });

  describe('RFCOMM Channel Validation', () => {
    it('accepts valid RFCOMM channels (1-30)', async () => {
      await fc.assert(
        fc.asyncProperty(validRFCOMMArb, async (channel) => {
          expect(isValidRFCOMMChannel(channel)).toBe(true);
          const result = validateRFCOMMChannel(channel);
          expect(result.valid).toBe(true);
        }),
        { verbose: true }
      );
    });

    it('rejects invalid RFCOMM channels', async () => {
      await fc.assert(
        fc.asyncProperty(invalidRFCOMMArb, async (channel) => {
          expect(isValidRFCOMMChannel(channel)).toBe(false);
          const result = validateRFCOMMChannel(channel);
          expect(result.valid).toBe(false);
        }),
        { verbose: true }
      );
    });
  });

  describe('USB ID Validation', () => {
    it('accepts valid USB IDs (0-65535)', async () => {
      await fc.assert(
        fc.asyncProperty(validUSBIdArb, validUSBIdArb, async (vendorId, productId) => {
          expect(isValidUSBId(vendorId)).toBe(true);
          expect(isValidUSBId(productId)).toBe(true);
          const result = validateUSBIds(vendorId, productId);
          expect(result.valid).toBe(true);
        }),
        { verbose: true }
      );
    });

    it('rejects invalid USB vendor IDs', async () => {
      await fc.assert(
        fc.asyncProperty(invalidUSBIdArb, validUSBIdArb, async (vendorId, productId) => {
          const result = validateUSBIds(vendorId, productId);
          expect(result.valid).toBe(false);
        }),
        { verbose: true }
      );
    });

    it('rejects invalid USB product IDs', async () => {
      await fc.assert(
        fc.asyncProperty(validUSBIdArb, invalidUSBIdArb, async (vendorId, productId) => {
          const result = validateUSBIds(vendorId, productId);
          expect(result.valid).toBe(false);
        }),
        { verbose: true }
      );
    });
  });

  describe('Bluetooth Connection Details Validation', () => {
    it('accepts valid Bluetooth connection details', async () => {
      await fc.assert(
        fc.asyncProperty(
          validMACArb,
          validRFCOMMArb,
          async (address, channel) => {
            const details: BluetoothConnectionDetails = {
              type: 'bluetooth',
              address,
              channel,
            };
            const result = validateBluetoothConnectionDetails(details);
            expect(result.valid).toBe(true);
          }
        ),
        { verbose: true }
      );
    });

    it('rejects Bluetooth details with invalid MAC', async () => {
      await fc.assert(
        fc.asyncProperty(
          invalidMACArb,
          validRFCOMMArb,
          async (address, channel) => {
            const details: BluetoothConnectionDetails = {
              type: 'bluetooth',
              address,
              channel,
            };
            const result = validateBluetoothConnectionDetails(details);
            expect(result.valid).toBe(false);
          }
        ),
        { verbose: true }
      );
    });
  });

  describe('USB Connection Details Validation', () => {
    it('accepts valid USB connection details', async () => {
      await fc.assert(
        fc.asyncProperty(
          validUSBIdArb,
          validUSBIdArb,
          async (vendorId, productId) => {
            const details: USBConnectionDetails = {
              type: 'usb',
              vendorId,
              productId,
            };
            const result = validateUSBConnectionDetails(details);
            expect(result.valid).toBe(true);
          }
        ),
        { verbose: true }
      );
    });
  });
});
