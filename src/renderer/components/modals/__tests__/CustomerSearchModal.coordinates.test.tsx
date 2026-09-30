import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/api-helpers', () => ({
  posApiGet: vi.fn(),
  posApiDelete: vi.fn(),
}))

vi.mock('../../../services/terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn(async () => ({})),
}))

vi.mock('../../../../lib', () => ({
  getBridge: () => ({}),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
}))

import { normalizeCustomerAddress, toCustomerRecord } from '../CustomerSearchModal'

// Synthetic data only.
const POINT = { lat: 40.5836, lng: 22.9502 }

const apiCustomer = {
  id: 'cust-1',
  phone: '6948128474',
  name: 'Test Customer',
  address: 'Odos Dokimis 12',
  latitude: null,
  longitude: null,
  addresses: [
    {
      id: 'addr-1',
      street_address: 'Odos Dokimis 12',
      city: 'Kalamaria',
      postal_code: '55133',
      latitude: null,
      longitude: null,
      is_default: true,
    },
  ],
}

describe('CustomerSearchModal customer mapping (Null Island regression)', () => {
  it('keeps an address with null latitude/longitude without coordinates (today: {lat:0,lng:0})', () => {
    const address = normalizeCustomerAddress(apiCustomer.addresses[0])

    expect(address.coordinates).toBeUndefined()
    expect(address.latitude).toBeNull()
    expect(address.longitude).toBeNull()
  })

  it('hands the address editor a customer without a (0,0) point', () => {
    const record = toCustomerRecord(apiCustomer)

    expect(record.coordinates).toBeUndefined()
    expect(record.latitude).toBeNull()
    expect(record.addresses?.[0].coordinates).toBeUndefined()
    expect(record.addresses?.[0].latitude).toBeNull()
  })

  it('keeps a real point, from a flat pair or a GeoJSON value', () => {
    expect(normalizeCustomerAddress({ ...apiCustomer.addresses[0], latitude: POINT.lat, longitude: POINT.lng }).coordinates)
      .toEqual(POINT)
    expect(normalizeCustomerAddress({
      ...apiCustomer.addresses[0],
      coordinates: { type: 'Point', coordinates: [POINT.lng, POINT.lat] },
    }).coordinates).toEqual(POINT)
    expect(normalizeCustomerAddress({ ...apiCustomer.addresses[0], latitude: 0, longitude: 0 }).coordinates)
      .toBeUndefined()
  })
})
