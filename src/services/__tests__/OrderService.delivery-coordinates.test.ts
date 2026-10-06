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

const addressId = '91f0a271-9fc5-454d-8876-f7c41e7e0b33';
const point = { lat: 40.6138032, lng: 22.9601881 };
const checkout = (camel = false) => ({
  clientRequestId: 'delivery-coordinates-regression',
  items: [{ name: 'Synthetic item', quantity: 1, price: 11, is_manual: true }],
  total_amount: 11, order_type: 'delivery', currency: 'EUR',
  delivery_address: 'Synthetic Street 28', delivery_city: 'Thessaloniki', delivery_postal_code: '54641',
  ...(camel ? { deliveryAddressId: addressId, deliveryLatitude: point.lat, deliveryLongitude: point.lng,
    deliveryAddressFingerprint: 'selected-point', deliveryZoneId: addressId }
    : { delivery_address_id: addressId, delivery_latitude: point.lat, delivery_longitude: point.lng,
      delivery_address_fingerprint: 'selected-point', delivery_zone_id: addressId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mock.browser = false;
  mock.bridge.orders.create.mockResolvedValue({ success: true, orderId: 'local-1' });
  mock.bridge.orders.getById.mockResolvedValue({ id: 'local-1' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('order creation retains selected delivery coordinates through the real service mapper', () => {
  it.each([false, true])('forwards the complete location to native IPC (camel=%s)', async camel => {
    await OrderService.getInstance().createOrder(checkout(camel) as any);
    expect(mock.bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({
      deliveryAddressId: addressId, deliveryLatitude: point.lat, deliveryLongitude: point.lng,
      deliveryAddressFingerprint: 'selected-point', deliveryZoneId: addressId,
    }));
  });
  it('keeps a legacy selected point independently of its noncanonical address id', async () => {
    await OrderService.getInstance().createOrder({ ...checkout(), delivery_address_id: `legacy:${addressId}` } as any);
    expect(mock.bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({
      deliveryAddressId: null, deliveryLatitude: point.lat, deliveryLongitude: point.lng,
    }));
  });
  it.each([[null, null], [0, 0], [40.6, null]])('does not turn an unknown/invalid pair into a real point (%s,%s)', async (lat, lng) => {
    await OrderService.getInstance().createOrder({ ...checkout(), delivery_latitude: lat, delivery_longitude: lng } as any);
    expect(mock.bridge.orders.create).toHaveBeenCalledWith(expect.objectContaining({ deliveryLatitude: null, deliveryLongitude: null }));
  });
  it('forwards the same point in the browser API body', async () => {
    mock.browser = true;
    const service = OrderService.getInstance();
    vi.spyOn(service as any, 'getOrganizationId').mockResolvedValue('org-1');
    vi.spyOn(service as any, 'buildHeaders').mockResolvedValue({ 'Content-Type': 'application/json' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'remote-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    await service.createOrder(checkout() as any);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      delivery_address_id: addressId, delivery_latitude: point.lat, delivery_longitude: point.lng,
      delivery_address_fingerprint: 'selected-point', delivery_zone_id: addressId,
    });
  });
});
