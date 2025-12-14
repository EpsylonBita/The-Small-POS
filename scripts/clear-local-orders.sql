-- Clear all orders from local POS database
-- Run this script in the SQLite database

-- Delete from sync_queue (orders)
DELETE FROM sync_queue WHERE table_name = 'orders';

-- Delete from order_retry_queue
DELETE FROM order_retry_queue;

-- Delete from conflicts table if it exists
DELETE FROM conflicts WHERE entity_type = 'order';

-- Delete all orders
DELETE FROM orders;

-- Reset any order-related counters or sequences
-- (SQLite doesn't have sequences, but we can vacuum to reclaim space)
VACUUM;

-- Verify deletion
SELECT COUNT(*) as remaining_orders FROM orders;
SELECT COUNT(*) as remaining_sync_queue FROM sync_queue WHERE table_name = 'orders';

