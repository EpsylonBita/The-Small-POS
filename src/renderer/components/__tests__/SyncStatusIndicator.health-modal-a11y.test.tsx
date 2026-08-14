import React from 'react'
import { I18nextProvider } from 'react-i18next'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../../lib/i18n'

const { bridge, onEvent, queueBridge } = vi.hoisted(() => ({
  bridge: {
    sync: {
      getStatus: vi.fn(),
      getFinancialStats: vi.fn(),
      getFailedFinancialItems: vi.fn(),
      validateFinancialIntegrity: vi.fn(),
    },
    diagnostics: {
      getSystemHealth: vi.fn(),
    },
    recovery: {
      listActionLog: vi.fn(),
    },
  },
  queueBridge: {
    listItems: vi.fn(),
  },
  onEvent: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => bridge,
  onEvent,
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

const renderHealthIndicator = (showDetails = true) =>
  render(
    <I18nextProvider i18n={i18n}>
      <SyncStatusIndicator showDetails={showDetails} />
    </I18nextProvider>,
  )

const getHealthDialog = () =>
  screen.findByRole('dialog', { name: i18n.t('sync.healthModal.title') })

const expectValidDescription = (
  dialog: HTMLElement,
  expectedDescription: string,
) => {
  const ids = dialog.getAttribute('aria-describedby')?.trim().split(/\s+/) ?? []
  expect(ids.length).toBeGreaterThan(0)
  expect(ids.map((id) => document.getElementById(id))).not.toContain(null)
  expect(dialog).toHaveAccessibleDescription(expectedDescription)
}

describe('SyncStatusIndicator Health Status modal keyboard and description contract', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    bridge.sync.getStatus.mockResolvedValue(HEALTHY_SYNC_STATUS)
    bridge.sync.getFinancialStats.mockResolvedValue({})
    bridge.sync.getFailedFinancialItems.mockResolvedValue([])
    bridge.sync.validateFinancialIntegrity.mockResolvedValue({ valid: true, issues: [] })
    bridge.diagnostics.getSystemHealth.mockResolvedValue(HEALTHY_SYSTEM_HEALTH)
    bridge.recovery.listActionLog.mockResolvedValue([])
    queueBridge.listItems.mockResolvedValue([])

    // jsdom has no layout, so make rendered controls visible to the same
    // focusability checks used by the production modal implementation.
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.parentElement
      },
    )

    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  afterEach(async () => {
    document.querySelectorAll('[data-test-topmost-dialog]').forEach((node) => node.remove())
    cleanup()
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
  })

  it('gives the loading dialog a valid accessible description', async () => {
    bridge.diagnostics.getSystemHealth.mockReturnValueOnce(new Promise(() => undefined))
    renderHealthIndicator()

    const dialog = await getHealthDialog()
    await screen.findByText(i18n.t('sync.healthModal.loading.message'))

    expectValidDescription(dialog, i18n.t('sync.healthModal.loading.message'))
  })

  it('gives the unavailable dialog a valid accessible description', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.diagnostics.getSystemHealth.mockRejectedValueOnce(
      new Error('diagnostic transport unavailable'),
    )
    renderHealthIndicator()

    const dialog = await getHealthDialog()
    await screen.findByText(i18n.t('sync.healthModal.states.unavailable.message'))

    expectValidDescription(
      dialog,
      i18n.t('sync.healthModal.states.unavailable.message'),
    )
  })

  it('closes on Escape and restores focus to the launcher', async () => {
    renderHealthIndicator(false)
    const launcher = await screen.findByRole('button', {
      name: 'Online | Sync health: Healthy',
    })
    launcher.focus()
    fireEvent.click(launcher)

    const dialog = await getHealthDialog()
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', {
          name: i18n.t('sync.healthModal.close'),
        }),
      ).toHaveFocus(),
    )

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(launcher).toHaveFocus())
  })

  it('restores focus to the capacity-warning opener after Escape', async () => {
    renderHealthIndicator(false)
    const capacityWarningHandler = onEvent.mock.calls.find(
      ([eventName]) => eventName === 'sync:queue-capacity-warning',
    )?.[1] as
      | ((payload: {
          replayable: number
          maxReplayable: number
          conflicts: number
          maxConflicts: number
          replayablePercent: number
          conflictPercent: number
        }) => void)
      | undefined

    expect(capacityWarningHandler).toBeTypeOf('function')
    if (!capacityWarningHandler) {
      throw new Error('Capacity warning event handler was not registered')
    }

    act(() => {
      capacityWarningHandler({
        replayable: 80,
        maxReplayable: 100,
        conflicts: 0,
        maxConflicts: 100,
        replayablePercent: 80,
        conflictPercent: 0,
      })
    })

    const capacityOpener = await screen.findByRole('button', {
      name: i18n.t('sync.capacity.title'),
    })
    capacityOpener.focus()
    fireEvent.click(capacityOpener)

    const dialog = await getHealthDialog()
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', {
          name: i18n.t('sync.healthModal.close'),
        }),
      ).toHaveFocus(),
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(capacityOpener).toHaveFocus())
  })

  it('includes the stale warning in the dialog accessible description', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderHealthIndicator()
    const dialog = await getHealthDialog()
    await screen.findByText(i18n.t('sync.healthModal.states.healthy.title'))

    bridge.diagnostics.getSystemHealth.mockRejectedValueOnce(
      new Error('diagnostic refresh unavailable'),
    )
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: i18n.t('sync.healthModal.actions.refresh'),
      }),
    )

    const staleMessage = i18n.t('sync.healthModal.stale.message')
    await screen.findByText(staleMessage)
    const descriptionIds =
      dialog.getAttribute('aria-describedby')?.trim().split(/\s+/) ?? []
    const accessibleDescription = descriptionIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')

    expect(descriptionIds.length).toBeGreaterThan(0)
    expect(accessibleDescription).toContain(staleMessage)
  })

  it('restores exact aria-hidden and inert state on body siblings after close', async () => {
    const originalInertDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'inert',
    )
    if (!originalInertDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'inert', {
        configurable: true,
        writable: true,
        value: false,
      })
    }

    const bodySibling = document.createElement('main') as HTMLElement & {
      inert: boolean
    }
    bodySibling.setAttribute('aria-hidden', 'false')
    bodySibling.inert = false
    document.body.appendChild(bodySibling)

    try {
      renderHealthIndicator()
      const dialog = await getHealthDialog()

      await waitFor(() => {
        expect(bodySibling).toHaveAttribute('aria-hidden', 'true')
        expect(bodySibling.inert).toBe(true)
      })

      fireEvent.click(
        within(dialog).getByRole('button', {
          name: i18n.t('sync.healthModal.close'),
        }),
      )

      await waitFor(() => expect(dialog).not.toBeInTheDocument())
      await waitFor(() => {
        expect(bodySibling).toHaveAttribute('aria-hidden', 'false')
        expect(bodySibling.inert).toBe(false)
      })
    } finally {
      bodySibling.remove()
      if (originalInertDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'inert',
          originalInertDescriptor,
        )
      } else {
        delete (HTMLElement.prototype as HTMLElement & { inert?: boolean }).inert
      }
    }
  })

  it('wraps forward Tab focus from the last control to the first control', async () => {
    renderHealthIndicator()
    const dialog = await getHealthDialog()
    await screen.findByText(i18n.t('sync.healthModal.states.healthy.title'))
    const buttons = within(dialog).getAllByRole('button')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    last.focus()

    fireEvent.keyDown(document, { key: 'Tab' })

    expect(first).toHaveFocus()
  })

  it('wraps reverse Tab focus from the first control to the last control', async () => {
    renderHealthIndicator()
    const dialog = await getHealthDialog()
    await screen.findByText(i18n.t('sync.healthModal.states.healthy.title'))
    const buttons = within(dialog).getAllByRole('button')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    first.focus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

    expect(last).toHaveFocus()
  })

  it('does not close on Escape while another dialog is topmost', async () => {
    renderHealthIndicator()
    const dialog = await getHealthDialog()
    const topmostDialog = document.createElement('div')
    topmostDialog.setAttribute('role', 'dialog')
    topmostDialog.setAttribute('aria-label', 'Nested confirmation')
    topmostDialog.setAttribute('data-test-topmost-dialog', 'true')
    document.body.appendChild(topmostDialog)

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(dialog).toBeInTheDocument()
  })
})
