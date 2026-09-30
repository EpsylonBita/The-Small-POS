import { describe, expect, it } from 'vitest'

import { SAVED_ADDRESS_COORDINATE_PARITY_CASES } from '../../../../../shared/utils/saved-address-coordinates.parity-cases'
import { readSavedAddressPoint, toValidLatLng } from '../coordinates'

// Synthetic point (Thessaloniki city centre), never a customer's address.
const POINT = { lat: 40.6401, lng: 22.9444 }

describe('desktop coordinate reader (shared strict rule)', () => {
  it.each(SAVED_ADDRESS_COORDINATE_PARITY_CASES.map((testCase) => [testCase.name, testCase] as const))(
    'matches the shared parity table: %s',
    (_name, testCase) => {
      expect(readSavedAddressPoint(testCase.address)).toEqual(testCase.expected)
    },
  )

  it('never turns a missing value into 0 (Number(null) === 0 regression)', () => {
    expect(toValidLatLng(null, null, null)).toBeNull()
    expect(toValidLatLng(undefined, undefined, undefined)).toBeNull()
    expect(toValidLatLng(undefined, '', '')).toBeNull()
    expect(toValidLatLng({ lat: null, lng: null })).toBeNull()
    expect(toValidLatLng(undefined, null, POINT.lng)).toBeNull()
  })

  it('treats Null Island, NaN and out-of-range values as no point', () => {
    expect(toValidLatLng({ lat: 0, lng: 0 })).toBeNull()
    expect(toValidLatLng(undefined, 0, 0)).toBeNull()
    expect(toValidLatLng({ lat: Number.NaN, lng: POINT.lng })).toBeNull()
    expect(toValidLatLng(undefined, 91, POINT.lng)).toBeNull()
    expect(toValidLatLng(undefined, POINT.lat, 181)).toBeNull()
  })

  it('keeps GeoJSON [lng, lat] order and accepts numeric strings', () => {
    expect(toValidLatLng({ type: 'Point', coordinates: [POINT.lng, POINT.lat] })).toEqual(POINT)
    expect(toValidLatLng(undefined, '40.6401', '22.9444')).toEqual(POINT)
    expect(toValidLatLng({ latitude: POINT.lat, longitude: POINT.lng })).toEqual(POINT)
  })
})
