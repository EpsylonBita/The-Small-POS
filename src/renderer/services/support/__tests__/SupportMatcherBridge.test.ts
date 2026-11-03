import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticsSystemHealth } from '../../../../lib';
import { matchHealthRemedies, readHealthRemedyMatches, registerSupportHealthObservation, type MatcherObservation } from '../SupportMatcherBridge';
import { buildSyncRecoveryIssues } from '../../../components/recovery/sync-recovery-issues';
import catalogue from '../../../../../src-tauri/generated/recovery-recipes.json';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
const health: DiagnosticsSystemHealth = { schemaVersion: 106, syncBacklog: {}, paymentAdjustmentBacklog: { genericDeferred: 0, waitingForParentPayment: 0, waitingForCanonicalRemotePaymentId: 0 },
  lastSyncTimes: {}, printerStatus: { configured: true, profileCount: 1, defaultProfile: 'your-printer', recentJobs: [] }, lastZReport: null,
  pendingOrders: 0, dbSizeBytes: 1, isOnline: true, lastSyncTime: null };
describe('Health-owned remedy matching', () => {
  it('never offers reconnect remotely', () => {
    expect(matchHealthRemedies({ systemHealth: health }, false, key => key).some(entry => entry.id === 'reconnect')).toBe(false);
  });
  it('supplies localized matches for every recipe shipped in the native catalogue', () => {
    const matches = matchHealthRemedies({ systemHealth: health }, false, key => key);
    expect(matches.map(entry => `${entry.id}:${entry.version}`).sort()).toEqual(catalogue.recipes.map(entry => `${entry.id}:${entry.version}`).sort());
  });
  it('uses the actual Health matcher for the same customer-address conflict and target', () => {
    const input = { systemHealth: health, parityItems: [{ id: 'your-row', tableName: 'customer_addresses', recordId: 'your-address', moduleType: 'customers', operation: 'UPDATE' as const,
      status: 'failed' as const, errorMessage: 'CUSTOMER_ADDRESS_DEFAULT_CONFLICT' }] };
    const manual = buildSyncRecoveryIssues(input).issues;
    const remote = matchHealthRemedies(input, false, key => key).find(entry => entry.id === 'customer-address-default-conflict.repair');
    expect(remote?.matches_now).toBe(true); expect(remote?.target_count).toBe(1);
    expect(remote?.targets[0]?.issue).toEqual(manual.find(issue => issue.knownSolution?.recipeId === remote.id));
  });
  it('keeps unavailable/stale distinct from healthy and never reports a false zero as fresh', async () => {
    expect(matchHealthRemedies({ systemHealth: null }, false, key => key).every(entry => entry.matches_now === 'not_applicable')).toBe(true);
    expect(matchHealthRemedies({ systemHealth: health }, true, key => key).every(entry => entry.matches_now === 'not_applicable')).toBe(true);
    mocks.invoke.mockRejectedValue(new Error('unavailable'));
    const matches = await readHealthRemedyMatches(key => key);
    expect(matches.every(entry => entry.matches_now === 'not_applicable' && entry.observation?.status === 'unavailable')).toBe(true);
    expect(matches.every(entry => entry.targets.length === 0 && entry.target_count === 0)).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('support_matcher_inputs');
  });
  it.each(['stale', 'unavailable'] as const)('labels %s evidence with its retained age and never returns healthy', async status => {
    const fresh = <T,>(content: T): MatcherObservation<T> => ({ status: 'fresh', at: new Date().toISOString(), age_ms: 0, content });
    mocks.invoke.mockResolvedValue({ systemHealth: fresh(health), financialItems: fresh([]), parityItems: fresh([]),
      integrity: { status, at: '2026-11-02T00:00:00Z', age_ms: 360_000, content: status === 'stale' ? { valid: true, issues: [] } : null } });
    const matches = await readHealthRemedyMatches(key => key);
    expect(matches.every(entry => entry.matches_now === 'not_applicable' && entry.target_count === 0 && entry.targets.length === 0)).toBe(true);
    expect(matches[0]?.observation).toMatchObject({ status, inputs: { integrity: { status, age_ms: 360_000 } } });
    expect(matches[0]?.explanation).toContain(`"status":"${status}"`);
    expect(matches[0]?.explanation).toContain('"age_ms":360000');
  });
  it('gets the three shipped Health actions from current Health observations and configured default printer', () => {
    const dispose = registerSupportHealthObservation({ problem: 'syncWaiting', realtime: 'disconnected', stale: false });
    const matches = matchHealthRemedies({ systemHealth: health }, false, key => key);
    expect(matches.find(entry => entry.id === 'reconnect')).toBeUndefined();
    expect(matches.find(entry => entry.id === 'testPrint')?.targets[0]?.key).toBe('your-printer');
    expect(matches.find(entry => entry.id === 'printerReprobe')?.target_count).toBe(1);
    expect(matches.find(entry => entry.id === 'syncNow')?.matches_now).toBe(false);
    dispose(); expect(matchHealthRemedies({ systemHealth: health }, false, key => key).find(entry => entry.id === 'testPrint')?.matches_now).toBe('not_applicable');
  });
  it('ages the retained Health classification even when no screen update arrives', () => {
    const dispose = registerSupportHealthObservation({ problem: 'syncWaiting', realtime: 'disconnected', stale: false, observedAt: Date.now() - 360_000 });
    try {
      const printer = matchHealthRemedies({ systemHealth: health }, false, key => key).find(entry => entry.id === 'testPrint');
      expect(printer?.matches_now).toBe('not_applicable');
      expect(printer?.observation).toMatchObject({ status: 'stale', inputs: { healthView: { age_ms: expect.any(Number) } } });
      expect(printer?.observation?.inputs.healthView.age_ms).toBeGreaterThanOrEqual(360_000);
    } finally { dispose(); }
  });
});
