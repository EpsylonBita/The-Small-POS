import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const couponsPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'CouponsPage.tsx');
const loyaltyPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'LoyaltyPage.tsx');
const scannerPanelPath = path.join(projectRoot, 'src', 'renderer', 'components', 'scanner', 'ScanDevicePanel.tsx');
const scannerContextPath = path.join(projectRoot, 'src', 'renderer', 'contexts', 'barcode-scanner-context.tsx');
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

// Extract a JSX element block from `startMarker` (e.g. an onClick signature inside an opening tag)
// to the first occurrence of `endMarker` after it (e.g. '</button>'). Used to scope assertions to a
// single interactive control so a native `title=` attribute on it can be distinguished from a
// component `title` PROP elsewhere on the page.
function sliceBlock(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `expected to find "${startMarker}"`);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected "${endMarker}" after "${startMarker}"`);
  return text.slice(start, end + endMarker.length);
}

test('CouponsPage exposes scanner action and routes scanned codes into coupon search', () => {
  const page = source(couponsPagePath);

  assert.match(page, /ScanDevicePanel/);
  assert.match(page, /setShowScanPanel\(true\)/);
  assert.match(page, /handleCouponScan/);
  assert.match(page, /setSearchTerm\(scannedCode\)/);
  assert.match(page, /coupon\.code\.toUpperCase\(\) === scannedCode/);
  assert.match(page, /coupons\.scan\.button/);
  assert.match(page, /scrollbar-hide/);
  assert.match(page, /border border-yellow-400\/70 bg-yellow-400\/10 text-yellow-100 active:bg-yellow-400\/20/);
  assert.match(page, /border border-yellow-400\/70 bg-yellow-50 text-yellow-700 active:bg-yellow-100/);
  assert.match(page, /<CheckCircle className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Ticket className="w-5 h-5 text-yellow-500" \/>/);
  assert.match(page, /text-xs font-semibold text-green-500 inline-flex items-center gap-1/);
  assert.match(page, /text-xs font-semibold text-red-400 inline-flex items-center gap-1/);
  assert.match(page, /bg-transparent text-amber-300 border border-amber-500\/40/);
  assert.match(page, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(page, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  assert.match(page, /bg-green-600 active:bg-green-700 text-white/);
  assert.match(page, /border border-red-500\/25 bg-red-500\/10 text-red-200 active:bg-red-500\/15/);
  assert.match(page, /border border-red-300\/70 bg-red-50 text-red-700 active:bg-red-100/);
  assert.doesNotMatch(page, /hover:/);
  assert.doesNotMatch(page, /group-hover:|dark:hover:/);
  assert.doesNotMatch(page, /bg-cyan-500\/15 text-cyan-100/);
  assert.doesNotMatch(page, /bg-cyan-50 text-cyan-800/);
  assert.doesNotMatch(page, /bg-transparent text-white border border-cyan-500\/40/);
  assert.doesNotMatch(page, /px-2 py-0\.5 text-xs rounded-lg inline-flex items-center gap-1/);
  assert.doesNotMatch(page, /px-2 py-0\.5 text-xs bg-red-500\/20 text-red-400 rounded-lg/);
  assert.doesNotMatch(page, /bg-amber-500\/20 text-amber-300 border border-amber-500\/30/);
});

test('CouponsPage buttons are touch-first with no native DOM title tooltips', () => {
  const page = source(couponsPagePath);

  assert.match(page, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(page, /aria-label=\{t\('common\.copy', 'Copy'\)\}/);
  assert.doesNotMatch(page, /title=\{saveAction\.message/);
  assert.doesNotMatch(page, /title=\{toggleAction\.message/);
  assert.doesNotMatch(page, /title=\{deleteAction\.message/);
  assert.doesNotMatch(page, /title=\{t\('common\.refresh', 'Refresh'\)\}/);

  const titleCount = (page.match(/\btitle=/g) || []).length;
  assert.equal(titleCount, 1, 'CouponsPage should only keep the ScanDevicePanel modal title prop');
  assert.match(page, /<ScanDevicePanel[\s\S]*?\btitle=\{t\('coupons\.scan\.title', 'Scan coupon'\)\}/);
});

test('LoyaltyPage exposes scanner action and supports card, phone, and member-code lookup', () => {
  const page = source(loyaltyPagePath);

  assert.match(page, /ScanDevicePanel/);
  assert.match(page, /includeLoyaltyReader/);
  assert.match(page, /useLoyaltyReader/);
  assert.match(page, /handleLoyaltyScan/);
  assert.match(page, /bridge\.loyalty\.lookupByCard\(scannedCode\)/);
  assert.match(page, /loyalty_card_uid/);
  assert.match(page, /customer_phone\?\.replace/);
  assert.match(page, /loyalty\.scan\.button/);
  assert.match(page, /scrollbar-hide/);
  // Round 167: scan button is yellow/touch-first (not the old cyan), TrendingUp stat is amber.
  assert.match(page, /border border-yellow-400\/70 text-white active:bg-yellow-400\/10/);
  assert.match(page, /<Users className="w-5 h-5 text-green-500" \/>/);
  assert.match(page, /<Award className="w-5 h-5 text-yellow-500" \/>/);
  assert.match(page, /<TrendingUp className="w-5 h-5 text-amber-500" \/>/);
  assert.match(page, /px-2 py-1 text-xs font-medium rounded border bg-transparent flex items-center gap-1/);
  assert.match(page, /text-amber-300 border-amber-400\/50/);
  assert.match(page, /text-yellow-400 border-yellow-500\/40/);
  assert.match(page, /text-zinc-300 border-zinc-400\/40/);
  assert.match(page, /text-amber-500 border-amber-500\/40/);
  assert.match(page, /p-2 rounded-2xl \$\{isDark \? 'bg-zinc-800' : 'bg-gray-100'\}/);
  assert.match(page, /selectedCustomer\?\.id === customer\.id \? 'ring-2 ring-yellow-400' : ''/);
  assert.match(page, /text-lg font-bold text-yellow-400/);
  assert.doesNotMatch(page, /bg-transparent text-white border border-cyan-500\/40/);
  assert.doesNotMatch(page, /bg-cyan-500\/15 text-cyan-100/);
  assert.doesNotMatch(page, /bg-cyan-50 text-cyan-800/);
  assert.doesNotMatch(page, /purple-/);
  assert.doesNotMatch(page, /rounded-lg/);
  assert.doesNotMatch(page, /bg-purple-500\/20/);
  assert.doesNotMatch(page, /bg-yellow-500\/20/);
  assert.doesNotMatch(page, /bg-zinc-400\/20/);
  assert.doesNotMatch(page, /bg-amber-500\/20/);
});

// Round 167 (live QA): the loyalty tier badge leaked the raw backend value ("none") next to a
// star. Tiers must be normalized + localized; no-tier shows a neutral label and no stars.
test('LoyaltyPage localizes loyalty tier labels and never renders raw tier tokens', () => {
  const page = source(loyaltyPagePath);

  // A tier label resolver localizes the value; no-tier and all known tiers use loyalty.tier.* keys.
  assert.match(page, /const getTierLabel = \(tier: string\)/);
  assert.match(page, /\{getTierLabel\(customer\.tier\)\}/);
  assert.match(page, /t\('loyalty\.tier\.none', 'No tier'\)/);
  assert.match(page, /t\('loyalty\.tier\.bronze', 'Bronze'\)/);
  assert.match(page, /t\('loyalty\.tier\.silver', 'Silver'\)/);
  assert.match(page, /t\('loyalty\.tier\.gold', 'Gold'\)/);
  assert.match(page, /t\('loyalty\.tier\.platinum', 'Platinum'\)/);
  // The tier value is normalized (trim + lowercase) and no-tier is detected before display.
  assert.match(page, /const normalizeTier = /);
  assert.match(page, /const isNoTier = /);
  // The raw-token render and the wrong "Bronze" fallback are gone.
  assert.doesNotMatch(page, /\{customer\.tier \|\| 'Bronze'\}/);
  assert.doesNotMatch(page, /\{customer\.tier\}/);
});

// Round 167 (live QA): the refresh button's native title tooltip is hover behaviour on a
// touchscreen; the accessible name is provided via aria-label only.
// Round 260 (live QA): the header refresh button was still a harsh black/white inversion square in
// dark mode while adjacent pages (DeliveryZones/Suppliers) use amber-glass refresh controls; it is
// now amber glass in both themes. The ScanDevicePanel `title` PROP (a modal heading) is a legitimate
// component prop, not a DOM tooltip, so the no-title guard stays scoped to the refresh key.
test('LoyaltyPage refresh button is amber glass with aria-label only (no native title, no hover)', () => {
  const page = source(loyaltyPagePath);

  assert.match(page, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.doesNotMatch(page, /title=\{t\('common\.refresh', 'Refresh'\)\}/);
  // Refresh stays touch-first: active press feedback, no hover utilities anywhere on the page.
  assert.match(page, /active:scale-95/);
  assert.doesNotMatch(page, /hover:/);
  assert.doesNotMatch(page, /group-hover:/);

  // Round 260: amber glass in both themes (matching DeliveryZones/Suppliers Round 257/259).
  assert.match(page, /border border-amber-400\/30 bg-amber-500\/15 text-amber-300 active:bg-amber-500\/25/);
  assert.match(page, /border border-amber-400\/40 bg-amber-50 text-amber-600 active:bg-amber-100/);
  // The old stark black/white inversion square is gone.
  assert.doesNotMatch(page, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(page, /border border-black bg-black text-white/);

  // Behaviour/shape preserved: same handler, disabled guard, 44px square, spinner, neutral disabled.
  assert.match(page, /onClick=\{\(\) => void fetchData\(\)\}/);
  assert.match(page, /disabled=\{loading\}/);
  assert.match(page, /h-12 w-12/);
  assert.match(page, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
  assert.match(page, /loading \? 'opacity-60 cursor-not-allowed' : 'active:scale-95'/);
});

// Round 170 (live QA audit): touch-first no-native-tooltip cleanup of the Scan button path. Native
// DOM `title` attributes on interactive controls are hover tooltips and must not exist; the
// ScanDevicePanel `title` PROP (modal heading) is a legitimate component prop and must be preserved.
test('LoyaltyPage Scan/refresh buttons carry no native title tooltip, but the modal title prop stays', () => {
  const page = source(loyaltyPagePath);

  // Scan button (opens the scan panel): accessible name comes from its visible "Scan" text, with no
  // native title tooltip and no hover-only affordance.
  const scanButton = sliceBlock(page, 'onClick={() => setShowScanPanel(true)}', '</button>');
  assert.doesNotMatch(scanButton, /\btitle=/);
  assert.doesNotMatch(scanButton, /hover:/);
  assert.match(scanButton, /\{t\('loyalty\.scan\.button', 'Scan'\)\}/);

  // Refresh button: accessible name via aria-label, no native title tooltip.
  const refreshButton = sliceBlock(page, 'onClick={() => void fetchData()}', '</button>');
  assert.match(refreshButton, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.doesNotMatch(refreshButton, /\btitle=/);

  // The ONLY `title=` on the page is the ScanDevicePanel modal-heading PROP (a component prop, not a
  // DOM tooltip). Distinguish: exactly one `title=` exists and it is on <ScanDevicePanel>.
  const titleCount = (page.match(/\btitle=/g) || []).length;
  assert.equal(titleCount, 1, 'LoyaltyPage should have exactly one title= (the ScanDevicePanel modal prop)');
  assert.match(page, /<ScanDevicePanel[\s\S]*?\btitle=\{t\('loyalty\.scan\.title', 'Scan loyalty member'\)\}/);
});

test('ScanDevicePanel detects camera/scanner availability and supports all scan entry paths', () => {
  const panel = source(scannerPanelPath);
  const context = source(scannerContextPath);

  assert.match(panel, /navigator\.mediaDevices\?\.enumerateDevices/);
  assert.match(panel, /device\.kind === 'videoinput'/);
  assert.match(panel, /BarcodeDetector/);
  assert.match(panel, /useHardwareManager\(open, 5000\)/);
  assert.match(panel, /serialScanner\?\.connected/);
  assert.match(panel, /useOnBarcodeScan/);
  assert.match(panel, /capture="environment"/);
  assert.match(panel, /submitCode\(manualCode, 'manual'\)/);
  assert.match(context, /barcode_scanned_serial/);
});

test('Coupon, loyalty, and scanner translation keys exist in every POS locale', () => {
  const requiredCouponKeys = [
    'scan.button',
    'scan.title',
    'scan.description',
    'scan.placeholder',
    'scan.found',
    'scan.notFound',
  ];
  const requiredLoyaltyKeys = [
    'scan.button',
    'scan.title',
    'scan.description',
    'scan.placeholder',
    'scan.found',
    'scan.notFound',
    'tier.none',
    'tier.bronze',
    'tier.silver',
    'tier.gold',
    'tier.platinum',
  ];
  const requiredScannerKeys = [
    'hardwareScanner',
    'serialConnected',
    'keyboardReady',
    'lastScan',
    'camera',
    'cameraUnsupported',
    'cameraDetectionFailed',
    'cameraBarcodeUnavailable',
    'checkingDevices',
    'cameraCount',
    'noCamera',
    'loyaltyReaderConnected',
    'loyaltyReaderReady',
    'scanNow',
    'scanHelp',
    'submit',
    'cameraScan',
    'checkAgain',
    'noBarcodeFound',
    'cameraScanFailed',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const couponKeys = flattenKeys(locale.coupons);
    const loyaltyKeys = flattenKeys(locale.loyalty);
    const scannerKeys = flattenKeys(locale.scannerPanel);
    const missing = [
      ...requiredCouponKeys.filter(key => !couponKeys.has(key)).map(key => `coupons.${key}`),
      ...requiredLoyaltyKeys.filter(key => !loyaltyKeys.has(key)).map(key => `loyalty.${key}`),
      ...requiredScannerKeys.filter(key => !scannerKeys.has(key)).map(key => `scannerPanel.${key}`),
    ];

    assert.deepEqual(missing, [], `${file} is missing scan translations`);
  }
});
