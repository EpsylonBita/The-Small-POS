import { describe, expect, it } from 'vitest'

import {
  canCheckoutWithDeliveryFeeStatus,
  createUncheckedDeliveryZoneResult,
  getDeliveryFeeStatus,
  isDeliveryZoneUnchecked,
  resolveDeliveryFee,
} from '../delivery-fee'

const inZone = {
  success: true,
  isValid: true,
  validation_status: 'in_zone',
  zone: { id: 'zone-1', name: 'Zone 1', deliveryFee: 1.5, minimumOrderAmount: 5 },
}

const realOutOfZone = {
  success: true,
  isValid: false,
  validation_status: 'out_of_zone',
  zone_checked: true,
  requires_override: true,
  suggestedAction: 'pickup_or_override',
}

describe('delivery zone "not checked" status', () => {
  it('reads the contract-2 server answer for an address without a point as not checked', () => {
    const contract2 = {
      success: true,
      isValid: false,
      validation_status: 'requires_selection',
      suggestedAction: 'geocode_first',
      reason_code: 'coordinates_missing',
      zone_checked: false,
    }
    expect(isDeliveryZoneUnchecked(contract2)).toBe(true)
    expect(getDeliveryFeeStatus('delivery', contract2)).toBe('not_checked')
  })

  it('never shows the legacy out_of_zone shape of an unusable point as out of zone', () => {
    const legacyTagged = { ...realOutOfZone, zone_checked: false, reason_code: 'coordinates_missing' }
    expect(getDeliveryFeeStatus('delivery', legacyTagged)).toBe('not_checked')
  })

  it('keeps typed text that still needs a pick (geocode_first) as not checked', () => {
    expect(getDeliveryFeeStatus('delivery', {
      success: true,
      isValid: false,
      validation_status: 'requires_selection',
      suggestedAction: 'geocode_first',
    })).toBe('not_checked')
  })

  it('keeps the desktop behaviour for a real out-of-zone point and for a zone fee', () => {
    expect(getDeliveryFeeStatus('delivery', realOutOfZone)).toBe('resolved')
    expect(resolveDeliveryFee(realOutOfZone)).toBe(0)
    expect(getDeliveryFeeStatus('delivery', inZone)).toBe('resolved')
    expect(resolveDeliveryFee(inZone)).toBe(1.5)
  })

  it('lets a not-checked zone through checkout but not a missing address or a running check', () => {
    expect(canCheckoutWithDeliveryFeeStatus('not_checked')).toBe(true)
    expect(canCheckoutWithDeliveryFeeStatus('resolved')).toBe(true)
    expect(canCheckoutWithDeliveryFeeStatus('requires_selection')).toBe(false)
    expect(canCheckoutWithDeliveryFeeStatus('loading')).toBe(false)
  })

  it('builds a local not-checked answer with no fee and no point', () => {
    const local = createUncheckedDeliveryZoneResult()
    expect(isDeliveryZoneUnchecked(local)).toBe(true)
    expect(local.coordinates).toBeUndefined()
    expect(resolveDeliveryFee(local)).toBe(0)
    expect(getDeliveryFeeStatus('delivery', local)).toBe('not_checked')
  })
})
