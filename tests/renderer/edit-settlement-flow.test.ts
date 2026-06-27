import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const orderDashboardSource = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'OrderDashboard.tsx'),
    'utf8',
  );

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

test('paid pickup edit collect flow waits for payment choice before committing item changes', () => {
  const source = orderDashboardSource();
  const collectBranch = source.slice(
    source.indexOf('previews[0]?.requiredAction === "collect"'),
    source.indexOf('previews[0]?.requiredAction === "refund"'),
  );

  assert.ok(collectBranch.length > 0, 'collect branch should be present');
  assert.doesNotMatch(
    collectBranch,
    /const refreshedPreview = await bridge\.orders\.previewEditSettlement/,
    'pickup collect edits must not save first and then re-preview the settlement delta',
  );
  assert.doesNotMatch(
    collectBranch,
    /openEditSettlementCollectionPrompt\(refreshedPreview, request\)/,
    'pickup collect prompt should use the original preview instead of a post-save preview',
  );
  assert.match(
    collectBranch,
    /openEditSettlementCollectionPrompt\(previews\[0\], request\)/,
    'collect edits should open the settlement prompt with the original preview',
  );
});

test('settlement prompts only fire for the collect/refund requiredAction (never unpaid no-op)', () => {
  const source = orderDashboardSource();
  // The extra-payment collection prompt is gated strictly on requiredAction "collect",
  // and the refund prompt on "refund"; everything else (incl. unpaid/pending edits the
  // Rust preview now reports as "none") falls through to the plain applyEditSettlement
  // path. So a no-op edit on an unpaid order can never open the Extra Payment modal.
  assert.match(source, /previews\[0\]\?\.requiredAction === "collect"/);
  assert.match(source, /previews\[0\]\?\.requiredAction === "refund"/);
  // The non-settlement path commits with action { type: "none" } and does not prompt.
  assert.match(source, /action: \{ type: "none" \}/);
});

test('edit-settlement collect + table-update toasts are routed through i18n (no bare English literal)', () => {
  const source = orderDashboardSource();
  // The payment-required toast and the table-updated toast both go through t(...) with
  // a locale key, so the Greek UI no longer shows the English defaultValue.
  assert.match(source, /toast\(\s*t\("orderDashboard\.orderEditPaymentRequiredToSave"/);
  assert.match(source, /t\("orderDashboard\.tableOrderUpdated"/);
  // The strings must not be passed to toast as bare literals (outside a t() call).
  assert.doesNotMatch(source, /toast\(\s*["']Choose how to collect the extra payment/);
  assert.doesNotMatch(source, /toast\.success\(\s*["']Table check updated/);
});

test('edit-settlement payment/table toast keys exist in every locale and Greek is translated', () => {
  const KEYS = ['orderEditPaymentRequiredToSave', 'tableOrderUpdated'];
  const GREEK = new RegExp('[\\u0370-\\u03FF]');
  for (const lang of ['en', 'el', 'de', 'fr', 'it']) {
    const od = locale(lang).orderDashboard;
    assert.ok(od, `${lang} missing orderDashboard`);
    for (const key of KEYS) {
      assert.equal(typeof od[key], 'string', `${lang}.orderDashboard.${key} missing`);
      assert.ok(od[key].length > 0, `${lang}.orderDashboard.${key} empty`);
    }
  }
  const el = locale('el').orderDashboard;
  const en = locale('en').orderDashboard;
  for (const key of KEYS) {
    assert.match(el[key], GREEK, `el orderDashboard.${key} should be Greek`);
    assert.notEqual(el[key], en[key], `el orderDashboard.${key} must differ from the English source`);
  }
});
