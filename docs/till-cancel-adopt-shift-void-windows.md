# Windows: refused order status and empty check-in recovery

Added 15 November 2026 after the Tomikro efood cancellation incident. No production support command is executed by this change.

## Refused order status owner

`src-tauri/src/order_state.rs` owns eligibility, server-state fetch and adoption.
Only the status UPDATE payload emitted by the Windows status/approval producers
is admitted: `orderId`, `status`, optional `estimatedTime`/`estimated_time` and
the producer's `organization_id` routing envelope (which must match native scope).
Items, customer, monetary and settlement payloads fail closed. Repair settlements,
foreign scope, processing/conflict rows, set-aside evidence and outstanding money
or other order-related work also block adoption.

The shipped normal remote materializer leaves the order's organization column
unset. Those legacy platform copies require the current branch, matching native
organization on every queue row, and the authenticated server response for the
exact server id. Adoption does not rewrite their tenant or terminal identity.

The order owner calls `sync::apply_authoritative_order_state`, which uses the
normal `apply_remote_orders_page_inner` implementation with an explicit authority
override. This permits the server timestamp to precede a refused local tap. It
does not rewrite items, totals, payment amounts or payment methods. Local payment
state is supplied to the pull owner; normal ledger consistency behavior remains.
Version, remote version, server update time and cancellation fields are applied.

Migration 108 adds `orders.cancelled_at` and extends the parity queue CHECK with
`superseded`. Existing rows, indexes and triggers survive the queue upgrade. The
retained row keeps its payload, attempts and refusal. Its claim generation advances
and its next retry is cleared. Queue totals, oldest age, failed counts, outstanding
order checks, closeout counts and manual retries exclude the terminal state.

HTTP 400 transition refusals (typed code or legacy prefix) attempt adoption
immediately. Ordinary background queue passes, including the startup pass, claim
at most 20 eligible orders, scanning at most 200 candidates, with a durable
10-minute cooldown per order. HTTP 408/429 never qualify. Server status must be
cancelled/canceled for automatic adoption. Automatic repair snapshots use the
existing pre-recovery snapshot owner; business writes use a private connection
and the critical-operation gate. A remote pull cancellation invokes the same
adoption owner rather than skipping behind refused status-only rows. Pull apply
failures keep the page retryable.

Committed adoption publishes the normal `order_realtime_update` and
`order_status_updated` events. A local observation marker bridges queue processing
to the sync event sink and survives a restart.

## Confirmed actions

`confirmed_state_actions.rs` implements the new closed actions through the
existing confirmed admission, intent, snapshot, row-cap, event and history paths.
HTTP runs outside the business writer and checkout mutex. The writer transaction
rechecks scope, the snapshot watermark, critical priority and eligibility.

An ordinary Windows cashier check-in writes exactly `staff_shifts`, its
`cash_drawer_sessions` row and its own parity shift-open INSERT. There is no
separate attendance/time-clock insert or login/PIN write. Opening a cashier can
also claim transferred cash-return staff: those links are activity and refuse a
void. All schema shift/drawer references, movement summaries, submitted closeout
coverage, gift/fiscal ownership and orphan queue references are checked. Other
activity or non-check-in/legacy queue work refuses with a typed reason.
A driver's/server's initial responsible-cashier link with zero starting cash is
check-in bookkeeping; borrowed starting cash and unfinished transfers refuse.

`shift.void_empty.v1` checks local eligibility and the row cap, obtains server
`deleted`/`already_absent`, then snapshots and deletes its own local check-in
records in one transaction. It verifies absence again after commit and returns
`shift_void` counts with unavailable undo. A transport-ambiguous server response
does not authorize local deletion; a later newly confirmed command can use the
server's idempotent `already_absent` response.
Once the server has answered successfully, a failure or preemption in the local
phase reports an unknown outcome rather than claiming that nothing changed.

`order.adopt_server_state.v1` fetches fresh server state before the snapshot and
uses the same owner for any supported server status. Every outstanding status row
must already be permanently refused. Evidence names retained queue rows and
before/after statuses; undo references the local snapshot only.

## SQL and redaction incident classes

Constant SQL is proven cell-free by SQLite and then executed by the existing
read-only query owner, including its function allowlist, SQL tail check and result
budgets. `SELECT 1 AS one` does not build a data replica. Schema uses a private
read-only metadata connection and never copies data or emits schema SQL/defaults/
trigger bodies/index expressions. Table queries retain the sanitized replica
boundary. Replica build timeout and database lock errors have distinct typed
native details rather than pretending that a constant query timed out.

Evidence PII substitution was a till-side cause of character masking: it indexed
every nonempty PII cell and replaced each substring. One-character placeholders
are now excluded from that index; known identities match whole values/tokens,
with Unicode case folding retained. Direct PII and secret fields remain masked
even for short values. Regressions include UUIDs, RFC3339 timestamps,
`HTTP_400_CLIENT_ERROR`, `server-wins`, short placeholders and genuine names.

## Closed refusal details

Both actions report refusals as `POLICY_REFUSED` with a closed `failure_detail_code`
(for example `SHIFT_NOT_EMPTY`, `ORDER_HAS_LOCAL_WORK`, `SERVER_ORDER_STATE_UNAVAILABLE`).
The list lives once in `shared/pos/support/evidence.ts` (`SUPPORT_FAILURE_DETAIL_CODES`),
is emitted into `shared/pos/support/generated/support-contracts.json`, and must equal
`support/evidence.rs::DETAILS` in the same order; the drift test
`every_closed_failure_detail_is_preserved_and_exception_text_is_never_a_detail` pins it.
Android raises the same labels from `emptyShiftVoid.ts` and `refusedOrderStatus.ts`.
After changing the actions or evidence shapes, regenerate with
`node shared/pos/support/scripts/emit-contracts.mjs` and, from `pos-tauri/`,
`node scripts/emit-confirmed-result-schema.cjs`.

## Tests

- `order_state::` (embedded): cancellation adoption, retained `superseded` rows,
  payment preservation, cooldown, scope and repair-payload refusals.
- `db::`: migration 108 keeps every queue row, index and trigger and rolls back cleanly.
- `support::tests::confirmed_tests`: void eligibility, server refusals, ambiguous
  server replies reported as unknown, row caps and adoption through the confirmed path.
- `support::tests::evidence_tests` and `replica_deadline_tests`: whole-value masking
  (UUIDs, timestamps, `HTTP_400_CLIENT_ERROR`, `server-wins`) and the constant-SQL path.
- `SupportConfirmed.test.tsx`: both action templates in six locales.

Run Rust tests with `CARGO_BUILD_JOBS=5` and a short `TMP`/`TEMP` (for example
`C:/Users/<you>/.cargo/tmp`): the long worktree temporary path breaks 16 Windows
snapshot-path tests.
