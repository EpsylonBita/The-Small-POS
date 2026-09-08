# POS workflow audit fixes — 8 September 2026

Scope: findings F01–F15 from the installed 1.4.104 test-store report, plus the System Health inconsistency reproduced at 10:14. Implementation branch: `codex/fix-pos-workflow-audit`. The installed application and live databases were not modified by these source changes.

## Acceptance and implementation

| Finding | Corrected behavior / owner | Regression evidence |
|---|---|---|
| F01 cash close | Native shift preview, close and recomputation count distinct orders; retain gross refunded receipts before subtracting cash refunds once; card refunds do not reduce drawer cash. The reported fixture closes at €115, net cash €15, card €19, order sales €34. | `workflow_audit_cashier_refund_and_split_payment_close_exactly_once`, cash-only/paying-drawer refund test |
| F02 table ownership | Allocation quantity survives decoration from local order data; proportional discounts use the full parent order. Partial transfers keep separate payment ownership. Whole moves update heading and native identity. Same-order split checks merge atomically; unrelated orders remain separate with an explanation. | Rendered table modal, ownership helper, session API and actual SQL transaction tests |
| F03 sync / health | Payment mirror follows queue failure, parent wait, backoff and explicit retry. A terminal HTTP422 has no automatic retry timestamp. System Health prioritizes payment failures even when older aggregate counters still say zero; past retry times are not advertised as future work. | Mock HTTP422 native test, mirror lifecycle tests, Health modal tests |
| F04 room arrival | Reuse and reload a covering booking, preserve its identity after partial failure, and advance confirmed arrival atomically with room occupancy. Non-billing arrival records occupancy only, with explicit operator copy; it creates no fictitious paid order. | Arrival recovery component/service tests; room status SQL rollback/replay tests |
| F05 payment method | Orders containing refund/void history show an actionable explanation before opening method editing. Existing native ledger guard remains. | Payment edit routing tests |
| F06 Unknown item | `_meta` is excluded from ingredient hydration and repricing. Metadata is not materialized as a sale customization. | Real MenuModal edit hydration test |
| F07 VAT | Recompute tax included in edited taxable item totals using the configured rate; do not reuse a previously rounded tax amount or add VAT again. Preserve explicit zero rates and exclude delivery/tips from this item base. | €4→€8→€4 at24% gives €0.77→€1.55→€0.77; discount and alias tests |
| F08 waiter shift | Normalize waiter role to the canonical `server` shift role in both renderer and native boundary. Unsupported roles show guidance. | Native check-in and StaffShiftModal tests |
| F09 appointments | A scheduled shift counts as availability; offered slots exclude breaks, appointments and past time. One day-grid query replaces guessed slots. Failed/loading availability cannot be selected. | Availability algorithm and actual GET route tests |
| F10 schedule | Create uses one durable UUID; edit/delete have real native queue and API handlers. Delete requires confirmation and planned status. Pending edits survive restart and a stale server read. | Renderer edit/delete, API replay/tenant checks, native restart/rollback/cache overlay tests |
| F11 reservations | Refresh query when switching Rooms/Tables; ignore stale tab responses. Display canonical branch wall-clock date/time consistently rather than converting through PC timezone. | Hook tab/race and date formatting tests |
| F12 validation | Validate guest/contact and stay dates, including calendar-day night counts; server rechecks availability for date-only edits. | Room utility, form and API tests |
| F13 room forms | Shared forms prefill bookings, permit edit/cancel before arrival, explain occupancy-only versus billed stays, and retain stable retry identity. Room edits also require pending/confirmed status at the actual write. Reservation status replay must not perform a room-wide financial checkout. | Component/service/API tests; additional expected-reservation atomic arrival guard |
| F14 modal usability | Order editor title/actions and search occupy separate rows. Cash completion stays outside the scrolling content. Settlement text has readable light/dark colors. | MenuModal tests; real cash submission verifies enabled state, €20 received/€1.50 change and fixed footer placement |
| F15 currency | Cash drawer variance badges use the configured currency formatter instead of a hard-coded dollar sign. | VarianceBadge renderer tests |

## Native identity and queue contracts

SQLite v81 adds `order_payments.table_session_id`, `seat_number` and `payment_items.order_item_id`. Upgrade backfills only explicit ownership from durable payment queue payloads. It never guesses a split payment's check from the order's current table. Retry payload rebuilding and remote hydration preserve these fields, and omitted server items/IDs do not erase existing item identity.

`orders:apply-table-session-snapshot` persists authoritative identity after open/move/merge without replacing full order items, totals or payment status. Canonicalization is scoped to the resolved order and preserves the protected repair boundary. Merges fence in-flight payment claims before retagging an unapplied operation; no second financial ledger is introduced.

The current desktop payment queue owner is `parity_sync_queue` (`payments`). The older `sync_queue` remains drain-only. Explicit retry is not proof a payment was accepted: a genuine server overpayment rejection stays visible until its cause is resolved.

## Rollout and remaining operational checks

Release 1.4.105 preparation: both SQL migrations were applied to the configured production project on 8 September 2026. Catalog checks confirmed the original 14-argument room check-in remains available alongside the guarded overload, and only `service_role` can execute the new functions. A rolled-back missing-booking call returned `ROOM_RESERVATION_REQUIRED`. The matching admin API must be live before the desktop release is distributed; installed workflow and shop-memory checks remain post-rollout acceptance work.

Deploy the new table/room database functions and matching admin API before distributing an updated POS. SQLite v81 applies on first startup of that updated client. See `ROOM_RESERVATION_WORKFLOW.md` for the room API contract and migrations. No live migration, API deployment, release publication or installation is implied by source verification.

The room migration retains the original 14-argument check-in RPC and adds an explicit 15-argument overload for expected booking identity. Older callers remain compatible. A pre-v81 POS refuses a database with the newer schema; downgrade must follow the established backup/recovery procedure rather than deleting operational data.

After rollout, repeat F01/F02 with fresh test orders and compare UI, SQLite and server before/after sync and restart. Recheck waiter check-in, schedule edit/delete, appointment creation and room arrival/edit/cancel against the deployed API. SQL tests use a disposable PostgreSQL-compatible schema; they do not prove production migration compatibility or multi-terminal concurrency.

The existing failed test payment is retained for diagnosis. It was not manually marked synced, and old test orders containing an already-persisted `Unknown` customization were not silently rewritten. The missing printer remains a setup issue; this change does not invent a printer or retry a financial collection automatically. Physical card terminals, printing and production Caller ID are outside this patch's verification.

## Verification results

Logs are under `D:/The-Small-002/output/pos-workflows-1.4.104-local`.

| Check | Result / log |
|---|---|
| Integrated renderer regressions | 90/90 across17 files, `all-audit-renderer.log` |
| Existing order/payment/table UI contracts | 69/69, `root-legacy-ui-final.log`; bundled using the repository's esbuild/node-test approach |
| Existing room/reservation UI contracts | 83/83, `room-legacy-ui.log` |
| Table and staff schedule APIs | 49/49, `root-api-integrated.log` |
| Room/reservation API and services | 51/51 plus32/32 route/module tests and8 snapshots, `room-api.log`, `room-api-contract.log` |
| Actual SQL transactions | Table merge rollback/replay/tenant/role tests passed; room status9/9 and guarded financial arrival13/13, `room-sql.log`, `room-checkin-sql.log` |
| Frontend and admin TypeScript | Passed, `final-build.log`, `admin-typecheck-final.log` |
| Production frontend build | Passed; existing large-chunk warnings remain, `final-build.log` |
| Locale and native command/event contracts | Passed with no missing keys or native registrations, `locale-parity-final.log`, `parity-contract.log` |
| Native broad run | 2,452 passed,3 test-fixture failures,1 existing ignored test, `native-full-final.log`. Failures were an outdated expected schema-version list, an incomplete legacy-schema fixture, and an in-memory fixture used for a file-backed upgrade. All were corrected and rerun below. |
| Native affected modules after final room queue integration | 368 passed,1 remaining historical-fixture failure,1 ignored, `native-recheck.log`. Includes real HTTP422 failure mirroring, payment ownership/upgrade, remote hydration, schedule restart, cashier close and expected-booking queue dispatch. |
| Final complete database module rerun | 68 passed,0 failures,1 existing ignored, `native-db-final.log`; resolves the last historical-fixture failure using a real later-schema database with its v56 gap removed. No identified failure remains unresolved. |

This verifies source behavior and isolated transactions. It does not claim a fresh installed-app workflow or memory measurement after this patch. The original installed1.4.104 report remains the baseline for the post-rollout test.
