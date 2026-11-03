# SQLite write transaction admission

## Why reserve the writer before reading

On 21/10/2026, the Tomikro `checkout_save_storage_busy` incident demonstrated the SQLite DEFERRED read-to-write upgrade trap. After a transaction establishes a read snapshot, another connection can acquire the writer reservation. An attempted upgrade can then fail immediately with `SQLITE_BUSY`, regardless of `busy_timeout`; in WAL mode an obsolete snapshot can also produce `SQLITE_BUSY_SNAPSHOT`. Increasing the timeout does not make that upgrade safe. The transaction must end and restart with a fresh snapshot.

`BEGIN IMMEDIATE` obtains the writer reservation before the transaction's first read. Contention is handled at admission through the connection's existing busy handler/timeout, so subsequent reads and writes use a snapshot whose writer reservation is already held. Admission can still time out; this is not an unlimited retry or a guarantee against every SQLite busy condition.

## Rule

- Use `crate::db::immediate_transaction` for business transactions that may write. It calls `Transaction::new_unchecked` with `TransactionBehavior::Immediate`, preserves the caller's busy timeout, and returns the existing RAII transaction type.
- For a SAVEPOINT scope that may be outermost, use `crate::db::with_immediate_admission` immediately around the existing scope. An outermost SAVEPOINT otherwise starts a DEFERRED transaction. The helper reserves and commits only when the connection was in autocommit; errors roll back its owned reservation on drop. Existing nested savepoint rollback and caller commit ownership remain intact.
- An existing caller transaction must itself have appropriate write admission. The wrapper cannot retroactively upgrade a caller's already established DEFERRED snapshot safely. Keep network requests, device operations and idle work outside the reserved scope.
- Keep genuinely read-only snapshots DEFERRED. DDL-first historical migrations below already request write access before any transactional data read.

The inventory contains 54 production admission sites plus one test-only site in 53 functions across 21 files: 46 default transaction replacements and nine conditional SAVEPOINT wrappers. Paths in the next tables are relative to `pos-tauri/src-tauri/src/`. Some audited sites already write first, or perform their validation reads before admission; those are marked explicitly. They were standardized to prevent future read-before-write changes from recreating the race. This change does not move those pre-admission reads into the transaction or claim to fix their separate consistency semantics.

## Keep the reservation DB-only

Capture credential-derived scope before admission, under the existing terminal-binding lease. Pass that immutable scope to DB-only helpers and revalidate its SQLite identity/version after admission, together with the validation and writes. No keyring, filesystem, network or device work belongs between admission and commit. Capture page files are written and validated first; a per-capture lifecycle guard fences replacement/discard through commit, and the admitted page helper accesses only SQLite.

Immutable empty inputs return before admission. State-dependent cached, unchanged, stale or refused outcomes use a short read-only probe that ends its snapshot. A mutation then starts a fresh IMMEDIATE transaction and repeats every decision read. Never upgrade the probe's DEFERRED snapshot. SAVEPOINT callers probe only in autocommit and preserve caller-owned transactions.

Clean-cache customer/repair purge and sensitive-settings scrub also probe first. Startup binding reconciliation still runs through setup/block_on; moving that pre-existing orchestration off the window thread remains a separate follow-up.

## Changed default transaction sites (45 production, one test-only)

| File | Function / site | Read and write sequence / reason for immediate admission |
| --- | --- | --- |
| `commands/orders.rs` | `convert_pickup_order_to_delivery_inner` | Resolves and validates the order before admission, then updates delivery fields and queues the change; currently write-first inside the transaction, standardized defensively. |
| `commands/orders.rs` | `update_customer_headers_in_connection` | Reads scoped header/edit proof before admission, then applies header changes, audit evidence and sync intent; standardizes the write boundary. |
| `commands/orders.rs` | `try_metadata_only_item_edit` | Reads edit eligibility and wire version, then changes headers/notes and queues the edit; standardizes admission even when a branch writes first. |
| `commands/orders.rs` | `order_update_items` | Reads order identity, ownership and version inside the durable edit transaction before persisting the edit and queue entry. |
| `commands/orders.rs` | `persist_fetched_food_order_items` | Updates fetched items before releasing waiting print work; currently write-first, standardized defensively. |
| `commands/orders.rs` | `order_cancel_with_approval` | Applies a canonical response through snapshot reconciliation and retires attempts/cache entries before updating cancellation evidence; delegated reads and writes share the reservation. |
| `commands/orders.rs` | `change_order_driver_locally` | Reads the driver-change plan before moving order/payment ownership, earnings and sync work. |
| `commands/orders.rs` | `reset_order_to_active_locally` | Reconciles cashier/driver ownership and earnings from existing state before resetting the order and queuing it. |
| `commands/analytics.rs` | `driver_record_earning_inner` | Resolves the driver's active shift before assigning ownership, upserting the earning and refreshing its sync row. |
| `commands/ecr.rs` | `persist_fiscal_receipt_transaction_and_enqueue_backfill` | Inserts the fiscal transaction first, then reads order status before receipt/backfill updates; currently write-first, standardized defensively. |
| `payments.rs` | `update_payment_method_for_payment_with_actor` / snapshot fallback | Reads fallback eligibility before admission, then updates the order and enqueues its payment snapshot; currently write-first inside, standardized defensively. |
| `payments.rs` | `update_payment_method_for_payment_with_actor` / same method | Reconciles driver earnings and reads queue retry state before refreshing pending payment sync work. |
| `payments.rs` | `update_payment_method_for_payment_with_actor` / changed method | Updates payment method first, then reconciles ownership, earnings and sync state; currently write-first, standardized defensively. |
| `table_attempt_recovery.rs` | `claim` | Reads legacy table existence and recovery state before importing legacy attempts and claiming work. |
| `table_attempt_recovery.rs` | `finish` | Reads the exact processing generation before applying the canonical response and updating recovery status. |
| `table_attempt_recovery.rs` | `apply_foreground_item_snapshot` | Canonical snapshot application reads/reconciles local state before retiring the foreground attempt. |
| `table_attempt_recovery.rs` | `claim_original_cancel` | Reads the immutable original recovery state before claiming its next generation and recording evidence. |
| `table_close_recovery.rs` | `finish_confirmation` | Re-reads the original queued close before inserting confirmation audit and removing the exact failed queue row. |
| `table_manual_cancellation.rs` | `release` | Reads refusal/order evidence before admission, then releases the intent and records manager evidence; currently write-first inside, standardized defensively. |
| `table_session_cache.rs` | `item_edit_attempt` | Delegates scoped attempt checks/persistence and remembers recovery intent in one transaction. |
| `table_session_cache.rs` | `cancellation_attempt` | Delegates scoped cancellation identity/attempt checks before persisting the attempt and recovery intent. |
| `lan_transport.rs` | `schema` | Reads schema currency before admission, then creates journal tables; currently DDL-first inside, standardized defensively. |
| `lan_transport.rs` | `admit_frame` | Deletes expired nonces and inserts replay protection; currently write-first, standardized defensively. |
| `lan_transport.rs` | `begin_receipt` | Reads an existing receipt/hash/state before inserting or reclaiming the durable request receipt. |
| `lan_transport.rs` | `clear_journal` | Deletes child journal state; currently write-first, standardized defensively. |
| `lan_transport.rs` | `relay` | Applies a canonical response through domain reconciliation before committing durable relay state; delegated reads and writes need one reservation. |
| `lan_transport.rs` | `relay_read` | Although the remote request is a read, local canonical application reconciles and writes cached domain state. |
| `commands/gift_cards.rs` | `import_canonical_gift_payment` | Mirrors canonical payment using existing local identity/ledger state before marking the redemption attempt applied. |
| `commands/gift_card_returns.rs` | `adopt` | Reads the pending return record and rechecks the original payment before adopting canonical return proof. |
| `commands/api_bridge.rs` | `purge_customer_admin_cache` | Scans cached setting keys before deleting customer-route answers. |
| `commands/api_bridge.rs` | `purge_repair_admin_cache` | Scans cached setting keys before deleting legacy repair-route answers. |
| `commands/loyalty.rs` | `replace_loyalty_snapshot` | Reads pending loyalty work inside admission before replacing the organization's cached customers. |
| `menu.rs` | `apply_menu_payload` | Reads current cache-version row counts before upserting menu sections and branch overrides. |
| `terminal_helpers.rs` | `cache_terminal_settings_snapshot` | Can read the branch mirror before storing timezone settings; other branches write first, so all share immediate admission. |
| `terminal_helpers.rs` | `scrub_sensitive_local_settings_checked` | Collects sensitive setting keys before admission, then deletes them; currently write-first inside, standardized defensively. |
| `commands/settings.rs` | `apply_generic_settings_updates_checked` (`#[cfg(test)]` only) | Validates input before admission, then upserts settings; currently write-first, standardized defensively. |
| `commands/settings.rs` | `restore_generic_sqlite_snapshot` | Restores a previously captured snapshot by upsert/delete; currently write-first, standardized defensively. |
| `commands/settings.rs` | `apply_generic_settings_and_credentials_under_lock` | Coordinates previously captured credential/settings state with SQLite upserts; currently write-first inside, standardized defensively. |
| `commands/settings.rs` | `persist_terminal_transition_intent` | Persists encoded transition intent and pending marker; currently write-first, standardized defensively. |
| `commands/settings.rs` | `clear_terminal_transition_journal_verified` | Deletes transition markers, commits, then verifies absence; currently write-first, standardized defensively. |
| `commands/settings.rs` | `publish_terminal_binding_under_lock` | Publishes the validated binding mirror with setting upserts, then verifies it after commit; currently write-first, standardized defensively. |
| `commands/settings.rs` | `clear_terminal_connection_lifecycle_under_lock` | Deletes the connection mirror and verifies absence after commit; currently write-first, standardized defensively. |
| `capture/watcher.rs` | `ingest_document` | Creates the capture document before recording pages/status/events; currently write-first, standardized defensively. |
| `capture/watcher.rs` | `record_rendered_pages` (from `capture_attach_rendered_pages`) | Records rendered pages and updates status/events; currently write-first, standardized defensively. |
| `sync.rs` | `reconcile_remote_orders` | Delegates deletion eligibility/state checks before deleting the local order and related durable state. |
| `sync.rs` | `defer_financial_server_retry` | Reads the existing retry delay/status before updating backoff and retry time. |

## Changed outermost SAVEPOINT sites (9)

| File | Function | Read and write sequence / reason for conditional immediate admission |
| --- | --- | --- |
| `edit_settlement_recovery.rs` | `adopt_canonical_order` | Reads scope, original order and adoption proof before applying the canonical snapshot and recording adoption evidence. |
| `payment_review.rs` | `with_savepoint` | Shared review scope lets payment set-aside/resolve and unsaved-payment/TWINT retry bodies inspect originals before changing ledger, review and queue state. |
| `commands/offline_mutations.rs` | `persist_reservation_mutation` | Reads scoped local/server reservation identity before upserting identity and enqueuing the mutation. |
| `commands/offline_mutations.rs` | `mutate_staff_schedule_locally` | Enqueues first, then reads and rewrites the branch schedule cache; currently write-first, standardized because the savepoint can be outermost. |
| `sync.rs` | `mark_local_payment_applied` | Reads the payment's order before marking payment/queue applied and recomputing the order snapshot. |
| `sync.rs` | `sync_remote_payment_into_local_with_context` | Reads local canonical-payment identity/state before mirroring payment/adjustments and clearing unresolved evidence. |
| `sync.rs` | `apply_remote_payment_page` | Each row reads local identity/ledger state before applying or retaining it; the page also writes its cursor atomically. |
| `sync.rs` | `apply_refund_payment_ledger` (from `refresh_canonical_payments_for_refund`) | After the remote fetch, reads/reconciles local payment mirrors before refund admission can use the refreshed ledger. |
| `sync.rs` | `apply_order_payment_ledger_before_payment_decision` | Reads/reconciles matching canonical payments before restoring ledger state used by the payment decision. |

## Retained DEFERRED read-only paths

| File | Function / branch | Why DEFERRED stays |
| --- | --- | --- |
| `commands/payments.rs` | `load_order_settlement_read_transaction` | Reads settlement state and ends with COMMIT/ROLLBACK; no write upgrade. |
| `payments.rs` | `get_order_settlement_snapshot` | Builds a consistent settlement read snapshot and ends it; no mutation. |
| `print.rs` | `with_print_queue_read_snapshot` / in-memory | Wraps the print projection in a read snapshot; the callback performs reads only. |
| `print.rs` | `with_print_queue_read_snapshot` / file-backed | Uses a dedicated READ_ONLY connection with `PRAGMA query_only = ON`; the snapshot cannot write. |

## Retained DDL-first migration transactions

These historical `BEGIN; ... COMMIT;` blocks in `db.rs` have no data SELECT between BEGIN and their first schema write. Their first DDL requests the writer reservation directly, so they do not perform a DEFERRED data-read snapshot upgrade. Reads made before BEGIN are outside that transaction. The reason for retaining them does not depend on a remote-support critical-operation guard.

| File | Function | First write after BEGIN / reason to retain |
| --- | --- | --- |
| `db.rs` | `migrate_v11` | `CREATE TABLE IF NOT EXISTS z_reports`; schema write precedes data reads. |
| `db.rs` | `migrate_v16` | `CREATE TABLE printer_profiles_new`; schema write precedes copy reads. |
| `db.rs` | `migrate_v18` | `CREATE TABLE IF NOT EXISTS print_jobs_v18`; schema write precedes copy reads. |
| `db.rs` | `migrate_v20` | `CREATE TABLE printer_profiles_v20`; schema write precedes copy reads. |
| `db.rs` | `migrate_v24` | `DROP TABLE IF EXISTS print_jobs_v24`, then CREATE; schema writes precede copy reads. |
| `db.rs` | `migrate_v28` | `DROP TABLE IF EXISTS print_jobs_v28`, then CREATE; schema writes precede copy reads. |
| `db.rs` | `migrate_v30` | `CREATE INDEX IF NOT EXISTS idx_orders_supabase_id`; index creation is the first write operation. |
| `db.rs` | `migrate_v31` | `CREATE TABLE IF NOT EXISTS payment_items`; schema write precedes data reads. |
| `db.rs` | `migrate_v34` | Creates the replacement print-jobs table before copying its rows. |
| `db.rs` | `migrate_v36` | `CREATE TABLE order_payments_v36`; schema write precedes copy reads. |
| `db.rs` | `migrate_v40` | `CREATE TABLE IF NOT EXISTS branch_ops_cache`; schema write precedes data reads. |

SQL trigger-body `BEGIN` tokens are not transaction admission. Existing explicit IMMEDIATE checkout, money, shift and Z paths are unchanged. Remaining default transaction calls in gift-financial, repair, queue, print/Z and table test fixtures simulate caller transactions and are not production exceptions.

## Regression coverage

`support/tests/transaction_admission_tests.rs` pins all 55 admissions across the 53 inventoried functions with syntax-tree checks. Its file-backed WAL reproduction establishes a DEFERRED read snapshot, holds a writer on a second connection, and observes a busy refusal in under 250 ms despite a two-second busy timeout. It then checks that the common immediate helpers wait for the writer and commit using fresh state. A third test checks nested savepoint rollback and caller commit ownership. These are shared admission regressions, not 55 independently seeded business workflows.

The inventory tests live under the support test directory but call no support-module API. Additional production-family regressions live in `src-tauri/src/admission_tests/` and beside the LAN/close/folio tests. They use file-backed WAL and the production 5000 ms timeout: a second connection holds IMMEDIATE while no-op outcomes return within 250 ms with unchanged `total_changes`; eligibility changes between probe and admission must be re-read. Paused credential and page-validation seams let a separate checkout connection reserve and commit within 250 ms. The capture tests also cover absent files, discarded documents, lifecycle fencing and the actual image-ingest/rendered-page recording paths. The syntax inventory follows the extracted `record_rendered_pages` and `apply_refund_payment_ledger` production helpers and rejects external reads in the scoped DB-only helpers.

## Scope

This change covers the desktop app only. Android (`POSSystemMobile/`) is not part of it; its transaction admission is a separate review. The worker inventories behind the tables above are in `output/agent-runs/pos-support-mcp-20261031/` (`wDR2-immediate-paths.json`, `wDR2-savepoint-paths.json`, `wDR2-report.md`).
