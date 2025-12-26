-- Find driver earnings that are stuck
SELECT
    'Driver Earning' as type,
    de.id,
    de.order_id,
    de.created_at,
    de.supabase_id as earning_supabase_id,
    o.id as order_local_id,
    o.order_number,
    o.supabase_id as order_supabase_id,
    o.status as order_status,
    CASE
        WHEN o.id IS NULL THEN 'Order not found in local DB'
        WHEN o.supabase_id IS NULL OR o.supabase_id = '' THEN 'Order not synced to Supabase'
        ELSE 'Order synced OK'
    END as issue
FROM driver_earnings de
LEFT JOIN orders o ON de.order_id = o.id
WHERE (de.supabase_id IS NULL OR de.supabase_id = '')
  AND date(de.created_at) = date('now')
ORDER BY de.created_at DESC;

-- Check sync queue for these orders
SELECT
    'Sync Queue' as type,
    sq.id,
    sq.table_name,
    sq.record_id,
    sq.operation,
    sq.attempts,
    sq.last_error,
    sq.created_at
FROM sync_queue sq
WHERE sq.table_name IN ('orders', 'driver_earnings')
  AND date(sq.created_at) = date('now')
ORDER BY sq.created_at DESC;
