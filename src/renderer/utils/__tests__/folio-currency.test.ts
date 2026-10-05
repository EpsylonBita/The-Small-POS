import { describe, expect, it } from 'vitest'
import { canChargeFolio, commonFolioCurrency, freezeRoomChargeCurrency } from '../folio-currency'

describe('immutable folio and order currency', () => {
  it('requires a known folio unit equal to the current store for a new charge', () => {
    expect(canChargeFolio('CHF', 'CHF')).toBe(true)
    expect(canChargeFolio('EUR', 'CHF')).toBe(false)
    expect(canChargeFolio(undefined, 'CHF')).toBe(false)
    expect(canChargeFolio('CHF', null)).toBe(false)
  })
  it('never gives mixed or partly unknown folios a single total currency', () => {
    expect(commonFolioCurrency([{ currency: 'CHF' }, { currency: 'CHF' }])).toBe('CHF')
    expect(commonFolioCurrency([{ currency: 'CHF' }, { currency: 'EUR' }])).toBeNull()
    expect(commonFolioCurrency([{ currency: 'CHF' }, {}])).toBeNull()
  })
  it('freezes the validated unit into durable metadata without dropping other metadata', () => {
    expect(freezeRoomChargeCurrency({ metadata: { table_session: 'preserved' }, roomId: 'room1', storeCurrency: 'CHF' })).toEqual({
      currency: 'CHF', metadata: { table_session: 'preserved', room_charge: { currency: 'CHF', room_id: 'room1' } },
    })
  })
  it('preserves an offline original after a country change or unavailable settings', () => {
    const original = freezeRoomChargeCurrency({ roomId: 'room1', storeCurrency: 'CHF' })
    for (const storeCurrency of ['EUR', null]) {
      expect(freezeRoomChargeCurrency({ metadata: original.metadata, roomId: 'room1', storeCurrency })).toEqual(original)
    }
  })
  it('refuses unknown originals, conflicting units and room identity', () => {
    expect(() => freezeRoomChargeCurrency({ metadata: { room_charge: {} }, roomId: 'room1', storeCurrency: 'CHF' })).toThrow('FOLIO_CURRENCY_UNAVAILABLE')
    expect(() => freezeRoomChargeCurrency({ roomId: 'room1', storeCurrency: null })).toThrow('FOLIO_CURRENCY_UNAVAILABLE')
    expect(() => freezeRoomChargeCurrency({ roomId: 'room1', storeCurrency: 'CHF', currency: 'EUR' })).toThrow('FOLIO_CURRENCY_MISMATCH')
    expect(() => freezeRoomChargeCurrency({ roomId: 'room2', storeCurrency: 'CHF', metadata: { room_charge: { currency: 'CHF', room_id: 'room1' } } })).toThrow('FOLIO_ROOM_MISMATCH')
  })
})
