/**
 * Property-Based Tests for Status Event Emission
 *
 * **Feature: pos-printer-drivers, Property 5: Status Event Emission**
 * **Validates: Requirements 7.2, 7.3, 7.4**
 *
 * This test verifies that for any printer state change (online to offline,
 * offline to online, or error condition), the system should emit exactly
 * one status change event with the correct new state, and the status
 * should be one of the valid states (online, offline, error, busy).
 */

import * as fc from 'fast-check';
import {
  StatusMonitor,
  StatusMonitorEvent,
  getErrorMessage,
  isValidPrinterState,
} from '../main/printer/services/StatusMonitor';
import {
  PrinterState,
  PrinterErrorCode,
  PrinterStatus,
} from '../main/printer/types';

// Configure fast-check for minimum 100 iterations
fc.configureGlobal({
  numRuns: 100,
  verbose: true,
});

// ============================================================================
// Arbitraries for generating valid status data
// ============================================================================

/**
 * Arbitrary for generating valid printer states
 */
const printerStateArb: fc.Arbitrary<PrinterState> = fc.constantFrom(
  PrinterState.ONLINE,
  PrinterState.OFFLINE,
  PrinterState.ERROR,
  PrinterState.BUSY
);

/**
 * Arbitrary for generating valid printer error codes
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

/**
 * Arbitrary for generating valid UUIDs (printer IDs)
 */
const printerIdArb: fc.Arbitrary<string> = fc.uuid();

/**
 * Arbitrary for generating state transitions
 */
const stateTransitionArb: fc.Arbitrary<{
  fromState: PrinterState;
  toState: PrinterState;
  errorCode?: PrinterErrorCode;
}> = fc.record({
  fromState: printerStateArb,
  toState: printerStateArb,
  errorCode: fc.option(printerErrorCodeArb, { nil: undefined }),
});

/**
 * Arbitrary for generating sequences of state changes
 */
const stateSequenceArb: fc.Arbitrary<PrinterState[]> = fc.array(printerStateArb, {
  minLength: 2,
  maxLength: 10,
});

// ============================================================================
// Property Tests
// ============================================================================

describe('Status Event Emission Property Tests', () => {
  /**
   * **Feature: pos-printer-drivers, Property 5: Status Event Emission**
   * **Validates: Requirements 7.2, 7.3, 7.4**
   */
  describe('Property 5: Status Event Emission', () => {
    let statusMonitor: StatusMonitor;

    beforeEach(() => {
      statusMonitor = new StatusMonitor();
    });

    afterEach(() => {
      statusMonitor.destroy();
    });

    it('emits exactly one event when state changes', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerIdArb,
          stateTransitionArb,
          async (printerId, transition) => {
            // Skip if states are the same (no change expected)
            if (transition.fromState === transition.toState && !transition.errorCode) {
              return true;
            }

            let eventCount = 0;
            let receivedStatus: PrinterStatus | null = null;

            // Set up event listener
            const callback = (id: string, status: PrinterStatus) => {
              if (id === printerId) {
                eventCount++;
                receivedStatus = status;
              }
            };
            statusMonitor.onStatusChange(callback);

            // Set initial state
            statusMonitor.updatePrinterState(printerId, transition.fromState);
            
            // Reset event count after initial state
            eventCount = 0;
            receivedStatus = null;

            // Trigger state change
            statusMonitor.updatePrinterState(
              printerId,
              transition.toState,
              transition.errorCode
            );

            // Verify exactly one event was emitted for the state change
            if (transition.fromState !== transition.toState || transition.errorCode) {
              expect(eventCount).toBe(1);
              expect(receivedStatus).not.toBeNull();
              expect(receivedStatus!.state).toBe(transition.toState);
            }

            // Clean up
            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('emitted status has valid state', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerIdArb,
          printerStateArb,
          fc.option(printerErrorCodeArb, { nil: undefined }),
          async (printerId, state, errorCode) => {
            let receivedStatus: PrinterStatus | null = null;

            const callback = (_id: string, status: PrinterStatus) => {
              receivedStatus = status;
            };
            statusMonitor.onStatusChange(callback);

            // First set a different initial state to ensure a change occurs
            const initialState = state === PrinterState.ONLINE ? PrinterState.OFFLINE : PrinterState.ONLINE;
            statusMonitor.updatePrinterState(printerId, initialState);
            receivedStatus = null; // Reset after initial state

            // Trigger state update (this will be a change)
            statusMonitor.updatePrinterState(printerId, state, errorCode);

            // Verify the status has a valid state
            expect(receivedStatus).not.toBeNull();
            expect(isValidPrinterState(receivedStatus!.state)).toBe(true);
            expect(Object.values(PrinterState)).toContain(receivedStatus!.state);

            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('status contains correct printer ID', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerIdArb,
          printerStateArb,
          async (printerId, state) => {
            let receivedPrinterId: string | null = null;
            let receivedStatus: PrinterStatus | null = null;

            const callback = (id: string, status: PrinterStatus) => {
              receivedPrinterId = id;
              receivedStatus = status;
            };
            statusMonitor.onStatusChange(callback);

            // First set a different initial state to ensure a change occurs
            const initialState = state === PrinterState.ONLINE ? PrinterState.OFFLINE : PrinterState.ONLINE;
            statusMonitor.updatePrinterState(printerId, initialState);
            receivedPrinterId = null;
            receivedStatus = null;

            // Now trigger the actual state change
            statusMonitor.updatePrinterState(printerId, state);

            // Verify printer ID matches
            expect(receivedPrinterId).toBe(printerId);
            expect(receivedStatus!.printerId).toBe(printerId);

            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('error state includes error code when provided', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerIdArb,
          printerErrorCodeArb,
          async (printerId, errorCode) => {
            let receivedStatus: PrinterStatus | null = null;

            const callback = (_id: string, status: PrinterStatus) => {
              receivedStatus = status;
            };
            statusMonitor.onStatusChange(callback);

            // First set to ONLINE state
            statusMonitor.updatePrinterState(printerId, PrinterState.ONLINE);
            receivedStatus = null;

            // Update to error state with error code (this is a state change)
            statusMonitor.updatePrinterState(
              printerId,
              PrinterState.ERROR,
              errorCode
            );

            // Verify error code is included
            expect(receivedStatus).not.toBeNull();
            expect(receivedStatus!.errorCode).toBe(errorCode);
            expect(receivedStatus!.errorMessage).toBeDefined();
            expect(receivedStatus!.errorMessage!.length).toBeGreaterThan(0);

            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('status includes lastSeen timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          printerIdArb,
          printerStateArb,
          async (printerId, state) => {
            let receivedStatus: PrinterStatus | null = null;

            const callback = (_id: string, status: PrinterStatus) => {
              receivedStatus = status;
            };
            statusMonitor.onStatusChange(callback);

            // First set a different initial state to ensure a change occurs
            const initialState = state === PrinterState.ONLINE ? PrinterState.OFFLINE : PrinterState.ONLINE;
            statusMonitor.updatePrinterState(printerId, initialState);
            receivedStatus = null;

            const beforeUpdate = new Date();
            statusMonitor.updatePrinterState(printerId, state);
            const afterUpdate = new Date();

            // Verify lastSeen is within the expected time range
            expect(receivedStatus).not.toBeNull();
            expect(receivedStatus!.lastSeen).toBeInstanceOf(Date);
            expect(receivedStatus!.lastSeen.getTime()).toBeGreaterThanOrEqual(
              beforeUpdate.getTime()
            );
            expect(receivedStatus!.lastSeen.getTime()).toBeLessThanOrEqual(
              afterUpdate.getTime()
            );

            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('no event emitted when state does not change', async () => {
      await fc.assert(
        fc.asyncProperty(printerIdArb, printerStateArb, async (printerId, state) => {
          let eventCount = 0;

          const callback = (id: string, _status: PrinterStatus) => {
            if (id === printerId) {
              eventCount++;
            }
          };
          statusMonitor.onStatusChange(callback);

          // First set a different initial state to ensure we get an event
          const initialState = state === PrinterState.ONLINE ? PrinterState.OFFLINE : PrinterState.ONLINE;
          statusMonitor.updatePrinterState(printerId, initialState);
          
          // Now set to target state (this should emit)
          statusMonitor.updatePrinterState(printerId, state);
          const countAfterFirstChange = eventCount;

          // Update to same state again (should not emit)
          statusMonitor.updatePrinterState(printerId, state);
          expect(eventCount).toBe(countAfterFirstChange); // Should not have increased

          statusMonitor.offStatusChange(callback);
          return true;
        }),
        { verbose: true }
      );
    });

    it('handles multiple printers independently', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(printerIdArb, { minLength: 2, maxLength: 5 }),
          fc.array(printerStateArb, { minLength: 2, maxLength: 5 }),
          async (printerIds, states) => {
            // Ensure unique printer IDs
            const uniqueIds = [...new Set(printerIds)];
            if (uniqueIds.length < 2) return true;

            const receivedEvents: Map<string, PrinterStatus[]> = new Map();

            const callback = (id: string, status: PrinterStatus) => {
              if (!receivedEvents.has(id)) {
                receivedEvents.set(id, []);
              }
              receivedEvents.get(id)!.push(status);
            };
            statusMonitor.onStatusChange(callback);

            // First set all printers to OFFLINE
            for (const id of uniqueIds) {
              statusMonitor.updatePrinterState(id, PrinterState.OFFLINE);
            }
            receivedEvents.clear(); // Clear initial events

            // Update each printer with a different state (ensuring it's different from OFFLINE)
            for (let i = 0; i < uniqueIds.length; i++) {
              let state = states[i % states.length];
              // Ensure state is different from OFFLINE to trigger an event
              if (state === PrinterState.OFFLINE) {
                state = PrinterState.ONLINE;
              }
              statusMonitor.updatePrinterState(uniqueIds[i], state);
            }

            // Verify each printer received its own events
            for (let i = 0; i < uniqueIds.length; i++) {
              const events = receivedEvents.get(uniqueIds[i]);
              expect(events).toBeDefined();
              expect(events!.length).toBeGreaterThanOrEqual(1);
              expect(events![0].printerId).toBe(uniqueIds[i]);
            }

            statusMonitor.offStatusChange(callback);
            return true;
          }
        ),
        { verbose: true }
      );
    });

    it('queueLength is non-negative', async () => {
      await fc.assert(
        fc.asyncProperty(printerIdArb, printerStateArb, async (printerId, state) => {
          let receivedStatus: PrinterStatus | null = null;

          const callback = (_id: string, status: PrinterStatus) => {
            receivedStatus = status;
          };
          statusMonitor.onStatusChange(callback);

          // First set a different initial state to ensure a change occurs
          const initialState = state === PrinterState.ONLINE ? PrinterState.OFFLINE : PrinterState.ONLINE;
          statusMonitor.updatePrinterState(printerId, initialState);
          receivedStatus = null;

          statusMonitor.updatePrinterState(printerId, state);

          // Verify queueLength is non-negative
          expect(receivedStatus).not.toBeNull();
          expect(receivedStatus!.queueLength).toBeGreaterThanOrEqual(0);

          statusMonitor.offStatusChange(callback);
          return true;
        }),
        { verbose: true }
      );
    });
  });

  /**
   * Additional tests for state machine validity
   */
  describe('State Machine Validity', () => {
    it('all PrinterState values are valid', () => {
      const allStates = Object.values(PrinterState);
      
      for (const state of allStates) {
        expect(isValidPrinterState(state)).toBe(true);
      }
    });

    it('invalid strings are not valid states', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter(s => !Object.values(PrinterState).includes(s as PrinterState)),
          async (invalidState) => {
            expect(isValidPrinterState(invalidState)).toBe(false);
            return true;
          }
        ),
        { verbose: true }
      );
    });
  });
});
