/**
 * Customer Sync Types
 * 
 * Local type definitions for POS system customer synchronization.
 * These types are kept in sync with the shared module definitions.
 */

/**
 * Unified Customer interface
 */
export interface Customer {
  id: string
  name: string
  full_name: string
  phone: string
  email: string | null
  loyalty_points: number
  total_orders: number
  last_order_date: string | null
  addresses: CustomerAddress[]

  // Sync metadata
  version: number
  updated_by: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

/**
 * Customer Address interface
 */
export interface CustomerAddress {
  id: string
  customer_id: string
  street: string
  street_address: string
  city: string
  postal_code: string
  country: string
  floor_number: string | null
  address_type: 'home' | 'work' | 'other'
  is_default: boolean
  delivery_notes: string | null
  notes: string | null

  // Sync metadata
  version: number
  created_at: string
  updated_at: string
}

/**
 * Customer Conflict interface
 */
export interface CustomerConflict {
  id: string
  customer_id: string
  local_version: number
  remote_version: number
  local_data: any
  remote_data: any
  conflict_type: ConflictType
  resolution_strategy: ResolutionStrategy | null
  resolved: boolean
  resolved_at: string | null
  resolved_by: string | null
  terminal_id: string | null
  created_at: string
  updated_at: string
}

/**
 * Conflict types
 */
export type ConflictType =
  | 'version_mismatch'
  | 'simultaneous_update'
  | 'pending_local_changes'

/**
 * Resolution strategies
 */
export type ResolutionStrategy =
  | 'local_wins'
  | 'remote_wins'
  | 'manual_merge'
  | 'force_update'

/**
 * Conflict result returned when update fails due to version mismatch
 */
export interface ConflictResult {
  conflict: true
  conflictId: string
  localData: Customer
  remoteData: Customer
  localVersion: number
  remoteVersion: number
}

/**
 * Conflict resolution result
 */
export interface ConflictResolutionResult {
  success: boolean
  resolvedCustomer?: Customer
  error?: string
}

/**
 * Filters for querying conflicts
 */
export interface ConflictFilters {
  terminalId?: string
  resolved?: boolean
  conflictType?: ConflictType
  customerId?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

/**
 * Options for customer lookup
 */
export interface CustomerLookupOptions {
  includeAddresses?: boolean
  skipCache?: boolean
  source?: string
}

/**
 * Type guard to check if result is a conflict
 */
export function isConflictResult(
  result: Customer | ConflictResult
): result is ConflictResult {
  return 'conflict' in result && result.conflict === true
}

/**
 * Type guard to check if result is a customer
 */
export function isCustomer(
  result: Customer | ConflictResult
): result is Customer {
  return 'id' in result && !('conflict' in result)
}

// Backward compatibility aliases
export type CustomerType = Customer
export type CustomerAddressType = CustomerAddress
