-- SQL Script to Update Order Address Fields for ORD-20251225-564774
-- Based on the receipt showing: Nikoleta Hachi, Grigoriou Xenopoulou 21, Bell: Haxhi

UPDATE orders SET
  delivery_city = 'Thessaloniki',
  delivery_postal_code = '56224',
  delivery_floor = NULL,  -- Not shown in receipt, adjust if needed
  name_on_ringer = 'Haxhi',  -- Bell name from receipt
  delivery_notes = NULL,  -- Not shown in receipt, adjust if needed
  updated_at = datetime('now')
WHERE order_number = 'ORD-20251225-564774';

-- To check the order after update:
SELECT
  order_number,
  customer_name,
  customer_phone,
  delivery_address,
  delivery_city,
  delivery_postal_code,
  delivery_floor,
  name_on_ringer,
  delivery_notes
FROM orders
WHERE order_number = 'ORD-20251225-564774';
