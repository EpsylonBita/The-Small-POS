import { describe, expect, it } from 'vitest'

import {
  buildLegacyFallbackCustomerAddress,
  materializeCustomerAddresses,
  resolveCanonicalCustomerAddress,
  toCanonicalCustomerAddress,
  withMaterializedCustomerAddresses,
} from '../customer-addresses'

// Synthetic data only.
const POINT = { lat: 40.6401, lng: 22.9444 }

const uncoordinatedRow = {
  id: 'addr-no-point',
  customer_id: 'cust-1',
  street_address: 'Odos Dokimis 12',
  city: 'Kalamaria',
  postal_code: '551 33',
  latitude: null,
  longitude: null,
  coordinates: null,
  address_type: 'delivery',
  is_default: true,
  created_at: '2026-05-20T10:00:00Z',
  version: 3,
}

describe('customer address coordinates (Null Island regression)', () => {
  it('keeps a server row without coordinates without coordinates (today: {lat:0,lng:0})', () => {
    const [materialized] = materializeCustomerAddresses({ id: 'cust-1', addresses: [uncoordinatedRow] })

    expect(materialized.latitude).toBeNull()
    expect(materialized.longitude).toBeNull()
    expect(materialized.coordinates).toBeUndefined()
  })

  it('stays without coordinates through a second materialization (keys absent, then null)', () => {
    const { latitude: _lat, longitude: _lng, coordinates: _coords, ...withoutKeys } = uncoordinatedRow
    const once = withMaterializedCustomerAddresses({ id: 'cust-1', addresses: [withoutKeys as never] })
    const canonical = resolveCanonicalCustomerAddress(once)

    expect(canonical).not.toBeNull()
    expect(canonical?.coordinates).toBeUndefined()
    expect(canonical?.latitude).toBeNull()
    expect(canonical?.longitude).toBeNull()
  })

  it('never keeps a (0,0) point, in any shape', () => {
    const rows = [
      { ...uncoordinatedRow, id: 'a', latitude: 0, longitude: 0 },
      { ...uncoordinatedRow, id: 'b', coordinates: { lat: 0, lng: 0 } },
      { ...uncoordinatedRow, id: 'c', coordinates: { type: 'Point' as const, coordinates: [0, 0] as [number, number] } },
    ]
    for (const address of materializeCustomerAddresses({ id: 'cust-1', addresses: rows })) {
      expect(address.coordinates).toBeUndefined()
      expect(address.latitude).toBeNull()
      expect(address.longitude).toBeNull()
    }
  })

  it('normalizes a real point from any accepted shape to {lat,lng}', () => {
    const [flat, geoJson] = materializeCustomerAddresses({
      id: 'cust-1',
      addresses: [
        { ...uncoordinatedRow, id: 'flat', latitude: POINT.lat, longitude: POINT.lng },
        {
          ...uncoordinatedRow,
          id: 'geojson',
          coordinates: { type: 'Point' as const, coordinates: [POINT.lng, POINT.lat] as [number, number] },
        },
      ],
    })

    expect(flat.coordinates).toEqual(POINT)
    expect(flat.latitude).toBe(POINT.lat)
    expect(geoJson.coordinates).toEqual(POINT)
    expect(geoJson.longitude).toBe(POINT.lng)
    expect(toCanonicalCustomerAddress(geoJson)?.coordinates).toEqual(POINT)
  })

  it('gives a legacy fallback address no point when the customer has none', () => {
    const legacy = buildLegacyFallbackCustomerAddress({
      id: 'cust-legacy',
      address: 'Odos Dokimis 12',
      latitude: null,
      longitude: null,
    })

    expect(legacy?.coordinates).toBeUndefined()
    expect(legacy?.latitude).toBeNull()
    expect(legacy?.longitude).toBeNull()
  })
})
