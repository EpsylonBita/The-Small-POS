/**
 * Migration Script: Add is_banned column to customers table
 *
 * This script adds the is_banned column to the existing SQLite database
 * Run this script if the POS system database already exists
 *
 * Usage: node scripts/add-is-banned-column.js
 */

const Database = require('better-sqlite3');
const path = require('path');
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

console.log('Database path:', dbPath);

try {
  // Open database
  const db = new Database(dbPath);
  
  // Check if column exists
  const tableInfo = db.prepare("PRAGMA table_info(customers)").all();
  const hasIsBanned = tableInfo.some(col => col.name === 'is_banned');
  
  if (hasIsBanned) {
    console.log('✅ Column is_banned already exists in customers table');
  } else {
    console.log('Adding is_banned column to customers table...');
    
    // Add the column
    db.exec('ALTER TABLE customers ADD COLUMN is_banned INTEGER DEFAULT 0');
    
    console.log('✅ Successfully added is_banned column to customers table');
  }
  
  // Verify
  const updatedTableInfo = db.prepare("PRAGMA table_info(customers)").all();
  console.log('\nCustomers table schema:');
  updatedTableInfo.forEach(col => {
    console.log(`  - ${col.name} (${col.type})`);
  });
  
  db.close();
  console.log('\n✅ Migration completed successfully');
} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exit(1);
}

