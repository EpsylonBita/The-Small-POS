import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), file: vi.fn(), error: vi.fn(), success: vi.fn() }));
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
vi.mock('../../components/suppliers/CaptureQueuePanel', () => ({ default: () => null }));
vi.mock('../../../lib', () => ({
  getBridge: () => ({ invoke: vi.fn(), terminalConfig: { getSetting: vi.fn() } }), onEvent: vi.fn(), offEvent: vi.fn(),
}));
vi.mock('../../utils/api-helpers', () => ({
  posApiGet: (...args: unknown[]) => mocks.get(...args), posApiFetch: (...args: unknown[]) => mocks.fetch(...args),
  posApiPatch: vi.fn(), posApiPost: vi.fn(),
}));
vi.mock('../../services/offline-mutations', () => ({ offlineCommitSupplierImport: vi.fn() }));
vi.mock('../../services/capture-client', async (original) => ({
  ...await original<typeof import('../../services/capture-client')>(),
  loadCaptureSources: vi.fn(async () => []), loadDefaultCaptureSourceId: vi.fn(async () => null),
  listCaptureDocuments: vi.fn(async () => []), importCaptureFile: mocks.file,
}));
vi.mock('../../services/purchase-order-snapshot', () => ({ loadPurchaseOrderSnapshot: vi.fn(async () => []) }));

import SuppliersPage from '../SuppliersPage';
const previewDraft = (ticket?: string) => ({
  organizationId: 'org', branchId: 'branch', supplier: { id: 'supplier', name: 'Farm', action: 'existing' },
  invoice: { invoiceNumber: 'INV-1', amount: 12, status: 'unpaid' }, missingCategories: [],
  rows: [{ name: 'Item 123', barcode: '123', quantity: 1, unit: 'pcs', cost: 12, source: 'manual', rowNumber: 1,
    status: 'update', existingInventoryItemId: 'item', categoryPath: [], warnings: [], errors: [] }],
  ...(ticket ? { humanImportTicket: ticket } : {}),
});
const recorded = { createdInventoryCount: 0, updatedInventoryCount: 1, supplierInvoiceId: 'invoice',
  warnings: ['negative_balance'], stockLines: [{ line_index: 0, inventory_item_id: 'item', movement_id: 'movement', applied_quantity: '-2' }] };
beforeEach(() => {
  mocks.get.mockResolvedValue({ success: true, data: { suppliers: [], invoices: [], currency: 'EUR' } });
  mocks.fetch.mockImplementation(async (path: string) => path.endsWith('/preview')
    ? { success: true, data: { success: true, draft: previewDraft('ticket-once') } }
    : { success: true, data: { success: true, result: recorded } });
  mocks.file.mockResolvedValue('capture-file');
});
afterEach(cleanup);

async function enter() {
  render(<SuppliersPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Import items' }));
  fireEvent.change(screen.getByPlaceholderText('Fresh Farms'), { target: { value: 'Farm' } });
  const barcodes = screen.getAllByPlaceholderText('Barcode', { exact: true });
  fireEvent.change(barcodes[barcodes.length - 1], { target: { value: '123' } });
}
async function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview', exact: true }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save to inventory' })[0]).toBeEnabled());
}
const save = () => fireEvent.click(screen.getAllByRole('button', { name: 'Save to inventory' })[0]);
const commits = () => mocks.fetch.mock.calls.filter(([path]) => String(path).endsWith('/commit'));

describe('desktop human supplier entry', () => {
  it('gets manual provenance for barcode rows and reuses the exact ticket and key after an ambiguous refusal', async () => {
    mocks.fetch.mockImplementation(async (path: string) => path.endsWith('/preview')
      ? { success: true, data: { success: true, draft: previewDraft('server-action-ticket') } }
      : { success: false, error: 'Offline' });
    await enter(); await preview();
    const previewCall = mocks.fetch.mock.calls[0];
    expect(JSON.parse(previewCall[1].body).rows[0]).toMatchObject({ barcode: '123', source: 'manual' });
    save(); await waitFor(() => expect(commits()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save to inventory' })[0]).toBeEnabled());
    save(); await waitFor(() => expect(commits()).toHaveLength(2));
    expect(commits()[0][1]).toEqual(commits()[1][1]);
    expect(JSON.parse(commits()[1][1].body).draft.humanImportTicket).toBe('server-action-ticket');
    expect(commits()[1][1].headers['x-supplier-staff-id']).toBe('staff-1');
    expect(mocks.success).not.toHaveBeenCalledWith('Supplier items saved to inventory');
    expect(screen.getByDisplayValue('Farm')).toBeInTheDocument();
  });

  it('keeps authored input on an expired server session and does not retry automatically', async () => {
    await enter(); await preview();
    mocks.fetch.mockResolvedValue({ success: false, code: 'INVOICE_HUMAN_ACTOR_REQUIRED', error: 'Refused', status: 403 });
    save();
    await screen.findByText('Connect to the office and check in again. Your input is kept.');
    expect(screen.getByDisplayValue('Farm')).toBeInTheDocument();
    expect(commits()).toHaveLength(1);
  });

  it.each([undefined, 'new-ticket'])('shows server stock receipts and negative-stock warnings for ticket %s', async (ticket) => {
    mocks.fetch.mockImplementation(async (path: string) => path.endsWith('/preview')
      ? { success: true, data: { success: true, draft: previewDraft(ticket) } }
      : { success: true, data: { success: true, result: recorded } });
    await enter(); await preview(); save();
    const result = await screen.findByTestId('supplier-import-result');
    expect(result).toHaveTextContent('Stock is negative after this entry. Check the stock balance.');
    expect(result).toHaveTextContent('Row 1: stock recorded for Item 123');
    expect(result).toHaveTextContent('Quantity applied: -2');
    expect(result).toHaveTextContent('movement');
    expect(JSON.parse(commits()[0][1].body).draft.humanImportTicket).toBe(ticket);
  });

  it.each(['invoice.pdf', 'invoice.docx', 'invoice.png'])('sends %s to retained capture and preserves typed input', async (name) => {
    await enter();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
    fireEvent.change(input, { target: { files: [new File(['document'], name)] } });
    await waitFor(() => expect(mocks.file).toHaveBeenCalledWith(expect.objectContaining({ name }), 'staff-1'));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Farm')).toBeInTheDocument();
  });

  it.each(['items.csv', 'items.xlsx'])('does not parse %s or invent a till spreadsheet route', async (name) => {
    await enter();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
    fireEvent.change(input, { target: { files: [new File(['item,1,2'], name)] } });
    await screen.findByText('Spreadsheet import is not available on this till yet. Your typed rows are kept.');
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Farm')).toBeInTheDocument();
  });
});
