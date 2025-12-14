/**
 * Printer Services Module
 * 
 * Contains core services for printer management:
 * - PrinterManager (main orchestrator)
 * - PrintQueueService (job queuing)
 * - JobRouter (job routing)
 * - StatusMonitor (status monitoring)
 * - PrinterConfigStore (configuration persistence)
 * - EscPosBuilder (ESC/POS command generation)
 */

// Database schema and initialization
export * from './PrinterDatabaseSchema';

// Configuration persistence
export { PrinterConfigStore } from './PrinterConfigStore';

// Print queue service
export { PrintQueueService } from './PrintQueueService';

// ESC/POS command generation
export * from './escpos';

// Job routing
export { JobRouter } from './JobRouter';
export type {
  RoutingEntry,
  CategoryRoutingEntry,
  FallbackEntry,
  RoutingResult,
  SplitOrderResult,
  PrinterStatusProvider,
} from './JobRouter';

// Status monitoring
export {
  StatusMonitor,
  StatusMonitorEvent,
  DEFAULT_MONITORING_INTERVAL,
  ERROR_CODE_MESSAGES,
  getErrorMessage,
  isValidPrinterState,
} from './StatusMonitor';
export type {
  StatusCheckProvider,
  QueueLengthProvider,
} from './StatusMonitor';

// Main orchestrator
export {
  PrinterManager,
  PrinterManagerEvent,
} from './PrinterManager';
export type {
  PrinterManagerOptions,
} from './PrinterManager';
