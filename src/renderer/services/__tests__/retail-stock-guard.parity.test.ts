import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getLocal: vi.fn(), unsynced: vi.fn(), browser: false, toastError: vi.fn() }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ settings: { getLocal: mocks.getLocal }, orders: { getUnsyncedRetailQuantities: mocks.unsynced } }),
  isBrowser: () => mocks.browser,
}));
vi.mock('react-hot-toast', () => ({ default: { error: mocks.toastError } }));

import { RETAIL_STOCK_PARITY_CASES } from '../../../../../shared/retail-stock.parity-cases';
import {
  blockOversellingFromSettings,
  catalogCartStockLine,
  desktopRetailStockVerdict,
  loadBlockOverselling,
  loadUnsyncedRetailQuantities,
  orderStockLines,
  readBlockOverselling,
  refuseOversell,
  resetRetailStockGuardCache,
  retailStockBlockedMessage,
  retailStockKey,
} from '../retail-stock-guard';

beforeEach(() => {
  resetRetailStockGuardCache();
  mocks.browser = false;
});

const unsyncedFor = (check: (typeof RETAIL_STOCK_PARITY_CASES)[number]['check']) =>
  new Map(check.unsyncedQuantity ? [[retailStockKey(check.productId, check.variantId), check.unsyncedQuantity]] : []);

describe('desktop wrapper of the shared overselling rule (parity cases)', () => {
  it.each(RETAIL_STOCK_PARITY_CASES.map(testCase => [testCase.name, testCase] as const))('order lines: %s', (_name, testCase) => {
    const { check, expected } = testCase;
    // MenuCart / salon ticket shape: `id` is the line, the product rides in retail_product_id.
    const lines = orderStockLines(check.lines.map(line => ({
      id: line.id, retail_product_id: line.retailProductId, retail_variant_id: line.retailVariantId ?? null,
      quantity: line.quantity, line_role: line.isDeposit ? 'deposit' : undefined,
    })));
    expect(desktopRetailStockVerdict({ ...check, lines, unsynced: unsyncedFor(check) })).toEqual(expected);
  });

  it.each(RETAIL_STOCK_PARITY_CASES.map(testCase => [testCase.name, testCase] as const))('retail catalog lines: %s', (_name, testCase) => {
    const { check, expected } = testCase;
    // ProductCatalogModal shape: `id` is the product, `lineId` the line. Its cart
    // never holds deposit lines (deposits are added at payment), and they never count.
    const lines = check.lines.filter(line => !line.isDeposit).map(line => catalogCartStockLine({
      id: line.retailProductId!, lineId: line.id!, cartQuantity: line.quantity, retail_variant_id: line.retailVariantId ?? undefined,
    }));
    expect(desktopRetailStockVerdict({ ...check, lines, unsynced: unsyncedFor(check) })).toEqual(expected);
  });

  it('counts an offer reward line against the product it hands over', () => {
    const line = catalogCartStockLine({ id: 'offer-reward-sig', lineId: 'offer-reward-sig', cartQuantity: 1, is_offer_reward: true, reward_item_id: 'p1' });
    expect(line).toEqual({ id: 'offer-reward-sig', retailProductId: 'p1', retailVariantId: null, quantity: 1 });
    expect(desktopRetailStockVerdict({ blockOverselling: true, productId: 'p1', stock: 1, nextQuantity: 1, lines: [line] }).blocked).toBe(true);
  });

  it('leaves menu, service and manual lines out of the stock lines', () => {
    expect(orderStockLines([{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1, retail_product_id: '' }])).toEqual([]);
  });
});

describe('setting, unsynced sales and the block message', () => {
  it('reads retail.block_overselling from nested or flat settings, default false', () => {
    expect(blockOversellingFromSettings({ retail: { block_overselling: 'true' } })).toBe(true);
    expect(blockOversellingFromSettings({ 'retail.block_overselling': 1 })).toBe(true);
    expect(blockOversellingFromSettings({})).toBe(false);
    expect(blockOversellingFromSettings(null)).toBe(false);
    expect(readBlockOverselling('false')).toBe(false);
  });

  it('loads the setting once for a few seconds and fails open', async () => {
    mocks.getLocal.mockResolvedValue({ retail: { block_overselling: true } });
    expect(await loadBlockOverselling(1_000)).toBe(true);
    mocks.getLocal.mockResolvedValue({});
    expect(await loadBlockOverselling(2_000)).toBe(true);
    expect(await loadBlockOverselling(10_000)).toBe(false);
    resetRetailStockGuardCache();
    mocks.getLocal.mockRejectedValue(new Error('no bridge'));
    expect(await loadBlockOverselling()).toBe(false);
  });

  it('keys this till\'s unsynced sales by product and variant, and counts nothing when the command fails', async () => {
    mocks.unsynced.mockResolvedValue({ success: true, quantities: [
      { productId: 'p1', variantId: null, quantity: 2 }, { productId: 'p1', variantId: 'v1', quantity: 0.5 },
      { productId: '', variantId: null, quantity: 9 }, { productId: 'p2', variantId: null, quantity: 'x' },
    ] });
    const value = await loadUnsyncedRetailQuantities({ now: 1_000 });
    expect([...value]).toEqual([[retailStockKey('p1'), 2], [retailStockKey('p1', 'v1'), 0.5]]);
    mocks.unsynced.mockResolvedValue({ success: true, quantities: [] });
    expect((await loadUnsyncedRetailQuantities({ now: 2_000 })).size).toBe(2);
    expect((await loadUnsyncedRetailQuantities({ now: 2_000, force: true })).size).toBe(0);
    mocks.unsynced.mockRejectedValue(new Error('ipc'));
    expect((await loadUnsyncedRetailQuantities({ force: true })).size).toBe(0);
    mocks.browser = true;
    resetRetailStockGuardCache();
    expect((await loadUnsyncedRetailQuantities()).size).toBe(0);
  });

  it('blocks with "Only {available} {unit} in stock"', () => {
    const t = (_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? '').replace(/{{(\w+)}}/g, (_m, name: string) => String(options?.[name] ?? ''));
    expect(retailStockBlockedMessage(t, 1.25, 'kg')).toBe('Only 1.25 kg in stock');
    expect(retailStockBlockedMessage(t, 0, 'piece')).toBe('Only 0 pcs in stock');
    expect(refuseOversell(t, { blocked: false, available: 3, requested: 1 })).toBe(false);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(refuseOversell(t, { blocked: true, available: 2, requested: 3 }, null)).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledWith('Only 2 pcs in stock');
  });
});
