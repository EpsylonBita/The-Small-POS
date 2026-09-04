import {
  resolvePrimaryActions,
  type ResolvedPrimaryAction,
} from '../../../shared/primary-actions'

/**
 * Tauri receives module IDs after organization entitlement and terminal
 * allowlist filtering. Pass the same set at both boundaries to remain
 * fail-closed if the shared resolver is reused elsewhere.
 */
export function resolveTauriPrimaryActions(
  terminalFilteredModuleIds: readonly string[],
  quickServiceEnabled: boolean,
): ResolvedPrimaryAction[] {
  return resolvePrimaryActions({
    platform: 'tauri',
    enabledModuleIds: terminalFilteredModuleIds,
    terminalAllowedModuleIds: terminalFilteredModuleIds,
    quickServiceEnabled,
  }).filter(action => action.visible)
}
