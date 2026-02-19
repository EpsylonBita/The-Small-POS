# The Small POS — Support & Diagnostics Guide

## Quick Diagnostics

### Export Diagnostics Bundle

1. Open the app and navigate to **System Health** (Activity icon in sidebar)
2. Click **Export Diagnostics**
3. A `.zip` file is saved to the app data directory
4. Click **Open Folder** to locate the file
5. Send the zip to support

The diagnostics bundle includes:
- `about.json` — version, build timestamp, git SHA, platform
- `system_health.json` — connection status, sync backlog, printer config, last z-report
- `sync_backlog.json` — pending sync counts by entity type
- `sync_errors.json` — last 20 sync errors with timestamps
- `printer_diagnostics.json` — printer profiles and recent print jobs
- `logs/` — recent application log files

### Manual Log Location

Log files are stored at:

```
%LOCALAPPDATA%\com.thesmall.pos\logs\
```

Log files use daily rotation (e.g., `pos.2026-02-16`). Up to 10 files are retained automatically.

## System Health Screen

The System Health screen shows:

| Card | What it shows |
|------|---------------|
| **Connection** | Online/Offline status, last successful sync time |
| **Sync Backlog** | Count of pending items by entity type (orders, payments, adjustments) |
| **Printers** | Configured printer count, default profile, recent job statuses |
| **Last Z-Report** | When generated, gross/net sales, sync state |
| **Database** | Schema version, file size |
| **Pending Sync Queue** | Total items waiting to sync |
| **Last Sync by Entity** | Per-entity-type last successful sync timestamp |

The screen auto-refreshes every 30 seconds.

## Common Issues

### App won't start

1. Check Windows Event Viewer for crash logs
2. Check `%LOCALAPPDATA%\com.thesmall.pos\logs\` for recent log files
3. Try renaming the database: rename `pos.db` to `pos.db.backup` in `%LOCALAPPDATA%\com.thesmall.pos\`
4. Restart the app

### Dev build fails with Access is denied / cannot remove `the-small-pos.exe`

If hot-reload or rebuild fails because the executable is still locked, stop any stale process and rerun dev:

```powershell
Get-Process the-small-pos -ErrorAction SilentlyContinue | Stop-Process -Force
```

Then run:

```powershell
npm run pos:tauri:dev
```

### Dev startup fails because port `1420` is in use

`npm run pos:tauri:dev` now runs a precheck and will stop early if Vite port `1420` is already bound.

Inspect and resolve the port owner manually:

```powershell
Get-NetTCPConnection -LocalPort 1420 | Format-Table -AutoSize
Get-Process -Id <PID> | Stop-Process -Force
```

Then rerun:

```powershell
npm run pos:tauri:dev
```

### Terminal not connecting to admin

1. Open System Health — check if "Online" or "Offline"
2. Open Settings (gear icon) and verify:
   - Admin dashboard URL is correct
   - API key is valid
   - Terminal ID matches
3. Check `sync_errors.json` in the diagnostics export for HTTP error details
4. Ensure the admin dashboard is reachable from the POS machine's network

### Orders not syncing

1. Open System Health — check "Sync Backlog" card
2. If items are pending, the sync loop runs every 15 seconds
3. If items are in "failed" state, check the diagnostics export `sync_errors.json`
4. Force a sync: the sync engine automatically retries with exponential backoff
5. If stuck, export diagnostics and contact support

### Menu is empty / menu not syncing

1. Check `%LOCALAPPDATA%\\com.thesmall.pos\\logs\\pos.YYYY-MM-DD` for menu/auth errors.
2. If logs contain `Invalid API key for terminal` or `Terminal identity mismatch`, the app now forces onboarding reset for safety.
3. Reconnect the terminal from onboarding with the latest connection/API key from admin.
4. After reconnect, open the menu screen and trigger **Sync Now** once.
5. If still empty, export diagnostics and include the latest log file.

### Printer not working

1. Open System Health — check "Printers" card
2. Verify a printer profile is configured (profile count > 0)
3. Check recent print job statuses for "failed" entries
4. Verify the Windows printer name matches the system printer
5. Test from Windows: print a test page to the same printer
6. Check for `warning_code: "drawer_kick_failed"` which indicates the cash drawer couldn't open (non-blocking)

### Z-Report not generating

1. Ensure a shift is active and has been closed
2. Z-reports are generated at shift close time
3. Check System Health > "Last Z-Report" card
4. If sync state is "pending", the report is waiting to sync to admin
5. Export diagnostics to see the full `system_health.json`

## Data Locations

| Data | Path |
|------|------|
| SQLite database | `%LOCALAPPDATA%\com.thesmall.pos\pos.db` |
| Log files | `%LOCALAPPDATA%\com.thesmall.pos\logs\` |
| Receipt files | `%LOCALAPPDATA%\com.thesmall.pos\receipts\` |
| Diagnostics exports | `%LOCALAPPDATA%\com.thesmall.pos\` |
| Credentials | Windows Credential Manager (keyring) |

## Log Rotation

- **Format**: Daily rolling files (`pos.YYYY-MM-DD`)
- **Retention**: 10 most recent files kept, older files pruned at startup
- **Max size**: Individual entries are not size-capped, but the daily rotation prevents unbounded growth
- **Location**: `%LOCALAPPDATA%\com.thesmall.pos\logs\`

## Credential Storage

Terminal credentials (API key, terminal ID, etc.) are stored in the Windows Credential Manager via the `keyring` crate. They are not stored in the SQLite database or in plain-text files.

To view stored credentials:
1. Open Windows Credential Manager
2. Look under "Generic Credentials"
3. Entries are prefixed with `the-small-pos:`

To reset credentials:
1. Use the app's Settings > Factory Reset
2. Or manually delete entries from Windows Credential Manager

## Getting Help

- Export diagnostics and share the zip file
- Include the app version (visible on About screen)
- Describe the steps to reproduce the issue
- Note the time when the issue occurred (for log correlation)
