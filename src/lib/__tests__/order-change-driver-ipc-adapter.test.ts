import { beforeEach, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { CHANNEL_MAP, TauriBridge } from '../ipc-adapter';

beforeEach(() => {
  invoke.mockReset();
});

// Founder request (Tomikro 26/10/2026): "Change driver" goes to the native
// `order_change_driver` command with the order and the driver who carried it.
it('sends the driver change to order_change_driver and keeps a refusal a refusal', async () => {
  invoke.mockResolvedValueOnce({ success: true, data: { driverId: 'driver-right' } });
  const bridge = new TauriBridge();

  await expect(
    bridge.orders.changeDriver({ orderId: 'order-1', driverId: 'driver-right' }),
  ).resolves.toEqual({ success: true, data: { driverId: 'driver-right' } });
  expect(invoke).toHaveBeenLastCalledWith('order_change_driver', {
    arg0: { orderId: 'order-1', driverId: 'driver-right' },
  });
  expect(CHANNEL_MAP['order:change-driver']).toBe('orders.changeDriver');

  invoke.mockRejectedValueOnce('DRIVER_CHANGE_SHIFT_CLOSED: closed');
  await expect(
    bridge.orders.changeDriver({ orderId: 'order-1', driverId: 'driver-right' }),
  ).rejects.toBe('DRIVER_CHANGE_SHIFT_CLOSED: closed');
});
