# Parity Gates - The Small POS (Tauri)

Quality gates that MUST pass before shipping any Phase 4+ feature.
Each gate has manual test steps and a clear pass/fail criterion.

---

## Gate 1: Offline Order Creation + Restart Persistence

**What it tests:** Orders created while offline survive app restarts and are still present in SQLite.

### Steps
1. Disconnect from network (disable WiFi / unplug ethernet)
2. Open the POS app (`tauri dev`)
3. Create 3 orders with different order types (dine-in, takeaway, delivery)
4. Verify each returns `{ success: true, order: { syncStatus: "pending" } }`
5. Close the app completely (Ctrl+C the dev server)
6. Re-launch the app
7. Call `order_get_all` — all 3 orders must be present with `syncStatus: "pending"`
8. Verify `sync_queue` has 3 entries with `status: "pending"`

### Pass Criteria
- [ ] 3 orders returned after restart
- [ ] All have `syncStatus: "pending"`
- [ ] `sync_queue` has 3 matching entries
- [ ] No data corruption (items JSON parses correctly)

---

## Gate 2: Sync Idempotency (No Duplicates)

**What it tests:** The sync engine does not create duplicate orders on the admin side when retrying.

### Steps
1. Create 1 order while online
2. Force sync (`sync_force`)
3. Verify order's `syncStatus` is `"synced"` in SQLite
4. Verify `sync_queue` entry has `status: "synced"` and a `synced_at` timestamp
5. Force sync again — should be a no-op (0 items synced)
6. Check admin dashboard — only 1 copy of the order exists
7. Simulate a retry scenario:
   a. Create another order
   b. Manually set its `sync_queue.status` back to `"pending"` after it syncs
   c. Force sync — the `idempotency_key` should prevent a duplicate on the server

### Pass Criteria
- [ ] No duplicate orders after multiple sync cycles
- [ ] `idempotency_key` is unique per sync_queue entry
- [ ] Re-syncing already-synced items is a no-op
- [ ] Retry counter increments on failure, caps at `max_retries` (5)

---

## Gate 3: Menu Cache Stability

**What it tests:** Menu data persists across restarts and survives a sync refresh without data loss.

### Steps
1. Connect to admin and sync menu (`terminal_config_refresh`)
2. Verify `menu_get_categories` returns non-empty array
3. Verify `menu_get_subcategories` returns non-empty array
4. Close and re-launch the app
5. Verify categories and subcategories are still present (read from cache)
6. Trigger another menu sync — verify data is updated, not duplicated
7. Disconnect from network, verify cached menu still returns data

### Pass Criteria
- [ ] Menu data survives restart
- [ ] Menu sync updates in-place (no duplicated categories)
- [ ] Offline reads return cached data
- [ ] `menu_cache` table has exactly 4 keys (categories, subcategories, ingredients, combos)

---

## Gate 4: Auth Lockout

**What it tests:** After 5 failed PIN attempts, the account is locked for 15 minutes.

### Steps
1. Set up a staff PIN via `auth_setup_pin`
2. Attempt login with wrong PIN 5 times
3. On the 6th attempt (even with correct PIN), verify lockout error is returned
4. Verify lockout message includes remaining time
5. Wait 15 minutes (or adjust lockout duration for testing)
6. Verify login succeeds with correct PIN after lockout expires

### Pass Criteria
- [ ] 5 wrong attempts allowed before lockout
- [ ] 6th attempt returns lockout error regardless of PIN correctness
- [ ] Lockout duration is ~15 minutes
- [ ] Successful login after lockout expiry
- [ ] Session is created with correct role and permissions

---

## Gate 5: Shift Lifecycle (Added Phase 4B)

**What it tests:** Shifts can be opened and closed with correct cash variance calculation.

### Steps
1. Open a cashier shift with `opening_cash_amount: 100.00`
2. Verify shift returned with `status: "active"`
3. Call `shift_get_active` with staff_id — returns the active shift
4. Call `shift_get_active_by_terminal` — returns the same shift
5. Create 2 orders (1 cash, 1 card) linked to the shift
6. Close the shift with `closing_cash: 150.00`
7. Verify variance calculation is correct
8. Verify shift `status` is `"closed"` and `sync_queue` has shift entries

### Pass Criteria
- [ ] Shift opens with unique ID and `status: "active"`
- [ ] Only 1 active shift per staff member at a time
- [ ] Cash drawer session created for cashier role
- [ ] Shift close calculates expected/variance correctly
- [ ] Closed shift enqueued for sync
- [ ] Cannot open duplicate active shift for same staff

---

## Gate 6: Shift Offline Persistence + Sync Exactly-Once (Added Phase 4C)

**What it tests:** Shifts opened/closed while offline survive restarts and sync exactly once when connectivity returns.

### Steps
1. Disconnect from network
2. Open a cashier shift with `opening_cash: 200.00`
3. Record an expense: `{ shiftId, amount: 15.00, expenseType: "supplies", description: "Napkins" }`
4. Verify `shift_get_expenses(shiftId)` returns 1 expense
5. Close the shift with `closing_cash: 250.00`
6. Close and re-launch the app
7. Verify `shift_get_active(staffId)` returns null (shift is closed)
8. Call `shift_get_summary(shiftId)` — verify expense total = 15.00, shift status = closed
9. Verify `sync_queue` has 3 entries: shift open, expense, shift close — all `status: "pending"`
10. Reconnect to network
11. Force sync (`sync_force`)
12. Verify all 3 sync_queue entries are `status: "synced"`
13. Force sync again — should be a no-op (0 items synced)
14. Check admin dashboard `staff_shifts` table — shift exists with correct variance
15. Repeat steps 11-13 to confirm idempotency

### Pass Criteria
- [ ] Shift persists across restart while offline
- [ ] Expense persists across restart while offline
- [ ] Closed shift's summary shows correct expense total
- [ ] sync_queue has exactly 3 entries (open + expense + close) with no duplicates
- [ ] All 3 entries sync successfully on reconnect
- [ ] Re-syncing is a no-op (idempotency_key prevents duplicates)
- [ ] Server has the shift with correct status, variance, and cash amounts

---

## Build Gate (Added Phase 4D)

**What it tests:** The Rust backend compiles cleanly and all automated tests pass.

### Automated Checks

Run via `npm run pos:tauri:verify` (or `pos:tauri:verify:win` on Windows):

1. **TypeScript**: `tsc --noEmit` — 0 errors
2. **Vite**: `vite build` — frontend bundle succeeds
3. **cargo fmt**: `cargo fmt --check` — no formatting violations
4. **cargo clippy**: `cargo clippy -- -D warnings` — no lint warnings
5. **cargo test**: all Rust unit tests pass

### Rust Test Coverage

| Test | Module | What it verifies |
|------|--------|------------------|
| `test_migrations_v1_to_latest` | db.rs | All tables created across v1→v8 migrations |
| `test_foreign_keys_enabled` | db.rs | `PRAGMA foreign_keys = ON` |
| `test_wal_mode_on_file_db` | db.rs | `PRAGMA journal_mode = WAL` on file-backed DB |
| `test_migrations_are_idempotent` | db.rs | Running migrations twice is a no-op |
| `test_shift_expenses_fk_cascade` | db.rs | Deleting shift cascades to expenses |
| `test_sync_queue_idempotency_key_unique` | db.rs | Duplicate idempotency_key is rejected |
| `test_printer_profiles_table` | db.rs | Printer profiles table + CHECK constraints |
| `test_settings_crud` | db.rs | Settings get/set/delete round-trip |
| `test_create_and_list_profiles` | printers.rs | Profile CRUD + list |
| `test_update_profile` | printers.rs | Profile field updates |
| `test_delete_profile_clears_default` | printers.rs | Delete clears default setting |
| `test_default_printer_profile` | printers.rs | Default profile get/set |
| `test_resolve_printer_profile` | printers.rs | Profile resolution (job > default > none) |
| `test_reprint_job` | printers.rs | Failed job reset for reprint |
| `test_reprint_non_failed_job_errors` | printers.rs | Non-failed job reprint rejected |
| `test_list_system_printers_returns_vec` | printers.rs | Windows printer enumeration |
| `test_invalid_driver_type_rejected` | printers.rs | Driver validation |
| `test_invalid_paper_width_rejected` | printers.rs | Paper width validation |
| `test_migration_v8_drawer_columns` | db.rs | Drawer fields on printer_profiles + CHECK constraints |
| `test_open_drawer_no_profile` | drawer.rs | No profile returns success: false |
| `test_open_drawer_disabled` | drawer.rs | Disabled drawer returns success: false |
| `test_open_drawer_mode_none` | drawer.rs | Mode "none" returns success: false |
| `test_open_drawer_invalid_host` | drawer.rs | Invalid TCP host returns descriptive error |
| `test_rate_limiter` | drawer.rs | Rate limiter blocks rapid kicks |
| `test_rate_limiter_allows_after_interval` | drawer.rs | Rate limiter clears after interval |
| `test_try_drawer_kick_disabled_is_noop` | drawer.rs | Disabled drawer in worker is no-op |
| `test_try_drawer_kick_mode_none_is_noop` | drawer.rs | Mode "none" in worker is no-op |
| `test_escpos_command_bytes` | drawer.rs | ESC/POS pulse command is correct 5 bytes |
| `test_send_escpos_pulse_invalid_address` | drawer.rs | Invalid address format rejected |
| `test_tcp_pulse_receives_exact_bytes` | drawer.rs | TCP server receives correct 5-byte ESC/POS pulse |
| `test_tcp_pulse_failure_returns_error` | drawer.rs | Closed port returns descriptive TCP error |
| `test_try_drawer_kick_failure_returns_err` | drawer.rs | `try_drawer_kick_after_print` returns Err on TCP failure |
| `test_rate_limiter_per_profile` | drawer.rs | Per-profile rate limiting (different profiles independent) |
| `test_set_print_job_warning` | print.rs | Warning code/message stored without changing job status |
| `test_print_job_last_attempt_at_set` | print.rs | `lastAttemptAt` populated after printing |
| `test_migration_v9_warning_columns` | db.rs | Warning columns exist on print_jobs after migration |
| `test_migration_v10_payment_adjustments` | db.rs | payment_adjustments table + CHECK + FK cascade |
| `test_refund_partial` | refunds.rs | Partial refund records adjustment, balance correct |
| `test_refund_full_marks_refunded` | refunds.rs | Full refund sets payment status to 'refunded' |
| `test_refund_exceeds_balance_rejected` | refunds.rs | Over-refund blocked with descriptive error |
| `test_refund_voided_payment_rejected` | refunds.rs | Refund of voided payment rejected |
| `test_void_creates_adjustment` | refunds.rs | Void creates adjustment record + sync entries |
| `test_list_order_adjustments` | refunds.rs | Lists all adjustments for an order |
| `test_get_payment_balance` | refunds.rs | Balance = original − refunds |
| `test_get_payment_balance_voided` | refunds.rs | Voided payment balance = 0 |
| `test_refund_waiting_parent_sync_state` | refunds.rs | Unsynced payment → adjustment deferred |
| `test_multiple_refunds_then_void_rejected` | refunds.rs | Refund then void works, 2 adjustments |
| `test_reconcile_promotes_waiting_parent_adjustments` | sync.rs | Deferred adjustments promoted after payment sync |
| `test_reconcile_does_not_promote_unsynced_payment_adjustments` | sync.rs | Unsynced payment → adjustment stays deferred |

### Backend Test Coverage

Run via `node admin-dashboard/scripts/test-shift-sync.mjs`:

| Test | What it verifies |
|------|------------------|
| Request validation | Schema enforcement (event_type, shift_id, idempotency_key) |
| Shift open idempotency | Same shift_id → skip on second attempt |
| Close-before-open | Missing shift inserted as closed (no data loss) |
| Expense idempotency | Duplicate expense_id → skip, total_expenses unchanged |
| Expense rollup | total_expenses accumulates correctly across unique expenses |
| Full lifecycle | open→expense→close all sync; full replay skips all |
| Close idempotency | Already-closed shift → skip with correct message |

### Pass Criteria
- [ ] `npm run pos:tauri:verify` exits 0 (or `pos:tauri:verify:win` on Windows)
- [ ] `node admin-dashboard/scripts/test-shift-sync.mjs` exits 0 (33 assertions pass)

---

## Runtime Gate (Added Phase 4D)

**What it tests:** The app starts, serves requests, and G6 passes end-to-end.

### Steps
1. Install Rust toolchain if not present (`rustup` or `rust-lang.org/tools/install`)
2. Run `npm run pos:tauri:verify` — must exit 0 (Build Gate)
3. Run `cargo tauri dev` — app window must open without crash
4. Execute Gate G6 (Shift Offline Persistence + Sync Exactly-Once) manually
5. Confirm all G6 pass criteria in the checklist above

### Pass Criteria
- [ ] Build Gate passes
- [ ] `tauri dev` launches without panic or crash
- [ ] G6 passes (shift + expense survive offline restart, sync exactly once)

---

## Running Gates

See `scripts/tauri-smoke.mjs` for the interactive checklist, or run gates manually
following the steps above.

---

## Gate 8: Payment Offline Persistence + Exactly-Once Sync

**What it tests:** Payments recorded offline persist across restarts, sync exactly once via `/api/pos/payments`, and receipt preview generates valid HTML.

### Steps
1. Disconnect from network (disable WiFi / unplug ethernet)
2. Open a shift (cashier)
3. Create an order via the POS flow (pickup, 2+ items)
4. Complete payment — cash, amount 25.00, received 30.00
5. Verify `order_payments` has 1 row:
   - `method: 'cash'`, `amount: 25.0`, `cash_received: 30.0`, `change_given: 5.0`
   - `status: 'completed'`, `sync_status: 'pending'`
6. Verify `orders` row has `payment_status: 'paid'`, `payment_method: 'cash'`
7. Verify `sync_queue` has entries for both `order` and `payment` entity types
8. Close the app completely (Ctrl+C the dev server)
9. Re-launch the app
10. Verify `order_payments` row still present (survives restart)
11. Reconnect network, call `sync:force`
12. Order syncs first (gets `supabase_id`), payment may defer if order not yet synced
13. Call `sync:force` again — payment syncs to `/api/pos/payments`
14. Verify `order_payments.sync_status = 'synced'`
15. Call `sync:force` — no-op (0 items synced)
16. Select the order in OrderDashboard → bulk action "receipt" → verify HTML receipt preview renders in modal

### Pass Criteria
- [ ] Payment persists in `order_payments` after restart
- [ ] Order `payment_status` is `'paid'`
- [ ] Payment syncs exactly once (idempotency key prevents duplicates)
- [ ] Payment defers gracefully when order has no `supabase_id` yet
- [ ] Receipt preview generates valid HTML with items, totals, and payment info
- [ ] Third sync is a no-op (0 items)

---

## Gate 9: Order-Payment Reconciliation (Added Phase 5B)

**What it tests:** Deferred payments (created while offline before the parent order syncs) are automatically reconciled and synced exactly-once after the parent order syncs, even across app restarts.

### Prerequisite
- Terminal configured with admin URL + API key
- Admin dashboard running at configured URL

### Steps
1. Disconnect from network (disable WiFi / unplug ethernet)
2. Open a cashier shift
3. Create an order via the POS flow (pickup, amount 30.00)
4. Record a cash payment: `{ orderId, method: "cash", amount: 30.00, cashReceived: 50.00, changeGiven: 20.00 }`
5. Verify `order_payments` has 1 row with `sync_state: 'waiting_parent'`
6. Verify `sync_queue` has the payment entry with `status: 'deferred'`
7. Close the app completely (Ctrl+C / kill process)
8. Re-launch the app
9. Verify `order_payments` row survives restart with `sync_state: 'waiting_parent'`
10. Reconnect to network
11. Call `sync_force` — order syncs first (gets `supabase_id`)
12. Verify inline reconciliation promoted payment: `order_payments.sync_state` should be `'pending'` or `'applied'`
13. Call `sync_force` again — payment syncs to `/api/pos/payments`
14. Verify `order_payments.sync_state = 'applied'`, `sync_status = 'synced'`
15. Call `sync_force` a third time — should be a no-op (0 items synced)
16. On the admin dashboard, verify the order shows `payment_status: 'paid'` once and only once
17. Attempt to re-send the same payment (replay the idempotency key) — server returns 200 with `"Payment already recorded"`

### Pass Criteria
- [ ] Payment created with `sync_state: 'waiting_parent'` when order has no `supabase_id`
- [ ] `sync_queue` entry is `'deferred'` (not picked up by main sync loop)
- [ ] Payment survives app restart with `sync_state` intact
- [ ] After order syncs and gets `supabase_id`, payment is auto-promoted to `'pending'`
- [ ] Payment syncs exactly once to `/api/pos/payments`
- [ ] `sync_state` transitions: `waiting_parent` -> `pending` -> `syncing` -> `applied`
- [ ] Idempotency key prevents duplicate server-side payment
- [ ] Server rejects overpayment (amount > order total + tip)
- [ ] Third `sync_force` is a no-op (0 items)
- [ ] Admin dashboard shows order paid once, not duplicated

---

## Gate 10: Print Pipeline Offline Safety + Idempotency (Added Phase 6A)

**What it tests:** Print jobs created offline survive app restarts, the print worker generates receipt files on demand, and repeated print clicks do not create duplicate jobs.

### Prerequisite
- Terminal configured (any state — online or offline)
- At least 1 completed order in the database

### Steps
1. Create an order via the POS flow (any type)
2. Record a payment for the order (cash, any amount)
3. Click "Print Receipt" — verify `print_list_jobs` returns 1 job with `status: 'pending'`
4. Click "Print Receipt" again for the same order — verify **no duplicate** (same jobId returned, `duplicate: true`)
5. Wait 5 seconds (print worker interval) — verify job transitions to `status: 'printed'`
6. Verify `outputPath` points to a valid `.html` file on disk
7. Read the generated file — verify it contains the order number, items, and totals
8. Close the app completely (Ctrl+C the dev server)
9. Re-launch the app
10. Call `print_list_jobs` — the printed job still has `status: 'printed'` and `outputPath`
11. Create a new order (offline), click "Print Receipt"
12. Close the app **before** the print worker runs (within 5s)
13. Re-launch the app
14. Verify the pending print job survives restart with `status: 'pending'`
15. Wait for the worker to run — verify it transitions to `'printed'`
16. Call `print_get_receipt_file(orderId)` for any order — verify it returns a valid file path

### Pass Criteria
- [ ] Enqueue returns `{ success: true, jobId }` for first click
- [ ] Duplicate click returns `{ success: true, jobId, duplicate: true }` — no new row
- [ ] Print worker generates `.html` receipt files in the `receipts/` directory
- [ ] Generated receipt contains order number, items, totals, and payment info
- [ ] Print jobs survive app restart (pending and printed states preserved)
- [ ] Failed jobs retry up to 3 times with exponential backoff
- [ ] After max retries exhausted, job status is `'failed'`
- [ ] A new enqueue for a failed entity creates a fresh job
- [ ] `print_get_receipt_file` generates on-demand receipt files

---

## Gate 11: Hardware Printing Resilience (Added Phase 6B-1)

**What it tests:** Printer profiles can be configured, print jobs dispatch to Windows printers, and printing failures never block checkout.

### Prerequisite
- Windows system with at least 1 printer installed (real or virtual like "Microsoft Print to PDF")
- At least 1 completed order with payment in the database

### Steps
1. Call `printer_list_system_printers` — verify it returns the system's installed printers
2. Create a printer profile with an **invalid** printer name:
   ```
   printer_create_profile({ name: "Bad Printer", printerName: "NONEXISTENT_PRINTER_XYZ" })
   ```
3. Set it as default: `printer_set_default_profile(profileId)`
4. Create an order, record a payment, click "Print Receipt"
5. Wait for print worker (5s) — verify the print job status is `'failed'` (not stuck in printing)
6. Verify the order remains `payment_status: 'paid'` — **checkout is not rolled back**
7. Verify a receipt `.html` file was still generated on disk (file-only artifact exists)
8. Now update the profile with a **valid** printer name:
   ```
   printer_update_profile({ id: profileId, printerName: "Microsoft Print to PDF" })
   ```
9. Call `print_reprint_job(jobId)` to retry the failed job
10. Wait for print worker (5s) — verify the job transitions to `'printed'`
11. Verify the print was dispatched to Windows (PDF file created or print dialog appeared)
12. Call `print_reprint_job(jobId)` again — should error (job is no longer 'failed')
13. Create another order + payment, click "Print Receipt" — verify it prints successfully on first attempt
14. Delete the printer profile, verify default is cleared
15. Create a new print job — verify it succeeds in file-only mode (no hardware printer configured)

### Pass Criteria
- [ ] `printer_list_system_printers` returns installed Windows printers
- [ ] Printer profiles support full CRUD (create, read, update, delete)
- [ ] Default printer profile persists in `local_settings`
- [ ] Print job with invalid printer fails gracefully (no checkout rollback)
- [ ] Receipt HTML file is generated even when hardware print fails
- [ ] `print_reprint_job` resets a failed job for retry
- [ ] Reprinted job succeeds with valid printer
- [ ] Reprint of non-failed job returns error (no duplicates)
- [ ] Deleting the default profile clears the default setting
- [ ] No printer configured = file-only mode (job marked 'printed' with output path)

---

## Gate 12: Cash Drawer Resilience (Added Phase 6B-2, updated Phase 6C)

**What it tests:** Cash drawer kick via ESC/POS over TCP is non-fatal — failures never block checkout or printing, and the drawer command works independently from the print pipeline.  Phase 6C adds per-profile rate limiting, print job warnings, and deterministic TCP tests.

### Prerequisite
- Terminal configured with at least 1 printer profile
- No physical drawer needed (test verifies failure resilience + command plumbing)

### Steps
1. Create a printer profile with drawer **disabled** (default):
   ```
   printer_create_profile({ name: "No Drawer", printerName: "TestPrinter" })
   ```
2. Set as default, call `drawer_open` — returns `{ success: false, message: "disabled" }`
3. Update profile to enable drawer with mode `none`:
   ```
   printer_update_profile({ id, openCashDrawer: true })
   ```
4. Call `drawer_open` — returns `{ success: false, message: "...none..." }` (no hardware configured)
5. Update profile to `drawer_mode: "escpos_tcp"` with **invalid** host:
   ```
   printer_update_profile({ id, drawerMode: "escpos_tcp", drawerHost: "192.0.2.1", drawerPort: 9100 })
   ```
6. Call `drawer_open` — returns **error** (TCP connect fails to unreachable host)
7. Verify: the order still exists with `payment_status: 'paid'` — checkout was **not** rolled back
8. Verify: any print job for this order has `status: 'printed'` — printing independent of drawer
9. Call `drawer_open` immediately again — should return rate-limit error ("wait Xms")
10. Wait 2 seconds, call `drawer_open` — should attempt TCP again (rate limit clears)
11. Create a second printer profile with a different drawer host — verify both profiles can be rate-limited independently
12. Create a new order + payment, enqueue a print job with this profile
13. Wait for print worker — verify job is `'printed'` despite drawer kick failure
14. Verify the printed job has `warningCode: "drawer_kick_failed"` and a non-null `warningMessage`
15. Check logs — drawer kick error is a `WARN`, not an `ERROR` that blocks the job
16. Verify `lastAttemptAt` is set on the print job
17. (Optional, if a local TCP echo server is available on port 9100):
    - Start a TCP server: `python -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',9100)); s.listen(1); c,a=s.accept(); d=c.recv(5); print(list(d)); c.close(); s.close()"`
    - Update profile: `drawerHost: "127.0.0.1"`
    - Call `drawer_open` — returns `{ success: true }`
    - Python should print `[27, 112, 0, 25, 250]` (the ESC/POS pulse bytes)
18. Delete the printer profile — verify it cleans up

### Pass Criteria
- [ ] `drawer_open` with disabled profile returns `{ success: false }` — no crash
- [ ] `drawer_open` with mode `none` returns `{ success: false }` — no crash
- [ ] `drawer_open` with invalid TCP host returns error, but checkout/printing unaffected
- [ ] Rate limiter is per-profile (two different profiles can kick independently)
- [ ] Rate limiter prevents drawer kick within 2 seconds for the **same** profile
- [ ] Print worker marks job as `'printed'` even when drawer kick fails (non-fatal)
- [ ] Failed drawer kick sets `warningCode: "drawer_kick_failed"` on the print job
- [ ] `warningMessage` contains the TCP error description
- [ ] `lastAttemptAt` is set on printed and failed jobs
- [ ] Drawer kick errors appear as `WARN` in logs, never blocking
- [ ] (Optional) With local TCP server, drawer kick sends correct ESC/POS bytes
- [ ] Profile CRUD includes drawer fields (drawerMode, drawerHost, drawerPort, drawerPulseMs)
- [ ] DB migration v8 adds 4 new columns to printer_profiles with correct defaults
- [ ] DB migration v9 adds 3 warning columns to print_jobs (warning_code, warning_message, last_attempt_at)

---

## Gate 13: Void/Refund Offline Persistence + Exactly-Once Sync (Added Phase 7A)

**What it tests:** Voids and refunds recorded offline survive app restarts, create auditable `payment_adjustments` records, sync exactly once after the parent payment syncs, and receipt previews show adjustment lines.

### Prerequisite
- Terminal configured with admin URL + API key
- Admin dashboard running at configured URL

### Steps
1. Disconnect from network (disable WiFi / unplug ethernet)
2. Open a cashier shift
3. Create an order via the POS flow (pickup, total 50.00)
4. Record a cash payment: `{ orderId, method: "cash", amount: 50.00, cashReceived: 50.00 }`
5. **Partial refund**: Call `refund_payment({ paymentId, amount: 15.00, reason: "Item returned" })`
6. Verify `payment_adjustments` has 1 row: `adjustment_type: 'refund'`, `amount: 15.0`, `sync_state: 'waiting_parent'`
7. Verify `sync_queue` has adjustment entry with `status: 'deferred'`
8. Call `refund_get_payment_balance(paymentId)` — verify `balance: 35.0`, `totalRefunds: 15.0`
9. **Void attempt on refunded payment**: Call `refund_void_payment({ paymentId, reason: "Cancel" })`
10. Verify payment status is now `'voided'` and `payment_adjustments` has 2 rows (1 refund + 1 void)
11. Call `refund_get_payment_balance(paymentId)` — verify `balance: 0.0`, `status: 'voided'`
12. **Receipt preview**: Call `payment_get_receipt_preview(orderId)` — verify HTML contains "REFUND" and "VOID" lines with amounts and reasons
13. **Over-refund rejection**: Record a new payment (30.00), attempt refund of 35.00 — should return error "exceeds remaining balance"
14. Close the app completely (Ctrl+C the dev server)
15. Re-launch the app
16. Verify `payment_adjustments` rows survive restart with `sync_state` intact
17. Call `refund_list_order_adjustments(orderId)` — verify both adjustments present
18. Reconnect to network
19. Call `sync_force` — order syncs first (gets `supabase_id`)
20. Call `sync_force` — payment syncs (gets `sync_state: 'applied'`)
21. Call `sync_force` — adjustment reconciliation promotes adjustments from `waiting_parent` → `pending`
22. Call `sync_force` — adjustments sync to `/api/pos/payments/adjustments/sync`
23. Verify `payment_adjustments` rows have `sync_state: 'applied'`
24. Call `sync_force` again — should be a no-op (0 items synced)
25. On admin dashboard: verify order payment shows correct adjustments

### Pass Criteria
- [ ] Partial refund records a `payment_adjustments` row with `adjustment_type: 'refund'`
- [ ] Refund validates remaining balance — over-refund rejected with descriptive error
- [ ] Full refund (amount == original) sets payment status to `'refunded'`
- [ ] Void creates both a `payment_adjustments` void record AND marks `order_payments.status = 'voided'`
- [ ] `get_payment_balance` returns correct values: `originalAmount`, `totalRefunds`, `balance`
- [ ] Voided payment balance is 0, regardless of prior refunds
- [ ] Refund of voided payment is rejected
- [ ] `list_order_adjustments` returns all adjustments for the order
- [ ] Adjustment `sync_state` starts as `'waiting_parent'` when parent payment not yet synced
- [ ] Adjustment `sync_queue` entry starts as `'deferred'`
- [ ] After payment syncs, adjustment reconciliation promotes to `'pending'`
- [ ] Adjustments sync exactly once to `/api/pos/payments/adjustments/sync`
- [ ] `sync_state` transitions: `waiting_parent` → `pending` → `syncing` → `applied`
- [ ] Idempotency key (`adjustment:{id}`) prevents duplicate server-side records
- [ ] Receipt preview HTML includes "REFUND" and "VOID" lines with amounts and reasons
- [ ] All data survives app restart (SQLite persistence)
- [ ] Final `sync_force` is a no-op (0 items)

---

## Gate 14: End-of-Day Close + Z-Report Offline

**What it tests:** Z-reports generated after shift close survive app restarts, print to file, and sync exactly once to the admin dashboard.

### Steps
1. Disconnect from network
2. Open a cashier shift (opening cash: 200.00)
3. Create 3 orders (totals: 25.00, 35.00, 40.00 = 100.00 gross)
4. Record cash payments for orders 1+2 (25.00 + 35.00 = 60.00 cash)
5. Record card payment for order 3 (40.00 card)
6. Partial refund on order 1: 10.00 (reason: "wrong item")
7. Record an expense: 15.00 (type: supplies)
8. Close shift (closing cash: 235.00) — expected = 200 + 60 - 10 - 15 = 235.00 (variance: 0)
9. Call `zreport_generate({ shiftId })` — verify report returned with correct totals:
   - gross_sales: 100.00, refunds_total: 10.00, net_sales: 90.00
   - cash_sales: 60.00, card_sales: 40.00, expenses_total: 15.00
   - cash_variance: 0.00, total_orders: 3
10. Verify `z_reports` table has 1 row with `sync_state: 'pending'`
11. Verify `sync_queue` has entry `entity_type: 'z_report'`, `status: 'pending'`
12. Call `zreport_print({ zReportId })` — verify print job enqueued
13. Verify `print_jobs` has entry `entity_type: 'z_report'`, `status: 'pending'`
14. Close the app completely
15. Re-launch the app
16. Verify `z_reports` row survives restart with totals intact
17. Verify print job also survived (or was processed to file)
18. Reconnect to network
19. Call `sync_force` — z_report syncs to `/api/pos/z-report/submit`
20. Verify `z_reports.sync_state = 'applied'`
21. Call `sync_force` again — should be a no-op (0 items)
22. Verify on admin dashboard: `pos_daily_z_reports` has report for terminal+date
23. Call `zreport_generate({ shiftId })` again — should return existing report (idempotent, no duplicate)

### Pass Criteria
- [ ] `generate_z_report` computes correct totals from orders, payments, adjustments, expenses
- [ ] Report includes cash drawer opening/closing/expected/variance
- [ ] Z-report persists in `z_reports` table with `sync_state: 'pending'`
- [ ] Duplicate generation for same shift returns existing report (idempotent)
- [ ] `zreport_print` enqueues print job with `entity_type: 'z_report'`
- [ ] Print worker generates HTML file in `receipts/` directory
- [ ] All data survives app restart
- [ ] Z-report syncs to `/api/pos/z-report/submit` with correct `report_data`
- [ ] Server upserts on `(terminal_id, report_date)` — idempotent
- [ ] `sync_state` transitions: `pending` → `syncing` → `applied`
- [ ] Final `sync_force` is a no-op (0 items)

---

### Automated gates (can run without app):
```bash
# Backend sync logic tests
node admin-dashboard/scripts/test-shift-sync.mjs

# Full build gate (requires Rust toolchain)
cd pos-tauri && npm run pos:tauri:verify
```

### Manual gates (require running app):
```bash
node pos-tauri/scripts/tauri-smoke.mjs
```

**Convention:** After implementing any new command group, add a corresponding gate
to this file before marking the group as complete.
