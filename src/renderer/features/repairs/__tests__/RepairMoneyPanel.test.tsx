import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../../../../locales/en.json'
import type { RepairCapabilitiesSnapshot } from '../contracts'

const mocks = vi.hoisted(() => ({
  createSecureRepairId: vi.fn(() => '99999999-9999-4999-8999-999999999999'),
}))

vi.mock('../secure-id', () => ({
  canCreateSecureRepairId: () => true,
  createSecureRepairId: mocks.createSecureRepairId,
}))

import { RepairMoneyPanel } from '../RepairMoneyPanel'

const REPAIR_ID = '11111111-1111-4111-8111-111111111111'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333'

const projection = {
  repair_id: REPAIR_ID,
  currency: 'EUR',
  total_minor: 10000,
  paid_minor: 4000,
  refunded_minor: 0,
  balance_minor: 6000,
  orders: [{
    id: '44444444-4444-4444-8444-444444444444',
    order_number: 'ORD-100',
    role: 'primary',
    fiscal_state: 'deferred',
    payment_status: 'partial',
    total_minor: 10000,
  }],
  payments: [{
    id: PAYMENT_ID,
    order_id: '44444444-4444-4444-8444-444444444444',
    payment_method: 'cash',
    amount_minor: 4000,
    refunded_minor: 0,
    refundable_minor: 4000,
    status: 'completed',
    created_at: '2026-08-31T10:00:00.000Z',
  }],
  adjustments: [],
  fiscal_commands: [],
} as const

const capabilities: RepairCapabilitiesSnapshot = {
  read: true,
  create: true,
  update: true,
  assign: true,
  approve: true,
  overrideApproval: false,
  planParts: true,
  consumeParts: true,
  transfer: false,
  cancel: true,
  manageAttachments: true,
  collectPayments: true,
  refundPayments: true,
  fiscalize: true,
  overrideDeliveryBalance: true,
}

function createMoneyService() {
  return {
    getSettlement: vi.fn().mockResolvedValue(projection),
    createOrRefreshSettlement: vi.fn().mockResolvedValue({ success: true, data: {} }),
    recordPayment: vi.fn().mockResolvedValue({ success: true, data: {} }),
    recordRefund: vi.fn().mockResolvedValue({ success: true, data: {} }),
    fiscalize: vi.fn().mockResolvedValue({ success: true, data: {} }),
    deliver: vi.fn().mockResolvedValue({ success: true, data: {} }),
  }
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof RepairMoneyPanel>> = {}) {
  const instance = i18next.createInstance()
  void instance.init({ lng: 'en', resources: { en: { translation: en } } })
  const moneyService = createMoneyService()
  const props: React.ComponentProps<typeof RepairMoneyPanel> = {
    repairId: REPAIR_ID,
    repairVersion: 7,
    repairStatus: 'ready',
    currency: 'EUR',
    hasAcceptedEstimate: true,
    capabilities,
    allowedTransitions: ['delivered'],
    repairDepositSupported: true,
    connectivity: 'online',
    hasActiveShift: true,
    isBusy: false,
    moneyService,
    onBusyChange: vi.fn(),
    onAuthoritativeRefresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  const view = render(<I18nextProvider i18n={instance}><RepairMoneyPanel {...props} /></I18nextProvider>)
  return {
    props,
    moneyService,
    rerender: (next: Partial<React.ComponentProps<typeof RepairMoneyPanel>>) => view.rerender(
      <I18nextProvider i18n={instance}><RepairMoneyPanel {...props} {...next} /></I18nextProvider>,
    ),
  }
}

beforeEach(() => {
  mocks.createSecureRepairId.mockClear()
})

afterEach(() => cleanup())

describe('RepairMoneyPanel', () => {
  it('loads and displays the authoritative minor-unit settlement without deriving money from the repair workspace', async () => {
    const { moneyService } = renderPanel()

    expect(await screen.findByText('€60.00')).toBeVisible()
    expect(screen.getByText('€100.00')).toBeVisible()
    expect(moneyService.getSettlement).toHaveBeenCalledWith(REPAIR_ID)
  })

  it('keeps authoritative financial history readable online without opening money actions', async () => {
    const { moneyService } = renderPanel({ hasActiveShift: false })

    expect(await screen.findByText('€60.00')).toBeVisible()
    expect(moneyService.getSettlement).toHaveBeenCalledWith(REPAIR_ID)
    expect(screen.getByRole('button', { name: 'Create settlement' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue fiscal document' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deliver repair' })).toBeDisabled()
  })

  it('does not render a financial projection under a mismatched repair currency', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValueOnce({ ...projection, currency: 'USD' })
    renderPanel({ moneyService })

    expect(await screen.findByRole('alert')).toHaveTextContent('REPAIR_FINANCIAL_CURRENCY_MISMATCH')
    expect(screen.queryByText('€60.00')).not.toBeInTheDocument()
  })

  it('ignores an old financial projection after the repair changes', async () => {
    const nextRepairId = '55555555-5555-4555-8555-555555555555'
    let resolveOld: ((value: unknown) => void) | undefined
    let resolveNext: ((value: unknown) => void) | undefined
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockImplementation((repairId: string) => new Promise((resolve) => {
      if (repairId === REPAIR_ID) resolveOld = resolve
      else resolveNext = resolve
    }))
    const { rerender } = renderPanel({ moneyService })
    await waitFor(() => expect(moneyService.getSettlement).toHaveBeenCalledWith(REPAIR_ID))

    rerender({ repairId: nextRepairId, repairVersion: 1 })
    await waitFor(() => expect(moneyService.getSettlement).toHaveBeenCalledWith(nextRepairId))
    await act(async () => resolveNext?.({
      ...projection,
      repair_id: nextRepairId,
      total_minor: 2000,
      paid_minor: 0,
      refunded_minor: 0,
      balance_minor: 2000,
      orders: [{ ...projection.orders[0], total_minor: 2000 }],
      payments: [],
      adjustments: [],
    }))
    expect(await screen.findAllByText('€20.00')).not.toHaveLength(0)

    await act(async () => resolveOld?.(projection))
    expect(screen.queryByText('€60.00')).not.toBeInTheDocument()
  })

  it('reuses the same operation id after an ambiguous payment failure and refreshes only after success', async () => {
    const moneyService = createMoneyService()
    moneyService.recordPayment
      .mockResolvedValueOnce({ success: false, error: 'Network timeout' })
      .mockResolvedValueOnce({ success: true, data: {} })
    const onAuthoritativeRefresh = vi.fn().mockResolvedValue(undefined)
    renderPanel({ moneyService, onAuthoritativeRefresh })
    await screen.findByText('€60.00')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), {
      target: { value: '60.00' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network timeout')

    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))
    await waitFor(() => expect(moneyService.recordPayment).toHaveBeenCalledTimes(2))

    const [first, second] = moneyService.recordPayment.mock.calls.map(([intent]) => intent)
    expect(first.operation_id).toBe('99999999-9999-4999-8999-999999999999')
    expect(second.operation_id).toBe(first.operation_id)
    expect(first).toMatchObject({
      repair_id: REPAIR_ID,
      expected_version: 7,
      payload: { amount_minor: 6000, payment_method: 'cash' },
    })
    expect(first).not.toHaveProperty('staff_session_id')
    expect(onAuthoritativeRefresh).toHaveBeenCalledWith(REPAIR_ID)
  })

  it('targets one refundable payment and requires an audited reason', async () => {
    const { moneyService } = renderPanel()
    await screen.findByText('€60.00')

    fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), {
      target: { value: PAYMENT_ID },
    })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Refund amount' }), {
      target: { value: '10.00' },
    })
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Refund reason' }), {
      target: { value: 'Customer request' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refund payment' }))

    await waitFor(() => expect(moneyService.recordRefund).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        payment_id: PAYMENT_ID,
        amount_minor: 1000,
        refund_method: 'cash',
        reason: 'Customer request',
      },
    })))
  })

  it('fails closed on a provider reference that the canonical payment contract rejects', async () => {
    renderPanel()
    await screen.findByText('€60.00')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), {
      target: { value: '60.00' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider reference' }), {
      target: { value: 'not a canonical reference' },
    })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Provider reference' }), {
      target: { value: 'terminal:txn-100' },
    })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeEnabled()
  })

  it('blocks partial deposit, money, fiscal and delivery actions when their online gates are not satisfied', async () => {
    const { moneyService } = renderPanel({
      connectivity: 'offline',
      repairDepositSupported: false,
      capabilities: {
        ...capabilities,
        collectPayments: false,
        refundPayments: false,
        fiscalize: false,
        overrideDeliveryBalance: false,
      },
    })
    await screen.findByText('Payments require an online connection.')

    expect(moneyService.getSettlement).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create settlement' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue fiscal document' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deliver repair' })).toBeDisabled()
  })

  it('requires a manager override reason before delivering with a non-zero balance', async () => {
    const { moneyService } = renderPanel()
    await screen.findByText('€60.00')

    expect(screen.getByRole('button', { name: 'Deliver repair' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Delivery override reason' }), {
      target: { value: 'Approved account customer' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Deliver repair' }))

    await waitFor(() => expect(moneyService.deliver).toHaveBeenCalledWith(expect.objectContaining({
      payload: { reason: 'Approved account customer' },
    })))
  })
})
