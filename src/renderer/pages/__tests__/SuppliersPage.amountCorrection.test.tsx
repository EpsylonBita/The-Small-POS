import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../locales/en.json';

// Desktop 1.4.124 (fix 10). Symptom: correcting a recorded invoice's amount
// to «1.234,50» answered «Invoice saved.» while the amount was never sent,
// and the office's refusal to change an amount that already has payments
// (409 SUPPLIER_INVOICE_AMOUNT_HAS_PAYMENTS) showed raw English server text.
// Root cause: `Number('1.234,50'.replace(',', '.'))` is NaN, which the form
// skipped silently; the refusal code had no translated text.

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), error: vi.fn(), success: vi.fn() }));
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
  posApiFetch: vi.fn(), posApiPost: (...args: unknown[]) => mocks.post(...args),
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
  await screen.findByDisplayValue('25,00');
}
// The amount is a digit-entry money field: typed digits are cents (123450 -> 1.234,50).
const typeAmount = (value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: (en as any).suppliers.amount }), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));

describe('supplier payment entry', () => {
  const labels = (en as any).suppliers.invoices;
  async function openPayment() {
    mocks.get.mockResolvedValue({ success: true, data: {
      suppliers: [{ id: 'supplier-1', name: 'Test supplier', is_active: true }],
      invoices: [{ id: 'payment-invoice', supplier_id: 'supplier-1', invoice_number: 'AUDIT-1', amount: 2000, status: 'unpaid', created_at: '2026-10-09', due_date: '2026-10-10' }],
      currency: 'CHF',
    } });
    render(<SuppliersPage />);
    fireEvent.click(await screen.findByRole('button', { name: labels.title, exact: true }));
    fireEvent.click(await screen.findByText('#AUDIT-1'));
    return screen.findByRole('textbox', { name: labels.paymentAmount });
  }
  beforeEach(() => mocks.post.mockReset());

  it.each(['12abc', '1e3', '-5'])('refuses %s at the keyboard and keeps the amount shown', async value => {
    const input = await openPayment();
    expect(input).toHaveValue('2.000,00');
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue('2.000,00');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuses an emptied payment amount without a payment request', async () => {
    const input = await openPayment();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: labels.recordPayment, exact: true }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it.each(['123450', '1.234,50', '1,234.50'])('reads %s as digits in cents and sends 1234.50', async value => {
    mocks.post.mockResolvedValue({ success: true, data: { success: true } });
    const input = await openPayment();
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue('1.234,50');
    fireEvent.click(screen.getByRole('button', { name: labels.recordPayment, exact: true }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('pos/supplier-invoices/payment-invoice/payments', expect.objectContaining({ amount: 1234.5 })));
  });

  it('blocks duplicate submission and dismissal, then retains a rejected draft', async () => {
    let rejectPayment!: (error: Error) => void;
    mocks.post.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPayment = reject; }));
    const input = await openPayment();
    fireEvent.change(input, { target: { value: '12,50' } });
    const submit = screen.getByRole('button', { name: labels.recordPayment, exact: true });
    fireEvent.click(submit); fireEvent.click(submit);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: (en as any).common.close, exact: true }));
    expect(input).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => { rejectPayment(new Error('Offline')); });
    expect(input).toHaveValue('12,50');
    expect(submit).toBeEnabled();
  });
});

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
    ['123450', 1234.5],
    ['1.234,50', 1234.5],
    ['1,234.50', 1234.5],
  ])('sends %j as %s and only then says it was saved', async (typed, amount) => {
    await openCorrection();
    typeAmount(typed);
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { amount }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith(review.saved));
  });

  // Letters never reach the field (digit entry refuses them); a typed zero does.
  it.each(['0', '000'])('refuses %j in words, sends nothing and keeps the form open', async typed => {
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
    typeAmount('3000');
    save();

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { amount: 30 }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(review.amountHasPayments));
    expect(review.amountHasPayments).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalledWith(review.saved);
    expect(screen.getByText(review.amountHasPayments)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 409/)).toBeNull();
  });
});
