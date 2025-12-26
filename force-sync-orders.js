// Quick script to check and manually sync pending orders
// This will help clear the sync queue so Z-Report can be submitted

const Database = require('better-sqlite3');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.production' });

const dbPath = path.join(__dirname, 'pos.db');
const db = new Database(dbPath);

// Get Supabase connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env.production');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function syncPendingOrders() {
  console.log('🔍 Checking for driver earnings with missing order references...\n');

  // Get driver earnings that are stuck
  const stuckEarnings = db.prepare(`
    SELECT de.id, de.order_id, o.id as local_order_id, o.order_number, o.supabase_id
    FROM driver_earnings de
    LEFT JOIN orders o ON de.order_id = o.id
    WHERE (de.supabase_id IS NULL OR de.supabase_id = '')
    AND date(de.created_at) = date('now')
  `).all();

  console.log(`Found ${stuckEarnings.length} unsynced driver earnings\n`);

  if (stuckEarnings.length === 0) {
    console.log('✅ No stuck driver earnings found!');
    db.close();
    return;
  }

  // Check which orders need syncing
  const ordersToSync = stuckEarnings.filter(e => e.local_order_id && (!e.supabase_id || e.supabase_id === ''));

  console.log(`📦 ${ordersToSync.length} orders need to be synced to Supabase\n`);

  for (const earning of ordersToSync) {
    console.log(`\n🔄 Processing Order #${earning.order_number} (${earning.order_id})`);

    // Get full order data
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(earning.order_id);

    if (!order) {
      console.log(`   ❌ Order not found in local DB`);
      continue;
    }

    // Check if order already exists in Supabase
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', order.id)
      .maybeSingle();

    if (existingOrder) {
      console.log(`   ✅ Order already in Supabase, updating local supabase_id`);
      db.prepare('UPDATE orders SET supabase_id = ? WHERE id = ?').run(order.id, order.id);
      continue;
    }

    // Prepare order for Supabase
    const orderData = {
      id: order.id,
      order_number: order.order_number,
      branch_id: order.branch_id,
      organization_id: order.organization_id,
      customer_id: order.customer_id,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_email: order.customer_email,
      order_type: order.order_type,
      status: order.status,
      payment_method: order.payment_method,
      payment_status: order.payment_status,
      total_amount: order.total_amount,
      subtotal: order.subtotal,
      tax_amount: order.tax_amount,
      discount_amount: order.discount_amount,
      delivery_fee: order.delivery_fee,
      tip_amount: order.tip_amount,
      delivery_address: order.delivery_address,
      notes: order.notes,
      items: order.items,
      driver_id: order.driver_id,
      staff_shift_id: order.staff_shift_id,
      staff_id: order.staff_id,
      created_at: order.created_at,
      updated_at: order.updated_at
    };

    // Sync to Supabase
    const { error } = await supabase
      .from('orders')
      .upsert(orderData);

    if (error) {
      console.log(`   ❌ Failed to sync: ${error.message}`);
    } else {
      console.log(`   ✅ Synced successfully`);
      // Update local record with supabase_id
      db.prepare('UPDATE orders SET supabase_id = ? WHERE id = ?').run(order.id, order.id);

      // Remove from sync queue if present
      db.prepare('DELETE FROM sync_queue WHERE table_name = ? AND record_id = ?').run('orders', order.id);
    }
  }

  console.log('\n\n📊 Summary:');
  console.log('════════════════════════════════════════════════════════');

  // Check remaining unsynced
  const remainingEarnings = db.prepare(`
    SELECT COUNT(*) as count
    FROM driver_earnings
    WHERE (supabase_id IS NULL OR supabase_id = '')
    AND date(created_at) = date('now')
  `).get();

  console.log(`Driver earnings still unsynced: ${remainingEarnings.count}`);

  if (remainingEarnings.count === 0) {
    console.log('✅ All driver earnings should sync now!');
    console.log('✅ You can now submit the Z-Report');
  } else {
    console.log('⚠️  Some driver earnings still need manual attention');
    console.log('💡 Try restarting the POS app and clicking "Retry Sync"');
  }

  db.close();
}

syncPendingOrders().catch(err => {
  console.error('Error:', err);
  db.close();
  process.exit(1);
});
