import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), fetch: vi.fn() }));
vi.mock('../module-snapshots', () => ({ readModuleSnapshot: mocks.snapshot }));
vi.mock('../../../lib', () => ({ isBrowser: () => false, getBridge: () => ({ adminApi: { fetchFromAdmin: mocks.fetch } }) }));
vi.mock('../../../shared/supabase', () => ({ supabase: {}, isSupabaseConfigured: () => false }));
vi.mock('../offline-mutations', () => ({ offlineUpdateProductQuantity: vi.fn() }));
import { lookupSnapshotBarcode, productCatalogService } from '../ProductCatalogService';
import { SnapshotAccessError } from '../versioned-snapshot';

const row = { id: 'p1', organization_id: 'o1', branch_id: 'b1', name: 'Coffee', price: 10,
  barcode: '12345', plu_code: '42', sku: 'COF', is_active: true,
  barcodes: [{ barcode: 'alternate', product_variant_id: null }, { barcode: 'alt-variant', product_variant_id: 'v1' }],
  variants: [{ id: 'v1', name: 'Large', barcode: '67890', price_adjustment: 2, quantity: 4, is_active: true }] };
const rules = [{ prefix: '21', articleStart: 2, articleLength: 5, valueStart: 7, valueLength: 5, valueType: 'weight' as const }];

describe('offline retail barcode lookup', () => {
  beforeEach(() => { mocks.snapshot.mockResolvedValue({ rows: [row], categories: [] }); productCatalogService.setContext('b1', 'o1'); });
  it.each(['12345', 'alternate', '42', 'COF'])('resolves primary/alternate/PLU/SKU %s', barcode => {
    expect(lookupSnapshotBarcode([row], barcode)?.product.id).toBe('p1');
  });
  it('resolves variant barcode identity, adjustment and stock', () => {
    expect(lookupSnapshotBarcode([row], '67890')).toMatchObject({ variantId: 'v1', product: { variants: [{ priceAdjustment: 2, quantity: 4 }] } });
    expect(lookupSnapshotBarcode([row], 'alt-variant')).toBeNull(); // cleaning removes separators, as on the server
    expect(lookupSnapshotBarcode([{ ...row, barcodes: [{ barcode: 'altvariant', product_variant_id: 'v1' }] }], 'alt-variant')?.variantId).toBe('v1');
  });
  it('reuses the server scale parser with organization opt-in only', () => {
    expect(lookupSnapshotBarcode([row], '2100042004250', rules)?.embedded).toEqual({ value_type: 'weight', weight: 0.425, price: null });
    expect(lookupSnapshotBarcode([row], '2100042004250')).toBeNull();
    expect(lookupSnapshotBarcode([row], '2100042004250', [{ ...rules[0], valueType: 'price' }])?.embedded?.price).toBe(4.25);
  });
  it('does not ring inactive products or variants', () => {
    expect(lookupSnapshotBarcode([{ ...row, is_active: false }], '12345')).toBeNull();
    expect(lookupSnapshotBarcode([{ ...row, variants: [{ ...row.variants[0], is_active: false }] }], '67890')).toBeNull();
  });
  it('scans from the authenticated snapshot with no network lookup', async () => {
    expect(await productCatalogService.fetchBarcodeScanResult('67890')).toMatchObject({ variantId: 'v1' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('cannot use another branch or organization catalogue rows', async () => {
    mocks.fetch.mockResolvedValue({ success: true, data: { success: true, found: false } });
    mocks.snapshot.mockResolvedValue({ rows: [{ ...row, branch_id: 'other' }, { ...row, organization_id: 'other' }], categories: [] });
    expect(await productCatalogService.fetchBarcodeScanResult('12345')).toBeNull();
  });
  it('does not bypass a revoked snapshot through a live or direct lookup', async () => {
    mocks.snapshot.mockRejectedValue(new SnapshotAccessError('Module revoked'));
    expect(await productCatalogService.fetchBarcodeScanResult('12345')).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('hydrates an online variant response from the scoped snapshot', async () => {
    mocks.fetch.mockResolvedValue({ success: true, data: { success: true, found: true, product: { ...row, variants: undefined }, variant_id: 'v1' } });
    expect(await productCatalogService.fetchBarcodeScanResult('newalternate')).toMatchObject({ variantId: 'v1', product: { variants: [{ id: 'v1', priceAdjustment: 2 }] } });
  });
});
