import { describe, expect, it } from 'vitest';
import { selectActiveKitchenStage } from '../KitchenStageBadge';
import type { LocalPreparationSnapshot } from '../../../services/KdsLocalPhaseStore';

const snapshot = (phase: 'preparing' | 'ready' | 'collected'): LocalPreparationSnapshot => ({
  scope: 'org|branch|terminal',
  state: { order: { phase, at: '2026-09-28T00:00:00.000Z' } },
  error: null,
});

describe('central kitchen stage matches connected boards', () => {
  it('suppresses stale markers for ended, closed, ghost, Z-report and non-kitchen orders', () => {
    const ineligible = [
      ...['completed', 'delivered', 'cancelled', 'canceled', 'refunded', 'voided'].map(status => ({ status })),
      { status: 'ready', is_closed: true },
      { status: 'ready', order_is_closed: 1 },
      { status: 'ready', is_ghost: 1 },
      { status: 'ready', z_report_id: 'z-report' },
      { status: 'ready', order_context: 'repair_settlement' },
    ];
    for (const order of ineligible) {
      expect(selectActiveKitchenStage(snapshot('ready'), { id: 'order', ...order })).toBeUndefined();
    }
  });

  it('never visually downgrades a canonical-ready order and keeps collected on an unpaid active sale', () => {
    expect(selectActiveKitchenStage(snapshot('preparing'), { id: 'order', status: 'ready' })).toBe('ready');
    const unpaid = { id: 'order', status: 'pending', payment_status: 'unpaid', is_closed: false };
    expect(selectActiveKitchenStage(snapshot('collected'), unpaid)).toBe('collected');
    expect(unpaid).toEqual({ id: 'order', status: 'pending', payment_status: 'unpaid', is_closed: false });
  });
});
