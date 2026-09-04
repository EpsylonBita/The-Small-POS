import { describe, expect, it, vi } from 'vitest'

import { RepairCatalogService } from '../RepairCatalogService'

const organizationId = '11111111-1111-4111-8111-111111111111'
const branchId = '22222222-2222-4222-8222-222222222222'
const productId = '33333333-3333-4333-8333-333333333333'
const variantId = '44444444-4444-4444-8444-444444444444'
const serviceId = '55555555-5555-4555-8555-555555555555'

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: productId,
    organizationId,
    branchId,
    sku: 'DISPLAY',
    barcode: '5200000000010',
    name: 'Display assembly',
    description: 'OLED module',
    price: 80,
    cost: 42,
    isActive: true,
    vatCategoryCode: 'gr_reduced_13',
    variants: [{
      id: variantId,
      productId,
      sku: 'DISPLAY-BLK',
      barcode: '5200000000027',
      name: 'Black',
      attributes: { color: 'black' },
      priceAdjustment: 5,
      quantity: 2,
      isActive: true,
    }],
    ...overrides,
  }
}

function dependencies() {
  return {
    products: {
      setContext: vi.fn(),
      fetchProducts: vi.fn().mockResolvedValue([product()]),
      fetchBarcodeScanResult: vi.fn().mockResolvedValue({
        product: product(),
        embedded: null,
        variantId,
      }),
      fetchProductVariants: vi.fn().mockResolvedValue(product().variants),
    },
    services: {
      setContext: vi.fn(),
      fetchServices: vi.fn().mockResolvedValue([{
        id: serviceId,
        organizationId,
        branchId,
        name: 'Display replacement',
        description: 'Bench labour',
        price: 35,
        isActive: true,
      }]),
    },
  }
}

describe('RepairCatalogService', () => {
  it('projects canonical product and variant snapshots from the existing POS catalog', async () => {
    const deps = dependencies()
    const service = new RepairCatalogService(deps.products as never, deps.services as never)

    const results = await service.search({ organizationId, branchId, kind: 'part', query: 'display' })

    expect(deps.products.setContext).toHaveBeenCalledWith(branchId, organizationId)
    expect(deps.products.fetchProducts).toHaveBeenCalledWith({ searchTerm: 'display', activeOnly: true })
    expect(results).toEqual([
      expect.objectContaining({
        kind: 'part',
        retailProductId: productId,
        retailVariantId: null,
        serviceId: null,
        nameSnapshot: 'Display assembly',
        skuSnapshot: 'DISPLAY',
        unitCostSnapshot: 42,
        unitPriceSnapshot: 80,
        vatRateSnapshot: 13,
      }),
      expect.objectContaining({
        kind: 'part',
        retailProductId: productId,
        retailVariantId: variantId,
        nameSnapshot: 'Display assembly — Black',
        skuSnapshot: 'DISPLAY-BLK',
        unitPriceSnapshot: 85,
      }),
    ])
  })

  it('accepts a canonical negative variant adjustment only when the resulting price stays non-negative', async () => {
    const deps = dependencies()
    deps.products.fetchProducts.mockResolvedValueOnce([product({
      variants: [{
        ...product().variants[0],
        priceAdjustment: -10,
      }],
    })])
    const service = new RepairCatalogService(deps.products as never, deps.services as never)

    const results = await service.search({ organizationId, branchId, kind: 'part', query: 'display' })

    expect(results).toEqual([
      expect.objectContaining({ retailVariantId: null, unitPriceSnapshot: 80 }),
      expect.objectContaining({ retailVariantId: variantId, unitPriceSnapshot: 70 }),
    ])

    deps.products.fetchProducts.mockResolvedValueOnce([product({
      price: 5,
      variants: [{
        ...product().variants[0],
        priceAdjustment: -10,
      }],
    })])

    await expect(service.search({ organizationId, branchId, kind: 'part', query: 'display' }))
      .resolves.toEqual([expect.objectContaining({ retailVariantId: null, unitPriceSnapshot: 5 })])
  })

  it('projects canonical services while leaving unavailable VAT explicit for operator entry', async () => {
    const deps = dependencies()
    const service = new RepairCatalogService(deps.products as never, deps.services as never)

    await expect(service.search({ organizationId, branchId, kind: 'labour', query: 'replacement' }))
      .resolves.toEqual([expect.objectContaining({
        kind: 'labour',
        retailProductId: null,
        retailVariantId: null,
        serviceId,
        nameSnapshot: 'Display replacement',
        description: 'Bench labour',
        unitPriceSnapshot: 35,
        vatRateSnapshot: null,
      })])
  })

  it('resolves a scanned variant exactly and fails closed if that variant is unavailable', async () => {
    const deps = dependencies()
    const service = new RepairCatalogService(deps.products as never, deps.services as never)

    await expect(service.lookupBarcode({ organizationId, branchId, barcode: '5200000000027' }))
      .resolves.toEqual(expect.objectContaining({ retailProductId: productId, retailVariantId: variantId }))

    deps.products.fetchProductVariants.mockResolvedValueOnce([])
    await expect(service.lookupBarcode({ organizationId, branchId, barcode: '5200000000027' }))
      .resolves.toBeNull()
  })

  it('does not query catalogs without canonical tenant context', async () => {
    const deps = dependencies()
    const service = new RepairCatalogService(deps.products as never, deps.services as never)

    await expect(service.search({ organizationId: 'not-an-org', branchId, kind: 'part', query: 'x' }))
      .resolves.toEqual([])
    expect(deps.products.fetchProducts).not.toHaveBeenCalled()
  })
})
