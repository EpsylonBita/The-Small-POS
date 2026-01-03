/**
 * Reset POS Admin Dashboard URL to use .env value
 * This removes the stored URL from the database so it falls back to .env
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// Find the database
const appDataPath = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'the-small-pos-system')
  : path.join(os.homedir(), '.config', 'the-small-pos-system');

const dbPath = path.join(appDataPath, 'pos-database.db');

try {
  const db = new Database(dbPath);

  console.log('Resetting admin dashboard URL...');

  // Remove the stored admin URL so it falls back to .env
  const result = db.prepare(`
    DELETE FROM local_settings
    WHERE category = 'terminal' AND key = 'admin_dashboard_url'
  `).run();

  console.log(`✅ Removed ${result.changes} setting(s)`);
  console.log('The POS will now use the URL from .env file: http://127.0.0.1:3001');

  // Show current terminal settings for verification
  const settings = db.prepare(`
    SELECT key, value FROM local_settings
    WHERE category = 'terminal'
  `).all();

  console.log('\nCurrent terminal settings:');
  settings.forEach(s => console.log(`  ${s.key}: ${s.value}`));

  db.close();
  console.log('\n✅ Done! Restart the POS application.');
} catch (error) {
  console.error('Error:', error.message);
  console.log('\nIf the database is locked, make sure the POS application is closed.');
}
