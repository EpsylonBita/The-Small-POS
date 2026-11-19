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
    listItems: vi.fn().mockResolvedValue([{ id: 'queue-1', tableName: 'customer_addresses', recordId: 'address-1', moduleType: 'customers', operation: 'UPDATE', status: 'failed', errorMessage: 'CUSTOMER_ADDRESS_DEFAULT_CONFLICT' }]),
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
import { SyncStatusIndicator } from '../SyncStatusIndicator';

describe('Till health staff and support actions', () => {
  afterEach(cleanup);

  it('shows a known action in the same window and keeps its original control in support', async () => {
    render(<SyncStatusIndicator showDetails />);
    expect(await screen.findByRole('button', { name: 'tillHealth.action.saveAddress' })).toBeVisible();
    const support = screen.getByRole('button', { name: /tillHealth.support.title/ });
    expect(support).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(support);
    const details = document.querySelector<HTMLDetailsElement>('.till-health-support-content section:nth-of-type(2) details')!;
    details.open = true;
    expect(screen.getByRole('button', { name: 'retryParityItem' })).toBeEnabled();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
