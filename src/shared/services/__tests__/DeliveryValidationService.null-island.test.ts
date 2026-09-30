import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchFromAdmin: vi.fn(),
}))

vi.mock('../../../lib', () => ({
  getBridge: () => ({ adminApi: { fetchFromAdmin: mocks.fetchFromAdmin } }),
}))

import { DeliveryValidationService } from '../DeliveryValidationService'

// Synthetic point.
const POINT = { lat: 40.5836, lng: 22.9502 }

function freshService() {
  ;(DeliveryValidationService as unknown as { instance: unknown }).instance = null
  return DeliveryValidationService.getInstance('https://admin.example.test/api', {
    apiKey: 'pos',
    enableOverrides: true,
    cacheValidationResults: true,
  })
}

function sentBody(callIndex = 0): Record<string, unknown> {
  const [, init] = mocks.fetchFromAdmin.mock.calls[callIndex]
  return JSON.parse(init.body)
}

beforeEach(() => {
  mocks.fetchFromAdmin.mockReset()
})

afterEach(() => {
  ;(DeliveryValidationService as unknown as { instance: unknown }).instance = null
})

describe('DeliveryValidationService: unusable points are "not checked"', () => {
  it('never sends a (0,0) point and answers it as not checked (today: sent and logged out_of_zone)', async () => {
    const service = freshService()

    const result = await service.validateDeliveryAddress({ address: { lat: 0, lng: 0 }, branchId: 'branch-1' })

    expect(mocks.fetchFromAdmin).not.toHaveBeenCalled()
    expect(result.validation_status).toBe('requires_selection')
    expect(result.zone_checked).toBe(false)
  })

  it('drops a coerced (0,0) latitude/longitude pair and sends the text instead', async () => {
    const service = freshService()
    mocks.fetchFromAdmin.mockResolvedValue({
      success: true,
      data: { success: true, isValid: false, validation_status: 'requires_selection', suggestedAction: 'geocode_first' },
    })

    await service.validateDeliveryAddress({
      address: 'Odos Dokimis 12, Kalamaria',
      latitude: 0,
      longitude: 0,
      branchId: 'branch-1',
    })

    const body = sentBody()
    expect(body.coordinates).toBeUndefined()
    expect(body.address).toBe('Odos Dokimis 12, Kalamaria')
  })

  it('opts in to the unchecked-zone contract (zone_validation_contract: 2)', async () => {
    const service = freshService()
    mocks.fetchFromAdmin.mockResolvedValue({ success: true, data: { success: true, isValid: true, validation_status: 'in_zone' } })

    await service.validateDeliveryAddress({ address: POINT, branchId: 'branch-1' })

    expect(sentBody().zone_validation_contract).toBe(2)
    expect(sentBody().coordinates).toEqual(POINT)
  })

  it('caches only a positive verdict for a point', async () => {
    const service = freshService()
    mocks.fetchFromAdmin
      .mockResolvedValueOnce({ success: true, data: { success: true, isValid: false, validation_status: 'out_of_zone', requires_override: true } })
      .mockResolvedValueOnce({ success: true, data: { success: true, isValid: true, validation_status: 'in_zone' } })

    await service.validateDeliveryAddress({ address: POINT, branchId: 'branch-1' })
    await service.validateDeliveryAddress({ address: POINT, branchId: 'branch-1' })
    await service.validateDeliveryAddress({ address: POINT, branchId: 'branch-1' })

    expect(mocks.fetchFromAdmin).toHaveBeenCalledTimes(2)
  })

  it('never echoes a (0,0) point from the answer as the checked coordinates', async () => {
    const service = freshService()
    mocks.fetchFromAdmin.mockResolvedValue({
      success: true,
      data: { success: true, isValid: false, validation_status: 'requires_selection', coordinates: { lat: 0, lng: 0 } },
    })

    const result = await service.validateDeliveryAddress({ address: 'Odos Dokimis 12', branchId: 'branch-1' })

    expect(result.coordinates).toBeUndefined()
  })
})
