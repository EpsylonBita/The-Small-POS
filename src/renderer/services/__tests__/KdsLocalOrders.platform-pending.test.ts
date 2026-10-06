/**
 * The kitchen board, the customer display and the central kitchen stage read
 * "active kitchen work" from KdsLocalOrders. A delivery platform order (efood,
 * Wolt, BOX…) is no kitchen work until the store accepts it: a pending BOX
 * order has no order items until BOX confirms the accept, and a BOX order
 * whose decision the server closed (expired, refused, or to check with BOX)
 * never is. Customer self-orders (QR, web, kiosk) keep their place.
 */
import { describe, expect, it } from 'vitest';
import { isActiveLocalKitchenOrder } from '../KdsLocalOrders';

const closedDecision = {
  _the_small_box_decision: {
    version: 1,
    state: 'closed',
    closure: { reason: 'expired', outcome: 'unknown', manual_check: true, code: 'BOX_DECISION_EXPIRED', closed_at: '2026-10-06T10:00:00Z' },
  },
};

const platformOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  status: 'pending',
  plugin: 'efood',
  external_plugin_order_id: 'EF-1',
  ...overrides,
});

describe('KDS active work and unconfirmed platform orders', () => {
  it.each([
    ['efood', { plugin: 'efood', external_plugin_order_id: 'EF-1' }],
    ['Wolt (camelCase bridge row)', { plugin: undefined, external_plugin_order_id: undefined, platform: 'wolt', externalPluginOrderId: 'W-1' }],
    ['BOX', { plugin: 'box', external_plugin_order_id: 'A1B2C3D4E5F6' }],
  ])('leaves out a pending %s order until it is accepted', (_label, fields) => {
    expect(isActiveLocalKitchenOrder(platformOrder(fields))).toBe(false);
  });

  it.each(['confirmed', 'preparing', 'ready'])('keeps an accepted platform order (%s)', (status) => {
    expect(isActiveLocalKitchenOrder(platformOrder({ status }))).toBe(true);
    expect(isActiveLocalKitchenOrder(platformOrder({ status, plugin: 'box', external_plugin_order_id: 'A1B2C3D4E5F6' }))).toBe(true);
  });

  it('leaves out a BOX order whose decision the server closed, as an object or local JSON text', () => {
    for (const ghost_metadata of [closedDecision, JSON.stringify(closedDecision)]) {
      expect(isActiveLocalKitchenOrder(platformOrder({ plugin: 'box', external_plugin_order_id: 'A1B2C3D4E5F6', ghost_metadata }))).toBe(false);
      // Even a row without the platform's order id, and whatever its status says.
      for (const status of ['pending', 'confirmed', 'preparing', 'ready']) {
        expect(isActiveLocalKitchenOrder({ id: 'order-1', status, plugin: 'box', ghost_metadata })).toBe(false);
      }
    }
  });

  it('keeps BOX orders whose decision is open or confirmed by BOX once accepted', () => {
    const confirmedDecision = { _the_small_box_decision: { version: 1, state: 'confirmed', action: 'accepted' } };
    expect(isActiveLocalKitchenOrder(platformOrder({ status: 'confirmed', plugin: 'box', ghost_metadata: confirmedDecision }))).toBe(true);
    expect(isActiveLocalKitchenOrder(platformOrder({ status: 'confirmed', plugin: 'box', ghost_metadata: '{not json' }))).toBe(true);
  });

  it.each([
    ['a kiosk order', { plugin: 'kiosk', external_plugin_order_id: 'K-1' }],
    ['a QR / web order', { plugin: 'web', external_plugin_order_id: 'QR-1' }],
    ['a customer web-app order', { plugin: undefined, external_plugin_order_id: undefined, source: 'customer-web' }],
    ['an order with kiosk routing metadata', { plugin: 'kiosk', external_plugin_order_id: undefined, ghost_metadata: { kiosk: { payment_method: 'cash' } } }],
    ['a customer order from an ordering channel', { plugin: 'qr-menu', external_plugin_order_id: 'Q-1', ghost_metadata: { customer: { name: 'Maria' } } }],
    ['a counter order', { plugin: 'pos', external_plugin_order_id: undefined }],
    ['an order without a platform', { plugin: undefined, external_plugin_order_id: undefined }],
  ])('keeps %s on the board while it is pending (today\'s behaviour)', (_label, fields) => {
    expect(isActiveLocalKitchenOrder(platformOrder(fields))).toBe(true);
  });

  it('still leaves out closed, ghost and Z-report orders', () => {
    expect(isActiveLocalKitchenOrder({ id: 'order-1', status: 'cancelled' })).toBe(false);
    expect(isActiveLocalKitchenOrder({ id: 'order-1', status: 'ready', is_ghost: 1 })).toBe(false);
    expect(isActiveLocalKitchenOrder({ id: 'order-1', status: 'ready', z_report_id: 'z-1' })).toBe(false);
  });
});
