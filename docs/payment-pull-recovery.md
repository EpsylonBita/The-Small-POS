# Canonical payment pull and cross-till returns

Desktop payment pulls store the opaque `next_cursor` as `sync.payments_cursor`.
An existing `sync.payments_since` is used only until a nonempty page supplies a
cursor. An empty page never advances the checkpoint, including on the first pull.
The API owns `(updated_at, id)` ordering and its ten-second visibility horizon.
Order-specific admission reads use `GET /api/pos/payments?order_id=…` and do not
change the stream checkpoint.

SQLite migration 102 adds `payment_adjustments.imported_remote` and
`unresolved_remote_payments`. Each page and its cursor commit in one savepoint.
A missing parent or failed mirror is retained with its complete payload before
the cursor advances. At most 25 retained rows are retried each reconciliation,
with a five-minute cooldown. After six failed applications, the original stays
retained for explicit operator recovery. Financial Sync shows the retained count
and offers a snapshot-backed Retry payment downloads action. That action resumes
only incoming mirrors and reads fresh canonical rows; it never discards an
unknown receipt or retries an unrelated outgoing financial row. The sync status includes
`unresolvedRemotePayments` and includes that count in the existing localized
sync-error indication. Each retained row also carries its last error and attempt
count for support inspection. These are incoming canonical mirrors, never an
outgoing payment or a new charge. Exact authenticated parent reads can retire
retained history on verified closure. Closure evidence is saved under
sync.payments_closed_parent:<remote-order-id> so deliberately excluded parents
do not re-enter the retry journal. Compaction keeps at most 256 markers for
absent parents, plus markers for orders still stored locally. Once a local
parent is removed, its marker becomes eligible for eviction. Evicted history
is unknown: a later payment with no parent is retained until an authenticated
closure check verifies it again. Compaction also runs before each retained-row
sweep, so existing oversized caches shrink without another closure arriving.
At most two parents are read per pass, with
three-second request bounds; failed reads consume no application retry budget.

Canonical ordinary refunds and voids use their canonical adjustment id. The
server retains the submitted `adjustment_id`, so exact local originals dedupe by
that id and retain their attribution. Imports are applied locally without an
outgoing queue entry, drawer movement or courier cash debit. Refund admission
uses master's original refund arithmetic and refuses canonical final returns.
History includes imported adjustments. `canonical_return_status` is written only
by canonical import and keeps final-return evidence separate from a local
original's physical receipt status used for custody/Z. Financial readers use a
schema-guarded projection: a canonical void/full refund stops counting exactly
like a locally voided/refunded receipt. Fiscal and legacy schemas without
payment metadata retain master behavior and never query that column.

Master local behavior is the specification: completed receipt coverage subtracts
refund adjustments; voided and fully refunded receipts leave completed coverage.
Order status, due, remaining balance and settlement generations use that same
master logic. Imported partial refunds reduce coverage identically to local
refunds. Both `manual` and `edit_settlement` contexts are stored; coverage does
not introduce a new context-dependent policy. The earlier no-debt/collection
waiver policy is withdrawn.
The importer accepts only `manual` and `edit_settlement`; missing or null means
`manual`. Invalid contexts retain the payment for recovery. Re-pulls correct
the context of existing imported copies, while exact local originals keep
their provenance and conflicting explicit contexts are refused.
New or previously reconstructed returned receipts keep their final status as
non-counting history; only local originals retain their custody. Z refund/void
totals and order-type net exclude imported rows.

Gift Card adjustments remain owned by the dedicated original-card return
importer. Generic pulls exclude them. Dedicated recovery can atomically adopt
an exact adjustment left by an older generic pull, excluding that same return
from its own prior-return floor and preserving one adjustment id.

Financial Sync creates one pre-action snapshot per in-flight incoming retry.
The native recovery owner prunes these snapshots after seven days; the panel
does not retain a separate snapshot or closure-marker history.

Both native balance reads and ordinary refund/void commands refresh the order's
canonical ledger when the native network probe is online. A refresh failure
blocks admission. Offline admission uses the durable local ledger. This read is
not an atomic cross-terminal reservation: two disconnected or racing tills still
depend on server-side adjustment admission for final reconciliation.
