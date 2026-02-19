/**
 * Canonical TableStatus Type
 *
 * SINGLE SOURCE OF TRUTH for table status values across all applications.
 * Matches database CHECK constraint from migration:
 * 20251128000002_restaurant_tables_and_reservations.sql
 *
 * @since 2.4.0
 */

/**
 * Canonical TableStatus matching database CHECK constraint
 *
 * Valid statuses:
 * - `available`: Table is free and ready for seating
 * - `occupied`: Table currently has guests seated
 * - `reserved`: Table is reserved for an upcoming reservation
 * - `cleaning`: Table is being cleaned after guests left
 * - `maintenance`: Table is out of service for repairs/maintenance
 * - `unavailable`: Table is temporarily unavailable (e.g., event setup)
 */
export type TableStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'cleaning'
  | 'maintenance'
  | 'unavailable';

/**
 * Array of all valid table statuses for runtime validation
 */
export const TABLE_STATUSES = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'maintenance',
  'unavailable',
] as const;

/**
 * Type guard to check if a string is a valid TableStatus
 */
export function isValidTableStatus(s: string): s is TableStatus {
  return TABLE_STATUSES.includes(s as TableStatus);
}

/**
 * Default status colors for UI consistency
 * Can be overridden in specific components but provides standard defaults
 */
export const TABLE_STATUS_COLORS: Record<TableStatus, string> = {
  available: '#22c55e',   // green-500
  occupied: '#ef4444',    // red-500
  reserved: '#f59e0b',    // amber-500
  cleaning: '#3b82f6',    // blue-500
  maintenance: '#6b7280', // gray-500
  unavailable: '#94a3b8', // slate-400
};

/**
 * Default status labels for UI consistency
 */
export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  available: 'Available',
  occupied: 'Occupied',
  reserved: 'Reserved',
  cleaning: 'Cleaning',
  maintenance: 'Maintenance',
  unavailable: 'Unavailable',
};
