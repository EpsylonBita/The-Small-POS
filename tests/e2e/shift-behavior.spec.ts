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
const SELECT_STAFF_SECTION = 'data-testid=staff-select-section';
const CHECKOUT_SECTION = 'data-testid=staff-checkout-section';

// NOTE: The modal currently has no testid hooks for sections; we fall back to text probes
function staffListProbe(page: Page) {
  return page.getByText(/(Staff|Προσωπικό|Select.*Staff|Επιλέξτε)/i);
}
function checkoutProbe(page: Page) {
  return page.getByText(/(End Shift|Checkout|Τερματισμός βάρδιας|Κλείσιμο)/i);
}

// Sanity: the app should boot with no active shift
// Then: clicking Check In opens the Staff list (no active shift)
// Optional: if exactly one active shift exists, the modal auto-switches to Checkout.

test.describe('Shift modal behavior', () => {
  test('When no active shift: Check In opens staff list; when one active shift: auto-opens checkout', async () => {
    const { app, page } = await launchElectron();

    try {
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
      const sawStaffList = await staffListProbe(page).first().isVisible().catch(() => false);
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
        const sawCheckout = await checkoutProbe(page).first().isVisible().catch(() => false);
        expect(sawCheckout).toBeTruthy();
        await page.keyboard.press('Escape');
      }
    } finally {
      await app.close();
    }
  });
});

