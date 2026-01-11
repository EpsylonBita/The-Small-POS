/**
 * Customer Sync Types for POS System
 *
 * Re-exports canonical types from shared for consistency.
 * The shared types now include all fields needed by POS (including name_on_ringer).
 */

// Re-export all types from shared customer-sync
export type {
  Customer,
  CustomerAddress,
  CustomerConflict,
  ConflictType,
  ResolutionStrategy,
  ConflictResult,
  ConflictResolutionResult,
  ConflictFilters,
  CustomerLookupOptions,
} from '../../../../shared/types/customer-sync';

// Re-export type guards
export {
  isConflictResult,
  isCustomer,
} from '../../../../shared/types/customer-sync';

// Backward compatibility aliases for POS code that uses these names
import type { Customer, CustomerAddress } from '../../../../shared/types/customer-sync';
export type CustomerType = Customer;
export type CustomerAddressType = CustomerAddress;
