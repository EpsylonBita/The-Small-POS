/**
 * Property-Based Tests for Error Message Mapping
 *
 * **Feature: pos-printer-drivers, Property 13: Error Message Mapping**
 * **Validates: Requirements 10.3**
 *
 * This test verifies that for any printer error code received from the hardware,
 * the system should map it to a user-friendly error message that is non-empty
 * and descriptive.
 */

import * as fc from 'fast-check';
import './propertyTestConfig';
import {
  getErrorMessage,
  ERROR_CODE_MESSAGES,
} from '../main/printer/services/StatusMonitor';
import { PrinterErrorCode } from '../main/printer/types';

// Configure fast-check
// Configuration is handled by propertyTestConfig.ts import

// ============================================================================
// Arbitraries for generating error codes
// ============================================================================

/**
 * Arbitrary for generating all valid printer error codes
 */
const printerErrorCodeArb: fc.Arbitrary<PrinterErrorCode> = fc.constantFrom(
  PrinterErrorCode.PAPER_OUT,
  PrinterErrorCode.COVER_OPEN,
  PrinterErrorCode.PAPER_JAM,
  PrinterErrorCode.CUTTER_ERROR,
  PrinterErrorCode.OVERHEATED,
  PrinterErrorCode.CONNECTION_LOST,
  PrinterErrorCode.UNKNOWN
);

// ============================================================================
// Property Tests
// ============================================================================

describe('Error Message Mapping Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 13: Error Message Mapping**
   * **Validates: Requirements 10.3**
   */
  describe('Property 13: Error Message Mapping', () => {
    it('every error code maps to a non-empty message', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // Message should be non-empty
          expect(message).toBeDefined();
          expect(typeof message).toBe('string');
          expect(message.length).toBeGreaterThan(0);

          return true;
        }),
        { verbose: true }
      );
    });

    it('every error code maps to a descriptive message (more than 10 characters)', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // Message should be descriptive (at least 10 characters)
          expect(message.length).toBeGreaterThan(10);

          return true;
        }),
        { verbose: true }
      );
    });

    it('error messages contain actionable information', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // Message should contain words that indicate action or status
          const hasActionableContent =
            message.toLowerCase().includes('please') ||
            message.toLowerCase().includes('check') ||
            message.toLowerCase().includes('is') ||
            message.toLowerCase().includes('has') ||
            message.toLowerCase().includes('detected') ||
            message.toLowerCase().includes('occurred') ||
            message.toLowerCase().includes('lost');

          expect(hasActionableContent).toBe(true);

          return true;
        }),
        { verbose: true }
      );
    });

    it('error messages are unique for different error codes', () => {
      const allErrorCodes = Object.values(PrinterErrorCode);
      const messages = new Set<string>();

      for (const errorCode of allErrorCodes) {
        const message = getErrorMessage(errorCode);
        messages.add(message);
      }

      // Each error code should have a unique message
      expect(messages.size).toBe(allErrorCodes.length);
    });

    it('ERROR_CODE_MESSAGES covers all PrinterErrorCode values', () => {
      const allErrorCodes = Object.values(PrinterErrorCode);

      for (const errorCode of allErrorCodes) {
        expect(ERROR_CODE_MESSAGES[errorCode]).toBeDefined();
        expect(ERROR_CODE_MESSAGES[errorCode].length).toBeGreaterThan(0);
      }
    });

    it('getErrorMessage returns consistent results for same error code', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message1 = getErrorMessage(errorCode);
          const message2 = getErrorMessage(errorCode);

          // Same error code should always return the same message
          expect(message1).toBe(message2);

          return true;
        }),
        { verbose: true }
      );
    });

    it('PAPER_OUT error message mentions paper', () => {
      const message = getErrorMessage(PrinterErrorCode.PAPER_OUT);
      expect(message.toLowerCase()).toContain('paper');
    });

    it('COVER_OPEN error message mentions cover', () => {
      const message = getErrorMessage(PrinterErrorCode.COVER_OPEN);
      expect(message.toLowerCase()).toContain('cover');
    });

    it('PAPER_JAM error message mentions jam', () => {
      const message = getErrorMessage(PrinterErrorCode.PAPER_JAM);
      expect(message.toLowerCase()).toContain('jam');
    });

    it('CUTTER_ERROR error message mentions cutter', () => {
      const message = getErrorMessage(PrinterErrorCode.CUTTER_ERROR);
      expect(message.toLowerCase()).toContain('cutter');
    });

    it('OVERHEATED error message mentions heat or temperature', () => {
      const message = getErrorMessage(PrinterErrorCode.OVERHEATED);
      const hasHeatReference =
        message.toLowerCase().includes('heat') ||
        message.toLowerCase().includes('cool') ||
        message.toLowerCase().includes('temperature');
      expect(hasHeatReference).toBe(true);
    });

    it('CONNECTION_LOST error message mentions connection', () => {
      const message = getErrorMessage(PrinterErrorCode.CONNECTION_LOST);
      expect(message.toLowerCase()).toContain('connection');
    });

    it('UNKNOWN error message is generic but informative', () => {
      const message = getErrorMessage(PrinterErrorCode.UNKNOWN);
      expect(message.length).toBeGreaterThan(10);
      expect(message.toLowerCase()).toContain('error');
    });
  });

  /**
   * Additional tests for edge cases
   */
  describe('Error Message Edge Cases', () => {
    it('messages do not contain raw error codes', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // Message should not contain the raw error code string
          expect(message).not.toContain(errorCode);

          return true;
        }),
        { verbose: true }
      );
    });

    it('messages are properly capitalized', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // First character should be uppercase
          expect(message[0]).toBe(message[0].toUpperCase());

          return true;
        }),
        { verbose: true }
      );
    });

    it('messages end with proper punctuation', async () => {
      await fc.assert(
        fc.asyncProperty(printerErrorCodeArb, async (errorCode) => {
          const message = getErrorMessage(errorCode);

          // Message should end with a period
          expect(message.endsWith('.')).toBe(true);

          return true;
        }),
        { verbose: true }
      );
    });
  });
});
