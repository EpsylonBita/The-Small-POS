# The Small POS (Tauri) - Architecture

## Runtime Status (2026-02-23)

- Desktop runtime in `pos-tauri` is native-only (`tauri | browser` platform detection, no Electron desktop path).
- Renderer command/event access is standardized through typed bridge contracts.
- Core POS workflows are Rust-backed (auth, orders, shifts, payments, sync, print, diagnostics, updates).
- Offline-first sync semantics are active with deferred remote sync and reconnect catch-up.

## System Topology

```text
React Renderer (src/renderer)
  -> Typed Desktop Bridge (src/lib/ipc-adapter.ts)
    -> Tauri Commands (src-tauri/src/commands/*)
      -> Rust Services + DB Layer (src-tauri/src/services, src-tauri/src/db)
        -> SQLite + Sync Queue (local source of truth)
        -> Admin API / Supabase sync adapters (when network is available)

Rust Event Emitters
  -> Tauri Events
    -> Event Bridge (src/lib/event-bridge.ts)
      -> Renderer onEvent/offEvent subscribers
```

## Desktop Startup Flow

1. `src/main.tsx` loads bridge runtime and styles.
2. Startup fetches secure terminal config from native command path.
3. Supabase runtime context is hydrated from secure terminal config when present.
4. React app mounts and uses `getBridge()` + `onEvent/offEvent` for all desktop operations.
5. Rust background workers start from app bootstrap (`src-tauri/src/lib.rs`) for sync, menu monitor, printer status, diagnostics health, and related domain loops.

## Bridge and Event Contracts

### Command path

- `src/lib/ipc-adapter.ts` is the canonical renderer command surface.
- In desktop runtime, bridge calls map to Tauri commands only.
- Browser mode is a non-production safety mode (stub behavior), not a desktop fallback.

### Event path

- `src/lib/event-bridge.ts` maps canonical Tauri event names to renderer channel names.
- `onEvent/offEvent` remains stable for renderer consumers.
- Event subscriptions attach lazily per channel and detach automatically when no listeners remain.

### Contract verification

- `npm run parity:contract` validates invoke/event channel parity.
- `npm run test:native-runtime` blocks reintroduction of Electron desktop surfaces.

## Rust Backend Architecture

### Command modules

`src-tauri/src/commands/` is domain-sliced. Main groups include:

- `auth`, `settings`, `terminal_config`
- `orders`, `payments`, `sync`, `menu`, `customers`
- `shifts`, `reports`/`zreports`
- `printer`, `ecr`, `hardware`
- `updates`, `diagnostics`, `window`, `admin_api`, `modules`

### Service modules

`src-tauri/src/services/` contains business orchestration:

- auth/session + lockout
- order lifecycle + sync queue enqueue
- sync workers + reconciliation
- payment/refund + print orchestration
- diagnostics and health snapshots
- printer/ecr orchestration

### Data layer

- SQLite (`rusqlite`) with migration-managed schema.
- WAL mode and foreign key enforcement.
- `sync_queue` is authoritative for deferred remote operations.

## Offline-First Sync Semantics

1. User mutation writes to SQLite first.
2. Sync payload is enqueued into `sync_queue` with idempotency key.
3. UI returns immediately from local state.
4. Background sync checks network reachability.
5. If offline, queue remains pending, remote writes are deferred, and status events continue with offline state.
6. On offline -> online transition, sync loop resumes, queue drains in priority order, deferred payment/adjustment rows are reconciled, and sync/network events are emitted.

## Security Boundaries

- Desktop renderer has no `window.electron*` runtime dependency.
- Secrets/terminal credentials are held in secure storage (keyring/OS credential manager), not renderer local storage.
- Tauri command layer defines callable desktop operations; unsupported channels are blocked by contract.
- External URL opening is mediated through native allowlist policy commands.
- Legacy PowerShell HTML print path is disabled; native print flows are used.

## Printing and Hardware

- Printer profiles are stored in SQLite.
- Windows printer inventory is enumerated and cached in Rust.
- Native print dispatch uses spooler/raw ESC/POS paths.
- Cash drawer and ECR operations are mediated by Rust command/services.

## Diagnostics and Observability

- Daily rotating logs with retention management.
- `System Health` UI consumes native diagnostics snapshots/events.
- Diagnostics export bundle includes health, sync, printer, and log artifacts.
- Staging soak evaluation is scriptable (`node scripts/tauri-smoke.mjs --report ...`, `npm run soak:report`).

## Build and Release Architecture

- Frontend build: Vite + TypeScript.
- Backend build: Cargo + Tauri bundler.
- Release target: Windows x64 NSIS installer.
- Updater artifacts: installer, signature, and `latest.json` manifest.
- Version sync is required across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.

## Migration Status

Completed:

- Native desktop cutover and Electron surface decommission in `pos-tauri`.
- Typed bridge migration for runtime-critical renderer flows.
- Security hardening items tracked in execution backlog.
- Native runtime/parity contract checks integrated into npm scripts.

Remaining operational gate:

- 24-hour staging soak with forced offline/online toggles and report artifact sign-off.

## References

- `README.md`
- `RELEASE.md`
- `SUPPORT.md`
- `PARITY_GATES.md`
- `PARITY_CHECKLIST.md`
- `docs/security-native-migration/README.md`
- `docs/security-native-migration/EXECUTION_BACKLOG.md`
- `docs/security-native-migration/STAGING_SOAK_RUNBOOK.md`
