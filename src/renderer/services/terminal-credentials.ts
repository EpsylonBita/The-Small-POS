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

async function invokeSettings(): Promise<TerminalSettingsShape | null> {
  if (typeof window === 'undefined') {
    return null
  }

  const electronBridge = (window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
  })

  try {
    if (electronBridge.electron?.ipcRenderer?.invoke) {
      const settings = await electronBridge.electron.ipcRenderer.invoke('terminal-config:get-settings')
      return (settings ?? null) as TerminalSettingsShape | null
    }
    if (electronBridge.electronAPI?.invoke) {
      const settings = await electronBridge.electronAPI.invoke('terminal-config:get-settings')
      return (settings ?? null) as TerminalSettingsShape | null
    }
  } catch {
    return null
  }

  return null
}

async function invokeTerminalApiKey(): Promise<string> {
  if (typeof window === 'undefined') {
    return ''
  }

  const electronBridge = (window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> } }
    electronAPI?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
  })

  try {
    if (electronBridge.electron?.ipcRenderer?.invoke) {
      const value = await electronBridge.electron.ipcRenderer.invoke(
        'terminal-config:get-setting',
        'terminal',
        'pos_api_key'
      )
      return typeof value === 'string' ? value : ''
    }
    if (electronBridge.electronAPI?.invoke) {
      const value = await electronBridge.electronAPI.invoke(
        'terminal-config:get-setting',
        'terminal',
        'pos_api_key'
      )
      return typeof value === 'string' ? value : ''
    }
  } catch {
    return ''
  }

  return ''
}

export async function refreshTerminalCredentialCache(): Promise<TerminalCredentialState> {
  const settings = await invokeSettings()
  const resolved = readFromSettings(settings)
  if (!resolved.apiKey) {
    resolved.apiKey = await invokeTerminalApiKey()
  }
  if (resolved.terminalId || resolved.apiKey || resolved.organizationId || resolved.branchId) {
    updateTerminalCredentialCache(resolved)
  }
  return getCachedTerminalCredentials()
}
