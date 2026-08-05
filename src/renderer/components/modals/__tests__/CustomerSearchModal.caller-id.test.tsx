import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  posApiDelete: vi.fn(),
  getResolvedTerminalCredentials: vi.fn(),
  deleteAddress: vi.fn(),
  addCustomerModalProps: vi.fn(),
  renderModalContent: true,
  translate: vi.fn((key: string, fallback?: string | Record<string, unknown>) => {
    if (key === 'modals.customerSearch.addNewCustomer') return 'Add customer'
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
    customers: { deleteAddress: mocks.deleteAddress },
  }),
}))

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}))

vi.mock('../../../hooks/useAcquiredModules', () => ({
  useAcquiredModules: () => ({
    hasDeliveryModule: true,
    hasTablesModule: true,
    hasRoomsModule: false,
    hasAppointmentsModule: false,
    hasServiceCatalogModule: false,
  }),
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
    const [mounted, setMounted] = React.useState(false)

    React.useEffect(() => {
      if (isOpen) setMounted(true)
      else setMounted(false)
    }, [isOpen])

    if (!mounted || !mocks.renderModalContent) return null

    return (
      <div role="dialog" aria-label={ariaLabel || title}>
        <button
          type="button"
          aria-label="Close caller lookup"
          onClick={() => {
            setMounted(false)
            onClose()
          }}
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

vi.mock('../AddCustomerModal', () => ({
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
}))

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

    fireEvent.click(await screen.findByRole('button', { name: /Second Street 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }))

    expect(onContinueToOrderType).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'customer-addresses',
        address: 'Second Street 2',
        selected_address_id: 'address-2',
      }),
    )
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
