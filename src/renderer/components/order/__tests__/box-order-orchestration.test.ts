import { describe, expect, it, vi } from 'vitest';
import {
  BOX_CLOSURE_CANCELLATION_REASONS,
  BOX_REJECTION_REASONS,
  boxClosedReasonLabelKey,
  boxDecisionFailureMessageKey,
  boxOrderStatusMutationAllowed,
  classifyBoxDecisionFailure,
  isBoxOrder,
  notifyOrderPlatformReady,
  runBoxApprovalDecision,
} from '../box-order-decision';
import { ErrorFactory } from '../../../../shared/utils/error-handler';

describe('BOX dashboard orchestration', () => {
  it.each(['box', 'box_gr', ' BOXGR '])('skips platform-ready notification for %s', async plugin => {
    const notify = vi.fn();
    expect(await notifyOrderPlatformReady({ plugin }, notify)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it('keeps efood notification and canonical source precedence', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    expect(isBoxOrder({ plugin: 'efood', platform: 'box' })).toBe(false);
    expect(await notifyOrderPlatformReady({ plugin: 'efood' }, notify)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
  });
  it('retains the panel and pending selection on a false decision', async () => {
    const closeAndRefresh = vi.fn();
    await expect(runBoxApprovalDecision(async () => false, closeAndRefresh)).rejects.toThrow('BOX decision failed');
    expect(closeAndRefresh).not.toHaveBeenCalled();
  });
  it('retains the panel when a decision throws', async () => {
    const closeAndRefresh = vi.fn();
    await expect(runBoxApprovalDecision(async () => { throw new Error('offline'); }, closeAndRefresh)).rejects.toThrow('offline');
    expect(closeAndRefresh).not.toHaveBeenCalled();
  });
  it('refreshes and closes only after a successful decision', async () => {
    const closeAndRefresh = vi.fn();
    await runBoxApprovalDecision(async () => true, closeAndRefresh);
    expect(closeAndRefresh).toHaveBeenCalledOnce();
  });
});

/** The server's closed record (06/10/2026); `unknown`: staff check the order with BOX. */
const closedDecision = (outcome: 'unknown' | 'not_accepted' = 'unknown') => ({
  _the_small_box_decision: {
    version: 1,
    state: 'closed',
    closure: {
      reason: 'expired',
      outcome,
      manual_check: outcome === 'unknown',
      code: 'BOX_DECISION_EXPIRED',
      closed_at: '2026-10-06T10:00:00Z',
    },
  },
});

describe('BOX decision the server closed', () => {
  it.each([
    ['object metadata', closedDecision()],
    ['local JSON text', JSON.stringify(closedDecision())],
    ['not accepted', closedDecision('not_accepted')],
  ])('lets staff close the pending order locally (%s)', (_label, ghost_metadata) => {
    const order = { plugin: 'box', status: 'pending', ghost_metadata };
    expect(boxOrderStatusMutationAllowed(order, 'cancelled')).toBe(true);
    expect(boxOrderStatusMutationAllowed(order, 'canceled')).toBe(true);
    expect(boxOrderStatusMutationAllowed(order, 'pending')).toBe(true);
    // Never a fulfilment of an order BOX did not confirm.
    for (const next of ['confirmed', 'preparing', 'ready', 'delivered', 'completed', 'rejected']) {
      expect(boxOrderStatusMutationAllowed(order, next)).toBe(false);
    }
  });

  it('keeps refusing a plain cancel of a pending BOX order whose decision is open or unreadable', () => {
    for (const ghost_metadata of [
      undefined,
      {},
      '{not json',
      { _the_small_box_decision: { version: 1, state: 'pending', action: 'accepted' } },
      { _the_small_box_decision: { version: 1, state: 'confirmed', action: 'rejected' } },
    ]) {
      expect(boxOrderStatusMutationAllowed({ plugin: 'box', status: 'pending', ghost_metadata }, 'cancelled')).toBe(false);
      expect(boxOrderStatusMutationAllowed({ plugin: 'box', status: 'pending', ghost_metadata }, 'canceled')).toBe(false);
    }
  });

  it('keeps decisions and decided orders as they were', () => {
    const pending = { plugin: 'box', status: 'pending', ghost_metadata: closedDecision() };
    // A pending accept / decline still reaches the server, which refuses it typed.
    expect(boxOrderStatusMutationAllowed(pending, 'confirmed', { kind: 'accept', estimatedTime: 20 })).toBe(true);
    expect(boxOrderStatusMutationAllowed(pending, 'cancelled', { kind: 'reject', reason: BOX_REJECTION_REASONS[0] })).toBe(true);
    expect(boxOrderStatusMutationAllowed(pending, 'cancelled', { kind: 'reject', reason: 'box_manual_check_closed' })).toBe(false);
    for (const status of ['cancelled', 'confirmed']) {
      const order = { ...pending, status };
      expect(boxOrderStatusMutationAllowed(order, 'cancelled')).toBe(false);
      expect(boxOrderStatusMutationAllowed(order, 'pending')).toBe(false);
      expect(boxOrderStatusMutationAllowed(order, 'confirmed', { kind: 'accept', estimatedTime: 20 })).toBe(false);
    }
    // Other platforms are not BOX's to guard.
    expect(boxOrderStatusMutationAllowed({ plugin: 'efood', status: 'pending', ghost_metadata: closedDecision() }, 'cancelled')).toBe(true);
  });
});

describe('BOX decision failures', () => {
  const nativeRefusal = (code: string) => `BOX decision refused (HTTP 400, ${code}); refresh the order`;
  const storeError = (thrown: unknown) => ErrorFactory.businessLogic('Failed to approve order', { error: thrown });

  it('reads the typed refusal the order store keeps in its error details', () => {
    expect(classifyBoxDecisionFailure(new Error('BOX decision failed'), storeError(nativeRefusal('BOX_DECISION_MANUAL_CHECK'))))
      .toBe('manual_check');
    for (const code of ['BOX_DECISION_CLOSED', 'BOX_DECISION_EXPIRED', 'BOX_DECISION_REFUSED']) {
      expect(classifyBoxDecisionFailure(storeError(nativeRefusal(code)))).toBe('closed');
      expect(classifyBoxDecisionFailure(storeError(new Error(nativeRefusal(code))))).toBe('closed');
    }
    expect(classifyBoxDecisionFailure({ code: 'BOX_DECISION_MANUAL_CHECK' })).toBe('manual_check');
    expect(classifyBoxDecisionFailure({ cause: { details: { error: nativeRefusal('BOX_DECISION_CLOSED') } } })).toBe('closed');
  });

  it('leaves an ordinary or unknown failure retryable', () => {
    expect(classifyBoxDecisionFailure(new Error('BOX decision failed'), null)).toBeNull();
    expect(classifyBoxDecisionFailure(storeError('BOX decision is not confirmed; check connection and retry if still pending'))).toBeNull();
    expect(classifyBoxDecisionFailure(storeError(nativeRefusal('BOX_UNAVAILABLE')))).toBeNull();
    expect(classifyBoxDecisionFailure(undefined, 42, {})).toBeNull();
    // A cyclic error never loops.
    const cyclic: Record<string, unknown> = { message: 'offline' };
    cyclic.cause = cyclic;
    expect(classifyBoxDecisionFailure(cyclic)).toBeNull();
  });

  it('maps each kind to its operator message', () => {
    expect(boxDecisionFailureMessageKey('manual_check')).toBe('boxOrder.manualCheck');
    expect(boxDecisionFailureMessageKey('closed')).toBe('boxOrder.decisionClosed');
    expect(boxDecisionFailureMessageKey(null)).toBe('boxOrder.decisionUnconfirmed');
  });
});

describe('BOX closed-decision cancellation reasons', () => {
  it('labels exactly the three closure codes', () => {
    for (const code of Object.values(BOX_CLOSURE_CANCELLATION_REASONS)) {
      expect(boxClosedReasonLabelKey(code)).toBe(`boxOrder.closedReasons.${code}`);
      expect(boxClosedReasonLabelKey(` ${code} `)).toBe(`boxOrder.closedReasons.${code}`);
    }
    for (const reason of [BOX_REJECTION_REASONS[0], 'Customer left', '', null, undefined, 'box_decision']) {
      expect(boxClosedReasonLabelKey(reason)).toBeNull();
    }
  });
});
