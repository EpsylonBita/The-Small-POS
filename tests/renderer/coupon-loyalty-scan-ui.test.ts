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

test('CouponsPage exposes scanner action and routes scanned codes into coupon search', () => {
  const page = source(couponsPagePath);

  assert.match(page, /ScanDevicePanel/);
  assert.match(page, /setShowScanPanel\(true\)/);
  assert.match(page, /handleCouponScan/);
  assert.match(page, /setSearchTerm\(scannedCode\)/);
  assert.match(page, /coupon\.code\.toUpperCase\(\) === scannedCode/);
  assert.match(page, /coupons\.scan\.button/);
  assert.match(page, /scrollbar-hide/);
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
