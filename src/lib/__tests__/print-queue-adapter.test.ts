import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  nativeHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}))

vi.mock('../platform-detect', () => ({
  detectPlatform: () => 'tauri',
  isTauri: () => true,
}))

import { TauriBridge } from '../ipc-adapter'
import { offEvent, onEvent, stopEventBridge } from '../event-bridge'

const nativeJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  reprintOfJobId: null,
  source: 'pos',
  entityType: 'shift_checkout',
  entityId: 'shift-1',
  printerProfileId: 'profile-1',
  printerProfileName: 'Legacy profile name',
  printerDisplayName: 'Front counter MCP31',
  status: 'printing',
  transportState: 'windows_queued',
  resolvedTransport: 'windows',
  resolvedTarget: 'MCP31 - Ethernet:TCP;',
  windowsJobId: 73,
  snapshotAvailable: true,
  capabilities: {
    cancellable: true,
    retryable: false,
    reprintable: false,
  },
  lastError: null,
  warningCode: 'printer_attention',
  warningMessage: 'Paper path needs attention',
  lastSeenAt: '2026-08-12T08:00:00.500Z',
  createdAt: '2026-08-12T08:00:00Z',
  updatedAt: '2026-08-12T08:00:01Z',
  ownershipMarker: 'TheSmallPOS/private-attempt-marker',
  nativeStatusBits: 16,
  nativeStatusText: 'spooling',
  retryCount: 1,
  maxRetries: 3,
  renderProfileSnapshotJson: '{"privateFixture":"must-not-cross-renderer-contract"}',
  ...overrides,
})

const nativeSnapshot = (jobs: unknown[] = [nativeJob()]) => ({
  success: true,
  jobs,
  queuePaused: false,
  pausedPrinterProfileIds: ['profile-paused'],
  counts: {
    active: 7,
    failed: 3,
    stale: 2,
    history: 11,
  },
  pagination: {
    offset: 20,
    limit: 20,
    total: 47,
    hasMore: true,
  },
  internalEnvelopeVersion: 73,
})

describe('print queue Tauri adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nativeHandlers.clear()
    mocks.listen.mockImplementation(async (
      nativeEvent: string,
      callback: (event: { payload: unknown }) => void,
    ) => {
      mocks.nativeHandlers.set(nativeEvent, callback)
      return mocks.unlisten
    })
  })

  afterEach(() => {
    stopEventBridge()
  })

  it('passes typed list options as arg0 and explicitly normalizes the public renderer snapshot', async () => {
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot())
    const bridge = new TauriBridge()

    const result = await bridge.printer.listJobs({
      status: 'failed',
      printerProfileId: 'profile-1',
      limit: 20,
      offset: 20,
    })

    expect(mocks.invoke).toHaveBeenCalledWith('print_list_jobs', {
      arg0: {
        status: 'failed',
        printerProfileId: 'profile-1',
        limit: 20,
        offset: 20,
      },
    })
    expect(result).toEqual({
      success: true,
      jobs: [{
        id: 'job-1',
        source: 'pos',
        entityType: 'shift_checkout',
        entityId: 'shift-1',
        printerProfileId: 'profile-1',
        printerDisplayName: 'Front counter MCP31',
        resolvedTransport: 'windows',
        resolvedTarget: 'MCP31 - Ethernet:TCP;',
        status: 'printing',
        transportState: 'windows_queued',
        spoolJobId: 73,
        snapshotAvailable: true,
        reprintOfJobId: null,
        cancellable: true,
        retryable: false,
        reprintable: false,
        lastError: null,
        warningCode: 'printer_attention',
        warningMessage: 'Paper path needs attention',
        lastSeenAt: '2026-08-12T08:00:00.500Z',
        createdAt: '2026-08-12T08:00:00Z',
        updatedAt: '2026-08-12T08:00:01Z',
      }],
      queuePaused: false,
      pausedPrinterProfileIds: ['profile-paused'],
      counts: { active: 7, failed: 3, stale: 2, history: 11 },
      pagination: { offset: 20, limit: 20, total: 47, hasMore: true },
    })
    expect(result.jobs[0]).not.toHaveProperty('ownershipMarker')
    expect(result.jobs[0]).not.toHaveProperty('nativeStatusBits')
    expect(result.jobs[0]).not.toHaveProperty('renderProfileSnapshotJson')
    expect(result).not.toHaveProperty('internalEnvelopeVersion')
  })

  it('accepts legacy null attempt/target data and resolves display name canonical-first with fallbacks', async () => {
    mocks.invoke
      .mockResolvedValueOnce(nativeSnapshot([nativeJob({
        printerDisplayName: undefined,
        printerProfileName: 'Legacy kitchen printer',
        resolvedTransport: null,
        resolvedTarget: null,
        transportState: null,
        windowsJobId: null,
        snapshotAvailable: false,
        warningCode: null,
        warningMessage: null,
        lastSeenAt: null,
      })]))
      .mockResolvedValueOnce(nativeSnapshot([nativeJob({
        printerDisplayName: undefined,
        printerProfileName: null,
        resolvedTarget: '192.168.1.19:9100',
        resolvedTransport: 'raw_tcp',
        windowsJobId: null,
      })]))
    const bridge = new TauriBridge()

    const legacy = await bridge.printer.listJobs()
    const targetFallback = await bridge.printer.listJobs()

    expect(legacy.jobs[0]).toMatchObject({
      printerDisplayName: 'Legacy kitchen printer',
      resolvedTransport: null,
      resolvedTarget: null,
      transportState: null,
      spoolJobId: null,
      snapshotAvailable: false,
      warningCode: null,
      warningMessage: null,
      lastSeenAt: null,
    })
    expect(targetFallback.jobs[0].printerDisplayName).toBe('192.168.1.19:9100')
  })

  it('uses Rust-compatible Unicode code-point bounds for operator-facing text', async () => {
    const displayName = '😀'.repeat(100)
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot([nativeJob({ printerDisplayName: displayName })]))
    const bridge = new TauriBridge()

    await expect(bridge.printer.listJobs()).resolves.toMatchObject({
      jobs: [{ printerDisplayName: displayName }],
    })
  })

  it('rejects a malformed latest native snapshot instead of replacing the last good renderer state', async () => {
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot([nativeJob({ status: 'invented_state' })]))
    const bridge = new TauriBridge()

    await expect(bridge.printer.listJobs()).rejects.toThrow(
      /Invalid print queue snapshot.*jobs\[0\]\.status/,
    )
  })

  it('rejects an omitted required lastSeenAt field while accepting an explicit legacy null', async () => {
    const { lastSeenAt: _omitted, ...jobWithoutLastSeenAt } = nativeJob()
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot([jobWithoutLastSeenAt]))
    const bridge = new TauriBridge()

    await expect(bridge.printer.listJobs()).rejects.toThrow(
      /Invalid print queue snapshot.*jobs\[0\]\.lastSeenAt/,
    )
  })

  it('rejects an omitted required nullable lastError field', async () => {
    const { lastError: _omitted, ...jobWithoutLastError } = nativeJob()
    mocks.invoke.mockResolvedValueOnce(nativeSnapshot([jobWithoutLastError]))
    const bridge = new TauriBridge()

    await expect(bridge.printer.listJobs()).rejects.toThrow(
      /Invalid print queue snapshot.*jobs\[0\]\.lastError/,
    )
  })

  it.each(['warningCode', 'warningMessage']) (
    'rejects an omitted required nullable %s field',
    async (field) => {
      const jobWithoutWarningField = nativeJob()
      delete jobWithoutWarningField[field]
      mocks.invoke.mockResolvedValueOnce(nativeSnapshot([jobWithoutWarningField]))
      const bridge = new TauriBridge()

      await expect(bridge.printer.listJobs()).rejects.toThrow(
        new RegExp(`Invalid print queue snapshot.*jobs\\[0\\]\\.${field}`),
      )
    },
  )

  it('packs queue mutations correctly and keeps legacy string Reprint callers compatible', async () => {
    const bridge = new TauriBridge()
    const cancelResult = {
      success: true,
      affected: 1,
      unchanged: 0,
      localCancelled: 1,
      activeStopsRequested: 0,
      nativeControlsRequested: 0,
      nativeControlsConfirmed: 0,
      nativeControlsFailed: 0,
      ownershipRefused: 0,
    }
    const bulkCancelResult = {
      success: true,
      affected: 2,
      unchanged: 3,
      localCancelled: 1,
      printerProfileId: 'profile-1',
      activeStopsRequested: 1,
      nativeControlsRequested: 2,
      nativeControlsConfirmed: 1,
      nativeControlsFailed: 1,
      ownershipRefused: 1,
    }
    const pauseResult = {
      success: true,
      queuePaused: false,
      pausedPrinterProfileIds: ['profile-1'],
      printerProfileId: 'profile-1',
      activeStopsRequested: 2,
      nativeControlsRequested: 3,
      nativeControlsConfirmed: 1,
      nativeControlsFailed: 2,
      ownershipRefused: 1,
    }
    const resumeResult = {
      ...pauseResult,
      pausedPrinterProfileIds: [],
      activeStopsRequested: 0,
    }
    const retryResult = {
      success: true,
      jobId: 'job-1',
      newJobId: null,
      affected: 1,
      unchanged: false,
      duplicate: false,
    }
    const reprintResult = {
      success: true,
      jobId: 'job-1',
      newJobId: 'new-job',
      affected: 1,
      unchanged: false,
      duplicate: false,
    }
    mocks.invoke
      .mockResolvedValueOnce(cancelResult)
      .mockResolvedValueOnce(bulkCancelResult)
      .mockResolvedValueOnce(pauseResult)
      .mockResolvedValueOnce(resumeResult)
      .mockResolvedValueOnce(retryResult)
      .mockResolvedValueOnce(reprintResult)
      .mockResolvedValueOnce(reprintResult)

    await expect(bridge.printer.cancelJob('job-1')).resolves.toBe(cancelResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('printer_cancel_job', { arg0: 'job-1' })

    await expect(bridge.printer.cancelAllJobs({
      printerProfileId: 'profile-1',
      statuses: ['pending', 'printing'],
    })).resolves.toBe(bulkCancelResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('printer_cancel_all_jobs', {
      arg0: { printerProfileId: 'profile-1', statuses: ['pending', 'printing'] },
    })

    await expect(bridge.printer.pauseQueue({ printerProfileId: 'profile-1' })).resolves.toBe(pauseResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('printer_pause_queue', {
      arg0: { printerProfileId: 'profile-1' },
    })

    await expect(bridge.printer.resumeQueue({ printerProfileId: 'profile-1' })).resolves.toBe(resumeResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('printer_resume_queue', {
      arg0: { printerProfileId: 'profile-1' },
    })

    await expect(bridge.printer.retryJob('job-1')).resolves.toBe(retryResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('printer_retry_job', { arg0: 'job-1' })

    await expect(bridge.printer.reprintJob({ jobId: 'job-1' })).resolves.toBe(reprintResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('print_reprint_job', {
      arg0: { jobId: 'job-1' },
    })

    await expect(bridge.printer.reprintJob('legacy-job')).resolves.toBe(reprintResult)
    expect(mocks.invoke).toHaveBeenLastCalledWith('print_reprint_job', {
      arg0: 'legacy-job',
    })
  })

  it('maps native print_queue_changed to renderer printer:queue-changed', async () => {
    const rendererListener = vi.fn()
    onEvent('printer:queue-changed', rendererListener)

    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledWith('print_queue_changed', expect.any(Function))
    })
    const nativeHandler = mocks.nativeHandlers.get('print_queue_changed')
    expect(nativeHandler).toBeTypeOf('function')

    nativeHandler?.({ payload: { invalidationOnly: true } })
    expect(rendererListener).toHaveBeenCalledWith({ invalidationOnly: true })

    offEvent('printer:queue-changed', rendererListener)
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
  })
})
