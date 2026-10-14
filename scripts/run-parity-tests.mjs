#!/usr/bin/env node
// Desktop parity suite: `npm test` / `npm run test:desktop-parity`, run by CI's
// "POS Tauri contract and runtime checks". It bundles every
// tests/**/*.test.{ts,tsx} file with esbuild and runs them in one `node --test`.
//
// Until 14/10/2026 this file kept a hand-written entry list, and a test missing
// from it ran nowhere: recovery-panel-ui, integrations-page-ui and
// capture-ui-i18n were each registered late for that reason, and 45 more files
// turned up unregistered, 13 of them failing. The entry points are now
// discovered (scripts/parity-test-files.mjs), so a new test runs without
// registration. Only a file another script owns is excluded there, by name;
// tests/scripts/test-runner-coverage.test.ts guards that split.
//
// Notes the old list carried (each test's own header has the detail):
// - services/sync-recovery-issues: known recovery matchers reject unrelated or
//   confusable failures and keep general warnings for incomplete queue reads.
// - renderer/session-storage, renderer/login-migration: Wave 0 regression
//   tests, written skipped and un-skipped as each Critical fix landed (see
//   D:\The-Small-002\planning\claude\now-create-a-plan-vivid-sutton.md).
// - renderer/order-vat-contract (07/10/2026): order VAT is native; screens show
//   the printed VAT only.
// - renderer/retail-checkout-money-contract (THE-324): the retail checkout
//   money/order-item seam, a fee-exclusive total contract with OrderFlow and
//   offer-reward lines mapped to real UUIDs.
// - renderer/capture-ui-i18n (invoice scan capture, spec task 12.6): the
//   capture UI speaks only `suppliers.capture.*`, hardcodes no user-facing
//   string and answers every runtime-built variant in every locale.
// - renderer/scanner-failure-detail (06/09/2026): BMP/TIFF transfers decode,
//   the driver's detail reaches the settings screen, the eSCL entry lists first.
// - renderer/featured-live-refresh: Featured follows the day's sales live, with
//   a minutes-scale refresh throttle and a re-check whenever the order menu opens.
// - renderer/recovery-panel-ui: Settings > Data > Local Recovery never renders
//   raw snapshot/terminal/branch identifiers or filesystem paths to the cashier.
// - renderer/recovery-center-panel-ui: the sync recovery assistant's summary
//   cards show friendly names, never raw terminal/branch/organization UUIDs,
//   while internal action-log IDs are preserved.
// - renderer/release-notes-changelog: every shipped version carries the
//   plain-language changelog section the update dialog shows the operator.
// - renderer/payment-blocker-localization (17/09/2026): a Greek till read its
//   blocker in English, because the settlement-shape sentences live in the Rust
//   classifier and no locale carried their reason codes.
// - renderer/z-report-fiscal-close-blocked (29/09/2026): the fiscal close-day
//   refusal is typed and localized in every store language, and the Z modal
//   holds the commit for queued receipts.
// - renderer/secure-session-validation (Wave 8 H29): a corrupt keyring blob is
//   rejected by validateSecureSessionUser and the keyring entry is cleared.
// - renderer/integrations-page-ui (myDATA simple setup): the MyData modal
//   signposts the Admin Dashboard (Plugins -> MyData) and keeps its toasts
//   localized.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { listParityTestFiles } from './parity-test-files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(projectRoot, 'tests');
// Not under node_modules: `node --test` treats each argument as a glob and never matches a
// path inside node_modules, so a relative node_modules path reports "Could not find".
// `.cache/` is gitignored.
const outDir = path.join(projectRoot, '.cache', 'parity-tests');

const entryPoints = listParityTestFiles(testsRoot).map((file) =>
  path.join(testsRoot, ...file.split('/')),
);

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
  loader: { '.png': 'dataurl' },
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'silent',
  external: ['node:test', 'node:assert/strict'],
});

// Relative to the cwd below: every test is one argument of a single `node --test`, and with
// absolute paths 185 files already took ~25K of Windows' 32,767-character command line.
const outFiles = entryPoints.map((entryPoint) =>
  path.relative(
    projectRoot,
    path.join(outDir, path.relative(testsRoot, entryPoint).replace(/\.(ts|tsx)$/, '.js')),
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
