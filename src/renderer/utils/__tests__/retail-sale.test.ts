import { describe, expect, it } from 'vitest';
import { scannedRetailLine, scaleQuantity, variantBlocked } from '../retail-sale';
import { normalizePosOrderItem } from '../../../shared/utils/pos-order-items';
import type { Product } from '../../services/ProductCatalogService';

const product = { id: '11111111-1111-4111-8111-111111111111', name: 'Rice', price: 3, soldByMeasure: true,
  variants: [{ id: 'v1', name: 'Brown', priceAdjustment: 2, quantity: 0, isActive: true }] } as Product;

describe('retail checkout lines', () => {
  it('sells the scanned variant with its name, adjustment and durable identity', () => {
    const line = scannedRetailLine({ product, variantId: 'v1', embedded: null });
    expect(line).toMatchObject({ name: 'Rice - Brown', price: 5, retail_variant_id: 'v1', cartQuantity: 1 });
    expect(normalizePosOrderItem({ ...line, menu_item_id: product.id, quantity: line.cartQuantity }).retail_variant_id).toBe('v1');
  });
  it('never silently sells the parent when the requested variant is unavailable', () => {
    expect(() => scannedRetailLine({ product, variantId: 'missing', embedded: null })).toThrow('variantUnavailable');
  });
  it('preserves label money and three-decimal stock when the division does not terminate', () => {
    const line = scannedRetailLine({ product, variantId: null, embedded: { value_type: 'price', price: 1, weight: null } });
    expect(line.cartQuantity).toBe(0.333);
    expect(line.price * line.cartQuantity).toBeCloseTo(1, 10);
    const saved = normalizePosOrderItem({ ...line, menu_item_id: product.id, quantity: line.cartQuantity });
    expect(saved.quantity).toBe(0.333);
    expect(saved.total_price).toBeCloseTo(1, 10);
  });
  it('uses label weight as quantity and retains unit price', () => {
    expect(scannedRetailLine({ product, variantId: null, embedded: { value_type: 'weight', weight: 0.425, price: null } }))
      .toMatchObject({ cartQuantity: 0.425, price: 3 });
  });
  it('derives stock for a per-kg label even when the measure flag was not set', () => {
    expect(scannedRetailLine({ product: { ...product, unitOfMeasure: 'kg', soldByMeasure: false },
      variantId: null, embedded: { value_type: 'price', price: 1.5, weight: null } }))
      .toMatchObject({ cartQuantity: 0.5, soldByMeasure: true, price: 3 });
  });
  it('rejects invalid labels and zero-priced measured goods', () => {
    expect(() => scannedRetailLine({ product: { ...product, price: 0 }, variantId: null, embedded: { value_type: 'price', price: 3, weight: null } })).toThrow('invalidScaleLabel');
  });
  it('allows zero stock unless overselling is blocked', () => {
    expect(variantBlocked(product.variants![0], false)).toBe(false);
    expect(variantBlocked(product.variants![0], true)).toBe(true);
  });
  it('leaves the stock decision to the shared rule: one more unit must fit what is left', () => {
    // Half a unit left cannot hold one more whole unit (the old `<= 0` check let it through).
    expect(variantBlocked({ ...product.variants![0], quantity: 0.5 }, true)).toBe(true);
    expect(variantBlocked({ ...product.variants![0], quantity: 0.5 }, false)).toBe(false);
    const one = { ...product.variants![0], quantity: 1 };
    expect(variantBlocked(one, true, { productId: product.id })).toBe(false);
    // The unit already in the cart, or sold here and not yet synced, is gone.
    expect(variantBlocked(one, true, { productId: product.id,
      lines: [{ id: 'line-1', retailProductId: product.id, retailVariantId: 'v1', quantity: 1 }] })).toBe(true);
    expect(variantBlocked(one, true, { productId: product.id, unsynced: new Map([[`${product.id}::v1`, 1]]) })).toBe(true);
  });
  it('never sells an inactive variant, whatever the setting', () => {
    expect(variantBlocked({ ...product.variants![0], quantity: 9, isActive: false }, false)).toBe(true);
  });
});

describe('checkout scale readings', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const reading = { weight: 425, unit: 'g', stable: true, timestamp: new Date(now).toISOString() };
  it('converts a fresh stable weight into the product unit', () => {
    expect(scaleQuantity(reading, 'kg', now)).toBe(0.425);
  });
  it.each([{ stable: false }, { weight: 0 }, { weight: -2 }, { unit: 'l' }, { timestamp: new Date(now - 6000).toISOString() }, { timestamp: undefined }])('rejects unsafe readings %j', change => {
    expect(() => scaleQuantity({ ...reading, ...change }, 'kg', now)).toThrow('scaleNotReady');
  });
});
