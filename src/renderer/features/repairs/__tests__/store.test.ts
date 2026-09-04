import { describe, expect, it, vi } from 'vitest'

import type { RepairExecuteCommandRequest } from '../service'
import type {
  RepairConflictSnapshot,
  RepairListItemSnapshot,
  RepairListSnapshot,
  RepairWorkspaceSnapshot,
} from '../contracts'
import { createRepairStore, type RepairStoreService } from '../store'

const REPAIR_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_REPAIR_ID = '99999999-9999-4999-8999-999999999999'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function repair(
  displayNumber: string,
  aliases: string[] = [],
): RepairListItemSnapshot {
  return {
    id: REPAIR_ID,
    displayNumber,
    aliases,
    status: 'received',
    priority: 'normal',
    intakeMode: 'standard',
    safeDeviceLabel: 'Phone',
    dueAt: null,
    readyAt: null,
    authoritativeVersion: 1,
    optimisticVersion: 1,
    syncState: 'synced',
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:00:00.000Z',
  }
}

function listSnapshot(
  scopeToken: string,
  repairs: RepairListItemSnapshot[],
): RepairListSnapshot {
  return {
    scopeToken,
    source: 'authoritative_cache',
    repairs,
    pagination: { count: repairs.length, limit: 20, offset: 0 },
  }
}

function serviceWith(list: RepairStoreService['list']): RepairStoreService {
  return {
    list,
    workspace: vi.fn(),
    settings: vi.fn(),
    listAttachments: vi.fn(),
    listConflicts: vi.fn(),
    executeCommand: vi.fn(),
    stageAttachment: vi.fn(),
    resolveConflict: vi.fn(),
  }
}

function conflict(overrides: Partial<RepairConflictSnapshot> = {}): RepairConflictSnapshot {
  return {
    conflictId: '22222222-2222-4222-8222-222222222222',
    repairId: REPAIR_ID,
    expectedVersion: 1,
    currentVersion: 2,
    displayNumber: 'R-ATH-26-000001',
    status: 'diagnosing',
    updatedAt: '2026-08-27T08:05:00.000Z',
    allowedTransitions: ['waiting_customer_approval'],
    createdAt: '2026-08-27T08:06:00.000Z',
    ...overrides,
  }
}

function workspaceSnapshot(repairId: string, displayNumber: string): RepairWorkspaceSnapshot {
  return {
    scopeToken: 'scope-a',
    repair: { id: repairId, displayNumber, status: 'received', version: 1 },
    aliases: [],
    syncState: 'synced',
  } as RepairWorkspaceSnapshot
}

describe('repair store scope isolation', () => {
  it('does not let a stale promise repopulate state after session clear', async () => {
    const pending = deferred<RepairListSnapshot>()
    const store = createRepairStore(serviceWith(vi.fn(() => pending.promise)))
    const load = store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    store.getState().clearSession()
    pending.resolve(listSnapshot('scope-old', [repair('R-OFF-ABCD-000001')]))

    await expect(load).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ scopeToken: null, repairs: [] })
  })

  it('scope reset clears state and rejects the promise from the previous epoch', async () => {
    const pending = deferred<RepairListSnapshot>()
    const list = vi.fn()
      .mockResolvedValueOnce(listSnapshot('scope-a', [repair('R-OFF-ABCD-000001')]))
      .mockImplementationOnce(() => pending.promise)
    const store = createRepairStore(serviceWith(list))
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })
    const load = store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    expect(store.getState().applyScopeResetEvent({
      scopeToken: 'scope-b',
      reason: 'identity_rebound',
    })).toBe(true)
    pending.resolve(listSnapshot('scope-a', [repair('R-ATH-26-000001')]))

    await expect(load).resolves.toBe(false)
    expect(store.getState()).toMatchObject({ scopeToken: 'scope-b', repairs: [] })
  })

  it('rejects foreign-scope cache and conflict events', async () => {
    const store = createRepairStore(serviceWith(vi.fn().mockResolvedValue(
      listSnapshot('scope-a', [repair('R-OFF-ABCD-000001')]),
    )))
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    expect(store.getState().applyCacheChangedEvent({
      scopeToken: 'scope-foreign',
      repairId: REPAIR_ID,
      reason: 'sync',
    })).toBe(false)
    expect(store.getState().applyConflictEvent({
      scopeToken: 'scope-foreign',
      conflict: conflict(),
    })).toBe(false)
    expect(store.getState().cacheRevision).toBe(0)
    expect(store.getState().conflicts).toEqual([])
  })
})

describe('repair store identity and safe projections', () => {
  it('rejects a workspace response after another repair becomes selected', async () => {
    const first = deferred<RepairWorkspaceSnapshot>()
    const second = deferred<RepairWorkspaceSnapshot>()
    const service = serviceWith(vi.fn())
    service.workspace = vi.fn((repairId: string) => repairId === REPAIR_ID ? first.promise : second.promise)
    const store = createRepairStore(service)
    store.setState({ scopeToken: 'scope-a' })

    store.getState().selectRepair(REPAIR_ID)
    const firstLoad = store.getState().loadWorkspace(REPAIR_ID)
    store.getState().selectRepair(SECOND_REPAIR_ID)
    const secondLoad = store.getState().loadWorkspace(SECOND_REPAIR_ID)
    second.resolve(workspaceSnapshot(SECOND_REPAIR_ID, 'R-ATH-26-000002'))
    await expect(secondLoad).resolves.toBe(true)
    first.resolve(workspaceSnapshot(REPAIR_ID, 'R-ATH-26-000001'))

    await expect(firstLoad).resolves.toBe(false)
    expect(store.getState().workspace?.repair.id).toBe(SECOND_REPAIR_ID)
  })

  it('reconciles provisional and official numbers by repair id without duplicates', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(listSnapshot('scope-a', [repair('R-OFF-ABCD-000001')]))
      .mockResolvedValueOnce(listSnapshot('scope-a', [repair('R-ATH-26-000001')]))
    const store = createRepairStore(serviceWith(list))

    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })
    store.getState().selectRepair(REPAIR_ID)
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    expect(store.getState().repairs).toHaveLength(1)
    expect(store.getState().repairs[0]).toMatchObject({
      id: REPAIR_ID,
      displayNumber: 'R-ATH-26-000001',
      aliases: ['R-OFF-ABCD-000001'],
    })
    expect(store.getState().selectedRepairId).toBe(REPAIR_ID)
  })

  it('applies a command only in the active generation and refreshes by repair id', async () => {
    const commandResult = deferred<Awaited<ReturnType<RepairStoreService['executeCommand']>>>()
    const service = serviceWith(vi.fn()
      .mockResolvedValueOnce(listSnapshot('scope-a', [repair('R-OFF-ABCD-000001')]))
      .mockResolvedValueOnce(listSnapshot('scope-a', [repair('R-ATH-26-000001')]))
    )
    service.executeCommand = vi.fn(() => commandResult.promise)
    const store = createRepairStore(service)
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    const input: RepairExecuteCommandRequest = {
      operationId: '33333333-3333-4333-8333-333333333333',
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:10:00.000Z',
      command: { command: 'add_note', payload: { note: 'Checked', visibility: 'internal' } },
    }
    const execution = store.getState().executeCommand(input)
    commandResult.resolve({
      kind: 'applied',
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      displayNumber: 'R-ATH-26-000001',
      status: 'diagnosing',
      version: 2,
      queuedForSync: false,
      customerNotificationState: 'not_requested',
    })

    await expect(execution).resolves.toMatchObject({ kind: 'applied', version: 2 })
    expect(service.list).toHaveBeenCalledTimes(2)
    expect(store.getState().repairs).toEqual([
      expect.objectContaining({ id: REPAIR_ID, displayNumber: 'R-ATH-26-000001' }),
    ])
  })

  it('returns null and performs no refresh for a mutation resolved after scope reset', async () => {
    const commandResult = deferred<Awaited<ReturnType<RepairStoreService['executeCommand']>>>()
    const service = serviceWith(vi.fn().mockResolvedValue(
      listSnapshot('scope-a', [repair('R-OFF-ABCD-000001')]),
    ))
    service.executeCommand = vi.fn(() => commandResult.promise)
    const store = createRepairStore(service)
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })
    const execution = store.getState().executeCommand({
      operationId: '33333333-3333-4333-8333-333333333333',
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:10:00.000Z',
      command: { command: 'add_note', payload: { note: 'Checked', visibility: 'internal' } },
    })

    store.getState().applyScopeResetEvent({ scopeToken: 'scope-b', reason: 'identity_rebound' })
    commandResult.resolve({
      kind: 'applied',
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      displayNumber: null,
      status: 'diagnosing',
      version: 2,
      queuedForSync: false,
      customerNotificationState: 'not_requested',
    })

    await expect(execution).resolves.toBeNull()
    expect(service.list).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({ scopeToken: 'scope-b', repairs: [] })
  })

  it('preserves the previous workspace number as an alias and exposes queued sync state', async () => {
    const service = serviceWith(vi.fn())
    service.executeCommand = vi.fn().mockResolvedValue({
      kind: 'applied',
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      displayNumber: 'R-ATH-26-000001',
      status: 'diagnosing',
      version: 2,
      queuedForSync: true,
      customerNotificationState: 'queued_after_sync',
    })
    service.workspace = vi.fn().mockRejectedValue(new Error('refresh unavailable'))
    const store = createRepairStore(service)
    store.setState({
      scopeToken: 'scope-a',
      selectedRepairId: REPAIR_ID,
      workspace: {
        scopeToken: 'scope-a',
        repair: {
          id: REPAIR_ID,
          displayNumber: 'R-OFF-ABCD-000001',
          status: 'received',
          version: 1,
        },
        aliases: [],
        syncState: 'synced',
      } as RepairWorkspaceSnapshot,
    })

    await expect(store.getState().executeCommand({
      operationId: '33333333-3333-4333-8333-333333333333',
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:10:00.000Z',
      command: { command: 'add_note', payload: { note: 'Checked', visibility: 'internal' } },
    })).resolves.toMatchObject({ kind: 'applied', queuedForSync: true })

    expect(store.getState().workspace).toMatchObject({
      repair: { displayNumber: 'R-ATH-26-000001', status: 'diagnosing', version: 2 },
      aliases: ['R-OFF-ABCD-000001'],
      syncState: 'queued',
    })
    expect(store.getState().staleRepairIds).toContain(REPAIR_ID)
  })

  it('keeps successful attachment and conflict results when their refetch fails', async () => {
    const service = serviceWith(vi.fn())
    service.stageAttachment = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      attachmentId: '44444444-4444-4444-8444-444444444444',
      optimisticVersion: 2,
      queuedForSync: true,
    })
    service.listAttachments = vi.fn().mockRejectedValue(new Error('refresh unavailable'))
    service.resolveConflict = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      repairId: REPAIR_ID,
      state: 'accepted_server',
      optimisticVersion: 3,
      needsRefetch: true,
    })
    service.listConflicts = vi.fn().mockRejectedValue(new Error('refresh unavailable'))
    const store = createRepairStore(service)
    store.setState({ scopeToken: 'scope-a', conflicts: [conflict()] })

    await expect(store.getState().stageAttachment({
      attachmentId: '44444444-4444-4444-8444-444444444444',
      operationId: '33333333-3333-4333-8333-333333333333',
      repairId: REPAIR_ID,
      expectedVersion: 1,
      occurredAt: '2026-08-27T08:10:00.000Z',
      attachmentType: 'intake',
      filename: 'device.jpg',
      caption: null,
      mimeType: 'image/jpeg',
      bytes: [1],
    })).resolves.toMatchObject({ attachmentId: '44444444-4444-4444-8444-444444444444' })

    await expect(store.getState().resolveConflict(
      '22222222-2222-4222-8222-222222222222',
      'accept_server',
    )).resolves.toMatchObject({ state: 'accepted_server' })
    expect(store.getState().conflicts).toEqual([])
    expect(store.getState().staleRepairIds).toContain(REPAIR_ID)
  })

  it('stores only the bounded conflict projection and upserts by conflict id', async () => {
    const unsafeConflict = {
      ...conflict(),
      organizationId: 'must-not-survive',
      localEnvelope: { credential: 'must-not-survive' },
      serverPayload: { privateNotes: 'must-not-survive' },
    }
    const listConflicts = vi.fn().mockResolvedValue({
      scopeToken: 'scope-a',
      conflicts: [unsafeConflict],
    })
    const service = serviceWith(vi.fn().mockResolvedValue(listSnapshot('scope-a', [])))
    service.listConflicts = listConflicts
    const store = createRepairStore(service)
    await store.getState().loadRepairs({ status: null, search: null, limit: 20, offset: 0 })

    await expect(store.getState().loadConflicts()).resolves.toBe(true)
    expect(store.getState().conflicts).toEqual([conflict()])
    expect(store.getState().conflicts[0]).not.toHaveProperty('organizationId')
    expect(store.getState().conflicts[0]).not.toHaveProperty('localEnvelope')
  })
})
