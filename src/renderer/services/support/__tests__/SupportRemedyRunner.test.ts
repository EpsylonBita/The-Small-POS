import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryActionDescriptor, RecoveryIssue } from '../../../../lib';
import { acquireRecoveryAction, executeHealthRecoveryAction, SupportRemedyRunner, buildRecoveryActionRequest, type OnsiteDecision, type SupportRunnerOptions } from '../SupportRemedyRunner';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), execute: vi.fn(), log: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ recovery: { createPreActionSnapshot: mocks.snapshot, executeAction: mocks.execute, recordActionLog: mocks.log } }), onEvent: mocks.on, offEvent: mocks.off }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.on }));
const action: RecoveryActionDescriptor = { id: 'repairPaymentTotalConflict', recipeId: 'payment-total-conflict.repair', recipeVersion: 1,
  labelKey: 'label', requiresSnapshot: true, safetyLevel: 'safe', requiresOnline: true, confirmationRequired: false };
const issue: RecoveryIssue = { id: 'your-issue', entityId: 'your-entity', entityType: 'order', code: 'payment_total_conflict',
  severity: 'warning', status: 'blocking', titleKey: 'title', summaryKey: 'summary', guidanceKey: 'guide', actions: [action] };
const input = { request_id: 'your-request', session_id: 'your-session', recipe_id: 'payment-total-conflict.repair', recipe_version: 1 };
function setup(overrides: Partial<SupportRunnerOptions> = {}) {
  const ipc = vi.fn().mockResolvedValue({}), onsite = vi.fn().mockResolvedValue('confirmed');
  const options: SupportRunnerOptions = { t: key => key, authorize: ({ action: run }) => run(), onsite, critical: () => false,
    sessionId: () => input.session_id, ipc,
    matches: vi.fn().mockResolvedValue([{ id: input.recipe_id, version: 1, title: 'Shipped', explanation: 'Shipped explanation',
      matches_now: true, target_count: 1, targets: [{ key: issue.id, issue, action }] }]), ...overrides };
  return { options, ipc, onsite, runner: new SupportRemedyRunner(options) };
}
beforeEach(() => { mocks.log.mockResolvedValue({ id: 'your-audit' }); mocks.on.mockResolvedValue(mocks.off); mocks.snapshot.mockResolvedValue({ id: 'your-snapshot' }); mocks.execute.mockResolvedValue({ success: true, requiresRefresh: true, verification: { status: 'pending' } }); });
afterEach(() => vi.clearAllMocks());
describe('remote Health execution', () => {
  it('refuses reconnect from the real shipped matcher without executing an action', async () => {
    const { runner, ipc } = setup({ matches: async () => (await import('../SupportMatcherBridge')).matchHealthRemedies({ systemHealth: null }, false, key => key) });
    await runner.run({ ...input, recipe_id: 'reconnect' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE' }));
  });
  it.each([
    ['customer-address-default.retry', 'nativeCustomerAddressDefaultRetry', true],
    ['printerReprobe', 'printerReprobe', false], ['testPrint', 'testPrint', false],
  ] as const)('uses manual snapshot, execution and attributed audit for %s', async (recipeId, actionId, snapshot) => {
    const healthAction = { ...action, id: actionId, recipeId, requiresSnapshot: snapshot };
    const healthIssue = { ...issue, actions: [healthAction] };
    const { runner } = setup({ matches: async () => [{ id: recipeId, version: 1, title: 'Title', explanation: 'Explanation',
      matches_now: true, target_count: 1, targets: [{ key: issue.id, issue: healthIssue, action: healthAction }] }] });
    await runner.run({ ...input, recipe_id: recipeId });
    expect(mocks.snapshot).toHaveBeenCalledTimes(Number(snapshot));
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ actionId, supportRequestId: input.request_id, source: 'remote_support', sessionId: input.session_id }));
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ actionId, recipeId, source: 'remote_support', sessionId: input.session_id }));
    expect(mocks.log.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]);
  });
  it('rechecks native matches after the PIN wait before the existing action can execute', async () => {
    let stale = false;
    const base = setup();
    const { runner, ipc } = setup({ authorize: async ({ action: run }) => { stale = true; return run(); },
      matches: async () => stale ? [] : await base.options.matches?.() ?? [] });
    await runner.run(input);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE' }));
  });
  it('carries structured native authorization refusal codes without their private prose', async () => {
    mocks.execute.mockRejectedValue({ code: 'FORBIDDEN', reason: 'your private text' });
    const { runner, ipc } = setup(); await runner.run(input);
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE', app_refusal: 'FORBIDDEN' }));
    expect(JSON.stringify(ipc.mock.calls)).not.toContain('your private text');
  });
  it('confirms attended mutations, snapshots, uses the app guard and returns pending evidence rather than claiming healing', async () => {
    const { runner, onsite, ipc } = setup(); await runner.run(input);
    expect(onsite).toHaveBeenCalledOnce(); expect(mocks.snapshot).toHaveBeenCalledOnce(); expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote_support', sessionId: input.session_id }));
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ source: 'remote_support', sessionId: input.session_id, success: false, outcome: 'pending' }));
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ onsite: 'confirmed', snapshot_id: 'your-snapshot',
      results: [expect.objectContaining({ verification: { status: 'pending' } })] }));
  });
  it.each([[true, false, 1], [false, true, 1], [true, true, 0]] as const)('unattended %s verified %s requires %s confirmations', async (unattended, unattended_verified, confirmations) => {
    const { runner, onsite } = setup(); await runner.run({ ...input, unattended, unattended_verified }); expect(onsite).toHaveBeenCalledTimes(confirmations);
  });
  it.each(['declined', 'timeout'] as OnsiteDecision[])('does not run after %s', async decision => {
    const { runner, ipc } = setup({ onsite: async () => decision }); await runner.run(input);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: decision === 'timeout' ? 'ONSITE_TIMEOUT' : 'ONSITE_DECLINED' }));
  });
  it('shares the manual action lock and cannot run during checkout', async () => {
    const release = acquireRecoveryAction(); expect(release).not.toBeNull();
    try { const { runner, ipc } = setup(); await runner.run(input); expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'CONCURRENT_OPERATION' })); }
    finally { release?.(); }
    const { runner, ipc } = setup({ critical: () => true }); await runner.run(input);
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'CONCURRENT_OPERATION' })); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rechecks applicability after confirmation; stale diagnostics refuse instead of fabricating zero matches', async () => {
    let stale = false;
    const { runner, ipc } = setup({ onsite: async () => { stale = true; return 'confirmed'; }, matches: async () => stale ? [] : [{
      id: input.recipe_id, version: 1, title: 'Title', explanation: 'Explanation', matches_now: true, target_count: 1, targets: [{ key: issue.id, issue, action }],
    }] });
    await runner.run(input); expect(mocks.execute).not.toHaveBeenCalled(); expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE' }));
  });
  it('rejects an unknown version/target and deduplicates request IDs', async () => {
    const { runner, ipc } = setup(); await runner.run({ ...input, recipe_version: 2 }); await runner.run(input);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(ipc).toHaveBeenCalledOnce();
    await runner.run({ ...input, request_id: 'your-other-request', target_key: 'unknown' }); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('never treats support-connect as app authorization and releases the lock on refusal', async () => {
    const { runner, ipc } = setup({ authorize: async () => { throw new Error('FORBIDDEN'); } }); await runner.run(input);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE' }));
    const release = acquireRecoveryAction(); expect(release).not.toBeNull(); release?.();
  });
  it('returns an explicit failure when the existing action reports failure without throwing', async () => {
    mocks.execute.mockResolvedValue({ success: false, requiresRefresh: true });
    const { runner, ipc } = setup(); await runner.run(input);
    expect(ipc).toHaveBeenCalledWith('support_remedy_result', expect.objectContaining({ error: 'REMEDY_NOT_APPLICABLE', targets_applied: 0,
      results: [expect.objectContaining({ success: false })] }));
  });
  it('checks stale state and snapshot acknowledgement in the same executor used by manual Health', async () => {
    const options = { request: buildRecoveryActionRequest(issue, action), action, stale: () => true, authorize: setup().options.authorize, t: (key: string) => key };
    await expect(executeHealthRecoveryAction(options)).rejects.toThrow('REMEDY_NOT_APPLICABLE'); expect(mocks.snapshot).not.toHaveBeenCalled();
    mocks.snapshot.mockResolvedValue({}); await expect(executeHealthRecoveryAction({ ...options, stale: () => false })).rejects.toThrow('Recovery snapshot was not confirmed'); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('registers and removes the exact native event listeners', async () => {
    const stop = setup().runner.start(); expect(mocks.on).toHaveBeenCalledWith('support://run-remedy', expect.any(Function));
    expect(mocks.on).toHaveBeenCalledWith('till_list_remedies', expect.any(Function)); await Promise.resolve(); stop(); expect(mocks.off).toHaveBeenCalledTimes(2);
  });
});
