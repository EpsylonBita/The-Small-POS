# POS Tauri Native Runtime RFC (Cutover Complete)

## Goal
Run `pos-tauri` as a native Rust/Tauri desktop app with no legacy desktop runtime surfaces.

## Final Interface Strategy
- Desktop runtime is bridge-only (`TauriBridge`).
- Browser mode remains non-desktop safety/dev fallback only.
- No legacy desktop globals (e.g. `window.*` desktop-API shims), preload bridges, or non-Tauri desktop module imports in `src/`.

## Runtime Contract
1. `Platform` is `tauri | browser`.
2. `getBridge()` resolves `TauriBridge` for desktop, browser stub otherwise.
3. `onEvent/offEvent` remain stable for renderer consumers and now bind directly to Tauri events.
4. `emitCompatEvent` is retained only as an in-process event emission helper for local compatibility use cases.

## Security/Build Guardrails
- `npm run test:native-runtime` runs the legacy-desktop-surface check and the native-bootstrap check (under `scripts/`).
- These checks fail if legacy desktop globals/imports or compat bootstrap calls are reintroduced.

## Decommissioned Surfaces
- Legacy desktop compatibility helper module under `src/lib/`.
- Preload index, IPC security, and stub typings under `src/preload/`.
- `src/services/printer-service.ts` (unused Node-era runtime path).

## Compatibility Rules
- App-facing interfaces remain stable:
  - `getBridge`
  - `onEvent`
  - `offEvent`
- Legacy desktop globals are intentionally unsupported in `pos-tauri`.
