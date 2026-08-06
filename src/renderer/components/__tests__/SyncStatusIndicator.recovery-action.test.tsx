import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { bridge, queueBridge } = vi.hoisted(() => ({
  bridge: {
    sync: {
      getStatus: vi.fn().mockResolvedValue({
        isOnline: true,
        pendingItems: 0,
        syncInProgress: false,
        terminalHealth: 80,
      }),
      getFinancialStats: vi.fn().mockResolvedValue({}),
      getFailedFinancialItems: vi.fn().mockResolvedValue([]),
      validateFinancialIntegrity: vi.fn().mockResolvedValue({ valid: true, issues: [] }),
    },
    diagnostics: {
      getSystemHealth: vi.fn().mockResolvedValue({
        schemaVersion: 71,
        dbSizeBytes: 1,
        isOnline: true,
        pendingOrders: 0,
        syncBacklog: {},
        lastSyncTimes: {},
        printerStatus: {
          configured: false,
          profileCount: 0,
          defaultProfile: null,
          recentJobs: [],
        },
      }),
    },
    recovery: {
      listActionLog: vi.fn().mockResolvedValue([]),
    },
  },
  queueBridge: {
    listItems: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
    }),
  }
})

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
  }),
}))

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
  runParitySyncCycle: vi.fn(),
}))

vi.mock('../OrderSyncRouteIndicator', () => ({ OrderSyncRouteIndicator: () => null }))
vi.mock('../FinancialSyncPanel', () => ({ FinancialSyncPanel: () => null }))
vi.mock('../support/HealthSupportEntryPoint', () => ({ HealthSupportEntryPoint: () => null }))
vi.mock('../recovery/RecoveryCenterPanel', () => ({ RecoveryCenterPanel: () => null }))

import { SyncStatusIndicator } from '../SyncStatusIndicator'

describe('SyncStatusIndicator staff health modal', () => {
  afterEach(cleanup)

  it('opens the recovery center directly from Support actions', async () => {
    const onOpenRecovery = vi.fn()
    render(<SyncStatusIndicator showDetails onOpenRecovery={onOpenRecovery} />)

    const recoveryButton = await screen.findByRole('button', {
      name: 'Open Recovery Center',
    })
    fireEvent.click(recoveryButton)

    expect(onOpenRecovery).toHaveBeenCalledTimes(1)
  })
})
