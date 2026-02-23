# POS Tauri Audit Report (Phase 1)

## Scope
- Repo: `pos-tauri/`
- Coverage: all tracked files in `pos-tauri` included in `FILE_MATRIX.csv`
- Focus: P0/P1 security containment + native Tauri migration blockers

## P0/P1 Findings Implemented In This Pass
1. Service-role exposure hardening in renderer Supabase config.
2. IPC security stub replaced with channel/argument filtering and sanitization.
3. Receipt preview HTML now escapes dynamic content to mitigate stored XSS.
4. Legacy PowerShell HTML print path disabled (command-injection surface removed).
5. PIN lockout state persisted in DB-backed settings so restart cannot reset attempts.
6. Sensitive credentials (`pos_api_key`, `supabase_anon_key`) removed from plaintext `local_settings` mirroring; startup migrates then scrubs old plaintext keys.
7. Legacy plaintext `staff.simple_pin` flow removed from settings modal/login checks; migrated to hashed PIN flow.
8. `OrderService` no longer uses `localStorage` for terminal/org credential resolution.
9. Electron compatibility/preload surfaces removed from `pos-tauri` runtime; desktop is now bridge-only Tauri.

## Open Risks (Not Fully Eliminated In This Pass)
- Renderer still uses localStorage for non-identity UX/session caches (theme, prompt dismissal, active shift continuity).
- External URL policy now routes through a centralized Rust command allowlist; host governance still needs periodic review.
- Large monolithic Rust command registry (`lib.rs`) still needs modular decomposition.

## Evidence (Key Files)
- `pos-tauri/src/shared/supabase-config.ts`
- `pos-tauri/src/lib/platform-detect.ts`
- `pos-tauri/src/lib/event-bridge.ts`
- `pos-tauri/src-tauri/src/payments.rs`
- `pos-tauri/src-tauri/src/printers.rs`
- `pos-tauri/src-tauri/src/auth.rs`
- `pos-tauri/src-tauri/src/lib.rs`
- `pos-tauri/src/lib/ipc-adapter.ts`
- `pos-tauri/src/renderer/utils/electron-api.ts`
- `pos-tauri/src/renderer/components/order/OrderCard.tsx`
- `pos-tauri/src/renderer/components/OrderDashboard.tsx`
- `pos-tauri/src/renderer/components/modules/TrialModulePrompt.tsx`
- `pos-tauri/src/renderer/components/modules/ModuleUpsellCard.tsx`
- `pos-tauri/src/renderer/components/modules/LockedFeatureScreen.tsx`
- `pos-tauri/src/renderer/pages/KioskManagementPage.tsx`
- `pos-tauri/src/services/OrderService.ts`
- `pos-tauri/src/renderer/services/terminal-credentials.ts`
- `pos-tauri/src/renderer/contexts/shift-context.tsx`
- `pos-tauri/src/renderer/pages/verticals/hotel/RoomsView.tsx`
- `pos-tauri/src/renderer/pages/verticals/salon/AppointmentsView.tsx`
- `pos-tauri/src/renderer/pages/verticals/salon/ServiceCatalogView.tsx`
- `pos-tauri/src/renderer/pages/verticals/restaurant/ReservationsView.tsx`
- `pos-tauri/src/renderer/pages/verticals/retail/ProductCatalogView.tsx`
- `pos-tauri/src/renderer/pages/verticals/fast-food/DriveThruView.tsx`
- `pos-tauri/src/renderer/components/modals/ConnectionSettingsModal.tsx`
- `pos-tauri/src/renderer/pages/LoginPage.tsx`

## Next Priority
- Begin domain extraction from `src-tauri/src/lib.rs`.
- Reduce remaining Electron-compat direct method surface in core flows.
