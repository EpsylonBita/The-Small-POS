import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const tablesPageSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'TablesPage.tsx'),
  'utf8',
);

const newOrderPageSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'pages', 'NewOrderPage.tsx'),
  'utf8',
);

test('TablesPage gates new table orders before navigating to guarded order entry', () => {
  assert.match(tablesPageSource, /import \{ useFeatures \} from '\.\.\/hooks\/useFeatures';/);
  assert.match(tablesPageSource, /const \{ isFeatureEnabled, loading: featuresLoading \} = useFeatures\(\);/);
  assert.match(tablesPageSource, /const canCreateOrders = isFeatureEnabled\('orderCreation'\);/);
  assert.match(tablesPageSource, /canCreateOrders=\{canCreateOrders\}/);
  assert.match(tablesPageSource, /featuresLoading=\{featuresLoading\}/);
  // Disabled state is based on LOADED feature state, so it never disables during the
  // brief feature-loading window (which would otherwise flicker / mis-gate).
  assert.match(tablesPageSource, /const isNewOrderActionDisabled = !table\.currentOrderId && !featuresLoading && !canCreateOrders;/);
  assert.match(tablesPageSource, /disabled=\{isNewOrderActionDisabled\}/);
  assert.match(tablesPageSource, /aria-disabled=\{isNewOrderActionDisabled\}/);
});

test('TablesPage keeps disabled new-order attempts on the table grid with localized copy', () => {
  assert.match(
    tablesPageSource,
    /const orderCreationDisabledMessage = t\(\s*'settings\.terminal\.messages\.orderCreationDisabled'/,
  );
  // The currentOrderId ("View Order") branch returns earlier, so the creation gate
  // applies to genuine new-order attempts: a bare !featuresLoading && !canCreateOrders.
  assert.match(
    tablesPageSource,
    /if \(!featuresLoading && !canCreateOrders\) \{[\s\S]*toast\.error\(orderCreationDisabledMessage\);[\s\S]*return;/,
  );
  assert.doesNotMatch(
    tablesPageSource,
    /terminal\.messages\.featureDisabled/,
    'TablesPage must not use the missing terminal.messages.featureDisabled key',
  );
});

test('NewOrderPage fallback guard uses the valid localized terminal settings key', () => {
  assert.match(
    newOrderPageSource,
    /toast\.error\(t\('settings\.terminal\.messages\.orderCreationDisabled', 'Order creation is disabled for this terminal'\)\);/,
  );
  assert.doesNotMatch(
    newOrderPageSource,
    /terminal\.messages\.featureDisabled/,
    'NewOrderPage must not fall back through the missing terminal.messages.featureDisabled key',
  );
});

test('NewOrderPage waits for terminal features to load before redirecting', () => {
  // The fail-closed default (orderCreation=false) must not redirect + toast during the
  // brief loading window; only once features have settled and creation is truly off.
  assert.match(
    newOrderPageSource,
    /const \{ isFeatureEnabled, isMobileWaiter, loading: featuresLoading \} = useFeatures\(\);/,
  );
  assert.match(newOrderPageSource, /if \(!featuresLoading && !canCreateOrders\) \{/);
  // The pre-load redirect (bare !canCreateOrders guard) must be gone.
  assert.doesNotMatch(newOrderPageSource, /if \(!canCreateOrders\) \{/);
});
