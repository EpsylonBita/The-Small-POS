# The Small POS (Tauri Desktop)

Tauri desktop runtime for The Small POS.

`pos-tauri/` is the desktop source of truth for local development, packaging, updater artifacts, and support operations.

## Status Snapshot (2026-02-23)

- Native-only cutover is complete in `pos-tauri` (no desktop runtime dependency on Electron globals or preload surfaces).
- Desktop runtime path is bridge-only: renderer -> typed bridge -> Tauri commands/events -> Rust services.
- Offline-first behavior is active: local SQLite write + sync queue first, remote sync deferred while offline, automatic queue drain on reconnect.
- Security/native migration implementation is complete except for the planned 24-hour staging soak run.

## Runtime At A Glance

- Frontend: React 19 + TypeScript + Vite (`src/renderer/`)
- Desktop bridge: `src/lib/ipc-adapter.ts`, `src/lib/event-bridge.ts`
- Backend: Rust command/service modules (`src-tauri/src/commands/`, `src-tauri/src/services/`)
- Data: SQLite (`pos.db`) + sync queue + keyring-backed credentials
- Packaging: Windows x64 NSIS bundle + signed updater manifest (`latest.json`)

## Project Layout

- `src-tauri/`: Rust backend, Tauri config/capabilities, build metadata
- `src/`: React renderer, bridge contracts, runtime adapters
- `scripts/`: parity/security checks, smoke runner, release helpers
- `docs/`: security migration artifacts and archived parity material

## Prerequisites

- Node.js 20+
- npm
- Rust stable toolchain
- Windows target: `x86_64-pc-windows-msvc`
- Visual Studio Build Tools (for Windows native Rust dependencies)

## Quick Start

Install:

```bash
npm ci
```

Run desktop app in dev:

```bash
npm run pos:tauri:dev
```

Type-check and production frontend build:

```bash
npm run type-check
npm run build
```

## Verification Gates

Run these before merge/release:

```bash
npm run parity:contract
npm run test:native-runtime
cargo check --keep-going --manifest-path src-tauri/Cargo.toml
```

Full packaged verification:

```bash
npm run pos:tauri:verify:win
```

## Build, Release, and Updater

Build Windows installer:

```bash
npm run pos:tauri:bundle:win
```

Release/manifest/signing details are documented in `RELEASE.md`.

## Documentation Map

Current architecture and operations:

- `ARCHITECTURE.md`: runtime topology, offline sync model, security boundaries
- `RELEASE.md`: release automation, version sync, updater contract
- `SUPPORT.md`: diagnostics, common incident playbooks, data locations
- `docs/README.md`: documentation index and ownership

Security/native migration program:

- `docs/security-native-migration/README.md`: artifact index and refresh workflow
- `docs/security-native-migration/EXECUTION_BACKLOG.md`: implementation ledger
- `docs/security-native-migration/AUDIT_REPORT.md`: findings and risk classes
- `docs/security-native-migration/SECURITY_VERIFICATION_PACK.md`: regression scenarios

Parity and phase history:

- `PARITY_GATES.md`: active parity gate definitions and execution model
- `PARITY_CHECKLIST.md`: active parity status tracker
- `docs/archive/parity/`: archived legacy parity tables and legacy gate document
- `PHASE2_NOTES.md`, `PHASE4_NOTES.md`, `PHASE8_COMPLETE.md`, `PHASE8_SUMMARY.md`: migration history notes
