# The Small POS - Support and Diagnostics Guide

## Scope

This guide covers operational support for the native-only `pos-tauri` desktop runtime.

## Fast Triage Checklist

1. Confirm app version from About screen.
2. Open System Health and capture current status cards.
3. Export diagnostics bundle.
4. Collect reproduction steps and timestamps.
5. Attach bundle + observations to support escalation.

## Export Diagnostics Bundle

1. Open **System Health** (Activity icon).
2. Click **Export Diagnostics**.
3. Confirm generated `.zip` path.
4. Click **Open Folder** and attach the file for support.

Bundle contents:

- `about.json`: app/build/platform metadata
- `system_health.json`: runtime health snapshot
- `sync_backlog.json`: queue counts by entity type
- `sync_errors.json`: recent sync failures
- `printer_diagnostics.json`: printer profiles and print-job state
- `logs/`: recent application log files

## Runtime Health Surface

System Health exposes:

- connection online/offline state,
- sync backlog and pending queue,
- printer configuration/recent status,
- last z-report status,
- database schema/file info,
- last successful sync timestamps by entity.

Health data is emitted by backend monitors and reflected in the UI continuously.

## Common Incidents

### App fails to start

1. Inspect `%LOCALAPPDATA%\com.thesmall.pos\logs\` for startup errors.
2. Check Windows Event Viewer for crash entries.
3. Rename `%LOCALAPPDATA%\com.thesmall.pos\pos.db` to `pos.db.backup` (only if corruption suspected).
4. Re-launch app and re-test.

### Dev build lock (`the-small-pos.exe` in use)

```powershell
Get-Process the-small-pos -ErrorAction SilentlyContinue | Stop-Process -Force
npm run pos:tauri:dev
```

### Dev port 1420 already in use

```powershell
Get-NetTCPConnection -LocalPort 1420 | Format-Table -AutoSize
Get-Process -Id <PID> | Stop-Process -Force
npm run pos:tauri:dev
```

### Terminal cannot connect to admin

1. Validate terminal settings (admin URL, terminal ID, API key).
2. Confirm network reachability from terminal host.
3. Review `sync_errors.json` for HTTP/auth errors.
4. If identity mismatch appears, re-run onboarding with current admin-issued credentials.

### Orders not syncing

1. Review System Health backlog/pending counts.
2. Confirm network state transitions (offline deferral, online resume).
3. Check `sync_errors.json` for persistent failures.
4. Verify queue drains after reconnect; if not, attach diagnostics and logs.

### Menu data missing

1. Inspect logs for menu/auth failures.
2. Validate terminal identity and API key.
3. Trigger manual menu refresh once connectivity is restored.
4. Escalate with diagnostics if cache remains empty.

### Printer issues

1. Verify printer profile exists and default assignment is correct.
2. Validate Windows printer name and OS test-page success.
3. Review recent print jobs in diagnostics.
4. Treat `drawer_kick_failed` warnings as non-blocking unless cash drawer behavior is itself the incident.

### Z-report or shift-close anomalies

1. Confirm shift state and close sequence completed.
2. Check z-report sync state in System Health.
3. Validate pending queue and sync errors.
4. Export diagnostics for reconciliation analysis.

## Data Locations

| Data | Location |
|---|---|
| SQLite DB | `%LOCALAPPDATA%\com.thesmall.pos\pos.db` |
| Logs | `%LOCALAPPDATA%\com.thesmall.pos\logs\` |
| Receipts | `%LOCALAPPDATA%\com.thesmall.pos\receipts\` |
| Diagnostics bundles | `%LOCALAPPDATA%\com.thesmall.pos\` |
| Credentials | Windows Credential Manager (`the-small-pos:*`) |

## Log Behavior

- Daily rolling log files (`pos.YYYY-MM-DD`).
- Retention pruning keeps recent files and removes old logs at startup.
- Printer inventory log entries are emitted only on inventory changes to reduce periodic noise.

## Credential Storage and Reset

- Terminal credentials are stored via OS keyring integration (Windows Credential Manager).
- Secrets are not expected in renderer local storage.
- Reset path: app **Factory Reset** or manual credential deletion in Credential Manager.

## Escalation Package

Always include:

1. diagnostics zip,
2. app version and terminal ID (masked if required),
3. exact issue timestamp and timezone,
4. reproduction steps,
5. whether terminal was offline/online at incident time.

## References

- `README.md`
- `ARCHITECTURE.md`
- `RELEASE.md`
- `docs/security-native-migration/SECURITY_VERIFICATION_PACK.md`
