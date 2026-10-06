import React from 'react'
import { I18nextProvider } from 'react-i18next'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../../lib/i18n'

// Incident 06/10/2026 (Tomikro, desktop 1.4.123): with no open cashier shift the
// day gate fences every click and key outside recovery surfaces. Health opened
// from the heart, then ignored every click and key — even Close and Escape — so
// the store had to kill the app from Task Manager.

const { bridge, queueBridge, toast } = vi.hoisted(() => ({
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
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

vi.mock('react-hot-toast', () => ({ default: toast }))
vi.mock('../../contexts/i18n-context', () => ({ useI18n: () => ({ t: (key: string) => key, language: 'en' }) }))

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
}))

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: false }),
}))

vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isMobileWaiter: false, parentTerminalId: null, loading: false }),
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

// The store had no open cashier shift: the day is blocked, not resolving.
vi.mock('../../hooks/useCashierDayGate', () => ({
  useCashierDayGate: () => ({ isBlocked: true, isResolving: false, branchId: 'branch-1', recheck: vi.fn() }),
}))

vi.mock('../ShiftManager', async () => {
  const React = await import('react')
  return {
    ShiftManager: React.forwardRef((_props, ref) => {
      React.useImperativeHandle(ref, () => ({ openCheckin: () => undefined }))
      return null
    }),
  }
})
vi.mock('../modals/ZReportModal', () => ({ default: () => null }))

vi.mock('../../services/SyncQueueBridge', () => ({
  getSyncQueueBridge: () => queueBridge,
}))

vi.mock('../../services/ParitySyncCoordinator', () => ({
  PARITY_QUEUE_STATUS_EVENT: 'sync:parity-queue-status',
  PARITY_SYNC_STATUS_EVENT: 'sync:parity-status',
  REALTIME_STATUS_EVENT: 'realtime:status',
  runParitySyncCycle: vi.fn(),
}))

vi.mock('../OrderSyncRouteIndicator', () => ({ OrderSyncRouteIndicator: () => null }))
vi.mock('../FinancialSyncPanel', () => ({ FinancialSyncPanel: () => null }))
vi.mock('../support/HealthSupportEntryPoint', () => ({ HealthSupportEntryPoint: () => null }))
vi.mock('../recovery/RecoveryCenterPanel', () => ({ RecoveryCenterPanel: () => null }))

import { SyncStatusIndicator } from '../SyncStatusIndicator'
import { CashierOperationalBoundary, CASHIER_GATE_SAFE_SELECTOR, GlobalCashierGate } from '../GlobalCashierGate'

const SYNC_STATUS = {
  isOnline: true,
  lastSync: '2026-10-06T11:00:00.000Z',
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

const SYSTEM_HEALTH = {
  schemaVersion: 97,
  dbSizeBytes: 1,
  isOnline: true,
  lastSyncTime: '2026-10-06T11:00:00.000Z',
  pendingOrders: 0,
  paymentAdjustmentBacklog: {
    genericDeferred: 0,
    waitingForParentPayment: 0,
    waitingForCanonicalRemotePaymentId: 0,
  },
  syncBacklog: {},
  lastSyncTimes: {},
  lastZReport: null,
  printerStatus: { configured: true, profileCount: 1, defaultProfile: 'Front desk', recentJobs: [] },
}

// Mirrors App.tsx: the heart launcher sits in a recovery slot outside the gate,
// and every page sits behind the gate's operational boundary.
const renderLockedApp = () =>
  render(
    <I18nextProvider i18n={i18n}>
      <div data-cashier-recovery="true">
        <SyncStatusIndicator showDetails />
      </div>
      <GlobalCashierGate onLogout={() => {}} onOpenSettings={() => {}}>
        <CashierOperationalBoundary>
          <button type="button">operational sale</button>
        </CashierOperationalBoundary>
      </GlobalCashierGate>
    </I18nextProvider>,
  )

describe('Health stays usable while the cashier day is locked', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    bridge.sync.getStatus.mockResolvedValue(SYNC_STATUS)
    bridge.sync.getFinancialStats.mockResolvedValue({})
    bridge.sync.getFailedFinancialItems.mockResolvedValue([])
    bridge.sync.validateFinancialIntegrity.mockResolvedValue({ valid: true, issues: [] })
    bridge.diagnostics.getSystemHealth.mockResolvedValue(SYSTEM_HEALTH)
    bridge.diagnostics.export.mockResolvedValue({ success: false, path: '' })
    bridge.diagnostics.sendRemoteIncident.mockResolvedValue({ success: true })
    bridge.recovery.listActionLog.mockResolvedValue([])
    queueBridge.listItems.mockResolvedValue([])
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('marks the Health dialog as a recovery surface the gate leaves interactive', async () => {
    renderLockedApp()
    const dialog = await screen.findByRole('dialog', { name: i18n.t('sync.healthModal.title') })
    const close = screen.getByRole('button', { name: i18n.t('sync.healthModal.close') })

    expect(dialog.closest(CASHIER_GATE_SAFE_SELECTOR)).not.toBeNull()
    expect(close.closest(CASHIER_GATE_SAFE_SELECTOR)).not.toBeNull()
  })

  it('closes Health with the Close button while no cashier shift is open', async () => {
    renderLockedApp()
    await screen.findByRole('dialog', { name: i18n.t('sync.healthModal.title') })

    fireEvent.click(screen.getByRole('button', { name: i18n.t('sync.healthModal.close') }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: i18n.t('sync.healthModal.title') })).toBeNull(),
    )
  })

  it('closes Health with Escape while no cashier shift is open', async () => {
    renderLockedApp()
    const dialog = await screen.findByRole('dialog', { name: i18n.t('sync.healthModal.title') })

    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: i18n.t('sync.healthModal.title') })).toBeNull(),
    )
  })

  it('still fences operational content behind the locked day', async () => {
    renderLockedApp()
    await screen.findByRole('dialog', { name: i18n.t('sync.healthModal.title') })

    const sale = document.querySelector('[data-cashier-operational="true"] button') as HTMLButtonElement
    expect(sale.closest(CASHIER_GATE_SAFE_SELECTOR)).toBeNull()
    expect(sale.closest('[data-cashier-operational="true"]')).toHaveAttribute('inert')
  })
})
