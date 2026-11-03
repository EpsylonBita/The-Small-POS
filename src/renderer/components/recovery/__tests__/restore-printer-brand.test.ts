// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSyncRecoveryIssues } from '../sync-recovery-issues';
import type { DiagnosticsSystemHealth } from '../../../../lib';
import { readFileSync } from 'node:fs';

const health = (): DiagnosticsSystemHealth => ({ schemaVersion: 106, syncBacklog: {},
  paymentAdjustmentBacklog: { genericDeferred: 0, waitingForParentPayment: 0, waitingForCanonicalRemotePaymentId: 0 },
  lastSyncTimes: {}, printerStatus: { configured: true, profileCount: 1, defaultProfile: 'Front printer', recentJobs: [],
    brandRecovery: [{ code: 'printer.brand_probe_unanswered', printerId: 'your-printer',
      configuredPrinterRef: { id: 'your-printer', configuration_revision: 17 }, observedAt: new Date().toISOString() }] },
  lastZReport: null, pendingOrders: 0, dbSizeBytes: 0, isOnline: false, lastSyncTime: null });

describe('saved printer language Health binding', () => {
  it('provides the same four plain-language keys in all six desktop locales', () => {
    for (const locale of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
      const resource: { recovery: { recipes: { restoreLastKnownPrinterBrand: Record<string, string> } } } =
        JSON.parse(readFileSync(new URL(`../../../../locales/${locale}.json`, import.meta.url), 'utf8'));
      const translated = resource.recovery.recipes.restoreLastKnownPrinterBrand;
      expect(Object.keys(translated).sort()).toEqual(['explanation', 'label', 'title', 'verification']);
      for (const value of Object.values(translated)) {
        expect(value.length).toBeGreaterThan(10);
        expect(value).not.toContain('?');
      }
    }
  });
  it('offers the reviewed one-tap action offline from a fresh native observation', () => {
    const issue = buildSyncRecoveryIssues({ systemHealth: health() }).issues.find(value => value.code === 'printer.brand_probe_unanswered');
    expect(issue).toMatchObject({ entityType: 'printer', entityId: 'your-printer',
      params: { configuredPrinterRef: { id: 'your-printer', configuration_revision: 17 } },
      actions: [expect.objectContaining({ id: 'restoreLastKnownPrinterBrand', recipeId: 'printer.restore_last_known_brand',
        recipeVersion: 1, recommended: true, requiresOnline: false, requiresSnapshot: true }), expect.objectContaining({ id: 'contactDev' })] });
  });
  it('does not offer a write for stale, future or unavailable observations', () => {
    for (const time of [Date.now() - 60_001, Date.now() + 60_000]) {
      const observed = health();
      for (const entry of observed.printerStatus.brandRecovery ?? []) { entry.observedAt = new Date(time).toISOString(); }
      expect(buildSyncRecoveryIssues({ systemHealth: observed }).issues.some(issue => issue.code === 'printer.brand_probe_unanswered')).toBe(false);
    }
    const observed = health();
    observed.printerStatus.brandRecovery = null;
    expect(buildSyncRecoveryIssues({ systemHealth: observed }).issues.some(issue => issue.code === 'printer.brand_probe_unanswered')).toBe(false);
  });
  it('tolerates an older diagnostics payload with no printerStatus', () => {
    const { printerStatus: _omitted, ...older } = health();
    const issues = buildSyncRecoveryIssues({ systemHealth: older as DiagnosticsSystemHealth }).issues;
    expect(issues.some(issue => issue.code === 'printer.brand_probe_unanswered')).toBe(false);
  });
});
