import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Founder (06/09/2026, on the 05/09 close): «θέλω να δείχνει όλα τα κέρδη γιατί και αυτά
// πραγματικά έσοδα είναι … να λέει Χρήματα σε ταμείο και να εννοεί τα cash, ή 3 τιμές
// cash + card = all». The Z modal headline used the staff shifts' collected subset
// (428.54 / 56 orders) while the day was 629.49 / 72 — the 16 efood orders the
// platform settles were missing from the number the owner reads first.
//
// The headline and its split must come from ONE payment-level source — the Z
// builder's daySummary (cash + card + platform online + platform COD + other
// tender) — never from the order-level sales.totalSales (gross − discounts),
// which diverges from the tiles as soon as an order is still uncollected or a
// payment was refunded (adversarial review, 06/09/2026).

const projectRoot = process.cwd();
const modalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'ZReportModal.tsx');
const typesPath = path.join(projectRoot, 'src', 'renderer', 'types', 'reports.ts');
const localesDir = path.join(projectRoot, 'src', 'locales');
const LOCALES = ['el', 'en', 'de', 'fr', 'it'] as const;
const NEW_KEYS = [
  'platformOnlineSales',
  'platformCodSales',
  'cashInTill',
  'cardTotalLabel',
  'platformsTotal',
  'otherTender',
  'revenueSplitHint',
] as const;

const modalSource = () => readFileSync(modalPath, 'utf8');
const loadLocale = (lng: string) =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8')) as Record<string, unknown>;
const get = (value: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);

test('Z modal headline is the money collected in the whole day (store + platform), never the staff-collected subset', () => {
  const source = modalSource();

  // One payment-level source for the headline and the tiles.
  assert.match(source, /const platformCollected = platformOnlineCollected \+ platformCodCollected;/);
  assert.match(source, /const otherTenderCollected = zReport\?\.paymentsBreakdown\?\.other\?\.total \?\? 0;/);
  assert.match(
    source,
    /const collectedTotal = zReport\?\.daySummary\?\.total\s*\?\? \(cashCollected \+ cardCollected \+ platformCollected \+ otherTenderCollected\);/,
  );
  assert.match(source, /text-yellow-300 sm:text-5xl">\s*\{formatMoney\(collectedTotal\)\}/);
  assert.match(source, /data-z-report-earned-source[\s\S]*?\{t\('modals\.zReport\.orders', \{ defaultValue: 'Orders' \}\)\}: \{totalOrders\}/);
  // The 'earned' overview card agrees with the headline.
  assert.match(source, /key: 'earned',[\s\S]*?value: formatMoney\(collectedTotal\),[\s\S]*?: \$\{totalOrders\} ·/);
  // The old staff-subset override is gone for good, and the headline never
  // falls back to the order-level gross.
  assert.doesNotMatch(source, /storeEarnedSoFar/);
  assert.doesNotMatch(source, /hasStaffEarnedSoFar/);
  assert.doesNotMatch(source, /staffEarnedSoFar/);
  assert.doesNotMatch(source, /text-yellow-300 sm:text-5xl">\s*\{formatMoney\(totalSales\)\}/);
  // No clamped residual pretending to be a tender: «other» is the real bucket.
  assert.doesNotMatch(source, /Math\.max\(\s*0,\s*totalSales - cashCollected/);
  assert.match(source, /const otherCollected = otherTenderCollected;/);
  assert.match(source, /const netAfterExpenses = collectedTotal - expensesTotal - staffPaymentsTotal;/);
});

test('Z modal shows the three-way split under the headline: cash in the till + card + platforms (+ other tender)', () => {
  const source = modalSource();
  assert.match(source, /const revenueSplitTiles = \[/);
  assert.match(source, /key: 'cash', label: t\('modals\.zReport\.cashInTill'\), value: formatMoney\(cashCollected\)/);
  assert.match(source, /key: 'card', label: t\('modals\.zReport\.cardTotalLabel'\), value: formatMoney\(cardCollected\)/);
  assert.match(source, /key: 'platforms', label: t\('modals\.zReport\.platformsTotal'\), value: formatMoney\(platformCollected\)/);
  assert.match(source, /otherCollected >= 0\.005[\s\S]*?label: t\('modals\.zReport\.otherTender'\)/);
  assert.doesNotMatch(source, /t\('common\.other'/, 'common.other is not a defined key — it rendered English on a Greek till');
  assert.match(source, /data-z-report-revenue-split/);
  assert.match(source, /\{t\('modals\.zReport\.revenueSplitHint'\)\}/);
  // The Orders tab lists staff-served orders, so its badge counts that list.
  assert.match(source, /icon: Receipt, badge: staffOrderDetailCount \}/);
});

test('Z report types expose the payment-level day summary the modal reads', () => {
  const types = readFileSync(typesPath, 'utf8');
  assert.match(types, /daySummary\?: \{[\s\S]*?platformOnlineTotal\?: number;[\s\S]*?platformCodTotal\?: number;[\s\S]*?total: number;/);
  assert.match(types, /paymentsBreakdown\?: Partial<[\s\S]*?'cash' \| 'card' \| 'other' \| 'platform_online' \| 'platform_cod'/);
});

test('Z modal cash-flow row keys exist in all five locales (no raw keys on the till)', () => {
  // Live 05/09/2026: the cash-flow row printed "modals.zReport.platformOnlineSales" and
  // "modals.zReport.platformCodSales" verbatim — the strings lived only under
  // reports.zReport.summary.*, not where the modal reads them.
  for (const lng of LOCALES) {
    const locale = loadLocale(lng);
    for (const key of NEW_KEYS) {
      const value = get(locale, `modals.zReport.${key}`);
      assert.equal(typeof value, 'string', `${lng}.modals.zReport.${key} missing`);
      assert.ok((value as string).trim().length > 0, `${lng}.modals.zReport.${key} empty`);
      assert.doesNotMatch(value as string, /NEEDS TRANSLATION/, `${lng}.modals.zReport.${key} is a placeholder`);
    }
  }
  const el = loadLocale('el');
  const en = loadLocale('en');
  for (const key of ['cashInTill', 'cardTotalLabel', 'platformsTotal', 'otherTender', 'revenueSplitHint'] as const) {
    assert.notEqual(get(el, `modals.zReport.${key}`), get(en, `modals.zReport.${key}`), `el ${key} must be a real Greek translation`);
    assert.match(get(el, `modals.zReport.${key}`) as string, /[Ͱ-Ͽ]/, `el ${key} should be Greek`);
  }
});
