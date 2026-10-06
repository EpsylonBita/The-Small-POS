import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../locales/en.json';

// Desktop 1.4.124 (fix 10). Symptom: correcting a recorded invoice's amount
// to «1.234,50» answered «Invoice saved.» while the amount was never sent,
// and the office's refusal to change an amount that already has payments
// (409 SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS) showed raw English server text.
// Root cause: `Number('1.234,50'.replace(',', '.'))` is NaN, which the form
// skipped silently; the refusal code had no translated text.

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('react-i18next', async () => ({
  useTranslation: (await import('../../test/en-translate')).useTranslationEn,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('react-hot-toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../contexts/module-context', () => ({ useModules: () => ({ isModuleEnabled: () => true }) }));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: { databaseStaffId: 'staff-1' } }) }));
vi.mock('../../contexts/barcode-scanner-context', () => ({ useOnBarcodeScan: () => undefined }));
vi.mock('../../components/procurement/PurchaseOrdersTab', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CaptureScanSettingsModal', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CapturePagesPanel', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CaptureQueuePanel', () => ({
  default: ({ onCorrect }: { onCorrect: (invoice: unknown) => void }) => (
    <button onClick={() => onCorrect({
      invoiceId: 'A', invoiceNumber: 'original', invoiceDate: '2026-01-01',
      amount: 25, supplierName: 'Supplier', kind: 'goods', outcome: 'recorded',
    })}>Correct A</button>
  ),
}));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn(), terminalConfig: { getSetting: vi.fn() } }),
  onEvent: vi.fn(), offEvent: vi.fn(),
}));
vi.mock('../../utils/api-helpers', () => ({
  posApiGet: (...args: unknown[]) => mocks.get(...args),
  posApiPatch: (...args: unknown[]) => mocks.patch(...args),
  posApiFetch: vi.fn(), posApiPost: vi.fn(),
}));
vi.mock('../../services/offline-mutations', () => ({ offlineCommitSupplierImport: vi.fn() }));
vi.mock('../../services/capture-client', () => ({
  loadCaptureSources: vi.fn(async () => []), loadDefaultCaptureSourceId: vi.fn(async () => null),
  listCaptureDocuments: vi.fn(async () => []), resolveDefaultSource: vi.fn(() => null),
  acquireFromScanner: vi.fn(), advanceCapture: vi.fn(), confirmCaptureCommit: vi.fn(),
  getCaptureDocument: vi.fn(), saveCaptureDraft: vi.fn(), startCaptureDocument: vi.fn(),
}));
vi.mock('../../services/purchase-order-snapshot', () => ({ loadPurchaseOrderSnapshot: vi.fn(async () => []) }));

import SuppliersPage, { parseInvoiceAmountInput } from '../SuppliersPage';

const review = (en as any).suppliers.capture.review as Record<string, string>;

beforeEach(() => {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.startsWith('pos/supplier-invoices/')) {
      return { success: true, data: { success: true, invoice: {
        invoice_number: 'INV-1', invoice_date: '2026-01-02', due_date: '2026-02-01', amount: 25, notes: '',
      } } };
    }
    return { success: true, data: { suppliers: [], invoices: [], currency: 'EUR' } };
  });
  mocks.patch.mockResolvedValue({ success: true, data: { success: true } });
});
afterEach(cleanup);

async function openCorrection() {
  render(<SuppliersPage />);
  fireEvent.click(await screen.findByTestId('capture-queue-open'));
  fireEvent.click(await screen.findByText('Correct A'));
  await screen.findByDisplayValue('25');
}
const typeAmount = (value: string) => fireEvent.change(screen.getByDisplayValue('25'), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));

describe('reading a typed invoice amount', () => {
  it.each([
    ['1.234,50', 1234.5],
    ['1,234.50', 1234.5],
    ['1234,50', 1234.5],
    ['1234.50', 1234.5],
    ['1234,5', 1234.5],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1.234.567', 1234567],
    ['1 234,50', 1234.5],
    ['€ 99', 99],
    ['0,99', 0.99],
    ['25', 25],
  ])('reads %j as %s', (raw, expected) => {
    expect(parseInvoiceAmountInput(raw)).toBe(expected);
  });

  it.each([
    '1.234', '1,234', // a thousands mark or a decimal point: never guessed
    '12,3,4', '1.23.45', '1,23.45', '1.234,567', '12.345,6.7',
    'abc', '12a', '-5', '0', '0,00', '', ' ', ',', '1e3', 'Infinity',
  ])('refuses %j', raw => {
    expect(parseInvoiceAmountInput(raw)).toBeNull();
  });
});

describe('recorded invoice amount correction', () => {
  it.each([
    ['1.234,50', 1234.5],
    ['1,234.50', 1234.5],
  ])('sends %j as %s and only then says it was saved', async (typed, amount) => {
    await openCorrection();
    typeAmount(typed);
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { amount }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(review.saved));
  });

  it.each(['1.234', 'abc', '0'])('refuses %j in words, sends nothing and keeps the form open', async typed => {
    await openCorrection();
    fireEvent.change(screen.getByPlaceholderText('Invoice number'), { target: { value: 'INV-2' } });
    typeAmount(typed);
    save();

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(review.amountInvalid));
    expect(review.amountInvalid).toBeTruthy();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalledWith(review.saved);
    expect(screen.getByText(review.amountInvalid)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Invoice number')).toHaveValue('INV-2');
  });

  it('refuses an emptied amount instead of saving without it', async () => {
    await openCorrection();
    typeAmount('');
    save();
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(review.amountInvalid));
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([
    ['the typed code', {
      success: false, status: 409, code: 'SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS',
      error: 'Invoice amount cannot change after a payment has been recorded (HTTP 409)',
    }],
    ['the code inside the bridge text', {
      success: false, status: 409,
      error: 'Invoice amount cannot change after a payment has been recorded (HTTP 409): {"success":false,"error":"Invoice amount cannot change after a payment has been recorded","code":"SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS"}',
    }],
  ])('names the paid-invoice amount lock in words (%s)', async (_shape, refusal) => {
    mocks.patch.mockResolvedValue(refusal);
    await openCorrection();
    typeAmount('30');
    save();

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { amount: 30 }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(review.amountHasPayments));
    expect(review.amountHasPayments).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalledWith(review.saved);
    expect(screen.getByText(review.amountHasPayments)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 409/)).toBeNull();
  });
});
