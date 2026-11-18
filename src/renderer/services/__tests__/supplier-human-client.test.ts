import { describe, expect, it, vi } from 'vitest';
import { supplierCommandHeaders, supplierHumanCommand, supplierHumanRecorded, supplierSessionRequired } from '../supplier-human-client';
import { supplierImportFileKind } from '../../utils/supplier-import-parser';
import { posApiFetch } from '../../utils/api-helpers';

vi.mock('../../utils/api-helpers', () => ({ posApiFetch: vi.fn() }));

describe('supplier human command boundary', () => {
  it('passes the real staff selector and stable retry key without exposing a hosted session', async () => {
    vi.mocked(posApiFetch).mockResolvedValue({ success: false, code: 'INVOICE_HUMAN_ACTOR_REQUIRED' });
    const draft = { humanImportTicket: 'opaque-server-ticket', rows: [{ source: 'manual', barcode: '123' }] };
    for (let attempt = 0; attempt < 2; attempt++) await supplierHumanCommand('pos/suppliers/import/commit', { draft }, 'staff-id', 'same-key');
    expect(posApiFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(posApiFetch).mock.calls[0]).toEqual(vi.mocked(posApiFetch).mock.calls[1]);
    expect(posApiFetch).toHaveBeenCalledWith('pos/suppliers/import/commit', {
      method: 'POST', body: JSON.stringify({ draft }), headers: { 'x-supplier-staff-id': 'staff-id', 'idempotency-key': 'same-key' },
    });
    expect(supplierCommandHeaders(null, 'same-key')).toEqual({ 'idempotency-key': 'same-key' });
  });

  it.each(['INVOICE_HUMAN_ACTOR_REQUIRED', 'SUPPLIER_STAFF_SESSION_REQUIRED', 'INVOICE_REVIEWER_REQUIRED'])
  ('asks for check-in on %s', code => expect(supplierSessionRequired(new Error(code))).toBe(true));

  it('accepts the old recorded inventory response and rejects waiting or unsuccessful envelopes', () => {
    const result = { createdInventoryCount: 1, updatedInventoryCount: 0 };
    expect(supplierHumanRecorded({ success: true, result })).toBe(true);
    expect(supplierHumanRecorded({ success: true, result, admission: { status: 'waiting' } })).toBe(false);
    expect(supplierHumanRecorded({ success: false, result })).toBe(false);
    expect(supplierHumanRecorded({ success: true })).toBe(false);
  });
});

describe('drawer file provenance', () => {
  it.each(['invoice.pdf', 'invoice.doc', 'invoice.docx', 'photo.jpg', 'photo.png', 'photo.webp'])
  ('keeps %s in document capture', name => expect(supplierImportFileKind({ name, type: '' })).toBe('document'));

  it.each(['items.csv', 'items.tsv', 'items.txt', 'items.xls', 'items.xlsx'])
  ('classifies %s as unavailable till spreadsheet import', name => expect(supplierImportFileKind({ name, type: '' })).toBe('spreadsheet'));

  it('never treats an image or PDF mime disguised as CSV as human rows', () => {
    expect(supplierImportFileKind({ name: 'fake.csv', type: 'application/pdf' })).toBe('document');
    expect(supplierImportFileKind({ name: 'fake.csv', type: 'image/png' })).toBe('document');
  });
});
