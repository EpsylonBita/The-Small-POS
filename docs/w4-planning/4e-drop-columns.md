# Sub-session 4e — Drop REAL columns + remove `MONEY_EPSILON` (irreversible)

> **Self-contained session prompt.** Drop into a fresh Claude Code session.

## Context

You are continuing the 11-wave remediation of `pos-tauri` (Rust/Tauri POS at `D:\The-Small-002\pos-tauri`). The remaining work is **Wave 4 b–e**, the money migration. This session is **4e — drop the legacy REAL money columns from SQLite and Supabase, remove the dual-write half from Rust, remove every `MONEY_EPSILON` usage, and remove `MONEY_EPSILON` from [money.rs](../../src-tauri/src/money.rs) itself**.

**This is the irreversible step.** After 4e ships, any consumer (admin-dashboard route, mobile app screen, Supabase analytics query, background job) that still reads the legacy REAL column breaks at runtime with "no such column". Rolling back requires another migration.

**Pre-condition: 4d has been baked in staging for at least one week** with no incidents. If 4d shipped recently and there's pressure to ship 4e now, **push back** — the bake catches forgotten consumers (the only protection we have, since the prior desktop runtime is retired and there's no compat window).

Background already in place (post-2026-04-26 work):

- **W0**: `Cents` newtype.
- **W4a**: 52 cents columns added across SQLite (`migrate_v51`, `migrate_v53`, `migrate_v54`).
- **W4b**: read path on cents (i + ii + iii — payments / refunds / commands / payment_integrity / sync.rs / shifts.rs / zreport.rs).
- **W4c**: write path dual-writes (REAL + cents).
- **W4d-i**: pos-tauri sync payloads emit BOTH float and cents keys (additive — see commit `12265780`).
- **W4e prep**: migration v58 backfills NULL cents from REAL siblings (see commit `1213174f`).
- **W4e MONEY_EPSILON removal**: constant + 9 production usage sites removed (commit `55353ead`); comparisons go through integer cents now.
- **W6**: `orders.payment_method` dropped (v55).
- **W11**: highest landed migration is **v58**; this session adds **v59**.

The full inventory is at [inventory.md](inventory.md). The original plan is at `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md` (Wave 4 section).

## Empirical cascade observation (2026-04-26)

A trial run on 2026-04-26 added migration v59 (DROP COLUMN of the 52 REAL columns) without first updating the cascade. `cargo test --lib` reported:

```
test result: FAILED. 693 passed; 249 failed; 2 ignored
```

**249 test failures.** Each failure is a SQL "no such column" error pointing at one of:
- A test fixture that INSERTs money via raw SQL with the dropped REAL column
- A production code path that still binds the REAL column (4c's dual-write half)
- A production SELECT whose COALESCE shim references the dropped REAL column

The cascade is enumerable via cargo test output but voluminous. Plan accordingly: the cutover can't ship as a single fast PR. The work below has to land **atomically** — DROP COLUMN + dual-write halves removed + COALESCE shims removed + test fixtures updated — because any partial state fails compilation or tests.

## Pre-flight (do before any code changes)

1. **Confirm 4d has been on the integration branch for ≥ one week** without runtime incident. Read `~/.claude/projects/D--The-Small-002/memory/project_w4d_landed.md` for the bake-window deadline.
2. **Hunt for any reader of the legacy REAL columns** — this is the most important step:
   ```bash
   # Across the whole monorepo (excluding node_modules):
   rg -nE '\.select\([^)]*?(total_amount|tax_amount|subtotal|discount_amount|tip_amount|delivery_fee|cash_received|change_given|opening_cash|closing_cash|expected_cash|cash_variance|gross_sales|net_sales|cash_sales|card_sales|refunds_total|voids_total|tips_total|discounts_total|expenses_total|total_refunds|total_expenses|cash_drops|driver_cash|opening_amount|closing_amount|expected_amount|variance_amount|item_amount|total_earning|cash_collected|card_amount|cash_to_return)' \
     --glob '!node_modules/**' --glob '!**/dist/**' .
   rg -nE 'SELECT [^;]*?(total_amount|tax_amount|opening_cash|gross_sales)' \
     --glob '!node_modules/**' --glob '!**/dist/**' .
   ```
   Cross-reference against [inventory.md](inventory.md) "Long tail — discover during sub-session pre-flight" — every match must already point at the `*_cents` sibling, OR the consumer must be updated in this PR. If a Supabase materialized view or analytics query is found that hasn't been migrated, **stop and update it first**.
3. **Verify Supabase parity**: connect to staging Supabase (or use the MCP `mcp__supabase__execute_sql`) and confirm every table has both columns:
   ```sql
   SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('orders', 'order_payments', 'staff_shifts', /* … */)
      AND (column_name LIKE '%amount%' OR column_name LIKE '%cash%' OR column_name LIKE '%sales%');
   ```
4. **Read [money.rs](../../src-tauri/src/money.rs) end-to-end** to absorb every `MONEY_EPSILON` doc reference and decide which docstrings to delete vs which to update with a "removed in 4e" tombstone.

## Scope

This session has **four destructive sub-steps**, executed in order. Each is reviewable on its own. Single PR with grouped commits.

**Recommended sequence (informed by the 2026-04-26 cascade observation):**

0. **Test-fixture sweep first** — find every raw-SQL `INSERT INTO orders|order_payments|staff_shifts|cash_drawer_sessions|z_reports|payment_adjustments|payment_items|driver_earnings|shift_expenses` in test code and add the cents column alongside the REAL column. Compute the cents value as `CAST(ROUND(real * 100) AS INTEGER)`. After this step the fixtures populate both columns; production reads via COALESCE shim still see the right value either way. Estimated ~30 fixtures across `payments.rs::tests`, `refunds.rs::tests`, `shifts.rs::tests`, `zreport.rs::tests`, `order_ownership.rs::tests`, `diagnostics.rs::tests`, `tests/parity_g7.rs`, `tests/parity_g8.rs`, `tests/parity_g13.rs`, `tests/parity_g14.rs`. Run `cargo test --lib` after each file to verify nothing breaks. **This step is purely additive** — REAL columns still receive writes, fixtures still work the same way, but the cents column is now ready.

1. Remove the COALESCE shims from production SELECTs (mechanical search-and-replace). After this, production reads ONLY from cents. Tests stay green because step 0 populated cents.

2. Remove the dual-write halves from production INSERT/UPDATE (37 sites — careful per-site edit). After this, production writes ONLY to cents. Tests stay green because COALESCE is gone (so reads don't see the now-stale REAL anyway) AND fixtures populate cents directly.

3. Remove the dual-write smoke test (`tests/w4c_dual_write_smoke.rs`).

4. Add migration v59 DROP COLUMN. Bump `CURRENT_SCHEMA_VERSION` to 59. After this, REAL columns are gone — but production code already migrated off them in steps 1–2, fixtures use cents directly post step 0, and there's no reader/writer left.

5. Verify `cargo test --lib` passes. Verify `cargo clippy --lib --all-targets -- -D warnings` is clean.

The original ordering (DROP COLUMN first, fix what breaks) cascades into 249 test failures and is genuinely too much for one session — **don't do that**. The reordered sequence above keeps every intermediate step green.

### Step 1 — Remove the legacy REAL column writes from Rust (the second half of 4c's dual-write)

For every INSERT/UPDATE that 4c made dual-write, drop the REAL column from the column list and bindings:

```rust
// after 4c (current)
conn.execute(
    "INSERT INTO orders (id, branch_id, items, total_amount, total_amount_cents, …)
     VALUES (?1, ?2, ?3, ?4, ?5, …)",
    params![id, branch_id, items, total_amount.to_f64_dp2(), total_amount.as_i64(), …],
)?;

// after 4e (target)
conn.execute(
    "INSERT INTO orders (id, branch_id, items, total_amount_cents, …)
     VALUES (?1, ?2, ?3, ?4, …)",
    params![id, branch_id, items, total_amount.as_i64(), …],
)?;
```

Same pattern for every UPDATE.

The dual-write integration test 4c added (named in `project_w4c_landed.md`) becomes a single-write test or is deleted entirely — pick whichever the rest of the suite favors.

### Step 2 — Migration v58: drop the 52 REAL columns

Add `migrate_v58` to [pos-tauri/src-tauri/src/db.rs](../../src-tauri/src/db.rs). Pattern after the existing migrations; reuse the `(table, col)` arrays from `migrate_v51`, `migrate_v53`, `migrate_v54` so a reviewer can diff-check the drop list against the add list:

```rust
fn migrate_v58(conn: &Connection) -> Result<(), String> {
    const REAL_COLUMNS_TO_DROP: &[(&str, &str)] = &[
        // From migrate_v51
        ("orders", "total_amount"),
        ("orders", "tax_amount"),
        ("orders", "subtotal"),
        ("orders", "discount_amount"),
        ("orders", "tip_amount"),
        ("orders", "delivery_fee"),
        ("order_payments", "amount"),
        ("order_payments", "cash_received"),
        ("order_payments", "change_given"),
        ("payment_adjustments", "amount"),
        // From migrate_v53
        ("staff_shifts", "opening_cash_amount"),
        // … (33 more from v53)
        // From migrate_v54
        ("order_payments", "discount_amount"),
        // … (8 more from v54)
    ];

    // OPTIONAL pre-drop: backfill any rows that still have NULL _cents
    // (rows written between v51/v53/v54 landing and 4c landing). Idempotent.
    // The 4c report-back specified whether this is needed; check that memo.
    for (table, real_col) in REAL_COLUMNS_TO_DROP {
        let cents_col = format!("{real_col}_cents");
        if column_exists(conn, table, &cents_col)? && column_exists(conn, table, real_col)? {
            let backfill_sql = format!(
                "UPDATE {table}
                 SET {cents_col} = CAST(ROUND(COALESCE({real_col}, 0) * 100) AS INTEGER)
                 WHERE {cents_col} IS NULL AND {real_col} IS NOT NULL"
            );
            conn.execute(&backfill_sql, [])
                .map_err(|e| format!("v58 backfill {table}.{cents_col}: {e}"))?;
        }
    }

    // Now drop. Guarded by column_exists for idempotent re-application.
    for (table, real_col) in REAL_COLUMNS_TO_DROP {
        if column_exists(conn, table, real_col)? {
            let drop_sql = format!("ALTER TABLE {table} DROP COLUMN {real_col}");
            conn.execute_batch(&drop_sql)
                .map_err(|e| format!("v58 drop {table}.{real_col}: {e}"))?;
        }
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (58)", [])
        .map_err(|e| format!("v58 record schema_version: {e}"))?;

    info!(
        columns = REAL_COLUMNS_TO_DROP.len(),
        "Applied migration v58 (W4e: dropped 52 legacy REAL money columns)"
    );
    Ok(())
}
```

Wire `migrate_v58` into the migration chain (search for where v57 is dispatched in `run_migrations`).

**Supabase mirror migration**: add a corresponding migration under `supabase/migrations/`:

```sql
-- supabase/migrations/<timestamp>_w4e_drop_legacy_money_columns.sql
ALTER TABLE orders DROP COLUMN total_amount;
ALTER TABLE orders DROP COLUMN tax_amount;
-- … (all 52 columns)
```

Mirror the SQLite drop list 1:1. Add a comment block at the top citing this sub-prompt for context.

### Step 3 — Remove the legacy-compat readers (4d's transitional fallback)

Rust readers that 4d added with the pattern:

```rust
let amount_cents = data.get("amount_cents").and_then(Value::as_i64)
    .or_else(|| data.get("amount").and_then(Value::as_f64).map(|v| Cents::round_half_even(v).as_i64()))
    .unwrap_or(0);
```

become:

```rust
let amount_cents = data.get("amount_cents").and_then(Value::as_i64).unwrap_or(0);
```

Any sync_queue row still pending dispatch with the legacy float `amount` shape now fails decode. The one-week bake means the queue should have drained — but sanity-check by querying staging (and prod, in a pre-merge step):

```sql
SELECT COUNT(*) FROM parity_sync_queue
 WHERE status IN ('pending', 'processing')
   AND payload NOT LIKE '%_cents%';
```

If non-zero, defer Step 3 until the queue drains. Steps 1, 2, 4 can still ship.

Same simplification on admin-dashboard Zod schemas (4d added a transitional union; collapse to integer-only):

```ts
// 4d transitional
const amountField = z.union([
  z.object({ amount_cents: z.number().int().nonnegative() }),
  z.object({ amount: z.number().nonnegative() }),
]);

// 4e
const amountField = z.object({ amount_cents: z.number().int().nonnegative() });
```

### Step 4 — Remove `MONEY_EPSILON` and every consumer

✅ **DONE in commit `55353ead` (2026-04-26)**, ahead of the rest of 4e.

The constant + 9 production usage sites have been removed. Comparisons now go through `Cents::round_half_even(.).as_i64()` integer-exact equality / ordering. The `money_epsilon_is_half_a_cent` test was removed alongside the constant. No `MONEY_EPSILON` references remain in production code — re-grep confirms only stale comments now.

One test (`overpaying_by_half_cent_is_accepted`) was renamed to `overpaying_by_sub_half_cent_rounds_to_outstanding_and_is_accepted` and its value changed from `10.005` to `10.004` because IEEE-754's representation of `10.005` rounds UP to `1001` cents (one-cent overpayment), which the new integer guard correctly rejects. `10.004` is unambiguously below `1000.5` cents, rounds to `1000`, and is accepted.

Remaining cleanup (still in scope for the cutover session):

5. Delete the `cents_pair` helper that 4c added if any (no longer needed once the REAL column is gone). Search for `cents_pair` to verify whether it was ever extracted; the 4c session committed inline `Cents::round_half_even(.).as_i64()` rather than a helper, so this may be a no-op.
6. Optional polish: remove the transitional `to_f64_dp2()` calls anywhere they only existed to feed the dropped REAL column.

## Out of scope

- Adding new tables or columns.
- Changing wire format further (already settled in 4d).
- Touching unrelated migrations.
- Polishing ECR `(amount * 100.0).round() as i64` sites — optional, not blocking.
- Removing the cents columns themselves (they're the new canonical form).

## Acceptance gates

```bash
# Rust
cd D:/The-Small-002/pos-tauri/src-tauri
cargo fmt --check
cargo clippy --lib --all-targets -- -D warnings
cargo test --lib
cargo test --tests

# Renderer + parity
cd D:/The-Small-002/pos-tauri
npm run typecheck
npm run test:desktop-parity

# Admin-dashboard
cd D:/The-Small-002/admin-dashboard
npm run typecheck
npm run lint
npm run test
```

All green.

Manual destructive sanity: in a **disposable staging DB**, run the migration, then query:

```sql
PRAGMA table_info(orders);
-- expect: NO `total_amount`, `tax_amount`, `subtotal`, `discount_amount`, `tip_amount`, `delivery_fee` rows
-- expect: `total_amount_cents`, `tax_amount_cents`, … present
```

Then take a payment, close a shift, generate a z-report. All must succeed; values must be exact.

Database-level negative test: create a fresh in-memory test DB, run migrations through v58, attempt to write to `orders.total_amount`:

```rust
#[test]
fn legacy_real_column_is_gone_after_v58() {
    let conn = Connection::open_in_memory().unwrap();
    run_migrations_for_test(&conn);
    let result = conn.execute(
        "INSERT INTO orders (id, total_amount, items) VALUES ('x', 1.23, '[]')",
        [],
    );
    assert!(result.is_err(), "writing to dropped total_amount should fail");
    let err = result.unwrap_err().to_string();
    assert!(err.contains("total_amount") && (err.contains("no such") || err.contains("has no column")),
        "error should mention dropped column; got: {err}");
}
```

## Branch strategy

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git pull --rebase
git checkout -b pos-tauri/w4e-drop-real-columns-and-epsilon
```

Single PR. Group commits as:

1. Step 1 — Rust dual-write removal
2. Step 2 — SQLite migration v58
3. Step 2 — Supabase migration
4. Step 3 — Rust legacy-compat reader removal
5. Step 3 — admin-dashboard Zod schema collapse
6. Step 4 — `MONEY_EPSILON` removal + docstring cleanup
7. Step 4 — Test pruning + new "real-column-gone" assertion

After merge:

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git merge --no-ff pos-tauri/w4e-drop-real-columns-and-epsilon
```

## Scope-split forks (stop and split rather than grind)

1. **Pre-flight finds a non-trivial reader of the legacy REAL columns** that wasn't anticipated. STOP. Don't ship 4e until that consumer is updated. Spin up a fix PR; resume 4e once it lands.
2. **Pre-flight finds non-zero queue entries with legacy float payload.** Defer Step 3 (legacy-compat reader removal) to a follow-up PR. Steps 1, 2, 4 can still ship — the legacy-compat readers stay temporarily but read against an integer-only wire so they're effectively dead code; remove in the follow-up once the queue has drained.
3. **The migration's drop-column phase takes >30 seconds** in staging. SQLite's `ALTER TABLE ... DROP COLUMN` may rewrite the table. Profile; if it's bad, split: drop a few columns per migration (v58, v59, v60) over a few PRs.
4. **Supabase migration fails or rolls back.** SQLite is in pos-tauri; Supabase is admin-dashboard's data store. Order matters: ship the Supabase migration FIRST, verify staging is healthy, THEN ship the SQLite migration. (Supabase is the side that admin-dashboard reads; if the Supabase column drops first while pos-tauri is still trying to dual-write, Supabase rejects the write. Resolution: 4d's wire change is already on cents-only via Surface 1, so no float writes hit Supabase. But order it so Supabase column-drops AFTER no float writes are reaching it.)
5. **A new `MONEY_EPSILON` usage appears that wasn't in the inventory** (e.g., a recently-added f64 comparison in a test or new code). Update [inventory.md](inventory.md) entry, then either fix in this PR (preferred) or defer to a `w4e-followup` PR — but `MONEY_EPSILON` deletion only happens once every site is converted.
6. **Pre-flight reveals 4d has not baked one week.** Push back — surface in a memo to user explaining the risk.

## Report back

Write a session memo to `~/.claude/projects/D--The-Small-002/memory/project_w4e_landed.md` covering:

- Migration v58 column drop count (should be 52).
- Whether all 4 steps shipped in one PR or any was split.
- Number of `MONEY_EPSILON` sites removed.
- Any consumers discovered during pre-flight that needed pre-PR updates.
- Test count delta — including the new "real-column-gone" assertion.
- Any rollback contingency if production exhibits drift after deploy.

Update [inventory.md](inventory.md) marking the file's status as "W4 b–e complete; closed YYYY-MM-DD". The file becomes a historical artifact — the inventory is no longer load-bearing.

Mark the [create-a-plan-to-rustling-pretzel.md](../../../planning/claude/create-a-plan-to-rustling-pretzel.md) Wave 4 section as ✅ closed (similar to how W5/W8/W10/W11 are marked).

Update or write the project memory file `~/.claude/projects/D--The-Small-002/memory/project_wave4_closed.md`:

> Wave 4 (money migration) closed YYYY-MM-DD. All `f64` money paths converted to `Cents` (i64). 52 REAL columns dropped via migration v58. `MONEY_EPSILON` removed. Wire format is integer cents end-to-end. Per-PR merge commits: 4c <sha>, 4b <sha>, 4d <sha>, 4e <sha>.

## Memory hooks

- Project memory: Wave 4 closure note (above).
- Feedback memory if user gives explicit guidance during the session.
- Reference memory if a runbook page captures the destructive deploy procedure (e.g., a Notion page documenting "how to staging-bake before a column-drop migration").
