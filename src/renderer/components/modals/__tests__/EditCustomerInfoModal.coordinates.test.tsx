import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  validateAddressForDelivery: vi.fn(),
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
    getSuggestionStreetLabel: () => '',
    resolveAddressSuggestion: vi.fn(),
    searchAddressSuggestions: vi.fn(async () => []),
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

    const [, options] = mocks.validateAddressForDelivery.mock.calls[0]
    expect(options.coordinates).toBeUndefined()
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
    expect(mocks.validateAddressForDelivery.mock.calls[0][1].coordinates).toEqual(point)
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ coordinates: point }))
  })
})
