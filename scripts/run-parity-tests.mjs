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
  path.join(testsRoot, 'pages', 'SettingsPage.test.tsx'),
  path.join(testsRoot, 'pages', 'OrderDetailsModal.test.tsx'),
  // Wave 0 regression tests — currently `test.skip`, un-skip as each
  // Critical fix lands in its wave. See
  // D:\The-Small-002\planning\claude\now-create-a-plan-vivid-sutton.md.
  path.join(testsRoot, 'renderer', 'session-storage.test.ts'),
  path.join(testsRoot, 'renderer', 'login-migration.test.ts'),
  path.join(testsRoot, 'renderer', 'orders-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'menu-cart-line-discounts.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-financials.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-delta-modal.test.ts'),
  path.join(testsRoot, 'renderer', 'edit-settlement-flow.test.ts'),
  path.join(testsRoot, 'renderer', 'delivery-zones-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-schedule-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'module-context-sync.test.ts'),
  path.join(testsRoot, 'renderer', 'suppliers-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'inventory-page-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'coupon-loyalty-scan-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'settings-modal-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'z-report-closeout-sync.test.ts'),
  path.join(testsRoot, 'renderer', 'display-pages-ui.test.ts'),
  path.join(testsRoot, 'renderer', 'order-number-utils.test.ts'),
  path.join(testsRoot, 'renderer', 'staff-shift-checkout-print.test.ts'),
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
