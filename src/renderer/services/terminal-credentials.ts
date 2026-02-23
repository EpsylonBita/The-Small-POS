import { getBridge } from '../../lib'

type TerminalCredentialState = {
  terminalId: string
  apiKey: string
  organizationId: string
  branchId: string
}

const state: TerminalCredentialState = {
  terminalId: '',
  apiKey: '',
  organizationId: '',
  branchId: '',
}

type TerminalSettingsShape = {
  terminal?: {
    terminal_id?: string
    pos_api_key?: string
    organization_id?: string
    branch_id?: string
  }
  [key: string]: unknown
}

function readFromSettings(settings: TerminalSettingsShape | null | undefined): TerminalCredentialState {
  if (!settings) {
    return { terminalId: '', apiKey: '', organizationId: '', branchId: '' }
  }

  const terminalId =
    (settings['terminal.terminal_id'] as string | undefined) ||
    settings.terminal?.terminal_id ||
    ''
  const apiKey =
    (settings['terminal.pos_api_key'] as string | undefined) ||
    settings.terminal?.pos_api_key ||
    ''
  const organizationId =
    (settings['terminal.organization_id'] as string | undefined) ||
    settings.terminal?.organization_id ||
    ''
  const branchId =
    (settings['terminal.branch_id'] as string | undefined) ||
    settings.terminal?.branch_id ||
    ''

  return { terminalId, apiKey, organizationId, branchId }
}

export function updateTerminalCredentialCache(
  next: Partial<TerminalCredentialState>
): void {
  if (typeof next.terminalId === 'string') state.terminalId = next.terminalId
  if (typeof next.apiKey === 'string') state.apiKey = next.apiKey
  if (typeof next.organizationId === 'string') state.organizationId = next.organizationId
  if (typeof next.branchId === 'string') state.branchId = next.branchId
}

export function clearTerminalCredentialCache(): void {
  state.terminalId = ''
  state.apiKey = ''
  state.organizationId = ''
  state.branchId = ''
}

export function getCachedTerminalCredentials(): TerminalCredentialState {
  return { ...state }
}

function normalizeCredentialValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function invokeSettings(): Promise<TerminalSettingsShape | null> {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const settings = await getBridge().terminalConfig.getSettings()
    return (settings ?? null) as TerminalSettingsShape | null
  } catch {
    return null
  }
}

async function invokeSettingByKey(key: string): Promise<string> {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const value = await getBridge().terminalConfig.getSetting('terminal', key)
    return normalizeCredentialValue(value)
  } catch {
    return ''
  }
}

type SpecializedTerminalLookup =
  | 'terminal-config:get-terminal-id'
  | 'terminal-config:get-branch-id'
  | 'terminal-config:get-organization-id'

async function invokeSpecialized(channel: SpecializedTerminalLookup): Promise<string> {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const bridge = getBridge()
    switch (channel) {
      case 'terminal-config:get-terminal-id':
        return normalizeCredentialValue(await bridge.terminalConfig.getTerminalId())
      case 'terminal-config:get-branch-id':
        return normalizeCredentialValue(await bridge.terminalConfig.getBranchId())
      case 'terminal-config:get-organization-id':
        return normalizeCredentialValue(await bridge.terminalConfig.getOrganizationId())
      default:
        return ''
    }
  } catch {
    return ''
  }
}

async function invokeTerminalApiKey(): Promise<string> {
  return invokeSettingByKey('pos_api_key')
}

export async function refreshTerminalCredentialCache(): Promise<TerminalCredentialState> {
  const settings = await invokeSettings()
  const resolved = readFromSettings(settings)

  if (!resolved.terminalId) {
    resolved.terminalId = await invokeSpecialized('terminal-config:get-terminal-id')
  }
  if (!resolved.branchId) {
    resolved.branchId = await invokeSpecialized('terminal-config:get-branch-id')
  }
  if (!resolved.organizationId) {
    resolved.organizationId = await invokeSpecialized('terminal-config:get-organization-id')
  }
  if (!resolved.apiKey) {
    resolved.apiKey = await invokeTerminalApiKey()
  }
  if (!resolved.terminalId) {
    resolved.terminalId = await invokeSettingByKey('terminal_id')
  }
  if (!resolved.branchId) {
    resolved.branchId = await invokeSettingByKey('branch_id')
  }
  if (!resolved.organizationId) {
    resolved.organizationId = await invokeSettingByKey('organization_id')
  }

  if (resolved.terminalId || resolved.apiKey || resolved.organizationId || resolved.branchId) {
    updateTerminalCredentialCache(resolved)
  }
  return getCachedTerminalCredentials()
}

export async function getResolvedTerminalCredentials(): Promise<TerminalCredentialState> {
  const cached = getCachedTerminalCredentials()
  if (cached.terminalId && cached.apiKey && cached.organizationId && cached.branchId) {
    return cached
  }
  return refreshTerminalCredentialCache()
}

export async function getResolvedTerminalIdentity(): Promise<{
  terminalId: string
  organizationId: string
  branchId: string
}> {
  const creds = await getResolvedTerminalCredentials()
  return {
    terminalId: creds.terminalId || '',
    organizationId: creds.organizationId || '',
    branchId: creds.branchId || '',
  }
}

export async function getPosAuthHeaders(): Promise<Record<string, string>> {
  const creds = await getResolvedTerminalCredentials()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (creds.apiKey) headers['x-pos-api-key'] = String(creds.apiKey)
  if (creds.terminalId) headers['x-terminal-id'] = String(creds.terminalId)
  return headers
}
