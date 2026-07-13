# pos-tauri gap review — 2026-07-10

A full-surface review of the Rust/Tauri desktop POS (`pos-tauri/`, ~157k LOC Rust + ~163k LOC TypeScript) at `master` (`6e2aea524`, clean tree). Seventeen scoped reviewers read the code in parallel; every finding was then handed to adversarial verifiers instructed to refute it.

> **Status 2026-07-13 — all 6 P0s now FIXED (uncommitted).**
>
> **Batch 1 (checkout / Z-report):** P0-01 (double-tap double charge), P0-02 (card recorded as cash), P0-06 (rollover deletes open tabs / counts them as revenue). Synchronous module-scoped charge guard shared by Card and Confirm Split plus close/input locks in `SplitPaymentModal.tsx`; `open_unsettled_table_tab_expr` in `business_day.rs` excludes live never-settled tabs from all Z revenue aggregates (date, single-shift, per-staff, per-type) and protects them in the rollover selector and Clear-Old-Orders, while keeping cancelled/refunded/settled tabs deletable. Adversarial review closed 6 follow-ons.
>
> **Batch 2 (ECR + unauthed wipe):** P0-03/P0-04/P0-05. **PAX** (`pax.rs`): `classify_response_code` approves only the exact success code — the `starts_with("00")` arm that booked declines as approvals is gone. **ZVT** (`zvt.rs`): `completion_error` classifies negative completion / abort on the CRC-validated APDU command bytes instead of a whole-buffer `0x84` scan (a €12.84 amount / CRC byte / 'ä' print char no longer aborts a live sale); round-2 review also caught that the real success frame `06 0F` was unrecognized (every approval timed out), so completion is now recognized and the outcome is classified from the `04 0F` result-code, failing safe to declined. **Unauthed wipe** (`commands/{sync,orders,diagnostics,sync_queue}.rs`): **8** renderer-callable full-wipe commands now require `authorize_privileged_action(SystemControl)` + snapshot (5 found in the review + `sync_queue_clear`, `sync_clear_old_orders`, `sync_clear_failed` that round-2 review surfaced as ungated side doors), pinned by the `destructive_command_auth_audit` static test; the three Settings buttons are wired to the admin-PIN elevation flow so the gate is usable. Covered by new PAX/ZVT unit tests. tsc 0, TS parity 964, cargo ecr 102 / commands 239.
>
> **Deferred ECR follow-ups (certification-gated, not blocking):** PAX partial approvals (000000 + ApprovedAmount < requested) still book the full amount — needs an `approved_amount` field on `TransactionResponse`; ZVT `extract_framed_apdu` does not DLE-unstuff and the transport truncates coalesced frames — both matter only against real hardware and are covered by the separate ECR certification gate; MockTransport end-to-end tests for `process_transaction`/`wait_for_completion` would pin the fixes at the call site.

**Verification is complete.** All 182 review + verifier agents finished. Of 99 raw findings, **93 survived and 6 were refuted and dropped.** Surviving: **6 P0, 28 P1, 40 P2, 19 P3.** Every P0 and P1 went through a 3-verifier panel; P2/P3 through a single skeptic; a majority "not refuted" was required to survive. The four findings I additionally read the code for myself are flagged in their status line.

## Fix these first

The six P0s cluster into four independent failures. Three lose real money in ordinary daily use:

1. **The customer's card gets charged twice** (P0-01). A double-tap on *Card* in the split-payment modal launches two concurrent terminal charges, and the Rust device mutex serializes rather than rejects them — so the terminal prompts twice, takes two real payments, and the POS records one.
2. **Declines and in-progress transactions are booked as approvals** (P0-04, P0-05). The PAX driver treats any response code beginning `00` as an approval; the ZVT driver scans raw bytes for `0x84` and calls an in-progress message a terminal error, so the POS records a failure while the terminal approves.
3. **A card payment is recorded as cash** (P0-02). Every first-attempt terminal card payment in the split modal persists `method: 'cash'` with a `cashReceived` amount, because the record call closes over a stale `portion` captured before the method was set. Expected-drawer cash inflates by the card amount on every split card sale.
4. **End-of-day deletes open tabs and books them as revenue** (P0-03). The close gate deliberately exempts open dine-in tabs, the Z-report aggregate counts them in gross sales anyway, and the rollover cleanup hard-deletes them with no status filter.

The remaining P0 is a security gap: **P0-06** — renderer-callable IPC commands wipe the sync queue and all unsynced orders with no authorization and no drain check (the verifier panel escalated this from P1 to P0).

Among the P1s, four are the highest-value follow-ups because each silently loses money or breaks day-close:

- **P1-25** and **P1-26** — a WAN-down / LAN-up outage (router up, ISP down) permanently dead-letters the day's queued orders and payments within minutes, and they never auto-drain when the link returns.
- **P1-23** — the Z-report close gate only checks the legacy queue plus `z_reports` rows in the parity queue, so a day can close with unsynced orders/payments still pending, and server books diverge from the terminal's Z.
- **P1-24** — when an admin deletes an order in the dashboard, the reconcile path hard-deletes the local order and cascades its payment rows with no unsynced-work guard, so an offline cash payment collected against that order vanishes from shift/Z totals.

## Index

| ID | ✓ | Area | Finding |
|---|---|---|---|
| P0-01 | ✅ | Checkout (UI) | Terminal card portion has no synchronous in-flight guard: a double-tap on 'Card' charges the customer's card twice |
| P0-02 | ✅ | Checkout (UI) | First-attempt terminal card payments are recorded with method 'cash' and a cashReceived amount (stale closure over portion) |
| P0-03 | ✅ | Shifts & Z-report | End-of-day rollover permanently deletes still-open unpaid table orders and counts them as revenue |
| P0-04 | ✅ | Hardware / ECR | PAX protocol approves any response code starting with "00", turning terminal declines into recorded approvals |
| P0-05 | ✅ | Hardware / ECR | ZVT wait_for_completion scans raw bytes for 0x84 and misreports in-progress transactions as "Terminal error" — POS records failure while the terminal approves |
| P0-06 | ✅ | IPC surface | Renderer-callable sync/order wipes discard unsynced financial mutations with no authorization and no recovery snapshot |
| P1-01 | ✅ | Config & updater | Updater signing private key lives in the repo working tree, guarded only by an incidental root gitignore pattern |
| P1-02 | ✅ | Config & updater | Release workflow auto-publishes to the production update channel on every master push, contradicting the documented manual-dispatch-only contract, with no concurrency guard |
| P1-03 | ✅ | Config & updater | Public source sync publishes internal security audit documents to the public distribution repo |
| P1-04 | ✅ | DB & reset | Migration v36 table rebuild cascade-deleted all payment_items and payment_adjustments (FKs stay ON during migrations; no safeguard for future rebuilds) |
| P1-05 | ✅ | DB & reset | database_reset / database_clear_operational_data destroy the entire parity_sync_queue and all unsynced orders with no PIN authorization and no drain check |
| P1-06 | ✅ | Error handling | ZVT card-payment loop misreads any intermediate message containing byte 0x84 as a terminal error, aborting an in-flight approved payment |
| P1-07 | ✅ | Fiscal | Fiscal active-cache is never populated in production, so every order enqueues a priority-100 fiscal row that consumes the fail-closed sync-queue cap and can block order creation offline |
| P1-08 | ✅ | Fiscal | Fiscal receipt payload is a snapshot taken at order-create time: pay-later, split-payment, and delivery orders are fiscalized with empty payments and stale totals, and are never re-dispatched on payment completion |
| P1-09 | ✅ | Fiscal | Z-report close-day fiscal guard is structurally unreachable dead code — the branch condition guarantees branchId is absent, so ensure_no_queued_fiscal_for_day never executes |
| P1-10 | ✅ | Fiscal | Per-terminal fiscal sequence counters keyed only by (branch, day) produce duplicate receipt identifiers at the tax authority for multi-terminal branches, and daily reset reuses numbers across days |
| P1-11 | ✅ | Hardware / ECR | Generic fiscal: lost/corrupt response to CMD_CLOSE_FISCAL_RECEIPT records failure after the device has fiscally committed the receipt — retry double-issues, no reconciliation |
| P1-12 | ✅ | Money / payments | Fully-refunded order becomes a 'no_persisted_payment' blocker that blocks shift close/Z-report and whose one-click repair records a phantom payment |
| P1-13 | ✅ | Money / payments | Close-time drawer reconciliation counts ALL refund adjustments as cash out of the drawer, contradicting the cash-only/handler-aware write path in refunds.rs |
| P1-14 | ✅ | Money / payments | room_charge is an accepted local payment method but payment_integrity flags it 'unsupported_payment_method', hard-blocking shift close and Z-report with no auto-resolution |
| P1-15 | ✅ | Money / payments | sync::create_order inserts orders without any *_cents columns, so new orders' canonical money is derived by SQLite ROUND (half-up) which disagrees with Rust round_half_even on exact ties — a full payment can leave the order permanently 'partially_paid' by 1 cent |
| P1-16 | ✅ | Money / payments | Payment tip is never persisted locally and is silently dropped from the sync payload whenever the queue entry is rebuilt |
| P1-17 | ✅ | Printing | Printed receipt and fiscal payload read legacy REAL money columns while the charge path is cents-authoritative |
| P1-18 | ✅ | Checkout (UI) | Approved terminal charge followed by a failed local record is reported as 'Card payment failed' and invites a re-charge on retry |
| P1-19 | ✅ | Offline / sync (UI) | Delivery validation cache keyed only by address — stale delivery fee and minimum-order verdicts served across order amounts, branches, and zone changes |
| P1-20 | ✅ | Shifts & Z-report | Shift-close reconciliation counts card/driver refunds against the drawer and drops fully-refunded cash payments — expected cash and variance are wrong |
| P1-21 | ✅ | Shifts & Z-report | Multi-shift Z-report includes 'refunded'-status orders in gross sales while excluding their payments and refund adjustments — net_sales overstated |
| P1-22 | ✅ | Shifts & Z-report | close_shift total_sales fans out per payment row — split-paid orders are double-counted in shift sales totals |
| P1-23 | ✅ | Sync core | Z-report closeout gate ignores unsynced parity_sync_queue orders/payments/adjustments — day can close with unsynced money rows |
| P1-24 | ✅ | Sync core | Remote-deleted orders destroy local unsynced payments with no pending-work guard, and orphan their parity queue rows |
| P1-25 | ✅ | Offline queue | Pure connectivity failures consume the permanent-failure retry budget and dead-letter the whole offline backlog |
| P1-26 | ✅ | Offline queue | mark_deferred shares the `attempts` counter with mark_failure, so deferral cycles consume the 10-attempt dead-letter budget |
| P1-27 | ✅ | Offline queue | Offline reservation/appointment/salon-shift INSERTs carry no idempotency key and no local-to-remote id mapping |
| P1-28 | ✅ | Test gaps | The 931-test TS parity suite (checkout money contracts, offline sync coordinator, keyring-session regression) is not enforced by any CI job, release script, or hook |
| P2-01 | ✅ | Auth & identity | Staff check-in PIN verification has no lockout/rate-limiting, allowing unlimited PIN brute-force and staff impersonation |
| P2-02 | ✅ | Config & updater | TAURI_ENV_DEBUG string-truthiness inversion: CI release builds ship unminified JS with console/debugger retained and sourcemaps |
| P2-03 | ✅ | DB & reset | Factory/emergency reset wipes the terminal without checking the sync queue is drained; emergency reset has no backend authorization at all |
| P2-04 | ✅ | DB & reset | Reset helper deletes keyring credentials before confirming the main app exited; a filesystem-wipe timeout strands unsynced data with no terminal identity |
| P2-05 | ✅ | DB & reset | One transient open/pragma failure quarantines the entire live database and silently boots an empty POS |
| P2-06 | ✅ | Deps & contracts | Bundled SQLite 3.46.0 (via rusqlite 0.32.1) carries known upstream CVEs incl. a CISA KEV-listed one |
| P2-07 | ✅ | Deps & contracts | pos-tauri overrides mapStatusForPOS/mapStatusForSupabase with divergent semantics and a 'pending' fallback for unknown statuses |
| P2-08 | ✅ | Fiscal | Fiscal payload builder reads legacy float REAL money columns instead of the authoritative *_cents columns |
| P2-09 | ✅ | Hardware / ECR | Scale: read_weight returns a stale cached reading as success and the reader loop never detects disconnect, so by-weight items can be priced on the previous item's weight |
| P2-10 | ✅ | Hardware / ECR | Customer display fit_line/right_align slice by byte index and panic on multi-byte UTF-8 — any Greek product name longer than the display width panics show_item |
| P2-11 | ✅ | Hardware / ECR | Customer-display and cash-drawer commands run blocking TCP connect (3s) and serial writes directly on the Tokio runtime — missing the spawn_blocking treatment every other hardware path received |
| P2-12 | ✅ | Hardware / ECR | Generic fiscal: transport-level error mid-receipt (not NAK) leaves the device stuck in receipt-open state with no cancel and no recovery on the next sale |
| P2-13 | ✅ | Hardware / ECR | ecr_process_payment/refund route to an arbitrary HashMap-ordered device when no deviceId is given, ignoring the configured default terminal |
| P2-14 | ✅ | Hardware / ECR | Serial scanner claims auto-reconnect but only re-reads the dead handle forever; status keeps reporting connected after unplug |
| P2-15 | ✅ | Hardware / ECR | build_fiscal_data does float money math and ignores the *_cents fields — derived unit prices can make the fiscal receipt total differ from the order total |
| P2-16 | ✅ | IPC surface | database_reset and database_clear_operational_data are destructive but lack the privileged-action gate their sibling reset commands enforce |
| P2-17 | ✅ | Money / payments | Void reverses drawer counters on the ORDER's shift instead of the PAYMENT's shift, debiting a drawer that never received the sale |
| P2-18 | ✅ | Money / payments | update_payment_method moves money between cash and card without touching drawer counters or recomputing closed-shift snapshots |
| P2-19 | ✅ | Printing | Per-profile queue pause can starve all other printers indefinitely because the paused-profile filter runs after SQL LIMIT 10 |
| P2-20 | ✅ | Printing | Single global print processor with oldest-first batching lets one dead/flow-blocked printer delay every other printer by minutes |
| P2-21 | ✅ | Printing | Every print job writes a receipt HTML artifact that is never cleaned up — unbounded PII-bearing disk growth |
| P2-22 | ✅ | Printing | Printer test, verification, and cash-drawer IPC commands run blocking hardware I/O directly on the Tokio runtime |
| P2-23 | ✅ | Printing | Fiscal submission results (MARK/UID/validation QR) never reach the printed receipt |
| P2-24 | ✅ | Checkout (UI) | Edit-settlement refunds cannot span multiple payments; the multi-payment fallback modal is unreachable dead code, blocking legitimate order edits |
| P2-25 | ✅ | Checkout (UI) | Split payment drift check ignores order cancellation, so payment can be collected against an order cancelled on another terminal |
| P2-26 | ✅ | Checkout (UI) | Synthetic 'Balance Adjustment' line can reuse an already-paid item's itemIndex, mis-attributing paid-item records |
| P2-27 | ✅ | Module gating (UI) | Pending post-login intent restores a view with no module re-check, mounting gated views and firing their data hooks |
| P2-28 | ✅ | Module gating (UI) | isViewAccessDenied fails open when the enabled-module list is empty, disabling both route-guard sites at once |
| P2-29 | ✅ | Offline / sync (UI) | Renderer falls back to a direct Supabase UPDATE on retail_products with no organization_id filter — violates API-first writes and org-scoped-write guardrails |
| P2-30 | ✅ | Offline / sync (UI) | Out-of-zone delivery override is auto-approved client-side — the 'manager approval required' denial branch is unreachable |
| P2-31 | ✅ | Offline / sync (UI) | MenuService browser-fallback menu reads hit Supabase without organization_id filters |
| P2-32 | ✅ | Shifts & Z-report | Multi-shift Z-report per-order-type sales omit the refund subtraction the single-shift path applies |
| P2-33 | ✅ | Shifts & Z-report | Orders written between Z-report aggregation and rollover-cutoff capture are deleted but never reported in any Z period |
| P2-34 | ✅ | Sync core | Payment/adjustment/z-report/loyalty failure paths burn retry budget on backpressure and retry hot with no backoff — money rows dead-letter after ~5 cycles |
| P2-35 | ✅ | Sync core | reconcile_remote_payments/orders advance the since-cursor past records that failed to apply locally — remote records silently dropped forever |
| P2-36 | ✅ | Sync core | Sync cycle aborts on pull (reconcile) errors before any push runs — a broken GET endpoint starves all order/payment pushes |
| P2-37 | ✅ | Sync core | Direct order POST silently drops invalid items but still sends the original order total — permanent total-mismatch failure or short-shipped remote order |
| P2-38 | ✅ | Offline queue | Monetary items dead-lettered via 4xx or prepare-failure never emit the sync:dead-letter:monetary operator alarm |
| P2-39 | ✅ | Offline queue | retry_item can flip an in-flight 'processing' row back to 'pending' without bumping claim_generation, enabling duplicate submission |
| P2-40 | ✅ | Offline queue | Recovery export bundle embeds the raw snapshot DB containing the plaintext terminal API key |
| P3-01 | ✅ | Auth & identity | In-memory session map grows unbounded: prior session is never evicted on re-login |
| P3-02 | ✅ | Auth & identity | Lock-ordering invariant comment in login() is factually wrong — a second lockout call site already exists |
| P3-03 | ✅ | Config & updater | CSP connect-src/img-src wildcard `https://*.supabase.co` allows exfiltration to any attacker-registered Supabase project |
| P3-04 | ✅ | Config & updater | Five @tauri-apps/plugin-* JS packages are shipped as dependencies but their Rust plugins are never registered |
| P3-05 | ✅ | DB & reset | database_get_stats reports pendingSync from the retired legacy sync_queue, hiding the real parity_sync_queue backlog |
| P3-06 | ✅ | DB & reset | Self-wrapped migrations v28/v34/v36 stamp schema_version OUTSIDE their transaction, contradicting the harness's atomicity claim |
| P3-07 | ✅ | DB & reset | Offline-store schema doc and in-code comments are stale: doc says v61 (code is v68), and code claims sync_queue was dropped in v56 when no migration drops it |
| P3-08 | ✅ | Deps & contracts | Duplicated Order type in pos-tauri/src/shared/types/orders.ts drifted from canonical shared/types/orders.ts (unions disagree both ways, all W4d *_cents wire fields missing) |
| P3-09 | ✅ | Deps & contracts | ~35 registered Tauri commands have no renderer caller, including raw serial-port write access and a parallel legacy Z-report stack |
| P3-10 | ✅ | Deps & contracts | payments.updatePaymentStatus TS surface permits statuses the Rust command rejects by design ('processing'/'completed') |
| P3-11 | ✅ | Error handling | Panic in a Tauri command never surfaces to the frontend: async commands (all order/payment/sync/shift flows) hang the invoke forever; the 11 sync commands panic on the main thread and kill the app |
| P3-12 | ✅ | Module gating (UI) | Module entitlements are trusted from tamper-writable plaintext caches, including a renderer-exposed IPC that writes the Rust-side cache unvalidated |
| P3-13 | ✅ | Module gating (UI) | Module cache identity check is skipped when current identity is not yet hydrated, honoring a previous terminal/org's module set after re-provisioning |
| P3-14 | ✅ | Offline / sync (UI) | BranchMenuFilterService queries menu_categories/subcategories/ingredients with no organization_id (or any tenant) filter and caches results+prices in localStorage |
| P3-15 | ✅ | Offline / sync (UI) | Legacy shared Supabase sync helpers (syncSettingsEx/syncMenuItemsEx/syncDeliveryZonesEx) query tenant tables completely unscoped; pos_configurations uses .single() |
| P3-16 | ✅ | Shifts & Z-report | Residual float money math on REAL columns in shift summary and cash-breakdown paths |
| P3-17 | ✅ | Test gaps | 47 of 143 TS test files never execute anywhere because run-parity-tests.mjs is a hard-coded allowlist — including module-gating and fiscal-entitlement guardrail tests |
| P3-18 | ✅ | Test gaps | Checkout double-submit dedup guard (client_request_id) in create_order has no test |
| P3-19 | ✅ | Test gaps | No automated parity gate for the order queue itself: G1 (offline order restart persistence) and G2 (order sync exactly-once) remain manual-only while payments/refunds/z-reports got automated gates |

---

## P0 — money incorrectness, data loss, or security breach

### P0-01 — Terminal card portion has no synchronous in-flight guard: a double-tap on 'Card' charges the customer's card twice

> ✅ **verified (3-verifier adversarial panel + direct code read)** · Checkout (UI) · `pos-tauri/src/renderer/components/modals/SplitPaymentModal.tsx:329`

handleTerminalCardPayment only marks the portion as 'processing' at line 336, AFTER two awaited pre-flight sequences: ensureLatestOutstanding (line 332, three bridge IPC calls) and resolveReadyTerminal (line 334, two more IPC calls). Until line 336 executes, the portion status stays 'draft', so both the re-entry check at line 330 (`portion.status !== 'draft'`) and the MethodToggle Card button's disabled state (line 391: `locked = portion.status !== 'draft' || isProcessing`) pass. A double-tap (or two taps on different portions' Card buttons, since the line-331 guard reads `processingPortionId` state that is still null for both) launches two concurrent handleTerminalCardPayment runs, each of which calls bridge.ecr.processPayment for the full portion amount. The Rust side offers no idempotency: ecr_process_payment (pos-tauri/src-tauri/src/commands/ecr.rs:1642-1700) mints a fresh `txn-{uuid}` per call and never reads the renderer-supplied `reference` option. The second recordPayment is then typically rejected by validate_payment_amount_against_outstanding (pos-tauri/src-tauri/src/payments.rs:727-748), leaving one of the two real card charges unrecorded.

**Evidence**

Line 330: `const portion = getPortion(portionId); if (!portion || portion.status !== 'draft') return;` ... line 332: `await ensureLatestOutstanding(portion.amount, activeTab);` ... line 334: `terminal = await resolveReadyTerminal();` ... line 336: `updatePortion(portionId, (current) => ({ ...current, method: 'card', status: 'processing', ... }))`. ecr.rs:1672: `let tx_id = format!("txn-{}", uuid::Uuid::new_v4());` — `reference` from line 341 (`reference: `${orderId}:${portion.id}``) is never parsed in ecr_process_payment.

**Impact.** A cashier double-tapping the Card button on a touchscreen POS sends two Sale transactions to the payment terminal for the same portion. The customer is charged twice; at most one charge is recorded locally, so the second is invisible to the drawer/Z-report and only discoverable via the acquirer statement.

**Suggested fix.** Set a synchronous in-flight marker before the first await (e.g., a useRef set of portion ids in flight, checked and set at the top of handleTerminalCardPayment), and/or move the status='processing' update to before ensureLatestOutstanding. Longer term, make ecr_process_payment dedupe on the caller-supplied reference.

### P0-02 — First-attempt terminal card payments are recorded with method 'cash' and a cashReceived amount (stale closure over portion)

> ✅ **verified (3-verifier adversarial panel + direct code read)** · Checkout (UI) · `pos-tauri/src/renderer/components/modals/SplitPaymentModal.tsx:313`

handleTerminalCardPayment captures `portion` from state at line 330 while its method is still the createPortion default 'cash' (line 79). Line 333 setPortionMethod / line 336 updatePortion only update React state — the local `portion` binding is untouched. The recordPayment effect at line 346 passes that stale object into recordPortionPayment (line 313), which persists `method: portion.method` (= 'cash') and `cashReceived: portion.method === 'cash' ? portion.amount : undefined`, `changeGiven: 0`, while simultaneously setting paymentOrigin 'terminal' and terminalApproved true. Since clicking the Card button is what initiates the terminal payment (there is no separate select-then-charge step), every happy-path first attempt hits this; only retries after a failure or after the no-terminal fallback (which do persist method 'card' in state, then read it back) record correctly.

**Evidence**

Line 313: `bridge.payments.recordPayment({ orderId, method: portion.method, ..., cashReceived: portion.method === 'cash' ? portion.amount : undefined, changeGiven: portion.method === 'cash' ? 0 : undefined, transactionRef, paymentOrigin, terminalApproved: paymentOrigin === 'terminal', ... })` where `portion` is the object captured at line 330 before `setPortionMethod(portionId, 'card')` at line 333. createPortion (line 79) defaults `method: 'cash'`.

**Impact.** Z-report and drawer expectations sum cash by op.method = 'cash' (pos-tauri/src-tauri/src/zreport.rs:1114, 1742), so every terminal-approved split card payment inflates expected cash by the full amount and understates card sales — the drawer shows a shortage at shift close and fiscal tender totals are wrong. The stored payment row is self-contradictory (method 'cash' + terminalApproved true + transactionRef).

**Suggested fix.** Build the recorded portion explicitly, e.g. `const cardPortion = { ...portion, method: 'card' as const };` after line 330 and pass cardPortion to recordPortionPayment/appendCompletedPayment in the terminal path (or have recordPortionPayment accept an explicit method override for paymentOrigin 'terminal').

### P0-03 — End-of-day rollover permanently deletes still-open unpaid table orders and counts them as revenue

> ✅ **verified (3-verifier adversarial panel + direct code read)** · Shifts & Z-report · `pos-tauri/src-tauri/src/zreport.rs:4464`

The Z-report unsettled-payment precondition deliberately exempts table-linked dine-in orders with payment_status='pending' (pos-tauri/src-tauri/src/payment_integrity.rs:325-333), so the day can be closed while a tab is still open. But finalize_end_of_day_counts selects orders to delete with NO status, settlement, ghost, or branch filter — only 'financial timestamp <= cutoff' (which for an unpaid order is its created_at). The open order, its (empty) payments, and adjustments are hard-deleted (zreport.rs:4501-4518, 4620-4627), while table_sessions is not in the cleanup list, leaving an orphaned occupied-table session. Meanwhile build_z_report_for_date's order aggregate (zreport.rs:3471-3484) includes that unpaid order in gross/net_sales (no payment-status filter), so the submitted Z overstates revenue by money that was never collected.

**Evidence**

zreport.rs:4464-4467: `"SELECT o.id FROM orders o WHERE datetime({financial_expr}) <= datetime(?1)"` (no status/settlement/branch filter) then zreport.rs:4623 `DELETE FROM orders WHERE id IN (SELECT id FROM temp_z_report_order_ids)`. payment_integrity.rs:325-333 exempts blockers: `AND NOT (LOWER(TRIM(COALESCE(o.order_type,''))) IN ('dine-in','dine_in','table') AND LOWER(TRIM(COALESCE(o.payment_status,''))) = 'pending' AND (... table_session_id ...))`. collect_rollover_protection (zreport.rs:63-108) protects only shift/shift_expense/staff_payment entities, never orders.

**Impact.** Closing the day with any table still open (a state the blocker exemption explicitly permits) destroys the live order locally before it is ever paid: the tab can never be settled on the POS, the table session dangles pointing at a deleted order, and the Z-report's gross/net_sales include the uncollected amount, so reported revenue disagrees with actual takings and with the server's order/payment records.

**Suggested fix.** In finalize_end_of_day_counts, exclude orders that are not terminally settled (e.g. status NOT IN ('completed','delivered','cancelled','canceled','refunded') OR payment_status='pending' with an open table_session) from temp_z_report_order_ids, or make open table orders a hard Z-report blocker instead of an exemption. Also scope the delete selector by branch_id to match the branch-scoped aggregation.

### P0-04 — PAX protocol approves any response code starting with "00", turning terminal declines into recorded approvals

> ✅ **verified (3-verifier adversarial panel)** · Hardware / ECR · `pos-tauri/src-tauri/src/ecr/protocols/pax.rs:228`

process_transaction classifies the PAX T00 response by matching exact "000000"/"00" as Approved, then adds a catch-all arm approving ANY code whose first two characters are "00". In the PAX POSLink code space the success code is "000000", while decline/failure codes such as "000100" (DECLINE) also begin with "00". Those flow into the prefix arm and come back as TransactionStatus::Approved with error_message: None. commands/ecr.rs ecr_process_payment then returns success:true and persists status "approved" in ecr_transactions (commands/ecr.rs:1700-1745).

**Evidence**

let status = match fields.first().map(|s| s.as_str()) {
    Some("000000") | Some("00") => TransactionStatus::Approved,
    Some(code) if code.starts_with("00") => TransactionStatus::Approved,
    _ => TransactionStatus::Declined,
};

**Impact.** Terminal declines the card (e.g. code 000100) but the POS records the payment as approved, closes the order as paid, and the cashier hands over goods with no money captured. The local ECR transaction log corroborates the phantom approval, so end-of-day settlement is the first place the shortfall can be noticed.

**Suggested fix.** Approve only the exact success code(s) ("000000", and "00" if a device family truly returns it); treat every other code as Declined and carry the code into error_code/error_message. If partial-approval codes must be supported, model them explicitly instead of via prefix matching.

### P0-05 — ZVT wait_for_completion scans raw bytes for 0x84 and misreports in-progress transactions as "Terminal error" — POS records failure while the terminal approves

> ✅ **verified (3-verifier adversarial panel)** · Hardware / ECR · `pos-tauri/src-tauri/src/ecr/protocols/zvt.rs:263`

After the positive-completion check, the loop declares a terminal error if ANY byte in the received frame equals 0x84 — with no frame/APDU alignment. Intermediate ZVT messages (04 FF status, 04 0F status-information, 06 D1 print lines) legitimately contain 0x84: (a) BCD-encoded amounts — any amount containing the digit pair "84" (e.g. €12.84) encodes byte 0x84; (b) the 2 CRC-16 bytes appended to every frame (~0.8% chance per frame, several frames per transaction); (c) CP437/CP850 print-line text where 'ä' = 0x84 (ZVT is the German-market protocol). When triggered, wait_for_completion returns Err mid-transaction; commands/ecr.rs records status "error" and returns success:false (commands/ecr.rs:1747-1774) while the terminal continues the card interaction and typically approves. There is no post-error reconciliation (no ZVT status-enquiry/repeat-receipt), so the charge is invisible to the POS.

**Evidence**

if raw.windows(1).any(|w| w[0] == 0x84) {
    let error_code = raw.get(raw.iter().position(|&b| b == 0x84).unwrap() + 1);
    return Err(format!("Terminal error: 0x{:02X}", error_code.unwrap_or(&0xFF)));
}

**Impact.** Deterministic false failures for any sale amount containing digit pair "84" plus random CRC-byte collisions: customer's card is charged, POS shows payment failed, cashier retries — double charge — or reverts to cash — unrecorded card revenue. This is the exact approve-vs-recorded-failure divergence with no reconciliation path.

**Suggested fix.** Extract and CRC-validate the APDU first (extract_framed_apdu already exists) and classify only on the APDU command class/instruction: treat 84 xx as negative completion and 06 1E as abort only when they are the frame's command bytes, never via a whole-buffer byte scan. On error/timeout after the card phase has started, issue a ZVT status enquiry before reporting failure.

### P0-06 — Renderer-callable sync/order wipes discard unsynced financial mutations with no authorization and no recovery snapshot

> ✅ **verified (3-verifier adversarial panel)** · IPC surface · `pos-tauri/src-tauri/src/commands/sync.rs:1289`

Three IPC commands registered in the invoke_handler — sync_clear_all (sync.rs:1282), sync_clear_all_orders (sync.rs:1174), and orders_clear_all (orders.rs:3800) — issue unconditional DELETEs against sync_queue and/or orders. The webview is the trust boundary, yet none of these commands take auth_state, call auth::authorize_privileged_action, or call recovery::snapshot_before_destructive_action first. sync_clear_all runs `DELETE FROM sync_queue` (the entire offline financial outbox), and sync_clear_all_orders deletes the order/payment/payment_adjustment queue rows plus all orders. The financial-queue read commands (sync_get_financial_queue_items) confirm sync_queue holds live unsynced payment/order/adjustment items awaiting push to the Admin API.

**Evidence**

sync_clear_all: `conn.execute("DELETE FROM sync_queue", [])` with signature `pub async fn sync_clear_all(db, sync_state, app)` — no auth_state, no snapshot. sync_clear_all_orders: `DELETE FROM sync_queue WHERE entity_type IN ('order','payment','payment_adjustment')` then `DELETE FROM orders`. Contrast settings_factory_reset (settings.rs:876) which calls `auth::authorize_privileged_action(PrivilegedActionScope::SystemControl, ...)` before wiping.

**Impact.** A cashier (or any renderer code path / injected web content) invoking a 'clear sync queue' or 'clear orders' maintenance action while the terminal is offline permanently discards not-yet-synced orders and payments. There is no recovery point and no PIN gate, so the financial records never reach the server and cannot be restored — silent loss of money data.

**Suggested fix.** Gate these commands behind auth::authorize_privileged_action (as settings_factory_reset does) and take a recovery snapshot before the DELETE. At minimum, refuse to drop sync_queue rows whose status is pending/failed (unsynced) rather than deleting unconditionally.

---

## P1 — correctness bugs with realistic triggers, durability gaps, leaks

### P1-01 — Updater signing private key lives in the repo working tree, guarded only by an incidental root gitignore pattern

> ✅ **verified (3-verifier adversarial panel + direct code read)** · Config & updater · `pos-tauri/updater.key`

The rsign/minisign PRIVATE key that signs POS auto-updates sits at pos-tauri/updater.key on the dev machine (header decodes to 'untrusted comment: rsign encrypted secret key'). Contrary to the review premise, it IS currently gitignored — but only via the monorepo root .gitignore line 213 pattern '*.key', which sits under a '# Local development certificates' comment and matches this file by accident. pos-tauri/.gitignore itself has NO '*.key' entry, and the release workflow's public-repo sync step (.github/workflows/pos-tauri-auto-release.yml:321-328) copies pos-tauri/ wholesale with `Get-ChildItem -Force` and an exclude list of only ['.git','node_modules','dist','.env','.env.local','.env.production'] — updater.key is not excluded. It is safe today only because CI checkouts omit untracked files. No script reads/writes it and it cannot reach dist/ or the installer (public/ is empty, no bundle.resources), but the protection is a single incidental line: pruning that root pattern, running the documented 'Manual Public Release Flow' sync from a local working tree, `git add -f`, or copying pos-tauri/ into the public repo (whose root .gitignore becomes pos-tauri's, which lacks *.key) would publish it.

**Evidence**

head of updater.key: the file's first line is the standard rsign header comment `untrusted comment: rsign encrypted secret key` (the base64 body is elided here — no key bytes are reproduced in this report); `git check-ignore -v` -> '.gitignore:213:*.key	pos-tauri/updater.key'; pos-tauri/.gitignore contains no key pattern; workflow exclude list: `$excludeRoot = @(".git", "node_modules", "dist", ".env", ".env.local", ".env.production")`

**Impact.** Whoever obtains this file (plus its password, if one was set — RELEASE.md:18 says the password is optional) can sign malicious update manifests accepted by tauri-plugin-updater on every production POS terminal: full update-channel takeover of all deployed terminals from a single-file compromise. Violates the guardrail that secrets never live in plaintext files.

**Suggested fix.** Remove updater.key from the working tree and keep the private key only in the GitHub Actions secret (TAURI_SIGNING_PRIVATE_KEY) / a password manager or OS keyring. Add explicit 'updater.key' and '*.key' entries to pos-tauri/.gitignore, and add '*.key' to the workflow sync exclude list as defense in depth. Rotate the keypair if any prior exposure is suspected.

### P1-02 — Release workflow auto-publishes to the production update channel on every master push, contradicting the documented manual-dispatch-only contract, with no concurrency guard

> ✅ **verified (3-verifier adversarial panel)** · Config & updater · `.github/workflows/pos-tauri-auto-release.yml:4`

RELEASE.md:11 states the active workflow is 'workflow_dispatch only' and documents a deliberate manual release gate (merge first, then a human dispatches the release). But the workflow YAML also triggers on `push` to master/main with paths 'pos-tauri/**' and 'branding/pos-desktop/**' (lines 3-11). The 'Validate manual release ref' step only checks the branch name, which every master push satisfies. Each triggering push then deletes and recreates the public GitHub release for the CURRENT version tag (`gh release delete $tag --cleanup-tag` then `gh release create ... --latest`, lines 350-362) and force-syncs the full pos-tauri source to the public repo. The workflow has no `concurrency:` group, so two closely-spaced merges run in parallel, each deleting/recreating the same release.

**Evidence**

Lines 3-11: `on:\n  push:\n    branches:\n      - master\n      - main\n    paths:\n      - 'pos-tauri/**'` vs RELEASE.md:11 'Active workflow: .github/workflows/pos-tauri-auto-release.yml (workflow_dispatch only)'. Lines 350-362: `gh release delete $tag --repo $repo --yes --cleanup-tag` followed by `gh release create $tag ... --latest`.

**Impact.** Every merged PR touching pos-tauri silently rebuilds and REPLACES the public installer for the current version with the unvetted master-head build — new installs and any terminal still below that version download it via the fixed endpoint https://github.com/EpsylonBita/The-Small-POS/releases/latest/download/latest.json. If a version bump lands mid-program before release QA, all production terminals auto-update to it with zero human gate. During the delete/recreate window (or when two runs race, possibly with an older commit's run finishing last) the updater endpoint 404s or serves a rolled-back build.

**Suggested fix.** Either remove the `push` trigger so the workflow matches the RELEASE.md contract (workflow_dispatch only), or update RELEASE.md and add a guard that skips publish when the version tag already has a release. In all cases add `concurrency: { group: pos-tauri-release, cancel-in-progress: false }`.

### P1-03 — Public source sync publishes internal security audit documents to the public distribution repo

> ✅ **verified (single skeptic)** · Config & updater · `.github/workflows/pos-tauri-auto-release.yml:322`

The 'Sync pos-tauri source to public repo' step copies every top-level entry of pos-tauri/ (Get-ChildItem -Force, exclude list of 6 names) into EpsylonBita/The-Small-POS. That includes pos-tauri/docs/security-native-migration/ — AUDIT_REPORT.md, SECURITY_VERIFICATION_PACK.md, FILE_MATRIX.csv (a per-file risk matrix rating 'risk' and 'exposure' for the whole codebase), EXECUTION_BACKLOG.md, staging-soak-report.json — plus planning/ and PHASE*_NOTES.md. Publishing the app source may be deliberate (RELEASE.md step 6), but shipping the internal security-audit posture of a production payments POS is almost certainly unintended collateral.

**Evidence**

Workflow lines 321-328: `$excludeRoot = @(".git", "node_modules", "dist", ".env", ".env.local", ".env.production"); Get-ChildItem -Path pos-tauri -Force | Where-Object { $excludeRoot -notcontains $_.Name } | ... Copy-Item ... -Recurse -Force`. Directory listing confirms pos-tauri/docs/security-native-migration/{AUDIT_REPORT.md,SECURITY_VERIFICATION_PACK.md,FILE_MATRIX.csv,...} exists and is not excluded.

**Impact.** An attacker researching the POS gets a curated map of the codebase's assessed weak points, security verification procedures, and soak/QA gaps straight from the vendor's public repo, lowering the cost of targeting deployed terminals.

**Suggested fix.** Add 'docs', 'planning', and internal notes files (or at minimum 'docs/security-native-migration') to the sync exclude list, or switch to an explicit allowlist of what the public repo actually needs (src, src-tauri, scripts, package files, README, RELEASE.md).

### P1-04 — Migration v36 table rebuild cascade-deleted all payment_items and payment_adjustments (FKs stay ON during migrations; no safeguard for future rebuilds)

> ✅ **verified (3-verifier adversarial panel)** · DB & reset · `pos-tauri/src-tauri/src/db.rs:2865`

Migrations run on the production connection with `PRAGMA foreign_keys = ON` (db.rs:94) and nothing turns it off around table rebuilds. migrate_v36 rebuilds order_payments via `DROP TABLE order_payments; ALTER TABLE order_payments_v36 RENAME TO order_payments` (db.rs:2865-2866). With FK enforcement on, SQLite's DROP TABLE performs an implicit DELETE FROM that fires foreign-key actions — and both payment_items (db.rs:2426) and payment_adjustments (db.rs:1053) declare `FOREIGN KEY(payment_id) REFERENCES order_payments(id) ON DELETE CASCADE`. So every terminal that upgraded through v36 with rows in those tables had its split-payment items and void/refund audit trail silently wiped. I reproduced this exactly on SQLite 3.50.4: after the v36-style rebuild inside BEGIN/COMMIT with foreign_keys=ON, child rows go from 2 to 0. The run_migration_tx doc-comment (db.rs:484-515) warns future authors about positional INSERT..SELECT but says nothing about cascade-on-DROP, so the next rebuild of orders/order_payments will repeat the wipe.

**Evidence**

db.rs v36 batch: `DROP TABLE order_payments; ALTER TABLE order_payments_v36 RENAME TO order_payments;` with connection pragma `PRAGMA foreign_keys = ON;` (db.rs:94) and child FK `FOREIGN KEY(payment_id) REFERENCES order_payments(id) ON DELETE CASCADE` (db.rs:2426, 1053). Empirical repro: 'items before: 2 / items after rebuild: 0' (python sqlite3 3.50.4, same statement sequence).

**Impact.** Terminals that took the v36 update mid-shift lost unsynced same-day refund/void adjustments and split-payment item rows — drawer expected-cash/variance math and the local monetary audit trail were silently wrong. The pattern remains live: any future FK-parent table rebuild (orders, order_payments) will cascade-wipe children again.

**Suggested fix.** In run_migrations, execute rebuild-containing migrations with `PRAGMA foreign_keys = OFF` (must be set outside a transaction), run `PRAGMA foreign_key_check` before re-enabling, and add the cascade-on-DROP rule to the run_migration_tx doc-comment. Optionally add a repair path that re-pulls adjustments/payment items from the server where remote copies exist.

### P1-05 — database_reset / database_clear_operational_data destroy the entire parity_sync_queue and all unsynced orders with no PIN authorization and no drain check

> ✅ **verified (3-verifier adversarial panel)** · DB & reset · `pos-tauri/src-tauri/src/commands/diagnostics.rs:314`

Both Tauri commands (registered in lib.rs:1198-1199) call clear_operational_data_inner (core_helpers.rs:265-285), which executes `DELETE FROM parity_sync_queue; DELETE FROM sync_queue; DELETE FROM orders;` plus payments/adjustments/shifts/z_reports. Unlike settings_factory_reset (settings.rs:876 requires authorize_privileged_action(SystemControl)) and the ~20 guarded destructive commands in commands/recovery.rs, these two commands have NO authorize_privileged_action call and no check that the queue is drained. An offline terminal with hundreds of pending replay rows loses both the queue rows AND the source order/payment rows they reference in one click; a pre-action snapshot is taken, but nothing ever replays those queue rows automatically after a snapshot restore-less clear — the sales simply never reach the server.

**Evidence**

diagnostics.rs:314-331: `pub async fn database_reset(db: ...) { crate::recovery::snapshot_before_destructive_action(...); crate::clear_operational_data_inner(&db) }` — no auth guard; core_helpers.rs:279-281: `DELETE FROM parity_sync_queue; DELETE FROM sync_queue; DELETE FROM orders;`. Contrast settings.rs:876: `auth::authorize_privileged_action(auth::PrivilegedActionScope::SystemControl, ...)` for the equivalent factory reset.

**Impact.** Any renderer code (or any staff member without a manager PIN) can invoke IPC and permanently discard unsynced sales, payments, and shift financials from the server's perspective while the terminal is offline — silent revenue-data loss with only a local snapshot as forensic evidence.

**Suggested fix.** Add authorize_privileged_action(SystemControl) to both commands, and refuse (or require an explicit typed override) when parity_sync_queue has rows in status IN ('pending','processing','conflict'), surfacing the count to the operator first.

### P1-06 — ZVT card-payment loop misreads any intermediate message containing byte 0x84 as a terminal error, aborting an in-flight approved payment

> ✅ **verified (3-verifier adversarial panel)** · Error handling · `pos-tauri/src-tauri/src/ecr/protocols/zvt.rs:263`

In `wait_for_completion`, error detection scans the ENTIRE raw byte stream for 0x84 instead of checking the framed APDU's class byte: any non-positive-completion message that merely contains 0x84 anywhere in its payload is treated as a negative completion and the transaction returns Err("Terminal error"). Contrast with `is_positive_completion` (line 205), which correctly parses via `extract_framed_apdu` before checking apdu[0]/apdu[1]. Real ZVT dialogues put arbitrary data bytes in intermediate messages before the 06 0F completion: 04 0F Status-Information carries the BCD-encoded amount (any sale ending in .84 — e.g. 12.84 EUR — encodes a literal 0x84 byte), and 06 D1 print-line text on German terminals (ZVT is the German ECR standard) uses CP437/CP850 where 'a-umlaut' — present in standard receipt words like 'Haendlerbeleg'/'Betrag zurueck' spelled with umlauts — is exactly 0x84. When this misfires, `process_transaction` (line 385) returns Err and the POS records the card payment as failed while the payment terminal proceeds to approve and capture the charge.

**Evidence**

zvt.rs:263-268: `if raw.windows(1).any(|w| w[0] == 0x84) { let error_code = raw.get(raw.iter().position(|&b| b == 0x84).unwrap() + 1); return Err(format!("Terminal error: 0x{:02X}", ...)); }` — versus the correct framed parse in `is_positive_completion` (lines 205-210): `let Some(apdu) = Self::extract_framed_apdu(raw) else { return false; }; apdu.len() >= 2 && apdu[0] == ACK_POSITIVE && apdu[1] == 0x00`.

**Impact.** Customer's card is charged but the POS shows the payment as failed; cashier retries and double-charges, or the order is left unpaid in POS while money was captured — direct money incorrectness in the card payment flow. (Mitigating context: real ECR hardware certification is tracked as a separate production gate, so this fires the day a ZVT terminal is certified, on ordinary amounts/receipt text.)

**Suggested fix.** Classify errors the same way positive completions are classified: run `extract_framed_apdu(raw)` and treat it as a negative completion only when `apdu[0] == 0x84` (optionally reading apdu[1] as the error code). Never scan unframed payload bytes for status codes. The inner `.position().unwrap()` becomes unnecessary once the framed check is used.

### P1-07 — Fiscal active-cache is never populated in production, so every order enqueues a priority-100 fiscal row that consumes the fail-closed sync-queue cap and can block order creation offline

> ✅ **verified (3-verifier adversarial panel)** · Fiscal · `pos-tauri/src-tauri/src/fiscal/active_cache.rs:91`

active_cache::update() has zero production call sites — the only callers are #[cfg(test)] tests in sync.rs (lines 19270, 19313); no /api/plugins/fiscal/health poll exists anywhere in pos-tauri (Rust or renderer TS). Therefore verdict() returns Unknown forever, and both skip checks in dispatcher.rs (lines 79 and 217) only skip on Inactive. Result: enqueue_for_order() (called from order_create for EVERY order, orders.rs:3748) builds a fiscal payload and inserts a module_type='fiscal' row into parity_sync_queue at priority 100 for every order on every terminal, including organizations that have never configured any fiscal plugin. Online this is one wasted POST per order (server returns 200 status='skipped'). Offline it is 2 pending rows per order against the shared MAX_QUEUE_SIZE=5000 fail-closed cap (sync_queue.rs:656), and order enqueue failure rolls back order creation (sync.rs:1861-1864).

**Evidence**

dispatcher.rs:217 'if let CacheVerdict::Inactive = active_cache::verdict(&branch_id) { ... return Ok(()); }' — Unknown falls through to enqueue_fiscal_row with 'Some(100), // FINANCIAL_CRITICAL' (dispatcher.rs:263). Grep for active_cache::update across src-tauri/src returns only sync.rs:19270/19313, both inside #[test] fns (test_create_order_persists_receipt_number_for_fiscal_enqueue etc.). sync_queue.rs:656 'if replayable >= MAX_QUEUE_SIZE { return Err(...Sync queue is full...) }'; sync.rs:1861 '.map_err(|e| { let _ = conn.execute_batch("ROLLBACK"); format!("enqueue parity sync: {e}") })?'.

**Impact.** For the majority of orgs (no fiscal plugin), offline endurance is silently halved: order creation starts failing at ~2500 orders instead of 5000 because fiscal junk rows fill the cap — fiscal state blocking the order flow, violating the 'fiscal is optional' guardrail. On reconnect, priority-100 fiscal rows drain before priority-0/1 order rows (claim ORDER BY priority DESC, sync_queue.rs:2929), delaying real order/payment sync behind hundreds of no-op 'skipped' POSTs.

**Suggested fix.** Wire a real /api/plugins/fiscal/health poll (e.g., alongside the existing integrations cache refresh in commands/api_bridge.rs) that calls active_cache::update(branch_id, active). Alternatively, in enqueue_for_order treat Unknown like the existing cached_fiscal_order_reporting_entitlement(conn) != Some(true) fallback used at sync.rs:1155-1163, so unentitled orgs never enqueue. Also drop fiscal priority below order priority so receipts never outrank order data.

### P1-08 — Fiscal receipt payload is a snapshot taken at order-create time: pay-later, split-payment, and delivery orders are fiscalized with empty payments and stale totals, and are never re-dispatched on payment completion

> ✅ **verified (3-verifier adversarial panel)** · Fiscal · `pos-tauri/src-tauri/src/commands/orders.rs:3748`

The only fiscal dispatch trigger in pos-tauri is the T22 hook inside order_create (orders.rs:3742-3758) — grep confirms enqueue_for_order has no other production caller and payments.rs contains zero fiscal references. build_fiscal_receipt_input reads order_payments WHERE status='completed' at that instant (payload_builder.rs:274-282). Only the quick-sale flow records an initialPayment inside create_order before the hook (sync.rs:1657-1690; OrderFlow.tsx:900-914 builds initialPayment only for non-split cash/card/room_charge). For split payments (method 'pending'), dine-in table checks paid at the end, and delivery orders paid on delivery, the enqueued payload permanently has payments=[], paymentMethodCode='O', and grossCents from the creation-time header total (payload_builder.rs:133-140). The queued row is replayed verbatim (sync_queue.rs:3939-3946, only issuedAt is normalized) and nothing re-enqueues on payment recording, order_update_financials, item additions, or cancellation (no 'cancel' operation is ever sent from pos-tauri).

**Evidence**

payload_builder.rs:133 'let gross_cents: i64 = if payments.is_empty() { Cents::round_half_even(header.total_amount).as_i64() } else ...'; module doc at payload_builder.rs:10-14 states the HR adapter validator 'rejects empty lines, empty payments, and missing metadata ... terminally'; admin-dashboard zod schema allows empty arrays (zod-schemas.ts:63-64) so the 422 comes from the adapter validator after dispatch.

**Impact.** For a fiscal-active org, every order not fully paid at creation produces a terminally rejected fiscal submission (HTTP 422 payload_invalid) — those sales are never reported to the tax authority — or, for adapters that tolerate empty payments, the authority receives creation-time totals that omit later items, tips, and the actual payment method. Orders cancelled after creation have already had a sale receipt enqueued with no compensating cancel.

**Suggested fix.** Move the dispatch trigger to the payment-completion/settlement path (record_payment_in_connection callers) or rebuild the payload at replay time from current DB state instead of storing a creation-time snapshot; gate dispatch on payment_status='completed'; add a cancel-operation dispatch when a fiscalized order is voided.

### P1-09 — Z-report close-day fiscal guard is structurally unreachable dead code — the branch condition guarantees branchId is absent, so ensure_no_queued_fiscal_for_day never executes

> ✅ **verified (3-verifier adversarial panel)** · Fiscal · `pos-tauri/src-tauri/src/commands/zreports.rs:102`

zreport_generate runs the fiscal guard only inside 'if has_shift_id && !has_branch_date' (zreports.rs:102), where has_branch_date is true when payload has 'branchId' OR 'date' (lines 99-100; parse_zreport_generate_payload normalizes branch_id → branchId, lines 43-52). Inside that branch, payload_branch_id re-reads payload.get("branchId") (lines 109-114) — which is None by construction, since the branch is only entered when branchId is absent. So the code always takes the warn-and-skip else arm (lines 144-150) and ensure_no_queued_fiscal_for_day (its only call site, line 125) can never run. If the caller DOES pass branchId, has_branch_date is true and the whole guarded branch is skipped. Req 4.7/T24 is silently unenforced on every single z-report close.

**Evidence**

zreports.rs:99-100 'let has_branch_date = payload.get("branchId").and_then(|v| v.as_str()).is_some() || payload.get("date")...'; line 102 'if has_shift_id && !has_branch_date {'; lines 109-114 'let payload_branch_id = payload.get("branchId")...' — mutually exclusive with the enclosing condition.

**Impact.** Cashiers can always close the business day with fiscal submissions still pending/processing for the branch — the local compliance checkpoint the fiscalization-core spec requires (receipts must reach the authority within the legal window) never fires. Note when fixing: because the active cache is never updated in production (see the active_cache finding), naively wiring the branchId through would make the guard block day-close for orgs with NO fiscal plugin whenever they are offline with pending junk rows — both issues must be fixed together.

**Suggested fix.** Resolve the shift's branch_id from the staff_shifts row (or terminal settings) instead of the close payload, call ensure_no_queued_fiscal_for_day with it, and make the guard skip when the org has no fiscal entitlement (reuse cached_fiscal_order_reporting_entitlement or a fixed active-cache) so an unconfigured org can never be blocked.

### P1-10 — Per-terminal fiscal sequence counters keyed only by (branch, day) produce duplicate receipt identifiers at the tax authority for multi-terminal branches, and daily reset reuses numbers across days

> ✅ **verified (3-verifier adversarial panel)** · Fiscal · `pos-tauri/src-tauri/src/fiscal/sequence_counter.rs:44`

fiscal_sequence_counters lives in each terminal's private local SQLite database but is keyed only (branch_id, business_day_iso). Two terminals on the same branch (a supported production topology) each start at last_seq=1 for the same branch and day, so both emit metadata.sequenceNumber 1, 2, 3... The server-side HR adapter stamps sequenceNumber into <tns:BrOznRac> and the PER-BRANCH HrBranchSettings.cashRegisterCode into <tns:OznNapUr> (admin-dashboard/src/services/fiscal/adapters/hr/xml-builder.ts:225-227), so the CIS receives multiple receipts with identical (BrOznRac, OznPosPr, OznNapUr) identifiers on the same day. Server idempotency (fiscal:{orderId}:{branchId}, dispatcher.ts:104-107) dedups per order, not per sequence number, so the duplicates go through. Additionally the counter resets every business day (sequence_counter.rs docs claim this is the HR convention), so the same identifiers repeat day after day even on a single terminal, while Croatian numbering is continuous within a year.

**Evidence**

sequence_counter.rs:44-51 'INSERT INTO fiscal_sequence_counters (branch_id, business_day_iso, last_seq, ...) VALUES (?1, ?2, 1, ...) ON CONFLICT (branch_id, business_day_iso) DO UPDATE SET last_seq = ... + 1' — no terminal component in the key, and the table is per-terminal local storage; xml-builder.ts:225-227 '<tns:BrOznRac>${escapeXml(String(md.sequenceNumber))}...<tns:OznNapUr>${escapeXml(cashRegisterCode)}' with cashRegisterCode sourced from per-branch settings (hr/index.ts:322,338).

**Impact.** Any branch running two or more POS terminals submits duplicate receipt numbers to the Croatian CIS every day — a direct fiscal-audit violation attributable to the merchant. Gaps also appear whenever a sequence is allocated but the payload is later dropped (dispatcher DroppedWithLog path).

**Suggested fix.** Either include a per-terminal device code in the number space (allocate a distinct cashRegisterCode per terminal and key the counter by terminal too), or move sequence allocation server-side into the outbox where a single authoritative counter per (org, branch, register) exists; align the reset period with the target country's rules instead of hardcoding daily reset.

### P1-11 — Generic fiscal: lost/corrupt response to CMD_CLOSE_FISCAL_RECEIPT records failure after the device has fiscally committed the receipt — retry double-issues, no reconciliation

> ✅ **verified (3-verifier adversarial panel)** · Hardware / ECR · `pos-tauri/src-tauri/src/ecr/protocols/generic_fiscal.rs:419`

The close step uses `self.send_command(CMD_CLOSE_FISCAL_RECEIPT, &[])?`. If the device has already printed and committed the receipt to fiscal memory but the response is lost (transport timeout returns empty → parse_response errs "Empty response from device") or corrupted (strict-LRC rejection at generic_fiscal.rs:189), the Err propagates. commands/ecr.rs then records the transaction as status "error" and returns success:false (commands/ecr.rs:2439-2468) without any device-side query. The codebase explicitly handles the inverse orphan case — device success + local DB insert failure (commands/ecr.rs:2408-2437, "ecr.orphaned_receipt") — but not this response-loss case, and there is no "read last receipt number / fiscal counters" reconciliation before declaring failure.

**Evidence**

let (cmd, close_data) = self.send_command(CMD_CLOSE_FISCAL_RECEIPT, &[])?;  // Err on timeout/LRC loss even though the device already closed and printed the fiscal receipt

**Impact.** Operator retries the fiscal print and the device issues a second fiscal receipt for the same order: fiscal memory (legal audit trail / tax totals) double-counts the sale, and the order's fiscal_receipt_number backfill to the server is never enqueued for the first, real receipt.

**Suggested fix.** On close-step failure, query the device before reporting failure: read CMD_GET_STATUS_FISCAL counters (fiscal_receipt_counter) or the vendor "last receipt" command and compare against the pre-transaction counter; if the receipt was committed, return Approved with the recovered receipt number. At minimum, tag the error as ambiguous ("receipt may have been issued") so the UI blocks blind retry.

### P1-12 — Fully-refunded order becomes a 'no_persisted_payment' blocker that blocks shift close/Z-report and whose one-click repair records a phantom payment

> ✅ **verified (3-verifier adversarial panel)** · Money / payments · `pos-tauri/src-tauri/src/payment_integrity.rs:134`

A full refund (refunds.rs:477 sets order_payments.status='refunded', then recompute_order_payment_state drops orders.payment_status to 'pending' because load_net_paid_for_order only counts status='completed' rows) leaves the order with status='completed', payment_status='pending', and zero completed payments. classify_blocker_row has no awareness of refund adjustments: the order is classified as 'no_persisted_payment' ('Order was completed without a persisted cash/card payment. Record the missing cash or card payment.'). load_branch_window_payment_blockers only excludes orders whose status is cancelled/refunded, and nothing in the refund flow (refunds.rs or RefundVoidModal.tsx) moves the order to such a state. Cashier shift close (shifts.rs:711-727) and Z-report (zreport.rs:569) hard-fail on this blocker. Worse, blocker_is_resolvable_from_z_report (payments.rs:172-176) returns true for this reason code, so the Z-report UI offers auto-repair via resolve_unsettled_payment_blocker_payment (payments.rs:1296-1432), which records a brand-new cash/card payment for the FULL order total into a cashier drawer — phantom revenue for money that was handed back to the customer, synced to admin as a real payment.

**Evidence**

refunds.rs:477 "UPDATE order_payments SET status = 'refunded' ..."; payment_integrity.rs:134-145 "if row.completed_payment_count <= 0 { return Some(build_blocker(&row, \"no_persisted_payment\", \"Order was completed without a persisted cash/card payment.\"..."; payments.rs:1377 repair records amount = outstanding_amount (= full total since net_paid is 0); shifts.rs:721-726 returns "Cannot close shift" on any blocker.

**Impact.** Every full refund of a completed order blocks the cashier's shift close and Z-report for that business day. The suggested in-app fix re-books the refunded amount as new cash/card income, overstating revenue and corrupting drawer variance; the alternative escape (cancelling the order) triggers the reconcile double-subtraction bug (see reconciled-refunds finding).

**Suggested fix.** In classify_blocker_row, compute settled/remaining net of refund adjustments and skip orders whose completed+refunded payments fully covered the total; or have the full-refund path mark the order payment_status (e.g. 'refunded') and exclude it from the blocker window, and make 'no_persisted_payment' non-resolvable when refund adjustments exist for the order.

### P1-13 — Close-time drawer reconciliation counts ALL refund adjustments as cash out of the drawer, contradicting the cash-only/handler-aware write path in refunds.rs

> ✅ **verified (3-verifier adversarial panel)** · Money / payments · `pos-tauri/src-tauri/src/shifts.rs:851`

The refund write path only adds to cash_drawer_sessions.total_refunds for cash refunds handled by the cashier drawer (refunds.rs:384-387 sets cash_handler=None for card refunds; refunds.rs:485-501 updates the drawer only in the CashierDrawer arm; DriverShift refunds adjust driver_earnings instead). But the reconcile-at-close step overwrites total_refunds with SUM of ALL payment_adjustments WHERE adjustment_type='refund' — no refund_method, cash_handler, or parent-payment-status filter, attributed by the ORDER's financial timestamp window rather than when/where the cash actually moved (shifts.rs:851-867, applied at 897-921), and that value feeds expected cash: 'expected = opening_cash + cash_sales - refunds - ...' (shifts.rs:996-1003). Three concrete failure modes: (a) a EUR 20 card refund during the shift reduces expected CASH by 20 though no cash left the drawer → phantom EUR 20 overage; (b) a payment fully refunded (status='refunded') is excluded from reconciled_cash_sales (shifts.rs:825 requires op.status='completed') while its refund adjustment is still summed → the amount is subtracted twice → phantom overage equal to the payment (reachable once the order is cancelled to clear the blocker); (c) a cash refund issued today for last week's order is attributed to last week's closed shift and dropped from today's reconcile, erasing today's genuine cash-out → phantom shortage.

**Evidence**

shifts.rs:854-862: "SELECT COALESCE(SUM(COALESCE(pa.amount_cents, ...)), 0) FROM orders o JOIN payment_adjustments pa ON pa.order_id = o.id ... WHERE ... pa.adjustment_type = 'refund'" — no refund_method/cash_handler filter; vs refunds.rs:485 "Some(CashHandler::CashierDrawer) => { ... total_refunds = COALESCE(total_refunds, 0) + ?1" (the only arm touching the drawer counter).

**Impact.** Cash variance persisted at every cashier shift close (and synced shift snapshots) is wrong whenever any card refund, driver-handled refund, full refund, or cross-day refund exists in the window — phantom overages/shortages that operators will 'correct' with real cash.

**Suggested fix.** Make the reconcile query mirror the write-path semantics: sum only adjustments with refund_method='cash' AND cash_handler='cashier_drawer' (plus void reversal semantics), attribute by the adjustment's own shift/created_at rather than the order window, and add back the principal of fully-refunded payments or exclude their adjustments symmetrically.

### P1-14 — room_charge is an accepted local payment method but payment_integrity flags it 'unsupported_payment_method', hard-blocking shift close and Z-report with no auto-resolution

> ✅ **verified (3-verifier adversarial panel)** · Money / payments · `pos-tauri/src-tauri/src/payment_integrity.rs:253`

record_payment explicitly allows method='room_charge' (payments.rs:1252-1255: 'Only cash, card, and room_charge payments can be recorded locally'), and the renderer offers it as a first-class method (PaymentModal.tsx PaymentMethodSelection = 'cash' | 'card' | 'room_charge'; OrderFlow.tsx:903 passes it as initialPayment into order creation, which inserts a completed order_payments row via record_payment_in_connection). But order_blocker_row_select counts every completed payment whose method is NOT IN ('cash','card') as invalid_completed_method_count (payment_integrity.rs:248-254), and classify_blocker_row returns an 'unsupported_payment_method' blocker BEFORE the remaining==0 early-return (lines 102-119) — i.e. even fully settled room-charge orders block. blocker_is_resolvable_from_z_report (payments.rs:172-176) returns false for exactly this reason code, so the operator gets 'needs manual review' and the suggested fix 'Void the unsupported payment row and recollect the payment as cash or card.'

**Evidence**

payment_integrity.rs:253: "AND LOWER(TRIM(COALESCE(op.method, ''))) NOT IN ('cash', 'card')"; payments.rs:1252: "if input.method != \"cash\" && input.method != \"card\" && input.method != \"room_charge\""; shifts.rs:711-727 refuses cashier close on any blocker.

**Impact.** Any branch using the hotel room-charge flow cannot close a cashier shift or run a Z-report for a day containing a room-charge order; the only in-app remedy voids a legitimate applied room charge and re-collects cash/card, double-charging the guest or corrupting the folio.

**Suggested fix.** Add 'room_charge' (and any other locally-recordable method) to the valid-method set in order_blocker_row_select, or classify room_charge orders separately instead of as unsupported; keep the unsupported branch only for genuinely unknown methods.

### P1-15 — sync::create_order inserts orders without any *_cents columns, so new orders' canonical money is derived by SQLite ROUND (half-up) which disagrees with Rust round_half_even on exact ties — a full payment can leave the order permanently 'partially_paid' by 1 cent

> ✅ **verified (single skeptic)** · Money / payments · `pos-tauri/src-tauri/src/sync.rs:1569`

The order INSERT in create_order (sync.rs:1569-1650) writes total_amount/subtotal/tax/discount/tip/delivery_fee as REAL only — no *_cents siblings — unlike the W4c-converted edit path (commands/orders.rs update_order_items_in_connection dual-writes via Cents::round_half_even). There is no dual-write trigger (only the v49 idempotency trigger exists). All reads then go through the shim COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER)); SQLite ROUND is half-away-from-zero while every Rust conversion uses round_ties_even. For an IEEE-representable half-cent tie (totals ending .125 or .625 — e.g. 50% discount on a EUR 2.25 item = 1.125, or halving a .25/.75 total in a split), the order total shims to N+1 cents while the payment for the identical f64 amount is stored as N cents (payments.rs:1019). recompute_order_payment_state (payments.rs:810-815) then computes total_paid_cents < order_total_cents → payment_status='partially_paid' with 1 cent outstanding, and validate_payment_amount_against_outstanding rejects any attempt to pay more than the phantom 1 cent... which classify_blocker_row reports as 'partial_payment_remaining' and blocks shift close/Z-report until a 1-cent phantom payment is recorded.

**Evidence**

sync.rs:1570-1582 column list contains "total_amount, tax_amount, subtotal ... discount_amount, tip_amount ... delivery_fee" and no *_cents; payment_integrity.rs:223 "COALESCE(o.total_amount_cents, CAST(ROUND(o.total_amount * 100) AS INTEGER), 0)"; payments.rs:1019 "let amount_cents = Cents::round_half_even(input.amount).as_i64();" — ROUND(112.5)=113 in SQLite vs round_ties_even(112.5)=112 in Rust.

**Impact.** Orders created with tie-valued totals can never reach 'paid'; the 1-cent ghost outstanding blocks cashier close/Z-report and prompts a phantom 1-cent repair payment. Also blocks the planned 4e REAL-column drop, since new rows carry NULL cents.

**Suggested fix.** Dual-write total_amount_cents/subtotal_cents/tax_amount_cents/discount_amount_cents/tip_amount_cents/delivery_fee_cents in the create_order INSERT using Cents::round_half_even (same as update_order_items_in_connection), so the canonical cents value is fixed at write time instead of re-derived by SQLite with a different rounding rule.

### P1-16 — Payment tip is never persisted locally and is silently dropped from the sync payload whenever the queue entry is rebuilt

> ✅ **verified (single skeptic)** · Money / payments · `pos-tauri/src-tauri/src/payments.rs:1518`

record_payment_in_connection's initial sync payload includes tipAmount/tip_amount_cents (payments.rs:1187-1189), and admin /api/pos/payments consumes and stores them (admin-dashboard/src/app/api/pos/payments/route.ts:114-136, 417). But order_payments has no tip column (the INSERT at payments.rs:1027-1061 omits it; db.rs only defines tip_amount on orders and driver_earnings), so build_payment_sync_payload_for_payment (payments.rs:1518-1548) rebuilds the payload from DB WITHOUT any tip key. Every rebuild path — refresh_payment_sync_queue_entry (payments.rs:1573, triggered by update_payment_method at 1833/1888 and by edit-settlement refunds on not-yet-applied parents at refunds.rs:617) and the payment-total-conflict recovery repair (commands/recovery.rs:214-218) — replaces the queued payload via upsert, permanently deleting the tip before it ever reaches the server. The tip is also invisible to all local reporting (drawer, Z-report) because it lives nowhere in SQLite.

**Evidence**

payments.rs:1518-1548 json! keys: paymentId, ..., amount, amount_cents, currency, cashReceived, ..., discountAmount ... — no tipAmount/tip_amount_cents; contrast payments.rs:1187-1189: '"tipAmount": input.tip_amount, ... "tip_amount_cents": Cents::round_half_even(input.tip_amount).as_i64()'.

**Impact.** Card/cash tips recorded with a payment are lost from the server record whenever the operator edits the payment method, an edit-settlement refund touches an unsynced payment, or the recovery flow re-queues the payment — misstating staff tip income; tips also never appear in local drawer/Z figures.

**Suggested fix.** Add a tip_amount/tip_amount_cents column to order_payments, persist it in record_payment_in_connection, and read it back in build_payment_sync_payload_for_payment so rebuilt payloads carry the same tip as the original enqueue.

### P1-17 — Printed receipt and fiscal payload read legacy REAL money columns while the charge path is cents-authoritative

> ✅ **verified (3-verifier adversarial panel)** · Printing · `pos-tauri/src-tauri/src/print.rs:2411`

build_order_receipt_doc reads total_amount, subtotal, tax_amount, discount_amount, delivery_fee and tip_amount straight from the REAL float columns (print.rs:2409-2456), and payment lines from order_payments.amount/cash_received/change_given floats (print.rs:2584). Meanwhile the payment engine validates and charges from the cents-authoritative shim: payments.rs:690-699 uses COALESCE(total_amount_cents, CAST(ROUND(total_amount*100) AS INTEGER)). The W4b program converted payments/refunds/commands/sync/shifts/zreport reads to that shim precisely because the two columns can disagree, but the customer-facing printed receipt (and the fiscal payload builder at fiscal/payload_builder.rs:211, which also reads COALESCE(total_amount, 0.0)) were never converted. Writers also populate cents with two different rounding rules: Rust sites use Cents::round_half_even while sync.rs:10859 uses SQL CAST(ROUND(?*100)) (half-away-from-zero), so cents vs float-derived-cents can legitimately differ by 1.

**Evidence**

print.rs:2411 'COALESCE(customer_phone, \'\'), COALESCE(items, \'[]\'), COALESCE(total_amount, 0),' read as f64 vs payments.rs:693 'SELECT COALESCE(total_amount_cents, CAST(ROUND(total_amount * 100) AS INTEGER), 0)'; fiscal/payload_builder.rs:211 'COALESCE(total_amount, 0.0)'; sync.rs:10859 'total_amount_cents = COALESCE(CAST(ROUND(?4 * 100) AS INTEGER), total_amount_cents)'

**Impact.** Whenever total_amount_cents disagrees with the REAL column (half-cent totals from percentage discounts/tax, one-sided UPDATE drift — a failure class this repo has already hit per the W4e Step-0 'UPDATEs on REAL must dual-populate cents' lesson), the printed TOTAL/payment lines differ from what the payment engine actually charged, e.g. customer charged 12.35 while the legal receipt prints 12.34. The fiscal compliance payload inherits the same divergence.

**Suggested fix.** Switch build_order_receipt_doc, the split/shift/z-report doc builders, and fiscal/payload_builder.rs to the same COALESCE(*_cents, CAST(ROUND(real*100) AS INTEGER)) boundary reads used everywhere else (payments.rs:693 pattern), converting to display floats via Cents::to_f64_dp2.

### P1-18 — Approved terminal charge followed by a failed local record is reported as 'Card payment failed' and invites a re-charge on retry

> ✅ **verified (3-verifier adversarial panel)** · Checkout (UI) · `pos-tauri/src/renderer/components/modals/SplitPaymentModal.tsx:349`

settleTerminalPortion (pos-tauri/src/renderer/utils/splitPaymentSettlement.ts:78-79) runs processPayment (real card charge) then recordPayment (local persist). The catch in handleTerminalCardPayment (lines 349-353) treats any throw — including a record-stage failure AFTER the terminal approved the charge — identically: it resets the portion to status 'draft' and toasts 'Card payment failed'. Realistic record-stage failures exist: the local outstanding guard (payments.rs validate_payment_amount_against_outstanding, line 727/986) rejects the insert if another terminal recorded a payment or the total changed between the line-332 drift check and the record; SQLite BEGIN IMMEDIATE contention; IPC failure. The operator, told the card payment failed on a portion now shown as unpaid draft, retries — which re-runs bridge.ecr.processPayment and charges the card a second time (no ECR-side dedup, see ecr.rs:1672). SinglePaymentCollectionModal has the same shape: ecr.processPayment (line 162) then recordCollectedPayment (line 177); its catch (lines 196-207) shows 'Failed to collect payment' and re-enables the Collect button.

**Evidence**

splitPaymentSettlement.ts:78-79: `const { transactionId } = await effects.processPayment(); const paymentId = await effects.recordPayment(transactionId);` — SplitPaymentModal.tsx:351-352 on ANY error: `updatePortion(portionId, (current) => ({ ...current, status: 'draft', paymentOrigin: 'manual' })); toast.error(... 'Card payment failed')`.

**Impact.** Customer's card is charged while the POS shows the portion/order unpaid; the natural operator response (retry) produces a second real charge. The approved transactionId is only in the console log, so reconciliation against the acquirer is manual.

**Suggested fix.** Distinguish the two stages: catch record-stage failures separately (settleTerminalPortion already sequences them), keep the portion in a 'charged, recording failed' state carrying the approved transactionId, and retry only the recordPayment step (never processPayment) — or persist a pending ECR transaction record before charging so recovery can re-attach.

### P1-19 — Delivery validation cache keyed only by address — stale delivery fee and minimum-order verdicts served across order amounts, branches, and zone changes

> ✅ **verified (3-verifier adversarial panel)** · Offline / sync (UI) · `pos-tauri/src/services/DeliveryZoneValidator.ts:365`

DeliveryZoneValidator caches full validation responses (zone, deliveryFee, validation.meetsMinimumOrder/shortfall/estimatedTotal, uiState.canProceed) but its cache key is only the address: `getCacheKey()` returns `address:${...}` or `coords:${...}` with neither branchId nor orderAmount, even though `validateAddress(address, orderAmount)` takes orderAmount as an input and the validator is constructed per-shift-branch (useDeliveryValidation.ts:70-77). The cache is checked BEFORE any network call (lines 101-107), persisted to a single shared localStorage key `pos_delivery_validation_cache` (line 42, loaded in the constructor at line 87), and lives 30 minutes across app restarts and branch switches. The inner shared service gets the key right (`${branchId}|${addressKey}|${orderAmount}` at DeliveryValidationService.ts:478) but is never reached on a hit in the outer cache. Worse, the only invalidation path — the delivery_zones realtime subscription that called `validatorRef.current.clearCache()` — is disabled dead code (useDeliveryValidation.ts:92-143 `return;` at line 96 before the subscription), and no IPC event replaces it: `clearCache()` has no live caller anywhere in the renderer.

**Evidence**

getCacheKey(): `if (typeof address === 'string') { return `address:${address.toLowerCase().trim()}`; } return `coords:${address.lat.toFixed(6)},${address.lng.toFixed(6)}`;` — no branchId, no orderAmount. validateAddress(): `const cached = this.getCachedValidation(cacheKey); if (cached) { return cached; }`. useDeliveryValidation.ts:93-96: `// DISABLED: Real-time subscriptions are now handled by the main process ... return; // Exit early` with the `clearCache()` call at line 119 inside the commented-out block. The result is consumed for money: OrderDashboard.tsx:2451 `const deliveryFee = resolveDeliveryFee(validationResult);` feeds the order total (line 2461-2464).

**Impact.** A €50 order to an address validated 10 minutes earlier with a €10 order (or vice versa) reuses the stale meetsMinimumOrder/shortfall verdict; an admin changing a zone's delivery fee or boundary is ignored for up to 30 minutes (including across POS restarts) so orders are created with the old fee; a terminal whose shift switches branch serves branch-A zone results and fees for branch-B deliveries. MenuModal and ProductCatalogModal both use this hook with debounceMs:0, so every delivery checkout path is exposed.

**Suggested fix.** Include branchId and orderAmount in the outer cache key (mirroring DeliveryValidationService.getCacheKey), or delete the outer cache entirely and rely on the correctly-keyed 5-minute inner cache; scope the localStorage key per branch; wire a live invalidation (IPC event from the main-process sync service, or drop persistence) so zone edits clear cached results.

### P1-20 — Shift-close reconciliation counts card/driver refunds against the drawer and drops fully-refunded cash payments — expected cash and variance are wrong

> ✅ **verified (3-verifier adversarial panel)** · Shifts & Z-report · `pos-tauri/src-tauri/src/shifts.rs:851`

During the shift, cash_drawer_sessions.total_refunds is only incremented for cash refunds handled by the cashier drawer (refunds.rs:484-501: `Some(CashHandler::CashierDrawer)` arm; card refunds have cash_handler=None and never touch the drawer). But close_shift's reconcile-at-close (shifts.rs:851-867) overwrites total_refunds with SUM of ALL payment_adjustments of type 'refund' — no refund_method/cash_handler filter — and feeds it into `expected = opening + cash_sales - refunds - ...` (shifts.rs:996-1003). Compounding this, reconciled_cash_sales (shifts.rs:817-833) filters `op.status = 'completed'`, so a fully-refunded cash payment (status flipped to 'refunded' at refunds.rs:476-482) is excluded from cash_sales while its refund adjustment IS subtracted — a double removal. The same unfiltered refund sum is repeated in recompute_closed_cashier_shift_financial_snapshot (shifts.rs:2497-2513, 2596-2604). Other code knows the correct rule: get_shift_summary's cash_refunds filters `refund_method='cash' AND cash_handler='cashier_drawer'` (shifts.rs:1746-1751), and zreport.rs:1161-1178 documents "Card refunds don't touch the drawer, so we only sum refund_method = 'cash'".

**Evidence**

shifts.rs:851-867: `SELECT COALESCE(SUM(COALESCE(pa.amount_cents, ...)), 0) FROM orders o JOIN payment_adjustments pa ON pa.order_id = o.id ... WHERE ... pa.adjustment_type = 'refund'` — no refund_method filter — vs refunds.rs:484-501 where only `Some(CashHandler::CashierDrawer)` updates `total_refunds = COALESCE(total_refunds, 0) + ?1`.

**Impact.** Every card refund during a cashier shift understates expected drawer cash by the refund amount, producing a phantom positive variance (drawer appears over) at close; a fully-refunded cash payment (cash in then cash back out, drawer net zero) skews expected by the full payment amount. Wrong variance and total_refunds propagate into the cash_drawer_sessions row, the shift-close sync payload to admin, and Z-report drawer aggregates (zreport.rs:3663 reads total_refunds), corrupting cash accountability records used to detect theft/shortages. No test covers refunds in close reconciliation.

**Suggested fix.** Restrict reconciled_refunds to `refund_method='cash' AND COALESCE(cash_handler,'cashier_drawer')='cashier_drawer'` (matching get_shift_summary), and include op.status IN ('completed','refunded') in reconciled_cash_sales so refunded cash payments' original inflow stays counted; apply the same fix in recompute_closed_cashier_shift_financial_snapshot.

### P1-21 — Multi-shift Z-report includes 'refunded'-status orders in gross sales while excluding their payments and refund adjustments — net_sales overstated

> ✅ **verified (3-verifier adversarial panel)** · Shifts & Z-report · `pos-tauri/src-tauri/src/zreport.rs:3483`

In build_z_report_for_date, the three window aggregates use inconsistent order-status filters: the order/gross aggregate excludes only `('cancelled','canceled')` (zreport.rs:3483), but the payments aggregate (3516) and the refund/void adjustments aggregate (3571) both exclude `('cancelled','canceled','refunded')`. An order whose status is 'refunded' therefore contributes its full total_amount to gross_sales, while its refund adjustment is dropped from refunds_total, so `net_sales = gross - refunds - voids - discounts` (3817) retains the fully refunded amount with no offset. The single-shift path is internally consistent (generate_z_report adjustments filter at 2546 keeps refunded orders in scope), so the same day yields different totals depending on which path runs. Orders acquire local status 'refunded' via server sync: normalize_order_status_for_sync (pos-tauri/src-tauri/src/sync.rs:12638-12645) maps 'refunded' through verbatim, e.g. delivery-platform orders refunded upstream.

**Evidence**

zreport.rs:3483 (order agg): `AND o.status NOT IN ('cancelled', 'canceled')` vs zreport.rs:3571 (adjustments): `AND o.status NOT IN ('cancelled', 'canceled', 'refunded')` feeding zreport.rs:3817 `let net_sales = gross_sales - refunds_total - voids_total - discounts_total;`.

**Impact.** Any order carrying status 'refunded' at day close (platform-refunded delivery orders synced down, or dashboard-refunded orders) inflates the persisted daily Z-report's gross_sales and net_sales by the refunded order's full total; the fiscal/admin submission disagrees with the orders and payments tables and with the single-shift Z for the same shift.

**Suggested fix.** Make the three filters consistent: either exclude 'refunded' orders from the gross aggregate at 3483, or include them in the payments/adjustments scopes at 3516/3571 (matching the single-shift path at zreport.rs:2489/2546).

### P1-22 — close_shift total_sales fans out per payment row — split-paid orders are double-counted in shift sales totals

> ✅ **verified (single skeptic)** · Shifts & Z-report · `pos-tauri/src-tauri/src/shifts.rs:1129`

The 'staff earnings' aggregate in close_shift LEFT JOINs order_payments onto orders and computes `COALESCE(SUM(o.total_amount), 0)`. An order settled with a split payment has two (or more) completed order_payments rows, so the join duplicates the order row and its total_amount is summed once per payment. The author was aware of the fan-out — order_count uses `COUNT(DISTINCT o.id)` — but the SUM was not deduplicated. The result is persisted to staff_shifts.total_sales_amount/_cents (shifts.rs:1154-1193) and emitted in the shift-close sync payload as totalSalesAmount (shifts.rs:1212). It also uses raw REAL float columns instead of the cents shim used everywhere else. The post-close correction path computes total sales differently (payment-level sums via compute_shift_payment_totals_in_window, shifts.rs:2483-2494), so the two disagree.

**Evidence**

shifts.rs:1127-1138: `SELECT COUNT(DISTINCT o.id), COALESCE(SUM(o.total_amount), 0), ... FROM orders o LEFT JOIN order_payments op ON op.order_id = o.id AND op.status = 'completed' WHERE COALESCE(op.staff_shift_id, o.staff_shift_id) = ?1 ...`

**Impact.** Any shift containing split-paid orders (SplitPaymentModal is a shipped feature) reports inflated total_sales_amount locally and to the admin dashboard — a EUR 40 order paid 20 cash + 20 card adds EUR 80 to shift sales. Drawer expected-cash math is unaffected (cash/card sums are payment-level), but shift sales reporting disagrees with the orders table.

**Suggested fix.** Compute total_sales from a deduplicated order set, e.g. `SUM(total)` over a subquery `SELECT DISTINCT o.id, o.total_amount_cents ...`, or reuse compute_shift_payment_totals_in_window as the recompute path does; use the *_cents columns while at it.

### P1-23 — Z-report closeout gate ignores unsynced parity_sync_queue orders/payments/adjustments — day can close with unsynced money rows

> ✅ **verified (3-verifier adversarial panel)** · Sync core · `pos-tauri/src-tauri/src/sync.rs:3755`

The closeout blocker snapshot (capture_unsynced_sync_queue_snapshot_with_limit, sync.rs:3735-3834) counts all non-synced rows in the LEGACY sync_queue table plus parity_sync_queue rows ONLY where table_name = 'z_reports'. But production order, payment, and payment_adjustment writes are enqueued to parity_sync_queue under table_name 'orders'/'payments'/'payment_adjustments' (payments.rs:1211/1581 via upsert_payment_sync_queue_row at sync.rs:7440-7454; per the comment at sync.rs:9499-9503 'order mutations are normally dispatched through parity_sync_queue'). report_submit_z_report (commands/analytics.rs:1592-1676) drains, then calls build_sync_closeout_blocked_response_for_stage (sync.rs:4216-4226), which only sees the blind-spotted snapshot — so parity payment/order rows left in 'pending' (future next_retry_at), 'failed', or 'conflict' after the drain do not block closeout. The equivalent legacy rows DID block closeout; when z-reports moved to parity (Wave 5 Session 6) only 'z_reports' was added to the count.

**Evidence**

sync.rs:3755-3760: "SELECT COUNT(*) FROM parity_sync_queue WHERE table_name = 'z_reports' AND status NOT IN ('synced', 'applied')" — the only parity contribution to snapshot.count (line 3830: sync_queue_count + parity_z_report_count). No count exists for parity 'orders'/'payments'/'payment_adjustments'. Gate: sync.rs:4220-4223 "if snapshot.count == 0 { return Ok(None); }".

**Impact.** A terminal can close the business day (Z-report) while payments/orders are still unsynced or stuck in conflict in the parity queue. Server-side daily books close without that money; when the rows later sync (or dead-letter), admin totals for an already-closed day diverge from the terminal's Z totals, defeating the entire purpose of the pre/post-closeout sync gate.

**Suggested fix.** In capture_unsynced_sync_queue_snapshot_with_limit, extend the parity count and blocker-detail queries to cover table_name IN ('orders','payments','payment_adjustments','z_reports') (or all monetary table_names the parity dispatcher handles) with status NOT IN terminal states, mirroring the has_outstanding_local_order_queue dual-queue pattern.

### P1-24 — Remote-deleted orders destroy local unsynced payments with no pending-work guard, and orphan their parity queue rows

> ✅ **verified (3-verifier adversarial panel)** · Sync core · `pos-tauri/src-tauri/src/sync.rs:9619`

reconcile_remote_orders processes deleted_ids from the admin dashboard by deleting the legacy sync_queue rows for the order and its payments/adjustments (sync.rs:9606-9617) and then deleting the local order row (9619-9621), which FK-cascades order_payments, payment_adjustments and driver_earnings. Unlike the snapshot-update path immediately below it — which carefully checks has_outstanding_local_order_queue (9728-9736) before overwriting local state — the delete path performs no check for unsynced local work. It also never calls sync_queue::clear_unsynced_items for the parity queue, so parity 'payments'/'orders' rows referencing the now-deleted local order survive and will retry against a missing record until they fail.

**Evidence**

sync.rs:9610-9612: "DELETE FROM sync_queue WHERE entity_type = 'payment' AND entity_id IN (SELECT id FROM order_payments WHERE order_id = ?1)" followed by 9619-9620: conn.execute("DELETE FROM orders WHERE id = ?1", ...) — executed for every deleted_id with no has_outstanding_local_order_queue guard and no parity_sync_queue cleanup.

**Impact.** Concrete scenario: terminal collects a cash payment offline for an order that synced earlier; before the payment uploads, an admin deletes the order in the dashboard. On reconnect, the local order, its payment rows, and their queued sync rows are all destroyed — cash physically in the drawer is no longer represented in shift/Z totals — while the leftover parity payment row POSTs a payment for a nonexistent order and fails repeatedly.

**Suggested fix.** Before deleting, check has_outstanding_local_order_queue (both queues); if unsynced payments/adjustments exist, quarantine the order (e.g., mark cancelled/tombstoned and surface a recovery blocker) instead of hard-deleting, and always scrub matching parity_sync_queue rows in the same transaction.

### P1-25 — Pure connectivity failures consume the permanent-failure retry budget and dead-letter the whole offline backlog

> ✅ **verified (3-verifier adversarial panel)** · Offline queue · `pos-tauri/src-tauri/src/sync_queue.rs:6471`

In process_queue, a transport-level failure (reqwest Err) and every 5xx call mark_failure(), which increments `attempts` and permanently flips the row to status='failed' once `new_attempts >= MAX_RETRY_ATTEMPTS` (10, line 143). No requeue helper covers network dead-letters: the auto-repair helpers run at lines 6025-6058 (terminal-context, rate-limited, fiscal issued_at, legacy order insert, payment-total conflict, customer address, table-session placeholder) and none match 'Network error:' messages. The renderer only gates sync cycles on navigator.onLine (App.tsx:1101-1104), which stays true whenever a LAN/Wi-Fi link exists even if the WAN/ISP is down, and the 'startup' trigger (App.tsx:1121) runs unconditionally. With the 30s retry loop (PARITY_SYNC_RETRY_INTERVAL_MS) and backoff caps of 60s/300s, an order dead-letters after ~5 minutes and a payment after ~15-20 minutes of WAN outage; a black-holed connection (captive portal, 30s timeouts) can exhaust all 10 attempts inside a single process_queue call. Dead-lettered rows never auto-drain when connectivity returns — each requires manual retry in the Recovery Center. This defeats the fail-closed offline design: MAX_QUEUE_SIZE's own comment (line 46-52) sizes the queue to 'absorb a full busy day fully offline', but items cannot survive even an hour of retry cycles.

**Evidence**

Err(e) => { let error_message = format!("Network error: {e}"); ... mark_failure(&db, &item.id, &error_message, item.claim_generation)? } (sync_queue.rs:6471-6479) feeding into `if new_attempts >= MAX_RETRY_ATTEMPTS { ... SET status = 'failed' ... }` (sync_queue.rs:3507-3529); no retry_failed_* helper matches network errors (sync_queue.rs:6025-6058)

**Impact.** During a WAN-down/LAN-up outage (very common: router up, ISP down), the entire queued backlog of orders and payments permanently dead-letters within minutes and never syncs automatically after reconnect; operators must hand-retry every module/item, and any they miss silently diverge from the server.

**Suggested fix.** Do not count transport errors (and arguably 5xx) toward MAX_RETRY_ATTEMPTS — classify them like MODULE_REQUIRED (reschedule with capped backoff, keep status='pending', don't bump attempts), or add a retry_failed_network_items_limited helper that requeues status='failed' rows whose error_message starts with 'Network error:' each cycle. Also break the batch loop on the first transport error (mirroring the 429 break) so one offline cycle cannot burn an attempt on every row.

### P1-26 — mark_deferred shares the `attempts` counter with mark_failure, so deferral cycles consume the 10-attempt dead-letter budget

> ✅ **verified (3-verifier adversarial panel)** · Offline queue · `pos-tauri/src-tauri/src/sync_queue.rs:3690`

mark_deferred increments the same `attempts` column that mark_failure uses for its permanent-failure threshold. Deferral is a NORMAL state for dependent rows ('Waiting for parent order sync' from prepare_payment_request lines 4893-4920, server 409 parent-wait at 6196-6199): a payment enqueued behind its parent order defers once per sync cycle until the parent lands. mark_deferred only escalates at MAX_DEFERRAL_CYCLES=50, but mark_failure compares the SAME counter against MAX_RETRY_ATTEMPTS=10 (line 3507). So a payment that deferred 9 times waiting for its parent, then finally sends and hits ONE transient 500 or network blip, computes new_attempts=10 and is instantly and permanently dead-lettered on its first-ever real transport failure. Additionally, when a parent order is stuck (e.g. dead-lettered per the network-attempts finding), its child payments burn 50 deferral cycles (~25 min at the 30s cycle cadence) and escalate to status='conflict' (lines 3692-3727), which never auto-drains even after the parent is repaired.

**Evidence**

mark_deferred: `let new_attempts = current_attempts + 1; if new_attempts >= MAX_DEFERRAL_CYCLES { ... SET status = 'conflict' ... } ... SET status = 'pending', attempts = ?1` (sync_queue.rs:3683-3748) writing the same `attempts` column read by mark_failure's `if new_attempts >= MAX_RETRY_ATTEMPTS` check (sync_queue.rs:3497-3507)

**Impact.** Offline-captured payments can dead-letter after a single real transport failure because waiting for their parent consumed the retry budget; during extended outages payments escalate to operator-review 'conflict' status and stop auto-draining, so money rows silently stop reaching the server.

**Suggested fix.** Track deferrals in a separate counter (new column or reuse next_retry bookkeeping) so mark_failure's MAX_RETRY_ATTEMPTS threshold only counts genuine send attempts; alternatively have mark_failure subtract deferral cycles or reset attempts when a Deferred item's blocking dependency resolves.

### P1-27 — Offline reservation/appointment/salon-shift INSERTs carry no idempotency key and no local-to-remote id mapping

> ✅ **verified (single skeptic)** · Offline queue · `pos-tauri/src-tauri/src/commands/offline_mutations.rs:654`

offline_reservation_create (642-685), offline_appointment_create (798-841), and offline_staff_shift_create (913-973) enqueue the caller's raw payload with a locally generated temp id ('local-reservation-{uuid}') as record_id only. prepare_request has no handler for these tables, so they fall into the generic passthrough (sync_queue.rs:3969-3978) and POST item.data verbatim to /api/pos/reservations|appointments|staff-schedule (resolve_special_entity_endpoint, 6549-6556, 6579). Unlike room_checkins — which was explicitly built with a persisted client_request_id replay key 'the server keys idempotent replay on' (offline_mutations.rs:1125-1183) — and unlike orders (client_order_id, sync_queue.rs:2107) and financial entities (idempotency_key, 5177-5188), these bodies contain no replay key at all. A 30s request timeout after the server committed, a crash between the 2xx and mark_success, or a lease-reclaim resend replays the POST and creates a duplicate reservation/appointment. Compounding it, a follow-up offline_reservation_update on an offline-created record PATCHes /api/pos/reservations/local-reservation-{uuid}; no remap mechanism exists (apply_success has cases only for orders/table-sessions/driver_earnings), so the 404 dead-letters the update permanently.

**Evidence**

`enqueue_parity_item(&conn, "reservations", &reservation_id, "INSERT", &payload, "hospitality", "manual")` (offline_mutations.rs:656-664) where reservation_id is temp_id("reservation") and payload is the raw caller object; generic prep sends item.data unmodified (sync_queue.rs:3969-3978)

**Impact.** Lost-ack replays duplicate reservations and appointments server-side (double-booked tables/slots), and any offline follow-up edit to an offline-created record 404s and dead-letters, losing the change.

**Suggested fix.** Mirror the room_checkins pattern: persist a client_request_id inside the queued payload (and send it in the body) for reservations/appointments/salon shifts so the server can dedup replays, and capture the server-minted id in apply_success to remap queued UPDATEs for local temp ids.

### P1-28 — The 931-test TS parity suite (checkout money contracts, offline sync coordinator, keyring-session regression) is not enforced by any CI job, release script, or hook

> ✅ **verified (3-verifier adversarial panel)** · Test gaps · `.github/workflows/pos-tauri-test.yml:158`

pos-tauri's `npm test` (scripts/run-parity-tests.mjs) runs ~90 test files / 931 tests including retail-checkout-money-contract.test.ts (THE-324 fee-exclusive total contract), checkout-failure-contract.test.ts, order-modal-totals.test.ts, edit-settlement-financials.test.ts, split-payment-currency.test.ts, ParitySyncCoordinator.test.ts, SyncQueueBridge.test.ts, and secure-session-validation.test.ts (Wave 8 H29 corrupt-keyring regression). No automation runs it: the `frontend` job in pos-tauri-test.yml runs only type-check, locale:parity, parity:contract, test:native-runtime, and test:support-layer; root test.yml (lines 137-143) runs the same four checks; pos-tauri-auto-release.yml (lines 178-181) runs the same four before building the shipped installer; the release verify script `pos:tauri:verify` in pos-tauri/package.json also omits it; .husky/pre-commit only covers admin-dashboard. I ran the suite locally: 931 pass / 0 fail in 4.9 seconds — it is green and cheap, just unwired.

**Evidence**

pos-tauri-test.yml frontend job steps end at `npm run test:support-layer` (line 183) with no `npm test`/`npm run test:desktop-parity` step; package.json: "pos:tauri:verify": "tsc --noEmit && npm run locale:parity && npm run test:support-layer && vite build && ... && npm run test:native-runtime" (no run-parity-tests). Local run: `# tests 931 / # pass 931 / # fail 0 / duration_ms 4853`.

**Impact.** A PR that regresses checkout money math, split-payment currency handling, edit-settlement deltas, or the corrupt-keyring session guard passes every enforced check and can auto-release to production terminals via pos-tauri-auto-release.yml with zero test signal.

**Suggested fix.** Add `npm run test:desktop-parity` to the frontend job in .github/workflows/pos-tauri-test.yml (and to the pre-bundle checks in pos-tauri-auto-release.yml and the `pos:tauri:verify` script). The suite is green and takes ~5s, so this is a one-line change per location.

---

## P2 — robustness, validation, and resource gaps

### P2-01 — Staff check-in PIN verification has no lockout/rate-limiting, allowing unlimited PIN brute-force and staff impersonation

> ✅ verified (single skeptic) · Auth & identity · `pos-tauri/src-tauri/src/auth.rs:1179`

`verify_staff_check_in_pin` (exposed to the renderer via the `staff-auth:verify-check-in-pin` command in pos-tauri/src-tauri/src/commands/auth.rs:247) calls `bcrypt::verify(pin, hash)` directly with no attempt counter, no lockout, and no throttle. It does not touch `AuthState.lockout` at all. By contrast, the app-login path `login()` enforces a durable 5-attempt / 15-minute lockout (MAX_FAILED_ATTEMPTS/LOCKOUT_MINUTES) and `confirm_privileged_action` routes through `verify_privileged_pin_with_lockout`. Staff PINs are short numeric secrets (setup_pin validates 4-32 ASCII digits; 4-digit PINs give only 10,000 combinations). An actor with terminal/IPC access can invoke the command in a loop…

**Fix.** Route `verify_staff_check_in_pin` through the same lockout mechanism as `login()`/`verify_privileged_pin_with_lockout` (shared `AuthState.lockout` load->check->verify->record->persist under the documented lockout-before-conn ordering), and emit a `warn!` on each failed attempt for the audit trail. Consider a per-staff attempt counter so one staff's failures do not lock others out.

### P2-02 — TAURI_ENV_DEBUG string-truthiness inversion: CI release builds ship unminified JS with console/debugger retained and sourcemaps

> ✅ verified (single skeptic) · Config & updater · `pos-tauri/vite.config.ts:34`

vite.config.ts gates production hardening on `process.env.TAURI_ENV_DEBUG` truthiness: `drop: process.env.TAURI_ENV_DEBUG ? [] : ['console', 'debugger']` (line 34), `minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false` (line 42), `sourcemap: !!process.env.TAURI_ENV_DEBUG` (line 44). Tauri v2 sets TAURI_ENV_DEBUG for beforeBuildCommand hooks to the STRING 'true' or 'false' (it is always set; the string 'TAURI_ENV_DEBUG' is present in the installed @tauri-apps/cli native binary, and tauri.conf.json:10 wires `beforeBuildCommand: npm run build` through it). In JS the non-empty string 'false' is truthy, so a RELEASE `tauri build` — exactly what CI runs via `npm run pos:tauri:bundle:win`…

**Fix.** Compare against the literal string: `const isTauriDebug = process.env.TAURI_ENV_DEBUG === 'true';` and use `isTauriDebug` for all three options.

### P2-03 — Factory/emergency reset wipes the terminal without checking the sync queue is drained; emergency reset has no backend authorization at all

> ✅ verified (single skeptic) · DB & reset · `pos-tauri/src-tauri/src/commands/settings.rs:900`

settings_factory_reset (settings.rs:869) and settings_emergency_reset (settings.rs:900) go straight from snapshot to reset::launch_reset without querying parity_sync_queue for pending/processing rows; neither the backend (reset.rs:285 launch_reset) nor the renderer flow (src/renderer/utils/reset-actions.ts) counts or surfaces unsynced items before the wipe. The wipe deletes pos.db and all app data except the recovery dir (reset.rs:167-208), so pending offline sales survive only inside a snapshot that is never auto-replayed. Additionally, settings_emergency_reset deliberately has zero backend auth — its only guard is a renderer-side 'type RESET' confirmation (comment at settings.rs:895-898)…

**Fix.** Before launching a reset, read sync_queue::capacity_usage and block or require an explicit acknowledgment ('N unsynced items will be lost') in the command handler; consider a backend-verified confirmation token for the emergency path so the wipe cannot be triggered by renderer code alone.

### P2-04 — Reset helper deletes keyring credentials before confirming the main app exited; a filesystem-wipe timeout strands unsynced data with no terminal identity

> ✅ verified (single skeptic) · DB & reset · `pos-tauri/src-tauri/src/reset.rs:558`

run_reset_helper's 'WaitingForShutdown' phase is only `thread::sleep(HELPER_STARTUP_GRACE_MS)` = 1 second (reset.rs:558) — it never checks the parent process actually exited (no PID in the manifest, no wait). The helper then deletes ALL keyring credentials first (loop at reset.rs:560-582: terminal_id, pos_api_key, etc.) and only afterwards deletes files. File deletion retries for 60s per path (FILESYSTEM_DELETE_TIMEOUT_MS, reset.rs:22) and then fails hard (reset.rs:596-606). If the main app hangs on shutdown longer than that (ECR DeviceManager.shutdown() blocking, AV file lock on pos.db on Windows), the helper exits with phase=failed leaving the database — including pending…

**Fix.** Pass the parent PID in ResetManifest and have the helper wait for process exit (bounded) before any deletion; reorder so filesystem wipe precedes keyring deletion (or delete credentials last, after verify), so a partial failure leaves a still-functional terminal.

### P2-05 — One transient open/pragma failure quarantines the entire live database and silently boots an empty POS

> ✅ verified (single skeptic) · DB & reset · `pos-tauri/src-tauri/src/db.rs:63`

init() treats ANY open_and_configure error as corruption: on the first failure it calls recovery::quarantine_database_files (moves pos.db + WAL + SHM into the recovery dir) and retries once with a fresh empty file (db.rs:63-75). open_and_configure can fail transiently — Windows AV/backup/indexer file locks during boot, or SQLITE_BUSY on the pragma batch (busy_timeout is set AFTER journal_mode in the same batch, db.rs:93-96, so the first pragma runs with the 0ms default). There is no retry-with-backoff before quarantining, no corruption-vs-lock distinction (no integrity_check), and no operator-facing alert on the boot that follows.

**Fix.** Retry open_and_configure a few times with short backoff, run PRAGMA quick_check to distinguish real corruption from lock/transient errors before quarantining, and emit a blocking operator notification (renderer event + status flag) whenever a quarantine occurred at startup.

### P2-06 — Bundled SQLite 3.46.0 (via rusqlite 0.32.1) carries known upstream CVEs incl. a CISA KEV-listed one

> ✅ verified (single skeptic) · Deps & contracts · `pos-tauri/src-tauri/Cargo.toml:32`

Cargo.toml pins `rusqlite = { version = "0.32", features = ["bundled", ...] }`; Cargo.lock resolves rusqlite 0.32.1 -> libsqlite3-sys 0.30.1, whose bundled amalgamation is SQLite 3.46.0 (May 2024, verified via the vendored sqlite3.h). SQLite 3.46.0 predates the fixes for CVE-2025-29087/CVE-2025-29088 (concat_ws integer overflow, fixed 3.49.1) and CVE-2025-6965 (aggregate-term count corruption, fixed 3.50.2, CISA KEV-listed). Every order, payment, shift and z-report on the terminal is persisted through this engine. Exploitation requires attacker-influenced SQL, which the POS does not directly expose (queries are parameterized), so this is a stale-with-known-CVEs finding rather than an active…

**Fix.** Bump rusqlite to >=0.37 (libsqlite3-sys >=0.35, SQLite >=3.50.2) in a dedicated PR; the rusqlite 0.32->0.37 API delta is small (mostly ToSql/FromSql trait paths). Re-run the full cargo suite with RUST_MIN_STACK set.

### P2-07 — pos-tauri overrides mapStatusForPOS/mapStatusForSupabase with divergent semantics and a 'pending' fallback for unknown statuses

> ✅ verified (single skeptic) · Deps & contracts · `pos-tauri/src/shared/types/order-status.ts:60`

pos-tauri/src/shared/types/order-status.ts re-exports the canonical types from shared/types/order-status.ts but locally REDEFINES the two mapping functions the order flow actually uses. Canonical shared mapStatusForPOS coerces synonyms first ('canceled'->'cancelled', 'delivery'->'delivered'), folds confirmed->preparing and delivered->completed, and falls back to 'ready' for unknown input. The local override (lines 60-74) is a raw identity lookup with `return statusMap[status] || 'pending'` — no synonym coercion, and unknown statuses become 'pending'. Local mapStatusForSupabase (lines 34-47) has the same `|| 'pending'` fallback where canonical returns 'ready'. These local versions are what…

**Fix.** Delete the local mapStatusForPOS/mapStatusForSupabase overrides' raw lookup and route them through the canonical `coerceIncomingStatus` (already imported as sharedCoerceIncomingStatus in the same file) so synonyms are coerced and unknowns fall back to 'ready' (or better: keep the order's current status and log). If the no-folding display behavior is intentional, keep only that delta and document it.

### P2-08 — Fiscal payload builder reads legacy float REAL money columns instead of the authoritative *_cents columns

> ✅ verified (single skeptic) · Fiscal · `pos-tauri/src-tauri/src/fiscal/payload_builder.rs:207`

read_order_header selects COALESCE(total_amount, 0.0) and COALESCE(tax_amount, 0.0) as f64 (payload_builder.rs:207-215) and read_completed_payments selects order_payments.amount as f64 (lines 277-282), then converts with Cents::round_half_even (lines 133-149, 325, 359). The W4 migration made total_amount_cents / tax_amount_cents / amount_cents the authoritative integer values and switched other SQL-boundary reads (payments.rs, zreport.rs, sync.rs) to the cents columns; this module — which produces a legal tax document — still derives cents by re-rounding floats. Wherever the REAL and cents columns drift (the known W4 UPDATE-staleness class: an UPDATE touching only one representation), the…

**Fix.** Switch the two SELECTs to the W4 read pattern: COALESCE(total_amount_cents, CAST(ROUND(total_amount*100) AS INTEGER)) etc., and use the cents values directly instead of round_half_even over floats.

### P2-09 — Scale: read_weight returns a stale cached reading as success and the reader loop never detects disconnect, so by-weight items can be priced on the previous item's weight

> ✅ verified (3-verifier adversarial panel) · Hardware / ECR · `pos-tauri/src-tauri/src/scale.rs:379`

read_weight (exposed as the scale_read_weight command, commands/hardware.rs:459) returns SCALE_STATUS.last_reading with success:true and the original stable flag whenever status.connected is true. The background reader never flips connected or clears last_reading on failure: a persistent read error (USB scale unplugged, cable fault) just logs `warn!("Scale read error")` every 100ms (scale.rs:324-327) while status stays connected:true and last_reading keeps the previous weight. There is no staleness bound on the cached reading.

**Fix.** Have the reader loop mark the scale disconnected (and emit a status event) after N consecutive read errors, clear/timestamp-invalidate last_reading, and make read_weight reject readings older than a small TTL (e.g. 2-3s) instead of returning them as fresh stable weights.

### P2-10 — Customer display fit_line/right_align slice by byte index and panic on multi-byte UTF-8 — any Greek product name longer than the display width panics show_item

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/customer_display.rs:71`

fit_line (and right_align at line 80) truncate with `trimmed[..width]` using byte indices and compare `trimmed.len() >= width` in bytes. For non-ASCII names — Greek is this POS's primary market, 2 bytes per char in UTF-8 — byte index 20 frequently falls inside a character, and Rust string slicing panics ("byte index 20 is not a char boundary"). show_item(name, ...) calls fit_line on the product name for every cart line shown on the display (renderer fires it per item add via bridge.hardware.displayShowItem, src/renderer/hooks/useCustomerDisplay.ts:87-93). Example that panics: name "Σουβλάκι Κοτόπουλο" (35 bytes, byte 20 falls mid-'ο'). The module's stated contract is "errors logged but…

**Fix.** Truncate/pad by char count: `trimmed.chars().take(width).collect::<String>()` and pad with `chars().count()`; ideally transcode to the VFD's code page. Apply to both fit_line and right_align.

### P2-11 — Customer-display and cash-drawer commands run blocking TCP connect (3s) and serial writes directly on the Tokio runtime — missing the spawn_blocking treatment every other hardware path received

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/commands/hardware.rs:504`

display_show_item / display_show_total / display_show_line / display_clear (commands/hardware.rs:490-521) call customer_display::* synchronously from async commands; for Network displays send_bytes does a std TcpStream::connect_timeout(3s) + 2s-timeout write per update (customer_display.rs:102-115), and for Serial displays a blocking serialport write. Likewise drawer_open (commands/hardware.rs:656) and printer_open_cash_drawer (commands/print.rs:3335) call drawer::open_cash_drawer, whose send_escpos_pulse_tcp does a blocking connect_timeout(3s) (drawer.rs:106). The neighboring code explicitly fixed this class of bug elsewhere (serial_read/serial_write H19 at hardware.rs:437, scale/scanner…

**Fix.** Wrap customer_display::show_* / clear / connect and drawer::open_cash_drawer bodies in tokio::task::spawn_blocking at the command layer (same pattern as serial_write at hardware.rs:437), or make send_bytes/send_escpos_pulse_tcp async with tokio::net.

### P2-12 — Generic fiscal: transport-level error mid-receipt (not NAK) leaves the device stuck in receipt-open state with no cancel and no recovery on the next sale

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/ecr/protocols/generic_fiscal.rs:371`

The FiscalReceipt flow sends open → items → subtotal → payments → close. Every NAK branch carefully sends CMD_CANCEL_RECEIPT, but every transport-level failure path (`self.send_command(...)?` on timeout, serial disconnect, LRC-mismatch Err) between open and close propagates immediately without attempting a cancel — the device is left with the fiscal receipt open. The next sale's CMD_OPEN_FISCAL_RECEIPT is NAKed by the device ("previous receipt still open") and process_transaction returns "Device rejected open receipt command" (line 354) with no cancel-and-retry, so the condition persists until an operator manually intervenes (only disconnect_device's abort() sends a cancel).

**Fix.** On any Err between open and close, best-effort send CMD_CANCEL_RECEIPT (ignore its result) before propagating, mirroring the NAK branches; additionally, when CMD_OPEN_FISCAL_RECEIPT is NAKed, attempt one cancel-then-retry-open cycle before failing.

### P2-13 — ecr_process_payment/refund route to an arbitrary HashMap-ordered device when no deviceId is given, ignoring the configured default terminal

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/commands/ecr.rs:1679`

When the renderer omits deviceId, the payment command picks `mgr.connected_device_ids().into_iter().next()` — the first key of a HashMap, i.e. arbitrary and unstable across runs. The same pattern is in ecr_process_refund (commands/ecr.rs:1835). A configured-default lookup exists (db::ecr_get_default_device, used by ecr_get_default_terminal at line 1410 and ecr_fiscal_print at line 2258 with a device-type filter) but is not consulted here. With two devices connected — the common setup of one fiscal cash register plus one card terminal — a Sale can be dispatched to the cash register's protocol.

**Fix.** Resolve the fallback via db::ecr_get_default_device(&conn, Some("payment_terminal")) (matching ecr_fiscal_print's device-type-filtered lookup), and error out with a clear message when no payment-terminal-class device is connected instead of grabbing an arbitrary id.

### P2-14 — Serial scanner claims auto-reconnect but only re-reads the dead handle forever; status keeps reporting connected after unplug

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/scanner.rs:113`

The module doc promises "Auto-reconnect: on read failure, retries after backoff", but the error arm only sleeps 1s and calls serial::read_port again on the same pooled handle. When the USB scanner is unplugged, the OS read fails permanently; the handle is never closed/reopened and no reconnect via the original port name is attempted. SCANNER_RUNNING stays true, so get_status() (line 156) reports connected:true indefinitely, and even replugging the scanner does not restore scanning because the stale handle is never reopened. The scale reader has the same never-recovers loop shape (scale.rs:324) but doesn't claim auto-reconnect.

**Fix.** In the error arm, close the stale handle and periodically retry serial::open_port on the stored port name (with capped backoff); flip a status flag / emit a scanner_status_changed event while disconnected so get_status and the UI reflect reality.

### P2-15 — build_fiscal_data does float money math and ignores the *_cents fields — derived unit prices can make the fiscal receipt total differ from the order total

> ✅ verified (single skeptic) · Hardware / ECR · `pos-tauri/src-tauri/src/ecr/fiscal.rs:78`

The fiscal-receipt builder reads only float fields (price, totalPrice, total_amount, payment amount) and converts each via `(value * 100.0).round() as i64` (positive_cents, line 30), never consulting the *_cents columns the W4 migration added (orders.total_amount_cents exists — it is even seeded in this file's sibling test at commands/ecr.rs:2853). Worse, when an item lacks a unit price it derives one as `total / qty` in f64 (line 78) and rounds to cents, so a 3 × total-10.00 line becomes 3.33/unit and the device-side receipt sums to 9.99. The project guardrail states float money math is a defect.

**Fix.** Prefer *_cents fields (price_cents/unit_price_cents/total_amount_cents/amount_cents) when present and only fall back to float conversion; for the total/qty derivation, distribute integer cents with round_half_even remainder allocation (as elsewhere in the W4 work) so the line items sum exactly to the order total.

### P2-16 — database_reset and database_clear_operational_data are destructive but lack the privileged-action gate their sibling reset commands enforce

> ✅ verified (single skeptic) · IPC surface · `pos-tauri/src-tauri/src/commands/diagnostics.rs:313`

database_reset and database_clear_operational_data wipe all operational/financial tables (via clear_operational_data_inner) and are exposed to the renderer through generate_handler. Neither accepts auth_state nor calls auth::authorize_privileged_action. The functionally equivalent settings_factory_reset (settings.rs:868) requires authorize_privileged_action(PrivilegedActionScope::SystemControl) and recovery_restore_point/recovery_export_* are likewise gated. This is an inconsistent authorization boundary for equally destructive operations.

**Fix.** Require auth::authorize_privileged_action(SystemControl, ...) in database_reset and database_clear_operational_data, matching settings_factory_reset and the recovery commands.

### P2-17 — Void reverses drawer counters on the ORDER's shift instead of the PAYMENT's shift, debiting a drawer that never received the sale

> ✅ verified (single skeptic) · Money / payments · `pos-tauri/src-tauri/src/refunds.rs:893`

record_payment_in_connection credits total_cash_sales/total_card_sales on the payment's resolved shift and stores that shift on the payment row (payments.rs:1144-1170, staff_shift_id in the INSERT). void_payment_with_adjustment instead loads orders.staff_shift_id (refunds.rs:761-768) and reverses the drawer on that shift (refunds.rs:893-918). The two diverge whenever sync_order_owner_with_payment was disabled or the owner moved after payment: cashier_drawer-collected payments (record_payment sets sync_order_owner_with_payment=false, payments.rs:1258-1260), blocker-repair payments recorded into a historical cashier shift (payments.rs:1385-1387), and split orders paid across two cashier…

**Fix.** Load the payment row's staff_shift_id in void_payment_with_adjustment and reverse the drawer on that shift (falling back to order shift only when NULL), and recompute the closed-shift financial snapshot when the target shift status is 'closed', mirroring resolve_unsettled_payment_blocker_payment.

### P2-18 — update_payment_method moves money between cash and card without touching drawer counters or recomputing closed-shift snapshots

> ✅ verified (single skeptic) · Money / payments · `pos-tauri/src-tauri/src/payments.rs:1879`

The cash↔card method edit updates order_payments.method, recomputes order payment state, and refreshes the sync queue (payments.rs:1875-1897) — but performs no cash_drawer_sessions adjustment (the original record_payment credited total_cash_sales or total_card_sales based on the OLD method, payments.rs:1144-1170) and no shift-state guard or closed-shift recompute. For an open shift the error self-heals only at close, when shifts.rs:817-921 re-derives totals from op.method. For a payment whose shift already CLOSED (nothing prevents editing it), the closed shift's persisted expected/variance and its synced snapshot were computed under the old method and are never recomputed, while the admin…

**Fix.** In the method-edit transaction, move the amount between total_cash_sales(_cents) and total_card_sales(_cents) on the payment's shift; when that shift is closed, invoke recompute_closed_cashier_shift_financial_snapshot and replace_unfinished_shift_sync_rows_with_current_snapshot as the blocker-repair path does (or reject method edits on closed-shift payments).

### P2-19 — Per-profile queue pause can starve all other printers indefinitely because the paused-profile filter runs after SQL LIMIT 10

> ✅ verified (single skeptic) · Printing · `pos-tauri/src-tauri/src/print.rs:4485`

process_pending_jobs selects 'the 10 oldest ready pending jobs' in SQL (ORDER BY created_at ASC LIMIT 10, print.rs:4479-4487) and only afterwards filters out jobs belonging to paused printer profiles in Rust (print.rs:4502-4507). Paused-profile jobs stay 'pending' forever (they are never retried, failed, or aged out — the 24h purge only touches failed/printed/dispatched/cancelled). Once >=10 of the oldest ready pending jobs belong to a paused profile, every tick's batch is fully consumed by rows that are then filtered to nothing, and jobs for healthy printers behind them are never reached. Unlike a dead-but-unpaused printer (which self-heals via max_retries=3 -> failed), this state persists…

**Fix.** Move the paused-profile exclusion into the SQL WHERE clause (e.g. printer_profile_id IS NULL OR printer_profile_id NOT IN (...)) so LIMIT 10 only counts dispatchable jobs, or loop fetching until 10 dispatchable jobs / no rows remain.

### P2-20 — Single global print processor with oldest-first batching lets one dead/flow-blocked printer delay every other printer by minutes

> ✅ verified (single skeptic) · Printing · `pos-tauri/src-tauri/src/print.rs:4515`

All printing is serialized behind PRINT_PROCESSOR_LOCK (print.rs:4454, added by 81a111aaa) and the batch of up to 10 jobs is processed strictly sequentially (print.rs:4515) with no per-printer fairness. Dispatch timeouts are per-operation, not per-job: a TCP printer that accepts connections but stops draining (paper out / cover open / flow control) costs up to 5s per 4KB chunk (RAW_TCP_WRITE_TIMEOUT_MS, printers.rs:339, chunk loop printers.rs:1387-1396), so a receipt with a logo raster near the 60KB cap (print.rs:2185) can hold the sole processor for ~75s per attempt, and a cold remote logo fetch adds up to 8s more (print.rs:1741). During that time kitchen-ticket jobs for a healthy printer…

**Fix.** Give each printer profile/target its own dispatch lane (e.g. group the batch by resolved target and process groups on separate blocking tasks, or add a per-job wall-clock budget), keeping the existing per-target serialization to avoid interleaved output.

### P2-21 — Every print job writes a receipt HTML artifact that is never cleaned up — unbounded PII-bearing disk growth

> ✅ verified (single skeptic) · Printing · `pos-tauri/src-tauri/src/print.rs:4587`

process_pending_jobs writes a timestamped HTML file for every job before dispatch (write_print_html_file, print.rs:4017-4032, called at 4587; also generate_receipt_file at 4051 and shift checkout at 4202). Filenames include a timestamp so every attempt creates a new file. The 24h purge in recover_stale_printing_jobs (print.rs:4430-4437) deletes only print_jobs rows, never the files; the only remove_dir_all calls for RECEIPTS_DIR are in tests (print.rs:6793, 6839). Nothing in production code ever deletes or rotates {app_data_dir}/receipts/.

**Fix.** Add an age-based sweep of the receipts directory to the existing 24h purge path (delete files older than N days, keeping the output_path of still-referenced jobs), or delete the artifact when its job row is purged.

### P2-22 — Printer test, verification, and cash-drawer IPC commands run blocking hardware I/O directly on the Tokio runtime

> ✅ verified (single skeptic) · Printing · `pos-tauri/src-tauri/src/commands/print.rs:2895`

printers.rs:1378-1384 documents that print_raw_to_tcp is blocking (connect_timeout 3s, 5s write timeouts, thread::sleep per chunk) and that 'Async callers SHOULD wrap this call in spawn_blocking'. The worker loop and payment/kitchen paths were fixed (Wave 2 C12, commit 81a111aaa), but several async #[tauri::command] handlers still call the blocking dispatch inline: printer_test (commands/print.rs:2895), printer_test_draft via run_verification_dispatch (2709), printer_test_greek_direct (3147), and printer_open_cash_drawer -> drawer::open_cash_drawer which does TcpStream::connect_timeout (commands/print.rs:3335, drawer.rs:106). build_sample_bytes (2663) can additionally trigger the up-to-8s…

**Fix.** Wrap the print_raw_for_target / open_cash_drawer calls in these commands with tokio::task::spawn_blocking, mirroring the pattern already used in start_print_worker and spawn_pending_job_processing.

### P2-23 — Fiscal submission results (MARK/UID/validation QR) never reach the printed receipt

> ✅ verified (single skeptic) · Printing · `pos-tauri/src-tauri/src/receipt_renderer.rs:448`

The pos-tauri fiscal module (fiscal/dispatcher.rs, fiscal/payload_builder.rs) builds and dispatches fiscal receipt submissions, but there is no linkage from any fiscal result back into the print pipeline: grep shows zero 'fiscal' references in print.rs/receipt_renderer.rs (only the unrelated 'Bureau fiscal'/'Ufficio fiscale' labels) and zero 'print/mark/qr' references in fiscal/dispatcher.rs. ReceiptDocument/LayoutConfig have no fiscal identifier fields; the only QR on a receipt is a statically configured marketing URL read from local_settings receipt.qr_url (print.rs:1311-1313, receipt_renderer.rs:447-448). There is also no re-print/append path once a submission completes.

**Fix.** Extend ReceiptDocument with optional fiscal fields (mark/uid/validation URL), have the fiscal dispatcher persist the returned identifiers per order, populate them in build_order_receipt_doc when present (still skipping silently when absent), and render them as footer text + QR — keeping print fully non-blocking on fiscal state.

### P2-24 — Edit-settlement refunds cannot span multiple payments; the multi-payment fallback modal is unreachable dead code, blocking legitimate order edits

> ✅ verified (single skeptic) · Checkout (UI) · `pos-tauri/src/renderer/components/OrderDashboard.tsx:4444`

handleEditSettlementDeltaConfirm's refund path only accepts a single payment whose remainingRefundable covers the whole delta (line 4444-4446: `filter((p) => Number(p.remainingRefundable || 0) >= amount - 0.005)`). If an order was split-paid and the edit's refund delta exceeds every individual payment's remaining balance, it toasts 'No completed payment with enough remaining balance to refund against' and throws — the order edit is never applied and cannot be saved through any path. The designed fallback, EditOrderRefundSettlementModal (rendered at line 7047), can never open: `setPendingEditRefundSettlement` is only ever invoked with null (lines 4272, 4340, 4391) anywhere in the renderer.…

**Fix.** Allow the refund action to allocate the delta across multiple completed payments (greedy over remainingRefundable, mirroring the shape applyEditSettlement already accepts as a refunds[] array), or re-wire the pendingEditRefundSettlement fallback for the multi-payment case; give the thrown error a translated message.

### P2-25 — Split payment drift check ignores order cancellation, so payment can be collected against an order cancelled on another terminal

> ✅ verified (single skeptic) · Checkout (UI) · `pos-tauri/src/renderer/components/modals/SplitPaymentModal.tsx:214`

hasLiveSplitStateDrift (lines 214-228) compares only totalAmount, outstanding, paid amounts, and paid item indices; fetchLatestSplitState (lines 144-161) never reads the order's status/cancelled flag. OrderDetailsModal gates opening the split modal on !isCancelledOrder (OrderDetailsModal.tsx:940), but that is checked once at open. If the order is cancelled from another terminal (or the dashboard) while the split modal is open, the pre-payment drift check passes (totals and payments are unchanged by cancellation) and the payment is recorded. The Rust side does not backstop this: record_payment_in_connection (pos-tauri/src-tauri/src/payments.rs:861-893) only rejects ghost orders and…

**Fix.** Include order status in the SplitStateSnapshot and treat cancelled/canceled as drift (abort with a clear message); additionally add a cancelled-order rejection in record_payment_in_connection mirroring the edit-payment-method guard.

### P2-26 — Synthetic 'Balance Adjustment' line can reuse an already-paid item's itemIndex, mis-attributing paid-item records

> ✅ verified (single skeptic) · Checkout (UI) · `pos-tauri/src/renderer/components/modals/SplitPaymentModal.tsx:173`

When persisted outstanding diverges from the unpaid items' sum (order-level discount, delivery fee, or prior by-amount payments), availableItems appends a synthetic adjustment line whose itemIndex is computed as max over UNPAID items + 1 (line 173). That index can equal a real item's index that is already in paidItemIndices (e.g., items 0,1,2 with item 2 paid by-items: max unpaid = 1, synthetic gets index 2). Paying the portion containing the synthetic line records payment item rows for that index (recordPortionPayment line 313 `items: ... itemIndex: Number(item.itemIndex ?? 0)`; appendCompletedPayment lines 287-289), so bridge.payments.getPaidItems now returns two payment-item rows for…

**Fix.** Derive the synthetic index from the maximum across ALL normalized items plus paid indices (or use a reserved sentinel such as -1/omit itemIndex for synthetic lines and skip them when building payment items).

### P2-27 — Pending post-login intent restores a view with no module re-check, mounting gated views and firing their data hooks

> ✅ verified (single skeptic) · Module gating (UI) · `pos-tauri/src/renderer/components/RefactoredMainLayout.tsx:318`

handleViewChange validates module access before saving a pending view intent to sessionStorage (lines 266-277), but the consume path does NOT re-validate: the useEffect at lines 300-319 calls setCurrentView(pendingView) directly. The intent has no expiry check (createdAt is stored at line 162 but never read in consumePendingPostLoginIntent, lines 166-180) and survives logout (handleLogout does not clear it, and no page reload occurs). Because the fail-closed route-guard is itself a useEffect (lines 233-244) that runs after commit, the gated view fully mounts and its passive effects run first (React flushes child effects before parent effects): e.g. RoomsView fires useRooms({enableRealtime:…

**Fix.** In the consume effect, run the same fail-closed check before applying: `if (isViewAccessDenied(enabledModules, pendingView)) { setBlockedModule(...); setShowUpgradePrompt(true); return; }` and add enabledModules to the effect deps; optionally honor createdAt with a short TTL and clear the key on logout.

### P2-28 — isViewAccessDenied fails open when the enabled-module list is empty, disabling both route-guard sites at once

> ✅ verified (single skeptic) · Module gating (UI) · `pos-tauri/src/renderer/utils/module-view-access.ts:71`

The single predicate both guard sites use (RefactoredMainLayout lines 237 and 266) returns 'allowed' for EVERY view whenever enabledModules.length === 0. The comment frames this as an offline-bootstrap tradeoff, but enabledModules is genuinely [] from ModuleProvider mount until loadFromCache/resolveModules completes (module-context.tsx line 276 initial state; the localStorage cache has a 15-minute TTL at line 104, so it is expired on any morning start), and resolveModules involves multiple IPC round-trips. During that window, any programmatic navigation — the pos:recovery-route -> pos:navigate-view('orders') dispatch in App.tsx lines 907-925, or the unchecked pending-intent path — lands on…

**Fix.** Make the empty-list case fail closed for non-core views (deny with a distinguishable 'module state loading' reason so the caller can show a spinner instead of the upgrade modal), or gate on an explicit hydration flag from ModuleContext (isLoading) rather than inferring 'not hydrated' from emptiness.

### P2-29 — Renderer falls back to a direct Supabase UPDATE on retail_products with no organization_id filter — violates API-first writes and org-scoped-write guardrails

> ✅ verified (3-verifier adversarial panel) · Offline / sync (UI) · `pos-tauri/src/renderer/services/ProductCatalogService.ts:728`

updateQuantity() (line 333) falls back to `updateQuantityViaSupabase()` whenever the Admin API PATCH fails and `canUseSupabaseFallback()` is true (browser runtime + Supabase configured, lines 217-219, 340-346). That fallback issues a raw anon-key UPDATE on the `retail_products` domain table from the renderer, filtered only by `.eq('id', productId)` — no `.eq('organization_id', ...)` even though `this.organizationId` is available and every read in the same file applies it (e.g. lines 638, 682, 705). This breaks two explicit guardrails at once: POS writes must be API-first through terminal-authenticated paths, and every org-scoped write must filter by organization_id. Correct scoping is left…

**Fix.** Delete updateQuantityViaSupabase and make browser mode fail closed (surface the API error / queue for retry), or at minimum add `.eq('organization_id', this.organizationId)` (and the branch filter) to the UPDATE and gate it behind an explicit dev-only flag.

### P2-30 — Out-of-zone delivery override is auto-approved client-side — the 'manager approval required' denial branch is unreachable

> ✅ verified (single skeptic) · Offline / sync (UI) · `pos-tauri/src/shared/services/DeliveryValidationService.ts:126`

DeliveryValidationService.requestOverride() unconditionally returns `{ success: true, approved: true, message: 'Override recorded locally' }` (lines 141-146); the only rejection is the custom-fee cap. Nothing checks staff role, manager PIN, or a server-side approval, despite the service being configured with `requireManagerApprovalForOverrides: true` (DeliveryZoneValidator.ts:69) and the UI advertising `requiresManagerApproval: true`. DeliveryZoneValidator.requestOverride() hardcodes `staffRole: 'staff'` and `customerConsent: true` (lines 211-212) and only sends the override to the bridge as ANALYTICS tracking (lines 222-230). Consequently OrderDashboard's pickup→delivery conversion guard…

**Fix.** Route override approval through a privileged-action confirmation (the existing usePrivilegedActionConfirmation manager-PIN flow) or a terminal-authenticated admin endpoint that validates the requesting staff's role; make requestOverride return approved:false when requireManagerApprovalForOverrides is true and no approval credential is presented.

### P2-31 — MenuService browser-fallback menu reads hit Supabase without organization_id filters

> ✅ verified (single skeptic) · Offline / sync (UI) · `pos-tauri/src/renderer/services/MenuService.ts:909`

Every Supabase fallback in MenuService is correctly gated to browser runtime by canUseSupabaseFallback() (lines 352-366), but none of the queries is org-scoped: getMenuItems `from('subcategories').select('*').eq('is_available', true)` (lines 909-912), getMenuCategories `from('menu_categories').select('*').eq('is_active', true)` (485-488), getIngredientCategories (559-563), getIngredients (660+), getMenuItemById by bare id (974-977), getMenuItemIngredients (1099+), checkIngredientAvailability by bare id (1171-1174), and getMenuCombos (1353+). This is the live menu the POS sells from when running in the browser runtime the code explicitly supports (the same runtime OrderService uses for its…

**Fix.** Thread the organizationId (already available via terminal-credentials/secure session) into MenuService and add `.eq('organization_id', ...)` to all eight fallback queries, mirroring the H30 fix in useRealTimeMenuSync.

### P2-32 — Multi-shift Z-report per-order-type sales omit the refund subtraction the single-shift path applies

> ✅ verified (single skeptic) · Shifts & Z-report · `pos-tauri/src-tauri/src/zreport.rs:3728`

The single-shift generate_z_report order-type breakdown subtracts per-order refund adjustments from each type's total, with a Wave 2b comment explaining that summing orders.total_amount alone 'overstates delivery/takeaway/dine-in revenue whenever refunds are recorded against an order but leave the order in a non-cancelled status' (zreport.rs:2728-2755). The multi-shift build_z_report_for_date order-type query (zreport.rs:3726-3736) sums total_amount only, with no refund LEFT JOIN — the fix was never ported. The multi-shift path is the one persisted and submitted at day close.

**Fix.** Port the Wave 2b refund-subtraction subquery from the single-shift order-type query (zreport.rs:2740-2751) into order_type_scope_sql at 3726, using the same window predicates.

### P2-33 — Orders written between Z-report aggregation and rollover-cutoff capture are deleted but never reported in any Z period

> ✅ verified (single skeptic) · Shifts & Z-report · `pos-tauri/src-tauri/src/zreport.rs:4341`

When no pending Z context exists (the common same-day close), resolve_effective_z_report_window returns cutoff_at=None (zreport.rs:406-414), so build_z_report_for_date aggregates with an unbounded upper window while holding the conn mutex, then releases it when the function returns (3387-3998). prepare_z_report_submission only afterwards captures rollover_timestamp = Utc::now() (zreport.rs:4341-4344). The DB mutex is released and re-acquired several times in between (persist at 4023-4221, timestamp capture). Any order/payment inserted by a concurrent producer (kiosk listener, delivery-platform ingest thread) in that gap has financial timestamp <= rollover_timestamp, so finalize deletes it…

**Fix.** Capture the effective cutoff timestamp BEFORE running build_z_report_for_date's aggregation and pass it as the window's cutoff_at (bounding all aggregate queries), so aggregation, persisted report, and rollover deletion share one cutoff.

### P2-34 — Payment/adjustment/z-report/loyalty failure paths burn retry budget on backpressure and retry hot with no backoff — money rows dead-letter after ~5 cycles

> ✅ verified (single skeptic) · Sync core · `pos-tauri/src-tauri/src/sync.rs:15658`

mark_batch_failed (sync.rs:16493-16545, used for orders/shifts/financials) implements the intended policy: HTTP 429/backpressure defers WITHOUT incrementing retry_count and schedules next_retry_at with exponential delay. The four per-item dispatchers do neither: sync_payment_items (15658-15673), sync_adjustment_items (15979-15994), sync_z_report_items (16142-16168) and sync_loyalty_items (16223-16238) all run 'retry_count + 1; if >= max_retries then failed else pending' on ANY error — including 429s and 5xx — and never set next_retry_at, so the row is re-eligible on the very next loop tick (claim filter sync.rs:12146-12149). With sync_queue.max_retries defaulting to 5 (db.rs:617), a…

**Fix.** Route the failure branches of all four dispatchers through mark_batch_failed (or replicate its backpressure carve-out and schedule_next_retry exponential backoff), keeping the entity-specific local-state mirror updates.

### P2-35 — reconcile_remote_payments/orders advance the since-cursor past records that failed to apply locally — remote records silently dropped forever

> ✅ verified (single skeptic) · Sync core · `pos-tauri/src-tauri/src/sync.rs:10087`

In reconcile_remote_payments the page cursor high-water mark is advanced from EVERY fetched payment's updated_at (sync.rs:10087-10094) BEFORE sync_remote_payment_into_local is attempted (10096); if the local mirror write fails, the error is only logged (10100-10110) and the cursor still moves past that payment (10114-10129, forward-only). Since the endpoint is queried with since=<cursor>, the failed payment is never fetched again unless it changes remotely. reconcile_remote_orders has the same shape: a failed materialize_remote_order is warn-and-continue (9685-9692), and the cursor advances past it via other orders' timestamps or the sync_timestamp fallback (10002-10017) — if every order in…

**Fix.** Only advance the cursor past records that applied successfully (track max updated_at of successes, stop the page at the first failure), or count failures and refuse to advance past the earliest failed record for N attempts before consciously skipping with a persistent, surfaced error.

### P2-36 — Sync cycle aborts on pull (reconcile) errors before any push runs — a broken GET endpoint starves all order/payment pushes

> ✅ verified (single skeptic) · Sync core · `pos-tauri/src-tauri/src/sync.rs:11830`

run_sync_cycle chains all pull/reconcile steps with `?` before claiming and pushing queue items: poll_order_receipt_statuses (11827), reconcile_remote_orders (11830), reconcile_remote_payments (11835), recover_payment_total_conflicts (11838), auto_heal_waiting_adjustments (11842-11846). reconcile_remote_orders returns Err for any non-backpressure HTTP failure (9555-9567). A persistent server-side failure on GET /api/pos/orders/sync (route bug, cursor value triggering a 500) therefore makes every cycle return Err at the pull stage, and the push half (claim_pending_sync_items at 11852 onward) never executes even though the POST endpoints are healthy — queued orders/payments/z-reports stall…

**Fix.** Degrade instead of abort: on non-backpressure reconcile errors, log and continue to the push phase (carrying the error into the cycle result), so pull-side outages cannot starve outbound order/payment sync.

### P2-37 — Direct order POST silently drops invalid items but still sends the original order total — permanent total-mismatch failure or short-shipped remote order

> ✅ verified (single skeptic) · Sync core · `pos-tauri/src-tauri/src/sync.rs:13351`

sync_order_batch_via_direct_api drops any order item that has neither a UUID menu_item_id nor a non-empty name (sync.rs:13351-13359, warn-only) and only fails the row when ALL items were dropped (13383-13394). When some items survive, the POST body still carries the payload's original totals — "total_amount": num_any(&data, ["total_amount"]).unwrap_or(0.0) at 13452 plus subtotal/tax — which now disagree with the items actually sent. Server-side total validation errors are classified permanent (is_permanent_order_sync_error matches 'total mismatch'/'order totals do not match', 5634-5635), so the order deterministically exhausts its retry budget via mark_order_item_retry_or_fail and then…

**Fix.** If any item is dropped, either fail the row as permanent immediately (consistent with the all-dropped branch) with a distinct operator-visible error, or recompute total_amount/subtotal/tax from the surviving items before POSTing; never send totals that don't match the submitted items.

### P2-38 — Monetary items dead-lettered via 4xx or prepare-failure never emit the sync:dead-letter:monetary operator alarm

> ✅ verified (single skeptic) · Offline queue · `pos-tauri/src-tauri/src/sync_queue.rs:6337`

The Wave 4H alarm contract (commands/sync_queue.rs:116-123: 'emit an operator-visible alarm for every monetary dead-letter in this batch ... without it, a dead-lettered payment is effectively invisible outside the logs') only fires when mark_failure itself exhausts retries: mark_failure returns Some(MonetaryDeadLetter) exclusively in its `new_attempts >= MAX_RETRY_ATTEMPTS` branch (sync_queue.rs:3559-3576). But the two paths that dead-letter items IMMEDIATELY — the 4xx client-error branch (6337-6349) and the RequestPreparation::Failed branch (6116-6127) — call mark_failure while attempts are still below 10 (so it takes the schedule-retry branch and returns None) and then force `SET status =…

**Fix.** In both immediate-dead-letter branches, build and push the MonetaryDeadLetter (when is_monetary_module) after forcing status='failed', or add a mark_failure_permanent() helper that always returns the dead-letter payload; also emit events for result.monetary_dead_letters in the commands/recovery.rs process_queue call sites.

### P2-39 — retry_item can flip an in-flight 'processing' row back to 'pending' without bumping claim_generation, enabling duplicate submission

> ✅ verified (single skeptic) · Offline queue · `pos-tauri/src-tauri/src/sync_queue.rs:3360`

sync_queue::retry_item resets status='pending', attempts=0, next_retry_at=NULL with no status filter and no claim_generation bump. Every comparable path is stricter: retry_items_by_module filters `status IN ('pending','failed','conflict')` (3391), and the recovery repair helpers that requeue rows explicitly bump claim_generation (commands/recovery.rs:327, 389) so a stale in-flight worker's ack is neutralized. retry_item is invoked from the renderer (sync_queue_retry_item, commands/sync_queue.rs:78-81) and the Recovery Center retryParityItem action (commands/recovery.rs:1122-1126) — the actionable-items list it operates on includes 'processing' rows (list_actionable_items, 3286). If an…

**Fix.** Add `AND status IN ('pending','failed','conflict')` to retry_item's WHERE clause and bump claim_generation in the same UPDATE, matching the retry_items_by_module and recovery-repair patterns.

### P2-40 — Recovery export bundle embeds the raw snapshot DB containing the plaintext terminal API key

> ✅ verified (single skeptic) · Offline queue · `pos-tauri/src-tauri/src/recovery.rs:1369`

write_export_bundle zips the entire snapshot.db into the support-bound export (recovery.rs:1369-1378, reachable from recovery_export_current/recovery_export_point). The snapshot is a full VACUUM INTO copy of pos.db, which includes the local_settings table where the terminal's pos_api_key, terminal_id, admin URL, and supabase keys live in plaintext — and the sync command layer actively re-writes the decoded API key into that plaintext table on every credential resolution (commands/sync_queue.rs:142-150: `crate::db::set_setting(&conn, "terminal", "pos_api_key", decoded_api_key.trim())`), so keyring-only installs still end up with the secret in the DB. Export zips are explicitly designed to…

**Fix.** Before zipping, open the staged snapshot and DELETE the credential rows from local_settings (pos_api_key, api_key, supabase_anon_key, etc.) or redact them to placeholders; stop re-writing the decoded API key into local_settings in resolve_sync_queue_credentials — the keyring write on the line above already covers persistence.

---

## P3 — test, contract, and maintainability gaps

| ID | ✓ | Area | Finding | Where | Why it matters |
|---|---|---|---|---|---|
| P3-01 | ✅ | Auth & identity | In-memory session map grows unbounded: prior session is never evicted on re-login | `pos-tauri/src-tauri/src/auth.rs:884` | Slow unbounded memory growth over the uptime of a terminal; orphaned sessions (with staffId/role/permissions) linger in process memory longer than intended. |
| P3-02 | ✅ | Auth & identity | Lock-ordering invariant comment in login() is factually wrong — a second lockout call site already exists | `pos-tauri/src-tauri/src/auth.rs:939` | Stale concurrency invariant increases the risk that a future edit reintroduces a lock-order deadlock in the auth/lockout path. |
| P3-03 | ✅ | Config & updater | CSP connect-src/img-src wildcard `https://*.supabase.co` allows exfiltration to any attacker-registered Supabase project | `pos-tauri/src-tauri/tauri.conf.json:28` | Defense-in-depth failure: a single renderer XSS escalates to silent bulk exfiltration of org-scoped POS data from every terminal, because the exfil endpoint domain is attacker-provisionable within the |
| P3-04 | ✅ | Config & updater | Five @tauri-apps/plugin-* JS packages are shipped as dependencies but their Rust plugins are never registered | `pos-tauri/package.json:30` | A developer who imports e.g. |
| P3-05 | ✅ | DB & reset | database_get_stats reports pendingSync from the retired legacy sync_queue, hiding the real parity_sync_queue backlog | `pos-tauri/src-tauri/src/commands/diagnostics.rs:294` | Diagnostics/health surfaces show 0 pending sync items during a genuine backlog, misleading operators and support into believing a terminal is safe to reset/clear when unsynced sales exist. |
| P3-06 | ✅ | DB & reset | Self-wrapped migrations v28/v34/v36 stamp schema_version OUTSIDE their transaction, contradicting the harness's atomicity claim | `pos-tauri/src-tauri/src/db.rs:2882` | Small crash window can leave half-applied migrations that re-execute destructive rebuilds on the next boot; the misleading harness comment invites future authors to repeat the stamp-outside-transactio |
| P3-07 | ✅ | DB & reset | Offline-store schema doc and in-code comments are stale: doc says v61 (code is v68), and code claims sync_queue was dropped in v56 when no migration drops it | `pos-tauri/docs/offline-store-schema-and-migrations.md:32` | Engineers following the stated intent will assume the legacy queue is gone and skip it in reset/repair/audit tooling, and will miss v62-v68 fiscal/tenant columns when reasoning about replay payloads a |
| P3-08 | ✅ | Deps & contracts | Duplicated Order type in pos-tauri/src/shared/types/orders.ts drifted from canonical shared/types/orders.ts (unions disagree both ways, all W4d *_cents wire fields missing) | `pos-tauri/src/shared/types/orders.ts:4` | Type checking cannot catch status/type handling gaps for values that legitimately cross the sync boundary, forcing the cast-heavy patterns already visible in useOrderStore; the missing cents fields hi |
| P3-09 | ✅ | Deps & contracts | ~35 registered Tauri commands have no renderer caller, including raw serial-port write access and a parallel legacy Z-report stack | `pos-tauri/src-tauri/src/lib.rs:990` | Dead-but-registered commands are unaudited attack surface for a compromised webview — `serial_write` allows writing arbitrary bytes to any serial device (ECR terminals, scales, cash-drawer lines) via  |
| P3-10 | ✅ | Deps & contracts | payments.updatePaymentStatus TS surface permits statuses the Rust command rejects by design ('processing'/'completed') | `pos-tauri/src-tauri/src/commands/payments.rs:77` | A future caller passing the type-valid 'completed' (the natural choice after a successful capture) gets a runtime IPC error and the payment status silently fails to persist (useOrderStore catches, log |
| P3-11 | ✅ | Error handling | Panic in a Tauri command never surfaces to the frontend: async commands (all order/payment/sync/shift flows) hang the invoke forever; the 11 sync commands panic on the main thread and kill the app | `pos-tauri/src-tauri/src/panic_hook.rs:28` | If any future or missed panic fires inside an async payment/order command after DB writes but before responding, the operator sees an infinite spinner with no error and cannot tell whether the payment |
| P3-12 | ✅ | Module gating (UI) | Module entitlements are trusted from tamper-writable plaintext caches, including a renderer-exposed IPC that writes the Rust-side cache unvalidated | `pos-tauri/src-tauri/src/commands/modules.rs:458` | Anyone with local access to the terminal (devtools, or editing the WebView profile / app data on disk) can grant the POS UI persistent access to unpurchased module views (rooms, delivery, appointments |
| P3-13 | ✅ | Module gating (UI) | Module cache identity check is skipped when current identity is not yet hydrated, honoring a previous terminal/org's module set after re-provisioning | `pos-tauri/src/renderer/contexts/module-context.tsx:619` | When a terminal is re-onboarded to another organization or its pos_terminal_settings.enabled_modules is tightened and the app restarts within the 15-minute TTL, the POS shows and allows opening the PR |
| P3-14 | ✅ | Offline / sync (UI) | BranchMenuFilterService queries menu_categories/subcategories/ingredients with no organization_id (or any tenant) filter and caches results+prices in localStorage | `pos-tauri/src/services/BranchMenuFilterService.ts:139` | If wired up (or if the tables' RLS permits broad anon reads, which is common for menu data), the POS pulls every tenant's entire menu, ingredient list, and prices into a plaintext localStorage cache a |
| P3-15 | ✅ | Offline / sync (UI) | Legacy shared Supabase sync helpers (syncSettingsEx/syncMenuItemsEx/syncDeliveryZonesEx) query tenant tables completely unscoped; pos_configurations uses .single() | `pos-tauri/src/shared/supabase.ts:182` | Dormant guardrail violations documented as the recommended API: the first future caller inherits a cross-tenant read (or a guaranteed PGRST116 crash from .single() once a second org row exists). |
| P3-16 | ✅ | Shifts & Z-report | Residual float money math on REAL columns in shift summary and cash-breakdown paths | `pos-tauri/src-tauri/src/shifts.rs:1611` | These paths bypass the integer-cents invariant: rows whose REAL and _cents siblings ever diverge (pre-backfill rows, partial writes) are read from the stale REAL side, and f64 accumulation re-enters t |
| P3-17 | ✅ | Test gaps | 47 of 143 TS test files never execute anywhere because run-parity-tests.mjs is a hard-coded allowlist — including module-gating and fiscal-entitlement guardrail tests | `pos-tauri/scripts/run-parity-tests.mjs:14` | Regressions in module gating (a project guardrail), fiscal-entitlement fail-closed behavior, split-payment UI money display, and refund-settlement flows are invisible: the tests exist, look like cover |
| P3-18 | ✅ | Test gaps | Checkout double-submit dedup guard (client_request_id) in create_order has no test | `pos-tauri/src-tauri/src/sync.rs:1238` | If field extraction or the SELECT breaks, a cashier double-tap or a frontend retry after a slow IPC response creates two orders (and with the standard pay-after-create flow, two charges/kitchen ticket |
| P3-19 | ✅ | Test gaps | No automated parity gate for the order queue itself: G1 (offline order restart persistence) and G2 (order sync exactly-once) remain manual-only while payments/refunds/z-reports got automated gates | `pos-tauri/PARITY_GATES.md:24` | A schema migration or dispatcher change that drops or double-sends pending order rows across a process restart (the exact class g8/g13/g14 exist to catch for other domains) would pass CI; the only det |

---

## Refuted and dropped

Six findings were reported by a reviewer but did not survive adversarial verification. They are recorded here so they are not re-investigated:

- **Replay-conflict auto-resolve deletes the queue row without running apply_success, orphaning local sync state and child payments** (`pos-tauri/src-tauri/src/sync_queue.rs`) — The cited code is real — sync_queue.rs:6286-6290 does call mark_success() without apply_success(), unlike the 2xx path at 6184-6187, and is_replay_conflict_response() does return true unconditionally for status 409 (line 5901). But the finding's concrete failure scenario (lost-ack order INSERT -> 409 duplicate -> row consumed -> order permanently unsynced -> payments park as conflicts) breaks at t
- **replay.rs and dispatcher::submit_for_order are dead code; the real fiscal replay path retries terminal 422 failures with backoff, contradicting the documented outcome semantics** (`pos-tauri/src-tauri/src/fiscal/replay.rs`) — The dead-code half is accurate (replay_fiscal_row and submit_for_order have no production callers; fiscal rows flow through enqueue_for_order → parity_sync_queue → generic driver via sync_queue.rs:3939/6533), but the finding's load-bearing behavioral claim and its entire impact statement are contradicted by the code. The generic driver does NOT retry terminal 422 failures with backoff: in process_
- **Pre-reset recovery snapshot omits sync_queue, so database_reset loses unsynced financial queue items it claims to protect** (`pos-tauri/src-tauri/src/recovery.rs`) — The finding's core claim — that the pre-reset recovery snapshot cannot restore deleted sync_queue rows because sync_queue is absent from POINT_TABLES — is factually wrong about how the recovery system works. The snapshot is created by vacuum_into_snapshot (recovery.rs:777-789) using SQLite `VACUUM INTO`, which copies the ENTIRE database file — all tables including sync_queue and its rows. Restore 
- **Fiscal active-cache lock uses panic-on-poison expect inside order-receipt, fiscal-dispatch, and close-day paths, violating the fiscal-must-never-crash guardrail** (`pos-tauri/src-tauri/src/fiscal/active_cache.rs`) — The cited expect exists (active_cache.rs:57-63) and the callers (sync.rs:1156, dispatcher.rs:79/217, close_day_guard.rs:51) and the survives-panics premise (no panic="abort" in release profile; panic_hook.rs only logs, never aborts) all check out. However, the finding's core mechanism — mutex poisoning — is unreachable with the code as written. fn state() is private and the MutexGuard never escape
- **Terminal-runtime emit signature lock uses panic-on-poison expect in the settings/config sync path** (`pos-tauri/src-tauri/src/commands/settings.rs`) — The cited .expect exists (settings.rs:461), but the claimed failure is unreachable. LAST_TERMINAL_RUNTIME_EMIT_SIGNATURE is locked at exactly one site in the crate (should_emit_terminal_runtime_update, lines 460-466), and the critical section contains only: a serde_json::Value PartialEq comparison on a fixed flat ~15-key signature object, a move-assign that drops the old Option<Value>, and the gua
- **Fiscal-optionality guarantee at the order_create seam and the entire fiscal dispatcher/replay path have zero tests** (`pos-tauri/src-tauri/src/commands/orders.rs`) — The finding's central factual claims are contradicted by the code. (1) It claims "no test today inserts a fiscal row through enqueue_for_order against the real schema (sync_queue::create_tables)" — but D:\The-Small-002\pos-tauri\src-tauri\tests\fiscal_dispatcher_test.rs (289 lines, wired to the crate via [lib] name the_small_pos_lib, so it runs under `cargo test`) does exactly that: fresh_db() at 

## Deliberately out of scope

Reviewers were told to skip these; they are already tracked elsewhere and are not re-reported above:

- Orders/shifts terminal-isolation leak across terminals on one branch (diagnosed separately).
- ~70 tests that fail only under a full `cargo test` run because of keyring/`SERVICE_NAME` global pollution.
- `RUST_MIN_STACK` needed to compile `src-tauri` on rustc 1.93.1.
- Per-transaction `PRAGMA synchronous=FULL`, descoped after benchmarking showed +47.8% P99.
- Retirement of the legacy `sync_queue` dispatcher (192+ references in `sync.rs`), a known multi-session effort.

## Method

Seventeen reviewers, one per subsystem: sync core, offline queue, money/payments, shifts & Z-report, auth & identity, fiscal, the Tauri IPC command surface, DB & reset, printing, hardware/ECR, module gating, checkout UI, offline UI, config & updater, error handling, test coverage, and dependency/contract drift. Each was given the project guardrails (org-scoping, fiscal-is-optional, API-first writes, keyring-only secrets, integer cents) and a severity rubric, and was required to cite file and line.

Every finding then went to adversarial verifiers prompted to **refute by default** — three verifiers with distinct lenses (does the code do this? is it handled elsewhere? is it reachable in production?) for P0/P1, one for P2/P3 — with a majority needed to survive, and each verifier free to re-grade severity. The full pass ran 182 agents over ~23M subagent tokens; it exhausted the account's monthly spend limit three times and was resumed from cache each time (run `wf_a50903be-45a`) until every verifier completed on the fourth pass. Six findings were refuted; the panel also re-graded 13 severities (one P1→P0 escalation, one P3→P1, several P2↔P1 and P2↔P3 moves).
