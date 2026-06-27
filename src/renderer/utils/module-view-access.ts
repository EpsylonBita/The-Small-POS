/**
 * Fail-closed module view access (THE-315).
 *
 * RefactoredMainLayout's route guards used to block a view only when it was
 * present in `lockedModules` with a `requiredPlan`. The API sync path filters
 * the module list to purchased/core modules and clears `lockedModules`
 * entirely ("API already filters"), so a module the org never acquired is
 * ABSENT from both lists — and the old guard let it straight through to the
 * view registry. This module is the single predicate both guard sites use:
 * a module-backed view is accessible only when its module is actually in the
 * enabled list.
 *
 * Kept free of React/context imports so the support-layer node:test suite
 * can exercise it directly.
 */

import { isCoreModule } from '../../shared/constants/pos-modules';

/**
 * View keys that render a module-backed view under a different id.
 * Must stay in sync with the aliases in RefactoredMainLayout's
 * VIEW_COMPONENTS registry.
 */
export const VIEW_MODULE_ALIASES: Record<string, string> = {
  customers: 'users',
  integrations: 'plugin_integrations',
  services: 'service_catalog',
};

/**
 * Shell views that exist without a backing purchasable module. 'settings' is
 * a dedicated page/modal, not a module; 'dashboard' is the core screen.
 */
const NON_MODULE_VIEWS = new Set(['dashboard', 'settings']);

/** Minimal structural slice of module-context's EnabledModule. */
export interface ViewAccessModuleLike {
  module: { id: string };
}

export function resolveViewModuleId(view: string): string {
  return VIEW_MODULE_ALIASES[view] ?? view;
}

function matchesResolvedModuleId(viewModuleId: string, enabledModuleId: string): boolean {
  return enabledModuleId === viewModuleId || resolveViewModuleId(enabledModuleId) === viewModuleId;
}

/**
 * True when navigating to `view` must be refused because its backing module
 * is not enabled for this org/terminal.
 *
 * - Non-module shell views and core screens are always allowed.
 * - While the module list has not hydrated yet (empty array on bootstrap —
 *   a synced terminal always carries its core modules), nothing is denied;
 *   the offline-first shell must not brick navigation before module data
 *   loads.
 * - Everything else is denied unless the module id (after alias resolution)
 *   is present in the enabled list. Locked modules and modules absent from
 *   the sync payload are both "not enabled" — that distinction only matters
 *   for upgrade-prompt copy, which the caller derives separately.
 */
export function isViewAccessDenied(
  enabledModules: ViewAccessModuleLike[],
  view: string
): boolean {
  const moduleId = resolveViewModuleId(view);
  if (NON_MODULE_VIEWS.has(moduleId) || isCoreModule(moduleId)) {
    return false;
  }
  if (enabledModules.length === 0) {
    return false;
  }
  return !enabledModules.some((entry) => matchesResolvedModuleId(moduleId, entry.module.id));
}
