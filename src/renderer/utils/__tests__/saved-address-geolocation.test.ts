import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('../../services/address-workflow', async () => {
  const houseNumber = await import('../../services/address-house-number')
  return {
    ...houseNumber,
    createAddressSessionToken: () => 'addr_session_test',
    searchAddressSuggestions: mocks.search,
    resolveAddressSuggestion: mocks.resolve,
  }
})

import {
  SAVED_ADDRESS_GEOLOCATION_BUDGET_MS,
  clearSavedAddressGeolocationMemo,
  extractSavedAddressCoordinates,
  normalizeAreaText,
  persistGeocodedSavedAddressCoordinates,
  resolveSavedAddressCoordinates,
  savedAddressAreaMatches,
  savedAddressIdentityKey,
} from '../saved-address-geolocation'

// Synthetic streets and points; no customer data.
const IN_AREA_POINT = { lat: 40.5836, lng: 22.9502 }
const OTHER_AREA_POINT = { lat: 40.6401, lng: 22.9444 }

const savedAddress = {
  id: 'addr-1',
  street_address: 'Odos Dokimis 12',
  city: 'Kalamaria',
  postal_code: '551 33',
  latitude: null,
  longitude: null,
  version: 4,
}

function suggestion(placeId: string, label: string, secondary: string) {
  return {
    place_id: placeId,
    name: label,
    displayLabel: label,
    main_text: label,
    secondary_text: secondary,
    formatted_address: `${label}, ${secondary}`,
    source: 'online' as const,
  }
}

function details(overrides: Record<string, unknown>) {
  return {
    streetAddress: 'Odos Dokimis 12',
    city: 'Kalamaria',
    postalCode: '551 33',
    coordinates: IN_AREA_POINT,
    placeId: 'place-in-area',
    resolvedStreetNumber: '12',
    addressFingerprint: 'fp',
    validationSource: 'online' as const,
    ...overrides,
  }
}

beforeEach(() => {
  clearSavedAddressGeolocationMemo()
  mocks.search.mockReset()
  mocks.resolve.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extractSavedAddressCoordinates', () => {
  it('returns null for every "no coordinates" spelling (today: {lat:0,lng:0})', () => {
    expect(extractSavedAddressCoordinates({ coordinates: { lat: null, lng: null } } as never)).toBeNull()
    expect(extractSavedAddressCoordinates({ latitude: null, lat: null, longitude: null, lng: null })).toBeNull()
    expect(extractSavedAddressCoordinates({ latitude: 0, longitude: 0 })).toBeNull()
  })

  it('skips "#label" special addresses and reads real points', () => {
    expect(extractSavedAddressCoordinates({ street_address: '#Beach bar', ...IN_AREA_POINT })).toBeNull()
    expect(extractSavedAddressCoordinates({ street_address: 'Odos Dokimis 12', latitude: IN_AREA_POINT.lat, longitude: IN_AREA_POINT.lng }))
      .toEqual(IN_AREA_POINT)
  })
})

describe('normalizeAreaText (same as Android)', () => {
  it('strips accents, folds final sigma and keeps words and digits', () => {
    expect(normalizeAreaText('Καλαμαριάς')).toBe('καλαμαριασ')
    expect(normalizeAreaText('  Θεσσαλονίκη, 546 21 ')).toBe('θεσσαλονικη 546 21')
  })
})

describe('savedAddressAreaMatches (founder rule: municipality or postal code)', () => {
  it('accepts an equal postal code even when the municipality is spelled differently', () => {
    expect(savedAddressAreaMatches({ city: 'Thessaloniki', postal_code: '55133' }, { city: 'Kalamaria', postalCode: '551 33' })).toBe(true)
  })

  it('accepts an equal municipality when a postal code is missing on either side', () => {
    expect(savedAddressAreaMatches({ city: 'Καλαμαριά' }, { city: 'ΚΑΛΑΜΑΡΙΑ', postalCode: '55133' })).toBe(true)
    expect(savedAddressAreaMatches({ city: 'Kalamaria', postal_code: '55133' }, { city: 'kalamaria', postalCode: '' })).toBe(true)
  })

  it('tolerates "Δήμος …" and the genitive, and compares every area name of the place', () => {
    expect(savedAddressAreaMatches({ city: 'Καλαμαριά' }, { city: 'Δήμος Καλαμαριάς', postalCode: '' })).toBe(true)
    expect(savedAddressAreaMatches({ city: 'Kalamaria' }, { city: 'Thessaloniki', postalCode: '', areaNames: ['Thessaloniki', 'Kalamaria'] })).toBe(true)
  })

  it('rejects another area, and never guesses without an area on the saved address', () => {
    expect(savedAddressAreaMatches({ city: 'Kalamaria', postal_code: '55133' }, { city: 'Kalamaria', postalCode: '54630' })).toBe(false)
    expect(savedAddressAreaMatches({ city: 'Kalamaria' }, { city: 'Thessaloniki', postalCode: '54630' })).toBe(false)
    expect(savedAddressAreaMatches({}, { city: 'Kalamaria', postalCode: '55133' })).toBe(false)
  })
})

describe('resolveSavedAddressCoordinates', () => {
  it('returns a saved point without searching', async () => {
    const result = await resolveSavedAddressCoordinates({ ...savedAddress, latitude: IN_AREA_POINT.lat, longitude: IN_AREA_POINT.lng })

    expect(result).toEqual({ coordinates: IN_AREA_POINT, source: 'saved' })
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it('geocodes an address without coordinates and accepts a match in its area', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria 551 33')])
    mocks.resolve.mockResolvedValue(details({}))

    const result = await resolveSavedAddressCoordinates(savedAddress, 'branch-1')

    expect(mocks.search).toHaveBeenCalledWith('Odos Dokimis 12, Kalamaria, 551 33', expect.objectContaining({ branchId: 'branch-1' }))
    expect(result).toMatchObject({ coordinates: IN_AREA_POINT, source: 'geocoded', placeId: 'place-in-area' })
  })

  it('rejects the same street in another municipality (the old street-only rule accepted it)', async () => {
    mocks.search.mockResolvedValue([suggestion('place-other-area', 'Odos Dokimis 12', 'Thessaloniki 546 30')])
    mocks.resolve.mockResolvedValue(details({ city: 'Thessaloniki', postalCode: '546 30', coordinates: OTHER_AREA_POINT }))

    await expect(resolveSavedAddressCoordinates(savedAddress, 'branch-1')).resolves.toBeNull()
  })

  it('looks up a suggestion that names the saved area first', async () => {
    mocks.search.mockResolvedValue([
      suggestion('place-other-area', 'Odos Dokimis 12', 'Thessaloniki'),
      suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria'),
    ])
    mocks.resolve.mockImplementation(async (candidate: { place_id: string }) => (
      candidate.place_id === 'place-in-area'
        ? details({})
        : details({ city: 'Thessaloniki', postalCode: '546 30', coordinates: OTHER_AREA_POINT })
    ))

    const result = await resolveSavedAddressCoordinates(savedAddress)

    expect(result?.coordinates).toEqual(IN_AREA_POINT)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('tries the next suggestion when the best-ranked one is in another area', async () => {
    // Neither names the area; the first carries the house number, so it ranks first.
    mocks.search.mockResolvedValue([
      suggestion('place-other-area', 'Odos Dokimis 12', 'Greece'),
      suggestion('place-in-area', 'Odos Dokimis', 'Greece'),
    ])
    mocks.resolve.mockImplementation(async (candidate: { place_id: string }) => (
      candidate.place_id === 'place-in-area'
        ? details({})
        : details({ city: 'Thessaloniki', postalCode: '546 30', coordinates: OTHER_AREA_POINT })
    ))

    const result = await resolveSavedAddressCoordinates(savedAddress)

    expect(result?.coordinates).toEqual(IN_AREA_POINT)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('requires the saved house number to be confirmed', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Odos Dokimis', 'Kalamaria 551 33')])
    mocks.resolve.mockResolvedValue(details({ resolvedStreetNumber: undefined, streetAddress: 'Odos Dokimis' }))
    await expect(resolveSavedAddressCoordinates(savedAddress)).resolves.toBeNull()

    clearSavedAddressGeolocationMemo()
    mocks.resolve.mockResolvedValue(details({ resolvedStreetNumber: '14', streetAddress: 'Odos Dokimis 14' }))
    await expect(resolveSavedAddressCoordinates(savedAddress)).resolves.toBeNull()
  })

  it('never accepts a (0,0) point from the lookup', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria 551 33')])
    mocks.resolve.mockResolvedValue(details({ coordinates: { lat: 0, lng: 0 } }))

    await expect(resolveSavedAddressCoordinates(savedAddress)).resolves.toBeNull()
  })

  it('does not search for an address with neither municipality nor postal code, nor for "#label"', async () => {
    await expect(resolveSavedAddressCoordinates({ street_address: 'Odos Dokimis 12' })).resolves.toBeNull()
    await expect(resolveSavedAddressCoordinates({ street_address: '#Beach bar', city: 'Kalamaria' })).resolves.toBeNull()
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it('searches once for concurrent and repeated requests of the same address', async () => {
    let release: (value: unknown) => void = () => undefined
    mocks.search.mockImplementation(() => new Promise((resolve) => {
      release = resolve
    }))
    mocks.resolve.mockResolvedValue(details({}))

    const first = resolveSavedAddressCoordinates(savedAddress, 'branch-1')
    const second = resolveSavedAddressCoordinates({ ...savedAddress }, 'branch-1')
    release([suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria 551 33')])
    const [a, b] = await Promise.all([first, second])
    const c = await resolveSavedAddressCoordinates({ ...savedAddress }, 'branch-1')

    expect(a?.coordinates).toEqual(IN_AREA_POINT)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(mocks.search).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSavedAddressCoordinates: time budget and memo scope', () => {
  it('answers "not located" after the time budget while a lookup hangs, and remembers a late answer', async () => {
    vi.useFakeTimers()
    try {
      let release: (value: unknown) => void = () => undefined
      mocks.search.mockImplementation(() => new Promise((resolve) => {
        release = resolve
      }))
      mocks.resolve.mockResolvedValue(details({}))

      const pending = resolveSavedAddressCoordinates(savedAddress, 'branch-1')
      await vi.advanceTimersByTimeAsync(SAVED_ADDRESS_GEOLOCATION_BUDGET_MS)
      await expect(pending).resolves.toBeNull()

      // The API answers after the budget: the point is kept for the next order.
      release([suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria 551 33')])
      await vi.runAllTimersAsync()
      const next = await resolveSavedAddressCoordinates({ ...savedAddress }, 'branch-1')
      expect(next?.coordinates).toEqual(IN_AREA_POINT)
      expect(mocks.search).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never remembers a verdict without a branch (it could answer for another store)', async () => {
    mocks.search.mockResolvedValue([suggestion('place-in-area', 'Odos Dokimis 12', 'Kalamaria 551 33')])
    mocks.resolve.mockResolvedValue(details({}))

    await resolveSavedAddressCoordinates(savedAddress)
    await resolveSavedAddressCoordinates({ ...savedAddress })

    expect(mocks.search).toHaveBeenCalledTimes(2)
  })
})

describe('persistGeocodedSavedAddressCoordinates', () => {
  it('writes back only a geocoded point, never a saved one or a legacy placeholder', async () => {
    const updateAddress = vi.fn(async () => ({ success: true }))
    const geocoded = { coordinates: IN_AREA_POINT, source: 'geocoded' as const }

    await expect(persistGeocodedSavedAddressCoordinates({
      address: savedAddress, customerId: 'cust-1', resolved: geocoded, isLegacyFallback: false, updateAddress,
    })).resolves.toBe(true)
    expect(updateAddress).toHaveBeenCalledWith(
      'addr-1',
      { customer_id: 'cust-1', coordinates: IN_AREA_POINT, latitude: IN_AREA_POINT.lat, longitude: IN_AREA_POINT.lng },
      4,
    )

    updateAddress.mockClear()
    await persistGeocodedSavedAddressCoordinates({
      address: savedAddress, customerId: 'cust-1', resolved: { ...geocoded, source: 'saved' }, isLegacyFallback: false, updateAddress,
    })
    await persistGeocodedSavedAddressCoordinates({
      address: { ...savedAddress, id: 'legacy:cust-1' }, customerId: 'cust-1', resolved: geocoded, isLegacyFallback: true, updateAddress,
    })
    expect(updateAddress).not.toHaveBeenCalled()
  })

  // Review finding (2026-09-29): the write-back carries coordinates only. On
  // every deferred Rust path (offline, 5xx, a write folded into a queued
  // insert) it replaced the cached address and dropped its street; for a
  // local placeholder id Rust POSTs it as a new street-less default address.
  it('never writes back for a local placeholder id, a point from the offline cache, or while offline', async () => {
    const updateAddress = vi.fn(async () => ({ success: true }))
    const geocoded = { coordinates: IN_AREA_POINT, source: 'geocoded' as const, validationSource: 'online' as const }

    for (const id of ['local-7f3c', 'LOCAL-abc', 'legacy:cust-1']) {
      await expect(persistGeocodedSavedAddressCoordinates({
        address: { ...savedAddress, id }, customerId: 'cust-1', resolved: geocoded, isLegacyFallback: false, updateAddress,
      })).resolves.toBe(false)
    }

    await expect(persistGeocodedSavedAddressCoordinates({
      address: savedAddress,
      customerId: 'cust-1',
      resolved: { ...geocoded, validationSource: 'offline_cache' },
      isLegacyFallback: false,
      updateAddress,
    })).resolves.toBe(false)

    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      await expect(persistGeocodedSavedAddressCoordinates({
        address: savedAddress, customerId: 'cust-1', resolved: geocoded, isLegacyFallback: false, updateAddress,
      })).resolves.toBe(false)
    } finally {
      onLine.mockRestore()
    }

    expect(updateAddress).not.toHaveBeenCalled()
  })
})

describe('savedAddressIdentityKey', () => {
  it('ignores object identity and non-zone fields, follows street/area/point', () => {
    const key = savedAddressIdentityKey(savedAddress)
    expect(savedAddressIdentityKey({ ...savedAddress, floor_number: '3' } as never)).toBe(key)
    expect(savedAddressIdentityKey({ ...savedAddress, latitude: IN_AREA_POINT.lat, longitude: IN_AREA_POINT.lng })).not.toBe(key)
    expect(savedAddressIdentityKey({ ...savedAddress, street_address: 'Odos Dokimis 14' })).not.toBe(key)
  })
})
