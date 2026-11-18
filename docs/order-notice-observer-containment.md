# Order notice observer containment - 17 November 2026

The desktop order notice observer is optional to queue processing, Health, support, checkout and payment. Its failure is not an owner failure. Following the founder decision on 17 November evening, the delivery gate refuses both a known open notice (`ORDER_HAS_OPEN_NOTICE`) and an unreadable issue list (`ORDER_NOTICE_CHECK_UNAVAILABLE`). A read error holds only the requested final move, records value-free process evidence and never becomes proof that an issue was solved.

## Causes of the twelve reported failures

| Existing regression | Cause | Production fix |
| --- | --- | --- |
| `commands::diagnostics::main_thread_command_audit::no_tauri_command_is_a_synchronous_fn` | `order_notice_editing` was synchronous. | Async command, with its body in `run_blocking_command`. |
| `database_lock::tests::database_lock_every_site_uses_a_listed_literal_label` | `order_sync_notices` introduced an unregistered traced business-mutex site. | Removed the business-mutex acquisition altogether. The command now opens an independent read-only WAL connection; no new traced site or label remains. Existing label registration/guards are unchanged. |
| `support::matcher::tests::matcher_reads_retained_integrity_and_queues_while_business_mutex_is_held` | Optional notice failures were included in the owner's `readFailures`, making retained Health stale. | Separate `observerFailures`; existing Health/matcher observations retain their own freshness. |
| `support::tests::availability_tests::fast_ci_checkout_has_zero_support_held_lock_waits` | Same optional failure polluted the checkout Health observation. | Same separation and independent notice connection. |
| `support::tests::availability_tests::checkout_during_matcher_evaluation_has_zero_business_mutex_waits` | Same. | Same. |
| `support::tests::availability_tests::support_connection_refused_leaves_checkout_print_sync_and_health_available` | Same. | Same. |
| `support::tests::availability_tests::support_accepts_then_never_answers_leaves_checkout_print_sync_and_health_available` | Same. | Same. |
| `support::tests::availability_tests::unreachable_doorbell_uses_monotonic_polling_without_business_locks` | Same. | Same. |
| `support::tests::critical_op_tests::scripted_checkout_adds_no_support_work_or_support_held_lock_waits` | Same. | Same. |
| `tests::repair_transport::repair_attachment_queue_reconciles_authoritative_201_before_delete` | Generic queue success propagated the employee notice audit UPDATE's missing-table error. | Log and contain optional acknowledgement failure; the queue owner's success still completes. |
| `tests::repair_transport::repair_sync_queue_sends_one_native_staff_header_and_reconciles_before_delete` | Same. | Same. |
| `tests::repair_transport::repairs_p4_reattributed_replay_keeps_author_and_uses_current_header` | Same. | Same. |

No existing guard was changed, weakened or skipped. Repair fixtures were not changed. The coordinator's complete failing log is the before-fix evidence for all twelve regressions.

## Hook audit

- **Queue success and canonical header acknowledgement:** optional employee/header audit updates and response verification log sanitized failures without propagating them into queue processing. The normal canonical projection, generation, scope and queue checks still return their original errors. A failed notice verification is not recorded as healed.
- **Health and diagnostics:** notice/evidence reads use their own read-only WAL handle, zero busy timeout and a 100 ms query deadline. Missing schema/scope, read failures and busy databases produce `null` plus the matching `observerFailures` source. They do not add failures to the owner's `readFailures` or acquire its business mutex.
- **Support matcher:** still consumes the owner's retained Health. No matcher or availability guard changes were needed. An unavailable notice subsection does not stale unrelated observations.
- **Incident reporting:** `observerFailures: ["orderIssueEvidence"]` prevents ordinary order-issue fingerprints (and legacy order-issue fingerprints) from being cleared. The evening check-unavailable fingerprint instead uses its independent gate-read proof. General incidents continue to open/update/close from their own evidence. A failed observation does not imply that an order issue was solved.
- **Automatic attempt, claim and failure audit:** each attempt uses a private WAL write handle through the existing terminal-binding fence. Write admission has zero busy timeout, the existing critical-operation cancellation and deadline, and the original atomic audit/retirement/replacement transaction. Its transaction wrapper clears the progress cancellation handler before rollback, so cancellation cannot leave the SQLite writer reservation behind. The single worker retries interrupted-intent cleanup on later passes; it never replays an already claimed correction. Startup/scan/attempt errors are logged and contained in this worker, independently of sync processing. Helper timeout/progress settings no longer alter the business connection.
- **Manual recipes and employee attempt command:** private handles and non-waiting critical-operation write admission avoid support-held business mutexes. PIN/snapshot and exact manual recipe guards remain. Failure refuses only that requested remedy; it never changes a sale/payment result.
- **Order notice and editing commands:** async/blocking-pool wrappers. Reads never use a business mutex. Explicit failed notice reads remain errors to the notice store, which retains its last known state as stale/unavailable. Editing/deferred leaf observations use non-waiting mutex access.
- **Status writes, driver assignment and platform completion:** all still call the same gate under their existing transaction. A read error now refuses the final move with `ORDER_NOTICE_CHECK_UNAVAILABLE`; a successful nonempty read refuses it with `ORDER_HAS_OPEN_NOTICE`. Driver assignment keeps the assignment/custody/earning and holds only its embedded final move. Platform ready keeps ready/settlement and holds only its embedded final move. Payment, cancellation, earlier statuses and incoming updates remain outside the gate. The gate uses the existing write connection and transaction, adding no lock or wait.
- **Renderer recovery assistant:** an unavailable optional notice subsection no longer fails the general recovery view. An explicitly order-scoped recovery view still requires its own notice observation.
- **Renderer editing lease:** synchronous bridge throws and rejected promises are both contained and logged on mount/close. A missing/not-ready bridge no longer crashes the dashboard, checkout or order-details window. Existing mounted gift-return, BOX and food-item tests are unchanged.
- **Recipe telemetry:** both customer-correction recipes now have their exact `customer_correction_refused` mapping, matching the coordinator's newly extended shared manifest. The manifest and its tests were not edited by this worker.
- **Bulk status and recovery-panel wiring:** explicit payment-blocker returns are preserved for both pickup completion and delivery completion. The bulk helper retains the caller's result type and still continues past notice refusals. Order-specific recovery filtering happens when computing the issue result, leaving the panel's normal issues input intact. Existing parity guards are unchanged.
- **Reachability/event hooks:** atomic reachability updates and best-effort notifications have no database reads or fallible owner result. No extra work was added to payment, checkout or print paths.

Independent notice connections require WAL and do not fall back to the business connection on old/non-file/rollback-journal stores. Errors log a fixed site and sanitized machine code, without raw request values or database messages.

## Added regressions

- Failed notice read refuses delivered/completed with its own code and no status/outbox side effect; ready and valid cancellation pass (revised by the evening decision).
- Failed notice read does not block cash payment recording.
- Missing audit table does not fail queue acknowledgement.
- Observer reads proceed while the business mutex/write transaction is held; optional writes use zero busy timeout; critical checkout cancels an admitted helper write.
- Optional failures stay separate from Health's existing observations.
- The retained-observation capacity evicts one old source, not every source. Shared values are cloned outside the non-waiting leaf lock, preserving availability during independent observations.
- Failed evidence retains only order-issue reports while general reports can clear.
- General renderer recovery remains available with unavailable notice evidence.
- Editing-lease mount and close tolerate both synchronous and asynchronous bridge failure.

## Verification

All commands run sequentially, one heavy command at a time. Rust uses `CARGO_BUILD_JOBS=5` and `CARGO_TARGET_DIR=D:/trae/The-Small-002/pos-tauri/src-tauri/target`. The final native runs also use process-local `TEMP` and `TMP` set to `D:/trae/The-Small-002/pos-tauri/src-tauri/target/t`.

The first whole-library run was **5044 passed, 11 failed, 8 ignored** (1678.02 s); all original twelve failures passed. Its new lock regression exposed cancellation interrupting transaction rollback; the optional-write transaction wrapper fixes this. An existing retained-Health test observed missing content, addressed by moving copies outside the leaf lock and preserving other sources at capacity. Nine restore/startup tests failed at `VACUUM INTO`: the inherited `.cache/UI` temporary root produced a 252-character snapshot filename before SQLite's journal suffix. These existing tests pass with the shorter process-local test directory, without fixture or restore-production changes.

The focused rerun `cargo test --lib -- notice_containment diagnostics::support_observation_tests recovery::tests startup_recovery::tests` passed **135 tests, 0 failed, 4929 filtered out** (73.54 s). A preceding compilation caught the cache wrapper's mutable-value compatibility; that production interface was corrected without changing existing tests.

| Command | Result |
| --- | --- |
| `cargo fmt --check` | Passed |
| `cargo test --lib --no-fail-fast` | **5056 passed, 0 failed, 8 ignored, 0 filtered out**, 1618.96 s |
| `CI=true npm run test:unit` | **498 files, 6156 tests passed, 0 failed**, 296.07 s |
| `npm test` | **1547 passed, 0 failed**, 8099.6035 ms |
| `npm run test:support-layer` | **78 Node tests + 48 Vitest tests (5 files) passed, 0 failed**, 661.7195 ms + 6.43 s |
| `npm run locale:parity` | All six locales: **9230 keys**, zero missing, extra or support errors |
| `node scripts/emit-recovery-recipes.mjs --check` | Passed, exit 0 |
| `npx tsc --noEmit` | Passed, exit 0 |

The first renderer run exposed the uncontained editing-lease bridge call and the missing two recipe telemetry mappings; these production fixes passed the whole rerun. The first parity run had two failures for explicit bulk payment-blocker returns and recovery-panel issue wiring; the production wiring above restored both, without changing their guards. Full command logs are in `pos-tauri/test-results/order-notice-containment/` (gitignored).

The final whole Rust run includes the telemetry mapping change. All twelve original failures pass, and no requested check remains red. The eight ignored tests are unchanged. `git diff --check -- pos-tauri` also passes. Commands above used `npm.cmd`/`npx.cmd` on Windows; `CI=true` was set for the whole Vitest run. No Rust test filter was used for the final whole run.

No commits. Android remains the coordinator's ownership: its observer hooks should likewise keep missing schema/failed reads/busy databases separate from owner work, preserve unknown notice evidence, and match the evening decision to hold final moves on a read error.

## Coordinator review changes (after the worker's final run)

- **Editing lease:** registering a lease (`order_notice_editing`, on the blocking pool) and the automatic attempt's
  final check now wait for the leaf mutex instead of refusing. A refused registration left the employee editing
  with no lease, and a refused check consumed the order's single automatic attempt. Observation reads
  (`editing`, `deferred_reason`) stay non-waiting and read contention as "being edited". A window closed while
  an attempt holds the leases is released by a short-lived thread, because the window event runs on the main
  thread and never waits. Regression: `order_notice_auto::tests::lease_changes_during_an_automatic_attempt_are_never_lost`.
- **Durability:** the private write connection sets `synchronous=FULL`, like the business connection.
- **Recipe telemetry:** the till's own attempt (audit `automatic: true`) is reported with mode `auto`; the same
  remedy pressed by a person stays `one_tap`. Regression:
  `recipe_telemetry_reports_the_automatic_customer_correction_attempt_as_auto`.
- **Android:** the delivered gate follows the same read-error policy (`POSSystemMobile/docs/order-notice-gate-containment.md`).

## Known limit

Closed by the founder decision on 17 November evening. An unreadable notice list now holds final moves and records an independent process observation. It does not require any of the failed tables to report the problem.

## Evening follow-up: unreadable issue list

- **Native gate sites:** `commands/orders.rs::apply_order_status_in_connection` (single moves and each bulk item), `order_ownership.rs::assign_order_to_driver_shift` (including initial assignment and legacy earning backfill during a driver change), and `commands/orders.rs::notify_platform_ready_locally`. All use `require_no_open_notice` inside their existing write transaction. A successful read may still find an open notice; that clears only the check-unavailable condition, never that order issue.
- **Staff path:** `OrderService` and `useOrderStore` preserve the distinct machine code without HTTP fallback. Dashboard, order status controls, Delivery, driver results and platform-ready results feed the existing `announceOrderNoticeMoveRefusal` path. Bulk moves continue after either notice refusal. Unreadable orders get one message with their numbers and no order-window navigation. Mixed bulk results group both explanations into one toast and only open an order with a known issue.
- **Locale keys:** `orderSyncNotice.checkUnavailable`, `orderSyncNotice.checkUnavailableMany` and the Health copy `orderSyncNotice.checkUnavailableHealth` / `orderSyncNotice.checkUnavailableGuidance`, in en/el/de/fr/it/sq. Greek and English match the supplied sentences exactly. The guard includes all four keys and bans database terms as well as the prior technical words.
- **Process evidence:** `order_notice_gate.rs` records an atomic refusal count and the sanitized reason in a non-waiting leaf state, keyed locally by the database path hash. No order identity or contents are retained. The bounded process registry has 4096 slots (one normal store database per process); keys never leave the process. Refusal counts are retained even if the reason's leaf is busy, using `ORDER_NOTICE_OBSERVATION_FAILED` when necessary. A contended observation is unknown, never clear. There are no database writes, tables or migrations for this evidence.
- **Health:** `orderNoticeGate` contains `status: unknown | unavailable | clear`; unavailable adds `code`, `refusal_count` and `pending_report`. A successful retry before the first report retains `pending_report` until report acknowledgement; Health can show the check as clear while the earlier refusal still reaches the team. It is independent of `orderNotices`, `orderIssueEvidence` and `observerFailures`, whose meanings are unchanged. No gate read since process start means unknown. Health also shows the plain-language entry with the existing contact-support action; no new remedy is invented.
- **Incident transport:** the existing `/api/pos/incidents/report` path, issue `sync.active_error`, fingerprint `<terminal>:sync.active_error:order_issue:issue_check_unavailable:<sanitized-code>`. Evidence is only `{issue_kind, refusal_code, refusal_count, order_issue_count}`, the keys of the Android report; `order_issue_count` is the count the alert and the super-admin view read. Existing High admission requires two observations: the first refusal is retained until reporting acknowledges it, even if a successful retry preceded the next Health poll, so a second staff attempt is not required. Existing fingerprint suppression prevents a report per tap. This fingerprint is preserved until a later gate read succeeds, then the normal two clean observations and acknowledged clearance apply. Restart/unknown evidence cannot clear it. Ordinary notice observer failures do not prevent clearance after this independent successful gate proof.
- **Regression coverage:** the failed-read completion regression is reversed; payment coverage is unchanged. Added driver assignment and platform-ready hold tests, non-waiting memory evidence, incident admission/deduplication/clearance with a dropped notice table, code preservation without HTTP fallback, bulk continuation, one/several-order copy with no navigation, and mounted order-control refusal behavior. Existing assertions were preserved; tuple/enum destructuring was updated for the additional completion-refusal result. The extra platform-ready run exposed an older fixture with no terminal/organization scope; the healthy-order fixture now has explicit scope and keeps its delivered/settlement assertions. No repair-transport tables or fixtures were changed. The short successful-retry regression also proves the first refusal cannot disappear before the next Health poll.

### What the code that reaches us says (coordinator review)

Founder, 17/11/2026: what is not solved reaches us, we find out what caused it, and then we build a permanent
fix. A code that only says "failed" gives us nothing to start from, so
`order_notice_recovery::notice_failure_code` names the kind of failure. The message itself is never logged or
sent; it is only matched against these fixed classes, and the one name taken from it is a lower-case schema
identifier of the till's own static SQL. The observer log (`observe`) uses the same code. Android uses the same
vocabulary (`orderNoticeFailureCode`).

| Code | Meaning |
| --- | --- |
| `NOTICE_TABLE_MISSING_<TABLE>` | a table the issue list reads does not exist |
| `NOTICE_COLUMN_MISSING_<COLUMN>` | a column the issue list reads does not exist |
| `NOTICE_DATA_MALFORMED` | a stored row holds text that is not valid JSON |
| `NOTICE_DATABASE_DAMAGED` | the database file is damaged or is not a database |
| `NOTICE_DATABASE_BUSY` | the database was locked |
| `NOTICE_READ_INTERRUPTED` | the read was interrupted |
| `NOTICE_STORAGE_ERROR` | disk error, disk full, or the file cannot be opened |
| `ORDER_NOTICE_SCOPE_UNAVAILABLE` | the till's own identity (terminal, organization or branch) is missing |
| an existing machine code, then `ORDER_NOTICE_OBSERVATION_FAILED` | nothing above matched |

Incident reporting forwards the Health code only when it has the classifier's shape
(`is_notice_failure_code`); anything else becomes `ORDER_NOTICE_OBSERVATION_FAILED`.

Every episode reaches us: a refusal that follows a successful read starts a new episode and is reported again,
even when the very next retry gets through before Health looks.

### Evening verification

Commands run one at a time. Cargo uses five jobs, the shared target and its short `t` temporary directory as requested. The whole Rust suite is not run in this follow-up, as requested; the coordinator owns that run. Live incident delivery was not exercised against a store: the existing transport/admission/clearance path is covered by the native tests.

| Evening command | Result |
| --- | --- |
| `cargo fmt --check` | Passed |
| `cargo test --lib --no-fail-fast -- order_notice incident_reporting diagnostics::support_observation_tests main_thread_command_audit database_lock::tests support::tests::availability_tests support::tests::critical_op_tests support::matcher::tests repair_transport` | 218 passed, 0 failed, 0 ignored, 4903 filtered, 70.70 s |
| `CI=true npx vitest run OrderDashboard OrderStatusControls useOrderStore DeliveryPage OrderNoticeStatusGuard OrderNoticeCopy platformReadyAction OrderService ipc-adapter order-open-notice sync-recovery-issues RecoveryConfirmationCopy SyncRecoveryModal --maxWorkers=2` | 391 tests, 48 files passed; 0 failed; 86.78 s |
| `npm test` | 1548 passed, 0 failed; 7987.909 ms |
| `npm run locale:parity` | Six locales, 9256 keys each; zero missing/extra/support errors |
| `npx tsc --noEmit` | Passed, exit 0 |

TypeScript first caught a missing required Health guidance key; the Health copy was split into explanation and guidance and translated in all six locales. The first Rust compile stopped on three test adaptations (a new tuple field, using the existing temporary-directory helper, and matching a non-Debug result). No production guard or fixture was weakened. The additional driver/platform run initially had 17 passes and one failure from that unscoped platform-ready fixture. The final combined run (the requested filters plus `driver_restore_tests tests::platform_ready order_ownership::tests`) passed 236 tests, 0 failed, 0 ignored, 4885 filtered, in 77.19 s. Logs: `pos-tauri/test-results/order-notice-unavailable/`.

Evening files: native `order_notice_gate.rs` (new), `order_notice_recovery.rs`, `order_ownership.rs`, `commands/orders.rs`, `diagnostics.rs`, `incident_reporting.rs`, `lib.rs`, and the platform-ready assertion in `tests/platform_ready.rs`; bridge `ipc-contracts.ts`, `ipc-adapter.ts`, `order-open-notice.ts`; service `OrderService.ts` and its local-first tests; renderer `OrderDashboard.tsx`, `OrderStatusControls.tsx` and its tests, `DeliveryPage.tsx`, `useOrderStore.ts` and its refused-payment tests, `OrderNoticeStatusGuard.ts` and tests, `platformReadyAction.ts` and tests, `sync-recovery-issues.ts`, `OrderNoticeCopy.test.ts`; six locale JSON files; this document. Queue acknowledgements, the automatic helper, business lock helpers and coordinator lease/durability changes are untouched.

## Files changed by this worker

- `src-tauri/src/commands/sync_queue.rs`
- `src-tauri/src/commands/recovery.rs`
- `src-tauri/src/diagnostics.rs`
- `src-tauri/src/incident_reporting.rs`
- `src-tauri/src/incident_reporting/recipe_telemetry.rs`
- `src-tauri/src/order_notice_auto.rs`
- `src-tauri/src/order_notice_recovery.rs`
- `src-tauri/src/support/critical_op.rs`
- `src-tauri/src/sync_queue.rs`
- `src/renderer/components/recovery/SyncRecoveryModal.tsx`
- `src/renderer/components/OrderDashboard.tsx`
- `src/renderer/services/OrderNoticeStatusGuard.ts`
- `src/renderer/components/__tests__/SyncRecoveryModal.behavior.test.tsx` (one added regression; existing cases unchanged)
- `src/renderer/hooks/useOrderNoticeEditing.ts`
- `src/renderer/hooks/__tests__/useOrderNoticeEditing.test.tsx` (two added cases; existing case unchanged)
- This report.

Concurrent coordinator edits outside `pos-tauri/` were observed and left untouched. The original containment pass changed no staff-facing text or locale; the evening follow-up adds the four plain-language keys listed above. No additional worker was launched.

Worker: OpenAI Codex (GPT-6 family); no cross-provider client or delegated agent was used.
