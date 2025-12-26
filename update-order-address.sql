-- SQL Script to Update Order Address Fields
-- Use this to fix existing orders that don't have properly separated address fields

-- Example: Update order #ORD-20251225-426780
-- Replace the values below with the actual data for your order

UPDATE orders SET
  delivery_city = 'Thessaloniki',
  delivery_postal_code = '56224',
  delivery_floor = '2',
  name_on_ringer = 'Bashi',
  delivery_notes = 'Ring twice',
  updated_at = datetime('now')
WHERE order_number = 'ORD-20251225-426780';

-- To check the order after update:
SELECT
  order_number,
  delivery_address,
  delivery_city,
  delivery_postal_code,
  delivery_floor,
  name_on_ringer,
  delivery_notes
FROM orders
WHERE order_number = 'ORD-20251225-426780';
