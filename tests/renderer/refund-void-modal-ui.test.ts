import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = () =>
  readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'RefundVoidModal.tsx'),
    'utf8',
  );

const locale = (language: string) =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'locales', `${language}.json`), 'utf8'));

test('RefundVoidModal explains table-session settled payments instead of a bare empty state', () => {
  const src = source();

  assert.match(src, /const \[tableSettledPaid, setTableSettledPaid\] = useState\(false\)/);
  assert.match(
    src,
    /setTableSettledPaid\(\s*paymentList\.length === 0 && looksPaid && tableLinked,?\s*\)/,
    'detects a paid order with no order-linked payment rows and a table context',
  );
  assert.match(
    src,
    /tableSettledPaid \? \([\s\S]*?modals\.refund\.tableSettledBody/,
    'shows an honest table-session explanation when the order was settled on the table check',
  );
  // The generic "No payments found" copy is now the fallback, not the only branch.
  assert.match(src, /modals\.refund\.noPayments/);
});

test('RefundVoidModal payment status badges are localized rather than hardcoded English', () => {
  const src = source();

  assert.match(src, /modals\.refund\.statusCompleted/);
  assert.match(src, /modals\.refund\.statusVoided/);
  assert.match(src, /modals\.refund\.statusRefunded/);
  assert.doesNotMatch(src, />\s*Completed\s*<\/span>/);
  assert.doesNotMatch(src, />\s*Voided\s*<\/span>/);
  assert.doesNotMatch(src, />\s*Refunded\s*<\/span>/);
});

test('RefundVoidModal table-session explanation has locale coverage', () => {
  for (const language of ['en', 'el', 'de', 'fr', 'it', 'sq']) {
    const refund = locale(language).modals.refund;
    assert.equal(typeof refund.title, 'string');
    assert.equal(typeof refund.subtitle, 'string');
    assert.equal(typeof refund.tableSettledTitle, 'string');
    assert.equal(typeof refund.tableSettledBody, 'string');
    assert.ok(refund.tableSettledTitle.length > 0);
    assert.ok(refund.tableSettledBody.length > 0);
  }
});

// founder 11/11/2026: payment records remain information cards; their existing action buttons keep their handlers.
test('refund forms use frost with plain header/footer and reduced-motion reveals', () => {
  const src = source();
  assert.match(src, /data-testid=\{`refund-payment-\$\{payment\.id\}`\}\s+className="pos-glass-form-card space-y-3"/);
  assert.match(src, /data-testid=\{`refund-adjustment-\$\{adj\.id\}`\}\s+className="pos-glass-form-card p-3!"/);
  assert.equal((src.match(/liquid-glass-modal-input pos-glass-field min-h-touch/g) ?? []).length, 6);
  assert.match(src, /const modalHeader = \(\s*<div className="shrink-0 px-6 py-4">/);
  assert.match(src, /const modalFooter = \(\s*<div className="shrink-0 px-6 pb-5 pt-2">/);
  assert.doesNotMatch(src, /border-t\b|animate-in|hover:|<[a-z][^>]*\stitle=/);
  assert.equal((src.match(/const reduceMotion = useReducedMotion\(\);/g) ?? []).length, 2);
  assert.match(src, /duration: reduceMotion \? 0 : 0\.24, ease: \[0\.2, 0\.8, 0\.2, 1\]/);
  assert.match(src, /<AnimatePresence initial=\{false\}>/);
  assert.match(src, /<motion\.div[^>]*key="isrefunding-isgift"[^>]*\{\.\.\.revealMotion\}/);
});
