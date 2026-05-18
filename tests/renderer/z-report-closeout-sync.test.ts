import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const zReportModalPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'modals',
  'ZReportModal.tsx',
);
const glassCssPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'styles',
  'glassmorphism.css',
);
const syncPath = path.join(projectRoot, 'src-tauri', 'src', 'sync.rs');
const localesDir = path.join(projectRoot, 'src', 'locales');

const source = (filePath: string) => readFileSync(filePath, 'utf8');

function flattenKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

test('ZReportModal localizes sync closeout blockers from submit responses', () => {
  const modal = source(zReportModalPath);

  assert.match(modal, /formatOperatorFacingError\(\s*res,/);
  assert.match(modal, /function extractErrorMessage[\s\S]*formatOperatorFacingError/);
  assert.doesNotMatch(
    modal,
    /formatPaymentIntegrityError\(\s*res,\s*\n\s*res\?\.error/,
    'submit response failures must use the operator-facing formatter, not the payment-only formatter',
  );
});

test('force sync drains the parity queue so Z-report commit reaches admin', () => {
  const sync = source(syncPath);

  assert.match(sync, /async fn force_parity_sync_once/);
  assert.match(sync, /sync_queue::process_queue\(&db\.conn, admin_url\.as_str\(\), api_key\.as_str\(\)\)/);
  assert.match(sync, /let parity_synced = force_parity_sync_once\(db, app\)\.await\?/);
  assert.match(sync, /let total_synced = synced \+ parity_synced/);
});

test('sync closeout translations exist in every POS locale', () => {
  const requiredKeys = [
    'closeoutStages.pre_z_report_sync',
    'closeoutStages.z_report_submission',
    'closeoutStages.closeout_sync',
    'blockerReasons.pending',
    'blockerReasons.processing',
    'blockerReasons.in_progress',
    'blockerReasons.failed',
    'blockerReasons.conflict',
    'blockerReasons.deferred',
    'blockerReasons.queued_remote',
    'blockerReasons.parent_payment_not_synced',
    'blockerReasons.parent_payment_missing_canonical_remote_id',
    'blockerReasons.ambiguous_canonical_remote_payment',
    'closeoutBlocked.single',
    'closeoutBlocked.multiple',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(source(path.join(localesDir, file)));
    const syncKeys = flattenKeys(locale.sync);
    const missing = requiredKeys.filter(key => !syncKeys.has(key));

    assert.deepEqual(missing, [], `${file} is missing sync closeout translations`);
  }
});

test('ZReportModal renders the closeout workbench with localized labels', () => {
  const modal = source(zReportModalPath);
  const requiredMarkers = [
    'data-z-report-workbench',
    'data-z-report-command-header',
    'data-z-report-closeout-checklist',
    'data-z-report-main-panel',
    'data-z-report-money-reconciliation',
    'data-z-report-action-panel',
    'data-z-report-modern-summary',
    'data-z-report-modern-details',
    'scrollbar-hide',
    'handleSubmitReport',
    'handlePrintReport',
    'contentClassName={modalContentClassName}',
    'className={modalShellClassName}',
    'modalContentClassName = isDarkTheme',
    'modalShellClassName = isDarkTheme',
    'z-report-glass-content',
    'z-report-glass-shell',
  ];

  for (const marker of requiredMarkers) {
    assert.match(modal, new RegExp(marker));
  }

  assert.match(
    modal,
    /disabled=\{submitting \|\| loading \|\| Boolean\(resolvingBlockerKey\) \|\| paymentBlockers\.length > 0\}/,
    'commit action must stay blocked while payment blockers are visible',
  );
  assert.match(
    modal,
    /t\('modals\.zReport\.businessWindow'\)/,
    'header should use the plain business-window label instead of the interpolated periodSince key',
  );
  assert.doesNotMatch(
    modal,
    /glass-crisp-content z-report-glass-content/,
    'Z-report must not use the opaque glass-crisp content layer',
  );
  assert.doesNotMatch(
    modal,
    /t\('modals\.zReport\.periodSince'\)/,
    'header must not render the periodSince translation without date/time interpolation',
  );

  const glassCss = source(glassCssPath);
  assert.match(glassCss, /\.liquid-glass-modal-shell\.z-report-glass-shell/);
  assert.match(glassCss, /\.liquid-glass-modal-content\.z-report-glass-content/);
  assert.match(glassCss, /backdrop-filter:\s*blur\(42px\)\s*saturate\(145%\)\s*!important/);

  const requiredZReportKeys = [
    'refresh',
    'closeoutChecklist',
    'moneyReconciliation',
    'reviewBeforeClose',
    'actionPanelTitle',
    'commitHelp',
    'secondaryActions',
    'reviewItems',
    'closeoutLoading',
    'readyToClose',
    'needsAttention',
    'adminSync',
    'syncChecking',
    'syncReady',
    'syncNeedsRetry',
    'paymentsCaptured',
    'paymentsReady',
    'paymentsNeedAction',
    'cashDrawerReady',
    'cashDrawerNeedsReview',
    'expensesReady',
    'expensesNeedReview',
    'staffReady',
    'staffNeedsMainTerminal',
    'drawerVariance',
    'closeoutSummary',
    'operatingSignals',
    'cashFlow',
    'netCashPosition',
    'expectedCash',
    'staffLedger',
    'drawerLedger',
    'expenseLedger',
    'noStaffReports',
    'cancelled',
    'tabs.overview',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(source(path.join(localesDir, file)));
    const zReportKeys = flattenKeys(locale.modals?.zReport);
    const missing = requiredZReportKeys.filter(key => !zReportKeys.has(key));

    assert.deepEqual(missing, [], `${file} is missing Z-report workbench translations`);
  }
});
