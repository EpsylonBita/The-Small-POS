import type { BarcodeScanResult, Product, ProductVariant } from '../services/ProductCatalogService';
import type { ScaleReading } from '../hooks/useScale';

export class RetailSaleError extends Error {
  constructor(public readonly code: 'variantUnavailable' | 'invalidScaleLabel' | 'scaleNotReady') {
    super(code);
  }
}

export function variantProduct(product: Product, variantId: string | null): Product & { retail_variant_id?: string } {
  if (!variantId) return product;
  const variant = product.variants?.find(value => value.id === variantId && value.isActive);
  if (!variant) throw new RetailSaleError('variantUnavailable');
  return {
    ...product,
    name: `${product.name} - ${variant.name}`,
    price: product.price + variant.priceAdjustment,
    quantity: variant.quantity,
    retail_variant_id: variant.id,
  };
}

export function scannedRetailLine(scan: BarcodeScanResult) {
  const product = variantProduct(scan.product, scan.variantId);
  const embedded = scan.embedded;
  if (!embedded) return { ...product, cartQuantity: 1 };
  if (embedded.value_type === 'weight' && Number.isFinite(embedded.weight) && embedded.weight! > 0) {
    const quantity = Math.round(embedded.weight! * 1000) / 1000;
    if (quantity > 0) return { ...product, soldByMeasure: true, scaleScanned: true, cartQuantity: quantity };
  }
  if (embedded.value_type === 'price' && Number.isFinite(embedded.price) && embedded.price! > 0) {
    const measured = product.soldByMeasure || product.unitOfMeasure?.toLowerCase() === 'kg';
    const quantity = measured && product.price > 0 ? Math.round(embedded.price! / product.price * 1000) / 1000 : measured ? 0 : 1;
    if (quantity > 0) return {
      ...product, soldByMeasure: measured, scaleScanned: true, cartQuantity: quantity,
      // Quantity is rounded to SQLite/server precision. Keep the printed label
      // total exact by using its effective unit price, without rounding it to cents.
      price: embedded.price! / quantity, originalUnitPrice: product.price,
    };
  }
  throw new RetailSaleError('invalidScaleLabel');
}

export function variantBlocked(variant: ProductVariant, blockOverselling: boolean): boolean {
  return !variant.isActive || (blockOverselling && variant.quantity <= 0);
}

export function scaleQuantity(reading: ScaleReading | null, unit: string, now = Date.now()): number {
  const factors: Record<string, number> = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125 };
  const source = reading && factors[reading.unit.toLowerCase()];
  const target = factors[unit.toLowerCase()];
  const at = Date.parse(reading?.timestamp || '');
  if (!reading?.stable || !Number.isFinite(reading.weight) || reading.weight <= 0 ||
      !source || !target || !Number.isFinite(at) || now - at > 5000 || at > now + 1000) {
    throw new RetailSaleError('scaleNotReady');
  }
  const quantity = Math.round(reading.weight * source / target * 1000) / 1000;
  if (quantity <= 0) throw new RetailSaleError('scaleNotReady');
  return quantity;
}
