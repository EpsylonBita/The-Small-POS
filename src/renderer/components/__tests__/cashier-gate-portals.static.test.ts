/**
 * A body portal escapes the locked till's inert operational subtree. Every new
 * portal must be reviewed: hide operational blockers while locked, explicitly
 * mark recovery roots, or prove the surface cannot block recovery controls.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type PortalReview = {
  /** Every reviewed portal must have working handling; no gap exemptions. */
  classification: 'gate-aware' | 'recovery' | 'non-blocking';
  reason: string;
};
const portalReview: Record<string, PortalReview> = {
  'components/FinancialSyncPanel.tsx': { classification: 'recovery', reason: 'Financial sync opens from Health; its root explicitly marks cashier recovery.' },
  'components/PortaledToaster.tsx': { classification: 'non-blocking', reason: 'Toast notifications have no blocking backdrop.' },
  'components/SyncStatusIndicator.tsx': { classification: 'recovery', reason: 'Health portal root explicitly marks cashier recovery.' },
  'components/UtilityRail.tsx': { classification: 'gate-aware', reason: 'The rail is a recovery root for Health; its expenses slot portal unmounts while the cashier gate is locked.' },
  'components/callerid/CallerIdMinimizedPanel.tsx': { classification: 'non-blocking', reason: 'Small movable caller-ID panel has no backdrop.' },
  'components/menu/MenuItemGrid.tsx': { classification: 'gate-aware', reason: 'Preview pointer catcher stays mounted but hidden and inert while locked.' },
  'components/modals/LoyaltyRedeemModal.tsx': { classification: 'gate-aware', reason: 'Redemption draft stays mounted but hidden and inert while locked.' },
  'components/notices/IncomingOrderAlertHost.tsx': { classification: 'gate-aware', reason: 'Reads the cashier lock, exposes check-in and yields to recovery dialogs.' },
  'components/recovery/SyncRecoveryModal.tsx': { classification: 'recovery', reason: 'Sync recovery portal root explicitly marks cashier recovery.' },
  'components/tables/TableCheckManagerModal.tsx': { classification: 'gate-aware', reason: 'Main check and separate secondary sheets hide and suspend Escape while locked.' },
  'components/ui/FloatingActionButton.tsx': { classification: 'non-blocking', reason: 'Floating action button has no full-screen backdrop.' },
  'components/ui/pos-glass-components.tsx': { classification: 'gate-aware', reason: 'Both glass modals preserve drafts, hide operational portals and release isolation while locked.' },
  'pages/LoginPage.tsx': { classification: 'non-blocking', reason: 'App returns the login layer while logged out, before mounting GlobalCashierGate. Signed in, it mounts only as the brief sign-in / sign-out cover (loginExit), with no PIN entry left to fence.' },
  'pages/TablesPage.tsx': { classification: 'gate-aware', reason: 'Table status changer stays mounted but hidden and inert while locked.' },
  'pages/verticals/salon/StaffScheduleView.tsx': { classification: 'gate-aware', reason: 'Schedule preview and shift backdrops hide and suspend Escape while locked.' },
};
const renderer = path.resolve(__dirname, '../..');
function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(absolute) : /\.tsx$/.test(entry.name) && !/\.(test|spec)\.tsx$/.test(entry.name) ? [absolute] : [];
  });
}

describe('cashier-gate portal classification', () => {
  it('requires explicit review of every renderer createPortal file', () => {
    const portals = tsxFiles(renderer).filter((file) => /\bcreatePortal\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(renderer, file).replaceAll('\\', '/')).sort();
    const missing = portals.filter((file) => !portalReview[file]);
    expect(missing, 'Unclassified body portal: the locked cashier gate fences clicks outside recovery roots. Hide full-screen operational portals while locked, mark recovery roots data-cashier-recovery="true", or document why there is no blocking backdrop.').toEqual([]);
    expect(Object.keys(portalReview).sort(), 'Remove stale portal classifications after reviewing the replacement surface.').toEqual(portals);
    for (const file of portals) {
      const review = portalReview[file];
      expect(review.reason.trim().length).toBeGreaterThan(0);
      expect(review).not.toHaveProperty('knownGap');
      const source = readFileSync(path.join(renderer, file), 'utf8');
      if (review.classification === 'gate-aware') {
        expect(source, `${file} must implement its gate-aware classification`).toMatch(/\b(useCashierPortalProps|useCashierOperationsLocked)\s*\(|\bcashierLocked\b/);
      } else if (review.classification === 'recovery') {
        expect(source, `${file} must mark its recovery root`).toContain('data-cashier-recovery="true"');
      }
    }
  });

  it('keeps the incoming-order alert gate-aware', () => {
    const file = 'components/notices/IncomingOrderAlertHost.tsx';
    expect(portalReview[file].classification).toBe('gate-aware');
    expect(readFileSync(path.join(renderer, file), 'utf8')).toMatch(/\buseCashierOperationsLocked\s*\(/);
  });

  it('keeps login outside the mounted cashier gate', () => {
    const app = readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
    // Logged out, App returns only the login layer: no GlobalCashierGate exists yet.
    const loggedOutStart = app.indexOf('if (!user) {', app.indexOf('// Show login'));
    const loggedOut = app.slice(loggedOutStart, app.indexOf('// Show main POS interface', loggedOutStart));
    expect(loggedOut).toContain('{loginLayer}');
    expect(loggedOut).not.toContain('<GlobalCashierGate');
    // The login layer holds LoginPage; signed in, it exists only as the sign-in / sign-out cover.
    const layerStart = app.indexOf('const loginLayer = ');
    expect(app.slice(layerStart, layerStart + 80)).toMatch(/const loginLayer = !user \|\| loginExit !== null \?/);
    expect(app.indexOf('<LoginPage', layerStart)).toBeGreaterThan(layerStart);
    expect(app.indexOf('<LoginPage', layerStart)).toBeLessThan(app.indexOf('<GlobalCashierGate'));
  });
});
