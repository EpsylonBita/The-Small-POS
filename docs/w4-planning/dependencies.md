# W4 b–e — Dependency Graph and Sequencing

> Companion to [inventory.md](inventory.md). Read the inventory first; this file explains the **order constraints** between the four sub-sessions.

## TL;DR

```
4c (write path, dual-write)
        │
        ▼
4b (read path switches to *_cents columns)
        │
        ▼
4d (wire format cutover — JSON payloads switch to *_cents keys)
        │
        ▼
4e (drop REAL columns, remove dual-write halves, remove MONEY_EPSILON)
```

The original plan suggested 4b and 4c could ship in parallel because triggers would dual-write transparently. **They cannot** — see "Why 4c must precede 4b" below.

---

## Why 4c must precede 4b

### What the original plan assumed

The plan in `create-a-plan-to-rustling-pretzel.md` (Wave 4, sub-step 4c) said:

> All `INSERT`/`UPDATE` statements write the `_cents` column; the legacy REAL column is updated by trigger (backward-compat for any reader that still queries it).

That implied a SQL-trigger model where you could write only `_cents` and SQLite would back-compute the REAL column for legacy readers.

### What the v51/v53/v54 migrations actually did

The docstring on [migrate_v51](../../src-tauri/src/db.rs) (line 3372-3396) explicitly says:

> No triggers are created — keeping the migration dependency-free means a rollback is simply "ignore the new columns". **Dual-write is Rust's job in 4b/4c**; atomic switch-over happens in 4d; 4e drops the legacy REAL columns.

`migrate_v53` and `migrate_v54` repeat the same model. **Backfill happens once at migration time** (`UPDATE … SET _cents = CAST(ROUND(real * 100) AS INTEGER) WHERE _cents IS NULL`), then **new rows written after the migration have NULL in the `_cents` column** until something writes them.

### Consequence for sequencing

If 4b ships first (readers switch to `SELECT _cents`), every row inserted after the v51 migration but before 4c lands in production has `NULL` in `_cents`. Readers see `NULL`, treat it as zero, and silently lose money. **Catastrophic correctness regression.**

If 4c ships first (writers do dual-write to both columns), the `_cents` column is now populated for new rows. 4b's SELECT-switch then becomes safe.

### What "dual-write" means in 4c

For every `INSERT INTO orders (… total_amount, …)` that exists today, 4c rewrites it to `INSERT INTO orders (… total_amount, total_amount_cents, …)`, binding both `to_f64_dp2()` for the REAL side and `as_i64()` for the cents side from the same `Cents` value held in Rust. Same for UPDATE.

The Rust struct field stays as `f64` until 4b — 4c only changes the **SQL layer**, not the in-memory representation. (Or: the struct field becomes `Cents` in 4c too, with `to_f64_dp2()` called at the SQL bind site to populate the REAL column. Either order is defensible — the 4c sub-prompt picks one explicitly.)

---

## Why 4d cannot ship before 4b and 4c

The wire format carries `amount_cents` as an **integer** field. For Rust to emit it, the value must already be in `Cents` form internally — which means the read path (4b) and any local arithmetic must already be on integer cents. If 4d ships before 4b/4c, every emission site has to do an ad-hoc `(value * 100.0).round() as i64` at the JSON boundary (which is what the [wave-4d-payload-builder-edits.md](../../../planning/claude/wave-4d-payload-builder-edits.md) replay doc does as a transitional measure for 9 sites).

That transitional pattern is acceptable for the 9 specific sites in the replay doc (because they were applied in a "save partial work" moment), but it scales badly:

- It hides every `f64` aggregation drift bug **inside the converter**, not at the source.
- It needs to be removed during 4b anyway — duplicate edit churn.
- The `MONEY_EPSILON` removal in 4e becomes harder to reason about because some sites still have float math even though the wire is integer.

So the right order is: **fix internal math first (4b/4c), then change the wire (4d).**

### One subtlety: the 4d-replay doc's pattern is fine to keep

The 9 edits in the replay doc are net-additive: they emit `*_cents` keys (integer) sourced from `Cents::round_half_even(f64).as_i64()`. If 4c lands first and the underlying field is already `Cents`, those sites simplify to just `value.as_i64()` (or rely on serde's automatic integer serialization if the field is typed `Cents`). The transitional `round_half_even(f64).as_i64()` form will continue to work because `Cents::From<f64>` IS `round_half_even`.

So the 4d sub-prompt should **apply the replay doc as-is** and then **simplify** any sites where 4b/4c has since converted the underlying field to `Cents`.

---

## Why 4e is the irreversible gate

4e:

1. Removes the **dual-write half** of every 4c INSERT/UPDATE (the legacy REAL column binding).
2. Runs migration v58 to `ALTER TABLE … DROP COLUMN` for the 52 REAL money columns.
3. Removes `MONEY_EPSILON` from [money.rs](../../src-tauri/src/money.rs) and every remaining import/usage.
4. Removes any transitional `(f64 * 100.0).round() as i64` calls that still exist after 4d simplifies.

After 4e ships:

- Any consumer (admin-dashboard route, mobile app, Supabase replication query, analytics query) still reading the legacy REAL column **breaks at runtime** with "no such column".
- The REAL column is gone from the SQLite schema; rolling back 4e requires another migration.
- Re-introducing `MONEY_EPSILON` would mean re-introducing float money, which is a reversal of the entire wave.

**Safety net**: a one-week staging bake between 4d shipping and 4e shipping is recommended (per the original plan's W4 verification section). The prior desktop runtime is retired so there's no compat window concern, but a week of staging traffic catches any accidentally-missed admin route or background job.

---

## Visualization with intermediate states

```
state 0 — pre-W4-b/c (today, after W4a + W11):
  schema:   orders.total_amount REAL  +  total_amount_cents INTEGER (NULL on new rows)
  rust:     reads/writes total_amount as f64
  wire:     {"amount": 12.34}   (f64 JSON)
  admin:    Zod accepts amount: number

state 1 — after 4c:
  schema:   orders.total_amount REAL  +  total_amount_cents INTEGER (populated on new rows)
  rust:     reads total_amount as f64; writes BOTH columns from Cents
  wire:     {"amount": 12.34}   (unchanged — wire change is 4d)
  admin:    Zod accepts amount: number   (unchanged)

state 2 — after 4b:
  schema:   orders.total_amount REAL (frozen, not read by Rust)  +  total_amount_cents INTEGER
  rust:     reads/works in Cents; writes BOTH columns from Cents
  wire:     {"amount": 12.34}   (unchanged)
  admin:    Zod accepts amount: number   (unchanged)

state 3 — after 4d:
  schema:   (same)
  rust:     reads/works in Cents; writes BOTH columns from Cents; emits {"amount_cents": 1234}
  wire:     {"amount_cents": 1234}   (integer JSON)
  admin:    Zod accepts amount_cents: number().int()

state 4 — after 4e (terminal):
  schema:   orders.total_amount_cents INTEGER (REAL column dropped)
  rust:     reads/works in Cents; writes _cents column only; MONEY_EPSILON removed
  wire:     {"amount_cents": 1234}
  admin:    Zod accepts amount_cents: number().int()
```

---

## Branch and PR ordering

Each sub-session ships its own PR onto `pos-tauri/remediation-waves-0-9-landing` (or whichever long-lived integration branch is current). Suggested branch names:

```
pos-tauri/w4c-rust-write-path-dual-write
pos-tauri/w4b-rust-read-path-cents
pos-tauri/w4d-wire-format-cutover
pos-tauri/w4e-drop-real-columns
```

Sequencing constraint: **4c → 4b → 4d → 4e**, sequentially. Each step's pre-flight gate verifies the prior step is on `main` (or whichever integration branch). Per the user's W10/W11 discipline, **don't grind a step that hits an unforeseen scope explosion** — scope-split forks are listed in each sub-prompt.

### Could 4b and 4c run as a single PR?

In principle yes. They're tightly coupled and a reviewer can hold both halves in their head together. But each is sizable on its own (4b touches ~400 read sites; 4c touches ~50 SQL writes plus dual-bind every place):

- **Land 4c first as its own PR.** Lower risk — only adds writes, no reader semantic change. Easy to revert.
- **Land 4b second.** This is the one that actually changes runtime behaviour — every `total_amount` read now flows through the cents path. Bake long enough to catch latent rounding mismatches.
- **Combining is fine** if the diff is small enough for review (e.g., a low-volume table). For `orders` and `zreport`, separate PRs are safer.

The 4c and 4b sub-prompts each ship as a standalone PR by default. The 4c prompt explicitly notes "do not switch reads in this PR" so reviewers know the boundary.

---

## What the sub-prompts each cover

### [4b-read-path.md](4b-read-path.md)

- Switch every `SELECT real_col` to `SELECT real_col_cents`.
- Change struct fields from `f64` to `Cents`.
- Change function signatures to take/return `Cents`.
- Replace local arithmetic (`+`, `-`, `*0.01`, etc.) with `Cents` ops (or convert via `to_f64_dp2()` only at display boundaries).
- Update tests to assert in integer cents.
- Do NOT change writes — they still dual-write per 4c.
- Do NOT change wire format — that's 4d.

### [4c-write-path.md](4c-write-path.md)

- For every INSERT/UPDATE on a money column, add the `_cents` sibling column to the column list and bind from the same `Cents` value.
- Helper extract: `crate::money::bind_cents_pair(stmt, idx, cents)` or equivalent — applies the `to_f64_dp2()` for REAL and `as_i64()` for cents in one call.
- Verify trigger-free idempotency: re-running the same INSERT should produce identical values in both columns.
- Do NOT change reads.
- Do NOT change wire format.
- Do NOT remove the REAL column writes — that's 4e.

### [4d-wire-format.md](4d-wire-format.md)

- Apply the [wave-4d-payload-builder-edits.md](../../../planning/claude/wave-4d-payload-builder-edits.md) replay doc as-is (9 sites).
- Extend to the deferred sites listed in that doc's tail: zreport.rs emissions, sync_queue.rs order body, admin-dashboard route schemas + Supabase column references.
- Add admin-dashboard Zod schema renames: `amount` → `amount_cents` (integer), with a transitional accept-both window inside this PR.
- Update parity-contract fixtures and shared TS types.
- Single coordinated PR — the prior desktop runtime is retired so no dual-shape parser.

### [4e-drop-columns.md](4e-drop-columns.md)

- Remove the legacy REAL column writes that 4c added.
- Migration v58: `ALTER TABLE … DROP COLUMN` for 52 REAL money columns.
- Remove `MONEY_EPSILON` constant and every remaining usage.
- Remove the transitional `(f64 * 100.0).round() as i64` call sites that survived 4d.
- One-week staging bake recommended before merging.
