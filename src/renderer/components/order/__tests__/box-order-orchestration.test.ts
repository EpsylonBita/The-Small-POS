import { describe, expect, it, vi } from 'vitest';
import { isBoxOrder, notifyOrderPlatformReady, runBoxApprovalDecision } from '../box-order-decision';

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
