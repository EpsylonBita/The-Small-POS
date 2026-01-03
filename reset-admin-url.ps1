# Reset POS Admin Dashboard URL to use .env value
# This removes the stored URL from the database so it falls back to .env

$appDataPath = "$env:APPDATA\the-small-pos-system"
$dbPath = Join-Path $appDataPath "pos-database.db"

Write-Host "Database path: $dbPath"

if (-not (Test-Path $dbPath)) {
    Write-Host "❌ Database not found at: $dbPath" -ForegroundColor Red
    Write-Host "Make sure the POS application has been run at least once."
    exit 1
}

try {
    # Load SQLite assembly
    Add-Type -Path "$(npm config get prefix)\node_modules\better-sqlite3\build\Release\better_sqlite3.node" -ErrorAction Stop
} catch {
    Write-Host "Running via Node.js instead..."

    # Use Node.js to execute the SQL
    $jsCode = @"
const Database = require('better-sqlite3');
const db = new Database('$($dbPath.Replace('\', '\\'))');

console.log('Resetting admin dashboard URL...');

const result = db.prepare(``
    DELETE FROM local_settings
    WHERE category = 'terminal' AND key = 'admin_dashboard_url'
``).run();

console.log('✅ Removed ' + result.changes + ' setting(s)');
console.log('The POS will now use the URL from .env file: http://127.0.0.1:3001\n');

const settings = db.prepare(``
    SELECT key, value FROM local_settings
    WHERE category = 'terminal'
``).all();

console.log('Current terminal settings:');
settings.forEach(s => console.log('  ' + s.key + ': ' + s.value));

db.close();
console.log('\n✅ Done! Restart the POS application.');
"@

    $jsCode | node
}
