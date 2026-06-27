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
    // Round 320 close-day redesign: the first view is ONE "Close day assistant" decision panel (compact day
    // control + window/terminal detail line + a large ready/blocked/locked verdict + a single primary action),
    // then the secondary detail tabs. The detail-ledger markers below are reused inside the Money/Check tabs.
    'data-z-report-close-assistant',
    'data-z-report-decision-panel',
    'data-z-report-primary-action',
    'data-z-report-details',
    'data-z-report-money-reconciliation',
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
    /t\('modals\.zReport\.clarity\.from'/,
    'the day-details summary uses a plain From label for the business window',
  );
  assert.match(
    modal,
    /t\('modals\.zReport\.clarity\.until'/,
    'the day-details summary uses a plain Until label for the business window',
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
    'cashDrawerCheckoutNeeded',
    'cashDrawerCheckoutAndVariance',
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

test('ZReportModal localizes the visible staff role badge through the shared role helper', () => {
  const modal = source(zReportModalPath);

  // The visible badge text routes through the shared role helper.
  assert.match(modal, /import \{ translateRoleName \} from ['"]\.\.\/\.\.\/utils\/role-labels['"];/);
  assert.match(modal, /translateRoleName\(t, staff\.role \|\| ''\)/);

  // The raw slug is still used for badge classes (logic stays on the unlocalized value).
  assert.match(modal, /getRoleBadgeClasses\(staff\.role\)/);

  // The raw, unlocalized role text (and its non-ASCII em-dash fallback) is gone.
  assert.doesNotMatch(modal, /\{staff\.role \|\| /);

  // The localized target exists and is translated in every POS locale.
  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();
  for (const file of localeFiles) {
    const locale = JSON.parse(source(path.join(localesDir, file)));
    const roleNames = (locale.common?.roleNames ?? {}) as Record<string, string>;
    assert.equal(typeof roleNames.cashier, 'string', `${file} missing common.roleNames.cashier`);
    assert.ok(roleNames.cashier.length > 0, `${file} empty common.roleNames.cashier`);
  }
  const en = JSON.parse(source(path.join(localesDir, 'en.json')));
  const el = JSON.parse(source(path.join(localesDir, 'el.json')));
  assert.notEqual(
    el.common.roleNames.cashier,
    en.common.roleNames.cashier,
    'el cashier role label must be translated, not raw English',
  );
});

// Round 334 (live POS QA, Greek/dark close-day): the cash-drawer closeout blocker visibly mixed English into
// localized copy -- the action read "Checkout ταμία" and the explanation told the cashier to finish "checkout".
// Cashier-facing copy must be fully localized: no raw English "checkout" in any POS language (and never in
// Greek), while the blocker logic stays exactly the same -- the zero-variance unreconciled drawer keeps its
// amber/warning state and still opens the same cashier action read through the clarity key.
test('Round 334: cash-drawer closeout copy is fully localized (no English "checkout") and keeps the amber clarity action', () => {
  const modal = source(zReportModalPath);

  // Behaviour preserved: the action still routes through the localized clarity key, the zero-variance branch
  // still uses cashDrawerCheckoutNeeded, and the cash-drawer item stays amber/warning (never a red error).
  assert.match(
    modal,
    /t\('modals\.zReport\.clarity\.cashDrawerCheckoutAction'/,
    'the cash-drawer action must read through the localized clarity key',
  );
  assert.match(
    modal,
    /:\s*t\('modals\.zReport\.cashDrawerCheckoutNeeded'\)/,
    'the zero-variance unreconciled drawer must keep its calm checkout-needed explanation key',
  );
  assert.match(
    modal,
    /state:\s*cashDrawerNeedsAttention\s*\?\s*'warning'\s*:\s*'ready'/,
    'the cash-drawer blocker must stay amber/warning, not become a red error',
  );

  // The English fallback baked into the component no longer carries the raw "Checkout" word, so a missing key
  // could never reintroduce it in the rendered action.
  assert.doesNotMatch(
    modal,
    /cashDrawerCheckoutAction'[^)]*defaultValue:\s*'[^']*[Cc]heckout/,
    'the clarity action defaultValue must not fall back to English "Checkout"',
  );

  // Every POS locale's cash-drawer closeout strings (action + both explanations) must be free of the English
  // word "checkout" -- case-insensitive, so "Checkout"/"checkout" both fail.
  const closeoutCopy = (locale: Record<string, unknown>): string[] => {
    const z = ((locale.modals as Record<string, unknown>)?.zReport ?? {}) as Record<string, unknown>;
    const clarity = (z.clarity ?? {}) as Record<string, unknown>;
    return [
      z.cashDrawerCheckoutNeeded,
      z.cashDrawerCheckoutAndVariance,
      clarity.cashDrawerCheckoutAction,
    ].map(v => String(v ?? ''));
  };

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();
  for (const file of localeFiles) {
    const locale = JSON.parse(source(path.join(localesDir, file)));
    for (const value of closeoutCopy(locale)) {
      assert.ok(value.length > 0, `${file} has empty cash-drawer closeout copy`);
      assert.doesNotMatch(
        value,
        /checkout/i,
        `${file} cash-drawer closeout copy must not contain the English word "checkout": ${value}`,
      );
    }
  }

  // Greek specifically must be a real translation, not the English source, and must not leak the dotted key.
  const enZ = JSON.parse(source(path.join(localesDir, 'en.json')));
  const elZ = JSON.parse(source(path.join(localesDir, 'el.json')));
  const enCopy = closeoutCopy(enZ);
  const elCopy = closeoutCopy(elZ);
  for (let i = 0; i < elCopy.length; i += 1) {
    assert.notEqual(elCopy[i], enCopy[i], 'Greek cash-drawer closeout copy must differ from English');
    assert.doesNotMatch(elCopy[i], /cashDrawer/i, 'Greek cash-drawer closeout copy must not leak the dotted key');
  }
});
