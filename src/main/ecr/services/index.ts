/**
 * ECR Services Module
 *
 * Exports service implementations for ECR device management.
 *
 * @module ecr/services
 */

// Database schema
export {
  initializeECRSchema,
  isECRSchemaInitialized,
} from './ECRDatabaseSchema';

// Configuration store
export { ECRConfigStore } from './ECRConfigStore';

// Transaction logging
export {
  TransactionLogService,
  type TransactionFilters,
  type TransactionStats,
} from './TransactionLogService';

// Payment terminal service
export {
  PaymentTerminalService,
  PaymentTerminalServiceEvent,
} from './PaymentTerminalService';

// Main manager
export {
  PaymentTerminalManager,
  PaymentTerminalManagerEvent,
  type PaymentTerminalManagerOptions,
} from './PaymentTerminalManager';
