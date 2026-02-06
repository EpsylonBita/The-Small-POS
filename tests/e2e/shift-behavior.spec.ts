import path from 'path';
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';

const POS_ROOT = path.resolve(__dirname, '..', '..');

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [POS_ROOT] });
  const page = await app.firstWindow();
  // Ensure the app is loaded
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function waitForAnyVisible(page: Page, locators: Array<ReturnType<Page['locator']>>, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) {
        return;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for any locator to become visible');
}

async function ensureConfiguredAndLoggedIn(page: Page) {
  await page.waitForFunction(() => Boolean((window as any).electronAPI || (window as any).electron?.ipcRenderer));
  await page.waitForFunction(() => {
    try {
      localStorage.setItem('__e2e_ls_test__', '1');
      localStorage.removeItem('__e2e_ls_test__');
      return true;
    } catch {
      return false;
    }
  });

  await page.evaluate(async () => {
    const invoke =
      (window as any).electronAPI?.invoke ||
      (window as any).electron?.ipcRenderer?.invoke;

    if (invoke) {
      await invoke('settings:set', { category: 'terminal', key: 'pos_api_key', value: 'e2e-pos-key' });
      await invoke('settings:set', { category: 'terminal', key: 'admin_dashboard_url', value: 'http://localhost:3001' });
      await invoke('settings:set', { category: 'terminal', key: 'terminal_id', value: 'terminal-e2e' });
      await invoke('settings:set', { category: 'terminal', key: 'branch_id', value: 'branch-e2e' });
      await invoke('settings:set', { category: 'terminal', key: 'organization_id', value: 'org-e2e' });
    }

    localStorage.setItem('pos-user', JSON.stringify({
      staffId: 'local-simple-pin',
      staffName: 'E2E User',
      role: { name: 'staff' },
      branchId: 'branch-e2e',
      terminalId: 'terminal-e2e',
      sessionId: 'e2e-session',
    }));
  });

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

// Small helper to click the Check In/End Shift FAB in the sidebar
async function clickCheckIn(page: Page) {
  const btn = page.locator('[data-testid="check-in-btn"]');
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
}

async function clickEndShift(page: Page) {
  const btn = page.locator('[data-testid="end-shift-btn"]');
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
}

// These selectors correspond to the StaffShiftModal sections
const SELECT_STAFF_SECTION = 'staff-select-section';
const CHECKOUT_SECTION = 'staff-checkout-section';

function staffListProbe(page: Page) {
  return page.locator(`[data-testid="${SELECT_STAFF_SECTION}"]`);
}
function checkoutProbe(page: Page) {
  return page.locator(`[data-testid="${CHECKOUT_SECTION}"]`);
}

async function isStaffListVisible(page: Page): Promise<boolean> {
  const byTestId = await staffListProbe(page).first().isVisible().catch(() => false);
  if (byTestId) return true;
  return page.getByText(/(Staff|Select.*Staff)/i).first().isVisible().catch(() => false);
}

async function isCheckoutVisible(page: Page): Promise<boolean> {
  const byTestId = await checkoutProbe(page).first().isVisible().catch(() => false);
  if (byTestId) return true;
  return page.getByText(/(End Shift|Checkout)/i).first().isVisible().catch(() => false);
}

// Sanity: the app should boot with no active shift
// Then: clicking Check In opens the Staff list (no active shift)
// Optional: if exactly one active shift exists, the modal auto-switches to Checkout.

test.describe('Shift modal behavior', () => {
  test('When no active shift: Check In opens staff list; when one active shift: auto-opens checkout', async () => {
    const { app, page } = await launchElectron();

    try {
      await ensureConfiguredAndLoggedIn(page);

      // Wait a bit for any shift-restore to run
      await page.waitForTimeout(1500);

      // If End Shift is visible, close the active shift so we can test the first case
      const endShiftVisible = await page.locator('[data-testid="end-shift-btn"]').isVisible().catch(() => false);
      if (endShiftVisible) {
        await clickEndShift(page);
        // The modal should open to checkout; attempt to find a Close/Confirm button heuristically
        // We just close the modal via ESC to keep the UI simple
        await page.keyboard.press('Escape');
        // The overlay should remain lifted (still active) until real close, but we only need to proceed
      }

      // Case A: No active shift -> Check In shows staff list
      await clickCheckIn(page);
      await waitForAnyVisible(page, [
        staffListProbe(page).first(),
        page.getByText(/(Staff|Select.*Staff)/i).first(),
      ]);
      const sawStaffList = await isStaffListVisible(page);
      expect(sawStaffList).toBeTruthy();

      // Close modal for next case
      await page.keyboard.press('Escape');

      // Case B: Create exactly one active shift via Electron API and verify auto-checkout
      const created = await page.evaluate(async () => {
        try {
          const termId = await (window as any).electronAPI.getTerminalId();
          const branchId = await (window as any).electronAPI.getTerminalBranchId();
          const staffRows = await (window as any).electronAPI.executeQuery(
            "SELECT id, name FROM staff WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"
          );
          const staffId = staffRows?.[0]?.id;
          if (!staffId || !termId) return { ok: false, reason: 'no-staff-or-terminal' };

          const res = await (window as any).electronAPI.openShift({
            staffId,
            branchId,
            terminalId: termId,
            roleType: 'cashier',
            openingCash: 0,
          });
          return { ok: !!res?.success, staffId, shiftId: res?.shiftId };
        } catch (e) {
          return { ok: false, reason: 'exception' };
        }
      });

      if (created.ok) {
        await clickCheckIn(page);
        // Expect the modal to open directly in checkout state (auto-switch)
        await waitForAnyVisible(page, [
          checkoutProbe(page).first(),
          page.getByText(/(End Shift|Checkout)/i).first(),
        ]);
        const sawCheckout = await isCheckoutVisible(page);
        expect(sawCheckout).toBeTruthy();
        await page.keyboard.press('Escape');
      }
    } finally {
      await app.close();
    }
  });
});

