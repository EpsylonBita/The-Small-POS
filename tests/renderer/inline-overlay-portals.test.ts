import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Founder rule: every modal/overlay mounts outside the page container
// (document.body) and blurs the rest of the screen. These guard the remaining
// inline fixed overlays (coupons, scanner, delivery) that were previously
// rendered inline at z-50 without a portal/blur.
const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

const couponsPage = read('src/renderer/pages/CouponsPage.tsx');
const scanPanel = read('src/renderer/components/scanner/ScanDevicePanel.tsx');
const deliveryValidation = read('src/renderer/components/delivery/DeliveryValidationComponent.tsx');
const deliveryPage = read('src/renderer/pages/DeliveryPage.tsx');
const paymentDialog = read('src/renderer/components/ecr/PaymentDialog.tsx');
const syncNotifications = read('src/renderer/components/SyncNotificationManager.tsx');
const tableSelector = read('src/renderer/components/tables/TableSelector.tsx');

test('CouponsPage coupon create/edit modal portals to body with a high-z blur overlay', () => {
  assert.match(couponsPage, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(couponsPage, /\{showModal && renderModalPortal\(/);
  assert.match(couponsPage, /fixed inset-0 z-\[1200\] bg-black\/50 backdrop-blur-sm/);
  // The clipped inline z-50 (no blur, no portal) overlay is gone.
  assert.doesNotMatch(couponsPage, /fixed inset-0 z-50 bg-black\/50/);
});

test('ScanDevicePanel portals to body with a high-z blur overlay', () => {
  assert.match(scanPanel, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(scanPanel, /return renderModalPortal\(/);
  assert.match(scanPanel, /fixed inset-0 z-\[1200\][^"]*bg-black\/60 backdrop-blur-sm/);
  assert.doesNotMatch(scanPanel, /fixed inset-0 z-50 flex items-center justify-center bg-black\/60/);
});

test('DeliveryValidationComponent override modal portals to body with a high-z blur overlay', () => {
  assert.match(deliveryValidation, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal';/);
  assert.match(deliveryValidation, /showOverrideModal && renderModalPortal\(/);
  assert.match(deliveryValidation, /fixed inset-0 z-\[1200\][^"]*bg-black\/45 backdrop-blur-md/);
  // The old non-blurred, non-portaled overlay is gone.
  assert.doesNotMatch(deliveryValidation, /bg-black bg-opacity-50/);
});

test('DeliveryPage DriverAssignmentModal portals to body with a high-z blur overlay', () => {
  assert.match(deliveryPage, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(deliveryPage, /return renderModalPortal\(/);
  assert.match(deliveryPage, /fixed inset-0 z-\[1200\] flex items-center justify-center/);
  assert.match(deliveryPage, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
  // The inline z-50 modal wrapper is gone.
  assert.doesNotMatch(deliveryPage, /fixed inset-0 z-50 flex items-center justify-center/);
});

test('PaymentDialog portals to body with a high-z blur overlay', () => {
  assert.match(paymentDialog, /import \{ renderModalPortal \} from '\.\.\/\.\.\/utils\/render-modal-portal'/);
  assert.match(paymentDialog, /return renderModalPortal\(/);
  assert.match(paymentDialog, /fixed inset-0 z-\[1200\] flex items-center justify-center/);
  assert.match(paymentDialog, /absolute inset-0 bg-black\/70 backdrop-blur-sm/);
  // The inline z-50 wrapper is gone.
  assert.doesNotMatch(paymentDialog, /fixed inset-0 z-50 flex items-center justify-center/);
});

test('SyncNotificationManager restart-required modal portals to body with a high-z blur overlay', () => {
  assert.match(syncNotifications, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(syncNotifications, /\{restartRequired && renderModalPortal\(/);
  assert.match(syncNotifications, /fixed inset-0 bg-black\/50 backdrop-blur-sm[^"]*z-\[1200\]/);
  // The old full-screen, non-blurred restart overlay is gone (corner toast keeps its own z).
  assert.doesNotMatch(syncNotifications, /fixed inset-0 bg-black bg-opacity-50/);
});

// Round 224: TableSelector was intentionally moved OFF the hand-rolled renderModalPortal shell onto the
// shared LiquidGlassModal glass surface, which provides its own portal/viewport overlay
// (data-liquid-glass-modal-viewport) with backdrop blur -- the same shell the Settings / Order Type
// modals use. So TableSelector no longer imports or calls renderModalPortal.
test('TableSelector overlays via the shared LiquidGlassModal glass shell (not renderModalPortal)', () => {
  assert.match(tableSelector, /import \{ LiquidGlassModal \} from '\.\.\/ui\/pos-glass-components'/);
  assert.match(tableSelector, /<LiquidGlassModal\b/);
  // The old hand-rolled portal shell + opaque backdrop are gone.
  assert.doesNotMatch(tableSelector, /renderModalPortal/);
  assert.doesNotMatch(tableSelector, /fixed inset-0 z-\[1200\] flex items-center justify-center/);
  assert.doesNotMatch(tableSelector, /absolute inset-0 bg-black\/50 backdrop-blur-sm/);
});
