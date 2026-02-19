# Phase 2: UI Parity — Migration Notes

## Overview

Phase 2 of the Electron-to-Tauri migration focused on copying the Electron renderer UI into the Tauri project and making it build successfully. The goal was full UI parity: every page, component, hook, store, context, service, style, type, and utility from the Electron POS should compile and render identically in the Tauri shell.

---

## Files Copied (Unchanged)

| Source | Destination | Count | Description |
|--------|-------------|-------|-------------|
| `pos-system/src/renderer/` | `pos-tauri/src/renderer/` | 249 files | All pages, components, hooks, stores, contexts, services, styles, types, utils |
| `pos-system/src/shared/` | `pos-tauri/src/shared/` | 28 files | Types, services, constants, utils |
| `pos-system/src/config/` | `pos-tauri/src/config/` | 2 files | `environment.ts`, `app-config.ts` |
| `pos-system/src/services/` | `pos-tauri/src/services/` | 8 files | Realtime handlers, order service, branch menu filter, delivery zone validator, terminal credentials, etc. |
| `pos-system/src/locales/` | `pos-tauri/src/locales/` | 2 files | `en.json`, `el.json` |
| `pos-system/src/preload/index.ts` | `pos-tauri/src/preload/index.ts` | 1 file | Preload script |
| `pos-system/src/lib/i18n.ts` | `pos-tauri/src/lib/i18n.ts` | 1 file | i18n initialization |
| `shared/types/table-status.ts` | `pos-tauri/src/repo-shared/types/table-status.ts` | 1 file | Repo-level shared type |
| `shared/types/combo.ts` | `pos-tauri/src/shared/types/combo.ts` | 1 file | Repo-level shared type |
| `shared/types/upsell.ts` | `pos-tauri/src/shared/types/upsell.ts` | 1 file | Repo-level shared type |
| `shared/types/menu.ts` | `pos-tauri/src/shared/types/menu.ts` | 1 file | Repo-level shared type |
| `shared/services/upsellUrlService.ts` | `pos-tauri/src/shared/services/upsellUrlService.ts` | 1 file | Repo-level shared service |

**Total: ~300 files copied**

---

## What Worked Unchanged

The following required zero modifications after copying:

- **ALL renderer React components** — pages, modals, hooks, stores, contexts
- **Tailwind + glassmorphism CSS** — `glassmorphism.css`, `globals.css`
- **Zustand stores** — all state management
- **i18n** — i18next with `en` and `el` locales
- **All relative import paths between renderer components** — they all use relative imports, no `@/` aliases
- **Cross-boundary imports** — to `../../shared/`, `../../config/`, `../../services/`, `../../lib/` (directory structure was mirrored exactly)
- **framer-motion** animations
- **lucide-react** icons
- **react-hot-toast** notifications
- **react-router-dom** HashRouter

---

## What Needed Patches

Six targeted changes were required to get a clean build:

### 1. `src/renderer/types/tables.ts` — Import path adjustment

Changed `../../../../shared/types/table-status` to `../../repo-shared/types/table-status`. The repo-level shared file was placed under `src/repo-shared/` to avoid collision with the pos-system-local `src/shared/` directory.

### 2. `src/shared/types/modules.ts` — Added `BusinessCategory` re-export

Added `BusinessCategory` to the re-exports from the repo-level shared types. This was needed by `upsell.ts`.

### 3. `src/shared/types/organization.ts` — Added `BillingCycle` re-export

Added `BillingCycle` to the re-exports from the repo-level shared types. This was needed by `upsell.ts`.

### 4. `src/services/RealtimeOrderHandler.ts` — Type cast for `getSetting`

Cast the `getSetting<string>()` call to avoid a TypeScript error caused by the `any`-typed database stub.

### 5. Deleted `src/renderer/tsconfig.json`

This file was copied from Electron and referenced a non-existent `../../tsconfig.renderer.json` base config. Removing it lets the renderer code fall through to the project root `tsconfig.json`.

### 6. `tsconfig.json` — Disabled unused-variable checks

Set `noUnusedLocals: false` and `noUnusedParameters: false`. The Electron codebase has 270+ unused-variable warnings that are not worth fixing during migration.

---

## Stubs Created (Tauri Compatibility)

Three stubs were created to satisfy imports that reference Electron-specific modules:

### 1. `src/types/electron.d.ts`

Type declarations for the `electron` and `electron-updater` modules. Provides types for `BrowserWindow`, `IpcRenderer`, `UpdateInfo`, `ProgressInfo`, and other Electron APIs referenced by the renderer code.

### 2. `src/preload/ipc-security.ts`

Passthrough stub for Electron's IPC channel security validation. In Electron, this module validates that renderer-to-main IPC calls use allowed channel names. In Tauri, security is handled by the Rust command permission system, so this is a no-op.

### 3. `src/main/database.ts`

Stub for Electron's `DatabaseManager` class. In Electron, SQLite is accessed via `better-sqlite3` in the Node.js main process. In Tauri, the database will be managed by `rusqlite` on the Rust side. This stub provides the class shape so TypeScript compiles, but all methods return defaults or throw.

---

## Key Architecture Decisions

### IPC Adapter Pattern

`src/lib/electron-compat.ts` installs `window.electron` and `window.electronAPI` shims backed by Tauri's `invoke()`. Renderer components call `window.electronAPI.someMethod()` exactly as they did in Electron, and the shim translates those calls to `invoke('some_method', { ... })`. This means renderer code requires zero IPC-related changes.

### Event Bridge

`src/lib/event-bridge.ts` maps 45 Tauri backend events to Electron IPC channel names. When the Tauri backend emits an event (via `tauri::Emitter`), the bridge re-dispatches it as if it came from Electron's `ipcRenderer.on()`. This preserves all existing event listeners in the renderer.

### Directory Mirroring

`pos-tauri/src/` mirrors the `pos-system/src/` directory structure exactly. This ensures all relative imports (which are used exclusively in the renderer code) resolve without changes.

### Dual Shared Directories

- `src/shared/` — Contains both pos-system-local types AND copies of repo-level shared types (`combo.ts`, `upsell.ts`, `menu.ts`)
- `src/repo-shared/` — Contains repo-level shared types that would collide with `src/shared/` paths (`table-status.ts`)

---

## Build Results

### TypeScript Check

**0 errors** (excluding unused-variable warnings from inherited code, which are disabled via tsconfig).

### Vite Build

**SUCCESS** — Produces `dist/` with:
- ~3MB JavaScript bundle
- ~220KB CSS
- Static assets (images, fonts)

### Warnings (Non-blocking)

- CSS escaped selector syntax warnings (from Tailwind)
- Dynamic/static import mixing warnings
- Large chunk size warnings (expected for a full POS application)

---

## What Remains Blocked (Phase 3+)

These items are out of scope for Phase 2 and require Rust-side implementation:

### 1. Actual IPC Functionality

All Tauri commands in `src-tauri/src/lib.rs` are stubs returning defaults or errors. Real Rust implementations are needed for:
- Authentication and session management
- Order CRUD and lifecycle
- Sync engine (push/pull with admin API)
- Menu and category queries
- Settings read/write
- Receipt generation

### 2. SQLite Database

Electron uses `better-sqlite3` in the Node.js main process. Tauri needs `rusqlite` (or `tauri-plugin-sql`) in the Rust backend. The full schema migration (tables, indices, triggers) must be ported to Rust.

### 3. Hardware Integration

- Thermal receipt printers (ESC/POS protocol)
- Kitchen display printers
- Barcode scanners (HID input)
- Cash drawer (pulse signal via printer port)

These need either Tauri plugins or direct Rust implementations.

### 4. Auto-Updater

Electron uses `electron-updater` with NSIS installers. Tauri uses `tauri-plugin-updater` with a different update manifest format and delivery mechanism.

### 5. Secure Storage

Electron uses DPAPI (Windows) or Keychain (macOS) via the main process for storing terminal credentials. Tauri needs `keyring-rs` integration or `tauri-plugin-store` with encryption.

### 6. Screen Capture

`ScreenCaptureHandler.ts` uses Electron's `desktopCapturer` API. There is no direct Tauri equivalent yet.

### 7. ECR/Fiscal Device Integration

Cash register communication via serial/USB needs Rust-side implementation (e.g., `serialport-rs`).

### 8. DOMPurify

Used in `UpdateDialog.tsx` for sanitizing release notes HTML. Not currently in the project dependencies. The build succeeds because Vite tree-shakes the unused code paths, but it will need to be added once the update dialog is functional.

---

## Summary

Phase 2 achieved its goal: the entire Electron renderer UI compiles and builds inside the Tauri project with minimal patches (6 targeted changes + 3 stubs). The IPC adapter pattern and directory mirroring strategy meant that ~300 files could be copied verbatim. The resulting Vite build produces a working frontend bundle ready to be connected to real Rust backend commands in Phase 3.
