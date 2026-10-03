import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), error: vi.fn() }));
vi.mock('react-i18next', async () => ({
  useTranslation: (await import('../../test/en-translate')).useTranslationEn,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../contexts/module-context', () => ({ useModules: () => ({ isModuleEnabled: () => true }) }));
vi.mock('../../contexts/shift-context', () => ({ useShift: () => ({ staff: { databaseStaffId: 'staff-1' } }) }));
vi.mock('../../contexts/barcode-scanner-context', () => ({ useOnBarcodeScan: () => undefined }));
vi.mock('../../components/procurement/PurchaseOrdersTab', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CaptureScanSettingsModal', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CapturePagesPanel', () => ({ default: () => null }));
vi.mock('../../components/suppliers/CaptureQueuePanel', () => ({
  default: ({ onCorrect }: { onCorrect: (invoice: unknown) => void }) => <>
    {['A', 'B'].map(id => <button key={id} onClick={() => onCorrect({
      invoiceId: id, invoiceNumber: 'original', invoiceDate: '2026-01-01',
      amount: 11, supplierName: 'Supplier', kind: 'goods', outcome: 'recorded',
    })}>Correct {id}</button>)}
  </>,
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

import SuppliersPage from '../SuppliersPage';

const current = (invoiceNumber = 'corrected') => ({
  success: true, data: { success: true, invoice: {
    invoice_number: invoiceNumber, invoice_date: '2026-01-02', due_date: '2026-02-01',
    amount: 25, notes: 'Current note',
  } },
});
let load: (id: string) => Promise<ReturnType<typeof current>>;

beforeEach(() => {
  load = async () => current();
  mocks.get.mockImplementation(async (path: string) => {
    if (path.startsWith('pos/supplier-invoices/')) return load(path.split('/').pop()!);
    return { success: true, data: { suppliers: [], invoices: [], currency: 'EUR' } };
  });
  mocks.patch.mockResolvedValue({ success: true, data: { success: true } });
});
afterEach(cleanup);

async function open(id = 'A') {
  fireEvent.click(await screen.findByTestId('capture-queue-open'));
  fireEvent.click(await screen.findByText(`Correct ${id}`));
}
const changeNumber = (value: string) => fireEvent.change(screen.getByPlaceholderText('Invoice number'), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));

describe('recorded invoice corrections', () => {
  it('loads the current amount and sends only the changed number, then permits restoring the original number', async () => {
    render(<SuppliersPage />);
    await open();
    await screen.findByDisplayValue('25');
    changeNumber('second');
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { invoiceNumber: 'second' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Invoice number')).not.toBeInTheDocument());
    load = async () => current('second');
    await open();
    await screen.findByDisplayValue('second');
    changeNumber('original');
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenLastCalledWith('pos/supplier-invoices/A', { invoiceNumber: 'original' }));
  });

  it('can clear a previously corrected note without changing other fields', async () => {
    render(<SuppliersPage />);
    await open();
    fireEvent.change(await screen.findByDisplayValue('Current note'), { target: { value: '' } });
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/A', { notes: '' }));
  });

  it('ignores an older response after closing A and opening B', async () => {
    let finishA!: (value: ReturnType<typeof current>) => void;
    load = id => id === 'A' ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve(current('B-current'));
    render(<SuppliersPage />);
    await open('A');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close', exact: true })[0]);
    await open('B');
    await screen.findByDisplayValue('B-current');
    await act(async () => { finishA(current('A-stale')); });
    expect(screen.getByDisplayValue('B-current')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A-stale')).not.toBeInTheDocument();
    changeNumber('B-new');
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('pos/supplier-invoices/B', { invoiceNumber: 'B-new' }));
  });

  it('shows fetch failure and disables saving instead of submitting the capture snapshot', async () => {
    load = async () => { throw new Error('Invoice unavailable'); };
    render(<SuppliersPage />);
    await open();
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByText(mocks.error.mock.calls.at(-1)![0])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(screen.getByPlaceholderText('Invoice number')).toHaveValue('');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('keeps the new form open when a previous correction finishes saving', async () => {
    let finishSave!: (value: unknown) => void;
    mocks.patch.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    render(<SuppliersPage />);
    await open('A');
    await screen.findByDisplayValue('corrected');
    changeNumber('A-updated');
    save();
    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Close', exact: true })[0]);
    load = async () => current('B-current');
    await open('B');
    await screen.findByDisplayValue('B-current');
    await act(async () => { finishSave({ success: true, data: { success: true } }); });
    expect(screen.getByDisplayValue('B-current')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).not.toBeDisabled();
  });
});
