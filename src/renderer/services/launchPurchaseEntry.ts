import { getBridge } from '../../lib'
import { normalizeAdminDashboardUrl } from '../utils/connection-code'

export async function readLaunchPurchaseContext(): Promise<{ organizationId: string; key: string; adminUrl: string }> {
  const bridge = getBridge()
  const [organizationId, terminalId, adminUrl] = await Promise.all([
    bridge.terminalConfig.getOrganizationId(), bridge.terminalConfig.getTerminalId(), bridge.settings.getAdminUrl(),
  ])
  if (!organizationId || !terminalId || !adminUrl?.trim()) throw new Error('Purchase context unavailable')
  const normalized = normalizeAdminDashboardUrl(adminUrl)
  return { organizationId, adminUrl: normalized, key: JSON.stringify([organizationId, terminalId, normalized]) }
}
