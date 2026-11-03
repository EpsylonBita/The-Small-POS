# Sync Recovery Recipes

The POS recovery modal uses versioned recipes for known sync blockers. A recipe is shipped with an app update after a developer has verified a safe fix for a specific issue code. The app does not learn or execute arbitrary user-created repair logic at runtime.

The project-wide policy is [health-recovery.md](../../.claude/rules/health-recovery.md).
Learning from an incident means preserving its root cause, adding a reproducing
regression and shipping a reviewed remedy when the client can safely perform it.
It does not mean treating every failure as retryable or displaying success before
the write has actually been acknowledged.

## Recipe Rules

- Each recipe has a stable `recipeId`, integer `version`, primary `actionId`, explanation key, verification key, and `requiresSnapshot` flag.
- Mutating recipes must create a `pre_recovery_action` snapshot before changing local queue, order, payment, shift, or report state.
- The native automatic customer-address retry only changes retry bookkeeping,
  never the queued payload or business records. Its preimage is stored in
  local settings and referenced by `recovery_action_log.payload_json` in the same
  SQLite transaction as the guard and scheduling change. This is a metadata snapshot, not a full database restore
  point. Operator-triggered mutating recipes still use `pre_recovery_action`.
- Route-only recipes, such as opening an unpaid order payment screen, do not create financial records automatically and do not require a snapshot.
- Every attempt is written to `recovery_action_log` with the issue code, recipe version, target ids, success state, optional snapshot id, and optional diagnostics export path.
- Unknown blockers must explain the issue and offer Contact Dev, not a fake automatic fix.
- A retry that is merely queued remains pending verification. A failed or stale
  diagnostics refresh cannot clear an issue or establish successful recovery.
- Automatic probes must survive restart with their cooldown and attempt cap
  intact; update scheduling metadata and the guard atomically.
- Initial diagnostics failure shows unavailable. Refresh failure retains the
  last known state as stale. Neither case may render a healthy empty state.

## Adding A Recipe

1. Add the recipe definition in the recovery issue builder and attach it only when diagnostics match a known safe condition.
2. Mark the action `recommended`, include `recipeId` and `recipeVersion`, and set `requiresSnapshot` for any mutating fix.
3. Add translation keys for all active POS languages: `en`, `el`, `de`, `fr`, `it`, and `sq`.
4. Add or update tests for the issue match, recommended action, snapshot requirement, and Contact Dev fallback.
5. Run `npm run locale:parity`, `npm run type-check`, and the targeted recovery tests.
6. For a reproduced production defect, make the regression part of a blocking
   CI job. Check both the broken-state reproduction and that the current schema
   or runtime still contains the installed fix.

## Customer default-address incident

The September 2026 incident is covered by
[the operational incident note](../../docs/operations/customer-address-default-parity-incident-20260913.md).
The blocking compliance job now checks both installed default-switch triggers
before reproducing the missing-trigger failure in an isolated database clone.
It exercises atomic switching, concurrent retry, tenant isolation and privacy
guards. The migration is mirrored in compliance setup so later schema drift
cannot silently remove the repair from the tested schema.

## Payment Blockers

Missing or unpaid payments must route the user to the order payment flow. The default recipe must not create a cash or card payment automatically, because payment method, amount, and terminal approval need operator confirmation.

## Support recipe manifest contract

The shared support manifest adds reviewed metadata around shipped recovery code.
It never accepts an incident's SQL or terminal command as runnable recipe logic.
The authoritative validator is
[`shared/pos/support/recipe-manifest.ts`](../../shared/pos/support/recipe-manifest.ts).
The manifest format is version 1; each entry also has its own positive integer
`version` and stable `id`.

| Fields | Contract |
| --- | --- |
| `platforms`, `minimum_app_version`, `matchers` | Declare `windows`/`android`; every declared platform needs its own minimum version and exact matcher |
| `source_incidents` | Nonempty provenance; existing shipped work may use an honest `legacy-shipped:` source reference |
| `matchers` | Issue/error codes, allowlisted structured fields and a read-only query; at least one exact structured trigger |
| `trigger`, `eligibility`, `mode` | Explicit classification, no critical operation, financial eligibility and maximum affected rows; `auto`, `one_tap` or `guidance` |
| `idempotence` | Explanation and regression test proving repeat safety |
| `cooldown_ms`, `attempt_cap`, `concurrency_lock` | Persisted limits and an actual operation owner, surviving process restart |
| `snapshot_level` | `none`, `metadata` or `full`, appropriate to the mutation |
| `verification_query`, `audit_event`, `regression_test_path` | Read-only verification, audit identity and blocking regression evidence |

Queries cannot match free-text messages or use file access, extensions or writes.
Automatic mode requires a specific known issue and nonfinancial eligibility;
generic HTTP 500, authentication/privacy failures, unknown conflicts and financial
discrepancies never authorize automatic repair. Validation checks metadata; the
app must still enforce policy, permissions, durable attempt/cooldown claims and
fresh verification. A queued retry stays pending until authoritative state proves
the problem is gone.

The current shared inventory in
[`recipe-manifest.entries.ts`](../../shared/pos/support/recipe-manifest.entries.ts)
maps every shipped recipe. Legacy matchers remain guidance-only entries in
`LEGACY_RECIPE_CONTRACT_LIMITATIONS`: their queries deliberately admit no target,
and grant no additional authority. This is their complete contract representation;
their existing owners retain their behavior. Desktop contract tests pin renderer,
native automatic and generated catalogues to the shared identity, version, budget
and snapshot metadata. The native automatic address retry retains its existing
metadata-only bookkeeping snapshot; the generated `snapshot_level` records this
explicitly, while its remote entry point still requires a full pre-action snapshot.
No legacy recovery behavior changes.

For a new support fix: capture the incident, reproduce the exact failure, review
both apps' eligibility and implementation, add manifest metadata and blocking
regressions, then ship both apps. Store recipe/version/outcome recurrence telemetry
only after native adoption. An LLM-authored incident draft is engineering guidance;
it cannot approve, schedule or execute recovery. See
[remote support architecture](../../docs/architecture/remote-support-mcp.md#phase-4-incident-to-reviewed-recipe)
for pipeline and implementation status.


## Restore the saved printer language

`printer.restore_last_known_brand` v1 is a desktop-only, one-tap Health recipe.
Its provenance is the source template `incident-template:2026-10-31:tomikro-star-mc-print3`
and the prevention fix `commit:2a057bfa7`; no real incident UUID is invented.
The blocking regression lives in `src-tauri/src/printers/restore_brand.rs` under
`cargo test --lib` and reproduces an unanswered probe with last-known Star.

The local printer observation must be at most 60 seconds old, unanswered, and
resolve to unknown. The enabled profile must still match its complete native
configuration reference and use automatic emulation. The printer owner restores
Star to `star_line`, or a recognised ESC/POS brand to `escpos`. It never probes,
prints, reads credentials, changes a payment or alters a financial record.

A per-printer lock, scope-bound durable three-attempt cap and five-minute cooldown
protect retries. Before any owner mutation, a full private SQLite snapshot is
flushed to disk and an intent audit plus attempt claim is committed. A critical
operation cancels the support permit and interrupts its SQLite transaction.
Configuration and observation are checked again after the snapshot and audit.
A fresh read handle reports `resolved`, `failed`, `pending` or `unknown`; restoring
a setting does not prove that paper output is correct, so the Health guidance
asks the operator to print a test receipt. The six desktop locales carry the
same plain-language action. Android has no brand probe and is explicitly not
applicable in `RECIPE_PLATFORM_NOT_APPLICABLE`.

Desktop completed recovery audits also feed the durable `recipe_applied` outbox
in `incident_reporting.rs`. Offline ticks still buffer. Only closed UTC hours
send, at most one aggregate per recipe, canonical till and hour; sent claims
survive restart. Unsent native audits are re-read so pending verification can
become a final outcome before sending. Failures back off from five minutes,
doubling to one hour. Only the server's nine event fields are sent through the
existing authenticated incident transport. No actor, customer, target, message,
raw scope or snapshot path is included, and no business writer is held over
network waits. Malformed outbox state fails closed without erasing claims.
