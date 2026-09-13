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
3. Add translation keys for all active POS languages: `en`, `el`, `de`, `fr`, and `it`.
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
