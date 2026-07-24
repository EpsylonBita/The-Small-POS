import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const dashboardSource = readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
  'utf8',
);
const paymentsSource = readFileSync(
  path.join(projectRoot, 'src-tauri', 'src', 'payments.rs'),
  'utf8',
);

test('payment-method edit exposes every completed payment row instead of blocking split orders', () => {
  assert.match(dashboardSource, /const handleEditPayment = async \(\) =>/);
  assert.match(
    dashboardSource,
    /await bridge\.payments\.getOrderPayments\(\s*editablePaymentOrder\.id,\s*\)/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /completedPayments\.length > 1[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
    'split payments must be selectable one row at a time',
  );
  assert.match(
    dashboardSource,
    /payments:\s*completedPayments\.map\(/,
  );
  assert.match(
    dashboardSource,
    /nextMethod,\s*\n\s*paymentId/,
    'the selected payment identity must cross the bridge with the requested cash/card method',
  );
});

test('native payment edit remains ambiguity-safe while supporting an explicit payment target', () => {
  assert.match(
    paymentsSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT/,
  );
  assert.match(
    paymentsSource,
    /update_payment_method_for_payment\(/,
  );
  assert.match(
    paymentsSource,
    /target_payment_id/,
  );
  assert.match(
    dashboardSource,
    /toast\.error\(message,\s*\{\s*id:\s*"payment-method-edit-error"\s*\}\)/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
    'the renderer should no longer present the old hard block for split payments',
  );
  assert.doesNotMatch(
    dashboardSource,
    /toast\.error\(extractOrderDashboardErrorMessage\(error\)/,
  );
});

test('per-payment edit instructions exist in every POS locale', () => {
  const languages = ['en', 'el', 'de', 'fr', 'it'];
  const values = languages.map((language) => {
    const locale = JSON.parse(
      readFileSync(path.join(projectRoot, 'src', 'locales', `${language}.json`), 'utf8'),
    );
    const value = locale?.modals?.editPaymentMethod?.selectPayment;
    assert.equal(typeof value, 'string', `${language} must define the per-payment edit instruction`);
    assert.ok(value.trim().length > 0, `${language} per-payment edit instruction must not be empty`);
    return value;
  });

  assert.notEqual(values[1], values[0], 'Greek instructions must not fall back to English');
});
