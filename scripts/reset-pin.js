/**
 * Reset POS PIN to 1234
 * Run this script to reset the simple PIN when you can't log in
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// Get the database path
const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'the-small-pos-system');
const dbPath = path.join(appDataPath, 'pos-database.db');

console.log('📂 Database path:', dbPath);

try {
  // Open database
  const db = new Database(dbPath);
  
  // Set simple PIN to 1234
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO settings (category, key, value)
    VALUES ('staff', 'simple_pin', '1234')
  `);
  
  stmt.run();
  
  console.log('✅ Simple PIN reset to 1234');
  console.log('🔐 You can now log in with PIN: 1234');
  
  // Also set branch_id and terminal_id if they don't exist
  const branchStmt = db.prepare(`
    INSERT OR IGNORE INTO settings (category, key, value)
    VALUES ('terminal', 'branch_id', ?)
  `);
  branchStmt.run(process.env.DEFAULT_BRANCH_ID || 'default-branch');
  
  const terminalStmt = db.prepare(`
    INSERT OR IGNORE INTO settings (category, key, value)
    VALUES ('terminal', 'terminal_id', ?)
  `);
  terminalStmt.run('terminal-' + Math.random().toString(36).substr(2, 9));
  
  console.log('✅ Terminal settings configured');
  
  db.close();
  
  console.log('\n🎉 Done! Restart the POS app and log in with PIN: 1234');
} catch (error) {
  console.error('❌ Error:', error.message);
  console.log('\n💡 Make sure the POS app is closed before running this script');
}

