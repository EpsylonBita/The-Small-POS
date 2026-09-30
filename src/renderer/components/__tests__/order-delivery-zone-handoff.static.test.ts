import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source guards for the delivery-zone hand-off in the order flows.
 *
 * Symptom (desktop 1.4.118): "Address is outside delivery area" after editing
 * an existing customer's address, and 1,845 out-of-zone checks of the point
 * (0,0) at one store since May 2026 (silent in the menu, but they blocked the
 * geolocation recovery and left orders without a zone).
 * Root cause: `Number(null) === 0` passes `Number.isFinite`, so every copy of
 * `toLatLngCoordinates` (and the CustomerSearchModal mappers) turned an
 * address without coordinates into (0,0); after an address edit the dashboard
 * re-checked the DEFAULT address instead of the edited one.
 *
 * OrderDashboard needs the whole POS context to mount, so these guards pin
 * the wiring; the behaviour itself is covered by the unit tests of
 * utils/delivery-zone-handoff, utils/coordinates, MenuModal and MenuCart.
 */
const renderer = path.join(__dirname, '..', '..');
const read = (...segments: string[]) => fs.readFileSync(path.join(renderer, ...segments), 'utf8');

const ORDER_DASHBOARD = read('components', 'OrderDashboard.tsx');
const ORDER_FLOW = read('components', 'OrderFlow.tsx');
const NEW_ORDER_PAGE = read('pages', 'NewOrderPage.tsx');
const CUSTOMER_SEARCH = read('components', 'modals', 'CustomerSearchModal.tsx');
const MENU_MODAL = read('components', 'modals', 'MenuModal.tsx');
const PRODUCT_CATALOG = read('components', 'modals', 'ProductCatalogModal.tsx');
const CUSTOMER_ADDRESSES = read('utils', 'customer-addresses.ts');
const GEOLOCATION = read('utils', 'saved-address-geolocation.ts');
const PICKUP_TO_DELIVERY = read('utils', 'pickup-to-delivery.ts');
const ZONE_VALIDATOR = fs.readFileSync(path.join(renderer, '..', 'services', 'DeliveryZoneValidator.ts'), 'utf8');

// `Number.isFinite(Number(x.latitude))`-style reads accept null as 0.
const LENIENT_COORDINATE_READ = /Number\.isFinite\(\s*Number\([^)]*\b(lat|lng|latitude|longitude)\b/;

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} should exist`).toBeGreaterThanOrEqual(0);
  // Handlers in these files end at the next top-level `const handle...` or a
  // blank-line-separated declaration; a generous window is enough for guards.
  return source.slice(start, start + 6000);
}

describe('order flows read coordinates strictly', () => {
  it.each([
    ['OrderDashboard.tsx', ORDER_DASHBOARD],
    ['OrderFlow.tsx', ORDER_FLOW],
    ['NewOrderPage.tsx', NEW_ORDER_PAGE],
  ])('%s has no local toLatLngCoordinates copy', (_name, source) => {
    expect(source).not.toMatch(/const\s+toLatLngCoordinates\s*=/);
    expect(source).toMatch(/toValidLatLng/);
  });

  it.each([
    ['OrderDashboard.tsx', ORDER_DASHBOARD],
    ['OrderFlow.tsx', ORDER_FLOW],
    ['NewOrderPage.tsx', NEW_ORDER_PAGE],
    ['CustomerSearchModal.tsx', CUSTOMER_SEARCH],
    ['customer-addresses.ts', CUSTOMER_ADDRESSES],
    ['saved-address-geolocation.ts', GEOLOCATION],
    ['pickup-to-delivery.ts', PICKUP_TO_DELIVERY],
  ])('%s never reads a coordinate with Number.isFinite(Number(...))', (_name, source) => {
    expect(source).not.toMatch(LENIENT_COORDINATE_READ);
  });
});

describe('address hand-off after the customer/address modal', () => {
  it('sends the order to the edited/selected address and never re-checks another one', () => {
    const body = functionBody(ORDER_DASHBOARD, 'const handleNewCustomerAdded = async');
    expect(body).toMatch(/resolveHandoffCustomer\(/);
    expect(body).toMatch(/planDeliveryZoneHandoff\(/);
    expect(body).toMatch(/MODAL_ZONE_VALIDATION_FIELD/);
    expect(body).not.toMatch(/addressCoordinates \|\| addressString/);
  });

  it('checks a selected customer\'s zone only with a real point', () => {
    const body = functionBody(ORDER_DASHBOARD, 'const handleCustomerSelectedDirect = async');
    expect(body).toMatch(/planDeliveryZoneHandoff\(\{ address: resolvedAddress \}\)/);
    expect(body).not.toMatch(/addressCoordinates \|\| addressString/);
  });

  it('NewOrderPage resolves the edited address too', () => {
    const body = functionBody(NEW_ORDER_PAGE, 'const handleNewCustomerAdded = (customer: any) =>');
    expect(body).toMatch(/resolveHandoffCustomer\(/);
  });
});

describe('"zone not checked" notice and re-pick', () => {
  it('every order host gives the menu a re-pick action, and the menu hands it to the cart', () => {
    expect(ORDER_DASHBOARD).toMatch(/onRepickDeliveryAddress=\{handleRepickDeliveryAddress\}/);
    expect(NEW_ORDER_PAGE).toMatch(/onRepickDeliveryAddress=\{handleRepickDeliveryAddress\}/);
    // OrderFlow (FAB/table host, retail catalogue): both the menu and the catalogue.
    expect(ORDER_FLOW.match(/onRepickDeliveryAddress=\{handleRepickDeliveryAddress\}/g)).toHaveLength(2);
    expect(MENU_MODAL).toMatch(/onRepickDeliveryAddress=\{editMode \? undefined : onRepickDeliveryAddress\}/);
    expect(PRODUCT_CATALOG).toMatch(/onClick=\{onRepickDeliveryAddress\}/);
  });

  it.each([
    ['OrderDashboard.tsx', ORDER_DASHBOARD, 'const handleRepickDeliveryAddress = useCallback'],
    ['NewOrderPage.tsx', NEW_ORDER_PAGE, 'const handleRepickDeliveryAddress = () =>'],
    ['OrderFlow.tsx', ORDER_FLOW, 'const handleRepickDeliveryAddress = useCallback'],
  ])('%s opens the address editor through planDeliveryAddressRepick', (_name, source, signature) => {
    const body = functionBody(source, signature).slice(0, 1500);
    expect(body).toMatch(/planDeliveryAddressRepick\(/);
    expect(body).toMatch(/menuAddressRepickRef\.current = true/);
  });

  it('the retail catalogue never blocks a sale whose zone was not checked', () => {
    expect(PRODUCT_CATALOG).toContain("(isResolvingSelectedAddressCoordinates ? 'loading' : 'not_checked')");
    expect(PRODUCT_CATALOG).toContain(
      "(orderType === 'delivery' && hasDeliveryPro && !canCheckoutWithDeliveryFeeStatus(deliveryFeeStatus))",
    );
    expect(PRODUCT_CATALOG).toContain("t('menu.cart.deliveryZoneNotCheckedNotice')");
  });

  it('closing the re-pick keeps the order\'s customer (no reset to null)', () => {
    const close = functionBody(ORDER_DASHBOARD, 'const closeAddCustomerModal = useCallback');
    const repickBranch = close.slice(0, close.indexOf('if (pickupToDeliveryContext)'));
    expect(repickBranch).toMatch(/menuAddressRepickRef\.current/);
    expect(repickBranch).toMatch(/withoutRepickTarget\(/);
    expect(repickBranch).not.toMatch(/setExistingCustomer\(null\)/);
  });

  it('NewOrderPage: closing the re-pick keeps the customer; only a normal close resets it', () => {
    const start = NEW_ORDER_PAGE.indexOf('<AddCustomerModal');
    expect(start).toBeGreaterThanOrEqual(0);
    const onClose = NEW_ORDER_PAGE.slice(start, NEW_ORDER_PAGE.indexOf('onCustomerAdded=', start));
    const branchStart = onClose.indexOf('if (menuAddressRepickRef.current)');
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const branchEnd = onClose.indexOf('return;', branchStart);
    const repickBranch = onClose.slice(branchStart, branchEnd);
    expect(repickBranch).toMatch(/withoutRepickTarget\(/);
    expect(repickBranch).not.toMatch(/setExistingCustomer\(null\)/);
    // The reset to null comes only after the re-pick branch returned.
    expect(onClose.indexOf('setExistingCustomer(null)')).toBeGreaterThan(branchEnd);
  });

  it('OrderFlow: a saved re-pick returns to the same menu; a closed one keeps the order', () => {
    const added = functionBody(ORDER_FLOW, 'const handleCustomerAdded = useCallback');
    const repickBranch = added.slice(0, added.indexOf('const wasEditing'));
    expect(repickBranch).toMatch(/menuAddressRepickRef\.current/);
    expect(repickBranch).toMatch(/resolveHandoffCustomer\(/);
    expect(repickBranch).toMatch(/planDeliveryZoneHandoff\(/);
    expect(repickBranch).not.toMatch(/setIsCustomerSearchModalOpen\(true\)/);
    expect(repickBranch).not.toMatch(/setIsMenuModalOpen\(false\)/);
    const start = ORDER_FLOW.indexOf('<AddCustomerModal');
    const onClose = ORDER_FLOW.slice(start, ORDER_FLOW.indexOf('onCustomerAdded=', start));
    expect(onClose).toMatch(/menuAddressRepickRef\.current = false/);
    expect(onClose).not.toMatch(/setSelectedCustomer\(|resetFlow\(/);
  });
});

describe('pickup -> delivery conversion (founder decision 4)', () => {
  it('geolocates an unlocated address, answers "not checked" locally and never asks for an override for it', () => {
    const start = ORDER_DASHBOARD.indexOf('const convertPickupOrderToDelivery = useCallback');
    const end = ORDER_DASHBOARD.indexOf('const handleCustomerSelectedDirect = async', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = ORDER_DASHBOARD.slice(start, end);
    expect(body).toMatch(/resolveSavedAddressCoordinates\(/);
    expect(body).toMatch(/persistGeocodedSavedAddressCoordinates\(/);
    expect(body).toMatch(/createUncheckedDeliveryZoneResult\(\)/);
    // The override request sits behind the decision's canProceed/canAttemptOverride.
    const decision = body.indexOf('decidePickupToDeliveryZone(validationResult)');
    const override = body.indexOf('requestDeliveryOverride(');
    expect(decision).toBeGreaterThanOrEqual(0);
    expect(override).toBeGreaterThan(decision);
    expect(body.slice(decision, override)).toMatch(/if \(!canProceed\)/);
    expect(body.slice(decision, override)).toMatch(/if \(!canAttemptOverride\)/);
    expect(body).toMatch(/deliveryZoneNotCheckedNotice/);
  });
});

describe('terminal zone-check cache', () => {
  it('uses a versioned storage key so cached (0,0) verdicts of 1.4.118 are discarded', () => {
    expect(ZONE_VALIDATOR).toMatch(/DELIVERY_VALIDATION_CACHE_STORAGE_KEY = 'pos_delivery_validation_cache_v2'/);
    expect(ZONE_VALIDATOR).toMatch(/LEGACY_DELIVERY_VALIDATION_CACHE_STORAGE_KEYS = \['pos_delivery_validation_cache'\]/);
  });
});
