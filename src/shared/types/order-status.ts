export const ORDER_STATUSES = [
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'out_for_delivery',
    'delivered',
    'completed',
    'cancelled'
] as const;

export type OrderStatus = typeof ORDER_STATUSES[number];

export function isValidOrderStatus(status: string): status is OrderStatus {
    return ORDER_STATUSES.includes(status as OrderStatus);
}

export function mapStatusForSupabase(status: string): string {
    // Map legacy or POS-specific statuses to Supabase schema
    // Allowed statuses in orders_status_check: pending, confirmed, preparing, ready, completed, cancelled
    const s = status.toLowerCase().trim();
    if (s === 'in_kitchen') return 'preparing';
    if (s === 'done') return 'ready';
    // Map delivery-related statuses to 'completed' (not allowed in Supabase check constraint)
    if (s === 'delivered' || s === 'out_for_delivery') return 'completed';
    // Only allow statuses that are in the database check constraint
    const allowedStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
    if (allowedStatuses.includes(s)) return s;
    return 'pending'; // Fallback
}

export function mapStatusForPOS(status: string): OrderStatus {
    // Map Supabase statuses to POS
    const s = status.toLowerCase().trim();
    if (isValidOrderStatus(s)) return s as OrderStatus;
    return 'pending';
}

export function coerceIncomingStatus(status: string): OrderStatus {
    return mapStatusForPOS(status);
}
