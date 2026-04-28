# Sub-session 4b — Rust read path switches to `Cents`

> **Self-contained session prompt.** Drop into a fresh Claude Code session.

## Context

You are continuing the 11-wave remediation of `pos-tauri` (Rust/Tauri POS at `D:\The-Small-002\pos-tauri`). The remaining work is **Wave 4 b–e**, the money migration. This session is **4b — switch the Rust read path from `f64` money to `Cents` (i64-backed)**.

Background already in place:

- **W0** shipped the `Cents(i64)` newtype with `From<f64>` (half-even rounding), `round_half_up`, `to_f64_dp2`, arithmetic ops (`Add/Sub/Neg/AddAssign/SubAssign/Sum`), and serde-as-integer. See [pos-tauri/src-tauri/src/money.rs](../../src-tauri/src/money.rs).
- **W4a** added 52 `*_cents INTEGER` shadow columns across 12 tables, via three migrations:
  - `migrate_v51` — `orders` (6), `order_payments` (3), `payment_adjustments` (1).
  - `migrate_v53` — `staff_shifts` (8), `cash_drawer_sessions` (12), `z_reports` (13).
  - `migrate_v54` — `order_payments.discount_amount`, `payment_items`, `driver_earnings` (6), `shift_expenses`.
  - **No SQL triggers exist.** Backfill happened once at migration time; new rows have NULL in the cents columns until something writes them.
- **4c (must already have shipped before you start 4b)** — the Rust write path now dual-writes both the legacy REAL column AND the new `_cents` column. Verify this by checking the integration branch before pre-flight.
- **W6** dropped `orders.payment_method` (migration v55). Don't reference that column.
- **W11** added migration v57 (staff_shifts index). Highest landed migration is **v57**.

Do NOT depend on the original W4 plan's "trigger-backed dual-write" assumption — that was wrong, and the dependency graph is now: **4c → 4b → 4d → 4e**. See [dependencies.md](dependencies.md) for why.

The full inventory is at [inventory.md](inventory.md). The original plan is at `D:\The-Small-002\planning\claude\create-a-plan-to-rustling-pretzel.md` (Wave 4 section).

## Pre-flight (do before any code changes)

1. **Verify 4c is on the integration branch.** `git log --grep="W4c\|4c " pos-tauri/remediation-waves-0-9-landing` (or whichever branch is current) should show a recent merge. If 4c is missing, **STOP** — switching reads to `_cents` columns when those columns are NULL on new rows produces silent zero-money corruption.
2. **Re-read** the load-bearing files to absorb current state (line numbers in the inventory may have drifted):
   - `pos-tauri/src-tauri/src/payments.rs`
   - `pos-tauri/src-tauri/src/refunds.rs`
   - `pos-tauri/src-tauri/src/zreport.rs` — biggest surface
   - `pos-tauri/src-tauri/src/shifts.rs`
   - `pos-tauri/src-tauri/src/sync.rs` — money paths only
   - `pos-tauri/src-tauri/src/payment_integrity.rs`
   - `pos-tauri/src-tauri/src/commands/orders.rs`
   - `pos-tauri/src-tauri/src/commands/analytics.rs`
   - `pos-tauri/src-tauri/src/commands/shifts.rs`
3. **Re-grep the read surface**:
   ```bash
   rg -nE 'let .*: f64 = conn\.(query_row|prepare)' pos-tauri/src-tauri/src/
   rg -nE 'row\.get::<_, (Option<)?f64>?' pos-tauri/src-tauri/src/
   ```
   Cross-reference against [inventory.md](inventory.md). New sites that landed since 2026-04-26 must be added.
4. **Inventory the existing test fixtures.** Search for `assert_eq!(.*f64\|.*\.to_f64_dp2\|MONEY_EPSILON)` in `pos-tauri/src-tauri/src/` — these tests must update in lockstep with the read switch. Do NOT remove `MONEY_EPSILON` references in this PR; that's 4e.

## Scope

For every monetary read in production Rust code:

1. **SQL SELECT changes**: every `SELECT total_amount FROM orders` becomes `SELECT total_amount_cents FROM orders`. Same for the other 51 columns enumerated in [inventory.md](inventory.md) (table: "Pre-existing infrastructure" — three migration column lists).
2. **`row.get::<_, f64>(col)` → `row.get::<_, i64>(col).map(Cents::new)`**. Apply at every read site.
3. **Struct fields** that hold money change from `f64` to `Cents`:
   - [payments.rs](../../src-tauri/src/payments.rs) — `PaymentRecordInput { amount: f64, cash_received: Option<f64>, change_given: Option<f64>, discount_amount: f64 }` becomes `Cents` for each.
   - [payment_integrity.rs](../../src-tauri/src/payment_integrity.rs) — `UnsettledPaymentBlocker { total_amount: f64, settled_amount: f64 }` and `RawBlockerRow { total_amount: f64, settled_amount: f64 }` become `Cents`. `serde::Serialize` derive will emit them as integers — that's a **wire-shape change** for `UnsettledPaymentBlocker` (camelCase JSON) consumed by admin-dashboard. Verify the consumer can accept either; if not, defer the struct serialization change to 4d and keep the public Serialize as `f64` via a custom serializer until then. (Pragmatic: tag the field `#[serde(serialize_with = "crate::money::serialize_cents_as_f64_dp2")]` and add the helper.)
4. **Function signatures** that take/return money change to `Cents`:
   - In [payments.rs](../../src-tauri/src/payments.rs): `outstanding_amount`, `record_payment`, `recompute_order_payment_state`.
   - In [refunds.rs](../../src-tauri/src/refunds.rs): `record_refund`, `get_payment_balance`.
   - In [zreport.rs](../../src-tauri/src/zreport.rs): every helper that returns an aggregate (cash_sales, card_sales, gross/net, tips, discounts, refunds, voids).
   - In [shifts.rs](../../src-tauri/src/shifts.rs): close-out aggregators.
5. **Local arithmetic** on money switches to `Cents` ops (`+`, `-`, `Sum`, `abs()`, comparisons). Do NOT introduce float intermediate steps.
6. **MONEY_EPSILON comparisons** at the 12 production sites: replace with exact integer comparison ONLY where both sides are now `Cents`. **Keep `MONEY_EPSILON` imported** — sites that still cross float boundaries (e.g. waiting on a `Value::as_f64()` from a sync queue payload) keep the epsilon until 4d converts the wire. Do not remove the constant in this PR.
7. **Display sites** (where money is rendered to a string for receipt/UI/log): keep as `f64` via `cents.to_f64_dp2()` at the boundary. Examples: `format_money` in [payment_integrity.rs:60](../../src-tauri/src/payment_integrity.rs).
8. **Test updates**: every test fixture that asserts on money in cents should now assert against `Cents::new(N)` or against the integer field. Tests that exercise epsilon boundaries (e.g. `payments.rs:3315-3415`) become tests of integer-exact equality (`Cents::new(1000) == Cents::new(1000)`).

## Out of scope

- Writing the cents column. **4c does that** — assume it's already shipped.
- Wire format JSON keys (`amount` → `amount_cents`). **4d does that.**
- Dropping `MONEY_EPSILON` constant or any `MONEY_EPSILON` usage. **4e does that.**
- Removing the legacy REAL column writes from 4c. **4e does that.**
- Touching the renderer (TypeScript). The IPC boundary already stringifies through `Value`; cents change is invisible to the renderer until 4d's wire change.
- ECR `commands/ecr.rs` — already on cents (uses `(amount * 100.0).round() as i64`); a polish pass to route through `Cents::round_half_up` is welcome but not blocking.
- Any 4e prep (dropping columns, removing dual-write, removing `MONEY_EPSILON`).

## Acceptance gates

Before merging:

```bash
cd D:/The-Small-002/pos-tauri/src-tauri
cargo fmt --check
cargo clippy --lib --all-targets -- -D warnings
cargo test --lib
cargo test --tests
```

All four must pass. Expected test count delta vs the parent branch: same number of tests, same pass count (currently 936 pass / 0 fail / 1 ignored on the integration branch). Any **new** test failures point at a money-aggregation discrepancy and must be root-caused, not skipped.

Money correctness check (manual):

1. Open and close a shift with a non-trivial cash count (e.g., €1234.56). Verify the close-out modal and z-report show €1234.56 exactly — no €1234.55 or €1234.57 drift.
2. Run the `cargo test sync::` and `cargo test zreport::` suites. Assert: integer-exact equality on every aggregate.
3. Replay a fixture day's z-report through `cargo test --test parity_g14` (W7 gate). Assert: identical `gross_sales`, `net_sales`, `cash_sales`, `card_sales` values to the pre-4b baseline (compare via integer cents, not f64-to-string).

If a manual check shows drift, **stop and root-cause** — likely cause is a missed dual-write site in 4c (a row with NULL `_cents` column that 4b is now reading as zero).

## Branch strategy

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git pull --rebase
git checkout -b pos-tauri/w4b-rust-read-path-cents
# … work …
git push -u origin pos-tauri/w4b-rust-read-path-cents   # only if remote workflow expects it; otherwise local-merge
```

Single PR. The diff will be sizable (~400 read sites + struct/sig changes); group commits by file: one commit for `payments.rs`, one for `refunds.rs`, one for `zreport.rs`, etc., so review can proceed file-at-a-time.

After merge, locally merge back into the integration branch:

```bash
git checkout pos-tauri/remediation-waves-0-9-landing
git merge --no-ff pos-tauri/w4b-rust-read-path-cents
```

## Scope-split forks (stop and split rather than grind)

Per the W10 H32 / W11 discipline — if any of these fire, scope-split rather than push through:

1. **`zreport.rs` exceeds 6 hours of work or 30 read-site edits stretch the diff beyond reviewable.** Split: ship `payments.rs` + `refunds.rs` + `payment_integrity.rs` + `commands/*.rs` first as 4b-i. Ship `shifts.rs` + `zreport.rs` + `sync.rs` as 4b-ii. Each on its own PR. Tag both with the `w4b` label so 4d/4e know both must be on the integration branch before they start.
2. **A struct field's `f64`-to-`Cents` change requires a non-trivial admin-dashboard JSON contract change.** This means the field crosses the wire (e.g. `UnsettledPaymentBlocker`). Either:
   - Add the `serialize_with = "serialize_cents_as_f64_dp2"` adapter so the wire shape is unchanged in this PR (preferred — keeps 4b purely internal), OR
   - Defer that struct's field-type change to 4d and leave it as `f64` for now.
3. **A read site can't be converted because the underlying SQL is dynamic.** Some `SELECT * FROM orders` paths exist in diagnostic dumps. Convert to explicit columns at the same time, OR add `total_amount_cents` to the SELECT and read it in addition to `total_amount`. Don't change `SELECT *` semantics broadly.
4. **A test fixture asserts on `MONEY_EPSILON` boundary semantics.** Update the fixture to assert integer-exact (`Cents::new(1001) == Cents::new(1001)`) and **note in the commit message** that the boundary semantic is preserved (`>= - 1` becomes `>= 0` once both sides are Cents). Do not delete the test.
5. **Pre-flight reveals 4c is NOT on the integration branch.** Stop and report. Do not run 4b until 4c is in place.

## Report back

When the work lands, write a session memo to `~/.claude/projects/D--The-Small-002/memory/project_w4b_landed.md` covering:

- Number of read sites converted (per-file table).
- Number of struct fields and function signatures changed.
- Whether `UnsettledPaymentBlocker` kept its wire-format f64 (via `serialize_with`) or not.
- Test count delta and any test renames.
- Outstanding scope-splits, if any (4b-ii branch handoff, etc.).
- Any drift between the inventory's expected count and reality.

Update [inventory.md](inventory.md) only if a structural surprise was discovered (e.g. a previously-unknown read site in a file the inventory didn't enumerate). Otherwise leave it.

## Memory hooks (write only if non-obvious)

- A feedback memory if the user gives explicit guidance during the session — e.g. "for `UnsettledPaymentBlocker` keep the wire as f64 forever; admin-dashboard relies on it" would mean a feedback memory naming the constraint.
- A project memory naming the merge commit hash and the test count after merge: "W4b landed at `<sha>` on 2026-04-XX; cargo test 936/0/1; …".
- Do NOT memory-write architectural facts that are already in this prompt or [inventory.md](inventory.md). Memory is for what's surprising or what the next session needs but can't easily re-derive.
