import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  posApiPost: vi.fn(),
  searchLocal: vi.fn(),
  validateLocal: vi.fn(),
}))

vi.mock('../../utils/api-helpers', () => ({
  posApiPost: mocks.posApiPost,
}))

vi.mock('../terminal-credentials', () => ({
  getResolvedTerminalCredentials: vi.fn(async () => ({ branchId: 'branch-1' })),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    address: { searchLocal: mocks.searchLocal, upsertLocalCandidate: vi.fn(async () => null) },
    deliveryZones: { cacheRefresh: vi.fn(async () => null), validateLocal: mocks.validateLocal },
  }),
  onEvent: vi.fn(),
}))

import {
  buildResolvedAddressDetails,
  resolveAddressSuggestion,
  searchAddressSuggestions,
  validateAddressForDelivery,
} from '../address-workflow'

// Synthetic data only.
const POINT = { lat: 40.5836, lng: 22.9502 }

beforeEach(() => {
  mocks.posApiPost.mockReset()
  mocks.searchLocal.mockReset()
  mocks.validateLocal.mockReset()
})

describe('address search: cached addresses without coordinates are not located at (0,0)', () => {
  it('drops the (0,0) location the offline customer cache gives an address without coordinates', async () => {
    mocks.posApiPost.mockResolvedValue({ success: false })
    mocks.searchLocal.mockResolvedValue({
      places: [
        {
          place_id: 'local-address-1',
          name: 'Odos Dokimis 12',
          formatted_address: 'Odos Dokimis 12, Kalamaria, 55133',
          city: 'Kalamaria',
          postal_code: '55133',
          location: { lat: 0, lng: 0 },
          verified: true,
        },
      ],
    })

    const [suggestion] = await searchAddressSuggestions('Odos Dokimis 12', { branchId: 'branch-1' })
    expect(suggestion.location).toBeUndefined()

    const resolved = await resolveAddressSuggestion(suggestion, 'Odos Dokimis 12')
    expect(resolved.coordinates).toBeUndefined()
    expect(resolved.city).toBe('Kalamaria')
  })

  it('keeps a real offline point', async () => {
    mocks.posApiPost.mockResolvedValue({ success: false })
    mocks.searchLocal.mockResolvedValue({
      places: [{ place_id: 'local-2', name: 'Odos Dokimis 12', formatted_address: 'Odos Dokimis 12', location: POINT, verified: true }],
    })

    const [suggestion] = await searchAddressSuggestions('Odos Dokimis 12', { branchId: 'branch-1' })
    expect(suggestion.location).toEqual(POINT)
  })

  it('never takes a (0,0) geometry from place details', () => {
    const details = buildResolvedAddressDetails(
      { place_id: 'p', name: 'Odos Dokimis 12', formatted_address: 'Odos Dokimis 12', source: 'online' },
      { geometry: { location: { lat: 0, lng: 0 } }, address_components: [] },
    )
    expect(details.coordinates).toBeUndefined()
  })
})

describe('validateAddressForDelivery', () => {
  it('never sends a (0,0) point and opts in to the unchecked-zone contract', async () => {
    mocks.posApiPost.mockResolvedValue({
      success: true,
      data: { success: true, isValid: false, validation_status: 'requires_selection', suggestedAction: 'geocode_first' },
    })

    await validateAddressForDelivery('Odos Dokimis 12', { coordinates: { lat: 0, lng: 0 } })

    const [endpoint, payload] = mocks.posApiPost.mock.calls[0]
    expect(endpoint).toBe('pos/delivery-zones/validate')
    expect(payload.coordinates).toBeUndefined()
    expect(payload.zone_validation_contract).toBe(2)
  })

  it('reads a legacy out_of_zone answer tagged zone_checked:false as "select the address", never out of zone', async () => {
    mocks.posApiPost.mockResolvedValue({
      success: true,
      data: {
        success: true,
        isValid: false,
        validation_status: 'out_of_zone',
        requires_override: true,
        reason_code: 'coordinates_missing',
        zone_checked: false,
        coordinates: null,
      },
    })

    const result = await validateAddressForDelivery('Odos Dokimis 12', { coordinates: POINT })

    expect(result.validation_status).toBe('requires_selection')
    expect(result.requires_override).toBe(false)
    expect(result.coordinates).toBeUndefined()
  })

  it('keeps a real out-of-zone answer as out of zone (override flow unchanged)', async () => {
    mocks.posApiPost.mockResolvedValue({
      success: true,
      data: { success: true, isValid: false, validation_status: 'out_of_zone', requires_override: true, zone_checked: true, coordinates: POINT },
    })

    const result = await validateAddressForDelivery('Odos Dokimis 12', { coordinates: POINT })

    expect(result.validation_status).toBe('out_of_zone')
    expect(result.requires_override).toBe(true)
    expect(result.coordinates).toEqual(POINT)
  })
})
