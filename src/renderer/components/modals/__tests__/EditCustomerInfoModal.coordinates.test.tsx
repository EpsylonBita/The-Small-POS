import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  validateAddressForDelivery: vi.fn(),
  resolveAddressSuggestion: vi.fn(),
  searchAddressSuggestions: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  const translation = {
    t: (key: string, fallback?: string | { defaultValue?: string }) => (
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key
    ),
  }
  return { ...actual, useTranslation: () => translation }
})

vi.mock('../../../services/address-workflow', async () => {
  const houseNumber = await import('../../../services/address-house-number')
  return {
    ...houseNumber,
    buildAddressFingerprint: (address: string, coordinates?: { lat: number; lng: number }) =>
      coordinates ? `${address}|${coordinates.lat}|${coordinates.lng}` : address,
    createAddressSessionToken: () => 'addr_session_test',
    ensureAddressOfflineRuntime: vi.fn(async () => undefined),
    getSuggestionStreetLabel: () => 'Suggested street',
    resolveAddressSuggestion: mocks.resolveAddressSuggestion,
    searchAddressSuggestions: mocks.searchAddressSuggestions,
    upsertVerifiedLocalCandidate: vi.fn(),
    validateAddressForDelivery: mocks.validateAddressForDelivery,
  }
})

vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn(async () => ({ branchId: 'branch-1' })),
}))

vi.mock('../../../hooks/useAcquiredModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useAcquiredModules')>()
  const value = { hasModule: () => true }
  return { ...actual, useAcquiredModules: () => value }
})

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children, footer }: any) => (isOpen ? <div role="dialog">{children}{footer}</div> : null),
}))

import { EditCustomerInfoModal } from '../EditCustomerInfoModal'

// Synthetic data only.
const baseInfo = {
  name: 'Test Customer',
  phone: '6948128474',
  address: 'Odos Dokimis 12',
  postal_code: '55133',
  delivery_floor: '2',
  name_on_ringer: 'Test',
}

beforeEach(() => {
  mocks.validateAddressForDelivery.mockReset()
  mocks.resolveAddressSuggestion.mockReset()
  mocks.searchAddressSuggestions.mockReset().mockResolvedValue([])
  mocks.validateAddressForDelivery.mockResolvedValue({
    success: true,
    isValid: true,
    deliveryAvailable: true,
    validation_status: 'in_zone',
    requires_override: false,
    house_number_match: true,
  })
})

afterEach(cleanup)

describe('EditCustomerInfoModal order coordinates', () => {
  it.each([
    ['delivery_latitude null (dashboard orders)', { coordinates: undefined, latitude: null, longitude: null }],
    ['a stray (0,0) object', { coordinates: { lat: 0, lng: 0 }, latitude: null, longitude: null }],
    ['a stray (0,0) pair', { coordinates: undefined, latitude: 0, longitude: 0 }],
  ])('opens without a point for %s and never checks or saves (0,0)', async (_label, coordinates) => {
    const onSave = vi.fn(async () => undefined)
    render(
      <EditCustomerInfoModal
        isOpen
        orderCount={1}
        initialCustomerInfo={{ ...baseInfo, ...coordinates }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ coordinates: null, latitude: null, longitude: null }))
  })

  it('keeps a real order point', async () => {
    const point = { lat: 40.5836, lng: 22.9502 }
    const onSave = vi.fn(async () => undefined)
    render(
      <EditCustomerInfoModal
        isOpen
        orderCount={1}
        initialCustomerInfo={{ ...baseInfo, coordinates: point, latitude: point.lat, longitude: point.lng }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ coordinates: point }))
  })

  it('saves only the floor of an unchanged legacy destination without requiring a geocoder point', async () => {
    mocks.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: false, deliveryAvailable: false,
      validation_status: 'requires_selection', message: 'Coordinates required' })
    const onSave = vi.fn(async () => undefined)
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={{ ...baseInfo, orderType: 'delivery',
      addressId: 'saved-address', addressFingerprint: 'original-fingerprint', delivery_floor: '', latitude: null, longitude: null }}
      onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.floorPlaceholder'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ address: baseInfo.address, postal_code: baseInfo.postal_code,
      addressId: 'saved-address', addressFingerprint: 'original-fingerprint', delivery_floor: '2', coordinates: null }))
  })

  it.each(['address', 'postal'])('requires fresh validation for a changed %s, without borrowing the old point', async field => {
    mocks.validateAddressForDelivery.mockResolvedValue({ success: true, isValid: false, deliveryAvailable: false, validation_status: 'requires_selection' })
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={{ ...baseInfo, coordinates: { lat: 40.6, lng: 22.9 } }} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(field === 'address' ? 'modals.editCustomer.addressPlaceholder' : 'modals.editCustomer.postalCodePlaceholder'), { target: { value: field === 'address' ? 'Other street 50' : '54321' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1))
    expect(mocks.validateAddressForDelivery.mock.calls[0][1].coordinates).toBeUndefined()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('discards a delayed validation result after the destination changes during Save', async () => {
    let finish!: (value: any) => void
    mocks.validateAddressForDelivery.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(mocks.validateAddressForDelivery).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Latest 30' } })
    await act(async () => { finish({ success: true, validation_status: 'in_zone', coordinates: { lat: 40.6, lng: 22.9 } }) })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Latest 30')
  })

  it('ignores delayed suggestion resolution after editing another destination', async () => {
    mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'place-1' }])
    let finish!: (value: any) => void
    mocks.resolveAddressSuggestion.mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(await screen.findByText('Suggested street'))
    await waitFor(() => expect(mocks.resolveAddressSuggestion).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Latest 30' } })
    await act(async () => { finish({ streetAddress: 'Old resolved 20', coordinates: { lat: 40.6, lng: 22.9 } }) })
    expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Latest 30')
    expect(mocks.validateAddressForDelivery).not.toHaveBeenCalled()
  })

  it('retains a current address selection when only the floor changes during resolution', async () => {
    mocks.searchAddressSuggestions.mockResolvedValue([{ place_id: 'place-1' }])
    let finish!: (value: any) => void
    mocks.resolveAddressSuggestion.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const onSave = vi.fn()
    render(<EditCustomerInfoModal isOpen orderCount={1} initialCustomerInfo={baseInfo} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder'), { target: { value: 'Changed 20' } })
    fireEvent.click(await screen.findByText('Suggested street'))
    await waitFor(() => expect(mocks.resolveAddressSuggestion).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByPlaceholderText('modals.addCustomer.floorPlaceholder'), { target: { value: '5' } })
    await act(async () => { finish({ streetAddress: 'Resolved 20', postalCode: '54321', coordinates: { lat: 40.6, lng: 22.9 } }) })
    await waitFor(() => expect(screen.getByPlaceholderText('modals.editCustomer.addressPlaceholder')).toHaveValue('Resolved 20'))
    expect(screen.queryByText('modals.addCustomer.validatingAddress')).toBeNull()
    fireEvent.click(screen.getByText('modals.editCustomer.saveChanges'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ address: 'Resolved 20', delivery_floor: '5', coordinates: { lat: 40.6, lng: 22.9 } }))
  })
})
