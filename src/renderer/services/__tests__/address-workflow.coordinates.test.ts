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
  formatAddressDistance,
  locateTypedAddress,
  selectPrimaryOnlineSuggestions,
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


describe('corrected typed address contract', () => {
  it.each(['el', 'en'])('formats distances with Intl units in %s', (language) => {
    expect(formatAddressDistance(83, language)).toBe(new Intl.NumberFormat(language, {
      style: 'unit', unit: 'meter', unitDisplay: 'short', maximumFractionDigits: 0,
    }).format(80))
    expect(formatAddressDistance(1140, language)).toBe(new Intl.NumberFormat(language, {
      style: 'unit', unit: 'kilometer', unitDisplay: 'short', minimumFractionDigits: 1, maximumFractionDigits: 1,
    }).format(1.14))
    expect(formatAddressDistance(undefined, language)).toBe('')
    expect(formatAddressDistance(-1, language)).toBe('')
  })

  it.each(['predictions', 'places'])('keeps distance on %s', (key) => {
    expect(selectPrimaryOnlineSuggestions({ [key]: [{ place_id: 'a', description: 'Street 62', distance_meters: 1140 }] })[0])
      .toMatchObject({ distance_meters: 1140 })
  })

  it('locates typed fields with no place id, preserves the typed street fingerprint and provider note', async () => {
    mocks.posApiPost.mockResolvedValue({ success: true, data: { success: true, located: true,
      postal_code_differs: true, provider_postal_code: '54249', result: {
        place_id: 'typed-place', geometry: { location: POINT }, formatted_address: 'Provider Street 62',
        address_components: [{ types: ['street_number'], long_name: '62' }],
      } } })
    const result = await locateTypedAddress({ street: 'Street 62', city: 'City', postalCode: '546 40' }, { branchId: 'branch-1' })
    expect(mocks.posApiPost).toHaveBeenCalledWith('pos/address/details', expect.objectContaining({
      typed_address: { street: 'Street 62', city: 'City', postal_code: '546 40' },
    }))
    expect(mocks.posApiPost.mock.calls[0][1]).not.toHaveProperty('place_id')
    expect(mocks.posApiPost.mock.calls[0][1]).not.toHaveProperty('location')
    expect(result).toMatchObject({ located: true, postalCodeDiffers: true, providerPostalCode: '54249',
      details: { coordinates: POINT, placeId: 'typed-place', streetAddress: 'Street 62',
        addressFingerprint: 'street 62|40.58360|22.95020', validationSource: 'online' } })
  })

  it.each([
    { success: false, status: 400 },
    { success: true, data: { success: true, located: false, reason: 'imprecise' } },
    { success: true, data: { success: true, located: true, result: { geometry: { location: { lat: 0, lng: 0 } } } } },
  ])('treats an old server, imprecise result or unusable point as not located', async (response) => {
    mocks.posApiPost.mockResolvedValue(response)
    expect(await locateTypedAddress({ street: 'Street 62' }, {})).toMatchObject({ located: false })
  })

  it('does not request a street without a number, special address or an offline address', async () => {
    expect(await locateTypedAddress({ street: 'Street' }, {})).toMatchObject({ located: false })
    expect(await locateTypedAddress({ street: '#Hotel Room 62' }, {})).toMatchObject({ located: false, reason: 'custom_address' })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await locateTypedAddress({ street: 'Street 62' }, {})).toMatchObject({ located: false })
    expect(mocks.posApiPost).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})


it('keeps the server nearest-first ranking even when formatted text would score differently', async () => {
  mocks.posApiPost.mockResolvedValue({ success: true, data: { predictions: [
    { place_id: 'near', description: 'Street 62, City', main_text: 'Street 62', distance_meters: 80 },
    { place_id: 'far', description: 'Street 62 City', main_text: 'Street 62', distance_meters: 1140 },
  ] } })
  expect((await searchAddressSuggestions('Street 62 City')).map(suggestion => suggestion.place_id)).toEqual(['near', 'far'])
})

it('keeps optional distance on verified local cache rows', async () => {
  mocks.posApiPost.mockResolvedValue({ success: false })
  mocks.searchLocal.mockResolvedValue({ places: [{ place_id: 'saved', name: 'Street 62', verified: true, distance_meters: 80 }] })
  expect((await searchAddressSuggestions('Street 62'))[0]).toMatchObject({ distance_meters: 80 })
})

it('silently treats a transport failure as not located', async () => {
  mocks.posApiPost.mockRejectedValue(new Error('HTTP 400'))
  expect(await locateTypedAddress({ street: 'Street 62' })).toMatchObject({ located: false })
})


it('retains existing relevance sorting when an old server supplies no distances', async () => {
  mocks.posApiPost.mockResolvedValue({ success: true, data: { predictions: [
    { place_id: 'other', description: 'Other Street 62', main_text: 'Other Street 62' },
    { place_id: 'match', description: 'Street 62', main_text: 'Street 62' },
  ] } })
  expect((await searchAddressSuggestions('Street 62')).map(suggestion => suggestion.place_id)).toEqual(['match', 'other'])
})
