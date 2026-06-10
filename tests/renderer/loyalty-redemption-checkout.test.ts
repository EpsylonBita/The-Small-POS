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
  assert.match(redeemModal, /z-\[2147483000\]/);
  assert.match(redeemModal, /liquid-glass-modal-shell/);
  assert.match(redeemModal, /liquid-glass-modal-input/);
  assert.match(redeemModal, /liquid-glass-modal-button/);
  assert.doesNotMatch(redeemModal, /type="number"/);
  assert.match(redeemModal, /inputMode="numeric"/);
  assert.match(redeemModal, /amountInput/);
  assert.match(redeemModal, /handleAmountChange/);
  assert.match(redeemModal, /onRedeem\(discountPreview, pointsToRedeem\)/);
});

test('orders redeem prepared loyalty points only after a persisted order id exists', () => {
  const orderDashboard = source(orderDashboardPath);
  const orderFlow = source(orderFlowPath);

  for (const checkoutSource of [orderDashboard, orderFlow]) {
    assert.match(checkoutSource, /MODULE_IDS\.LOYALTY/);
    assert.match(checkoutSource, /hasLoyaltyModule/);
    assert.match(checkoutSource, /orderData\.loyalty_redemption/);
    assert.match(checkoutSource, /loyalty_discount_amount/);
    assert.match(checkoutSource, /bridge\.loyalty\s*\n?\s*\.redeemPoints\(\{/);
    assert.match(checkoutSource, /orderId: result\.orderId/);
    assert.match(checkoutSource, /loyalty\.redeemFailed/);
  }
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
