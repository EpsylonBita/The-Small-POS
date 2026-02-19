# Phase 4 Notes - The Small POS (Tauri)

## Prerequisites

### Rust Toolchain
```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# On Windows, use the installer from:
# https://www.rust-lang.org/tools/install
# Requires Visual Studio C++ Build Tools

# Verify installation
rustc --version    # should be >= 1.77
cargo --version
```

### Tauri CLI
```bash
# Install Tauri CLI (if not already)
cargo install tauri-cli

# Or use npm wrapper
npm install -g @tauri-apps/cli
```

### Node Dependencies
```bash
cd pos-tauri
npm install
```

## Build & Dev Commands

### Check Rust compilation (no binary output)
```bash
cd pos-tauri/src-tauri
cargo check
```

### Run in development mode (frontend + backend)
```bash
cd pos-tauri
cargo tauri dev
```

### Build release
```bash
cd pos-tauri
cargo tauri build
```

### Check TypeScript only (frontend)
```bash
cd pos-tauri
npx tsc --noEmit
```

### Run Vite dev server only (no Rust)
```bash
cd pos-tauri
npm run dev
```

## Phase 4 Progress

### Phase 4A — Foundations (COMPLETE)
- [x] `PARITY_GATES.md` — 5 gates defined (G1-G5)
- [x] `scripts/tauri-smoke.mjs` — interactive smoke test runner
- [x] `PHASE4_NOTES.md` — this file

### Phase 4B — Shifts (first command group) (COMPLETE)
- [x] DB migration v2: `staff_shifts` + `cash_drawer_sessions` tables
- [x] `shifts.rs` module: open, close, get_active, get_active_by_terminal,
      get_active_by_terminal_loose, get_active_cashier_by_terminal
- [x] Registered 6 shift commands in `lib.rs`
- [x] Sync queue integration (shift open/close enqueued)
- [x] Updated `PARITY_CHECKLIST.md`

### Phase 4C — Shift Sync + Expenses (COMPLETE)
- [x] DB migration v3: `shift_expenses` table (5 expense types, FK CASCADE)
- [x] Sync engine refactor: orders and shifts sync independently to separate endpoints
- [x] `/api/pos/shifts/sync` backend endpoint (direct upsert, idempotency via shift_id)
- [x] `shift_get_summary` command: order aggregation, payment breakdown, expense totals
- [x] `shift_record_expense` command: insert + update cash drawer + enqueue sync
- [x] `shift_get_expenses` command: list expenses for a shift
- [x] Registered 3 new commands in `lib.rs` (total: 9 shift commands)
- [x] Gate G6: Shift Offline Persistence + Sync Exactly-Once
- [x] Updated `PARITY_CHECKLIST.md` and `PARITY_GATES.md`

### Phase 4D-1 — Build & Correctness Gates (COMPLETE)
- [x] `scripts/verify-rust.sh` — cargo fmt + clippy + test (Bash/Linux/macOS)
- [x] `scripts/verify-rust.ps1` — cargo fmt + clippy + test (PowerShell/Windows)
- [x] `npm run pos:tauri:verify` — tsc + vite build + Rust verify (full gate)
- [x] `npm run pos:tauri:verify:win` — Windows variant of above
- [x] 7 Rust unit tests in `db.rs` (migrations, pragmas, FK cascade, idempotency, settings)
- [x] 33-assertion backend test script `admin-dashboard/scripts/test-shift-sync.mjs`
- [x] Build Gate and Runtime Gate sections added to `PARITY_GATES.md`

**Not in scope for 4D-1** (deferred to 4D-2+):
- `shift:record-staff-payment` — requires `staff_payments` table
- `shift:get-staff-payments` — depends on above
- `shift:backfill-driver-earnings` — requires `driver_earnings` table
- `shift:list-staff-for-checkin` — requires admin API fetch
- `shift:get-staff-roles` — requires admin API fetch

## Architecture Notes

### Shift Calculation Versions
The Electron POS uses two calculation versions for cash variance:
- **V1 (legacy)**: Staff payments deducted from expected cash
- **V2 (current)**: Staff payments are informational only

All new shifts created in Tauri use `calculation_version = 2`.
V1 support exists only for backward compatibility with synced legacy data.

### Shift State Flow
```
[No Shift] --open--> [Active] --close--> [Closed]
                                    |
                             (calculate variance)
```

### Driver Transfer (future)
When a cashier closes their shift, active drivers are marked with
`is_transfer_pending = 1`. The next cashier inherits them on check-in.
This is NOT implemented in Phase 4B — drivers can open/close shifts
but transfers require the full summary system.

## Known Limitations
- Rust toolchain not yet installed on dev machine — `cargo check` not yet verified
- Rust unit tests written but not yet executed (pending toolchain install)
- Driver transfer logic deferred to Phase 4D-2+
- Staff payments deferred to Phase 4D-2+
- Driver earnings deferred to Phase 4D-2+
- Shift expenses sync via `shift_expense` entity_type → routed to `/api/pos/shifts/sync`
  as `expense_record` events alongside shift open/close events

## Verification Scripts

### Automated (no app needed)
```bash
# Backend shift sync logic tests (33 assertions)
node admin-dashboard/scripts/test-shift-sync.mjs

# Full build gate (requires Rust toolchain)
cd pos-tauri && npm run pos:tauri:verify      # Linux/macOS
cd pos-tauri && npm run pos:tauri:verify:win   # Windows
```

### Manual (requires running app)
```bash
node pos-tauri/scripts/tauri-smoke.mjs
```
