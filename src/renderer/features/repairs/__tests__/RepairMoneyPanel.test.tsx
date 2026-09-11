import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../../../../locales/en.json'
import type { RepairCapabilitiesSnapshot } from '../contracts'
import type { RepairFiscalReadiness } from '../../../services/RepairMoneyApiService'

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

const readyFiscalReadiness: RepairFiscalReadiness = {
  ready: true,
  code: 'ready',
  countryCode: 'GR',
  fiscalMode: 'fiscal',
  capabilities: { collectPayments: true, refundPayments: true, fiscalize: true },
}

const readyOperationalReadiness: RepairFiscalReadiness = {
  ...readyFiscalReadiness,
  fiscalMode: 'non_fiscal',
  capabilities: { collectPayments: true, refundPayments: true, fiscalize: false },
}

function fiscalProjection(state = 'issued') {
  return {
    ...projection,
    orders: [{ ...projection.orders[0], fiscal_state: state }],
    fiscal_commands: [{
      id: '66666666-6666-4666-8666-666666666666',
      order_id: projection.orders[0].id,
      purpose: 'deposit', amount_minor: 4000, status: state === 'issued' ? 'submitted' : 'queued',
      attempt_count: 1, occurred_at: '2026-08-31T10:00:00.000Z', updated_at: '2026-08-31T10:00:00.000Z',
    }],
  }
}

function createMoneyService() {
  return {
    getSettlement: vi.fn().mockResolvedValue(projection),
    getFiscalReadiness: vi.fn().mockResolvedValue(readyFiscalReadiness),
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
    moneyService: props.moneyService as ReturnType<typeof createMoneyService>,
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

  it('shows a loading state while fiscal readiness is being checked', async () => {
    const moneyService = createMoneyService()
    let resolveReadiness: ((value: RepairFiscalReadiness) => void) | undefined
    moneyService.getFiscalReadiness.mockImplementation(() => new Promise((resolve) => {
      resolveReadiness = resolve
    }))
    renderPanel({ moneyService })

    expect(await screen.findByText('Checking fiscal readiness…')).toBeVisible()

    await act(async () => resolveReadiness?.(readyFiscalReadiness))
    await waitFor(() => expect(screen.queryByText('Checking fiscal readiness…')).not.toBeInTheDocument())
  })

  it('shows a bounded blocked-readiness message with retry and denies fiscal-gated actions', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValue(fiscalProjection())
    moneyService.getFiscalReadiness.mockResolvedValue({
      ready: false,
      code: 'certification_required',
      countryCode: 'GR',
      fiscalMode: null,
      capabilities: { collectPayments: false, refundPayments: false, fiscalize: false },
    })
    renderPanel({ moneyService })
    await screen.findByText('€60.00')

    expect(await screen.findByText('Fiscal certification is required for fiscal actions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Issue fiscal document' })).toBeDisabled()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '60.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
  })

  it('shows optional myDATA info and still allows collecting payment when readiness is non-fiscal ready', async () => {
    const moneyService = createMoneyService()
    moneyService.getFiscalReadiness.mockResolvedValue({
      ready: true,
      code: 'ready',
      countryCode: 'GR',
      fiscalMode: 'non_fiscal',
      capabilities: { collectPayments: true, refundPayments: true, fiscalize: false },
    })
    renderPanel({ moneyService })
    await screen.findByText('€60.00')

    expect(await screen.findByText(
      'myDATA is optional. Repair payments can be recorded without the plugin.',
    )).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Issue fiscal document' })).toBeDisabled()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '60.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeEnabled()
  })

  it('denies fiscal-gated actions and shows a bounded message without leaking internal errors when readiness fails to load', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValue(fiscalProjection())
    moneyService.getFiscalReadiness.mockRejectedValue(new Error('internal transport detail that must not leak'))
    renderPanel({ moneyService })
    await screen.findByText('€60.00')

    expect(await screen.findByText('Fiscal readiness could not be determined.')).toBeVisible()
    expect(screen.queryByText('internal transport detail that must not leak')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue fiscal document' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(moneyService.getFiscalReadiness).toHaveBeenCalledTimes(2))
  })

  it('ignores a stale fiscal readiness result after the staff shift context changes', async () => {
    const moneyService = createMoneyService()
    let resolveOld: ((value: RepairFiscalReadiness) => void) | undefined
    let resolveNext: ((value: RepairFiscalReadiness) => void) | undefined
    let calls = 0
    moneyService.getFiscalReadiness.mockImplementation(() => new Promise((resolve) => {
      calls += 1
      if (calls === 1) resolveOld = resolve
      else resolveNext = resolve
    }))
    const { rerender } = renderPanel({ moneyService, hasActiveShift: true })
    await waitFor(() => expect(moneyService.getFiscalReadiness).toHaveBeenCalledTimes(1))

    rerender({ hasActiveShift: false })
    await waitFor(() => expect(moneyService.getFiscalReadiness).toHaveBeenCalledTimes(2))

    await act(async () => resolveNext?.({
      ready: false,
      code: 'setup_required',
      countryCode: 'GR',
      fiscalMode: null,
      capabilities: { collectPayments: false, refundPayments: false, fiscalize: false },
    }))
    expect(await screen.findByText('Fiscal setup for this branch is incomplete.')).toBeVisible()

    await act(async () => resolveOld?.(readyFiscalReadiness))
    expect(screen.getByText('Fiscal setup for this branch is incomplete.')).toBeVisible()
  })

  it('ignores a stale fiscal readiness result after the repair changes', async () => {
    const nextRepairId = '55555555-5555-4555-8555-555555555555'
    const moneyService = createMoneyService()
    let resolveOld: ((value: RepairFiscalReadiness) => void) | undefined
    let resolveNext: ((value: RepairFiscalReadiness) => void) | undefined
    let calls = 0
    moneyService.getFiscalReadiness.mockImplementation(() => new Promise((resolve) => {
      calls += 1
      if (calls === 1) resolveOld = resolve
      else resolveNext = resolve
    }))
    const { rerender } = renderPanel({ moneyService })
    await waitFor(() => expect(moneyService.getFiscalReadiness).toHaveBeenCalledTimes(1))

    rerender({ repairId: nextRepairId, repairVersion: 1 })
    await waitFor(() => expect(moneyService.getFiscalReadiness).toHaveBeenCalledTimes(2))

    await act(async () => resolveNext?.({
      ready: false,
      code: 'setup_required',
      countryCode: 'GR',
      fiscalMode: null,
      capabilities: { collectPayments: false, refundPayments: false, fiscalize: false },
    }))
    expect(await screen.findByText('Fiscal setup for this branch is incomplete.')).toBeVisible()

    await act(async () => resolveOld?.(readyFiscalReadiness))
    expect(screen.getByText('Fiscal setup for this branch is incomplete.')).toBeVisible()
  })

  it('allows a partial payment without deposit support when readiness is non-fiscal ready', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValue({ ...projection, paid_minor: 0, balance_minor: 10000, payments: [] })
    moneyService.getFiscalReadiness.mockResolvedValue({
      ready: true,
      code: 'ready',
      countryCode: 'GR',
      fiscalMode: 'non_fiscal',
      capabilities: { collectPayments: true, refundPayments: true, fiscalize: false },
    })
    const { moneyService: service } = renderPanel({ moneyService, repairDepositSupported: false })
    await screen.findByText('€0.00')
    await screen.findByText('myDATA is optional. Repair payments can be recorded without the plugin.')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '20.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))

    await waitFor(() => expect(service.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ amount_minor: 2000 }),
    })))
  })

  it('still denies a partial payment without deposit support when readiness is plain fiscal ready', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValue(fiscalProjection())
    renderPanel({ moneyService, repairDepositSupported: false })
    await screen.findByText('€60.00')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '20.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))

    expect(moneyService.recordPayment).not.toHaveBeenCalled()
  })

  it('allows collecting and refunding existing operational order history even when branch readiness is blocked', async () => {
    const moneyService = createMoneyService()
    moneyService.getFiscalReadiness.mockResolvedValue({
      ready: false,
      code: 'provider_required',
      countryCode: 'GR',
      fiscalMode: null,
      capabilities: { collectPayments: false, refundPayments: false, fiscalize: false },
    })
    const { moneyService: service } = renderPanel({ moneyService })
    await screen.findByText('€60.00')
    await screen.findByText('A fiscal provider is required for fiscal actions.')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '20.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))
    await waitFor(() => expect(service.recordPayment).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), { target: { value: PAYMENT_ID } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Refund amount' }), { target: { value: '10.00' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Refund reason' }), { target: { value: 'Customer request' } })
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refund payment' }))

    await waitFor(() => expect(service.recordRefund).toHaveBeenCalled())
  })

  it('does not allow the operational override once a fiscal command exists for that order', async () => {
    const moneyService = createMoneyService()
    moneyService.getFiscalReadiness.mockResolvedValue({
      ready: false,
      code: 'provider_required',
      countryCode: 'GR',
      fiscalMode: null,
      capabilities: { collectPayments: false, refundPayments: false, fiscalize: false },
    })
    moneyService.getSettlement.mockResolvedValue({
      ...projection,
      fiscal_commands: [{
        id: '66666666-6666-4666-8666-666666666666',
        order_id: projection.orders[0].id,
        purpose: 'sale',
        amount_minor: 10000,
        status: 'submitted',
        attempt_count: 1,
        occurred_at: '2026-08-31T10:00:00.000Z',
        updated_at: '2026-08-31T10:00:00.000Z',
      }],
    })
    const { moneyService: service } = renderPanel({ moneyService })
    await screen.findByText('€60.00')
    await screen.findByText('A fiscal provider is required for fiscal actions.')

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '20.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))

    expect(service.recordPayment).not.toHaveBeenCalled()
  })

  it.each(['issued', 'issue_pending', 'unknown', 'issue_failed', 'correction_pending', 'cancelled'])(
    'keeps %s fiscal history blocked after the optional plugin is disabled', async state => {
      const moneyService = createMoneyService()
      moneyService.getSettlement.mockResolvedValue(fiscalProjection(state))
      moneyService.getFiscalReadiness.mockResolvedValue(readyOperationalReadiness)
      renderPanel({ moneyService })
      await screen.findByText('myDATA is optional. Repair payments can be recorded without the plugin.')
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '20.00' } })
      fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), { target: { value: PAYMENT_ID } })
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Refund amount' }), { target: { value: '10.00' } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Refund reason' }), { target: { value: 'Customer request' } })
      expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }))
      fireEvent.click(screen.getByRole('button', { name: 'Refund payment' }))
      expect(moneyService.recordPayment).not.toHaveBeenCalled()
      expect(moneyService.recordRefund).not.toHaveBeenCalled()
    },
  )

  it('keeps unresolved fiscal history blocked even when branch fiscal readiness is ready', async () => {
    const moneyService = createMoneyService()
    moneyService.getSettlement.mockResolvedValue(fiscalProjection('unknown'))
    renderPanel({ moneyService })
    await screen.findByText('€60.00')
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '60.00' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), { target: { value: PAYMENT_ID } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Refund amount' }), { target: { value: '10.00' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Refund reason' }), { target: { value: 'Customer request' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
  })

  it('does not borrow another order’s operational history for collection or the selected refund', async () => {
    const moneyService = createMoneyService()
    const supplementId = '77777777-7777-4777-8777-777777777777'
    const supplementPaymentId = '88888888-8888-4888-8888-888888888888'
    moneyService.getFiscalReadiness.mockResolvedValue(readyOperationalReadiness)
    moneyService.getSettlement.mockResolvedValue({
      ...projection,
      total_minor: 15000, paid_minor: 11000, balance_minor: 4000,
      orders: [
        { ...projection.orders[0], fiscal_state: 'recognized_non_fiscal', payment_status: 'paid' },
        { ...projection.orders[0], id: supplementId, role: 'supplement', fiscal_state: 'issued', total_minor: 5000 },
      ],
      payments: [
        { ...projection.payments[0], amount_minor: 10000, refundable_minor: 10000 },
        { ...projection.payments[0], id: supplementPaymentId, order_id: supplementId, amount_minor: 1000, refundable_minor: 1000 },
      ],
      fiscal_commands: [{ ...fiscalProjection().fiscal_commands[0], order_id: supplementId }],
    })
    renderPanel({ moneyService })
    await screen.findByText('myDATA is optional. Repair payments can be recorded without the plugin.')
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Payment amount' }), { target: { value: '40.00' } })
    expect(screen.getByRole('button', { name: 'Collect payment' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), { target: { value: supplementPaymentId } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Refund amount' }), { target: { value: '10.00' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Refund reason' }), { target: { value: 'Customer request' } })
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Payment to refund' }), { target: { value: PAYMENT_ID } })
    expect(screen.getByRole('button', { name: 'Refund payment' })).toBeEnabled()
  })
})
