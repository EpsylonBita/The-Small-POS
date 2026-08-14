import React from 'react'
import { I18nextProvider } from 'react-i18next'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../../lib/i18n'

const { bridge, queueBridge, runParitySyncCycle, toast } = vi.hoisted(() => ({
  bridge: {
    sync: {
      getStatus: vi.fn(),
      getFinancialStats: vi.fn(),
      getFailedFinancialItems: vi.fn(),
      validateFinancialIntegrity: vi.fn(),
    },
    diagnostics: {
      getSystemHealth: vi.fn(),
      export: vi.fn(),
      sendRemoteIncident: vi.fn(),
    },
    recovery: {
      listActionLog: vi.fn(),
    },
  },
  queueBridge: {
    listItems: vi.fn(),
  },
  runParitySyncCycle: vi.fn(),
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

vi.mock('react-hot-toast', () => ({ default: toast }))

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
}))

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: true }),
}))

vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isMobileWaiter: false, parentTerminalId: null }),
}))

vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({
    endOfDayStatus: {
      status: 'idle',
      pendingReportDate: null,
      cutoffAt: null,
      periodStartAt: null,
      activeReportDate: null,
      activePeriodStartAt: null,
      latestZReportId: null,
      latestZReportSyncState: null,
      canOpenPendingZReport: false,
    },
    isPendingLocalSubmit: false,
  }),
}))

vi.mock('../../services/SyncQueueBridge', () => ({
  getSyncQueueBridge: () => queueBridge,
}))

vi.mock('../../services/ParitySyncCoordinator', () => ({
  PARITY_QUEUE_STATUS_EVENT: 'sync:parity-queue-status',
  PARITY_SYNC_STATUS_EVENT: 'sync:parity-status',
  REALTIME_STATUS_EVENT: 'realtime:status',
  runParitySyncCycle,
}))

vi.mock('../OrderSyncRouteIndicator', () => ({ OrderSyncRouteIndicator: () => null }))
vi.mock('../FinancialSyncPanel', () => ({ FinancialSyncPanel: () => null }))
vi.mock('../support/HealthSupportEntryPoint', () => ({ HealthSupportEntryPoint: () => null }))
vi.mock('../recovery/RecoveryCenterPanel', () => ({ RecoveryCenterPanel: () => null }))

import { SyncStatusIndicator } from '../SyncStatusIndicator'

const HEALTHY_SYNC_STATUS = {
  isOnline: true,
  lastSync: '2026-01-13T14:00:00.000Z',
  pendingItems: 0,
  queuedRemote: 0,
  historicalZReportConflicts: 0,
  backpressureDeferred: 0,
  oldestNextRetryAt: null,
  syncInProgress: false,
  error: null,
  terminalHealth: 100,
  settingsVersion: 1,
  menuVersion: 1,
  pendingPaymentItems: 0,
  failedPaymentItems: 0,
  lastQueueFailure: null,
}

const HEALTHY_SYSTEM_HEALTH = {
  schemaVersion: 71,
  dbSizeBytes: 1,
  isOnline: true,
  lastSyncTime: '2026-01-13T14:00:00.000Z',
  pendingOrders: 0,
  paymentAdjustmentBacklog: {
    genericDeferred: 0,
    waitingForParentPayment: 0,
    waitingForCanonicalRemotePaymentId: 0,
  },
  syncBacklog: {},
  lastSyncTimes: {},
  lastZReport: null,
  printerStatus: {
    configured: true,
    profileCount: 1,
    defaultProfile: 'Front desk',
    recentJobs: [],
  },
}

const queueItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'queue-item-1',
  tableName: 'orders',
  recordId: 'order-42',
  operation: 'UPDATE',
  data: JSON.stringify({ orderNumber: 'ORD-42' }),
  organizationId: 'organization-1',
  createdAt: '2026-01-13T14:00:00.000Z',
  attempts: 2,
  lastAttempt: '2026-01-13T14:01:00.000Z',
  errorMessage: 'Queue processing failed',
  nextRetryAt: null,
  retryDelayMs: 1_000,
  priority: 0,
  moduleType: 'orders',
  conflictStrategy: 'server-wins',
  version: 1,
  status: 'failed',
  ...overrides,
})

const renderIndicator = (showDetails = false) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SyncStatusIndicator showDetails={showDetails} />
    </I18nextProvider>,
  )

const renderHealthModal = () => renderIndicator(true)

const normalized = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() ?? ''
const HEALTH_FRESHNESS_THRESHOLD_MS = 10 * 60 * 1_000

const settleFakeTimerWork = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('SyncStatusIndicator Health Status modal contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    bridge.sync.getStatus.mockResolvedValue(HEALTHY_SYNC_STATUS)
    bridge.sync.getFinancialStats.mockResolvedValue({})
    bridge.sync.getFailedFinancialItems.mockResolvedValue([])
    bridge.sync.validateFinancialIntegrity.mockResolvedValue({ valid: true, issues: [] })
    bridge.diagnostics.getSystemHealth.mockResolvedValue(HEALTHY_SYSTEM_HEALTH)
    bridge.diagnostics.export.mockResolvedValue({ success: false, path: '' })
    bridge.diagnostics.sendRemoteIncident.mockResolvedValue({ success: true })
    bridge.recovery.listActionLog.mockResolvedValue([])
    queueBridge.listItems.mockResolvedValue([])
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  afterEach(async () => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
  })

  it('exposes Health Status as a named modal dialog', async () => {
    renderHealthModal()

    const dialog = await screen.findByRole('dialog', {
      name: i18n.t('sync.healthModal.title'),
    })

    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(
      screen.getByRole('button', { name: i18n.t('sync.healthModal.close') }),
    ).toBeInTheDocument()
  })

  it('renders operator-facing Health Status copy from the active Greek locale', async () => {
    await act(async () => {
      await i18n.changeLanguage('el')
    })
    renderHealthModal()

    await screen.findByRole('button', {
      name: i18n.t('sync.dashboard.openRecovery'),
    })
    await screen.findByText(i18n.t('sync.healthModal.states.healthy.title'))

    for (const englishFragment of [
      'Health Status',
      'Everything is working',
      'What you should do',
      'What is happening',
      'Support actions',
      'Refresh status',
      'Send diagnostics to support',
      'Export diagnostics file',
      'Open advanced details',
    ]) {
      expect(document.body).not.toHaveTextContent(englishFragment)
    }

    expect(document.body).toHaveTextContent(i18n.t('sync.healthModal.title'))
    expect(document.body).toHaveTextContent(
      i18n.t('sync.healthModal.states.healthy.title'),
    )
    expect(document.body).toHaveTextContent(
      i18n.t('sync.healthModal.sections.supportActions'),
    )
  })

  it('reports health data as unavailable when the health check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.diagnostics.getSystemHealth.mockRejectedValueOnce(
      new Error('diagnostic transport unavailable'),
    )
    renderHealthModal()

    await waitFor(() => {
      expect(bridge.diagnostics.getSystemHealth).toHaveBeenCalledTimes(1)
    })

    expect(
      await screen.findByText(i18n.t('sync.healthModal.states.unavailable.title')),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.problems.ready')),
    ).not.toBeInTheDocument()
  })

  it('does not present the pending health check as a healthy result', async () => {
    let resolveHealth: (value: typeof HEALTHY_SYSTEM_HEALTH) => void = () => undefined
    bridge.diagnostics.getSystemHealth.mockReturnValueOnce(
      new Promise<typeof HEALTHY_SYSTEM_HEALTH>((resolve) => {
        resolveHealth = resolve
      }),
    )

    renderHealthModal()

    expect(
      await screen.findByText(i18n.t('sync.healthModal.loading.message')),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.problems.ready')),
    ).not.toBeInTheDocument()

    await act(async () => resolveHealth(HEALTHY_SYSTEM_HEALTH))
    expect(
      await screen.findByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).toBeInTheDocument()
  })

  it('ages retained health data to stale and returns it to ready after a fresh refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-13T14:00:00.000Z'))
    renderHealthModal()
    await settleFakeTimerWork()

    expect(
      screen.getByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.stale.message')),
    ).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_FRESHNESS_THRESHOLD_MS)
    })
    expect(
      screen.queryByText(i18n.t('sync.healthModal.stale.message')),
    ).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(
      screen.getByText(i18n.t('sync.healthModal.stale.message')),
    ).toBeInTheDocument()
    expect(
      screen.getByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: i18n.t('sync.healthModal.actions.refresh'),
      }),
    )
    await settleFakeTimerWork()

    expect(
      screen.queryByText(i18n.t('sync.healthModal.stale.message')),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).toBeInTheDocument()
  })

  it('maps an unknown backend queue status to a localized safe label', async () => {
    const rawStatus = 'vendor_internal_backoff'
    queueBridge.listItems.mockResolvedValue([
      queueItem({ status: rawStatus, errorMessage: 'Queue processing failed' }),
    ])
    renderHealthModal()

    await screen.findByText(i18n.t('sync.healthModal.syncDetails'))

    expect(document.body).not.toHaveTextContent(rawStatus)
    expect(document.body).toHaveTextContent(i18n.t('sync.healthModal.status.unknown'))
  })

  it('does not expose raw backend error details to the operator', async () => {
    const sensitiveBackendError =
      'HTTP 500 Authorization: Bearer terminal-secret customer@example.test'
    queueBridge.listItems.mockResolvedValue([
      queueItem({ errorMessage: sensitiveBackendError }),
    ])
    renderHealthModal()

    await screen.findByText(i18n.t('sync.healthModal.syncDetails'))

    expect(document.body).not.toHaveTextContent(sensitiveBackendError)
    expect(document.body).toHaveTextContent(i18n.t('sync.healthModal.failure.safeError'))
  })

  it('never exposes raw terminal, branch, organization, or incident UUIDs in the Health Status dialog', async () => {
    const rawIds = {
      terminalId: '11111111-1111-4111-8111-111111111111',
      branchId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
      incidentId: '44444444-4444-4444-8444-444444444444',
    }
    bridge.diagnostics.getSystemHealth.mockResolvedValueOnce({
      ...HEALTHY_SYSTEM_HEALTH,
      terminalContext: {
        terminalId: rawIds.terminalId,
        branchId: rawIds.branchId,
        organizationId: rawIds.organizationId,
      },
    })
    bridge.diagnostics.sendRemoteIncident.mockResolvedValueOnce({
      success: true,
      incidentId: rawIds.incidentId,
    })
    renderHealthModal()

    const dialog = await screen.findByRole('dialog', {
      name: i18n.t('sync.healthModal.title'),
    })
    fireEvent.click(
      await within(dialog).findByRole('button', {
        name: i18n.t('sync.healthModal.actions.sendSupport'),
      }),
    )
    await waitFor(() => {
      expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledTimes(1)
    })
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: i18n.t('sync.healthModal.actions.openAdvanced'),
      }),
    )

    for (const rawId of Object.values(rawIds)) {
      expect(dialog).not.toHaveTextContent(rawId)
    }
  })

  it('exports only redacted diagnostics from the operator Health Status dialog', async () => {
    renderHealthModal()

    fireEvent.click(
      await screen.findByRole('button', {
        name: i18n.t('sync.healthModal.actions.export'),
      }),
    )

    await waitFor(() => {
      expect(bridge.diagnostics.export).toHaveBeenCalledWith({
        includeLogs: true,
        redactSensitive: true,
      })
    })
  })

  it.each([
    [
      'failed financial items',
      () => bridge.sync.getFailedFinancialItems.mockRejectedValueOnce(new Error('financial sidecar failed')),
    ],
    [
      'financial integrity',
      () => bridge.sync.validateFinancialIntegrity.mockRejectedValueOnce(new Error('integrity sidecar failed')),
    ],
    [
      'recovery queue items',
      () => queueBridge.listItems.mockRejectedValueOnce(new Error('queue sidecar failed')),
    ],
  ])('keeps successful core health available when %s loading fails', async (_name, rejectAncillaryCall) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    rejectAncillaryCall()
    renderHealthModal()

    expect(
      await screen.findByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.states.unavailable.title')),
    ).not.toBeInTheDocument()
  })

  it('does not claim all checks passed when no printer is configured', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValueOnce({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        configured: false,
        profileCount: 0,
        defaultProfile: null,
        recentJobs: [],
      },
    })
    renderHealthModal()

    await screen.findByText(i18n.t('sync.healthModal.status.notConfigured'))
    expect(
      screen.queryByText(i18n.t('sync.healthModal.states.healthy.title')),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('sync.healthModal.problems.ready')),
    ).not.toBeInTheDocument()
  })

  it('announces the current transport and sync-health state from the collapsed launcher', async () => {
    renderIndicator()

    expect(
      await screen.findByRole('button', {
        name: 'Online | Sync health: Healthy',
      }),
    ).toBeInTheDocument()
  })

  it('never sends a raw parity backend error to the operator toast', async () => {
    const rawBackendError =
      'HTTP 500 Authorization: Bearer retry-secret customer@example.test'
    bridge.sync.getStatus.mockResolvedValue({
      ...HEALTHY_SYNC_STATUS,
      isOnline: false,
    })
    runParitySyncCycle.mockResolvedValueOnce({
      paritySyncStatus: {
        status: 'failed',
        trigger: 'manual',
        error: rawBackendError,
      },
      queueStatus: { pending: 0, failed: 1, conflicts: 0, total: 1 },
    })
    renderIndicator()

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Retry sync',
      }),
    )
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })

    expect(toast.error.mock.calls.flat().join(' ')).not.toContain(rawBackendError)
  })

  it('formats the next retry timestamp with the active POS locale', async () => {
    const retryAt = '2026-01-13T15:04:05.000Z'
    const originalToLocaleString = Date.prototype.toLocaleString
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      if (locales === undefined) return 'DEFAULT-LOCALE-DATE'
      return originalToLocaleString.call(this, locales, options)
    })
    await act(async () => {
      await i18n.changeLanguage('el')
    })
    queueBridge.listItems.mockResolvedValue([
      queueItem({ nextRetryAt: retryAt }),
    ])
    renderHealthModal()

    await screen.findByText(i18n.t('sync.healthModal.nextRetry'), { exact: false })

    const expectedGreekDateTime = normalized(new Date(retryAt).toLocaleString('el-GR'))
    const renderedText = normalized(document.body.textContent)
    expect(renderedText).not.toContain('DEFAULT-LOCALE-DATE')
    expect(renderedText).toContain(expectedGreekDateTime)
  })
})
