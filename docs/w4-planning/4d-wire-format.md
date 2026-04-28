# Sub-session 4d — Wire format cutover (single coordinated release)

> **Self-contained session prompt.** Drop into a fresh Claude Code session.

## Context

You are continuing the 11-wave remediation of `pos-tauri` (Rust/Tauri POS at `D:\The-Small-002\pos-tauri`). The remaining work is **Wave 4 b–e**, the money migration. This session is **4d — switch every JSON wire payload from float `amount` to integer `amount_cents`**, in a single coordinated release across pos-tauri AND admin-dashboard.

**Why single coordinated PR:** Electron POS was retired 2026-04-23 (per `~/.claude/projects/D--The-Small-002/memory/feedback_electron_pos_untouched.md`). pos-tauri is the only consumer of `/api/pos/**` admin routes. There is no compat window concern — change both sides in lockstep.

**Sequencing:** 4d ships AFTER 4b (read path on cents) and 4c (write path dual-write). See [dependencies.md](dependencies.md) for the full order rationale. The internal Rust math is already on `Cents` after 4b; this session changes only what crosses the wire.

Background already in place:

- **W0**: `Cents(i64)` newtype in [pos-tauri/src-tauri/src/money.rs](../../src-tauri/src/money.rs). Serde encodes `Cents` as a JSON integer automatically.
- **W4a**: shadow `*_cents` columns; W4c: dual-write; W4b: read path on cents.
- **W6**: `orders.payment_method` dropped (v55).

A **partial 4d pass already shipped 9 specific edits**, captured in [planning/claude/wave-4d-payload-builder-edits.md](../../../planning/claude/wave-4d-payload-builder-edits.md). That replay doc is the starting point. The deferred-list at the bottom of the replay doc enumerates what's still pending.

The full inventory is at [inventory.md](inventory.md). The original plan is at `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md` (Wave 4 section).

## Pre-flight (do before any code changes)

1. **Verify 4b and 4c are both on the integration branch.** Search recent commits for `W4b` and `W4c` markers, or for the merge commits named in the project memory entries `project_w4b_landed.md` and `project_w4c_landed.md`. If either is missing, **STOP**.
2. **Read the 4d-replay doc end-to-end**: [planning/claude/wave-4d-payload-builder-edits.md](../../../planning/claude/wave-4d-payload-builder-edits.md). Apply the 9 edits as a starting commit. They may need minor adjustment if 4b already converted the underlying field to `Cents` (in which case `Cents::round_half_even(amount).as_i64()` simplifies to `amount.as_i64()`).
3. **Re-grep** Rust JSON-emission sites:
   ```bash
   rg -nE 'serde_json::json!|json!\(' pos-tauri/src-tauri/src/ | rg -iE 'amount|cash|tip|refund|sales|cents'
   ```
   Cross-reference against the 9 sites in the replay doc and the `WIRE-OUT` entries in [inventory.md](inventory.md). Build a complete list before editing.
4. **Re-grep** admin-dashboard `/api/pos` routes for monetary Zod schemas + Supabase column references:
   ```bash
   rg -nE '(amount|cents|tip|cash|sales|refund).*z\.number\(\)' admin-dashboard/src/app/api/pos/
   rg -nE '\.select\(.*(total_amount|cash_received|tip_amount|opening_cash|closing_cash|gross_sales|net_sales)' admin-dashboard/src/app/api/pos/
   ```
   Cross-reference against the `ADMIN-IN`/`ADMIN-OUT` entries in [inventory.md](inventory.md).
5. **Locate the parity-contract fixtures** (likely under `pos-tauri/tests/renderer/` and/or `pos-tauri/scripts/run-parity-tests.mjs`). Money-bearing fixtures need re-stamping from float to integer-cents shape.
6. **Verify the z-report submit path.** During inventory I noted `/api/pos/z-report/submit/` exists as a directory but did not confirm `route.ts` inside it. `ls admin-dashboard/src/app/api/pos/z-report/submit/` and resolve.

## Scope

This is a multi-surface PR. Group into commits by surface so review can proceed in passes.

### Surface 1 — pos-tauri Rust JSON emissions

Apply the 9 edits from the replay doc verbatim. They cover:

- [payments.rs](../../src-tauri/src/payments.rs):
  - `load_payment_items_for_payment` — `itemAmount` → `item_amount_cents`
  - `build_payment_sync_payload_for_payment` — `amount`, `cashReceived`, `changeGiven`, `discountAmount` → `*_cents`
- [refunds.rs](../../src-tauri/src/refunds.rs):
  - `build_adjustment_queue_payload` — `amount` → `amount_cents`
- [shifts.rs](../../src-tauri/src/shifts.rs):
  - `build_shift_open_sync_payload` — `openingCash`, `borrowedStartingAmount` → `*_cents`
  - `load_cash_drawer_snapshot_for_shift` — 12 money fields → `*_cents`
  - `build_shift_update_sync_payload_from_db` — 8 money fields → `*_cents`
  - `build_staff_payment_sync_payload` — `amount` → `amount_cents`
- [sync.rs](../../src-tauri/src/sync.rs):
  - `sync_payment_items` POST body — `amount`, `tip_amount` → `*_cents` (plus a legacy-compat reader the replay doc spells out)
  - `sync_loyalty_transaction` (earn branch) — `amount` → `amount_cents`

Then extend to the **deferred sites** the replay doc explicitly listed:

- [zreport.rs](../../src-tauri/src/zreport.rs): ~4 outbound emission sites + ~10 internal JSON sites where money keys cross the wire. Re-grep `serde_json::json!` in this file. The submit z-report path POSTs the entire z-report `Value` — every money key in that body changes.
- [sync_queue.rs](../../src-tauri/src/sync_queue.rs): order-body assembly — `tipAmount`, `totalAmount`, line-item `amount` keys. Helper-extract a `monetary_value(field, &mut json)` that writes `*_cents` consistently.
- [commands/orders.rs](../../src-tauri/src/commands/orders.rs): `enqueue_order_sync_payload` (line ~465). Order-creation sync emission.
- [sync.rs](../../src-tauri/src/sync.rs): `rewrite_adjustment_sync_payload_payment_id` (~6038), `build_shift_requeue_payload` (~11115). Verify these preserve `*_cents` keys after rewrite.

**Convention** (from the replay doc, keep):

- Money keys: `snake_case_with_cents_suffix` (matches SQLite/Supabase column names: `amount_cents`, `tip_amount_cents`, `opening_cash_cents`).
- Non-money keys: keep existing `camelCase` (identifiers like `paymentId`, `orderId`, `transactionRef`).
- The wire ends up mixed-case **by design**.

**Legacy-compat reader pattern** (from the replay doc):

For any Rust site that READS money out of a queued payload, prefer the integer key and fall back to the float key for any pre-cutover queued row that still carries the legacy shape:

```rust
let amount_cents = data
    .get("amount_cents")
    .and_then(Value::as_i64)
    .or_else(|| {
        data.get("amount")
            .and_then(Value::as_f64)
            .map(|v| Cents::round_half_even(v).as_i64())
    })
    .unwrap_or(0);
```

This handles any sync_queue row that was enqueued by pre-4d code and is still pending dispatch when 4d ships. Keep these compat readers until 4e (which removes them).

### Surface 2 — admin-dashboard route schemas

For every monetary Zod schema in `admin-dashboard/src/app/api/pos/**/route.ts`:

- Replace `amount: z.number().nonnegative()` with a transitional schema that accepts EITHER:
  ```ts
  // Transitional during 4d/4e bake. Removed in 4e.
  const amountField = z.union([
    z.object({ amount_cents: z.number().int().nonnegative() }),
    z.object({ amount: z.number().nonnegative() }),
  ]);
  ```
  OR a flatter pattern: accept both keys at the top of the schema, with refine-validation requiring exactly one and normalizing into a single `amount_cents` integer for downstream code.
- The downstream Supabase write must populate the `*_cents` Supabase column (which presupposes a Supabase migration; see Surface 3).
- Remove fragile epsilon comparisons like `+ 0.01` at [payments/route.ts:383](../../../admin-dashboard/src/app/api/pos/payments/route.ts) — integer math is exact.
- For the **financial/sync omnibus** ([financial/sync/route.ts](../../../admin-dashboard/src/app/api/pos/financial/sync/route.ts)): the `getNumber(item.payload, ['tipAmount', 'tip_amount'])` helper at lines 578, 593-595, 679-680, 779-780 already does camel↔snake aliasing. Add `*_cents` aliases at the head of each lookup so the integer form is preferred. Convert at the dispatcher boundary so downstream Supabase writes always go through cents.

The full list of routes to touch (per [inventory.md](inventory.md) wire-format consumers section):

- `/api/pos/payments`
- `/api/pos/payments/adjustments/sync`
- `/api/pos/financial/sync`
- `/api/pos/loyalty/earn`
- `/api/pos/loyalty/redeem`
- `/api/pos/loyalty/transactions`
- `/api/pos/shifts`
- `/api/pos/shifts/sync`
- `/api/pos/shifts/force-close`
- `/api/pos/cash-drawer-sessions`
- `/api/pos/cash-drawer-sessions/reconcile`
- `/api/pos/orders`
- `/api/pos/orders/sync`
- `/api/pos/orders/sync/status`
- `/api/pos/sync/[tableName]` (generic dispatcher — the column-allowlist needs `_cents` siblings)
- `/api/pos/sync/[tableName]/[recordId]`
- `/api/pos/shift-expenses`
- `/api/pos/shift-expenses/decision`
- `/api/pos/z-report/submit`
- `/api/pos/z-report/[reportId]`
- `/api/pos/z-report/history`
- `/api/pos/z-reports/compare`
- `/api/pos/daily-z-reports`

### Surface 3 — Supabase `*_cents` columns

The admin-dashboard routes write to Supabase. Supabase tables also need the `*_cents` columns (52 of them, mirroring the pos-tauri SQLite shape). Add a migration under `supabase/migrations/` that:

- Adds `*_cents BIGINT` columns to every table currently carrying REAL money. Use `BIGINT` (Postgres `bigint`) — equivalent to SQLite's `INTEGER` for our magnitudes.
- Backfills existing Supabase rows: `UPDATE orders SET total_amount_cents = ROUND(total_amount * 100)::BIGINT` etc.
- Does NOT drop the REAL columns (4e does that, with a Supabase migration of its own).

**Caution on RLS**: per `.claude/rules/supabase-database.md`, never disable or weaken RLS. Adding columns is RLS-neutral; backfill UPDATE is service-role-only.

### Surface 4 — Parity-contract fixtures and shared TS types

The pos-tauri renderer and admin-dashboard share contract-fixture files (likely under `pos-tauri/tests/renderer/` and `shared/` or similar). Money fields in those fixtures need re-stamping from `12.34` (float) to `1234` (integer cents).

Shared TypeScript types:

- Search `shared/src/` and `pos-tauri/src/lib/` for type declarations carrying `amount: number` (where it represents money). Add `amount_cents: number` siblings; mark old fields `@deprecated — use _cents in new code; removed in W4e`.
- Renderer code that reads from IPC bridge stays untouched in this PR — IPC payloads are still `Value` and the renderer reads whatever shape Rust emits. Only the parity-fixtures change here.

### Surface 5 — Update existing tests and run parity gates

- Re-stamp money assertions in Rust tests: payment fixtures, shift fixtures, refund fixtures, loyalty fixtures (all live in `tests/` or `#[cfg(test)] mod tests` blocks within each source file).
- Re-stamp admin-dashboard route tests under `admin-dashboard/tests/` and `admin-dashboard/src/app/api/pos/**/__tests__/` (where present).
- `npm run test:desktop-parity` (the parity-contract test runner) should pass.
- Parity gates G7/G8/G13/G14 (W7) should still pass — they exercise the offline+restart+exactly-once paths that ride the wire.

## Out of scope

- Dropping the legacy REAL Supabase or SQLite columns. **4e does that.**
- Removing the legacy-compat readers in Rust (`get("amount").and_then(as_f64)` fallback). **4e does that** after a one-week bake catches any forgotten queue row.
- Removing `MONEY_EPSILON`. **4e does that.**
- Switching the renderer (TypeScript) to typed `Cents` — the renderer already operates on `Value`; add type-side updates only to the parity-contract files.

## Acceptance gates

```bash
# pos-tauri Rust
cd D:/The-Small-002/pos-tauri/src-tauri
cargo fmt --check
cargo clippy --lib --all-targets -- -D warnings
cargo test --lib
cargo test --tests

# pos-tauri renderer
cd D:/The-Small-002/pos-tauri
npm run typecheck   # or pnpm --filter pos-tauri typecheck
npm run test:desktop-parity

# admin-dashboard
cd D:/The-Small-002/admin-dashboard
npm run typecheck
npm run lint
npm run test
```

All green. Manual end-to-end:

1. Start pos-tauri dev build. Take a payment of €12.34, refund €5.00, void remainder. Open admin-dashboard, verify the order shows €12.34 / €5.00 / €0.00 exactly.
2. Close a shift with €1234.56 cash. Verify the z-report on admin-dashboard reads €1234.56 (not €1234.55 or €1234.57).
3. Inspect the network requests during shift close — body should carry `*_cents` integer fields, not float `amount`.

## Branch strategy

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git pull --rebase
git checkout -b pos-tauri/w4d-wire-format-cutover
```

This PR spans **two repos' surface areas**: pos-tauri and admin-dashboard. Both happen in the same Git repo (monorepo) so it's one branch. Group commits as:

1. Apply 4d-replay doc edits (9 sites)
2. Extend to deferred Rust emission sites (zreport, sync_queue, commands/orders)
3. Add legacy-compat readers in Rust
4. Supabase migration + backfill
5. admin-dashboard route schemas + downstream Supabase writes
6. Parity-contract fixtures + shared types
7. Test re-stamping

After merge, locally merge back. **Bake one week** in staging before scheduling 4e.

## Scope-split forks (stop and split rather than grind)

1. **The diff exceeds 1500 lines.** Split:
   - 4d-i: Surfaces 1 + 2 + 3 (Rust + admin-dashboard schemas + Supabase migration). Wire is on cents end-to-end after this lands.
   - 4d-ii: Surfaces 4 + 5 (parity fixtures, shared TS, test re-stamping). Cleanup pass.
   - 4d-i must land first; 4d-ii can ship within hours of 4d-i since it's mechanical re-stamping.
2. **A wire consumer is found that the inventory didn't anticipate** (e.g., a background cron job, an analytics view, a third-party webhook). Surface as a memory note (`project_w4d_undocumented_consumer.md`) and either:
   - Land the consumer's update in this PR (preferred if small).
   - Defer to a follow-up PR that ships before 4e.
3. **An admin-dashboard route's downstream Supabase write turns out to be using `service_role` direct SQL** rather than going through Supabase's client library. Treat as a 1-line change but flag in commit message — it can hide pattern violations.
4. **The Supabase migration's backfill UPDATE takes longer than 30 seconds** on staging. Split: ship the column ADD as one migration, the backfill as a separate batched-UPDATE migration that can pause/resume. (Production data volume estimation: orders table is the biggest; if it's <10M rows the single migration is fine.)
5. **Pre-flight reveals 4b or 4c is NOT on the integration branch.** Stop and report.

## Report back

Write a session memo to `~/.claude/projects/D--The-Small-002/memory/project_w4d_landed.md` covering:

- Number of Rust emission sites converted (per-file).
- Number of admin-dashboard routes converted.
- Whether Surface 3 (Supabase migration) shipped in this PR or is deferred.
- Number of parity-fixture files re-stamped.
- Bake-window deadline (when 4e should be safe to ship).
- Any consumers discovered during pre-flight that the inventory missed.
- Test count delta.

Update [inventory.md](inventory.md) wire-format consumers section if any new consumers were discovered.

## Memory hooks

- Project memory: merge commit hash, surface-by-surface site counts, bake-window deadline.
- Reference memory if a Supabase admin doc was created (e.g., a Notion page on the dual-shape transition window).
- Feedback memory only if the user gives non-obvious guidance during the session.
