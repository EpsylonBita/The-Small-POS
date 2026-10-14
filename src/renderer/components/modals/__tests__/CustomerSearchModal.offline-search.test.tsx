/**
 * Desktop customer search while the server cannot be reached (offline
 * customer search, 13/10/2026). The modal found a customer offline only for a
 * query typed exactly as one answered online (the saved response of that
 * URL); any other name or number said "Error searching for customer". It now
 * searches the customers this till holds, by name or phone, without a request.
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  lookupByPhone: vi.fn(),
  search: vi.fn(),
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
      lookupByPhone: mocks.lookupByPhone,
      search: mocks.search,
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

const savedMaria = {
  id: 'customer-saved-1',
  name: 'Μαρία Παπαδοπούλου',
  phone: '+30 694 812 8474',
  addresses: [],
}
const savedNikos = {
  id: 'customer-saved-2',
  name: 'Νίκος Παπαδάκης',
  phone: '6948000000',
  addresses: [],
}

describe('CustomerSearchModal offline search', () => {
  beforeEach(() => {
    mocks.renderModalContent = true
    mocks.lookupByPhone.mockReset()
    mocks.lookupByPhone.mockResolvedValue(null)
    mocks.search.mockReset()
    mocks.search.mockResolvedValue([])
    mocks.posApiGet.mockReset()
    mocks.getBranchId.mockResolvedValue(null)
    mocks.getResolvedTerminalCredentials.mockResolvedValue({
      apiKey: 'terminal-api-key',
      terminalId: 'terminal-1',
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('finds a customer saved on this till by name when the server cannot be reached', async () => {
    mocks.posApiGet.mockRejectedValue(new Error('Failed to fetch'))
    mocks.search.mockResolvedValue([savedMaria])

    render(
      <CustomerSearchModal isOpen lookupOnly initialSearchTerm="Παπαδοπ" searchRequestKey="offline-name" onClose={vi.fn()} />,
    )

    expect(await screen.findByText('Μαρία Παπαδοπούλου')).toBeInTheDocument()
    expect(mocks.search).toHaveBeenCalledWith('Παπαδοπ', { cacheOnly: true })
    expect(screen.getByTestId('customer-search-saved-results'))
      .toHaveTextContent('modals.customerSearch.offlineSavedResults')
    expect(screen.queryByText('modals.customerSearch.searchError')).not.toBeInTheDocument()
  })

  it('lists every saved match of a partial number, also when the credentials cannot be read offline', async () => {
    mocks.getResolvedTerminalCredentials.mockRejectedValue(new Error('offline'))
    mocks.search.mockResolvedValue([savedMaria, savedNikos])

    render(
      <CustomerSearchModal isOpen lookupOnly initialSearchTerm="6948" searchRequestKey="offline-phone" onClose={vi.fn()} />,
    )

    expect(await screen.findByText('Νίκος Παπαδάκης')).toBeInTheDocument()
    expect(screen.getByText('Μαρία Παπαδοπούλου')).toBeInTheDocument()
    expect(mocks.search).toHaveBeenCalledWith('6948', { cacheOnly: true })
  })

  it('still says the search failed when nothing is saved for the query', async () => {
    mocks.posApiGet.mockResolvedValue({ success: false, status: 503, error: 'Service unavailable' })

    render(
      <CustomerSearchModal isOpen lookupOnly initialSearchTerm="Unknown" searchRequestKey="offline-miss" onClose={vi.fn()} />,
    )

    expect(await screen.findByText('modals.customerSearch.searchError')).toBeInTheDocument()
    expect(mocks.search).toHaveBeenCalledWith('Unknown', { cacheOnly: true })
    expect(screen.queryByTestId('customer-search-saved-results')).not.toBeInTheDocument()
  })

  it('trusts the server when it answers: no saved copy for a customer it does not know', async () => {
    mocks.posApiGet.mockResolvedValue({ success: true, data: { success: false } })
    mocks.search.mockResolvedValue([savedMaria])

    render(
      <CustomerSearchModal isOpen lookupOnly initialSearchTerm="Παπαδοπ" searchRequestKey="online-miss" onClose={vi.fn()} />,
    )

    expect(await screen.findByText('Customer not found')).toBeInTheDocument()
    expect(mocks.search).not.toHaveBeenCalled()
  })
})
