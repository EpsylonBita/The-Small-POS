import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const suppliersPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'SuppliersPage.tsx');
const localesDir = path.join(projectRoot, 'src', 'locales');

const suppliersPageSource = () => readFileSync(suppliersPagePath, 'utf8');

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

test('SuppliersPage is a hidden-scrollbar supplier workbench', () => {
  const source = suppliersPageSource();

  assert.match(source, /h-full min-h-0 overflow-hidden/);
  assert.match(source, /overflow-y-auto scrollbar-hide/);
  assert.match(source, /aria-label=\{t\('common.refresh'/);
  assert.match(source, /h-12 w-12/);
});

test('SuppliersPage supports POS-only scan and review-first import actions', () => {
  const source = suppliersPageSource();

  assert.match(source, /useOnBarcodeScan/);
  assert.match(source, /BarcodeDetector/);
  assert.match(source, /extractSupplierImportFile/);
  assert.match(source, /pos\/suppliers\/import\/preview/);
  assert.match(source, /pos\/suppliers\/import\/commit/);
  assert.match(source, /pos\/supplier-invoices\/\$\{invoiceId\}\/mark-\$\{status\}/);
  assert.match(source, /pos\/supplier-invoices\/\$\{selectedInvoice\.id\}\/payments/);
  assert.match(source, /partialPayment/);
  assert.match(source, /Supplier summary/);
  assert.match(source, /getInvoiceDisplayDate/);
  assert.match(source, /currencySymbol/);
  assert.match(source, /formatCurrency\(amount, currencyCode, i18n\.language\)/);
  assert.doesNotMatch(source, /DollarSign/);
  assert.match(source, /saveAfterPreview/);
  assert.match(source, /endpointUnavailable/);
});

test('SuppliersPage supplier translation keys exist in every POS locale', () => {
  const requiredKeys = [
    'import.open',
    'import.title',
    'import.preview',
    'import.commit',
    'import.fileReadFailed',
    'import.importedRows',
    'import.rowCount',
    'import.saveAfterPreview',
    'import.saveRequiresPreview',
    'import.previewThenSaveHelp',
    'import.endpointUnavailable',
    'import.adminHtmlError',
    'import.supplierEmail',
    'import.hardwareScanner',
    'import.supplierNotes',
    'import.supplierPhone',
    'import.camera',
    'import.status.create',
    'import.status.update',
    'import.status.skip',
    'invoices.markPaid',
    'invoices.markUnpaid',
    'invoices.invoiceDate',
    'invoices.partialPayment',
    'invoices.detailsTitle',
    'invoices.totalSpent',
    'invoices.paidTotal',
    'invoices.unpaidTotal',
    'invoices.invoiceCount',
    'invoices.paidAmount',
    'invoices.remaining',
    'invoices.paymentOptions',
    'invoices.paymentAmount',
    'invoices.reference',
    'invoices.paymentNotes',
    'invoices.recordPayment',
    'invoices.payRemaining',
    'invoices.payments',
    'invoices.noPayments',
    'invoices.noPaymentNeeded',
    'invoices.paymentRecorded',
    'invoices.paymentFailed',
    'invoices.paymentAmountRequired',
    'invoices.paymentAmountTooHigh',
    'invoices.methods.cash',
    'invoices.methods.bankTransfer',
    'invoices.methods.check',
    'invoices.methods.creditCard',
    'invoices.methods.other',
    'summary.title',
    'status.unpaid',
    'status.partial',
    'status.paid',
    'status.overdue',
    'status.cancelled',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const available = flattenKeys(locale.suppliers);
    const missing = requiredKeys.filter(key => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing SuppliersPage translations:\n${missing.map(key => `  - suppliers.${key}`).join('\n')}`,
    );
  }
});
