# Security Verification Pack

## Threat Model Focus
- Renderer XSS and data exfiltration risk
- IPC abuse via unvalidated channels/payloads
- Secret leakage via local plaintext settings/storage
- Local brute-force via auth lockout reset on restart
- Command execution abuse via shell/PowerShell paths

## Regression Scenarios
1. Receipt preview escapes HTML/script payloads.
2. Legacy HTML print command path is blocked.
3. Sensitive keys do not persist in local_settings after update/refresh.
4. Legacy `staff.simple_pin` values are not accepted as auth source.
5. Failed PIN attempts persist across restart window.
6. IPC invoke blocks disallowed channel names.
7. Tauri startup hydrates context without localStorage dependency.
8. External URL open requests are blocked unless host/scheme pass Rust allowlist validation.
9. Renderer critical paths resolve `terminal_id` / `branch_id` / `organization_id` from secure IPC/cache, not localStorage persistence.
10. Native-only runtime contract blocks any reintroduction of `window.electron*`, `window.isElectron`, or `import 'electron'` surfaces.
11. Startup bootstrap is bridge-only (`src/main.tsx` has no compat/bootstrap shims).

## Validation Commands
- `cargo test payments::tests::test_receipt_preview_escapes_html_content`
- `cargo test payments::tests::test_receipt_preview`
- `cargo test --package the-small-pos auth`
- `cargo test external_url_validation_tests`
- `cargo test lockout_persists_across_auth_state_restart`
- `cargo test successful_login_resets_persisted_lockout_after_restart`
- `npm run test:native-runtime`
- `npm run type-check`
- `rg -n "localStorage\\.(getItem|setItem|removeItem)\\('(terminal_id|branch_id|organization_id)'\\)" pos-tauri/src/renderer`
