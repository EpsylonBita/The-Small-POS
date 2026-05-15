# POS Tauri Offline Store Schema And Migrations

Last reviewed: 2026-05-12

Linear: THE-97

## Scope

This document describes the current Tauri 2 desktop POS runtime only. It does
not use the retired Electron-based POS planning as a source of truth.

<!--
  Phrasing note: this paragraph originally used the legacy Electron-POS
  identifier in backticks. The repo's identifier policy script
  (scripts/check-platform-identifier-policy.mjs) forbids that literal
  token outside an allowlist of compatibility/migration code, so the doc
  was rephrased on 2026-05-15. The intent ("don't trust the retired
  Electron POS planning") is unchanged.
-->

Primary source files:

- [`../src-tauri/src/db.rs`](../src-tauri/src/db.rs): SQLite schema and migration chain.
- [`../src-tauri/src/sync.rs`](../src-tauri/src/sync.rs): order, payment, financial, Z-report, and remote snapshot sync paths.
- [`../src-tauri/src/sync_queue.rs`](../src-tauri/src/sync_queue.rs): canonical parity replay queue and conflict audit handling.
- [`../src-tauri/src/storage.rs`](../src-tauri/src/storage.rs): OS keyring-backed terminal credentials.
- [`../src-tauri/src/commands/menu.rs`](../src-tauri/src/commands/menu.rs), [`../src-tauri/src/commands/branch_data.rs`](../src-tauri/src/commands/branch_data.rs), and [`../src-tauri/src/commands/offline_mutations.rs`](../src-tauri/src/commands/offline_mutations.rs): local-first producers for catalog, operations, and vertical-specific mutations.
- [`../../admin-dashboard/src/app/api/pos`](../../admin-dashboard/src/app/api/pos): terminal-authenticated admin API contract.

## Migration Model

The local SQLite schema version is `CURRENT_SCHEMA_VERSION = 61`. Startup runs
`run_migrations()` sequentially and records progress in `schema_version`.
Migrations are written to be re-entrant where practical using `column_exists`,
`CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS`.

Important upgrade facts for installed terminals:

- v44 creates `parity_sync_queue` and `conflict_audit_log`.
- v47 through v50 add entity idempotency keys and active queue indexes.
- v51 through v54 add integer-cent monetary shadow columns and repair paths.
- v55 drops `orders.payment_method`; reads derive payment method from payments.
- v56 adds `parity_sync_queue.claim_generation` and has a backfill guard for terminals already reporting schema v56 without the column.
- v60 adds `top_sellers_rolling` so reporting survives local order cleanup.
- v61 adds `orders.owner_terminal_id` and `orders.source_terminal_id` indexes for terminal ownership and transfer behavior.

Any future migration that changes queue, payment, order, or terminal identity
columns must preserve queued replay semantics across an app update. Do not drop
or rename those columns until queued rows are drained, rewritten, or explicitly
migrated.

## Local Store Inventory

| Local table/state | Owner path | Purpose | Remote/admin contract | Conflict and idempotency expectation |
| --- | --- | --- | --- | --- |
| `local_settings` | `db.rs`, `settings.rs`, `storage.rs` | Non-secret runtime settings, terminal metadata fallback, sync cursors, cached flags. | POS settings/bootstrap endpoints such as `/api/pos/settings/{terminal_id}` and `/api/pos/modules/enabled`. | Not a secret store. Sensitive values should live in the OS keyring and be scrubbed from SQLite compatibility rows. |
| OS keyring credentials | `storage.rs` | `admin_dashboard_url`, `terminal_id`, `pos_api_key`, `branch_id`, `organization_id`, Supabase config, and session blobs. | All terminal-authenticated POS API calls. | Terminal credentials are runtime prerequisites. Missing `terminal_id` or API key blocks replay instead of silently using admin bearer identity. |
| `orders` | `sync.rs`, `commands/orders.rs` | Local order source of truth while offline; stores Supabase mapping, payment status, branch, terminal, ownership, and local sync status. | `/api/pos/orders`, `/api/pos/orders/sync`, status and reconciliation endpoints. | Use stable client/order identifiers and idempotency fields. Non-monetary updates are generally server-wins; payment-total and stale-parent cases require blocking or repair. |
| `order_payments`, `payment_items`, `payment_adjustments` | `sync.rs`, `payments` commands, `sync_queue.rs` | Payment rows, split tenders, void/refund/adjustment state, and local payment sync metadata. | `/api/pos/payments`, `/api/pos/payments/adjustments/sync`, `/api/pos/financial/sync`. | Manual review for monetary conflicts. Parent order repair must rewrite local order IDs to Supabase IDs before replay. |
| `staff_shifts`, `cash_drawer_sessions`, `shift_expenses`, `driver_earnings`, `z_reports` | `sync.rs`, shift and analytics commands | Shift lifecycle, drawer closeout, expenses, delivery earnings, Z-report submission, and financial evidence. | `/api/pos/shifts/sync`, `/api/pos/financial/sync`, `/api/pos/z-report/submit`. | Active-shift and closeout conflicts are blocking. Historical financial ownership must not be overwritten by a newer remote snapshot. |
| `menu_cache` | `menu.rs`, branch data loaders | Local cached menu and branch data for offline ordering and catalog screens. | `/api/pos/menu-sync`, `/api/pos/sync/menu_categories/{id}`, `/api/pos/sync/subcategories/{id}`, `/api/pos/sync/ingredients/{id}`, `/api/menu/combos/{id}`. | Remote catalog remains authoritative. Local catalog edits use `module_type = catalog` and `conflict_strategy = manual`. |
| `branch_ops_cache` | `branch_data.rs`, offline mutation commands | Cached branch datasets such as inventory, coupons, reservations, appointments, rooms, housekeeping, and POS settings. | `/api/pos/inventory`, `/api/pos/coupons`, `/api/pos/reservations`, `/api/pos/appointments`, `/api/pos/rooms`, `/api/pos/housekeeping`, `/api/pos/settings/{terminal_id}`. | Local cache patching keeps the UI usable offline; replay is owned by `parity_sync_queue`. Conflicts should preserve operator-visible cache state until resolved. |
| `parity_sync_queue` | `sync_queue.rs` | Canonical generic offline replay queue for current producers. Stores `table_name`, `record_id`, operation, JSON payload, org, priority, module type, conflict strategy, version, status, retry timing, and `claim_generation`. | Dispatches to table-specific POS endpoints through `prepare_request()` and endpoint resolvers. | Status is `pending`, `processing`, `failed`, or `conflict`. 429 and transient failures retry with backoff. 409, 412, and explicit version-conflict responses park rows in `conflict`. |
| `conflict_audit_log` | `sync_queue.rs` | Durable audit trail for detected replay conflicts. | Read by diagnostics/recovery surfaces; complements server-side audit events. | Record local/server versions, payload, monetary flag, resolution strategy, and reviewed state without storing secrets. |
| `sync_queue` | `sync.rs`, compatibility guards | Legacy queue table still referenced by financial/order guard and repair paths. New generic producers should use `parity_sync_queue`. | Older order/financial sync endpoints and status checks. | Treat as compatibility/drain state. Future migration work must account for both queues until all legacy references are removed. |
| `print_jobs`, `printer_profiles`, `ecr_devices`, `ecr_transactions`, `caller_id_log` | printer, ECR, caller ID commands | Local hardware durability and diagnostics. | Mostly local or settings/admin diagnostics. | Not part of business replay ordering, but must not be lost during schema rebuilds. |
| `loyalty_settings`, `loyalty_customers`, `loyalty_transactions` | branch data and sync paths | Offline loyalty config, customers, and transaction replay. | `/api/pos/loyalty/sync` and related branch data loaders. | Loyalty transactions need order/customer context and idempotent replay keys. |
| `top_sellers_rolling` | analytics commands | Local rolling sales aggregates after local order cleanup. | Analytics/reporting views. | Derived state; rebuildable from retained order/reporting evidence where available. |

## Queue Operation Format

Current producers enqueue into `parity_sync_queue` through
`sync_queue::enqueue_payload_item()` or `EnqueueInput`. Required fields are:

- `table_name`: semantic dispatch key, not always the SQLite table name. Example: payment rows dispatch with `table_name = "payments"` although the local table is `order_payments`.
- `record_id`: entity-stable local or remote identifier.
- `operation`: `INSERT`, `UPDATE`, or `DELETE`.
- `data`: JSON payload containing the mutation and enough branch/org/terminal context to replay.
- `organization_id`: inferred from payload, `local_settings`, or keyring.
- `module_type`: retry and UI grouping such as `orders`, `payment`, `catalog`, `operations`, `inventory`, `promotions`, `hospitality`, `salon`, or `fast_food`.
- `conflict_strategy`: usually `server-wins` for operational order/status updates and `manual` for catalog, inventory, promotions, hospitality, salon, and monetary paths.
- `version`: optional optimistic-concurrency version used for conflict detection.

Replay prepares the request only after terminal context is available. It sends
`x-pos-api-key` and `x-terminal-id`; strict POS endpoints must not rely on an
admin bearer token as a substitute for terminal identity.

## API Mapping

The dispatcher resolves local mutations to current admin-dashboard POS APIs:

| Queue entity | Endpoint family |
| --- | --- |
| `orders` | `/api/pos/orders`, `/api/pos/orders/{id}`, `/api/pos/orders/sync` |
| `payments` | `/api/pos/payments` |
| `payment_adjustments` | `/api/pos/payments/adjustments/sync` |
| `staff_shifts` | `/api/pos/shifts/sync` |
| `driver_earnings`, `shift_expenses`, `staff_payments` | `/api/pos/financial/sync` |
| `z_reports` | `/api/pos/z-report/submit` |
| `loyalty_transactions` | `/api/pos/loyalty/sync` |
| `menu_categories`, `menu_subcategories`, `menu_ingredients`, `menu_combos` | `/api/pos/sync/*` or `/api/menu/combos/{id}` |
| `inventory_adjustments`, `products` | `/api/pos/inventory`, `/api/pos/products/{id}` |
| `coupons` | `/api/pos/coupons`, `/api/pos/coupons/{id}` |
| `reservations`, `appointments` | `/api/pos/reservations*`, `/api/pos/appointments*` |
| `restaurant_tables` | `/api/pos/sync/restaurant_tables/{id}` through generic POS sync routing |
| `drive_thru_orders` | `/api/pos/drive-through` |
| `rooms`, `housekeeping_tasks` | `/api/pos/rooms/{id}`, `/api/pos/housekeeping/{id}` |
| `customers`, `customer_addresses` | `/api/pos/customers*` |

Module visibility is not stored as ad hoc POS configuration. The server source
of truth is `vertical_modules`; purchased modules live in
`organization_modules`; terminal filtering is in
`pos_terminal_settings.enabled_modules` and is exposed through
`/api/pos/modules/enabled`.

## Conflict Expectations

- Orders: keep local creation usable offline. Status and non-monetary updates may use server-wins when replaying, but stale parent records, remote rollover, and total/payment mismatches need repair or operator review.
- Payments and financial closeout: monetary conflicts are never silently accepted. Rows can be deferred while parent order or shift rows are still pending.
- Menu/catalog: remote catalog is authoritative; local catalog changes use manual conflict handling.
- Inventory, coupons, reservations, appointments, rooms, and housekeeping: cached local changes keep vertical screens usable offline; conflicts should park in `conflict` until an operator can reconcile.
- Terminal settings/modules/credentials: missing or revoked terminal identity is a blocking configuration problem, not a recoverable queue retry.
- Rate limiting and server/network errors: 429 and transient failures remain pending with retry backoff; client errors that are not recognized conflicts fail fast.

## Upgrade Risks

1. Dual queue state: code still checks both `parity_sync_queue` and legacy `sync_queue`. Migration work must not assume only one table exists until compatibility references are removed.
2. Credential split: keyring is authoritative for secrets, while `local_settings` is a fallback for non-secret terminal metadata. Factory reset and bootstrap flows must update both correctly and scrub sensitive rows.
3. Payment derivation: `orders.payment_method` no longer exists after v55. New code must call payment derivation helpers instead of writing that column.
4. `claim_generation`: stale async acknowledgements can corrupt queue status if generation is not preserved.
5. Monetary columns: float and integer-cent columns coexist for compatibility. New monetary logic should write cents and keep repair/backfill behavior in mind.
6. Terminal ownership: order handoff and source/owner terminal fields affect remote snapshot reconciliation.
7. Reporting after cleanup: local order cleanup must not erase data needed by `top_sellers_rolling`, Z-reports, or financial evidence.

## Checklist For New Offline Entities

Before adding another offline-capable entity:

1. Add or verify the local table/cache and migration.
2. Define the semantic `table_name`, idempotency key, and stable `record_id`.
3. Include `organization_id`, `branch_id`, and terminal context in the payload or resolvable runtime state.
4. Add a `parity_sync_queue` producer with priority, `module_type`, `conflict_strategy`, and version expectations.
5. Map the entity to a strict terminal-authenticated admin API endpoint.
6. Decide whether conflicts are server-wins, manual, or blocking.
7. Surface queue status and conflict state in renderer recovery/diagnostics.
8. Add regression coverage for offline create/update, reconnect replay, duplicate retry, and conflict classification.
