/**
 * Script to clear all orders from the local POS SQLite database
 * Run this with: node scripts/clear-local-orders.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Get database path (same as Electron app.getPath('userData'))
const appName = 'the-small-pos-system';
let userDataPath;

if (process.platform === 'win32') {
  userDataPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
} else if (process.platform === 'darwin') {
  userDataPath = path.join(os.homedir(), 'Library', 'Application Support', appName);
} else {
  userDataPath = path.join(os.homedir(), '.config', appName);
}

const dbPath = path.join(userDataPath, 'pos-database.db');

console.log('📂 Database path:', dbPath);

// Check if database exists
if (!fs.existsSync(dbPath)) {
  console.error('❌ Database file not found at:', dbPath);
  process.exit(1);
}

try {
  // Open database
  const db = new Database(dbPath);
  console.log('✅ Database opened successfully');

  // Start transaction
  db.exec('BEGIN TRANSACTION');

  // Count orders before deletion
  const beforeCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();
  console.log(`📊 Orders before deletion: ${beforeCount.count}`);

  // Delete from sync_queue (orders)
  const syncQueueResult = db.prepare("DELETE FROM sync_queue WHERE table_name = 'orders'").run();
  console.log(`🗑️  Deleted ${syncQueueResult.changes} items from sync_queue`);

  // Delete from order_retry_queue if it exists
  try {
    const retryQueueResult = db.prepare('DELETE FROM order_retry_queue').run();
    console.log(`🗑️  Deleted ${retryQueueResult.changes} items from order_retry_queue`);
  } catch (err) {
    console.log('ℹ️  order_retry_queue table does not exist (skipping)');
  }

  // Delete from conflicts table if it exists
  try {
    const conflictsResult = db.prepare("DELETE FROM conflicts WHERE entity_type = 'order'").run();
    console.log(`🗑️  Deleted ${conflictsResult.changes} conflicts`);
  } catch (err) {
    console.log('ℹ️  conflicts table does not exist (skipping)');
  }

  // Delete all orders
  const ordersResult = db.prepare('DELETE FROM orders').run();
  console.log(`🗑️  Deleted ${ordersResult.changes} orders`);

  // Commit transaction
  db.exec('COMMIT');
  console.log('✅ Transaction committed');

  // Vacuum to reclaim space
  console.log('🧹 Running VACUUM to reclaim space...');
  db.exec('VACUUM');
  console.log('✅ VACUUM completed');

  // Verify deletion
  const afterCount = db.prepare('SELECT COUNT(*) as count FROM orders').get();
  console.log(`📊 Orders after deletion: ${afterCount.count}`);

  const syncQueueCount = db.prepare("SELECT COUNT(*) as count FROM sync_queue WHERE table_name = 'orders'").get();
  console.log(`📊 Sync queue items remaining: ${syncQueueCount.count}`);

  // Close database
  db.close();
  console.log('✅ Database closed');
  console.log('');
  console.log('🎉 All orders cleared successfully!');

} catch (error) {
  console.error('❌ Error clearing orders:', error);
  process.exit(1);
}

