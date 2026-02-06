import path from 'path';
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';

const POS_ROOT = path.resolve(__dirname, '..', '..');
const shouldRun = process.env.ELECTRON_E2E === '1';

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [POS_ROOT] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

test.describe('Z report smoke (electron)', () => {
  test.skip(!shouldRun, 'Requires ELECTRON_E2E=1 and Electron app access');

  test('can open and close a cashier shift then generate a Z report', async () => {
    const { app, page } = await launchElectron();

    try {
      const result = await page.evaluate(async () => {
        const api = (window as any).electronAPI;
        const terminalId = await api.getTerminalId();
        const rawBranchId = await api.getTerminalBranchId();
        const branchId = rawBranchId || 'test-branch';
        const makeId = () => {
          try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
              return crypto.randomUUID();
            }
          } catch { /* ignore */ }
          return `test-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
        };
        const staffId = makeId();
        const unwrap = (res: any) => (res && res.success && res.data ? res.data : res);

        const openRes = unwrap(await api.openShift({
          staffId,
          staffName: 'Test Cashier',
          branchId,
          terminalId,
          roleType: 'cashier',
          openingCash: 100
        }));

        if (!openRes?.success) {
          return { ok: false, error: openRes?.error || 'openShift failed', step: 'openShift', details: openRes };
        }
        if (!openRes?.shiftId) {
          return { ok: false, error: `openShift did not return shiftId: ${JSON.stringify(openRes)}`, step: 'openShift', details: openRes };
        }

        const closeRes = unwrap(await api.closeShift({
          shiftId: openRes.shiftId,
          closingCash: 100,
          closedBy: staffId
        }));

        if (!closeRes?.success) {
          return { ok: false, error: closeRes?.error || 'closeShift failed', step: 'closeShift', details: closeRes };
        }

        const date = new Date().toISOString().slice(0, 10);
        const report = unwrap(await api.generateZReport({ branchId, date }));

        return { ok: true, report, branchId };
      });

      if (!result.ok) {
        throw new Error(result.error || 'E2E flow failed');
      }
      expect(result.report).toBeTruthy();
      expect(result.report.shifts.total).toBeGreaterThanOrEqual(1);
      expect(result.report.sales.totalOrders).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });
});
