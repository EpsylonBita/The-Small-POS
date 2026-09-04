import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type {
  RepairAttachmentSnapshot,
  RepairCacheChangedEvent,
  RepairCommandSnapshot,
  RepairConflictEvent,
  RepairConflictResolution,
  RepairConflictResolutionSnapshot,
  RepairConflictSnapshot,
  RepairListItemSnapshot,
  RepairPaginationSnapshot,
  RepairScopeResetEvent,
  RepairSettingsSnapshot,
  RepairStageAttachmentSnapshot,
  RepairWorkspaceSnapshot,
} from './contracts'
import {
  repairService,
  type RepairExecuteCommandRequest,
  type RepairListQuery,
  type RepairResolveConflictRequest,
  type RepairServicePort,
  type RepairStageAttachmentRequest,
} from './service'

export interface RepairStoreService extends Pick<RepairServicePort,
  | 'list'
  | 'workspace'
  | 'settings'
  | 'listAttachments'
  | 'listConflicts'
  | 'executeCommand'
  | 'stageAttachment'
  | 'resolveConflict'
> {}

interface RequestGeneration {
  epoch: number
  scopeToken: string | null
}

export interface RepairStoreState {
  epoch: number
  scopeToken: string | null
  repairs: RepairListItemSnapshot[]
  pagination: RepairPaginationSnapshot | null
  workspace: RepairWorkspaceSnapshot | null
  settings: RepairSettingsSnapshot | null
  attachmentsByRepairId: Record<string, RepairAttachmentSnapshot[]>
  conflicts: RepairConflictSnapshot[]
  selectedRepairId: string | null
  cacheRevision: number
  staleRepairIds: string[]
  allRepairsStale: boolean
  lastListQuery: RepairListQuery | null

  loadRepairs(input: RepairListQuery): Promise<boolean>
  loadWorkspace(repairId: string): Promise<boolean>
  loadSettings(): Promise<boolean>
  loadAttachments(repairId: string): Promise<boolean>
  loadConflicts(): Promise<boolean>
  executeCommand(input: RepairExecuteCommandRequest): Promise<RepairCommandSnapshot | null>
  stageAttachment(input: RepairStageAttachmentRequest): Promise<RepairStageAttachmentSnapshot | null>
  resolveConflict(
    conflictId: string,
    resolution: RepairConflictResolution,
  ): Promise<RepairConflictResolutionSnapshot | null>
  applyCacheChangedEvent(event: RepairCacheChangedEvent): boolean
  applyConflictEvent(event: RepairConflictEvent): boolean
  applyScopeResetEvent(event: RepairScopeResetEvent): boolean
  selectRepair(repairId: string | null): void
  clearSession(): void
}

const scopedEmptyState = {
  repairs: [] as RepairListItemSnapshot[],
  pagination: null as RepairPaginationSnapshot | null,
  workspace: null as RepairWorkspaceSnapshot | null,
  settings: null as RepairSettingsSnapshot | null,
  attachmentsByRepairId: {} as Record<string, RepairAttachmentSnapshot[]>,
  conflicts: [] as RepairConflictSnapshot[],
  selectedRepairId: null as string | null,
  cacheRevision: 0,
  staleRepairIds: [] as string[],
  allRepairsStale: false,
  lastListQuery: null as RepairListQuery | null,
}

function unionAliases(...groups: Array<readonly (string | null | undefined)[]>): string[] {
  const result = new Set<string>()
  for (const group of groups) {
    for (const value of group) {
      if (typeof value === 'string' && value.length > 0) result.add(value)
    }
  }
  return [...result]
}

function reconcileRepairList(
  previous: RepairListItemSnapshot[],
  incoming: RepairListItemSnapshot[],
): RepairListItemSnapshot[] {
  const previousById = new Map(previous.map((item) => [item.id, item]))
  const reconciled = new Map<string, RepairListItemSnapshot>()

  for (const item of incoming) {
    const prior = reconciled.get(item.id) ?? previousById.get(item.id)
    const changedDisplayNumber = prior && prior.displayNumber !== item.displayNumber
      ? prior.displayNumber
      : null
    reconciled.set(item.id, {
      ...item,
      aliases: unionAliases(prior?.aliases ?? [], item.aliases, [changedDisplayNumber]),
    })
  }
  return [...reconciled.values()]
}

function reconcileWorkspace(
  previous: RepairWorkspaceSnapshot | null,
  incoming: RepairWorkspaceSnapshot,
): RepairWorkspaceSnapshot {
  if (!previous || previous.repair.id !== incoming.repair.id) return incoming
  const changedDisplayNumber = previous.repair.displayNumber !== incoming.repair.displayNumber
    ? previous.repair.displayNumber
    : null
  return {
    ...incoming,
    aliases: unionAliases(previous.aliases, incoming.aliases, [changedDisplayNumber]),
  }
}

/** Copy only fields declared safe by the native conflict projection. */
export function projectSafeRepairConflict(
  conflict: RepairConflictSnapshot,
): RepairConflictSnapshot {
  return {
    conflictId: conflict.conflictId,
    repairId: conflict.repairId,
    expectedVersion: conflict.expectedVersion,
    currentVersion: conflict.currentVersion,
    displayNumber: conflict.displayNumber,
    status: conflict.status,
    updatedAt: conflict.updatedAt,
    allowedTransitions: [...conflict.allowedTransitions],
    createdAt: conflict.createdAt,
  }
}

function upsertConflict(
  conflicts: RepairConflictSnapshot[],
  conflict: RepairConflictSnapshot,
): RepairConflictSnapshot[] {
  const projected = projectSafeRepairConflict(conflict)
  const index = conflicts.findIndex((item) => item.conflictId === projected.conflictId)
  if (index < 0) return [...conflicts, projected]
  return conflicts.map((item, current) => current === index ? projected : item)
}

export function createRepairStore(
  service: RepairStoreService = repairService,
): StoreApi<RepairStoreState> {
  return createStore<RepairStoreState>((set, get) => {
    const captureGeneration = (): RequestGeneration => ({
      epoch: get().epoch,
      scopeToken: get().scopeToken,
    })

    const acceptScopeResponse = (
      generation: RequestGeneration,
      responseScopeToken: string,
    ): boolean => {
      if (responseScopeToken.length === 0) return false
      const current = get()
      if (current.epoch !== generation.epoch) return false
      if (generation.scopeToken !== null && current.scopeToken !== generation.scopeToken) return false
      if (current.scopeToken !== null && current.scopeToken !== responseScopeToken) return false
      if (current.scopeToken === null) set({ scopeToken: responseScopeToken })
      return true
    }

    const markRepairStale = (
      repairId: string,
      generation: RequestGeneration,
    ): void => {
      const current = get()
      if (current.epoch !== generation.epoch || current.scopeToken !== generation.scopeToken) return
      set({
        cacheRevision: current.cacheRevision + 1,
        staleRepairIds: unionAliases(current.staleRepairIds, [repairId]),
      })
    }

    const refreshRepair = async (
      repairId: string,
      generation: RequestGeneration,
    ): Promise<void> => {
      const current = get()
      if (current.epoch !== generation.epoch || current.scopeToken !== generation.scopeToken) return
      const refreshes: Promise<boolean>[] = []
      if (current.lastListQuery) refreshes.push(get().loadRepairs(current.lastListQuery))
      if (current.selectedRepairId === repairId || current.workspace?.repair.id === repairId) {
        refreshes.push(get().loadWorkspace(repairId))
      }
      const results = await Promise.allSettled(refreshes)
      if (results.some((result) => result.status === 'rejected')) {
        markRepairStale(repairId, generation)
      }
    }

    return {
      epoch: 0,
      scopeToken: null,
      ...scopedEmptyState,

      async loadRepairs(input) {
        const generation = captureGeneration()
        const snapshot = await service.list({
          status: input.status,
          search: input.search,
          limit: input.limit,
          offset: input.offset,
        })
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return false
        set((state) => ({
          repairs: reconcileRepairList(state.repairs, snapshot.repairs),
          pagination: snapshot.pagination,
          lastListQuery: {
            status: input.status,
            search: input.search,
            limit: input.limit,
            offset: input.offset,
          },
          allRepairsStale: false,
          staleRepairIds: [],
        }))
        return true
      },

      async loadWorkspace(repairId) {
        const generation = captureGeneration()
        const snapshot = await service.workspace(repairId)
        if (snapshot.repair.id !== repairId) return false
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return false
        if (get().selectedRepairId !== repairId) return false
        set((state) => ({
          workspace: reconcileWorkspace(state.workspace, snapshot),
          staleRepairIds: state.staleRepairIds.filter((id) => id !== repairId),
        }))
        return true
      },

      async loadSettings() {
        const generation = captureGeneration()
        const snapshot = await service.settings()
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return false
        set({ settings: snapshot })
        return true
      },

      async loadAttachments(repairId) {
        const generation = captureGeneration()
        const snapshot = await service.listAttachments(repairId)
        if (snapshot.repairId !== repairId) return false
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return false
        set((state) => ({
          attachmentsByRepairId: {
            ...state.attachmentsByRepairId,
            [repairId]: snapshot.attachments.map((attachment) => ({ ...attachment })),
          },
        }))
        return true
      },

      async loadConflicts() {
        const generation = captureGeneration()
        const snapshot = await service.listConflicts()
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return false
        set({ conflicts: snapshot.conflicts.map(projectSafeRepairConflict) })
        return true
      },

      async executeCommand(input) {
        const generation = captureGeneration()
        const snapshot = await service.executeCommand(input)
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return null

        if (snapshot.kind === 'conflict') {
          set((state) => ({ conflicts: upsertConflict(state.conflicts, snapshot.conflict) }))
        } else {
          set((state) => ({
            repairs: state.repairs.map((item) => {
              if (item.id !== snapshot.repairId) return item
              const displayNumber = snapshot.displayNumber ?? item.displayNumber
              return {
                ...item,
                displayNumber,
                aliases: unionAliases(
                  item.aliases,
                  item.displayNumber !== displayNumber ? [item.displayNumber] : [],
                ),
                status: snapshot.status,
                optimisticVersion: snapshot.version,
                syncState: snapshot.queuedForSync ? 'queued' : item.syncState,
              }
            }),
            workspace: state.workspace?.repair.id === snapshot.repairId
              ? (() => {
                  const previousDisplayNumber = state.workspace.repair.displayNumber
                  const displayNumber = snapshot.displayNumber ?? previousDisplayNumber
                  return {
                    ...state.workspace,
                    aliases: unionAliases(
                      state.workspace.aliases,
                      previousDisplayNumber !== displayNumber ? [previousDisplayNumber] : [],
                    ),
                    repair: {
                      ...state.workspace.repair,
                      displayNumber,
                      status: snapshot.status,
                      version: snapshot.version,
                    },
                    syncState: snapshot.queuedForSync ? 'queued' as const : state.workspace.syncState,
                  }
                })()
              : state.workspace,
          }))
        }

        const acceptedGeneration = captureGeneration()
        await refreshRepair(snapshot.kind === 'conflict' ? snapshot.conflict.repairId : snapshot.repairId, acceptedGeneration)
        const current = get()
        return current.epoch === acceptedGeneration.epoch
          && current.scopeToken === acceptedGeneration.scopeToken
          ? snapshot
          : null
      },

      async stageAttachment(input) {
        const generation = captureGeneration()
        const snapshot = await service.stageAttachment(input)
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return null
        const acceptedGeneration = captureGeneration()
        const refreshes = await Promise.allSettled([
          refreshRepair(snapshot.repairId, acceptedGeneration),
          get().loadAttachments(snapshot.repairId),
        ])
        if (refreshes.some((result) => result.status === 'rejected')) {
          markRepairStale(snapshot.repairId, acceptedGeneration)
        }
        const current = get()
        return current.epoch === acceptedGeneration.epoch
          && current.scopeToken === acceptedGeneration.scopeToken
          ? snapshot
          : null
      },

      async resolveConflict(conflictId, resolution) {
        const generation = captureGeneration()
        const request: RepairResolveConflictRequest = { conflictId, resolution }
        const snapshot = await service.resolveConflict(request)
        if (!acceptScopeResponse(generation, snapshot.scopeToken)) return null
        set((state) => ({
          conflicts: state.conflicts.filter((conflict) => conflict.conflictId !== conflictId),
        }))
        const acceptedGeneration = captureGeneration()
        const refreshes = await Promise.allSettled([
          refreshRepair(snapshot.repairId, acceptedGeneration),
          get().loadConflicts(),
        ])
        if (refreshes.some((result) => result.status === 'rejected')) {
          markRepairStale(snapshot.repairId, acceptedGeneration)
        }
        const current = get()
        return current.epoch === acceptedGeneration.epoch
          && current.scopeToken === acceptedGeneration.scopeToken
          ? snapshot
          : null
      },

      applyCacheChangedEvent(event) {
        const state = get()
        if (state.scopeToken === null || state.scopeToken !== event.scopeToken) return false
        set({
          cacheRevision: state.cacheRevision + 1,
          allRepairsStale: state.allRepairsStale || event.repairId === null,
          staleRepairIds: event.repairId === null
            ? state.staleRepairIds
            : unionAliases(state.staleRepairIds, [event.repairId]),
        })
        return true
      },

      applyConflictEvent(event) {
        const state = get()
        if (state.scopeToken === null || state.scopeToken !== event.scopeToken) return false
        set({ conflicts: upsertConflict(state.conflicts, event.conflict) })
        return true
      },

      applyScopeResetEvent(event) {
        if (event.scopeToken.length === 0) return false
        set((state) => ({
          ...scopedEmptyState,
          epoch: state.epoch + 1,
          scopeToken: event.scopeToken,
        }))
        return true
      },

      selectRepair(repairId) {
        set({ selectedRepairId: repairId })
      },

      clearSession() {
        set((state) => ({
          ...scopedEmptyState,
          epoch: state.epoch + 1,
          scopeToken: null,
        }))
      },
    }
  })
}

export const repairStore = createRepairStore()

export function useRepairStore<T>(selector: (state: RepairStoreState) => T): T {
  return useStore(repairStore, selector)
}
