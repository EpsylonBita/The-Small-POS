import React from 'react'
import { I18nextProvider } from 'react-i18next'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../../lib/i18n'

/**
 * The Health modal's shared (P1) layer on the desktop: the Day close (Z) tile,
 * stuck queue rows with their count and age, the ONE recommended action and
 * the repeated-failure escalation to "Export diagnostics".
 */

const { bridge, queueBridge, runParitySyncCycle, toast, features, endOfDay, shift } = vi.hoisted(() => ({
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
      openExportDir: vi.fn(),
    },
    recovery: {
      listActionLog: vi.fn(),
      executeAction: vi.fn().mockImplementation(async request => ({ success: true, routeTarget: request.routeTarget })),
      recordActionLog: vi.fn(),
    },
  },
  queueBridge: {
    listItems: vi.fn(),
    itemsById: vi.fn(),
    makeDue: vi.fn(),
  },
  runParitySyncCycle: vi.fn(),
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
  features: { isMobileWaiter: false, parentTerminalId: null as string | null },
  endOfDay: {
    status: 'idle' as string,
    pendingReportDate: null as string | null,
    dayStartAt: null as string | null,
    zIssued: false,
  },
  shift: { isShiftActive: true },
}))

vi.mock('react-hot-toast', () => ({ default: toast }))

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
}))

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: shift.isShiftActive }),
}))

vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => features,
}))

vi.mock('../../hooks/useEndOfDayStatus', () => ({
  useEndOfDayStatus: () => ({
    endOfDayStatus: {
      status: endOfDay.status,
      pendingReportDate: endOfDay.pendingReportDate,
      cutoffAt: null,
      periodStartAt: null,
      activeReportDate: null,
      activePeriodStartAt: null,
      latestZReportId: null,
      latestZReportSyncState: null,
      canOpenPendingZReport: false,
      dayStartAt: endOfDay.dayStartAt,
      zIssued: endOfDay.zIssued,
    },
    isPendingLocalSubmit: endOfDay.status === 'pending_local_submit',
    isZIssuedAwaitingFinalization: endOfDay.status === 'pending_local_submit' && endOfDay.zIssued,
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

vi.mock('../recovery/RecoveryPanel', () => ({ RecoveryPanel: () => null }))

vi.mock('../support/SupportDetailsPanel', () => ({ SupportDetailsPanel: () => null }))

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

const HOUR_MS = 60 * 60 * 1_000

/** A queued order row, still pending 4 hours after its first attempts. */
const stuckOrderRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'queue-item-stuck',
  tableName: 'orders',
  recordId: 'order-42',
  operation: 'UPDATE',
  data: JSON.stringify({ orderNumber: 'ORD-42' }),
  organizationId: 'organization-1',
  createdAt: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
  attempts: 2,
  lastAttempt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
  errorMessage: null,
  nextRetryAt: null,
  retryDelayMs: 1_000,
  priority: 0,
  moduleType: 'orders',
  conflictStrategy: 'server-wins',
  version: 1,
  status: 'pending',
  ...overrides,
})

const checkoutBlocker = (overrides: Record<string, unknown> = {}) => ({
  orderId: 'order-unpaid-1',
  orderNumber: 'ORD-7',
  totalAmount: 12.5,
  settledAmount: 0,
  paymentStatus: 'pending',
  paymentMethod: 'cash',
  reasonCode: 'no_persisted_payment',
  reasonText: 'Completed order has no recorded payment.',
  suggestedFix: 'Record the payment.',
  severity: 'blocking',
  ...overrides,
})

const COMPLETED_SYNC = {
  paritySyncStatus: {
    status: 'completed',
    trigger: 'manual',
    startedAt: '2026-01-13T14:00:00.000Z',
    finishedAt: '2026-01-13T14:00:02.000Z',
    processed: 0,
    failed: 0,
    conflicts: 0,
    remaining: 1,
  },
  queueStatus: { pending: 1, failed: 0, conflicts: 0, total: 1 },
}

const renderHealthModal = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <SyncStatusIndicator showDetails />
    </I18nextProvider>,
  )

const getDialog = () => screen.findByRole('dialog', { name: i18n.t('tillHealth.title') })

const serviceTile = (service: string) => screen.getByTestId(`health-service-${service}`)
const supportToggle = () => screen.getByRole('button', { name: new RegExp(i18n.t('tillHealth.support.title')) })
const openSupport = () => { if (supportToggle().getAttribute('aria-expanded') === 'false') fireEvent.click(supportToggle()) }
const openAdvanced = () => {
  openSupport()
  screen.getByText(i18n.t('sync.healthModal.actions.openAdvanced')).closest('details')!.open = true
}
const report = () => { openSupport(); fireEvent.click(screen.getByRole('button', { name: i18n.t('tillHealth.report.new') })) }
const send = () => screen.getByRole('button', { name: i18n.t('tillHealth.action.send') })
const stuckText = (count: number) => new RegExp(i18n.t('tillHealth.families.waiting.stuck', { count, duration: 'AGE' }).split('AGE')[0].replace(/[.*+?^&{}()|[\]\\]/g, '\\$&') + '4[^0-9]')


describe('SyncStatusIndicator Health modal: day close, stuck rows and the one recommended action', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    features.isMobileWaiter = false
    shift.isShiftActive = true
    endOfDay.status = 'idle'
    endOfDay.pendingReportDate = null
    endOfDay.dayStartAt = null
    endOfDay.zIssued = false
    bridge.sync.getStatus.mockResolvedValue(HEALTHY_SYNC_STATUS)
    bridge.sync.getFinancialStats.mockResolvedValue({})
    bridge.sync.getFailedFinancialItems.mockResolvedValue([])
    bridge.sync.validateFinancialIntegrity.mockResolvedValue({ valid: true, issues: [] })
    bridge.diagnostics.getSystemHealth.mockResolvedValue(HEALTHY_SYSTEM_HEALTH)
    bridge.diagnostics.export.mockResolvedValue({ success: true, path: 'C:/diagnostics/bundle.zip' })
    bridge.diagnostics.sendRemoteIncident.mockResolvedValue({ success: true, localPrepared: true, path: 'C:/diagnostics/bundle.zip' })
    bridge.diagnostics.openExportDir.mockResolvedValue({ success: true })
    bridge.recovery.listActionLog.mockResolvedValue([])
    bridge.recovery.recordActionLog.mockImplementation(async (entry: unknown) => entry)
    queueBridge.listItems.mockResolvedValue([])
    // Rows read by id: what the list holds, unless a test says otherwise.
    queueBridge.itemsById.mockImplementation(async (ids: string[]) =>
      ((await queueBridge.listItems()) as Array<{ id: string }>).filter((item) => ids.includes(item.id)),
    )
    queueBridge.makeDue.mockResolvedValue({ madeDue: [], auditId: null })
    runParitySyncCycle.mockResolvedValue(COMPLETED_SYNC)
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
  })

  it('shows a sixth Day close (Z) tile that defers to the Z screen when the renderer cannot check the whole Z', async () => {
    renderHealthModal()
    await screen.findByText(i18n.t('tillHealth.states.ok.title'))

    const tile = serviceTile('closeout')
    expect(tile).toHaveTextContent('Day close (Z)')
    // Neither "ready" (it saw only part of the checks) nor a fault.
    expect(tile).toHaveTextContent('Checked at day close')
    expect(tile).not.toHaveTextContent('Ready')
    expect(tile).not.toHaveTextContent('Unavailable')
    // Six tiles, in the shared order.
    expect(
      ['orders', 'internet', 'sync', 'printer', 'support', 'closeout'].map((service) =>
        serviceTile(service).textContent,
      ),
    ).toEqual([
      'OrdersWorking',
      'InternetConnected',
      'Sending to the officeAll sent',
      'PrinterReady',
      'SupportNot needed',
      'Day close (Z)Checked at day close',
    ])
    // Healthy: nothing to recommend.
    expect(screen.queryByTestId('till-health-card')).not.toBeInTheDocument()
  })

  it('shows ZIP delivery separately from a failed Telegram notification', async () => {
    bridge.diagnostics.sendRemoteIncident.mockResolvedValue({ success: true, incidentId: 'received-1', localPrepared: true, bundleStored: true, alertSent: false, alertStatus: 'failed', path: 'C:/diagnostics/sent.zip' })
    renderHealthModal()
    await screen.findByText(i18n.t('tillHealth.states.ok.title'))
    report()
    expect(await screen.findByText(/The report reached The Small and a copy is saved here \(\d{2}:\d{2}\)\./, { selector: '[role="status"]' })).toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
    expect(await screen.findByText(i18n.t('recovery.actionStatus.reportStored'))).toBeInTheDocument()
    expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledWith(expect.objectContaining({ healthView: expect.any(Object) }))
  })

  it('does not show success when a legacy backend accepted only the summary', async () => {
    bridge.diagnostics.sendRemoteIncident.mockResolvedValue({ success: true, alertSent: true })
    renderHealthModal()
    await screen.findByText(i18n.t('tillHealth.states.ok.title'))
    report()
    expect(await screen.findByText(i18n.t('tillHealth.report.failed'))).toBeInTheDocument()
    expect(screen.queryByText(/The report reached The Small and a copy is saved here \(\d{2}:\d{2}\)\./)).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('reports the day close as blocked by a completed order that was not paid', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      checkoutPaymentBlockers: {
        count: 1,
        details: [checkoutBlocker()],
        sourceWindow: 'active_shift',
      },
    })
    renderHealthModal()

    expect(await screen.findByText(i18n.t('tillHealth.families.balance.title'))).toBeInTheDocument()
    expect(serviceTile('closeout')).toHaveTextContent('Needs attention')
    const card = screen.getByTestId('till-health-card')
    expect(card).toHaveTextContent(i18n.t('tillHealth.families.balance.detail'))
    expect(within(card).getByRole('button', { name: i18n.t('tillHealth.action.openPayment') })).toBeEnabled()
    expect(within(card).queryByRole('button', { name: /open day close/i })).toBeNull()
  })

  it('does not block the day close on a payment warning', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      checkoutPaymentBlockers: {
        count: 1,
        details: [checkoutBlocker({ severity: 'warning' })],
        sourceWindow: 'z_report',
      },
    })
    renderHealthModal()
    await getDialog()

    await waitFor(() => expect(bridge.diagnostics.getSystemHealth).toHaveBeenCalled())
    await waitFor(() => expect(serviceTile('closeout')).toHaveTextContent('Checked at day close'))
    expect(screen.queryByText(i18n.t('tillHealth.families.dayClose.title'))).not.toBeInTheDocument()
  })

  // Founder decision 13/10/2026: a POS day runs from its first check-in to its
  // Z, so a Z offered right after the last checkout is not overdue. Health only
  // warns (never blocks) once the open day started more than 24 hours ago.
  const OPEN_TOO_LONG = 'The day is still open'

  it('does not call a day overdue just because its Z is ready after the last checkout', async () => {
    endOfDay.status = 'pending_local_submit'
    endOfDay.pendingReportDate = '2026-01-12'
    endOfDay.dayStartAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    renderHealthModal()
    await getDialog()
    await waitFor(() => expect(bridge.diagnostics.getSystemHealth).toHaveBeenCalled())
    expect(serviceTile('closeout')).not.toHaveTextContent('Still open')
    expect(screen.queryByText(OPEN_TOO_LONG)).not.toBeInTheDocument()
  })

  it('warns when the POS day has been open for over 24 hours, and that the Z is done on the main terminal for a waiter', async () => {
    endOfDay.status = 'idle'
    endOfDay.dayStartAt = new Date(Date.now() - (24 * 60 + 1) * 60 * 1000).toISOString()
    const { unmount } = renderHealthModal()
    expect(await screen.findByText(OPEN_TOO_LONG)).toBeInTheDocument()
    expect(serviceTile('closeout')).toHaveTextContent('Still open')
    expect(screen.getByText(i18n.t('tillHealth.closeoutHint'))).toBeInTheDocument()
    unmount()

    features.isMobileWaiter = true
    renderHealthModal()
    await waitFor(() => expect(serviceTile('closeout')).toHaveTextContent('On the main till'))
    expect(screen.queryByText(OPEN_TOO_LONG)).not.toBeInTheDocument()
  })

  it('names a stuck queue row with its count and age and recommends Sync now', async () => {
    queueBridge.listItems.mockResolvedValue([stuckOrderRow()])
    renderHealthModal()

    expect(await screen.findByText(stuckText(1))).toBeInTheDocument()
    expect(serviceTile('sync')).toHaveTextContent('Needs attention')
    expect(serviceTile('closeout')).toHaveTextContent('Checked at day close')
    expect(send()).toBeEnabled()
    fireEvent.click(send())
    await waitFor(() => expect(runParitySyncCycle).toHaveBeenCalledWith({ trigger: 'manual', reportHealthTargets: true }))
  })

  it('counts several stuck rows and ages them by the oldest', async () => {
    queueBridge.listItems.mockResolvedValue([
      stuckOrderRow(),
      stuckOrderRow({ id: 'queue-item-stuck-2', createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() }),
    ])
    renderHealthModal()

    expect(await screen.findByText(stuckText(2))).toBeInTheDocument()
  })

  it('escalates to Export diagnostics when Sync now did not clear the stuck row, and exports the Health view', async () => {
    queueBridge.listItems.mockResolvedValue([stuckOrderRow()])
    // The cycle tried the row again and it is still not sent.
    runParitySyncCycle.mockImplementation(async () => {
      queueBridge.listItems.mockResolvedValue([
        stuckOrderRow({ attempts: 3, lastAttempt: new Date().toISOString(), errorMessage: 'HTTP 503' }),
      ])
      return COMPLETED_SYNC
    })
    renderHealthModal()
    await screen.findByText(stuckText(1))
    const healthChecksBefore = bridge.diagnostics.getSystemHealth.mock.calls.length

    fireEvent.click(send())

    expect(await screen.findByText(i18n.t('tillHealth.states.support.title'))).toBeInTheDocument()
    expect(bridge.diagnostics.getSystemHealth.mock.calls.length).toBeGreaterThan(healthChecksBefore)
    expect(screen.queryByRole('button', { name: i18n.t('tillHealth.action.send') })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('till-health-card').some(card => card.textContent?.includes(i18n.t('tillHealth.action.noSafeAction')))).toBe(true)
    report()
    await waitFor(() => expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledTimes(1))
    expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        healthView: expect.objectContaining({
          format: 'thesmall-pos-health-view-v1',
          platform: 'windows',
          source: 'health_modal',
          state: 'attention',
          problem: {
            code: 'syncStuck',
            params: expect.objectContaining({ count: 1 }),
          },
          impacts: ['dayCloseBlockedUntilSent'],
          primaryAction: 'exportDiagnostics',
          escalated: true,
          services: expect.objectContaining({ sync: 'stuck', closeout: 'not_checked' }),
          counts: expect.objectContaining({ stuckRows: 1 }),
        }),
      }),
    )
    screen.getByText(i18n.t('tillHealth.report.previous')).closest('details')!.open = true
    fireEvent.click(await screen.findByRole('button', { name: /open the folder for the copy/i }))
    await waitFor(() =>
      expect(bridge.diagnostics.openExportDir).toHaveBeenCalledWith('C:/diagnostics/bundle.zip'),
    )
  })

  it('never escalates on a row the cycle did not try, and makes a row waiting out its retry due first', async () => {
    // Review 30/09/2026: the row was waiting out its retry delay, the cycle
    // skipped it, and the same problem afterwards read as a failed Sync now.
    const retryAt = new Date(Date.now() + 12 * 60 * 1000).toISOString()
    queueBridge.listItems.mockResolvedValue([stuckOrderRow({ nextRetryAt: retryAt })])
    queueBridge.makeDue.mockResolvedValue({
      madeDue: [{ id: 'queue-item-stuck', nextRetryAt: retryAt }],
      auditId: 'audit-sync-now-1',
    })
    renderHealthModal()
    await screen.findByText(stuckText(1))

    fireEvent.click(send())

    await waitFor(() => expect(runParitySyncCycle).toHaveBeenCalledWith({ trigger: 'manual', reportHealthTargets: true }))
    expect(queueBridge.makeDue).toHaveBeenCalledWith(['queue-item-stuck'], 'sync_stuck')
    expect(queueBridge.makeDue.mock.invocationCallOrder[0]).toBeLessThan(
      runParitySyncCycle.mock.invocationCallOrder[0],
    )
    // The entry that recorded the retry time is completed: pending, not failed.
    await waitFor(() =>
      expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'audit-sync-now-1',
          actionId: 'syncNow',
          outcome: 'pending',
          success: false,
          madeDue: [{ id: 'queue-item-stuck', nextRetryAt: retryAt }],
        }),
      ),
    )
    expect(screen.getByText(i18n.t('tillHealth.states.pending.title'), { selector: 'h3' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export diagnostics' })).not.toBeInTheDocument()
  })

  it('never reads a failed backlog read as nothing waiting: last known backlog kept, shown as unavailable', async () => {
    // Review 30/09/2026: when the backlog could not be read, system health
    // carried an empty backlog, so Advanced details said 0 and the summary
    // could turn healthy. It now says the read failed and keeps the last one.
    bridge.diagnostics.getSystemHealth
      .mockResolvedValueOnce({ ...HEALTHY_SYSTEM_HEALTH, syncBacklog: { orders: { pending: 3 } }, syncBacklogStatus: 'ok' })
      .mockResolvedValue({ ...HEALTHY_SYSTEM_HEALTH, syncBacklog: {}, syncBacklogStatus: 'unavailable' })
    renderHealthModal()
    await waitFor(() => expect(serviceTile('sync')).toHaveTextContent('Waiting to be sent'))
    const checksBefore = bridge.diagnostics.getSystemHealth.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: i18n.t('tillHealth.action.recheck') }))
    await waitFor(() =>
      expect(bridge.diagnostics.getSystemHealth.mock.calls.length).toBeGreaterThan(checksBefore),
    )

    // The last known backlog still counts: the sync tile does not turn healthy.
    await waitFor(() => expect(serviceTile('sync')).toHaveTextContent('Waiting to be sent'))
    openAdvanced()
    const field = screen.getByText(i18n.t('sync.healthModal.advanced.fields.syncBacklog')).parentElement
    expect(field).toHaveTextContent(i18n.t('sync.healthModal.status.unavailable'))
    expect(field).not.toHaveTextContent('3')
  })

  it('shows the backlog as unavailable when the very first read failed', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      syncBacklog: {},
      syncBacklogStatus: 'unavailable',
    })
    renderHealthModal()
    await screen.findByText(i18n.t('tillHealth.states.unavailable.detail'))
    openAdvanced()
    const field = screen.getByText(i18n.t('sync.healthModal.advanced.fields.syncBacklog')).parentElement
    expect(field).toHaveTextContent(i18n.t('sync.healthModal.status.unavailable'))
    expect(field).not.toHaveTextContent(/^Sync backlog\s*0$/)
  })

  it('does not escalate when a fresh check after Sync now shows the row was sent', async () => {
    queueBridge.listItems.mockResolvedValue([stuckOrderRow()])
    runParitySyncCycle.mockImplementation(async () => {
      queueBridge.listItems.mockResolvedValue([])
      return { ...COMPLETED_SYNC, paritySyncResult: { acknowledgedIds: ['queue-item-stuck'] } }
    })
    renderHealthModal()
    await screen.findByText(stuckText(1))

    fireEvent.click(send())

    expect(await screen.findByRole('heading', { name: i18n.t('tillHealth.states.solved.title') })).toBeVisible()
    await waitFor(() => expect(bridge.recovery.recordActionLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'resolved', success: true })))
  })

  it('recommends reviewing the issue when a payment failed to sync', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      parityQueueStatus: { total: 1, pending: 0, failed: 1, conflicts: 0 },
    })
    queueBridge.listItems.mockResolvedValue([
      stuckOrderRow({ tableName: 'payments', moduleType: 'financial', status: 'failed', errorMessage: 'HTTP 422' }),
    ])
    renderHealthModal()

    expect(await screen.findByText(i18n.t('tillHealth.states.support.title'))).toBeInTheDocument()
    expect(serviceTile('sync')).toHaveTextContent('Did not complete')
    const card = screen.getByTestId('till-health-card')
    expect(card).toHaveTextContent(i18n.t('tillHealth.action.noSafeAction'))
    fireEvent.click(within(card).getByRole('button', { name: i18n.t('tillHealth.action.supportDetails') }))
    expect(supportToggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('sends a terminal with missing credentials to the terminal settings', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      credentialState: { hasAdminUrl: true, hasApiKey: false },
    })
    const routes: unknown[] = []
    const onRoute = (event: Event) => routes.push((event as CustomEvent).detail)
    window.addEventListener('pos:recovery-route', onRoute)
    try {
      renderHealthModal()
      expect(await screen.findByText(i18n.t('tillHealth.families.connection.title'))).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: i18n.t('tillHealth.action.openConnection') }))
      await waitFor(() => expect(routes).toEqual([{ screen: 'connectionSettings' }]))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: i18n.t('tillHealth.title') })).not.toBeInTheDocument(),
      )
    } finally {
      window.removeEventListener('pos:recovery-route', onRoute)
    }
  })

  it('recommends checking again when no health check could be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.diagnostics.getSystemHealth.mockRejectedValueOnce(new Error('diagnostic transport unavailable'))
    renderHealthModal()

    expect(await screen.findByText(i18n.t('tillHealth.states.stale.title'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('tillHealth.states.unavailable.detail'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('tillHealth.action.recheck') }))

    expect(await screen.findByText(i18n.t('tillHealth.states.ok.title'))).toBeInTheDocument()
    expect(bridge.diagnostics.getSystemHealth).toHaveBeenCalledTimes(2)
  })

  it('renders the new Health copy in Greek', async () => {
    await act(async () => {
      await i18n.changeLanguage('el')
    })
    queueBridge.listItems.mockResolvedValue([stuckOrderRow()])
    runParitySyncCycle.mockImplementation(async () => {
      queueBridge.listItems.mockResolvedValue([
        stuckOrderRow({ attempts: 3, lastAttempt: new Date().toISOString(), errorMessage: 'Write refused' }),
      ])
      return COMPLETED_SYNC
    })
    renderHealthModal()

    expect(await screen.findByText(stuckText(1))).toBeInTheDocument()
    expect(serviceTile('closeout')).toHaveTextContent(i18n.t('tillHealth.services.closeout'))
    expect(serviceTile('closeout')).toHaveTextContent(i18n.t('tillHealth.status.not_checked'))
    expect(serviceTile('sync')).toHaveTextContent(i18n.t('tillHealth.status.stuck'))
    expect(send()).toBeEnabled()

    const dialog = await getDialog()
    for (const englishFragment of [
      'queued record',
      'hours',
      'Sync now',
      'Day close',
      'Needs attention',
      'Unavailable',
      "can't finish",
      'Send the waiting records',
      'checks again',
      'What you should do',
    ]) {
      expect(dialog).not.toHaveTextContent(englishFragment)
    }

    fireEvent.click(send())
    await screen.findByText(i18n.t('tillHealth.states.support.title'))
    openSupport()
    expect(screen.getByRole('button', { name: i18n.t('tillHealth.report.new') })).toBeInTheDocument()
    expect(dialog).not.toHaveTextContent('Export diagnostics')
    expect(dialog).not.toHaveTextContent("Syncing didn't clear this")
  })

  /**
   * Store incident, Tomikro Parisi, 1.4.119, 30/09/2026: from 03:25 every
   * print job stayed pending behind a print lane nothing released, nothing
   * ever failed, and this view said "Printer: Ready". The whole-queue
   * aggregate (printerStatus.pendingJobs) is what shows it.
   */
  it('says receipts are not printing when jobs have waited for minutes, and opens the printer settings', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        ...HEALTHY_SYSTEM_HEALTH.printerStatus,
        // Nothing failed: the failure counter alone would stay quiet.
        recentJobs: [{ id: 'job-1', entityType: 'order_receipt', status: 'pending' }],
        pendingJobs: {
          count: 2,
          oldestCreatedAt: new Date(Date.now() - 40 * 60 * 1_000).toISOString(),
        },
      },
    })
    const routes: unknown[] = []
    const onRoute = (event: Event) => routes.push((event as CustomEvent).detail)
    window.addEventListener('pos:recovery-route', onRoute)
    try {
      renderHealthModal()

      expect(await screen.findByText(i18n.t('tillHealth.families.printing.title'))).toBeInTheDocument()
      expect(serviceTile('printer')).toHaveTextContent(i18n.t('tillHealth.status.attention'))
      expect(serviceTile('printer')).not.toHaveTextContent('Ready')
      const card = screen.getByTestId('till-health-card')
      expect(card).toHaveTextContent(i18n.t('tillHealth.families.printing.detail', { count: 2 }))
      fireEvent.click(within(card).getByRole('button', { name: i18n.t('tillHealth.action.printer') }))

      expect(routes).toEqual([{ screen: 'connectionSettings', params: { section: 'printing' } }])
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: i18n.t('tillHealth.title') })).not.toBeInTheDocument(),
      )
    } finally {
      window.removeEventListener('pos:recovery-route', onRoute)
    }
  })

  /**
   * Review 30/09/2026: the stall showed only inside Health. The heart in the
   * header takes the attention colour during a shift (the shared rule), and
   * its label says why, so staff see it without opening Health.
   */
  describe('the header heart', () => {
    const heart = () => document.querySelector<HTMLElement>('[data-heart-tone]')
    const renderClosed = () =>
      render(
        <I18nextProvider i18n={i18n}>
          <SyncStatusIndicator />
        </I18nextProvider>,
      )
    const stalledHealth = (ageMs: number) => ({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        ...HEALTHY_SYSTEM_HEALTH.printerStatus,
        pendingJobs: { count: 2, oldestCreatedAt: new Date(Date.now() - ageMs).toISOString() },
      },
    })

    it('takes the attention colour when print jobs have stalled, with the Health view closed', async () => {
      bridge.diagnostics.getSystemHealth.mockResolvedValue(stalledHealth(40 * 60 * 1_000))
      renderClosed()

      await waitFor(() => {
        expect(heart()).toHaveAttribute('data-heart-tone', 'attention')
        expect(heart()).toHaveAttribute('data-health-tone', 'warn')
        expect(heart()).toHaveAccessibleName(new RegExp(i18n.t('tillHealth.states.issue.title')))
      })
      expect(screen.queryByRole('dialog', { name: i18n.t('tillHealth.title') })).not.toBeInTheDocument()
    })

    const settle = async () => {
      await waitFor(() => expect(bridge.diagnostics.getSystemHealth).toHaveBeenCalled())
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    it('stays green for a queue that is moving', async () => {
      bridge.diagnostics.getSystemHealth.mockResolvedValue(stalledHealth(30 * 1_000))
      renderClosed()
      await settle()
      await waitFor(() => expect(heart()).toHaveAttribute('data-heart-tone', 'healthy'))
      expect(heart()).not.toHaveAccessibleName(/Receipts/)
    })

    it('stays green before a shift: the shared rule holds the printer alarm until one starts', async () => {
      shift.isShiftActive = false
      bridge.diagnostics.getSystemHealth.mockResolvedValue(stalledHealth(40 * 60 * 1_000))
      renderClosed()
      await settle()
      await waitFor(() => expect(heart()).toHaveAttribute('data-heart-tone', 'healthy'))
      expect(heart()).not.toHaveAccessibleName(/Receipts/)
    })
  })

  it('keeps a job that has only just been queued out of the alarm', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        ...HEALTHY_SYSTEM_HEALTH.printerStatus,
        pendingJobs: { count: 1, oldestCreatedAt: new Date(Date.now() - 30 * 1_000).toISOString() },
      },
    })
    renderHealthModal()

    expect(await screen.findByText(i18n.t('tillHealth.states.ok.title'))).toBeInTheDocument()
    expect(serviceTile('printer')).toHaveTextContent('Ready')
    expect(screen.queryByTestId('till-health-card')).not.toBeInTheDocument()
  })

  it('opens the printer settings from the printer setup action too', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: { configured: false, profileCount: 0, defaultProfile: null, recentJobs: [] },
    })
    const routes: unknown[] = []
    const onRoute = (event: Event) => routes.push((event as CustomEvent).detail)
    window.addEventListener('pos:recovery-route', onRoute)
    try {
      renderHealthModal()
      await screen.findByText(i18n.t('tillHealth.status.not_configured'))
      expect(screen.queryByTestId('till-health-card')).toBeNull()
      openSupport()
      screen.getByText(i18n.t('tillHealth.support.tools')).closest('details')!.open = true
      fireEvent.click(screen.getByRole('button', { name: i18n.t('tillHealth.action.printer') }))

      expect(routes).toEqual([{ screen: 'connectionSettings', params: { section: 'printing' } }])
    } finally {
      window.removeEventListener('pos:recovery-route', onRoute)
    }
  })

  it('exports how many print jobs wait and for how long', async () => {
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        ...HEALTHY_SYSTEM_HEALTH.printerStatus,
        pendingJobs: { count: 3, oldestCreatedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() },
      },
    })
    renderHealthModal()
    await screen.findByText(i18n.t('tillHealth.families.printing.detail', { count: 3 }))

    report()

    await waitFor(() => expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledTimes(1))
    expect(bridge.diagnostics.sendRemoteIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        healthView: expect.objectContaining({
          problem: { code: 'printingStalled', params: expect.objectContaining({ count: 3 }) },
          impacts: ['printingStopped'],
          primaryAction: 'checkPrinting',
          services: expect.objectContaining({ printer: 'attention' }),
          counts: expect.objectContaining({ printJobsWaiting: 3, oldestPrintJobWaitingMs: expect.any(Number) }),
        }),
      }),
    )
  })

  it('says it in Greek', async () => {
    await act(async () => {
      await i18n.changeLanguage('el')
    })
    bridge.diagnostics.getSystemHealth.mockResolvedValue({
      ...HEALTHY_SYSTEM_HEALTH,
      printerStatus: {
        ...HEALTHY_SYSTEM_HEALTH.printerStatus,
        pendingJobs: { count: 1, oldestCreatedAt: new Date(Date.now() - 25 * 60 * 1_000).toISOString() },
      },
    })
    renderHealthModal()

    expect(await screen.findByText(i18n.t('tillHealth.families.printing.detail', { count: 1 }))).toBeInTheDocument()
    expect(serviceTile('printer')).toHaveTextContent(i18n.t('tillHealth.status.attention'))
    const card = screen.getByTestId('till-health-card')
    expect(within(card).getByRole('button', { name: i18n.t('tillHealth.action.printer') })).toBeInTheDocument()
    const dialog = await getDialog()
    for (const englishFragment of ['Receipts', 'print job', 'printer', 'Check the printer']) {
      expect(dialog).not.toHaveTextContent(englishFragment)
    }
  })
})
