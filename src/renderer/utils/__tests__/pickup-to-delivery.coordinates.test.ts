import { describe, expect, it } from 'vitest'

import { resolvePickupToDeliveryAddress } from '../pickup-to-delivery'

// Review finding (2026-09-29): the pickup -> delivery address resolver still
// read customer-level coordinates with Number.isFinite(Number(x)), so a null
// became 0 and an address without coordinates could read as (0,0).
// Synthetic data only.
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000001'
const ADDRESS_ID = '00000000-0000-4000-8000-000000000002'

describe('resolvePickupToDeliveryAddress coordinates', () => {
  it('an address without coordinates has no point (never 0,0)', () => {
    const resolved = resolvePickupToDeliveryAddress({
      id: CUSTOMER_ID,
      name: 'Test',
      phone: '6948128474',
      latitude: null,
      longitude: null,
      addresses: [{
        id: ADDRESS_ID,
        customer_id: CUSTOMER_ID,
        street_address: 'Odos Dokimis 12',
        city: 'Kalamaria',
        postal_code: '55133',
        latitude: null,
        longitude: null,
        is_default: true,
      }],
    } as never)

    expect(resolved?.coordinates).toBeNull()
    expect(resolved?.latitude).toBeNull()
    expect(resolved?.longitude).toBeNull()
  })

  it('a legacy customer without an address row and without coordinates has no point either', () => {
    const resolved = resolvePickupToDeliveryAddress({
      id: CUSTOMER_ID,
      name: 'Test',
      phone: '6948128474',
      address: 'Odos Dokimis 12',
      latitude: null,
      longitude: null,
      addresses: [],
    } as never)

    expect(resolved?.streetAddress).toBe('Odos Dokimis 12')
    expect(resolved?.latitude).toBeNull()
    expect(resolved?.longitude).toBeNull()
  })

  it('a saved address row never borrows the customer-level point of the legacy address', () => {
    const resolved = resolvePickupToDeliveryAddress({
      id: CUSTOMER_ID,
      name: 'Test',
      phone: '6948128474',
      latitude: 40.6401,
      longitude: 22.9444,
      addresses: [{
        id: ADDRESS_ID,
        customer_id: CUSTOMER_ID,
        street_address: 'Odos Dokimis 12',
        city: 'Kalamaria',
        postal_code: '55133',
        is_default: true,
      }],
    } as never)

    expect(resolved?.coordinates).toBeNull()
    expect(resolved?.latitude).toBeNull()
    expect(resolved?.longitude).toBeNull()
  })

  it('reads a real point from any accepted shape', () => {
    const resolved = resolvePickupToDeliveryAddress({
      id: CUSTOMER_ID,
      name: 'Test',
      phone: '6948128474',
      addresses: [{
        id: ADDRESS_ID,
        customer_id: CUSTOMER_ID,
        street_address: 'Odos Dokimis 12',
        latitude: '40.5836',
        longitude: '22.9502',
        is_default: true,
      }],
    } as never)

    expect(resolved?.coordinates).toEqual({ lat: 40.5836, lng: 22.9502 })
    expect(resolved?.latitude).toBe(40.5836)
  })
})
