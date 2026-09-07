import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCatalogOffers } = vi.hoisted(() => ({ getCatalogOffers: vi.fn() }));
vi.mock('../../../lib', () => ({
  isBrowser: () => false,
  getBridge: () => ({ branchData: { getCatalogOffers } }),
}));
vi.mock('../api-helpers', () => ({ posApiPost: vi.fn() }));

import { validateCatalogOffers } from '../catalog-offers';

describe('catalog offer evaluation cancellation', () => {
  beforeEach(() => getCatalogOffers.mockReset());

  it('skips evaluation of an obsolete IPC response', async () => {
    let resolveRequest!: (value: unknown) => void;
    getCatalogOffers.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const readOffers = vi.fn(() => []);
    let cancelled = false;
    const pending = validateCatalogOffers({
      catalogType: 'menu',
      cartItems: [{ item_id: 'espresso', quantity: 2, unit_price: 3 }],
      isCancelled: () => cancelled,
    });
    cancelled = true;
    resolveRequest({ success: true, data: { get offers() { return readOffers(); } } });
    await expect(pending).resolves.toBeNull();
    expect(readOffers).not.toHaveBeenCalled();
  });

  it('still evaluates the current cart with fresh returned rules', async () => {
    getCatalogOffers.mockResolvedValue({ success: true, data: { offers: [], reward_items: [] } });
    const result = await validateCatalogOffers({
      catalogType: 'menu',
      cartItems: [{ item_id: 'espresso', quantity: 2, unit_price: 3 }],
      isCancelled: () => false,
    });
    expect(result).toMatchObject({ cart_total: 6, final_total: 6, discount_total: 0 });
  });
});
