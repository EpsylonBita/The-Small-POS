import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const messagingMocks = vi.hoisted(() => ({
  history: vi.fn(),
  preference: vi.fn(),
}))

vi.mock('../../customer-messaging/service', () => ({
  customerMessagingService: {
    history: messagingMocks.history,
    preference: messagingMocks.preference,
  },
}))

import en from '../../../../locales/en.json'
import { emitCompatEvent } from '../../../../lib/event-bridge'
import type {
  RepairCustomerSnapshot,
  RepairDeviceSnapshot,
  RepairSettingsProjection,
} from '../contracts'
import { RepairIntakeDialog } from '../RepairIntakeDialog'

vi.mock('../../../components/ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children, title }: {
    isOpen: boolean
    children: React.ReactNode
    title?: string
  }) => isOpen ? <div role="dialog" aria-label={title}>{children}</div> : null,
}))

const customer: RepairCustomerSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Alex Customer',
}

const device: RepairDeviceSnapshot = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Work phone',
  deviceType: 'phone',
  manufacturer: 'Apple',
  model: 'iPhone 15',
  variant: null,
  storageCapacity: null,
  color: null,
  serialMasked: '••••1234',
  imeiMasked: null,
  createdAt: '2026-08-27T08:00:00.000Z',
  updatedAt: '2026-08-27T08:00:00.000Z',
}

const secondCustomer: RepairCustomerSnapshot = {
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Blair Customer',
}

const secondDevice: RepairDeviceSnapshot = {
  ...device,
  id: '44444444-4444-4444-8444-444444444444',
  label: 'Blair phone',
}

const settings: RepairSettingsProjection = {
  source: 'server',
  numberPrefix: 'R',
  currency: 'EUR',
  quickServiceEnabled: true,
  defaultPriority: 'normal',
  defaultSlaHours: 48,
  readyCollectionDays: 7,
  deliveryBalancePolicy: 'paid_or_override',
  repairDepositSupported: false,
  attachmentPolicy: { maxBytes: 5_000_000, allowedMimeTypes: ['image/jpeg'] },
  updatedAt: '2026-08-27T08:00:00.000Z',
}

const messagingWorkspace = {
  customerId: customer.id,
  operationalLocked: false,
  lockReason: null,
  permissions: { read: true, link: true, send: false, retry: false },
  preference: { decision: 'no_preference', channel: null },
  channels: [],
  preferenceTargets: [
    { connectionId: null, channel: 'sms', provider: null },
    {
      connectionId: '55555555-5555-4555-8555-555555555555',
      channel: 'whatsapp',
      provider: 'whatsapp_cloud',
    },
  ],
  linkTargets: [],
  messages: [],
  pagination: { nextCursor: null, hasMore: false },
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof RepairIntakeDialog>> = {}) {
  const instance = i18next.createInstance()
  void instance.init({ lng: 'en', resources: { en: { translation: en } } })
  const props: React.ComponentProps<typeof RepairIntakeDialog> = {
    isOpen: true,
    intent: 'new_repair',
    settings,
    connectivity: 'online',
    isSubmitting: false,
    onClose: vi.fn(),
    onSearchCustomers: vi.fn().mockResolvedValue([customer]),
    onLoadDevices: vi.fn().mockResolvedValue([device]),
    onCreateDevice: vi.fn().mockResolvedValue([device]),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  const view = render(
    <I18nextProvider i18n={instance}>
      <RepairIntakeDialog {...props} />
    </I18nextProvider>,
  )
  return {
    props,
    rerender: (next: React.ComponentProps<typeof RepairIntakeDialog>) => view.rerender(
      <I18nextProvider i18n={instance}>
        <RepairIntakeDialog {...next} />
      </I18nextProvider>,
    ),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  messagingMocks.history.mockResolvedValue(messagingWorkspace)
  messagingMocks.preference.mockResolvedValue({})
})
afterEach(() => cleanup())

describe('RepairIntakeDialog', () => {
  it('requires a selected canonical customer and device for a standard repair', async () => {
    const { props } = renderDialog()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), {
      target: { value: 'Alex' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    expect(await screen.findByRole('button', { name: /Alex Customer/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Alex Customer/ }))
    expect(await screen.findByRole('button', { name: /Work phone/ })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Create repair' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Select a customer and device')
    expect(props.onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Work phone/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create repair' }))

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1))
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      repairId: expect.any(String),
      command: {
        command: 'create_intake',
        payload: expect.objectContaining({
          intake_mode: 'standard',
          is_anonymous: false,
          customer_id: customer.id,
          customer_device_id: device.id,
        }),
      },
    }))
  })

  it('fails closed for Quick Service until settings load', () => {
    renderDialog({ intent: 'quick_service', settings: null })

    expect(screen.getByRole('button', { name: 'Create repair' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/disabled until authoritative or cached settings/i)
  })

  it('creates anonymous Quick Service without customer or device references', async () => {
    const { props } = renderDialog({ intent: 'quick_service' })

    expect(screen.getByRole('radio', { name: 'Anonymous quick service' })).toBeChecked()
    expect(screen.queryByRole('searchbox', { name: 'Customer search' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create repair' }))

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1))
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      command: {
        command: 'create_intake',
        payload: expect.objectContaining({
          intake_mode: 'quick_service',
          is_anonymous: true,
          customer_id: null,
          customer_device_id: null,
        }),
      },
    }))
    expect(messagingMocks.history).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'No automated updates' })).not.toBeInTheDocument()
  })

  it('asks for an explicit transactional preference after canonical customer selection', async () => {
    renderDialog()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), {
      target: { value: 'Alex' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    fireEvent.click(await screen.findByRole('button', { name: /Alex Customer/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'No automated updates' }))

    await waitFor(() => expect(messagingMocks.preference).toHaveBeenCalledWith({
      customerId: customer.id,
      decision: 'no_preference',
      channel: null,
      connectionId: null,
    }))
  })

  it('does not append duplicate preferences from rapid intake clicks', async () => {
    let resolvePreference: (() => void) | undefined
    messagingMocks.preference.mockImplementation(() => new Promise<void>((resolve) => {
      resolvePreference = resolve
    }))
    renderDialog()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), {
      target: { value: 'Alex' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    fireEvent.click(await screen.findByRole('button', { name: /Alex Customer/ }))

    const button = await screen.findByRole('button', { name: 'No automated updates' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(messagingMocks.preference).toHaveBeenCalledTimes(1)

    await act(async () => resolvePreference?.())
  })

  it('does not let a failed preference write block repair intake', async () => {
    messagingMocks.preference.mockRejectedValueOnce(new Error('provider unavailable'))
    const { props } = renderDialog()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), {
      target: { value: 'Alex' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    fireEvent.click(await screen.findByRole('button', { name: /Alex Customer/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'No automated updates' }))
    fireEvent.click(await screen.findByRole('button', { name: /Work phone/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create repair' }))

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('communication preference was not saved')
  })

  it('never asks for device unlock credentials', () => {
    renderDialog()

    emitCompatEvent('barcode_scanned_serial', {
      barcode: 'DEVICE-SERIAL-MUST-NOT-ENTER-INTAKE',
      source: 'serial',
      timestamp: '2026-08-27T08:00:00.000Z',
    })

    expect(screen.queryByLabelText(/pin|password|unlock pattern/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/pin|password|unlock pattern/i)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('DEVICE-SERIAL-MUST-NOT-ENTER-INTAKE')).not.toBeInTheDocument()
  })

  it('ignores a stale device response after the customer changes', async () => {
    let resolveFirst: ((devices: RepairDeviceSnapshot[]) => void) | undefined
    let resolveSecond: ((devices: RepairDeviceSnapshot[]) => void) | undefined
    const onLoadDevices = vi.fn((customerId: string) => new Promise<RepairDeviceSnapshot[]>((resolve) => {
      if (customerId === customer.id) resolveFirst = resolve
      else resolveSecond = resolve
    }))
    renderDialog({
      onSearchCustomers: vi.fn().mockResolvedValue([customer, secondCustomer]),
      onLoadDevices,
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), { target: { value: 'Customer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    const firstButton = await screen.findByRole('button', { name: /Alex Customer/ })
    const secondButton = screen.getByRole('button', { name: /Blair Customer/ })
    fireEvent.click(firstButton)
    fireEvent.click(secondButton)

    await act(async () => resolveSecond?.([secondDevice]))
    expect(await screen.findByRole('button', { name: /Blair phone/ })).toBeVisible()
    await act(async () => resolveFirst?.([device]))
    expect(screen.queryByRole('button', { name: /Work phone/ })).not.toBeInTheDocument()
  })

  it('keeps selected canonical references for offline submit but disables further lookup', async () => {
    const { props, rerender } = renderDialog()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Customer search' }), { target: { value: 'Alex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search customers' }))
    fireEvent.click(await screen.findByRole('button', { name: /Alex Customer/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Work phone/ }))

    rerender({ ...props, connectivity: 'offline' })
    expect(screen.getByRole('status')).toHaveTextContent(/lookup requires an online native connection/i)
    expect(screen.getByRole('searchbox', { name: 'Customer search' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'No automated updates' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create repair' }))

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        payload: expect.objectContaining({
          customer_id: customer.id,
          customer_device_id: device.id,
        }),
      }),
    })))
  })
})
