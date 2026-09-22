import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Founder incident, 16/09/2026. One Z slip, two bugs:
//
//   1. «POS x37» printed inside the ΠΛΑΤΦΟΡΜΕΣ block next to efood and Wolt.
//      `orders.plugin = 'pos'` is the store's OWN till — an order source, not
//      an external platform.
//   2. Order-level turnover read €1.636,16 while payment-level read €1.105,73,
//      and the Z closed without a word. €531,13 of orders were marked paid
//      with no canonical completed payment behind them.
//
// These pins keep the fixes honest from the renderer's side: the classifier
// stays central (no fresh string checks), the modal shows the reconciliation,
// and the submit gate keys on the findings the report itself carries.

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'ZReportModal.tsx');
const typesPath = path.join(projectRoot, 'src', 'renderer', 'types', 'reports.ts');
const contractsPath = path.join(projectRoot, 'src', 'lib', 'ipc-contracts.ts');
const pluginIconsPath = path.join(projectRoot, 'src', 'renderer', 'utils', 'plugin-icons.tsx');
const sharedPlatformsPath = path.join(projectRoot, '..', 'shared', 'platforms', 'order-platforms.ts');
const zreportRsPath = path.join(projectRoot, 'src-tauri', 'src', 'zreport.rs');
const platformsRsPath = path.join(projectRoot, 'src-tauri', 'src', 'platforms.rs');
const printRsPath = path.join(projectRoot, 'src-tauri', 'src', 'print.rs');
const localesDir = path.join(projectRoot, 'src', 'locales');
const LOCALES = ['el', 'en', 'de', 'fr', 'it', 'sq'] as const;

const read = (file: string) => readFileSync(file, 'utf8');
const loadLocale = (lng: string) =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8')) as Record<string, unknown>;
const get = (value: unknown, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      value,
    );

test('plugin="pos" is excluded from external-platform aggregation by ONE central classifier', () => {
  const zreport = read(zreportRsPath);

  // The bug: `TRIM(COALESCE(o.plugin,'')) != ''` made every non-empty plugin a
  // platform, so the store's own till printed as «POS x37».
  assert.ok(
    !/TRIM\(COALESCE\(o\.plugin, ''\)\) != ''/.test(zreport),
    'the Z must not treat "any non-empty plugin" as an external platform',
  );
  // Both the platform aggregation and the day-order list go through the
  // central classifier rather than hand-rolled SQL — and they ask for a
  // marketplace we can NAME, not merely "not internal".
  assert.match(zreport, /crate::platforms::external_marketplace_sql_predicate\("o\.plugin"\)/);
  assert.match(zreport, /crate::platforms::external_marketplace_label_sql_expr\("o\.plugin"\)/);
  // An unrecognised source is reported rather than guessed into ΠΛΑΤΦΟΡΜΕΣ.
  assert.match(zreport, /crate::platforms::unknown_platform_sql_predicate\("o\.plugin"\)/);
  assert.match(zreport, /"unclassifiedPlatforms": unclassified_platforms/);

  // The receipt's rider banner asks the same module, not its own list.
  const print = read(printRsPath);
  assert.match(
    print,
    /pub\(crate\) fn is_food_delivery_plugin\(plugin: &str\) -> bool \{\s*crate::platforms::is_external_delivery_platform\(plugin\)\s*\}/,
  );
});

test('the marketplace set is CLOSED and excludes the wider plugin namespace', () => {
  // Audit 16/09/2026: `plugin_integrations` catalogs mydata / stripe / viva /
  // google_analytics / woocommerce / shopify, and woocommerce+shopify are
  // flagged `supports_order_sync`. None may ever be read as a marketplace.
  const rust = read(platformsRsPath);
  const ts = read(sharedPlatformsPath);
  for (const notAMarketplace of [
    'mydata', 'stripe', 'viva', 'google_analytics', 'woocommerce', 'shopify',
  ]) {
    assert.ok(
      !new RegExp(`EXTERNAL_(DELIVERY|BOOKING)_PLATFORMS[\\s\\S]{0,400}?["']${notAMarketplace}["']`).test(rust),
      `${notAMarketplace} must not be a marketplace slug in Rust`,
    );
    assert.ok(
      !new RegExp(`EXTERNAL_(DELIVERY|BOOKING)_PLATFORMS[\\s\\S]{0,400}?["']${notAMarketplace}["']`).test(ts),
      `${notAMarketplace} must not be a marketplace slug in TypeScript`,
    );
  }
  // Four classes, named identically on both sides.
  assert.match(rust, /ExternalMarketplace/);
  assert.match(rust, /OrderPlatformClass::Unknown/);
  assert.match(ts, /'none' \| 'internal' \| 'external_marketplace' \| 'unknown'/);
});

test('the internal-source list is closed and identical in Rust and TypeScript', () => {
  const rust = read(platformsRsPath);
  const ts = read(sharedPlatformsPath);

  const rustInternal = /INTERNAL_ORDER_PLATFORMS: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
  const tsInternal = /INTERNAL_ORDER_PLATFORMS = \[([^\]]*)\]/.exec(ts);
  assert.ok(rustInternal && tsInternal, 'both sides must declare the internal list');

  const slugs = (block: string) =>
    [...block.matchAll(/"([a-z0-9-]+)"|'([a-z0-9-]+)'/g)]
      .map((match) => match[1] ?? match[2])
      .sort();

  assert.deepEqual(slugs(rustInternal![1]), slugs(tsInternal![1]));
  assert.deepEqual(slugs(rustInternal![1]), ['android-ios', 'kiosk', 'pos', 'web']);

  // The renderer's icon allowlist must never claim 'pos' is external.
  const icons = read(pluginIconsPath);
  const knownInternal = /KNOWN_INTERNAL_PLUGINS: readonly string\[\] = \[([^\]]*)\]/.exec(icons);
  assert.ok(knownInternal, 'plugin-icons keeps its own internal list');
  assert.ok(slugs(knownInternal![1]).includes('pos'));
});

test('the Z modal shows the reconciliation and blocks the close on real findings', () => {
  const source = read(modalPath);

  // Findings travel WITH the report, so a broken day is visible at preview
  // time instead of only when a submit is rejected.
  assert.match(source, /const integrity = zReport\?\.integrity;/);
  assert.match(source, /Array\.isArray\(integrity\?\.findings\)/);

  // Preview findings and submit-time rejections are merged, de-duplicated on
  // orderId + reasonCode.
  assert.match(source, /merged\.set\(`\$\{blocker\.orderId\}:\$\{blocker\.reasonCode\}`, blocker\)/);

  // The submit gate and the checklist key on the merged blocking set, not on
  // submit-time rejections alone.
  assert.match(source, /const blockingPaymentIssues = useMemo\(/);
  assert.match(source, /blocker\.severity !== 'warning'/);
  assert.match(source, /hasActiveStaffShifts \|\|\s*blockingPaymentIssues\.length > 0;/);
  assert.match(source, /closeoutIssueCount =\s*blockingPaymentIssues\.length \+/);

  // Turnover and coverage are shown side by side and never summed.
  assert.match(source, /modals\.zReport\.orderTurnover/);
  assert.match(source, /modals\.zReport\.paymentCoverage/);
  assert.match(source, /formatMoney\(integrity\.orderTurnover \?\? 0\)/);
  assert.match(source, /formatMoney\(integrity\.paymentCoverage \?\? 0\)/);
  assert.ok(
    !/orderTurnover[^\n]*\+[^\n]*paymentCoverage/.test(source),
    'order turnover and payment coverage must never be added together',
  );

  // Orders held back because an earlier Z closed their day are reported, not
  // silently dropped. Same for a source we could not classify.
  assert.match(source, /integrity\.carriedOverFromClosedDays\?\.orders/);
  assert.match(source, /integrity\.unclassifiedPlatforms\?\.length/);
  assert.match(source, /modals\.zReport\.reconciliationUnclassifiedSources/);

  // Review item C (16/09/2026): a legitimate refund leaves a real, non-zero
  // `difference`. The panel must colour on what is UNEXPLAINED, or a normal
  // day with a refund reads red while `reconciled` says it is fine.
  assert.match(
    source,
    /Math\.abs\(integrity\.unexplainedDifference \?\? integrity\.difference \?\? 0\) >= 0\.01\n?\s*\? 'text-rose-600 dark:text-rose-300'/,
  );
  assert.ok(
    !/Math\.abs\(integrity\.difference \?\? 0\) >= 0\.01\s*\n?\s*\? 'text-rose/.test(source),
    'the difference must never be coloured on raw arithmetic alone',
  );
  // The raw difference is still PRINTED — nothing is hidden, only recoloured.
  assert.match(source, /formatMoney\(integrity\.difference \?\? 0\)/);
  // And the explanation is named next to it.
  assert.match(source, /integrity\.refundedOrders\?\.orders \?\? 0\) > 0/);
  assert.match(source, /modals\.zReport\.reconciliationExplainedByRefunds/);
  assert.match(source, /formatMoney\(integrity\.explainedDifference \?\? 0\)/);
});

test('the blocker panel never offers to guess a tender for platform-held money', () => {
  const panelPath = path.join(
    projectRoot, 'src', 'renderer', 'components', 'ui', 'UnsettledPaymentBlockersPanel.tsx',
  );
  const source = read(panelPath);

  // `platform_settlement_missing` reads like a plain outstanding balance —
  // order total, nothing settled — but that money is with efood/Wolt, not in
  // the till. The cash/card buttons must not appear for it, or the operator
  // books platform money as drawer cash and the close never reconciles.
  for (const reasonCode of [
    'platform_settlement_missing',
    'platform_settlement_mismatch',
    'overpaid_order',
    'duplicate_payment',
  ]) {
    assert.match(
      source,
      new RegExp(`"${reasonCode}"`),
      `${reasonCode} must be excluded from the resolve-here affordance`,
    );
  }
  assert.match(source, /!NON_TENDER_REASON_CODES\.includes\(blocker\.reasonCode\)/);
});

test('the report contract carries severity, the signed difference, and the reconciliation block', () => {
  const contracts = read(contractsPath);
  assert.match(contracts, /severity\?: 'blocking' \| 'warning';/);
  assert.match(contracts, /differenceCents\?: number;/);
  assert.match(contracts, /export interface ZReportIntegrity \{/);
  assert.match(contracts, /orderTurnover: number;/);
  assert.match(contracts, /paymentCoverage: number;/);
  assert.match(contracts, /blockingFindings: number;/);
  assert.match(contracts, /reconciled: boolean;/);
  // Item C: the adjustment-aware trio the panel colours and explains on.
  assert.match(contracts, /explainedDifference\?: number;/);
  assert.match(contracts, /unexplainedDifference\?: number;/);
  assert.match(contracts, /refundedOrders\?: \{ orders: number; amount: number \};/);
  assert.match(
    contracts,
    /unclassifiedPlatforms\?: Array<\{ source: string; orders: number; amount: number \}>;/,
  );

  const types = read(typesPath);
  assert.match(types, /integrity\?: ZReportIntegrity;/);
});

test('every locale carries the reconciliation copy, including each reason code', () => {
  const REASON_CODES = [
    'missing_local_payment_row',
    'no_persisted_payment',
    'partial_payment_remaining',
    'split_payment_incomplete',
    'unsupported_payment_method',
    'overpaid_order',
    'duplicate_payment',
    'platform_settlement_mismatch',
    'platform_settlement_missing',
  ] as const;
  const KEYS = [
    'reconciliationTitle',
    'orderTurnover',
    'paymentCoverage',
    'reconciliationDifference',
    'reconciliationOrdersAffected',
    'reconciliationCarriedOver',
    'reconciliationUnclassifiedSources',
    'reconciliationExplainedByRefunds',
  ] as const;

  for (const lng of LOCALES) {
    const locale = loadLocale(lng);
    for (const key of KEYS) {
      const value = get(locale, `modals.zReport.${key}`);
      assert.equal(typeof value, 'string', `${lng}: modals.zReport.${key} must be translated`);
      assert.ok((value as string).trim().length > 0, `${lng}: modals.zReport.${key} is empty`);
    }
    for (const code of REASON_CODES) {
      const value = get(locale, `modals.zReport.reconciliationReason.${code}`);
      assert.equal(
        typeof value,
        'string',
        `${lng}: modals.zReport.reconciliationReason.${code} must be translated`,
      );
    }
  }
});
