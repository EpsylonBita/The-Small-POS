import {
  productCatalogService,
  type BarcodeScanResult,
  type Product,
  type ProductVariant,
} from '../../services/ProductCatalogService'
import { servicesService, type Service } from '../../services/ServicesService'

export type RepairCatalogKind = 'part' | 'labour'

export interface RepairCatalogItem {
  key: string
  kind: RepairCatalogKind
  retailProductId: string | null
  retailVariantId: string | null
  serviceId: string | null
  nameSnapshot: string
  skuSnapshot: string | null
  description: string | null
  unitCostSnapshot: number | null
  unitPriceSnapshot: number
  vatRateSnapshot: number | null
}

export interface RepairCatalogSearchInput {
  organizationId: string
  branchId: string
  kind: RepairCatalogKind
  query: string
}

export interface RepairCatalogBarcodeInput {
  organizationId: string
  branchId: string
  barcode: string
}

interface ProductCatalogDependency {
  setContext(branchId: string, organizationId: string): void
  fetchProducts(filters: { searchTerm: string; activeOnly: true }): Promise<Product[]>
  fetchBarcodeScanResult(barcode: string): Promise<BarcodeScanResult | null>
  fetchProductVariants(productId: string): Promise<ProductVariant[]>
}

interface ServiceCatalogDependency {
  setContext(branchId: string, organizationId: string): void
  fetchServices(filters: { searchTerm: string; activeFilter: true }): Promise<Service[]>
}

const VAT_RATE_BY_CATEGORY: Readonly<Record<string, number>> = Object.freeze({
  gr_standard_24: 24,
  gr_reduced_13: 13,
  gr_super_reduced_6: 6,
  gr_island_reduced_17: 17,
  gr_island_super_reduced_9: 9,
  gr_island_ultra_reduced_4: 4,
  gr_exempt: 0,
  gr_out_of_scope: 0,
  gr_article_39_small_business: 0,
})

function canonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    && normalized === value
    ? normalized
    : null
}

function safeMoney(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function productInScope(product: Product, organizationId: string, branchId: string): boolean {
  return canonicalUuid(product.id) !== null
    && product.organizationId === organizationId
    && (!product.branchId || product.branchId === branchId)
    && product.isActive === true
    && typeof product.name === 'string'
    && product.name.trim().length > 0
    && safeMoney(product.price) !== null
}

function variantInScope(variant: ProductVariant, productId: string, productPrice: number): boolean {
  const adjustedPrice = productPrice + variant.priceAdjustment
  return canonicalUuid(variant.id) !== null
    && variant.productId === productId
    && variant.isActive === true
    && typeof variant.name === 'string'
    && variant.name.trim().length > 0
    && typeof variant.priceAdjustment === 'number'
    && Number.isFinite(variant.priceAdjustment)
    && safeMoney(adjustedPrice) !== null
}

function projectProduct(product: Product, variant: ProductVariant | null = null): RepairCatalogItem {
  const price = product.price + (variant?.priceAdjustment ?? 0)
  const explicitVatRate = product.vatCategoryCode
    ? VAT_RATE_BY_CATEGORY[product.vatCategoryCode] ?? null
    : null
  return {
    key: variant ? `${product.id}:${variant.id}` : product.id,
    kind: 'part',
    retailProductId: product.id,
    retailVariantId: variant?.id ?? null,
    serviceId: null,
    nameSnapshot: variant ? `${product.name.trim()} — ${variant.name.trim()}` : product.name.trim(),
    skuSnapshot: (variant?.sku || product.sku || '').trim() || null,
    description: product.description?.trim() || null,
    unitCostSnapshot: safeMoney(product.cost),
    unitPriceSnapshot: price,
    vatRateSnapshot: explicitVatRate,
  }
}

function projectService(service: Service, organizationId: string, branchId: string): RepairCatalogItem | null {
  if (canonicalUuid(service.id) === null
    || service.organizationId !== organizationId
    || service.branchId !== branchId
    || service.isActive !== true
    || typeof service.name !== 'string'
    || !service.name.trim()
    || safeMoney(service.price) === null) {
    return null
  }
  return {
    key: service.id,
    kind: 'labour',
    retailProductId: null,
    retailVariantId: null,
    serviceId: service.id,
    nameSnapshot: service.name.trim(),
    skuSnapshot: null,
    description: service.description?.trim() || null,
    unitCostSnapshot: null,
    unitPriceSnapshot: service.price,
    vatRateSnapshot: null,
  }
}

export class RepairCatalogService {
  constructor(
    private readonly products: ProductCatalogDependency = productCatalogService,
    private readonly services: ServiceCatalogDependency = servicesService,
  ) {}

  async search(input: RepairCatalogSearchInput): Promise<RepairCatalogItem[]> {
    const organizationId = canonicalUuid(input.organizationId)
    const branchId = canonicalUuid(input.branchId)
    const query = input.query.trim()
    if (!organizationId || !branchId || !query || query.length > 120) return []

    if (input.kind === 'part') {
      this.products.setContext(branchId, organizationId)
      const products = await this.products.fetchProducts({ searchTerm: query, activeOnly: true })
      return products.flatMap((product) => {
        if (!productInScope(product, organizationId, branchId)) return []
        const variants = (product.variants ?? [])
          .filter((variant) => variantInScope(variant, product.id, product.price))
          .map((variant) => projectProduct(product, variant))
        return [projectProduct(product), ...variants]
      })
    }

    this.services.setContext(branchId, organizationId)
    const services = await this.services.fetchServices({ searchTerm: query, activeFilter: true })
    return services.flatMap((service) => {
      const projected = projectService(service, organizationId, branchId)
      return projected ? [projected] : []
    })
  }

  async lookupBarcode(input: RepairCatalogBarcodeInput): Promise<RepairCatalogItem | null> {
    const organizationId = canonicalUuid(input.organizationId)
    const branchId = canonicalUuid(input.branchId)
    const barcode = input.barcode.trim()
    if (!organizationId || !branchId || !barcode || barcode.length > 128) return null

    this.products.setContext(branchId, organizationId)
    const scan = await this.products.fetchBarcodeScanResult(barcode)
    if (!scan || !productInScope(scan.product, organizationId, branchId)) return null
    if (!scan.variantId) return projectProduct(scan.product)

    const variantId = canonicalUuid(scan.variantId)
    if (!variantId) return null
    const variants = await this.products.fetchProductVariants(scan.product.id)
    const variant = variants.find((candidate) => candidate.id === variantId
      && variantInScope(candidate, scan.product.id, scan.product.price))
    return variant ? projectProduct(scan.product, variant) : null
  }
}

export const repairCatalogService = new RepairCatalogService()
