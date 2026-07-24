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

test('payment-method edit checks completed payment rows before opening the single-payment modal', () => {
  assert.match(dashboardSource, /const handleEditPayment = async \(\) =>/);
  assert.match(
    dashboardSource,
    /await bridge\.payments\.getOrderPayments\(\s*editablePaymentOrder\.id,\s*\)/,
  );
  assert.match(
    dashboardSource,
    /completedPayments\.length > 1[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
  );
  assert.match(
    dashboardSource,
    /completedPayments\.length === 1[\s\S]*?completedPayments\[0\]\?\.method/,
  );
});

test('native payment edit ambiguity is a stable code that the renderer localizes and deduplicates', () => {
  assert.match(
    paymentsSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT/,
  );
  assert.match(
    dashboardSource,
    /PAYMENT_METHOD_EDIT_REQUIRES_SINGLE_COMPLETED_PAYMENT[\s\S]*?paymentMethodEditRequiresSingleCompletedPayment/,
  );
  assert.match(
    dashboardSource,
    /toast\.error\(message,\s*\{\s*id:\s*"payment-method-edit-error"\s*\}\)/,
  );
  assert.doesNotMatch(
    dashboardSource,
    /toast\.error\(extractOrderDashboardErrorMessage\(error\)/,
  );
});

test('split-payment edit explanation exists in every POS locale', () => {
  const languages = ['en', 'el', 'de', 'fr', 'it'];
  const values = languages.map((language) => {
    const locale = JSON.parse(
      readFileSync(path.join(projectRoot, 'src', 'locales', `${language}.json`), 'utf8'),
    );
    const value = locale?.orderDashboard?.paymentMethodEditRequiresSingleCompletedPayment;
    assert.equal(typeof value, 'string', `${language} must define the split-payment edit explanation`);
    assert.ok(value.trim().length > 0, `${language} split-payment edit explanation must not be empty`);
    return value;
  });

  assert.notEqual(values[1], values[0], 'Greek explanation must not fall back to English');
});
