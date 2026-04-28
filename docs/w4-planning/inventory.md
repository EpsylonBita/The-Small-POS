# W4 b–e — Monetary Touchpoint Inventory

> **Status snapshot:** 2026-04-26, branch `pos-tauri/w4-planning-docs`. Schema head = **v57** (W11 staff_shifts index). Highest W4a-shadow migration = **v54**. `Cents` newtype shipped in W0 ([money.rs](../../src-tauri/src/money.rs)). 12 production `MONEY_EPSILON` comparison sites remain; all collapse in 4e.

## Reading guide

This file is the source of truth for the **4b / 4c / 4d / 4e** sub-sessions. Every entry is tagged with its target sub-session(s). Cross-session entries (e.g. a struct that crosses the wire) carry both tags.

Tags:

- **`READ-RUST`** — Rust read path: `SELECT real_col` site or struct field read. → 4b
- **`WRITE-RUST`** — Rust write path: `INSERT/UPDATE … real_col` site, or struct field that becomes input to a write. → 4c
- **`STRUCT`** — `pub struct { … : f64 }`. Touched by both 4b (read) and 4c (write); the field type changes once (4b lands first). → 4b primary, 4c secondary
- **`SIG`** — function signature with `f64` money parameter or return. → 4b primary, 4c secondary
- **`WIRE-OUT`** — `serde_json::json!` emission to admin API or sync queue payload. → 4d
- **`WIRE-IN`** — Rust deserialization of an admin response or queue payload money field. → 4d (and 4b for the SQL write that follows)
- **`EPSILON`** — `MONEY_EPSILON` comparison. → removed in 4e (replaced by exact integer ops in 4b/4c)
- **`ADMIN-IN`** — admin-dashboard route receives money field. → 4d
- **`ADMIN-OUT`** — admin-dashboard route emits money field. → 4d
- **`SQL-MIGRATION`** — schema column to drop. → 4e
- **`ALREADY-CENTS`** — site already on integer cents (no work needed; document for completeness)

The **80% rule** applies — entries below cover the load-bearing surface. The long tail (display-only formatting in receipt rendering, ECR session printing, customer-display polish, diagnostic dumps) is named at the file/module level and listed under "Long tail — discover during sub-session pre-flight" at the end. The relevant sub-session's pre-flight step explicitly re-greps its own scope before editing.

---

## Pre-existing infrastructure (no work)

| Item | Location | Status |
|---|---|---|
| `Cents(i64)` newtype with `From<f64>`, `round_half_even`, `round_half_up`, `to_f64_dp2`, arithmetic ops, `Sum`, serde-as-integer | [money.rs:53-197](../../src-tauri/src/money.rs) | **W0 shipped.** Use as substrate; do not redefine. |
| `MONEY_EPSILON: f64 = 0.005` | [money.rs:40](../../src-tauri/src/money.rs) | Live; **removed in 4e** (after every consumer is on cents). |
| Migration v51 cents columns: `orders` (6), `order_payments` (3), `payment_adjustments` (1) | [db.rs:3397-3442](../../src-tauri/src/db.rs) | **W4a shipped.** No backfill triggers — Rust does dual-write in 4c. |
| Migration v53 cents columns: `staff_shifts` (8), `cash_drawer_sessions` (12), `z_reports` (13) | [db.rs:3569-3633](../../src-tauri/src/db.rs) | **W4a shipped.** No triggers. |
| Migration v54 cents columns: `order_payments.discount_amount`, `payment_items.item_amount`, `driver_earnings` (6), `shift_expenses.amount` | [db.rs:3664-3707](../../src-tauri/src/db.rs) | **W4a shipped.** No triggers. |
| ECR amount-to-cents conversion (8 sites) | [commands/ecr.rs:1584,1599,1634,1670,1737,1751,1777,1804](../../src-tauri/src/commands/ecr.rs) | **`ALREADY-CENTS`** — uses `(amount * 100.0).round() as i64`. Optional cleanup: route through `Cents::round_half_up` for receipt-style rounding semantics. Not blocking for 4d. |
| Partial 4d JSON-emission edits (9 sites) | [planning/claude/wave-4d-payload-builder-edits.md](../../../planning/claude/wave-4d-payload-builder-edits.md) | **Replay doc** from a prior aborted 4d pass — captures `payments::build_payment_sync_payload_for_payment`, `refunds::build_adjustment_queue_payload`, 4 `shifts::build_*` builders, 2 `sync::sync_*` POST bodies. **Apply as-is during 4d**, then extend per inventory below. |

### Total cents columns to drop in 4e: **52**

(Not 66 as the original plan estimated. The plan over-counted three tables that turn out never to be created in production migrations: `daily_z_reports`, `staff_payments`, `transaction_log`. v54 docstring at [db.rs:3635-3658](../../src-tauri/src/db.rs) explains the exclusion.)

---

## File-level f64 totals (2026-04-26)

| File | f64 count | Plan estimate | Notes |
|---|---:|---:|---|
| [zreport.rs](../../src-tauri/src/zreport.rs) | 196 | 190 | Biggest surface. Most are aggregation locals (intermediate sums); not all 196 cross a struct or wire boundary. |
| [shifts.rs](../../src-tauri/src/shifts.rs) | 176 | (not listed) | **Plan undercounted.** Includes drawer-snapshot loaders + close-shift aggregations. |
| [sync.rs](../../src-tauri/src/sync.rs) | 69 | 68 | Of these ~20 are monetary (POST body assembly + comparison helpers); the rest are non-money (latency, ratios). |
| [commands/orders.rs](../../src-tauri/src/commands/orders.rs) | 66 | (not listed) | **Plan missed.** Order creation/update sync emission. |
| [sync_queue.rs](../../src-tauri/src/sync_queue.rs) | 45 | (not listed) | **Plan missed.** 65 `json!` macros, 30+ monetary keys (`tipAmount`, `totalAmount`, `amount`). 4d-replay doc explicitly lists this as deferred. |
| [payments.rs](../../src-tauri/src/payments.rs) | 44 | 43 | |
| [commands/analytics.rs](../../src-tauri/src/commands/analytics.rs) | 35 | (commands/) | Read-only analytics dump; output-only money. |
| [refunds.rs](../../src-tauri/src/refunds.rs) | 21 | 20 | |
| [commands/shifts.rs](../../src-tauri/src/commands/shifts.rs) | 13 | (commands/) | Thin wrapper; mostly delegates to `shifts.rs`. |
| [commands/payments.rs](../../src-tauri/src/commands/payments.rs) | 0 | (some) | **Plan stale** — already free of f64s after W6 cleanup. |
| [commands/zreports.rs](../../src-tauri/src/commands/zreports.rs) | 0 | (some) | **Plan stale.** |
| [payment_integrity.rs](../../src-tauri/src/payment_integrity.rs) | (struct: 4) | n/a | `UnsettledPaymentBlocker` + `RawBlockerRow` carry `total_amount: f64` + `settled_amount: f64`; struct also serializes to admin (camelCase). |

**f64 grand total in monetary surface:** ~700 occurrences. Cap explicit enumeration in this doc at the load-bearing emission/SQL/struct sites; let each sub-session re-grep its own slice during pre-flight.

---

## payments.rs

[payments.rs](../../src-tauri/src/payments.rs)

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| ~14-30 | Struct | `STRUCT` 4b/4c | `PaymentRecordInput` carries `amount: f64`, `cash_received: Option<f64>`, `change_given: Option<f64>`, `discount_amount: f64`. |
| 381 | Function | `SIG` 4b/4c/`WIRE-IN` 4d | `pub(crate) fn build_payment_record_input(payload: &Value)` — parses incoming JSON. 4d adds `amount_cents` deserialization fallback. |
| ~430-490 | SQL writes | `WRITE-RUST` 4c | `record_payment` INSERT INTO `order_payments` (writes `amount`, `cash_received`, `change_given`, `discount_amount` and their `_cents` siblings — dual-write). |
| 495 | Local | `READ-RUST` 4b | `let order_total: f64 = conn.query_row("SELECT total_amount …")` — switches to `total_amount_cents` + `Cents`. |
| 541-545 | Comparison | `EPSILON` → 4e | Overpayment check `input.amount > snapshot.outstanding_amount + MONEY_EPSILON`. After 4b/4c both sides are `Cents`; collapses to `>`. |
| 614-629 | SQL + state | `WRITE-RUST` 4c, `EPSILON` → 4e | `recompute_order_payment_state` reads SUM of payments, compares against `order_total`. Uses MONEY_EPSILON twice (line 625, 627). |
| 1085-1088 | Comparison | `EPSILON` → 4e | `outstanding_amount <= MONEY_EPSILON` early-return. |
| 1165 | Function | `WIRE-OUT` 4d | `pub(crate) fn build_payment_sync_payload_for_payment` — sync payload emission. **Already covered by 4d-replay doc §1c.** |
| 3316, 3406, 3415 | Test | (test only) | Test fixtures asserting MONEY_EPSILON boundary semantics. Update to integer-exact assertions in 4b. |

## refunds.rs

[refunds.rs](../../src-tauri/src/refunds.rs)

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 19 | Import | n/a | Already imports `Cents` (from prior partial 4d pass). |
| 170 | Function | `WIRE-OUT` 4d | `fn build_adjustment_queue_payload` — sync queue payload. **Already covered by 4d-replay doc §2b.** |
| 249 | Function | `WIRE-OUT` 4d | `pub(crate) fn build_adjustment_sync_payload_for_adjustment` — sibling of build_adjustment_queue_payload. Verify both go through the same `Cents` boundary. |
| ~307-340 | SQL reads | `READ-RUST` 4b | Refund issuing reads `amount`, `total_refunds`, `original_amount` from `order_payments` and `payment_adjustments`. |
| 413 | Comparison | `EPSILON` → 4e | `if amount > remaining + MONEY_EPSILON` — overrefund guard. |
| 436 | Comparison | `EPSILON` → 4e | `(new_total_refunds - original_amount).abs() < MONEY_EPSILON` — fully-refunded predicate. |
| ~670-730 | SQL writes | `WRITE-RUST` 4c | `record_refund` INSERT INTO `payment_adjustments` + UPDATE `order_payments` (refund accumulator). Dual-write. |
| 708, 775 | Comparison | `EPSILON` → 4e | `prior_refunds > MONEY_EPSILON` (twice). |
| 793-800 | SQL writes | `WRITE-RUST` 4c | Cash-sales reversal in `cash_drawer_sessions.total_cash_sales`. |
| 947-956 | Function | `READ-RUST` 4b | `get_payment_balance` voided branch — recently fixed in W10 to compute actual `total_refunds` ([commit e3f293b3](../..)); the f64 path stays until 4b. |

## zreport.rs

[zreport.rs](../../src-tauri/src/zreport.rs)

The largest surface. Internal aggregations (cash_sales, card_sales, gross/net, tips, discounts, refunds, voids) at ~50 sites; only the emission and reader boundaries are listed here.

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 495, 2739, 2748, 2792, 2801, 3118, 3211, 3291, … | Local + SQL | `READ-RUST` 4b | `let cashier_cash_sales: f64 = conn.query_row(…)` family — converts to `let cashier_cash_sales_cents: Cents = conn.query_row(…)?` reading the `_cents` column. **~50 such sites**; sub-session re-greps. |
| 1134 | Formula | `WRITE-RUST` 4c | `cashToReturn` formula in `build_staff_cash_breakdown_row` — recently W10-fixed to deduct cash refunds ([commit c8cda575](../..)); keep `Cents` math here in 4c. |
| 2201, 3171, 3723, 3735, 4099 | SIG | `SIG` 4b/4c | Top-level `pub fn generate_z_report / build_z_report_for_date / preview_z_report_for_date / generate_z_report_for_date / submit_z_report` — `Value` in/out, internal arithmetic on f64. |
| 2646 | Formula | (W6 done) | Z-report `net_sales` formula — proof-comment landed in W6/W10. Keep math equivalent under integer arithmetic. |
| 2771, 3665 | Inline JSON | `WIRE-OUT` 4d | `serde_json::json!({"cashDrawer": …})` — drawer snapshot embedded in z-report `Value`. Money keys here are emitted as floats today. Convert to `_cents` integer keys in 4d. |
| ~3171-3720 | Internal | `READ-RUST`+`WRITE-RUST` 4b/4c | `build_z_report_for_date` reads from `z_reports`, `staff_shifts`, `cash_drawer_sessions`, `payment_adjustments`, aggregates, writes back to `z_reports`. Switch all SELECTs to `_cents` columns and all UPDATE/INSERT to write the `_cents` columns (dual-write in 4c). |
| ~4099-4250 | Submit | `WIRE-OUT` 4d | `submit_z_report` POSTs to `/api/pos/z-report/submit` — body shape is the entire z-report Value. Money keys cross the wire. |

**Pre-flight required for 4d:** re-grep `serde_json::json!` in zreport.rs to enumerate every emission site; the wave-4d-replay doc explicitly noted "~4 emission sites + ~10 internal JSON sites" still pending. Treat zreport.rs as the highest-risk file in 4d.

## sync.rs

[sync.rs](../../src-tauri/src/sync.rs)

Of 69 f64 occurrences, only the monetary subset matters (~20 sites).

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 1442 | Helper | `WIRE-IN` 4d | `number_field_from_sources(&sources, &["total_amount", "totalAmount", "total"])` — read from queue payload. Add `_cents` keys to source list. |
| 1565 | Helper | `WIRE-IN` 4d | Same pattern for `tip_amount` / `tipAmount`. |
| 1661, 3035, 3315, 3340, 3440 | Helper | `WIRE-IN` 4d | `payload.get("amount").and_then(Value::as_f64)` — generalize to integer-first: try `amount_cents` (`as_i64`) before falling back to `amount` (`as_f64` → `Cents::round_half_even`). |
| 3236, 3242 | Constants | `WIRE-IN` 4d | Camel↔snake key alias table. Add `(_cents, _cents)` entries: `("totalAmount", "total_amount")` becomes part of a sister `MONEY_KEY_PAIRS` table that handles cents siblings. |
| 3328 | JSON | `WIRE-OUT` 4d | `"amount": amount` body emission. Becomes `"amount_cents": amount_cents`. |
| 6038 | Function | `WIRE-OUT` 4d | `fn rewrite_adjustment_sync_payload_payment_id` — payload rewrite path. Verify it preserves `_cents` keys after rewrite. |
| 11115 | Function | `WIRE-OUT` 4d | `fn build_shift_requeue_payload`. |
| 11935 | Comment | (note) | Existing comment about `MONEY_EPSILON` in payment-equality dedup. |
| 11957 | Comparison | `EPSILON` → 4e | `(l - r).abs() < crate::money::MONEY_EPSILON` — payment dedup. After 4b/4c both sides are `Cents`; collapses to `==`. |
| 12500-12600 | Logic | `READ-RUST` 4b | Adjustment-sync flow reads `order_payments.amount` for parent-payment classification. Switch to `_cents`. |

**Pre-flight required for 4d:** the W5/W6/W8/W10/W11 work shifted line numbers materially; treat all line numbers above as approximate. Re-grep before editing.

## shifts.rs

[shifts.rs](../../src-tauri/src/shifts.rs) (176 f64s — the second-largest surface)

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 158-169 | Function | `WRITE-RUST` 4c | `open_shift` reads `opening_cash` and writes `staff_shifts` row. Both columns dual-write in 4c. |
| ~200-280 | SQL writes | `WRITE-RUST` 4c | Multiple `INSERT INTO staff_shifts` and `INSERT INTO cash_drawer_sessions` sites. Audit carefully — ~10 distinct paths (open, transfer, close, force-close, expense-decision). |
| 419 | Function | `WIRE-OUT` 4d | `fn build_shift_open_sync_payload`. **Already covered by 4d-replay doc §3b.** |
| ~600-1000 | SQL reads + UPDATE | `READ-RUST` 4b + `WRITE-RUST` 4c | Shift close-out: aggregate `total_cash_sales`, `total_card_sales` from completed orders, write to `staff_shifts` + `cash_drawer_sessions`. |
| 2419 | Function | `WIRE-OUT` 4d | `fn build_shift_update_sync_payload_from_db`. **Already covered by 4d-replay doc §3d.** |
| 2574 | Function | `WIRE-OUT` 4d | `fn build_staff_payment_sync_payload`. **Already covered by 4d-replay doc §3e.** |
| ~2900-3100 | Function | `WIRE-OUT` 4d | `fn load_cash_drawer_snapshot_for_shift` — embedded in z-report payloads. **Already covered by 4d-replay doc §3c.** |

## sync_queue.rs

[sync_queue.rs](../../src-tauri/src/sync_queue.rs)

The 4d-replay doc explicitly listed this as deferred. 65 `json!` macros, 30+ monetary keys.

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| ~start of file | Module | (note) | `parity_sync_queue` is canonical post-W5; legacy `sync_queue` payload assembly may live here. Verify which queue's payloads are being built before editing. |
| All `json!` sites carrying `tipAmount`, `totalAmount`, `amount`, `subtotal`, `tax`, `discount` | Inline JSON | `WIRE-OUT` 4d | Convert money keys to `*_cents` integer form. Helper-extract a `monetary_value(field, json)` that prefers `_cents` over the float sibling. |
| Order-body assembly (per the wave-4d-replay deferred list) | Inline JSON | `WIRE-OUT` 4d | Order-creation payload includes line items + totals. Audit `payment_items` line-item amounts and order totals together. |

## commands/orders.rs

[commands/orders.rs](../../src-tauri/src/commands/orders.rs) (66 f64s, plan missed this file)

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 465 | Function | `WIRE-OUT` 4d | `fn enqueue_order_sync_payload` — order-creation sync emission. New surface for 4d. |
| Various | SIG + locals | `SIG` 4b, `WRITE-RUST` 4c | Order-create / update / discount commands receive money fields from renderer over IPC. The Tauri command wrapper deserializes `Value` → typed struct; switch to `Cents` on the typed side, accept either `amount` or `amount_cents` from renderer for transition (renderer is TypeScript, lives in `pos-tauri/src/`; do NOT touch in this Rust-only sub-session — flag as renderer follow-up). |

## commands/analytics.rs and commands/shifts.rs

Both are thin command wrappers (35 + 13 f64s). Mostly read-only `Value` formatting. Touch in 4b alongside `zreport.rs` and `shifts.rs` reads. No new wire emission unique to commands/.

## payment_integrity.rs

[payment_integrity.rs](../../src-tauri/src/payment_integrity.rs)

| Line(s) | Kind | Tag | What |
|---|---|---|---|
| 6 | Import | n/a | Imports MONEY_EPSILON. Removed in 4e. |
| 12-22 | Struct | `STRUCT` 4b/4c | `pub struct UnsettledPaymentBlocker { total_amount: f64, settled_amount: f64, … }`. Serializes to admin via `Serialize` derive (camelCase). 4d cross-impact: the JSON shape changes when fields become `Cents`. |
| 24-34 | Struct | `STRUCT` 4b | `RawBlockerRow` — internal, populated by `query_map`. Switch to `Cents` once SELECT switches to `_cents` columns. |
| 60-62 | Helper | (display) | `fn format_money(amount: f64) -> String { format!("EUR {:.2}", …) }` — keep as `f64` display path, accept `Cents` and call `.to_f64_dp2()`. |
| 91, 98, 116 | Comparison | `EPSILON` → 4e | Three `MONEY_EPSILON` sites in `classify_blocker_row`. Collapse to integer comparison after 4b. |
| 209-244 | SQL | `READ-RUST` 4b | `order_blocker_row_select()` — `SELECT o.total_amount, … SUM(op.amount)` subquery. Switch column references to `_cents` siblings; the SUM stays correct because `_cents` columns store `INTEGER`. |

---

## admin-dashboard wire-format consumers

`/api/pos` routes that ingest pos-tauri-originated monetary payloads or emit money to pos-tauri.

| Route | File | Direction | Money keys |
|---|---|---|---|
| `/api/pos/payments` | [payments/route.ts](../../../admin-dashboard/src/app/api/pos/payments/route.ts) | `ADMIN-IN` 4d | Zod schema (lines 36, 38, 43, 47): `item_amount`, `amount`, `tip_amount`. Comparison at line 383 uses `+ 0.01` epsilon — remove (integer-exact). |
| `/api/pos/payments/adjustments/sync` | [payments/adjustments/sync/route.ts](../../../admin-dashboard/src/app/api/pos/payments/adjustments/sync/route.ts) | `ADMIN-IN` 4d | Adjustment payload (refund/void). |
| `/api/pos/financial/sync` | [financial/sync/route.ts](../../../admin-dashboard/src/app/api/pos/financial/sync/route.ts) | `ADMIN-IN` 4d | Omnibus dispatcher. Lines 578, 593-595, 679-680, 779-780 read `tipAmount`/`tip_amount`, `cashCollected`/`cash_collected`, `cardAmount`/`card_amount`, `cashToReturn`/`cash_to_return`, `amount`. Camel↔snake aliasing already in place — extend with `_cents` aliases. |
| `/api/pos/loyalty/earn` | [loyalty/earn/route.ts](../../../admin-dashboard/src/app/api/pos/loyalty/earn/route.ts) | `ADMIN-IN` 4d | Line 18: `amount: z.number().positive()`. Line 86 `Math.floor(amount * pointsPerEuro)` — switch to `Math.floor(amount_cents * pointsPerEuro / 100)`. |
| `/api/pos/loyalty/redeem` | [loyalty/redeem/route.ts](../../../admin-dashboard/src/app/api/pos/loyalty/redeem/route.ts) | `ADMIN-IN` 4d | Likely mirror of earn — confirm during 4d pre-flight. |
| `/api/pos/loyalty/transactions` | [loyalty/transactions/route.ts](../../../admin-dashboard/src/app/api/pos/loyalty/transactions/route.ts) | `ADMIN-IN/OUT` 4d | List endpoint — emits historical money. |
| `/api/pos/shifts` | [shifts/route.ts](../../../admin-dashboard/src/app/api/pos/shifts/route.ts) | `ADMIN-IN/OUT` 4d | Line 17 SELECT carries `cash_variance`, `closing_cash_amount`, `expected_cash_amount`, `opening_cash_amount`, `payment_amount`, `total_card_sales`, `total_cash_sales`, `total_sales_amount`. |
| `/api/pos/shifts/sync` | [shifts/sync/route.ts](../../../admin-dashboard/src/app/api/pos/shifts/sync/route.ts) | `ADMIN-IN` 4d | Shift-state sync ingest. |
| `/api/pos/shifts/force-close` | [shifts/force-close/route.ts](../../../admin-dashboard/src/app/api/pos/shifts/force-close/route.ts) | `ADMIN-IN` 4d | Force-close payload includes reconciliation money. |
| `/api/pos/cash-drawer-sessions` | [cash-drawer-sessions/route.ts](../../../admin-dashboard/src/app/api/pos/cash-drawer-sessions/route.ts) | `ADMIN-OUT` 4d | Line 75 SELECT carries 12 money columns. |
| `/api/pos/cash-drawer-sessions/reconcile` | [cash-drawer-sessions/reconcile/route.ts](../../../admin-dashboard/src/app/api/pos/cash-drawer-sessions/reconcile/route.ts) | `ADMIN-IN` 4d | Reconciliation delta payload. |
| `/api/pos/orders` | [orders/route.ts](../../../admin-dashboard/src/app/api/pos/orders/route.ts) | `ADMIN-OUT` 4d | Order list — emits totals. |
| `/api/pos/orders/sync` | [orders/sync/route.ts](../../../admin-dashboard/src/app/api/pos/orders/sync/route.ts) | `ADMIN-IN` 4d | Order-creation ingest from pos-tauri. |
| `/api/pos/orders/sync/status` | [orders/sync/status/route.ts](../../../admin-dashboard/src/app/api/pos/orders/sync/status/route.ts) | `ADMIN-OUT` 4d | Status echo. |
| `/api/pos/sync/[tableName]` | [sync/[tableName]/route.ts](../../../admin-dashboard/src/app/api/pos/sync/[tableName]/route.ts) | `ADMIN-IN` 4d | **Generic table sync — most important.** Z-report submit, daily z-report submit, and any unmapped entity routes through here. The dispatcher's column-allowlist needs `_cents` siblings. |
| `/api/pos/sync/[tableName]/[recordId]` | [sync/[tableName]/[recordId]/route.ts](../../../admin-dashboard/src/app/api/pos/sync/[tableName]/[recordId]/route.ts) | `ADMIN-IN` 4d | Single-record update via generic sync. Same dispatcher pattern. |
| `/api/pos/shift-expenses` | [shift-expenses/route.ts](../../../admin-dashboard/src/app/api/pos/shift-expenses/route.ts) | `ADMIN-IN/OUT` 4d | Shift-expense ingest + listing. Money key `amount`. |
| `/api/pos/shift-expenses/decision` | [shift-expenses/decision/route.ts](../../../admin-dashboard/src/app/api/pos/shift-expenses/decision/route.ts) | `ADMIN-IN` 4d | Approval/rejection of pending expense. |
| `/api/pos/z-report/submit` | (verify path during 4d pre-flight; route directory is `z-report/submit`) | `ADMIN-IN` 4d | Z-report submission — large body, all money keys. |
| `/api/pos/z-report/[reportId]` | (verify) | `ADMIN-OUT` 4d | Single z-report fetch. |
| `/api/pos/z-report/history` | (verify) | `ADMIN-OUT` 4d | Z-report list. |
| `/api/pos/z-reports/compare` | [z-reports/compare/route.ts](../../../admin-dashboard/src/app/api/pos/z-reports/compare/route.ts) | `ADMIN-OUT` 4d | Diff endpoint — emits delta money. |
| `/api/pos/daily-z-reports` | [daily-z-reports/route.ts](../../../admin-dashboard/src/app/api/pos/daily-z-reports/route.ts) | `ADMIN-IN/OUT` 4d | Aggregated daily z-report. |

### admin-dashboard non-route consumers

These ingest pos-tauri money via Supabase replication after the route lands the row. NOT direct wire consumers, but **must be re-checked after 4e** drops the REAL columns:

- Any admin-dashboard analytics page that queries `orders.total_amount`, `staff_shifts.total_cash_sales`, `z_reports.gross_sales`, etc. directly via Supabase.
- Reports / financial dashboards. Search admin-dashboard for `.from('orders').select('total_amount')` and similar — list as 4e pre-flight item.

---

## Non-pos-tauri consumers (verified)

| Surface | Status | Notes |
|---|---|---|
| `POSSystemMobile/` | **Not a wire consumer.** | Grep for `/api/pos/(payments\|financial\|z-reports\|loyalty\|shifts\|cash-drawer)` returned 0 files. Mobile is supabase-direct per `MEMORY.md`. After 4e drops REAL columns, any mobile screen that queries `orders.total_amount` directly via Supabase will break — flag as a 4e pre-flight item to grep mobile too. |
| `pos-system/` (legacy Electron) | **Retired 2026-04-23** per `feedback_electron_pos_untouched.md`. | Confirmed by user as the basis for the W4d "no dual-shape, single coordinated cutover" decision. |
| `Landing/` | Not a money consumer. | Marketing site only. |
| Background jobs (cron, queues) | **Verify during 4e pre-flight.** | Search `admin-dashboard/src/app/api/cron/` and `admin-dashboard/src/lib/jobs/` for SELECTs against the dropping columns. |

---

## Long tail — discover during sub-session pre-flight

These surfaces are NOT enumerated above because they are display-only or low-velocity, but each sub-session's pre-flight step should re-grep its own scope:

- **4b pre-flight**: re-grep `let .*: f64 = conn.query_row` and `let .*: f64 = conn.prepare` in [payments.rs](../../src-tauri/src/payments.rs), [refunds.rs](../../src-tauri/src/refunds.rs), [shifts.rs](../../src-tauri/src/shifts.rs), [zreport.rs](../../src-tauri/src/zreport.rs), [sync.rs](../../src-tauri/src/sync.rs), [commands/analytics.rs](../../src-tauri/src/commands/analytics.rs), [commands/shifts.rs](../../src-tauri/src/commands/shifts.rs), [commands/orders.rs](../../src-tauri/src/commands/orders.rs).
- **4c pre-flight**: re-grep `INSERT INTO orders \|INSERT INTO order_payments \|INSERT INTO staff_shifts \|INSERT INTO cash_drawer_sessions \|INSERT INTO z_reports \|INSERT INTO payment_adjustments \|INSERT INTO payment_items \|INSERT INTO driver_earnings \|INSERT INTO shift_expenses \|UPDATE orders \|UPDATE order_payments \|UPDATE staff_shifts \|UPDATE cash_drawer_sessions \|UPDATE z_reports` across all of `pos-tauri/src-tauri/src/`. Tag each as dual-write target.
- **4d pre-flight**: re-grep `serde_json::json!` in [zreport.rs](../../src-tauri/src/zreport.rs), [sync_queue.rs](../../src-tauri/src/sync_queue.rs), [sync.rs](../../src-tauri/src/sync.rs), [commands/orders.rs](../../src-tauri/src/commands/orders.rs); cross-reference against the wave-4d-replay doc to see which are already documented.
- **4e pre-flight**: grep all of `admin-dashboard/src/` and `POSSystemMobile/` for `.select(.*total_amount\|tax_amount\|subtotal\|discount_amount\|tip_amount\|delivery_fee\|cash_received\|change_given\|opening_cash\|closing_cash\|expected_cash\|cash_variance\|gross_sales\|net_sales\|cash_sales\|card_sales\|refunds_total\|voids_total\|tips_total\|discounts_total\|expenses_total\|total_refunds\|total_expenses\|cash_drops\|driver_cash\|opening_amount\|closing_amount\|expected_amount\|variance_amount\|item_amount\|total_earning\|cash_collected\|card_amount\|cash_to_return)` — any consumer reading the REAL column will break after 4e. The strict mitigation: bake in staging for one week before 4e ships.

---

## Open questions surfaced during inventory

These are **not** blockers for the planning deliverables, but each sub-session should resolve as part of pre-flight:

1. **Migration v51 says "first slice" — but v51/v53/v54 all shipped.** The plan's reference to a single "v52 cents migration" is stale. **Resolved here:** 4a is fully done across v51 + v53 + v54. 4e's drop-column migration is **v58** (next available, since v57 is the staff_shifts index).
2. **No backfill triggers exist.** The plan's "trigger-backed dual-write" assumption was wrong; v51/v53/v54 docstrings explicitly say "Dual-write is Rust's job in 4b/4c." This rewires the dependency graph (see [dependencies.md](dependencies.md)).
3. **The 4d-replay doc covers 9 sites but explicitly defers ~30+ more** (zreport.rs emissions, sync_queue.rs order body, admin-dashboard renames, parity-contract fixtures, Supabase migration). 4d's effective scope is the union of (replay doc) + (deferred list) + (sync.rs payload paths flagged here).
4. **`payment_method` was dropped in v55** (W6) — already removed from struct fields and SQL paths in the existing code. Not a 4-series concern; only flagged so 4b/4c authors don't re-add references.
5. **ECR sites already use cents** but with raw `(amount * 100.0).round() as i64` instead of `Cents::round_half_up`. Optional polish during 4d for receipt-rounding semantics; not blocking.
