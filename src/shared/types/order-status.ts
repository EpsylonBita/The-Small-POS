/**
 * Order Status Types for POS System
 *
 * Re-exports canonical types from shared for consistency.
 * POS-specific mapping functions are kept locally since they have
 * slightly different behavior (e.g., mapStatusFromSupabase).
 */

// Re-export canonical types from shared
export type { OrderStatus, SupabaseOrderStatus } from '../../../../shared/types/order-status';

// Re-export constants from shared
export {
  ORDER_STATUSES,
  ORDER_STATUS_MAP,
  isValidOrderStatus,
  SUPABASE_ALLOWED_STATUSES,
} from '../../../../shared/types/order-status';

// Import shared mapping functions for internal use
import {
  mapStatusForPOS as sharedMapStatusForPOS,
  mapStatusForSupabase as sharedMapStatusForSupabase,
  coerceIncomingStatus as sharedCoerceIncomingStatus,
} from '../../../../shared/types/order-status';

import type { OrderStatus, SupabaseOrderStatus } from '../../../../shared/types/order-status';

/**
 * Map POS status to Supabase status
 * IMPORTANT: Supabase database only allows: pending, confirmed, preparing, ready, completed, cancelled
 * 'delivered' and 'out_for_delivery' are POS-local statuses that must be mapped to 'completed'
 */
export function mapStatusForSupabase(status: string): SupabaseOrderStatus {
  const statusMap: Record<string, SupabaseOrderStatus> = {
    pending: 'pending',
    confirmed: 'confirmed',
    preparing: 'preparing',
    ready: 'ready',
    out_for_delivery: 'completed',  // Map to completed for Supabase
    delivered: 'completed',          // Map to completed for Supabase
    cancelled: 'cancelled',
    completed: 'completed',
  };

  return statusMap[status] || 'pending';
}

/**
 * Map Supabase status to POS status
 */
export function mapStatusFromSupabase(status: string): OrderStatus {
  return mapStatusForPOS(status);
}

/**
 * Map any status to POS status
 */
export function mapStatusForPOS(status: string): OrderStatus {
  const statusMap: Record<string, OrderStatus> = {
    pending: 'pending',
    confirmed: 'confirmed',
    preparing: 'preparing',
    ready: 'ready',
    out_for_delivery: 'delivered',
    delivered: 'delivered',
    cancelled: 'cancelled',
    completed: 'completed',
  };

  return statusMap[status] || 'pending';
}

/**
 * Coerce incoming status to valid OrderStatus
 */
export function coerceIncomingStatus(status: string): OrderStatus {
  const valid = sharedCoerceIncomingStatus(status);
  if (valid) return valid;
  return mapStatusForPOS(status);
}
