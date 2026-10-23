import React from 'react'
import { I18nextProvider } from 'react-i18next'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../../lib/i18n'

/**
 * Offline week (founder 21/10/2026, Ω3/Ω4): Health lists the days closed on
 * this till that the server has not confirmed, with what each waits for, and
 * every row the server refused for good that holds a Z. "Set aside" goes
 * through the void-payments approval and the native command; nothing is
 * deleted. A read that fails keeps the last good list, marked stale.
 */

const { bridge, approval } = vi.hoisted(() => ({
  bridge: {
    recovery: {
      zGateSetAside: vi.fn(),
    },
  },
  approval: { calls: [] as Array<{ scope: string }> },
}))

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  emitCompatEvent: vi.fn(),
}))

vi.mock('../../hooks/usePrivilegedActionConfirmation', () => ({
  usePrivilegedActionConfirmation: () => ({
    runWithPrivilegedConfirmation: async ({ scope, action }: { scope: string; action: () => Promise<unknown> }) => {
      approval.calls.push({ scope })
      return action()
    },
    confirmationModal: null,
  }),
}))

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: null, isShiftActive: true }),
}))
vi.mock('../../hooks/useFeatures', () => ({
  useFeatures: () => ({ isMobileWaiter: false, parentTerminalId: null }),
}))
vi.mock('../../services/SyncQueueBridge', () => ({
  getSyncQueueBridge: () => ({ listItems: vi.fn(), itemsById: vi.fn(), makeDue: vi.fn() }),
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

import { ZGateSetAsidePanel } from '../SyncStatusIndicator'

const refusedPayment = {
  queueId: 'q-payment',
  tableName: 'payments',
  recordId: 'pay-1',
  status: 'failed',
  errorCode: 'HTTP_422_CLIENT_ERROR',
  serverMessage: 'Order total changed',
  createdAt: '2026-10-21T10:00:00Z',
  amountCents: 1250,
  setAside: false,
  setAsideAt: null,
  setAsideByStaffId: null,
  setAsideReason: null,
}

const health = (overrides: Partial<Record<string, unknown>> = {}) => ({
  success: true,
  unconfirmedLocalZs: 2,
  localZs: [
    {
      zReportId: 'z-1',
      reportDate: '2026-10-20',
      confirmed: false,
      waitsFor: 'window_rows',
      windowRowsPending: 1,
      queueStatus: 'pending',
      errorCode: null,
      serverMessage: null,
    },
    {
      zReportId: 'z-2',
      reportDate: '2026-10-21',
      confirmed: false,
      waitsFor: 'earlier_z',
      windowRowsPending: 0,
      queueStatus: 'pending',
      errorCode: null,
      serverMessage: null,
    },
  ],
  refused: [refusedPayment],
  ...overrides,
})

const renderPanel = async (lng = 'en') => {
  await act(async () => {
    await i18n.changeLanguage(lng)
  })
  return render(
    <I18nextProvider i18n={i18n}>
      <ZGateSetAsidePanel />
    </I18nextProvider>,
  )
}

describe('ZGateSetAsidePanel', () => {
  beforeEach(() => {
    bridge.recovery.zGateSetAside.mockReset()
    approval.calls = []
  })

  afterEach(() => {
    cleanup()
  })

  it('lists the days closed on this till with what each waits for', async () => {
    bridge.recovery.zGateSetAside.mockResolvedValue(health())
    await renderPanel('en')

    const first = await screen.findByTestId('z-gate-local-z-z-1')
    expect(within(first).getByText(i18n.t('sync.zGate.localDay', { date: '2026-10-20' }))).toBeTruthy()
    expect(within(first).getByText(i18n.t('sync.zGate.waits.window_rows', { count: 1 }))).toBeTruthy()
    const second = screen.getByTestId('z-gate-local-z-z-2')
    expect(within(second).getByText(i18n.t('sync.zGate.waits.earlier_z'))).toBeTruthy()
    expect(bridge.recovery.zGateSetAside).toHaveBeenCalledWith({ action: 'list' })
  })

  it('sets a refused row aside through the void-payments approval, then shows it set aside', async () => {
    bridge.recovery.zGateSetAside
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(
        health({
          applied: 'set_aside',
          queueId: 'q-payment',
          refused: [{ ...refusedPayment, setAside: true, setAsideAt: '2026-10-22T08:00:00Z' }],
        }),
      )
    await renderPanel('el')

    const row = await screen.findByTestId('z-gate-row-q-payment')
    expect(within(row).getByText('Order total changed')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: i18n.t('sync.zGate.setAside') }))
    })

    await waitFor(() =>
      expect(bridge.recovery.zGateSetAside).toHaveBeenLastCalledWith({
        action: 'set_aside',
        queueId: 'q-payment',
      }),
    )
    expect(approval.calls).toEqual([{ scope: 'cash_drawer_control' }])
    expect(await screen.findByText(i18n.t('sync.zGate.setAsideDone'))).toBeTruthy()
    const updated = screen.getByTestId('z-gate-row-q-payment')
    expect(within(updated).getByText(i18n.t('sync.zGate.setAsideState'))).toBeTruthy()
    expect(within(updated).getByRole('button', { name: i18n.t('sync.zGate.undo') })).toBeTruthy()
  })

  it('a refused set-aside says nothing changed and keeps the list', async () => {
    bridge.recovery.zGateSetAside
      .mockResolvedValueOnce(health())
      .mockRejectedValueOnce(new Error('SET_ASIDE_NOT_ELIGIBLE'))
    await renderPanel('en')

    const row = await screen.findByTestId('z-gate-row-q-payment')
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: i18n.t('sync.zGate.setAside') }))
    })
    expect(await screen.findByText(i18n.t('sync.zGate.actionFailed'))).toBeTruthy()
    // The list is the one read before: nothing changed.
    expect(screen.getByTestId('z-gate-row-q-payment')).toBeTruthy()
  })

  it('says the list is unavailable when the first read fails, never "nothing to do"', async () => {
    bridge.recovery.zGateSetAside.mockRejectedValue(new Error('database locked'))
    await renderPanel('en')
    expect(await screen.findByText(i18n.t('sync.zGate.unavailable'))).toBeTruthy()
  })

  it('shows nothing when no day waits and nothing was refused', async () => {
    bridge.recovery.zGateSetAside.mockResolvedValue(health({ localZs: [], refused: [], unconfirmedLocalZs: 0 }))
    await renderPanel('en')
    await waitFor(() => expect(bridge.recovery.zGateSetAside).toHaveBeenCalled())
    expect(screen.queryByTestId('z-gate-panel')).toBeNull()
  })
})
