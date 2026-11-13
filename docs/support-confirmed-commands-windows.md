# Windows founder-confirmed commands — worker handoff, 2026-11-13

Implementation is in `pos-tauri/` only. No commit, deployment, consent publication, migration on a store, feature-switch activation, new crate or new Cargo feature was performed. Work used the native OpenAI Codex worker in this session; the exact model SKU is not exposed to this worker. No Claude worker or nested coordinator was started.

## Qualification and remaining limitation

All five typed actions and the explicit conversational admission/execution path are implemented. Native SQLite and renderer/static checks are recorded below. A real Windows till and server-connected rehearsal remain necessary before enabling this capability in production.

**Raw SQL INSERT remains refused on Windows, including an operational-setting INSERT that the shared policy syntactically permits.** This preserves the previous Windows authorizer's refusal. Windows `local_settings` creates a protected random primary key and default metadata; its exact scratch/live physical postimage cannot be replayed with the current shared insert identity contract. No supplied ID, stripped metadata, invented deterministic default or unsafe relaxation was introduced. Operational-setting UPDATE/DELETE and eligible UPDATE targets work. This is a Windows/Android difference and an unresolved shared/native contract qualification item for the coordinator. Review capability enablement with this limitation; do not claim full shared INSERT coverage.

No changes to the runtime error registry are needed: this worker added no fixed-code error to `edit_settlement_recovery.rs` or the registry-scanned refusal contract tests. Business-owner refusal strings pass through existing result mapping. No shared contract files were edited.

## Admission, durability and checkout priority

The native session pins consent `1.1` and `founder_conversation` only when this till accepts an authenticated offer advertising current command consent. Confirmed admission requires fresh authenticated availability, enabled tier 3/tool/switch, exact mode and idempotency, explanation/reason, and literal `founder_confirmed: true` for mutations. A dry run needs no mutation confirmation. Session/org/branch/terminal, key-only authentication, active state, attended proof, visibility, local consent pin and expiry are independently rechecked. Availability is refreshed at polling and execution; a mode field alone grants no authority. Legacy passkey admission and execution remain separate.

Existing durable acceptance, sequence/hash/idempotent replay and outbox delivery apply. Per-session 10-dispatch and 5-second interval caps are persisted atomically with acceptance; exact replay consumes no new dispatch. Every mutation is bounded to 50 changed rows, a full native snapshot and durable started record before work. Local waiting/started/finished/refused/undone events carry session, command, accepted payload hash, time, scrubbed explanation and reason. End cancels accepted work that has not begun; owner transactions check sticky cancellation and deadline before commit. Full current UI/session authority is observed outside the business writer reservation, avoiding Core/UI locks while holding SQLite writes.

No change was made to the critical gate or its latency tests. Checkout/payment/shift-close/Z preempts the support permit. Owner callbacks use the native writer reservation and retain the 250 ms transaction budget. Snapshot copy and scratch work retain read permits and existing cancellation budgets. The full pre-change snapshot fingerprint is compared under the writer reservation, including changes that the cheap count/time watermark misses. A frozen full post-change watermark is captured inside the writer transaction, then persisted afterward. A sale between COMMIT and persistence is excluded from that baseline and therefore blocks whole-file undo. Baseline-persistence or uncertain commit failure is reported as unknown and never as resolved.

## Typed actions

| Action | Business owner | Native eligibility and changes | Fresh evidence and outcome |
|---|---|---|---|
| `shift.close_stuck.v1` | `shifts::close_shift_with_support`, the same body called by ordinary `shifts::close_shift` | Named active local shift; matching branch/terminal; submitted-close/fiscal safeguards; owner payment prerequisites. No-drawer only for an actual zero-float nonfinancial kitchen role. Counted close requires exactly the named open drawer and caller cash cents; no invented counts. Windows owner cannot represent nonzero card/other counts, so those refuse. Gift prerequisites and active cash-return transfer staff refuse. Calls the owner with exact closing cash and keeps its sync rows. | Re-read closed shift and exact drawer counts/closed state, count all owner effects against cap, preserve snapshot metadata. Returns shift evidence and `pending` with sync `pending`, because scheduling the close is not server acknowledgment. |
| `queue.retry_row.v1` | Central `sync_queue::support_retry_dependencies_ready` + `sync_queue::retry_item`; financial `sync::retry_financial_queue_item` | Exact pending/failed eligible row; no in-flight/conflict/completed/fiscal/Z/repair/gift target; local scope and original parent identity; dependencies actually ready. Never fabricates acknowledgment. Only scheduling fields change. | Re-read scheduled row; compare immutable before/after payload hashes and actual pending state. Returns queue evidence, `pending`, sync `pending`. |
| `queue.set_aside.v1` | `sync_queue::set_aside_queue_row` for every member | Enumerate full dependent group first; explicit include-dependents/cap; scope and claimed-Z exclusions on every member. Owner's new narrow dependency branch accepts a row genuinely waiting on an already set-aside order EDIT as well as INSERT. Command-supplied parent ID must identify that actual dependency. Records explicit `support:<session>:<command>` provenance and retained group. Only owner markers/audit change; originals remain. | Fresh markers for every member and identical before/after payload hashes. Returns group evidence, `resolved` for the local marker operation, sync `not_applicable`; undo reference is the retained group. |
| `queue.return_to_queue.v1` | `sync_queue::undo_set_aside`; `retained_set_aside_group` enumerates an existing Health owner group | Require original retained support group/provenance or provable existing owner marker group, all originals present, matching scope, full group cap, no claimed/submitted Z/fiscal/protected member. Removes markers through the owner only; failed rows remain failed for normal owner retry handling. | Re-read all members and absent markers; exact original payload hashes. Returns group evidence, `resolved` for return-to-queue only, sync `not_applicable`; no claim of successful upload. |
| `recovery.undo_snapshot.v1` | Existing `restore::native_restore` / `stage_restore`, then startup recovery and `confirmed_restore::complete` | Exact eligible newest snapshot, same app/schema, current full loss watermark, row cap, full pre-restore copy and accepted session. Explicit confirmed authority skips only the separate PIN/passkey prompt. Existing restore lease/staging/restart guards remain. End revokes pending startup authority. | Staging returns restore evidence `staged_restart`, `pending`; no forced restart. Startup reports `resolved` and records undone only after fresh live fingerprint equals target. Refusal/mismatch is unknown/refused, never presumed restored. |

All mutation results include `kind: untrusted_till_data`, fresh observation time, affected IDs, changed-row count, verification, native snapshot ID plus metadata, closed typed evidence and a truthful undo descriptor. The desktop oracle validates actual owner results against JSON Schema generated from the shared Zod result schema. Snapshot metadata is validated by the existing separate envelope handling; it is removed before validating the strict shared result body.

Android parity: same caller shapes, owner-only behavior, snapshot-first, group retention, pending retry/close/restart semantics, and consent/mode rules. Windows uses `pos.db`, central `parity_sync_queue` plus financial `sync_queue`; Android uses its own queue/database owners. The Windows restrictions on card/other counts and unsupported gift preparation are fail-closed owner limitations, not hidden conversions. SQL INSERT limitation is described above.

## Guarded database change

The explicit confirmed connection uses generated effective Windows tables from `write-policy.ts`; legacy connections keep their prior policy. UPDATE-only widening covers eligible staff shifts, drawers, payment scheduling and parity queue bookkeeping. Native OLD/NEW evidence is derived from the same transaction connection and cannot be supplied by the caller. Payments retain amount/method/identity; scheduling cannot fabricate synced/completed. Orders retain unpaid/unfiscalized/unsubmitted and original mutation rules. Operational-setting keys use the existing narrow owner predicate.

Dry run makes a scratch copy, prepares one screened statement, and binds anonymous `?` parameters on scratch and live. Named, numbered, missing, unused or over-limit bindings refuse. No subqueries, UPDATE FROM, conflicts, multi-statements, DDL, arbitrary reads, secret columns, active persistent trigger bodies or effective FK cascade writes. SQLite authorizer, defensive/trusted-schema settings, disabled extension loading and native resource limits remain independent of lexical checks. Allowed persistent dormant triggers do not cause a blanket refusal.

A persisted dry receipt binds complete before/after row inventories, exact inserted/updated/deleted counts, target hashes, SQL, parameters, expected counts, row cap and 10-minute expiry. New confirmed/explicit-param payloads use a JavaScript-compatible numeric canonical hash with Node vectors; historical omitted-param hashes remain unchanged. Execution loads the accepted original envelope and recomputes its hash and receipt digest, requires the exact proposal/result/dry-run hash, checks expiry and unused status, then atomically consumes it. The complete live pre-change fingerprint must still equal the pre-command snapshot; live target preimages must equal the dry preimages; live postimages/counts must equal the dry output. A snapshot and durable business transaction marker precede commit; fresh verification follows. Changed parameters/counts/hash, tampered stored receipt, expired/reused dry run or live drift refuse. Postimage baseline is captured before COMMIT for safe undo.

Real-file tests deny payment amount/method changes, submitted Z and issued fiscal links, credentials, business audit and support journals, unsupported inserts and acknowledgment fabrication. Existing critical-operation tests remain green; the new action tests also hold the gate and assert no row changes. Tests additionally cover exact parameter binding, SQL effects/counts, caps, expiry, receipt tampering/reuse, group parent proof, wrong scope, retained originals, owner refusal, manual Health group return and snapshot startup revocation.

The three ignored support tests are existing on-demand checkout scaling/reference-hardware diagnostics, including the temporary 500 MB release-gate fixture. Those reference-hardware checks were not run. The two ignored queue tests are existing catch-up/capacity measurements.

## Staff visibility and translations

The pill shows the current command's actual explanation and reason while it waits/runs, keyed by command ID so another waiting command cannot replace running text. End remains available immediately, with Greek `Τέλος`. The pill's activity details retain the latest 20 scoped command records with timestamp, state and outcome, including after the active session ends. Details stay visible even without other undoable devices/snapshots. No PIN or staff tap is requested in confirmed mode.

Each locale contains all 12 required keys plus plain outcome strings. These match the Android translations and preserve placeholders. Full new text follows:

### el

```json
{
  "waiting": "Περιμένει να ξεκινήσει",
  "running": "Εκτελείται τώρα",
  "finished": "Ολοκληρώθηκε",
  "refused": "Δεν εκτελέστηκε",
  "undone": "Έγινε αναίρεση",
  "endSession": "Τέλος",
  "snapshot": "Αποθηκεύεται αντίγραφο πριν από κάθε αλλαγή",
  "shiftClose": "Κλείσιμο βάρδιας {{shift_id}} με τα ποσά που μετρήθηκαν",
  "queueRetry": "Νέα προσπάθεια για την εγγραφή {{queue_id}}",
  "queueSetAside": "Παράκαμψη της εγγραφής {{queue_id}} και όσων την περιμένουν, με διατήρηση των στοιχείων τους",
  "queueReturn": "Επιστροφή στην ουρά της εγγραφής {{queue_id}} που παρακάμφθηκε, μαζί με την ομάδα της",
  "undoSnapshot": "Αναίρεση με το αποθηκευμένο αντίγραφο {{snapshot_id}}",
  "outcomes": {
    "pending": "Περιμένει συγχρονισμό",
    "resolved": "Το πρόβλημα λύθηκε",
    "failed": "Δεν ολοκληρώθηκε",
    "unknown": "Χρειάζεται έλεγχος",
    "rolled_back": "Η αλλαγή αναιρέθηκε"
  }
}
```

### en

```json
{
  "waiting": "Waiting to run",
  "running": "Running now",
  "finished": "Finished",
  "refused": "Could not run",
  "undone": "Undone",
  "endSession": "End",
  "snapshot": "A copy is saved before every change",
  "shiftClose": "Close shift {{shift_id}} with the supplied closing counts",
  "queueRetry": "Retry queue row {{queue_id}}",
  "queueSetAside": "Set aside row {{queue_id}} and the rows waiting for it, keeping their records",
  "queueReturn": "Return set-aside row {{queue_id}} and its group to the queue",
  "undoSnapshot": "Undo using saved copy {{snapshot_id}}",
  "outcomes": {
    "pending": "Waiting for sync",
    "resolved": "Resolved",
    "failed": "Could not finish",
    "unknown": "Needs checking",
    "rolled_back": "Change rolled back"
  }
}
```

### de

```json
{
  "waiting": "Wartet auf den Start",
  "running": "Wird jetzt ausgeführt",
  "finished": "Abgeschlossen",
  "refused": "Konnte nicht ausgeführt werden",
  "undone": "Rückgängig gemacht",
  "endSession": "Beenden",
  "snapshot": "Vor jeder Änderung wird eine Kopie gespeichert",
  "shiftClose": "Schicht {{shift_id}} mit den angegebenen gezählten Beträgen schließen",
  "queueRetry": "Warteschlangeneintrag {{queue_id}} erneut versuchen",
  "queueSetAside": "Eintrag {{queue_id}} und die darauf wartenden Einträge zurückstellen und ihre Daten behalten",
  "queueReturn": "Zurückgestellten Eintrag {{queue_id}} und seine Gruppe wieder in die Warteschlange stellen",
  "undoSnapshot": "Mit gespeicherter Kopie {{snapshot_id}} rückgängig machen",
  "outcomes": {
    "pending": "Wartet auf die Übertragung",
    "resolved": "Behoben",
    "failed": "Nicht abgeschlossen",
    "unknown": "Prüfung erforderlich",
    "rolled_back": "Änderung zurückgenommen"
  }
}
```

### fr

```json
{
  "waiting": "En attente de démarrage",
  "running": "En cours",
  "finished": "Terminé",
  "refused": "Impossible à exécuter",
  "undone": "Annulé",
  "endSession": "Terminer",
  "snapshot": "Une copie est enregistrée avant chaque modification",
  "shiftClose": "Clôturer le service {{shift_id}} avec les montants comptés indiqués",
  "queueRetry": "Réessayer l’envoi de l’élément {{queue_id}}",
  "queueSetAside": "Mettre de côté l’élément {{queue_id}} et ceux qui l’attendent, en conservant leurs données",
  "queueReturn": "Remettre l’élément {{queue_id}} et son groupe dans la file d’envoi",
  "undoSnapshot": "Annuler avec la copie enregistrée {{snapshot_id}}",
  "outcomes": {
    "pending": "En attente de synchronisation",
    "resolved": "Résolu",
    "failed": "Non terminé",
    "unknown": "À vérifier",
    "rolled_back": "Modification annulée"
  }
}
```

### it

```json
{
  "waiting": "In attesa di iniziare",
  "running": "In esecuzione",
  "finished": "Completato",
  "refused": "Impossibile eseguire",
  "undone": "Annullato",
  "endSession": "Termina",
  "snapshot": "Una copia viene salvata prima di ogni modifica",
  "shiftClose": "Chiudi il turno {{shift_id}} con gli importi contati indicati",
  "queueRetry": "Riprova l’invio della voce {{queue_id}}",
  "queueSetAside": "Metti da parte la voce {{queue_id}} e quelle in attesa, conservandone i dati",
  "queueReturn": "Rimetti in coda la voce {{queue_id}} e il suo gruppo",
  "undoSnapshot": "Annulla usando la copia salvata {{snapshot_id}}",
  "outcomes": {
    "pending": "In attesa di sincronizzazione",
    "resolved": "Risolto",
    "failed": "Non completato",
    "unknown": "Da verificare",
    "rolled_back": "Modifica annullata"
  }
}
```

### sq

```json
{
  "waiting": "Në pritje për të nisur",
  "running": "Po kryhet tani",
  "finished": "Përfundoi",
  "refused": "Nuk mund të kryhej",
  "undone": "U zhbë",
  "endSession": "Përfundo",
  "snapshot": "Ruhet një kopje para çdo ndryshimi",
  "shiftClose": "Mbyll turnin {{shift_id}} me shumat e numëruara të dhëna",
  "queueRetry": "Provo sërish dërgimin e rreshtit {{queue_id}}",
  "queueSetAside": "Lër mënjanë rreshtin {{queue_id}} dhe rreshtat që e presin, duke ruajtur të dhënat e tyre",
  "queueReturn": "Kthe në radhë rreshtin {{queue_id}} dhe grupin e tij",
  "undoSnapshot": "Zhbëj me kopjen e ruajtur {{snapshot_id}}",
  "outcomes": {
    "pending": "Në pritje të sinkronizimit",
    "resolved": "U zgjidh",
    "failed": "Nuk përfundoi",
    "unknown": "Duhet kontrolluar",
    "rolled_back": "Ndryshimi u kthye mbrapsht"
  }
}
```

## Checks

All Rust test commands use `CARGO_BUILD_JOBS=5`, `LOCALAPPDATA=C:/Temp/zt-rust-localappdata`, no FORCE_COLOR. One heavy job at a time. The whole `cargo test --lib` was deliberately not run; the coordinator owns it.

| Command | Result |
|---|---|
| `cargo check --lib` | Pass, production build; 6 existing dead-code warnings. |
| `cargo fmt --check` | Pass. |
| `cargo test --lib support -- --test-threads=1` | Pass: 466 passed, 3 ignored. |
| `cargo test --lib sync_queue` | Pass: 417 passed, 2 ignored. |
| `cargo test --lib shifts` | Pass: 106 passed, none ignored. |
| `npm run type-check` | Pass. |
| Support components plus `useSupportSession` Vitest | 18 files, 307 tests passed. |
| `npm test` | 4 suites, 1527 tests passed. |
| `npm run locale:parity` | Six locales, 9167 keys each, zero missing/extra/support errors. |
| Support-layer suite | 78 tests passed. |
| Shared schema emitter `--check` | Pass. |
| `git diff --check` | Pass. |

The requested default Vitest command could not write `.vite-temp` because this worktree's `node_modules` is a junction into another worktree. A `--configLoader runner` invocation used a generated copy of the existing config with its original `__dirname` and cache relocated under this worktree's ignored `src-tauri/target`; no other worktree was modified. Exact tested paths: `src/renderer/components/support` and `src/renderer/hooks/__tests__/useSupportSession.test.tsx`.

Likewise the default `npm run test:support-layer` esbuild output in the junction's `node_modules/.cache` was blocked by EPERM. The same entry point and esbuild options were bundled into `src-tauri/target/confirmed-support-layer.test.mjs`, then run with `node --test`; all 78 tests passed. This is an environment workaround, not a skipped assertion. No packaged Windows release build, hardware interaction, live support session or real store keyring was used.

## File-by-file changes

Paths below are relative to `pos-tauri/`. Generated build output/logs are ignored and are not source changes.

- `scripts/emit-confirmed-result-schema.cjs` — Reproducible shared Zod schema emitter using existing esbuild, with --check.
- `src-tauri/src/recovery.rs` — Recognize confirmed staged restore, retain startup authorization/loss safeguards and pending contract.
- `src-tauri/src/shifts.rs` — Share ordinary close owner body with optional support DB-only checks; preserve normal close behavior.
- `src-tauri/src/support/authorizer.rs` — Explicit confirmed effective-policy connection, exact bound parameters and strict untrusted SQL authorization.
- `src-tauri/src/support/breakglass.rs` — Optional legacy parameter binding and confirmed staged restore completion routing.
- `src-tauri/src/support/catalogue/tests.rs` — Extend existing test fixture constructor for explicit confirmed admission/session field; legacy expectations unchanged.
- `src-tauri/src/support/confirmed.rs` — Admission/current authority, caps, audit/history, snapshots, atomic cancellation and action dispatch.
- `src-tauri/src/support/confirmed_actions.rs` — Typed owner calls, local eligibility, group proof, cap/effect accounting and fresh typed evidence.
- `src-tauri/src/support/confirmed_hash.rs` — JavaScript-compatible numeric canonical digest for new contract payloads.
- `src-tauri/src/support/confirmed_hash_vectors.json` — Node-generated numeric hash compatibility fixtures.
- `src-tauri/src/support/confirmed_restore.rs` — Confirmed restore evidence, pending staging and verified startup outcome/undone event.
- `src-tauri/src/support/confirmed_result_schema.json` — Generated closed shared result JSON Schema.
- `src-tauri/src/support/confirmed_schema.sql` — Local durable events, group originals, restore binding and accepted consent pin schema.
- `src-tauri/src/support/confirmed_sql.rs` — Bound scratch/live confirmed SQL, policy, receipts, native row guards and exact verification.
- `src-tauri/src/support/contracts.rs` — Pin 32 tool kinds and 14 cap groups.
- `src-tauri/src/support/db.rs` — Support DB schema version 5 with confirmed session/event/group/restore records.
- `src-tauri/src/support/delivery.rs` — Independent confirmed admission and new hash selection without changing historical payload digests.
- `src-tauri/src/support/dispatch.rs` — Advertise capability, dispatch explicit confirmed path before legacy passkey flow, preserve staged pending result.
- `src-tauri/src/support/dry_run.rs` — Persist optional legacy bindings; exact scratch/live binds and target-selection parameter ordering.
- `src-tauri/src/support/executor.rs` — Atomic accepted command event/rate lifecycle, replay and End audit handling.
- `src-tauri/src/support/mod.rs` — Register new native modules.
- `src-tauri/src/support/remedy_run.rs` — Extend existing test fixture constructor for explicit confirmed admission/session field; legacy expectations unchanged.
- `src-tauri/src/support/restore.rs` — Explicit confirmed authorization at existing restore owner and routing completion; preserve loss guards.
- `src-tauri/src/support/session.rs` — Pin local consent/mode, revoke authority, expose current command and scoped durable history, restore resume.
- `src-tauri/src/support/tests/confirmed_tests.rs` — Real SQLite typed-action/refusal, admission, SQL binding/protection, audit/replay/End, late-sale undo/same-cheap-watermark drift regressions, known operational/shift queue coverage and contract tests.
- `src-tauri/src/support/tests/delivery_tests.rs` — Extend existing test fixture constructor for explicit confirmed admission/session field; legacy expectations unchanged.
- `src-tauri/src/support/tests/desktop_output_contract_tests.rs` — Validate actual native confirmed results against generated shared closed schema.
- `src-tauri/src/support/tests/device_apply_owner_tests.rs` — Extend existing test fixture constructor for explicit confirmed admission/session field; legacy expectations unchanged.
- `src-tauri/src/support/tests/evidence_tests.rs` — Use current support DB schema constant; eyes behavior unchanged.
- `src-tauri/src/support/tests/mod.rs` — Register new confirmed test module.
- `src-tauri/src/support/tests/transport_loop_tests.rs` — Extend existing test fixture constructor for explicit confirmed admission/session field; legacy expectations unchanged.
- `src-tauri/src/support/tools.rs` — Expose existing desktop output contract oracle to actual confirmed-result tests.
- `src-tauri/src/support/transport.rs` — Optional session mode, offer/ack authority and fresh command poll restriction.
- `src-tauri/src/sync.rs` — Parse/cache optional confirmed availability; financial retry transaction wrapper and fresh dependency checks.
- `src-tauri/src/sync_queue.rs` — Owner set-aside order-EDIT dependency proof, scoped enumeration, claimed-Z return refusal and atomic retry/group helpers.
- `src-tauri/src/sync_queue/confirmed_queue_tests.rs` — Real SQLite set-aside order-EDIT waiting money row regression and scope/claimed-Z refusals.
- `src/locales/support/de.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/locales/support/el.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/locales/support/en.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/locales/support/fr.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/locales/support/it.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/locales/support/sq.json` — Add required confirmed-command templates, states and outcomes in this language; preserve other support strings.
- `src/renderer/components/support/SupportBanner.tsx` — Actual current explanation/reason, immediate End and retained timestamped outcome history.
- `src/renderer/components/support/SupportDetailsPanel.tsx` — Keep activity history accessible after session and without undoables.
- `src/renderer/components/support/__tests__/SupportConfirmed.test.tsx` — Current pill, history, End, locale placeholder and schema tests.
- `src/renderer/hooks/useSupportSession.ts` — Compatible optional current-command/history payload parsing.
- `docs/support-confirmed-commands-windows.md` — this review, qualification and real-till handoff.

## Real-till rehearsal and risks

1. Install a Windows qualification build with a backed-up real-schema database. Check the old server/consent version refuses confirmed commands and an attended key-only session accepting 1.1 can admit them. Check passkey tools still follow their original path.
2. Check visible waiting/running explanation and reason, Greek End, session-end cancellation, post-session timestamp/outcome activity, and no PIN/tap request. Exercise an unattended, paused, hidden-window and different-terminal refusal.
3. Run each typed action on known eligible fixtures, including an order EDIT already set aside with a waiting payment. Return the whole group and compare original payloads. Retry must remain pending until server acknowledgment; never claim the Z blocker cleared before fresh owner evidence.
4. Close a genuine zero-float kitchen shift and a counted eligible cashier drawer. Compare exact cents, drawer ID and normal close sync; attempt unsupported card/other/gift/transfer cases and expect refusal.
5. Dry-run an allowed bound UPDATE, review exact target hashes/counts and snapshot, then execute the exact receipt once. Try changed params/counts, expired/replayed receipt, protected amount/method/fiscal/Z/credential/audit/support targets and held sale/payment/shift-close/Z gate. Check checkout timing against the existing green latency baseline.
6. Undo an eligible newest snapshot, observe pending restart, restart normally and verify actual restored evidence. Then make a sale and prove the prior snapshot refuses undo. End before restart must revoke pending support authority.
7. Review server incident projection/outbox retry and receipts against actual native output. Review the raw INSERT limitation before capability enablement. Do not run Z, submit fiscal documents, alter a payment, or access actual credentials during the rehearsal.

Remaining risks: no hardware/live server/package rehearsal yet; unchanged owner prerequisites may refuse the store's particular blocked data; fiscal/Z linkage checks conservatively refuse rows with a later Z in the local database rather than infer missing per-document attribution; whole-file restore deliberately becomes unavailable after any relevant state moves; full snapshots/watermarks on large tills may hit existing size/time budgets and refuse safely; active persistent SQL triggers/cascades are deliberately conservative; crash/commit uncertainty is unknown and requires fresh diagnosis, not blind retry; staged restore can verify unknown after startup housekeeping changes. The consent model records the operator's founder-confirmation assertion and cannot prove conversation assent cryptographically. Server switches/consent and coordinator full-suite review are separate integration work.
