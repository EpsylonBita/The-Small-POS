import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  browser: false,
  bridge: { orders: { create: vi.fn(), createWithInitialPayment: vi.fn(), getById: vi.fn(), saveForRetry: vi.fn() } },
}));
vi.mock('../../lib', async original => ({ ...await original<typeof import('../../lib')>(), getBridge: () => mock.browser ? null : mock.bridge }));
vi.mock('../../lib/platform-detect', async original => ({ ...await original<typeof import('../../lib/platform-detect')>(), isBrowser: () => mock.browser }));
vi.mock('../../renderer/services/terminal-credentials', () => ({
  getCachedTerminalCredentials: () => ({ branchId: 'branch-1' }),
  refreshTerminalCredentialCache: async () => ({ branchId: 'branch-1' }),
  updateTerminalCredentialCache: vi.fn(),
}));
import { OrderService } from '../OrderService';
const variantId = '22222222-2222-4222-8222-222222222222';
const checkout = () => ({ clientRequestId: 'retail-variant-regression',
  items: [{ menu_item_id: '11111111-1111-4111-8111-111111111111', retail_variant_id: variantId,
    name: 'Brown rice', quantity: 0.333, price: 1 / 0.333, total_price: 1 }],
  total_amount: 1, order_type: 'pickup', currency: 'EUR' });
beforeEach(() => {
  vi.clearAllMocks(); mock.browser = false;
  mock.bridge.orders.create.mockResolvedValue({ success: true, orderId: 'local-1' });
  mock.bridge.orders.getById.mockResolvedValue({ id: 'local-1' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('retail order transport', () => {
  it('retains variant, measured stock and label total in the native durable payload', async () => {
    await OrderService.getInstance().createOrder(checkout() as any);
    expect(mock.bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ retail_variant_id: variantId, quantity: 0.333, total_price: 1 })],
    }));
  });
  it('retains the same fields through the API fallback mapper', async () => {
    mock.browser = true;
    const service = OrderService.getInstance();
    vi.spyOn(service as any, 'getOrganizationId').mockResolvedValue('org-1');
    vi.spyOn(service as any, 'buildHeaders').mockResolvedValue({ 'Content-Type': 'application/json' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'remote-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    await service.createOrder(checkout() as any);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).items).toEqual([
      expect.objectContaining({ retail_variant_id: variantId, quantity: 0.333, total_price: 1 }),
    ]);
  });
});
