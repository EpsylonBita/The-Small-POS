# Sync Recovery Recipes

The POS recovery modal uses versioned recipes for known sync blockers. A recipe is shipped with an app update after a developer has verified a safe fix for a specific issue code. The app does not learn or execute arbitrary user-created repair logic at runtime.

## Recipe Rules

- Each recipe has a stable `recipeId`, integer `version`, primary `actionId`, explanation key, verification key, and `requiresSnapshot` flag.
- Mutating recipes must create a `pre_recovery_action` snapshot before changing local queue, order, payment, shift, or report state.
- Route-only recipes, such as opening an unpaid order payment screen, do not create financial records automatically and do not require a snapshot.
- Every attempt is written to `recovery_action_log` with the issue code, recipe version, target ids, success state, optional snapshot id, and optional diagnostics export path.
- Unknown blockers must explain the issue and offer Contact Dev, not a fake automatic fix.

## Adding A Recipe

1. Add the recipe definition in the recovery issue builder and attach it only when diagnostics match a known safe condition.
2. Mark the action `recommended`, include `recipeId` and `recipeVersion`, and set `requiresSnapshot` for any mutating fix.
3. Add translation keys for all active POS languages: `en`, `el`, `de`, `fr`, and `it`.
4. Add or update tests for the issue match, recommended action, snapshot requirement, and Contact Dev fallback.
5. Run `npm run locale:parity`, `npm run type-check`, and the targeted recovery tests.

## Payment Blockers

Missing or unpaid payments must route the user to the order payment flow. The default recipe must not create a cash or card payment automatically, because payment method, amount, and terminal approval need operator confirmation.
