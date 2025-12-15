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

export type SupabaseOrderStatus = 
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'completed';

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
 */
export function mapStatusForSupabase(status: string): SupabaseOrderStatus {
  const statusMap: Record<string, SupabaseOrderStatus> = {
    pending: 'pending',
    confirmed: 'confirmed',
    preparing: 'preparing',
    ready: 'ready',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
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
