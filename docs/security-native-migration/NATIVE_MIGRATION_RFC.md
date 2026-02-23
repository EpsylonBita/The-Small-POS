# POS Tauri Native Runtime RFC (Cutover Complete)

## Goal
Run `pos-tauri` as a native Rust/Tauri desktop app with no Electron runtime surfaces.

## Final Interface Strategy
- Desktop runtime is bridge-only (`TauriBridge`).
- Browser mode remains non-desktop safety/dev fallback only.
- No `window.electron*`, `window.isElectron`, preload bridge, or Electron module imports in `src/`.

## Runtime Contract
1. `Platform` is `tauri | browser`.
2. `getBridge()` resolves `TauriBridge` for desktop, browser stub otherwise.
3. `onEvent/offEvent` remain stable for renderer consumers and now bind directly to Tauri events.
4. `emitCompatEvent` is retained only as an in-process event emission helper for local compatibility use cases.

## Security/Build Guardrails
- `npm run test:native-runtime` runs:
  - `scripts/check-no-electron-surfaces.mjs`
  - `scripts/check-native-bootstrap.mjs`
- These checks fail if Electron globals/imports or compat bootstrap calls are reintroduced.

## Decommissioned Surfaces
- `src/lib/electron-compat.ts`
- `src/preload/index.ts`
- `src/preload/ipc-security.ts`
- `src/preload/types/electron-stubs.d.ts`
- `src/services/printer-service.ts` (unused Node-era runtime path)

## Compatibility Rules
- App-facing interfaces remain stable:
  - `getBridge`
  - `onEvent`
  - `offEvent`
- Legacy Electron globals are intentionally unsupported in `pos-tauri`.
