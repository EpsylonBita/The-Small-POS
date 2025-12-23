/**
 * Order Status Types (POS-local stub)
 */

export type OrderStatus = 
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'delivered'
  | 'cancelled'
  | 'completed';

// Supabase database constraint only allows these statuses
export type SupabaseOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled';

export const ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'delivered',
  'cancelled',
  'completed',
];

/**
 * Check if a status is valid
 */
export function isValidOrderStatus(status: string): status is OrderStatus {
  return ORDER_STATUSES.includes(status as OrderStatus);
}

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
  if (isValidOrderStatus(status)) {
    return status;
  }
  return mapStatusForPOS(status);
}
