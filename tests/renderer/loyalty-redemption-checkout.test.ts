import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const menuModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'MenuModal.tsx');
const menuCartPath = path.join(projectRoot, 'src', 'renderer', 'components', 'menu', 'MenuCart.tsx');
const loyaltyRedeemModalPath = path.join(projectRoot, 'src', 'renderer', 'components', 'modals', 'LoyaltyRedeemModal.tsx');
const orderDashboardPath = path.join(projectRoot, 'src', 'renderer', 'components', 'OrderDashboard.tsx');
const orderFlowPath = path.join(projectRoot, 'src', 'renderer', 'components', 'OrderFlow.tsx');
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

test('loyalty redemption is an explicit checkout discount, not an immediate modal mutation', () => {
  const menuModal = source(menuModalPath);
  const menuCart = source(menuCartPath);
  const redeemModal = source(loyaltyRedeemModalPath);

  assert.match(menuCart, /loyaltyDiscountAmount/);
  assert.match(
    menuCart,
    /subtotal - offerDiscountAmount - discountAmount - couponDiscount - loyaltyDiscountAmount/,
  );
  assert.match(menuCart, /onOpenLoyaltyRedeem/);
  assert.match(menuCart, /onRemoveLoyaltyRedemption/);
  assert.match(menuCart, /loyaltyRedeemableAmount/);
  assert.match(menuCart, /menu\.cart\.loyaltyAvailable/);
  assert.match(menuCart, /menu\.cart\.loyaltyDiscount/);
  assert.match(menuCart, /loyaltyFeatureEnabled/);
  assert.match(menuCart, /isCouponModalOpen && loyaltyFeatureEnabled/);

  assert.match(menuModal, /LoyaltyRedeemModal/);
  assert.match(menuModal, /loyalty_redemption/);
  assert.match(menuModal, /hasLoyaltyModule/);
  assert.match(menuModal, /effectiveLoyaltyRedemption/);
  assert.match(menuModal, /maxRedeemablePoints=\{maxLoyaltyRedeemablePoints\}/);
  assert.match(menuModal, /bridge\.loyalty\.getCustomerBalance\(loyaltyCustomerId\)/);

  assert.doesNotMatch(redeemModal, /bridge\.loyalty\.redeemPoints/);
  assert.match(redeemModal, /createPortal/);
  assert.match(redeemModal, /document\.body/);
  assert.match(redeemModal, /z-2147483000(?![\w.-])/);
  assert.match(redeemModal, /liquid-glass-modal-shell/);
  assert.match(redeemModal, /liquid-glass-modal-input/);
  assert.match(redeemModal, /liquid-glass-modal-button/);
  assert.doesNotMatch(redeemModal, /type="number"/);
  assert.match(redeemModal, /inputMode="numeric"/);
  assert.match(redeemModal, /amountInput/);
  assert.match(redeemModal, /handleAmountChange/);
  assert.match(redeemModal, /onRedeem\(discountPreview, pointsToRedeem\)/);
});

test('orders secure prepared loyalty points before saving under the checkout identity', () => {
  const orderDashboard = source(orderDashboardPath);
  const orderFlow = source(orderFlowPath);

  for (const checkoutSource of [orderDashboard, orderFlow]) {
    assert.match(checkoutSource, /MODULE_IDS\.LOYALTY/);
    assert.match(checkoutSource, /hasLoyaltyModule/);
    assert.match(checkoutSource, /orderData\.loyalty_redemption/);
    assert.match(checkoutSource, /loyalty_discount_amount/);
    assert.match(checkoutSource, /await saveOrderWithLoyalty\(/);
    assert.match(checkoutSource, /takeCheckoutRequestId\(orderData\.clientRequestId\)/);
    assert.doesNotMatch(checkoutSource, /bridge\.loyalty\s*\.redeemPoints/);
    assert.match(checkoutSource, /loyalty\.checkoutRefused/);
    // Ω11: offline, refused and unconfirmed points each say what happened.
    assert.match(checkoutSource, /error instanceof LoyaltyRedemptionUnconfirmed/);
    assert.match(checkoutSource, /loyaltyCheckoutMessageKey\(error\)/);
  }
});

// Ω11 (22/10/2026): points are redeemed only with a live server answer. An
// unconfirmed answer keeps the points with Retry and Remove points; offline or
// refused clears them and the sale continues without the discount.
test('the menu offers Retry and Remove points for an unconfirmed redemption', () => {
  const menuModal = source(menuModalPath);
  assert.match(menuModal, /error instanceof LoyaltyRedemptionUnconfirmed/);
  assert.match(menuModal, /notifyLoyaltyRedemptionUnconfirmed\(\)/);
  assert.match(menuModal, /retryLoyaltyConfirmation/);
  assert.match(menuModal, /removeUnconfirmedLoyaltyPoints/);
  assert.match(menuModal, /loyalty\.redeem\.removePoints/);
  assert.match(menuModal, /loyaltyCheckoutMessageKey\(error\)/);
  // A declined card renews the checkout: its old live debit is released.
  assert.match(menuModal, /releaseRedemption\(\{ orderId: previousCheckoutRequestId \}\)/);
});

test('loyalty redemption checkout translations exist in every POS locale', () => {
  const requiredMenuKeys = [
    'cart.loyaltyDiscount',
    'cart.loyaltyButton',
    'cart.redeemLoyalty',
    'cart.loyaltyAvailable',
    'cart.loyaltyAvailableTitle',
    'cart.loyaltyRedemption',
    'cart.loyaltyOff',
    'cart.removeLoyaltyRedemption',
  ];
  const requiredLoyaltyKeys = [
    'redeemFailed',
    'checkoutRefused',
    'redeemPrepared',
    'noCustomerSelected',
    'moduleUnavailable',
    'settingsUnavailable',
    'noAccountForCustomer',
    'notEnoughRedeemablePoints',
    'pointsShort',
    'amountToRedeem',
    'availableBalance',
    'maxRedeemable',
    'minimumRedeemable',
    'manualRedeemHint',
    'redeem.offlineRefused',
    'redeem.refusedBody',
    'redeem.confirmationRequired',
    'redeem.releasedForCheckout',
    'redeem.removePoints',
    'redeem.confirmed',
    'redeem.releaseFailed',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const menuKeys = flattenKeys(locale.menu);
    const loyaltyKeys = flattenKeys(locale.loyalty);
    const missing = [
      ...requiredMenuKeys.filter(key => !menuKeys.has(key)).map(key => `menu.${key}`),
      ...requiredLoyaltyKeys.filter(key => !loyaltyKeys.has(key)).map(key => `loyalty.${key}`),
    ];

    assert.deepEqual(missing, [], `${file} is missing loyalty redemption translations`);
  }
});
