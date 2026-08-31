import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  posApiDelete: vi.fn(),
  getResolvedTerminalCredentials: vi.fn(),
  deleteAddress: vi.fn(),
  getBranchId: vi.fn(),
  customerServiceAddCustomerAddress: vi.fn(),
  addCustomerModalProps: vi.fn(),
  actualAddCustomerModal: null as any,
  renderModalContent: true,
  translate: vi.fn((key: string, fallback?: string | Record<string, unknown>) => {
    if (key === 'modals.customerSearch.addNewCustomer') return 'Add customer'
    if (key === 'modals.customerSearch.addNewAddress') return 'Add address'
    if (key === 'modals.customerSearch.customerNotFound') return 'Customer not found'
    return typeof fallback === 'string' ? fallback : key
  }),
}))

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: mocks.posApiGet,
  posApiDelete: mocks.posApiDelete,
}))

vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: mocks.getResolvedTerminalCredentials,
}))

vi.mock('../../../../lib', () => ({
  getBridge: () => ({
    customers: {
      deleteAddress: mocks.deleteAddress,
      invalidateCache: vi.fn(),
      lookupByPhone: vi.fn(),
    },
    terminalConfig: { getBranchId: mocks.getBranchId },
  }),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}))

vi.mock('../../../services/CustomerService', () => ({
  customerService: { addCustomerAddress: mocks.customerServiceAddCustomerAddress },
}))

vi.mock('../../../services/address-workflow', () => ({
  buildAddressFingerprint: () => 'address-fingerprint',
  createAddressSessionToken: () => 'address-session',
  ensureAddressOfflineRuntime: vi.fn().mockResolvedValue(undefined),
  extractStreetNumber: () => null,
  getSuggestionStreetLabel: () => '',
  resolveAddressSuggestion: vi.fn(),
  searchAddressSuggestions: vi.fn().mockResolvedValue([]),
  upsertVerifiedLocalCandidate: vi.fn(),
  validateAddressForDelivery: vi.fn(),
}))

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}))

vi.mock('../../../hooks/useAcquiredModules', () => ({
  MODULE_IDS: { DELIVERY: 'delivery', DELIVERY_ZONES: 'delivery_zones' },
  useAcquiredModules: () => ({
    hasDeliveryModule: true,
    hasTablesModule: true,
    hasRoomsModule: false,
    hasAppointmentsModule: false,
    hasServiceCatalogModule: false,
    hasModule: () => false,
  }),
}))

vi.mock('../../forms/FloorPresetPicker', () => ({
  FloorPresetPicker: ({ value, onChange, label }: Record<string, any>) => (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

vi.mock('../../../utils/format', () => ({
  formatDate: (value: string) => value,
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: mocks.translate }),
  }
})

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: function MockLiquidGlassModal({
    isOpen,
    onClose,
    children,
    title,
    header,
    ariaLabel,
  }: {
    isOpen: boolean
    onClose: () => void
    children: React.ReactNode
    title?: string
    header?: React.ReactNode
    ariaLabel?: string
  }) {
    if (!isOpen || !mocks.renderModalContent) return null

    return (
      <div role="dialog" aria-label={ariaLabel || title}>
        <button
          type="button"
          aria-label="Close caller lookup"
          onClick={onClose}
        />
        {header}
        {children}
      </div>
    )
  },
}))

vi.mock('../../ui/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}))

vi.mock('../AddCustomerModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AddCustomerModal')>()
  mocks.actualAddCustomerModal = actual.AddCustomerModal

  return {
    AddCustomerModal: (props: Record<string, any>) => {
    mocks.addCustomerModalProps(props)
    if (!props.isOpen || props.callerIdWorkspace?.suspended) return null

    return (
      <div role="dialog" aria-label="Add customer form">
        <span>{String(props.initialPhone ?? '')}</span>
        <button
          type="button"
          aria-label="Minimize customer form"
          onClick={props.callerIdWorkspace?.onMinimize}
        />
      </div>
    )
  },
  }
})

import { CustomerSearchModal } from '../CustomerSearchModal'
import { CallerIdCustomerSearchModalHost } from '../../callerid/CallerIdCustomerSearchModalHost'

interface CallerIdCustomerSearchRequestContract {
  displayPhone: string
  lookupPhone: string
  requestKey: string
  onDisplayed: () => void
}

interface CallerIdCustomerSearchModalHostContractProps {
  request: CallerIdCustomerSearchRequestContract | null
  onClose: () => void
  onContinueToOrderType?: (customer: unknown | null) => void
}

const CallerIdCustomerSearchModalHostUnderContract =
  CallerIdCustomerSearchModalHost as React.ComponentType<CallerIdCustomerSearchModalHostContractProps>

describe('CustomerSearchModal Caller ID lookup', () => {
  beforeEach(() => {
    mocks.renderModalContent = true
    mocks.addCustomerModalProps.mockClear()
    mocks.customerServiceAddCustomerAddress.mockReset()
    mocks.getBranchId.mockResolvedValue(null)
    mocks.getResolvedTerminalCredentials.mockResolvedValue({
      apiKey: 'terminal-api-key',
      terminalId: 'terminal-1',
    })
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        success: true,
        customer: {
          id: 'customer-1',
          name: 'Μαρία Παπαδοπούλου',
          phone: '2101234567',
          email: 'maria@example.com',
          address: 'Ερμού 1',
          addresses: [],
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('prefills the incoming number, searches automatically, and renders details read-only', async () => {
    const onDisplayed = vi.fn()

    render(
      <CustomerSearchModal
        isOpen
        lookupOnly
        initialSearchTerm="2101234567"
        searchRequestKey="call-1"
        onDisplayed={onDisplayed}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Phone Number or Name' }))
      .toHaveValue('2101234567')
    expect(onDisplayed).toHaveBeenCalledTimes(1)

    await waitFor(() => {
      expect(mocks.posApiGet).toHaveBeenCalledWith(
        'pos/customers?search=2101234567&phone=2101234567',
        expect.any(Object),
      )
    })
    expect(await screen.findByText('Μαρία Παπαδοπούλου')).toBeInTheDocument()
    expect(screen.getByText('Ερμού 1')).toBeInTheDocument()
    expect(screen.queryByText('Continue')).not.toBeInTheDocument()
    expect(screen.queryByText('Add customer')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Delete Customer')).not.toBeInTheDocument()
  })

  it('displays the original international number while searching with the local lookup number', async () => {
    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: '+41779990214',
          lookupPhone: '779990214',
          requestKey: 'call-swiss',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Phone Number or Name' }))
      .toHaveValue('+41779990214')
    await waitFor(() => {
      expect(mocks.posApiGet).toHaveBeenCalledWith(
        'pos/customers?search=779990214&phone=779990214',
        expect.any(Object),
      )
    })
  })

  it('offers Add customer and direct module-aware order actions after an exact not-found result', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: { success: true },
    })
    const onContinueToOrderType = vi.fn()

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: '+41779990214',
          lookupPhone: '779990214',
          requestKey: 'call-not-found',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
        onContinueToOrderType={onContinueToOrderType}
      />,
    )

    expect(await screen.findByText('Customer not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add customer' })).toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Delivery' })).toBeInTheDocument()
    const pickupButton = screen.getByRole('button', { name: 'Pickup' })
    fireEvent.click(pickupButton)
    expect(onContinueToOrderType).toHaveBeenCalledWith(null)
  })

  it('opens the existing new-customer flow with the displayed caller number', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: { success: true },
    })

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: '+41779990214',
          lookupPhone: '779990214',
          requestKey: 'call-add-customer',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
        onContinueToOrderType={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add customer' }))
    expect(await screen.findByRole('dialog', { name: 'Add customer form' }))
      .toHaveTextContent('+41779990214')
    expect(mocks.addCustomerModalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOpen: true,
        mode: 'new',
        initialPhone: '+41779990214',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Minimize customer form' }))
    expect(screen.queryByRole('dialog', { name: 'Add customer form' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Caller ID')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('dialog', { name: 'Add customer form' }))
      .toHaveTextContent('+41779990214')
  })

  it('adds an address without exposing edit or delete actions', async () => {
    const existingCustomer = {
      id: 'customer-add-address',
      name: 'Address Customer',
      phone: '2101234567',
      addresses: [{
        id: 'address-existing',
        street_address: 'Existing Street 1',
        city: 'Athens',
        is_default: true,
      }],
    }
    mocks.posApiGet.mockResolvedValueOnce({
      success: true,
      data: { success: true, customer: existingCustomer },
    })

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: existingCustomer.phone,
          lookupPhone: existingCustomer.phone,
          requestKey: 'call-add-address',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }))

    expect(mocks.addCustomerModalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOpen: true,
        mode: 'addAddress',
        initialCustomer: expect.objectContaining({ id: existingCustomer.id }),
      }),
    )
    expect(screen.queryByRole('button', { name: /delete customer/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit customer/i })).not.toBeInTheDocument()
  })

  it('restores the same caller with the returned address selected', async () => {
    const incomingNumber = '2101234567'
    const existingCustomer = {
      id: 'customer-returned-address',
      name: 'Returned Address Customer',
      phone: incomingNumber,
      addresses: [{
        id: 'address-existing',
        street_address: 'Existing Street 1',
        city: 'Athens',
        is_default: true,
      }],
    }
    const newAddress = {
      id: 'address-returned',
      street_address: 'Returned Street 2',
      city: 'Athens',
      is_default: false,
    }
    mocks.posApiGet.mockResolvedValueOnce({
      success: true,
      data: { success: true, customer: existingCustomer },
    })

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: incomingNumber,
          lookupPhone: incomingNumber,
          requestKey: 'call-restore-address',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }))
    const addAddressProps = mocks.addCustomerModalProps.mock.lastCall?.[0]

    await act(async () => {
      addAddressProps.onCustomerAdded({
        ...existingCustomer,
        address: newAddress.street_address,
        addresses: [...existingCustomer.addresses, newAddress],
        selected_address_id: newAddress.id,
      })
    })

    expect(await screen.findByRole('button', { name: /Returned Street 2/ }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: 'Phone Number or Name' }))
      .toHaveValue(incomingNumber)
  })

  it('restores the retained caller snapshot without a second lookup when add address is cancelled', async () => {
    const existingCustomer = {
      id: 'customer-cancel-address',
      name: 'Cancelled Address Customer',
      phone: '2101234567',
      addresses: [{
        id: 'address-cancel-existing',
        street_address: 'Offline Street 4',
        city: 'Athens',
        is_default: true,
      }],
    }
    mocks.posApiGet.mockResolvedValueOnce({
      success: true,
      data: { success: true, customer: existingCustomer },
    })

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: existingCustomer.phone,
          lookupPhone: existingCustomer.phone,
          requestKey: 'call-cancel-address',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }))
    mocks.posApiGet.mockClear()
    const addAddressProps = mocks.addCustomerModalProps.mock.lastCall?.[0]

    await act(async () => {
      addAddressProps.onClose()
    })

    expect(screen.getByRole('button', { name: /Offline Street 4/ }))
      .toHaveAttribute('aria-pressed', 'true')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(mocks.posApiGet).not.toHaveBeenCalled()
  })

  it('does not overwrite an explicit returned customer with an automatic lookup', async () => {
    vi.useFakeTimers()
    const returnedCustomer = {
      id: 'customer-explicit-return',
      name: 'Explicit Return Customer',
      phone: '2101234567',
      addresses: [{
        id: 'address-explicit-return',
        street_address: 'Explicit Return Street 3',
        city: 'Athens',
        is_default: true,
      }],
    }

    try {
      render(
        <CustomerSearchModal
          isOpen
          lookupOnly
          initialCustomer={returnedCustomer}
          initialSearchTerm={returnedCustomer.phone}
          onClose={vi.fn()}
        />,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      expect(mocks.posApiGet).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Explicit Return Street 3/ }))
        .toHaveAttribute('aria-pressed', 'true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends a trimmed ringer name in the add-address persistence payload', async () => {
    mocks.customerServiceAddCustomerAddress.mockResolvedValue({
      success: true,
      data: { id: 'address-ringer' },
    })
    const ActualAddCustomerModal = mocks.actualAddCustomerModal as React.ComponentType<Record<string, any>>

    render(
      <ActualAddCustomerModal
        isOpen
        mode="addAddress"
        initialCustomer={{
          id: 'customer-ringer',
          name: 'Ringer Customer',
          phone: '2101234567',
          addresses: [],
        }}
        onClose={vi.fn()}
        onCustomerAdded={vi.fn()}
      />,
    )

    fireEvent.change(
      screen.getByPlaceholderText('modals.addCustomer.manualAddressPlaceholder'),
      { target: { value: 'Ringer Street 5' } },
    )
    fireEvent.change(
      screen.getByPlaceholderText('modals.addCustomer.nameOnRingerPlaceholder'),
      { target: { value: '  Bell  ' } },
    )
    fireEvent.change(screen.getByLabelText('modals.addCustomer.floorLabel'), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Address' }))

    await waitFor(() => {
      expect(mocks.customerServiceAddCustomerAddress).toHaveBeenCalledWith(
        'customer-ringer',
        expect.objectContaining({ name_on_ringer: 'Bell' }),
      )
    })
  })

  it('locks a real add-address form synchronously, blocks every close path, and unlocks with safe feedback after failure', async () => {
    let rejectAddress: ((reason: Error) => void) | undefined
    mocks.customerServiceAddCustomerAddress.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectAddress = reject
    }))
    const onClose = vi.fn()
    const onMinimize = vi.fn()
    const ActualAddCustomerModal = mocks.actualAddCustomerModal as React.ComponentType<Record<string, any>>

    render(
      <ActualAddCustomerModal
        isOpen
        mode="addAddress"
        initialCustomer={{
          id: 'customer-lock',
          name: 'Locked Customer',
          phone: '2101234567',
          addresses: [],
        }}
        onClose={onClose}
        onCustomerAdded={vi.fn()}
        callerIdWorkspace={{ suspended: false, onMinimize }}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.manualAddressPlaceholder'), {
      target: { value: 'Locked Street 1' },
    })
    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.nameOnRingerPlaceholder'), {
      target: { value: 'Bell' },
    })
    fireEvent.change(screen.getByLabelText('modals.addCustomer.floorLabel'), {
      target: { value: '2' },
    })

    const save = screen.getByRole('button', { name: 'Save Address' })
    fireEvent.click(save)
    fireEvent.click(save)

    await waitFor(() => expect(mocks.customerServiceAddCustomerAddress).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'modals.addCustomer.cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close caller lookup' }))
    expect(onMinimize).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      rejectAddress?.(new Error('Bearer secret-token user@example.test HTTP 500 customer-lock'))
    })

    expect(await screen.findByText('modals.addCustomer.addressSaveFailed')).toBeInTheDocument()
    expect(screen.queryByText(/secret-token|example\.test|HTTP 500|customer-lock/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'modals.addCustomer.cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung native add-address session and ignores its eventual completion', async () => {
    vi.useFakeTimers()
    let resolveAddress: ((value: unknown) => void) | undefined
    mocks.customerServiceAddCustomerAddress.mockImplementation(() => new Promise(resolve => {
      resolveAddress = resolve
    }))
    const onClose = vi.fn()
    const onCustomerAdded = vi.fn()
    const ActualAddCustomerModal = mocks.actualAddCustomerModal as React.ComponentType<Record<string, any>>

    try {
      render(
        <ActualAddCustomerModal
          isOpen
          mode="addAddress"
          initialCustomer={{ id: 'customer-timeout', name: 'Timeout Customer', phone: '2101234567', addresses: [] }}
          onClose={onClose}
          onCustomerAdded={onCustomerAdded}
        />,
      )
      fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.manualAddressPlaceholder'), {
        target: { value: 'Timeout Street 1' },
      })
      fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.nameOnRingerPlaceholder'), {
        target: { value: 'Bell' },
      })
      fireEvent.change(screen.getByLabelText('modals.addCustomer.floorLabel'), { target: { value: '2' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save Address' }))

      await act(async () => {
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(35_000)
      })
      expect(screen.getByText('modals.addCustomer.addressSaveTimedOut')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'modals.addCustomer.cancel' }))
      expect(onClose).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveAddress?.({ success: true, data: { id: 'late-address' } })
        await Promise.resolve()
      })
      expect(onCustomerAdded).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a late saved-address callback from a replaced Caller ID request session', async () => {
    const firstCustomer = {
      id: 'customer-old',
      name: 'Old Customer',
      phone: '2101111111',
      addresses: [{ id: 'old-address', street_address: 'Old Street 1', is_default: true }],
    }
    const nextCustomer = {
      id: 'customer-new',
      name: 'New Customer',
      phone: '2102222222',
      addresses: [{ id: 'new-address', street_address: 'New Street 2', is_default: true }],
    }
    mocks.posApiGet
      .mockResolvedValueOnce({ success: true, data: { success: true, customer: firstCustomer } })
      .mockResolvedValueOnce({ success: true, data: { success: true, customer: nextCustomer } })
    const commonProps = { onClose: vi.fn() }
    const { rerender } = render(
      <CallerIdCustomerSearchModalHostUnderContract
        {...commonProps}
        request={{ displayPhone: firstCustomer.phone, lookupPhone: firstCustomer.phone, requestKey: 'call-old', onDisplayed: vi.fn() }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }))
    const oldOnCustomerAdded = mocks.addCustomerModalProps.mock.lastCall?.[0].onCustomerAdded

    rerender(
      <CallerIdCustomerSearchModalHostUnderContract
        {...commonProps}
        request={{ displayPhone: nextCustomer.phone, lookupPhone: nextCustomer.phone, requestKey: 'call-new', onDisplayed: vi.fn() }}
      />,
    )
    expect(await screen.findByText('New Customer')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }))

    await act(async () => {
      oldOnCustomerAdded({
        ...firstCustomer,
        selected_address_id: 'old-late-address',
        addresses: [...firstCustomer.addresses, { id: 'old-late-address', street_address: 'Old Late Street' }],
      })
    })

    expect(mocks.addCustomerModalProps.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      mode: 'addAddress',
      initialCustomer: expect.objectContaining({ id: nextCustomer.id }),
    }))
    expect(screen.getByRole('dialog', { name: 'Add customer form' })).toBeInTheDocument()
    expect(screen.queryByText('Old Late Street')).not.toBeInTheDocument()
  })

  it('repeats the lookup for a new call even when the phone number is unchanged', async () => {
    const props = {
      isOpen: true,
      lookupOnly: true as const,
      initialSearchTerm: '2101234567',
      onDisplayed: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(
      <CustomerSearchModal {...props} searchRequestKey="call-1" />,
    )

    await waitFor(() => expect(mocks.posApiGet).toHaveBeenCalledTimes(1))

    rerender(<CustomerSearchModal {...props} searchRequestKey="call-2" />)
    await waitFor(() => expect(mocks.posApiGet).toHaveBeenCalledTimes(2))
    expect(props.onDisplayed).toHaveBeenCalledTimes(2)
  })

  it('reports displayed only after the glass modal has mounted its visible content', () => {
    mocks.renderModalContent = false
    const onDisplayed = vi.fn()
    const props = {
      isOpen: true,
      lookupOnly: true as const,
      initialSearchTerm: '2101234567',
      searchRequestKey: 'call-visible',
      onDisplayed,
      onClose: vi.fn(),
    }

    const { rerender } = render(<CustomerSearchModal {...props} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onDisplayed).not.toHaveBeenCalled()

    mocks.renderModalContent = true
    rerender(<CustomerSearchModal {...props} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onDisplayed).toHaveBeenCalledTimes(1)
  })

  it('renders multiple customer matches as keyboard-operable buttons', async () => {
    mocks.posApiGet.mockResolvedValueOnce({
      success: true,
      data: {
        success: true,
        multiple: true,
        customers: [
          {
            id: 'customer-2',
            name: 'Νίκος Νικολάου',
            phone: '2101234567',
            addresses: [],
          },
        ],
      },
    })

    render(
      <CustomerSearchModal
        isOpen
        lookupOnly
        initialSearchTerm="2101234567"
        searchRequestKey="call-multiple"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', {
      name: /Νίκος Νικολάου.*2101234567/,
    })).toBeInTheDocument()
  })

  it('minimizes to a movable non-modal panel and restores the same lookup state', async () => {
    const onDisplayed = vi.fn()

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: '2101234567',
          lookupPhone: '2101234567',
          requestKey: 'call-minimize',
          onDisplayed,
        }}
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByRole('textbox')).toHaveValue('2101234567')
    await waitFor(() => expect(mocks.posApiGet).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Caller ID')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByRole('textbox')).toHaveValue('2101234567')
    expect(mocks.posApiGet).toHaveBeenCalledTimes(1)
    expect(onDisplayed).toHaveBeenCalledTimes(1)
  })

  it('passes the selected address directly with the Caller ID delivery action', async () => {
    mocks.posApiGet.mockResolvedValue({
      success: true,
      data: {
        success: true,
        customer: {
          id: 'customer-addresses',
          name: 'Address Customer',
          phone: '2101234567',
          addresses: [
            {
              id: 'address-1',
              street_address: 'First Street 1',
              city: 'Athens',
              is_default: true,
            },
            {
              id: 'address-2',
              street_address: 'Second Street 2',
              city: 'Athens',
              is_default: false,
            },
          ],
        },
      },
    })
    const onContinueToOrderType = vi.fn()

    render(
      <CallerIdCustomerSearchModalHostUnderContract
        request={{
          displayPhone: '2101234567',
          lookupPhone: '2101234567',
          requestKey: 'call-address',
          onDisplayed: vi.fn(),
        }}
        onClose={vi.fn()}
        onContinueToOrderType={onContinueToOrderType}
      />,
    )

    const secondAddress = await screen.findByRole('button', { name: /Second Street 2/ })
    fireEvent.click(secondAddress)
    // The pick must be applied (and survive any late customer re-set — the
    // auto-select effect used to stomp it back to the default) before the
    // Delivery action reads it.
    await waitFor(() => {
      expect(secondAddress).toHaveAttribute('aria-pressed', 'true')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }))

    await waitFor(() => {
      expect(onContinueToOrderType).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'customer-addresses',
          address: 'Second Street 2',
          selected_address_id: 'address-2',
        }),
      )
    })
  })

  it('remounts the glass modal for the next queued call after the first closes', async () => {
    const firstDisplayed = vi.fn()
    const secondDisplayed = vi.fn()

    function QueueHarness() {
      const [queue, setQueue] = React.useState([
        {
          displayPhone: '2101111111',
          lookupPhone: '2101111111',
          requestKey: 'call-first',
          onDisplayed: firstDisplayed,
        },
        {
          displayPhone: '2102222222',
          lookupPhone: '2102222222',
          requestKey: 'call-second',
          onDisplayed: secondDisplayed,
        },
      ])

      return (
        <CallerIdCustomerSearchModalHostUnderContract
          request={queue[0] ?? null}
          onClose={() => setQueue((current) => current.slice(1))}
        />
      )
    }

    render(<QueueHarness />)
    expect(await screen.findByRole('textbox')).toHaveValue('2101111111')
    expect(firstDisplayed).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close caller lookup' }))

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('2102222222')
    })
    expect(secondDisplayed).toHaveBeenCalledTimes(1)
  })
})
