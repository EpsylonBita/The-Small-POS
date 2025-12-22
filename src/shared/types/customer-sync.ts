/**
 * Customer Sync Types
 * 
 * Re-exports all types from the shared customer-sync module for POS system use.
 * This ensures type consistency across all platforms (Admin Dashboard, POS, Mobile).
 * 
 * @see shared/types/customer-sync.ts for the canonical type definitions
 */

// Re-export types from shared module
export type {
  Customer,
  CustomerAddress,
  CustomerConflict,
  ConflictResult,
  ConflictResolutionResult,
  ConflictFilters,
  ConflictType,
  ResolutionStrategy,
  CustomerLookupOptions,
} from '../../../../shared/types/customer-sync';

// Re-export type guard functions (runtime values)
export { isConflictResult, isCustomer } from '../../../../shared/types/customer-sync';

// Re-export types for backward compatibility
export type { Customer as CustomerType } from '../../../../shared/types/customer-sync';
export type { CustomerAddress as CustomerAddressType } from '../../../../shared/types/customer-sync';
