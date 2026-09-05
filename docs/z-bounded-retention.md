# Z-Bounded Local Retention

The till's local order ledger is bounded by Z reports, not by the clock.
This document is the data-lifecycle contract for that model: who writes the
day-close marker, who reads it, and what happens on every failure path.

## The rule

> A working day opens with its first activity (check-in) and closes only at
> the Z report — whether it ran two hours or five days. Nothing local is
> hidden or deleted until a Z has settled it.

This is a product law, not an implementation detail. Any change that lets
the orders view or the local prune act on a clock boundary violates it.

## The marker

`local_settings` → category `system`, key `last_z_report_timestamp`
(RFC 3339, always the `+00:00` suffix — see "Suffix trap" below).

### Ownership: exactly one writer

`apply_local_day_rollover` (`src/zreport.rs`) is the **only** production
writer, and it writes inside its `BEGIN IMMEDIATE` transaction — the atomic
day rollover that also resets `sync.orders_since`, the order counter, and
clears the settled operational tables. The submission flow
(`prepare_z_report_submission` → `finalize_prepared_z_report_submission`,
driven by the renderer's `report:submit-z-report`) discards the freshly
generated Z row when the rollover fails, so "Z exists" and "day closed"
cannot diverge.

**Z generation is not a close.** `generate_z_report` produces a report row
and nothing more. This is load-bearing: `report_generate_z_report` (the
reports screen's preview) generates a real single-shift row and immediately
discards it via `discard_generated_z_report_by_id`. A marker write at
generation time would let a preview hide — and later prune — orders no Z
settled. Pinned by `test_preview_generate_and_discard_leaves_day_close_marker_untouched`
and `test_apply_local_day_rollover_advances_day_close_marker`.

### Readers: one derivation, two consumers

`business_day::retention_cutoff_utc` derives the retention boundary:

1. Read the marker (`stored_period_start`).
2. Floor it to `MIN(check_in_time)` of the still-active shifts — an open
   shift keeps its whole day visible even across a Z that closed *other*
   shifts.
3. `None` (no Z has ever run on this terminal) means **no boundary**:
   unbounded view, no pruning.

Both consumers use that single function:

- **Orders view** — `sync::get_all_orders` shows everything at or after the
  cutoff (open table tabs are always shown regardless).
- **Local prune** — `commands/sync.rs` deletes strictly before the cutoff,
  and deletes nothing when the cutoff is `None`.

The view and the prune must never diverge: anything visible is retained,
anything retained is visible. Do not add a third consumer with its own
boundary arithmetic — call `retention_cutoff_utc`.

### "Settled by the last Z": the one reader that is deliberately not floored

The rollover cleanup deletes the closed day's `order_payments` on purpose
(`zreport.rs`, cleanup step 2) and keeps the order rows for the retention
view. After every Z the settled day therefore reads as **paid with no local
payment row** — the Z's footprint, not unsettled work.

`business_day::paid_order_swept_by_last_z_expr` names that footprint (paid,
created before the marker, no completed local payment) and two consumers
exclude it:

- **Checkout gate** — `payment_integrity::load_branch_window_payment_blockers`
  never reports such an order as `missing_local_payment_row`, whatever later
  touch (remote snapshot refresh, platform ack replay, status edit) bumped its
  `updated_at` into the open shift's window.
- **Payment-mirror sweep** — `sync::paid_orders_missing_local_mirror_candidates`
  never puts it back on the repair list, so the sweep no longer re-applies its
  remote snapshot every pass (which is exactly the touch that dragged closed
  days back into the gate).

This reader takes the raw marker (`business_day::last_z_anchor_utc`), not
the shift-floored cutoff: whether money was settled is decided at the Z
moment regardless of which colleagues' shifts stayed open, and the floor
exists to keep an open shift's day *visible*, never to reopen settled
money. A genuinely unpaid old order (`payment_status` ≠ `paid`) is still a
blocker — the Z sweeps payments, not debts. Pinned by
`branch_window_blockers_ignore_paid_orders_swept_by_the_last_z` and
`payment_mirror_sweep_skips_orders_settled_by_the_last_z`.

History: 05/09/2026, Το Μικρό Παρίσι — the 03:36Z Z closed the 04/09 day;
by the evening 16 of its orders blocked the shift checkout and the sweep
re-fetched 47 of them every two minutes.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Rollover transaction fails | Marker untouched, generated Z discarded, day stays open. |
| Z generated, submission never finalized | Marker untouched — the day is still open, orders stay. |
| Preview (generate + discard) | Marker untouched by design. |
| No Z ever ran (fresh terminal, dev) | Marker absent → unbounded view, zero pruning. |
| Marker present but all shifts closed | Cutoff = marker; settled history before it may prune. |
| Marker after an active shift's check-in | Cutoff floors to the check-in; the open day is fully visible. |

The failure direction is deliberately asymmetric: every fault keeps **more**
data visible, never less. The worst outcome of a broken close is one extra
settled day on screen.

## Suffix trap

`created_at` rows end in `+00:00`. Comparisons are lexicographic, and
`'+' < 'Z'`, so a `Z`-suffixed cutoff would wrongly exclude a row with the
exactly-equal second. `retention_cutoff_utc` therefore always emits
`+00:00`, and tests pin it.

## History

Until 1.4.67 the marker had no production writer on the single-shift path
that shops actually used day-to-day, and retention silently fell back to
clock boundaries (`business_day_start_utc_at_minutes`, default 07:00) —
which is how an open overnight shift's orders vanished at 07:00. Since
1.4.68 the clock-boundary helpers are `#[cfg(test)]`-gated: release code
cannot call them, and retention is Z-anchored everywhere. Remaining
clock-based *display* sites (analytics tiles, dashboard calendar filters)
are tracked as the flip-to-Z backlog; they read, they never delete.
