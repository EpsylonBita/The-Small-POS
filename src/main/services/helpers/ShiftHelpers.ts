import Database from 'better-sqlite3';

export interface WaiterTableSummary {
    table_number: string;
    order_count: number;
    total_amount: number;
    cash_amount: number;
    card_amount: number;
    payment_method: 'cash' | 'card' | 'mixed';
    orders: any[];
}

/**
 * Fetches and groups waiter orders by table number for a specific shift.
 * Shared logic between StaffService and PrintService to ensure consistency.
 */
export function getWaiterShiftData(db: Database.Database, shiftId: string): WaiterTableSummary[] {
    const waiterTablesStmt = db.prepare(`
    SELECT 
      o.table_number,
      COUNT(*) as order_count,
      COALESCE(SUM(o.total_amount), 0) as total_amount,
      COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.total_amount ELSE 0 END), 0) as cash_amount,
      COALESCE(SUM(CASE WHEN o.payment_method != 'cash' THEN o.total_amount ELSE 0 END), 0) as card_amount,
      GROUP_CONCAT(
        json_object(
          'id', o.id,
          'order_id', o.id,
          'order_number', o.order_number,
          'total_amount', o.total_amount,
          'payment_method', o.payment_method,
          'status', o.status
        )
      ) as orders_json
    FROM orders o
    WHERE o.staff_shift_id = ? 
      AND o.order_type = 'dine-in'
      AND o.table_number IS NOT NULL
    GROUP BY o.table_number
    ORDER BY o.table_number
  `);

    const tables = waiterTablesStmt.all(shiftId) as any[];

    return tables.map(t => {
        let orders: any[] = [];
        try {
            if (t.orders_json) {
                // Fix JSON array format if GROUP_CONCAT returns separate objects
                const jsonStr = t.orders_json.startsWith('[') ? t.orders_json : `[${t.orders_json.replace(/}\s*,\s*{/g, '},{')}]`;
                orders = JSON.parse(jsonStr);
            }
        } catch (e) {
            console.warn('Failed to parse orders_json for table', t.table_number, e);
        }

        let payment_method: 'cash' | 'card' | 'mixed' = 'card';
        if (t.cash_amount > 0 && t.card_amount === 0) payment_method = 'cash';
        else if (t.cash_amount > 0 && t.card_amount > 0) payment_method = 'mixed';

        return {
            table_number: t.table_number,
            order_count: t.order_count,
            total_amount: t.total_amount,
            cash_amount: t.cash_amount,
            card_amount: t.card_amount,
            payment_method,
            orders: Array.isArray(orders) ? orders : [] // Null safety as requested
        };
    });
}
