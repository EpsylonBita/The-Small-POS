import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emitCompatEvent } from '../../../../lib/event-bridge'
import RepairsView from '../RepairsView'

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    epoch: 1,
    scopeToken: 'scope-a',
    repairs: [],
    workspace: null,
    settings: null,
    conflicts: [],
    attachmentsByRepairId: {},
    selectedRepairId: 'repair-1',
    lastListQuery: null,
    loadSettings: vi.fn().mockResolvedValue(true),
    loadRepairs: vi.fn().mockResolvedValue(true),
    loadConflicts: vi.fn().mockResolvedValue(true),
    loadWorkspace: vi.fn().mockResolvedValue(true),
    loadAttachments: vi.fn().mockResolvedValue(true),
    applyCacheChangedEvent: vi.fn().mockReturnValue(true),
    applyConflictEvent: vi.fn(),
    applyScopeResetEvent: vi.fn(),
    selectRepair: vi.fn(),
    clearSession: vi.fn(),
    executeCommand: vi.fn(),
    stageAttachment: vi.fn(),
    resolveConflict: vi.fn(),
  }
  return {
    state,
    shellProps: null as Record<string, any> | null,
    catalogSearch: vi.fn(),
    catalogBarcodeLookup: vi.fn(),
    printProjection: vi.fn(),
    enqueuePrint: vi.fn(),
  }
})

vi.mock('../store', () => ({
  repairStore: { getState: () => mocks.state },
  useRepairStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock('../service', () => ({
  repairService: {
    searchCustomers: vi.fn(),
    customerDevices: vi.fn(),
    createCustomerDevice: vi.fn(),
    printProjection: mocks.printProjection,
    enqueuePrint: mocks.enqueuePrint,
  },
}))

vi.mock('../RepairCatalogService', () => ({
  repairCatalogService: {
    search: mocks.catalogSearch,
    lookupBarcode: mocks.catalogBarcodeLookup,
  },
}))

vi.mock('../RepairsShell', () => ({
  RepairsShell: (props: Record<string, any>) => {
    mocks.shellProps = props
    return <div>repair shell</div>
  },
}))
vi.mock('../RepairIntakeDialog', () => ({ RepairIntakeDialog: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  mocks.state.workspace = null
  mocks.state.selectedRepairId = 'repair-1'
  mocks.state.scopeToken = 'scope-a'
  mocks.state.loadSettings.mockResolvedValue(true)
  mocks.state.loadRepairs.mockResolvedValue(true)
  mocks.state.loadConflicts.mockResolvedValue(true)
  mocks.state.loadWorkspace.mockImplementation(async (repairId: string) => {
    mocks.state.workspace = { repair: { id: repairId } }
    return true
  })
  mocks.state.loadAttachments.mockResolvedValue(true)
  mocks.catalogSearch.mockResolvedValue([])
  mocks.catalogBarcodeLookup.mockResolvedValue(null)
  mocks.printProjection.mockReset()
  mocks.enqueuePrint.mockReset()
})

describe('RepairsView native cache event integration', () => {
  it('ignores authoritative read events and performs one bounded refresh for a mutation event', async () => {
    render(<RepairsView connectivity="online" hasActiveShift actorKey="actor-a" />)
    await waitFor(() => expect(mocks.state.loadAttachments).toHaveBeenCalled())
    vi.clearAllMocks()

    act(() => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: null,
        reason: 'authoritative_list',
      })
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: 'repair-1',
        reason: 'authoritative_workspace',
      })
    })
    expect(mocks.state.loadRepairs).not.toHaveBeenCalled()
    expect(mocks.state.loadWorkspace).not.toHaveBeenCalled()

    mocks.state.loadRepairs.mockImplementationOnce(async () => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: null,
        reason: 'authoritative_list',
      })
      return true
    })
    mocks.state.loadWorkspace.mockImplementationOnce(async () => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: 'repair-1',
        reason: 'authoritative_workspace',
      })
      mocks.state.workspace = { repair: { id: 'repair-1' } }
      return true
    })

    act(() => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: 'repair-1',
        reason: 'authoritative_command',
      })
    })

    await waitFor(() => expect(mocks.state.loadRepairs).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.state.loadWorkspace).toHaveBeenCalledTimes(1))
    expect(mocks.state.loadAttachments).toHaveBeenCalledTimes(1)
  })

  it('coalesces a mutation received during refresh into one trailing refresh', async () => {
    render(<RepairsView connectivity="online" hasActiveShift actorKey="actor-a" />)
    await waitFor(() => expect(mocks.state.loadAttachments).toHaveBeenCalled())
    vi.clearAllMocks()

    let releaseFirstRefresh: (() => void) | undefined
    mocks.state.loadRepairs
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstRefresh = resolve
      }))
      .mockResolvedValue(true)

    act(() => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: 'repair-1',
        reason: 'authoritative_command',
      })
    })
    await waitFor(() => expect(mocks.state.loadRepairs).toHaveBeenCalledTimes(1))

    act(() => {
      emitCompatEvent('repairs:cache-changed', {
        scopeToken: 'scope-a',
        repairId: 'repair-1',
        reason: 'attachment_queued',
      })
    })
    expect(mocks.state.loadRepairs).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseFirstRefresh?.()
    })

    await waitFor(() => expect(mocks.state.loadRepairs).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.state.loadWorkspace).toHaveBeenCalledTimes(2))
    expect(mocks.state.loadAttachments).toHaveBeenCalledTimes(2)
  })

  it('wires terminal-scoped catalog lookup and native-authoritative printing into the live shell', async () => {
    const repairId = '11111111-1111-4111-8111-111111111111'
    const organizationId = '22222222-2222-4222-8222-222222222222'
    const branchId = '33333333-3333-4333-8333-333333333333'
    mocks.state.selectedRepairId = repairId
    mocks.state.workspace = { repair: { id: repairId }, scopeToken: 'scope-a' }
    mocks.state.loadWorkspace.mockResolvedValue(true)
    mocks.enqueuePrint.mockResolvedValue({
      scopeToken: 'scope-a',
      repairId,
      kind: 'repair_intake',
      jobId: '44444444-4444-4444-8444-444444444444',
      queued: true,
    })

    render(<RepairsView
      connectivity="online"
      hasActiveShift
      actorKey="actor-a"
      organizationId={organizationId}
      branchId={branchId}
    />)
    await waitFor(() => expect(mocks.shellProps).not.toBeNull())

    await mocks.shellProps?.onCatalogSearch('part', 'screen')
    expect(mocks.catalogSearch).toHaveBeenCalledWith({
      organizationId,
      branchId,
      kind: 'part',
      query: 'screen',
    })

    await mocks.shellProps?.onPrintRepair('repair_intake')
    expect(mocks.printProjection).not.toHaveBeenCalled()
    expect(mocks.enqueuePrint).toHaveBeenCalledWith({
      scopeToken: 'scope-a',
      repairId,
      kind: 'repair_intake',
    })
  })
})
