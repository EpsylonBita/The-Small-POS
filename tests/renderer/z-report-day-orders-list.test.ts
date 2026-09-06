import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Founder, 06/09/2026 (Το Μικρό Παρίσι, after the first efood day): the Z modal's
// Orders tab listed only the staff shifts' orders — platform orders have no staff
// shift, so every efood order was missing from the list, the tab badge and the
// CSV while the headline already counted them. The Z builder now emits a
// day-level list (`dayOrders`) with the headline's own predicate, and the modal
// lists that (falling back to the staff union for reports persisted earlier).

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'ZReportModal.tsx');
const typesPath = path.join(projectRoot, 'src', 'renderer', 'types', 'reports.ts');
const exportPath = path.join(projectRoot, 'src', 'renderer', 'utils', 'reportExport.ts');
const zreportRsPath = path.join(projectRoot, 'src-tauri', 'src', 'zreport.rs');
const localesDir = path.join(projectRoot, 'src', 'locales');
const LOCALES = ['el', 'en', 'de', 'fr', 'it'] as const;

const read = (file: string) => readFileSync(file, 'utf8');
const loadLocale = (lng: string) =>
  JSON.parse(read(path.join(localesDir, `${lng}.json`))) as Record<string, unknown>;
const get = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);

test('Rust Z builder emits a day-level order list with the headline predicate and platform tenders', () => {
  const rs = read(zreportRsPath);
  assert.match(rs, /fn load_day_order_details\(/);
  // Same exclusions as the `totalOrders` aggregate: ghost, test, repair settlement,
  // cancelled, open unsettled table tabs — nothing about staff shifts or plugins.
  const helper = rs.slice(rs.indexOf('fn load_day_order_details('), rs.indexOf('fn load_driver_unsettled_counts_for_period('));
  assert.match(helper, /COALESCE\(o\.is_ghost, 0\) = 0/);
  assert.match(helper, /COALESCE\(o\.is_test, 0\) = 0/);
  assert.match(helper, /COALESCE\(o\.order_context, ''\) <> 'repair_settlement'/);
  assert.match(helper, /o\.status NOT IN \('cancelled', 'canceled'\)/);
  assert.match(helper, /AND NOT \{open_table_tab\}/);
  assert.doesNotMatch(helper, /staff_shift_id = \?/, 'the day list must not be scoped to a staff shift');
  assert.doesNotMatch(helper, /plugin, ''\)\) != ''/, 'the day list must not be scoped to platform orders either');
  // Platform-settled tenders are named like paymentsBreakdown, never bare `other`.
  assert.match(helper, /LIKE 'platform_settlement:online:%'[\s\S]*?THEN 'platform_online'/);
  assert.match(helper, /LIKE 'platform_settlement:cod:%'[\s\S]*?THEN 'platform_cod'/);
  assert.match(helper, /"platform": row\.get::<_, Option<String>>\(10\)\?/);
  assert.match(helper, /"platformFleet": row\.get::<_, i64>\(11\)\? == 1/);
  assert.match(helper, /"staffName": row\.get::<_, Option<String>>\(13\)\?/);
  assert.match(helper, /"createdAt": row\.get::<_, Option<String>>\(9\)\?\.unwrap_or_default\(\)/, 'a NULL created_at must not drop the row (count identity)');
  assert.match(helper, /ORDER BY x\.created_at ASC, x\.id ASC\s*LIMIT 1001/);
  // Emitted by the date builder (modal preview, close, admin sync, re-opened day).
  assert.match(rs, /let \(day_orders, day_orders_truncated\) = load_day_order_details\(/);
  assert.match(rs, /"staffReports": staff_reports,[\s\S]*?"dayOrders": day_orders,\s*"dayOrdersTruncated": day_orders_truncated,/);
  // Real-schema Rust test exists for it.
  assert.match(rs, /fn test_date_z_report_lists_every_order_of_the_day_including_platform_orders\(\)/);
});

test('Z modal Orders tab lists the day list (store + platform) and falls back to the staff union', () => {
  const source = read(modalPath);
  assert.match(source, /const dayOrderDetails = useMemo<ZReportOrderRow\[\]>\(/);
  assert.match(source, /if \(Array\.isArray\(zReport\?\.dayOrders\)\) \{/);
  assert.match(source, /return staffReportsSorted\.flatMap\(\(staff\) =>/, 'pre-1.4.97 reports fall back to the staff lists');
  assert.match(source, /const dayOrderDetailCount = dayOrderDetails\.length;/);
  assert.match(source, /icon: Receipt, badge: dayOrderDetailCount \}/);
  assert.match(source, /const filteredOrderDetails = filterOrders\(dayOrderDetails\);/);
  assert.doesNotMatch(source, /staffOrderDetailCount/, 'the staff-only badge count is gone');
  assert.match(source, /data-z-report-orders-list/);
  // Platform rows name their platform; store rows keep the staff name; every row shows its time.
  assert.match(source, /\{formatTime\(order\.createdAt\)\} · \{\[\s*order\.staffName,\s*order\.platform\s*\? t\('modals\.zReport\.platformOrderSource', \{ platform: order\.platform \}\)\s*: null,\s*\]\.filter\(Boolean\)\.join\(' · '\) \|\| '—'\}/, 'a store-driver platform order shows both the driver and the platform');
  // The audit row still localizes through the shared helpers (pos-greek-flow pin).
  assert.match(source, /\{localizeZReportOrderType\(order\.orderType, t\)\} · \{localizeZReportPaymentLabel\(order\.paymentMethod, t\)\}/);
});

test('Z modal payment filter and labels understand platform tenders', () => {
  const source = read(modalPath);
  assert.match(source, /platform_online: 'platformOnline',\s*platform_cod: 'platformCod',/);
  assert.match(source, /function isPlatformTender\(value: unknown\): boolean/);
  assert.match(source, /useState<'all' \| 'cash' \| 'card' \| 'platform'>\('all'\)/);
  assert.match(source, /paymentMethodFilter === 'platform'\s*\? Boolean\(o\.platform\) \|\| isPlatformTender\(o\.paymentMethod\)\s*: o\.paymentMethod === paymentMethodFilter/, 'the Platforms chip also matches platform orders our own driver delivered');
  assert.match(source, /\{ value: 'platform' as const, label: t\('modals\.zReport\.filters\.platform'\) \}/);
});

test('Orders CSV export is wired to a visible button and exports the day list', () => {
  const source = read(modalPath);
  assert.match(source, /import \{ exportZReportToCSV, exportDayOrdersToCSV \} from '\.\.\/\.\.\/utils\/reportExport';/);
  assert.match(source, /exportDayOrdersToCSV\(dayOrderDetails, `z-report-orders-\$\{resolvedBusinessDate\}`\)/);
  assert.match(source, /onClick=\{handleExportOrdersReport\}/, 'the export handler used to be dead code');
  assert.match(source, /\{t\('modals\.zReport\.exportOrdersCSV'\)\}/);
  assert.match(source, /zReport\?\.dayOrdersTruncated \?[\s\S]*?t\('modals\.zReport\.ordersListTruncated'\)/);
  const exporter = read(exportPath);
  assert.match(exporter, /export function exportDayOrdersToCSV\(/);
  assert.doesNotMatch(exporter, /exportStaffOrdersToCSV/, 'the staff-scoped exporter is gone with its only caller');
  assert.match(exporter, /'Source': order\.staffName \|\| \(order\.platform \? `platform:\$\{order\.platform\}` : '—'\)/);
});

test('Z report types expose the day list', () => {
  const types = read(typesPath);
  assert.match(types, /export interface ZReportDayOrder \{[\s\S]*?platform\?: string \| null;[\s\S]*?platformFleet\?: boolean;[\s\S]*?staffShiftId\?: string \| null;[\s\S]*?staffName\?: string \| null;/);
  assert.match(types, /dayOrders\?: ZReportDayOrder\[\];\s*dayOrdersTruncated\?: boolean;/);
});

test('new Orders-tab keys exist in all five locales, Greek translated', () => {
  const KEYS = ['filters.platform', 'paymentLabels.platformOnline', 'paymentLabels.platformCod', 'platformOrderSource', 'ordersListTruncated'] as const;
  for (const lng of LOCALES) {
    const locale = loadLocale(lng);
    for (const key of KEYS) {
      const value = get(locale, `modals.zReport.${key}`);
      assert.equal(typeof value, 'string', `${lng}.modals.zReport.${key} missing`);
      assert.ok((value as string).length > 0, `${lng}.modals.zReport.${key} empty`);
      assert.doesNotMatch(value as string, /NEEDS TRANSLATION/, `${lng}.modals.zReport.${key} is a placeholder`);
    }
  }
  const el = loadLocale('el');
  const en = loadLocale('en');
  const GREEK = /[Ͱ-Ͽ]/;
  for (const key of ['filters.platform', 'paymentLabels.platformOnline', 'paymentLabels.platformCod', 'platformOrderSource', 'ordersListTruncated']) {
    const elValue = get(el, `modals.zReport.${key}`) as string;
    assert.match(elValue, GREEK, `el modals.zReport.${key} should be Greek: "${elValue}"`);
    assert.notEqual(elValue, get(en, `modals.zReport.${key}`), `el modals.zReport.${key} must differ from English`);
  }
  assert.match(get(el, 'modals.zReport.platformOrderSource') as string, /\{\{platform\}\}/, 'the platform name is interpolated, never translated');
});
