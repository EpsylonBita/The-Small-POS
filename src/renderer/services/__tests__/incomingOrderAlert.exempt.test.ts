/**
 * A BOX order whose decision the server closed (BOX expired or refused it, or
 * the outcome is unknown and staff check it with BOX) takes no accept or
 * decline any more, even while it is still pending, so it must not ring the
 * incoming-order alert. Every other waiting order still does.
 */
import { describe, expect, it } from 'vitest';
import { orderNeedsApproval } from '../../../../../shared/order-approval';
import { isIncomingOrderAlertExempt } from '../incomingOrderAlert';

const closedDecision = (outcome: 'unknown' | 'not_accepted') => ({
  _the_small_box_decision: {
    version: 1,
    state: 'closed',
    closure: { reason: 'expired', outcome, manual_check: outcome === 'unknown', code: 'BOX_DECISION_EXPIRED', closed_at: '2026-10-06T10:00:00Z' },
  },
});

const boxOrder = (ghost_metadata?: unknown) => ({
  id: 'box-1',
  status: 'pending',
  plugin: 'box',
  external_plugin_order_id: 'A1B2C3D4E5F6',
  ghost_metadata,
});

describe('isIncomingOrderAlertExempt', () => {
  it.each([
    ['manual check, object metadata', closedDecision('unknown')],
    ['manual check, local JSON text', JSON.stringify(closedDecision('unknown'))],
    ['not accepted', closedDecision('not_accepted')],
  ])('exempts a pending BOX order whose decision the server closed (%s)', (_label, metadata) => {
    const order = boxOrder(metadata);
    // It still looks like an order waiting for approval…
    expect(orderNeedsApproval(order)).toBe(true);
    // …but nobody can accept or decline it any more.
    expect(isIncomingOrderAlertExempt(order)).toBe(true);
    expect(isIncomingOrderAlertExempt({ ...order, ghost_metadata: undefined, ghostMetadata: metadata })).toBe(true);
  });

  it.each([
    ['no decision record', undefined],
    ['an open decision', { _the_small_box_decision: { version: 1, state: 'pending', action: 'accepted' } }],
    ['a confirmed decision', { _the_small_box_decision: { version: 1, state: 'confirmed', action: 'accepted' } }],
    ['unreadable metadata', '{not json'],
  ])('keeps alerting for a pending BOX order with %s', (_label, metadata) => {
    expect(isIncomingOrderAlertExempt(boxOrder(metadata))).toBe(false);
  });

  it('keeps alerting for other platforms and customer orders', () => {
    expect(isIncomingOrderAlertExempt({ id: 'ef-1', status: 'pending', plugin: 'efood', external_plugin_order_id: 'EF-1' })).toBe(false);
    expect(isIncomingOrderAlertExempt({ id: 'k-1', status: 'pending', plugin: 'kiosk', external_plugin_order_id: 'K-1' })).toBe(false);
    expect(isIncomingOrderAlertExempt(null)).toBe(false);
    expect(isIncomingOrderAlertExempt(undefined)).toBe(false);
  });
});
