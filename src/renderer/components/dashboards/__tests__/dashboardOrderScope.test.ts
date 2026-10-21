import { expect, it } from 'vitest';
import { getBusinessCategory, getDashboardOrderFilter, normalizeBusinessTypeAlias } from '../dashboardOrderScope';

it('accepts convenience_store as the convenience retail alias for module resolution and dashboard scope', () => {
  expect(normalizeBusinessTypeAlias('convenience_store')).toBe('convenience');
  expect(normalizeBusinessTypeAlias('restaurant')).toBe('restaurant');
  expect(getBusinessCategory('convenience_store')).toBe('product');
  expect(getDashboardOrderFilter(getBusinessCategory('convenience_store'))).toBeUndefined();
  expect(getDashboardOrderFilter(getBusinessCategory('restaurant'))!({ items: [{ retail_product_id: 'product' }] } as any)).toBe(false);
});
