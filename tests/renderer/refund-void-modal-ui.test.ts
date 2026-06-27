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
  for (const language of ['en', 'el', 'de', 'fr', 'it']) {
    const refund = locale(language).modals.refund;
    assert.equal(typeof refund.title, 'string');
    assert.equal(typeof refund.subtitle, 'string');
    assert.equal(typeof refund.tableSettledTitle, 'string');
    assert.equal(typeof refund.tableSettledBody, 'string');
    assert.ok(refund.tableSettledTitle.length > 0);
    assert.ok(refund.tableSettledBody.length > 0);
  }
});
