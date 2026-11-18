import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ settings: {} as any }))
vi.mock('../../../lib', () => ({ getBridge: () => ({
  terminalConfig: {
    getSettings: async () => mocks.settings,
    getTerminalId: async () => 'till', getBranchId: async () => 'store', getOrganizationId: async () => 'org',
    getSetting: async () => '',
  },
}) }))
import { clearTerminalCredentialCache, refreshTerminalCredentialCache } from '../terminal-credentials'
describe('trusted group identity from native settings', () => {
  beforeEach(() => { clearTerminalCredentialCache(); mocks.settings = {} })
  it('uses the organization on an older or null-group server', async () => {
    expect((await refreshTerminalCredentialCache()).groupKey).toBe('org')
    mocks.settings = { terminal: { group_id: null } }
    expect((await refreshTerminalCredentialCache()).groupKey).toBe('org')
  })
  it('binds the trusted group after native keyring-only terminal lookups', async () => {
    mocks.settings = { terminal: { group_id: 'first', group_organization_id: 'org', group_branch_id: 'store', group_terminal_id: 'till' } }
    expect((await refreshTerminalCredentialCache()).groupKey).toBe('first')
    mocks.settings.terminal.group_branch_id = 'old-store'
    expect((await refreshTerminalCredentialCache()).groupKey).toBe('org')
  })
})
