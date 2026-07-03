#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(projectRoot, 'tests');
const outDir = path.join(projectRoot, 'node_modules', '.cache', 'parity-tests');

const entryPoints = [
  path.join(testsRoot, 'services', 'RealtimeManager.test.ts'),
  path.join(testsRoot, 'services', 'SyncQueueBridge.test.ts'),
  path.join(testsRoot, 'services', 'ParitySyncCoordinator.test.ts'),
  path.join(testsRoot, 'services', 'offline-page-capabilities.test.ts'),
  path.join(testsRoot, 'services', 'VerticalOfflineFlows.test.ts'),
  path.join(testsRoot, 'services', 'supplier-import-parser.test.ts'),
  path.join(testsRoot, 'scripts', 'update-release-notes.test.ts'),
  path.join(testsRoot, 'pages', 'OrderDetailsModal.test.tsx'),
  // Wave 0 regression tests — currently `test.skip`, un-skip as each
  // Critical fix lands in its wave. See
  // D:\The-Small-002\planning\claude\now-create-a-plan-vivid-sutton.md.
  path.join(testsRoot, 'renderer', 'session-storage.test.ts'),
  path.join(testsRoot, 'renderer', 'login-migration.test.ts'),
  path.join(testsRoot, 'renderer', 'login-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'orders-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-category-tabs-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-modal-customer-popover.test.ts'),
  path.join(testsRoot, 'renderer', 'modal-escape-native-menu-focus.test.ts'),
  path.join(testsRoot, 'renderer', 'manual-address-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'order-modal-plural-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'order-edit-modals-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'order-modal-totals.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-cart-line-discounts.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-item-card-currency.test.ts'),
  path.join(testsRoot, 'renderer', 'order-card-currency.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-financials.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-delta-modal.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-options-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-customer-info-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'customer-search-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'expense-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-item-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'payment-method-cards-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'payment-modal-terminal-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'pos-greek-flow-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'tables-cleaning-card-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'refund-void-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'reservation-form-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'reservations-view-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'reservation-timeline.test.ts'),
  path.join(testsRoot, 'renderer', 'rooms-view-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'appointments-view-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'housekeeping-view-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'housekeeping-fallback.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-schedule-date-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-schedule-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-shift-duration.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-schedule-role-filter-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-shift-role-labels.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-flow.test.ts'),
  path.join(testsRoot, 'renderer', 'split-payment-discount-persistence.test.ts'),
  path.join(testsRoot, 'renderer', 'split-payment-currency.test.ts'),
  path.join(testsRoot, 'renderer', 'checkout-failure-contract.test.ts'),
  // THE-324: retail checkout money/order-item seam — fee-exclusive total
  // contract with OrderFlow and offer-reward lines mapped to real UUIDs.
  path.join(testsRoot, 'renderer', 'retail-checkout-money-contract.test.ts'),
  path.join(testsRoot, 'renderer', 'delivery-zones-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-schedule-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'module-context-sync.test.ts'),
  path.join(testsRoot, 'renderer', 'suppliers-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'inventory-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'coupon-loyalty-scan-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'loyalty-redemption-checkout.test.ts'),
  path.join(testsRoot, 'renderer', 'users-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'user-directory-filters.test.ts'),
  path.join(testsRoot, 'renderer', 'custom-titlebar-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'navigation-sidebar-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'i18n-labels.test.ts'),
  path.join(testsRoot, 'renderer', 'remaining-page-headers-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'payment-terminals-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'settings-modal-ui.test.ts'),
  // Settings > Data > Local Recovery: guards that the selected recovery detail never renders raw snapshot/
  // terminal/branch identifiers or filesystem paths (cashier-facing). Registered here so the guard actually
  // runs in the parity suite -- it previously existed but was never executed by this runner.
  path.join(testsRoot, 'renderer', 'recovery-panel-ui.test.ts'),
  // Sync recovery assistant (RecoveryCenterPanel): guards that the visible summary cards render friendly
  // names/labels only -- never the raw terminalId/branchId/organizationId UUIDs -- while internal action-log
  // IDs are preserved.
  path.join(testsRoot, 'renderer', 'recovery-center-panel-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'update-changelog-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'z-report-closeout-sync.test.ts'),
  path.join(testsRoot, 'renderer', 'z-report-action-rail-scroll.test.ts'),
  path.join(testsRoot, 'renderer', 'display-pages-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'order-number-utils.test.ts'),
  path.join(testsRoot, 'renderer', 'table-order-flow.test.ts'),
  path.join(testsRoot, 'renderer', 'orders-table-customer-display.test.ts'),
  path.join(testsRoot, 'renderer', 'table-check-manager-display.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-modal-coupon-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'connectivity-status-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'table-floor-plan.test.ts'),
  path.join(testsRoot, 'renderer', 'tables-action-modal-portal.test.ts'),
  path.join(testsRoot, 'renderer', 'vertical-modal-portals.test.ts'),
  path.join(testsRoot, 'renderer', 'inline-overlay-portals.test.ts'),
  path.join(testsRoot, 'renderer', 'table-selector-i18n.test.ts'),
  path.join(testsRoot, 'renderer', 'service-catalog-route.test.ts'),
  path.join(testsRoot, 'renderer', 'service-catalog-stats.test.ts'),
  path.join(testsRoot, 'renderer', 'service-catalog-management.test.ts'),
  path.join(testsRoot, 'renderer', 'tables-page-status-modal-portal.test.ts'),
  path.join(testsRoot, 'renderer', 'table-grid-scroll-reset.test.ts'),
  path.join(testsRoot, 'renderer', 'tables-page-new-order-terminal-gate.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-shift-checkout-print.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-shift-closeout-inline-forms.test.ts'),
  path.join(testsRoot, 'renderer', 'kds-live-draft-sync.test.ts'),
  // Wave 8 H29 regression: corrupt keyring blob must be rejected by
  // validateSecureSessionUser AND the keyring entry must be cleared.
  path.join(testsRoot, 'renderer', 'secure-session-validation.test.ts'),
  path.join(testsRoot, 'renderer', 'privileged-actions.test.ts'),
  path.join(testsRoot, 'renderer', 'reset-actions.test.ts'),
];

await fs.mkdir(outDir, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints,
  outdir: outDir,
  outbase: testsRoot,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'silent',
  external: ['node:test', 'node:assert/strict'],
});

const outFiles = entryPoints.map((entryPoint) =>
  path.join(
    outDir,
    path.relative(testsRoot, entryPoint).replace(/\.(ts|tsx)$/, '.js'),
  ),
);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', ...outFiles], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`Parity tests failed with exit code ${code}`));
  });

  child.on('error', reject);
});
