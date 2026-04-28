# Sub-session 4c — Rust write path switches to dual-write `Cents` + REAL

> **Self-contained session prompt.** Drop into a fresh Claude Code session.

## Context

You are continuing the 11-wave remediation of `pos-tauri` (Rust/Tauri POS at `D:\The-Small-002\pos-tauri`). The remaining work is **Wave 4 b–e**, the money migration. This session is **4c — switch every monetary INSERT/UPDATE to dual-write the legacy REAL column AND the new `*_cents` integer column**.

**4c ships first** in the b/c/d/e ordering. See [dependencies.md](dependencies.md) for the rewired dependency graph: the original "trigger-backed dual-write" assumption was wrong (no SQL triggers exist; v51/v53/v54 docstrings explicitly say "Dual-write is Rust's job in 4b/4c"). New rows written after the v51/v53/v54 migrations have NULL in the cents columns until 4c populates them. Without 4c, 4b's switch-to-cents-reads silently zeros out money.

Background already in place:

- **W0**: `Cents(i64)` newtype in [pos-tauri/src-tauri/src/money.rs](../../src-tauri/src/money.rs) with `From<f64>` (half-even), `round_half_up`, `to_f64_dp2`, arithmetic ops, `Sum`, serde-as-integer.
- **W4a**: 52 `*_cents INTEGER` shadow columns shipped via `migrate_v51` (orders / order_payments / payment_adjustments — 10 cols), `migrate_v53` (staff_shifts / cash_drawer_sessions / z_reports — 33 cols), `migrate_v54` (order_payments.discount_amount, payment_items, driver_earnings, shift_expenses — 9 cols). All cents columns are nullable; new rows default NULL.
- **W6**: dropped `orders.payment_method` (v55). Don't reference.
- **W11**: highest landed migration is **v57** (staff_shifts index).

The full inventory is at [inventory.md](inventory.md). The original plan is at `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md` (Wave 4 section).

## Pre-flight (do before any code changes)

1. **Confirm the integration branch is clean** — `git status` shows no surprises beyond the planned 4c PR scope. Pull the latest before branching.
2. **Re-read** the load-bearing files to absorb current state:
   - `pos-tauri/src-tauri/src/payments.rs` — payment INSERTs and recompute UPDATEs
   - `pos-tauri/src-tauri/src/refunds.rs` — refund INSERTs and accumulator UPDATEs
   - `pos-tauri/src-tauri/src/shifts.rs` — staff_shifts and cash_drawer_sessions writes (open / transfer / close / force-close)
   - `pos-tauri/src-tauri/src/zreport.rs` — z_reports writes (submit / generate)
   - `pos-tauri/src-tauri/src/sync.rs` — order_payments.applied state writes
   - `pos-tauri/src-tauri/src/commands/orders.rs` — order INSERTs (line items, payment items)
3. **Re-grep the write surface**:
   ```bash
   rg -nE 'INSERT INTO (orders|order_payments|staff_shifts|cash_drawer_sessions|z_reports|payment_adjustments|payment_items|driver_earnings|shift_expenses)' pos-tauri/src-tauri/src/
   rg -nE 'UPDATE (orders|order_payments|staff_shifts|cash_drawer_sessions|z_reports|payment_adjustments|payment_items|driver_earnings|shift_expenses)' pos-tauri/src-tauri/src/
   ```
   Cross-reference against [inventory.md](inventory.md). New sites that landed since 2026-04-26 must be added.
4. **Map every column** in each table to its `_cents` sibling. The authoritative lists are in `migrate_v51`, `migrate_v53`, `migrate_v54` — copy the `(table, col)` arrays as the dual-write source of truth so a reviewer can diff-check.
5. **Note**: `daily_z_reports`, `staff_payments`, `transaction_log` were intentionally excluded from W4a (per `migrate_v54` docstring at [db.rs:3635-3658](../../src-tauri/src/db.rs)) because they have no production CREATE. If a write to one of those tables shows up here, **stop** and discuss with the user — adding the cents column needs to be coordinated with a CREATE TABLE migration.

## Scope

For every monetary INSERT or UPDATE in production Rust code:

1. **Helper extraction (do this first)**. Add to [money.rs](../../src-tauri/src/money.rs):

   ```rust
   /// Bind a money value to two consecutive SQL placeholders: REAL first,
   /// then INTEGER. Use during the W4 dual-write window. Removed in 4e.
   pub fn cents_pair(c: Cents) -> (f64, i64) {
       (c.to_f64_dp2(), c.as_i64())
   }
   ```

   Using a tuple keeps the call sites short: `params![…, cents_pair(amount).0, cents_pair(amount).1, …]`. Or, for clarity at call sites that bind by name, accept the call sites doing two lookups. Pick whichever pattern reads cleanest in the largest file ([shifts.rs](../../src-tauri/src/shifts.rs)) and use consistently.

2. **For every INSERT** that touches a money column, extend the column list and the values list:

   ```rust
   // before
   conn.execute(
       "INSERT INTO orders (id, branch_id, items, total_amount, …)
        VALUES (?1, ?2, ?3, ?4, …)",
       params![id, branch_id, items, total_amount, …],
   )?;

   // after
   conn.execute(
       "INSERT INTO orders (id, branch_id, items, total_amount, total_amount_cents, …)
        VALUES (?1, ?2, ?3, ?4, ?5, …)",
       params![id, branch_id, items, total_amount.to_f64_dp2(), total_amount.as_i64(), …],
   )?;
   ```

   The Rust-side variable `total_amount` should already be `Cents` if 4c is changing the struct. If the struct is still `f64`, convert at the bind site (`Cents::round_half_even(total_amount).to_f64_dp2()`, `Cents::round_half_even(total_amount).as_i64()`).

3. **For every UPDATE** on a money column, similarly extend SET clause and bindings:

   ```rust
   // before
   conn.execute(
       "UPDATE orders SET total_amount = ?1, updated_at = ?2 WHERE id = ?3",
       params![total_amount, now, id],
   )?;

   // after
   conn.execute(
       "UPDATE orders
        SET total_amount = ?1,
            total_amount_cents = ?2,
            updated_at = ?3
        WHERE id = ?4",
       params![total_amount.to_f64_dp2(), total_amount.as_i64(), now, id],
   )?;
   ```

4. **Shadow-column completeness audit**. After every INSERT/UPDATE edit, a reviewer needs to verify that every legacy REAL column listed in the W4a migrations now has its sibling write. Add a temporary integration test (delete in 4e) that:

   ```rust
   #[test]
   fn dual_write_keeps_real_and_cents_columns_in_sync() {
       // for each of the 52 (table, col, col_cents) triples,
       // open a transaction, insert a fixture row, assert
       // CAST(ROUND(real_col * 100) AS INTEGER) == cents_col
       // (within the rounding rule used at the bind site).
   }
   ```

   This catches missed sites; without it, a forgotten dual-write only surfaces when 4b ships and a specific code path runs in production.

5. **`cargo test` parity**. Existing tests should pass unchanged. The dual-write is invariant: every read still sees the REAL column with the same value as before. Cents-only tests are 4b's job.

6. **Choice point — struct fields**. Two valid approaches:
   - **(a) Keep struct fields as `f64` for now.** Convert to `Cents` at the SQL bind site only. Leaves the read path untouched (4b's job). Smallest diff.
   - **(b) Convert struct fields to `Cents` here.** Then 4b only changes SELECT statements and SQL parsing. Larger 4c diff, smaller 4b diff.
   - **Recommendation: (a)** — minimizes 4c review surface and keeps 4b/4c independently revertable. The 4b prompt is written assuming (a).

## Out of scope

- Switching SELECTs to read `_cents` columns. **4b does that.**
- Wire format JSON keys (`amount` → `amount_cents`). **4d does that.**
- Removing the legacy REAL column writes (the second half of dual-write). **4e does that.**
- Removing `MONEY_EPSILON`. **4e does that.**
- Touching the renderer.
- Backfilling rows that already exist with NULL `_cents`. v51/v53/v54 already did initial backfill at migration time; rows written between v51 and 4c landing have NULL `_cents`. After 4c lands, **only newly-written rows are populated**. To repair the in-between gap, either:
  - Trust that any in-between row will be re-written on next mutation (most order/payment rows are short-lived), OR
  - Add a one-shot `UPDATE … SET col_cents = CAST(ROUND(col * 100) AS INTEGER) WHERE col_cents IS NULL` inside `migrate_v58` (4e's migration). **Recommended: defer to 4e** so the repair runs once just before columns drop. Note this in the report-back.

## Acceptance gates

```bash
cd D:/The-Small-002/pos-tauri/src-tauri
cargo fmt --check
cargo clippy --lib --all-targets -- -D warnings
cargo test --lib
cargo test --tests
```

Plus the new dual-write integration test (item 4 above) must pass with all 52 (table, col, col_cents) triples. Build the test by reading the column lists out of `migrate_v51`, `migrate_v53`, `migrate_v54` rather than re-typing — single source of truth.

Manual sanity:

1. Open shift with cash €1234.56, close shift, query SQLite directly:
   ```sql
   SELECT opening_cash_amount, opening_cash_amount_cents FROM staff_shifts ORDER BY check_in_time DESC LIMIT 1;
   -- expect: 1234.56 | 123456
   ```
2. Record a payment of €5.00 with €0.01 change. Query `order_payments`:
   ```sql
   SELECT amount, amount_cents, cash_received, cash_received_cents, change_given, change_given_cents
   FROM order_payments ORDER BY created_at DESC LIMIT 1;
   -- expect: 5.00 | 500 | 5.01 | 501 | 0.01 | 1
   ```

## Branch strategy

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git pull --rebase
git checkout -b pos-tauri/w4c-rust-write-path-dual-write
```

Single PR. Group commits by file: one per `payments.rs`, `refunds.rs`, etc. The dual-write integration test is its own commit at the end.

After merge:

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git merge --no-ff pos-tauri/w4c-rust-write-path-dual-write
```

## Scope-split forks (stop and split rather than grind)

1. **Diff exceeds reviewer threshold (>800 lines).** Split by table family:
   - 4c-i: `orders` + `order_payments` + `payment_adjustments` + `payment_items` (the most touched)
   - 4c-ii: `staff_shifts` + `cash_drawer_sessions` (the close-out family)
   - 4c-iii: `z_reports` + `driver_earnings` + `shift_expenses` (low-volume tail)
   Sequence them; 4b cannot start until all three land.
2. **A write site can't be dual-written because the SQL is dynamic** (e.g., `format!()` building INSERT). Refactor to explicit-column SQL in this same PR — dynamic SQL on money columns is a refactor smell anyway and 4e needs explicit columns to drop. If the refactor blows up scope, split: ship a separate PR refactoring just that path before continuing 4c.
3. **The dual-write integration test fails on a column you didn't expect to write to.** Investigate — likely a write path you missed. Don't mark the column as "skip"; root-cause and add the dual-write.
4. **You discover a write to `daily_z_reports`, `staff_payments`, or `transaction_log`.** Stop. These tables have no production CREATE TABLE; writing to a `_cents` column on them errors at runtime. Either remove the write (test-only?) or coordinate with the user to add a production CREATE migration.
5. **You're tempted to also switch struct fields to `Cents`.** Don't, unless the user explicitly asks. Recommendation (a) above keeps 4c minimal.

## Report back

When the work lands, write a session memo to `~/.claude/projects/D--The-Small-002/memory/project_w4c_landed.md` covering:

- Number of INSERT sites and UPDATE sites converted (per-file).
- Whether you went with recommendation (a) or (b) on struct fields.
- The dual-write integration test name and how many (table, col) pairs it covers.
- Whether the v58 backfill-repair plan is recorded for the 4e prompt.
- Test count delta.
- Any scope-splits triggered.

Update [inventory.md](inventory.md) only if you discovered a structurally new write site that the inventory missed.

## Memory hooks

- Project memory: merge commit hash, file/site counts, dual-write integration test name.
- Feedback memory only if user gives explicit guidance ("always extract a helper for cents pair binding", "prefer named bindings over positional", etc.).
- Reference memory if a runbook page is added (e.g., "how to verify dual-write column drift in production SQLite").
