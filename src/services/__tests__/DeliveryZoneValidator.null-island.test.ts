import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  validateDeliveryAddress: vi.fn(),
  trackValidation: vi.fn(async () => ({ success: true })),
}))

vi.mock('../../shared/services/DeliveryValidationService', () => ({
  DeliveryValidationService: {
    getInstance: () => ({
      validateDeliveryAddress: mocks.validateDeliveryAddress,
      requestDeliveryOverride: vi.fn(),
      updateAuth: vi.fn(),
    }),
  },
}))

vi.mock('../../config/environment', () => ({
  environment: { ADMIN_API_BASE_URL: 'https://admin.example.test/api' },
}))

vi.mock('../../lib', () => ({
  getBridge: () => ({ deliveryZones: { trackValidation: mocks.trackValidation } }),
}))

import {
  DELIVERY_VALIDATION_CACHE_STORAGE_KEY,
  DeliveryZoneValidator,
} from '../DeliveryZoneValidator'

// Synthetic point.
const POINT = { lat: 40.5836, lng: 22.9502 }

const inZone = {
  success: true,
  isValid: true,
  validation_status: 'in_zone',
  zone: { id: 'zone-1', name: 'Zone 1', deliveryFee: 0, minimumOrderAmount: 5 },
}

const outOfZone = {
  success: true,
  isValid: false,
  validation_status: 'out_of_zone',
  zone_checked: true,
  requires_override: true,
}

function makeValidator() {
  return new DeliveryZoneValidator({
    branchId: 'branch-1',
    terminalId: 'terminal-1',
    enableCaching: true,
    enableAnalytics: true,
  })
}

beforeEach(() => {
  localStorage.clear()
  mocks.validateDeliveryAddress.mockReset()
  mocks.trackValidation.mockClear()
})

afterEach(() => {
  localStorage.clear()
})

describe('DeliveryZoneValidator: no Null Island checks', () => {
  it('answers a (0,0) point locally as "not checked" and never asks or caches (today: out_of_zone for 30 min)', async () => {
    const validator = makeValidator()

    const result = await validator.validateAddress({ lat: 0, lng: 0 })

    expect(mocks.validateDeliveryAddress).not.toHaveBeenCalled()
    expect(result.validation_status).toBe('requires_selection')
    expect(result.zone_checked).toBe(false)
    expect(result.reason_code).toBe('coordinates_missing')
    expect(localStorage.getItem(DELIVERY_VALIDATION_CACHE_STORAGE_KEY)).toBeNull()
  })

  it('does the same for NaN or out-of-range points', async () => {
    const validator = makeValidator()
    await validator.validateAddress({ lat: Number.NaN, lng: POINT.lng })
    await validator.validateAddress({ lat: 95, lng: POINT.lng })
    expect(mocks.validateDeliveryAddress).not.toHaveBeenCalled()
  })

  it('discards the cache of older builds (versioned key) so a cached (0,0) verdict is never reused', async () => {
    localStorage.setItem('pos_delivery_validation_cache', JSON.stringify({
      'coords:0.000000,0.000000': { result: outOfZone, timestamp: Date.now() },
    }))

    makeValidator()

    expect(localStorage.getItem('pos_delivery_validation_cache')).toBeNull()
    expect(DELIVERY_VALIDATION_CACHE_STORAGE_KEY).not.toBe('pos_delivery_validation_cache')
  })

  it('caches an in-zone verdict for a point but asks again after an out-of-zone one', async () => {
    const validator = makeValidator()

    mocks.validateDeliveryAddress.mockResolvedValueOnce(outOfZone)
    await validator.validateAddress(POINT)
    mocks.validateDeliveryAddress.mockResolvedValueOnce(inZone)
    await validator.validateAddress(POINT)
    await validator.validateAddress(POINT)

    expect(mocks.validateDeliveryAddress).toHaveBeenCalledTimes(2)
    expect(mocks.validateDeliveryAddress).toHaveBeenLastCalledWith(expect.objectContaining({ address: POINT }))
  })

  it('never caches a "not checked" answer for a point', async () => {
    const validator = makeValidator()
    const notChecked = { success: true, isValid: false, validation_status: 'requires_selection', zone_checked: false }
    mocks.validateDeliveryAddress.mockResolvedValue(notChecked)

    await validator.validateAddress(POINT)
    await validator.validateAddress(POINT)

    expect(mocks.validateDeliveryAddress).toHaveBeenCalledTimes(2)
  })

  it('logs a not-checked answer as not_checked, never as out_of_zone', async () => {
    const validator = makeValidator()
    mocks.validateDeliveryAddress.mockResolvedValue({
      success: true,
      isValid: false,
      validation_status: 'requires_selection',
      suggestedAction: 'geocode_first',
    })

    await validator.validateAddress('Odos Dokimis 12, Kalamaria')

    expect(mocks.trackValidation).toHaveBeenCalledWith(expect.objectContaining({ result: 'not_checked' }))
  })
})
