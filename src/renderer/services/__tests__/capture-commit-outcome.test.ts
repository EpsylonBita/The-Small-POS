import { describe, expect, it, vi } from 'vitest';
import { captureCommitDecision, capturePageManifest, type CapturePageRow } from '../capture-client';

vi.mock('../../../lib', () => ({ getBridge: vi.fn() }));

const jobId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const undoId = '33333333-3333-4333-8333-333333333333';
const recorded = { status: 'recorded', jobId, invoiceId, undoId, stock: 'none', balanceConfirmed: true };

describe('capture commit proof', () => {
  it('accepts the recorded shared contract without a legacy result envelope', () => {
    expect(captureCommitDecision({ success: true, admission: recorded }))
      .toEqual({ kind: 'recorded', result: recorded });
  });

  it.each([
    { status: 'waiting', jobId, reason: 'queued' },
    { status: 'needs_review', jobId, reasons: [] },
    { status: 'failed', jobId, reasons: [] },
    { status: 'excluded', jobId, reason: 'not_invoice' },
  ])('never treats $status as recorded even with an old result alongside', (admission) => {
    expect(captureCommitDecision({ success: true, admission, result: { supplierInvoiceId: invoiceId } }))
      .toEqual({ kind: admission.status, jobId });
  });

  it.each([null, {}, { ...recorded, invoiceId: '' }, { ...recorded, undoId: null },
    { ...recorded, stock: 'unknown' }, { ...recorded, balanceConfirmed: 'true' }])
  ('refuses an invalid admission without falling back to a legacy invoice', (admission) => {
    expect(captureCommitDecision({ success: true, admission, result: { supplierInvoiceId: invoiceId } }))
      .toEqual({ kind: 'invalid' });
  });

  it('unwraps legacy invoice results and preserves attachment evidence', () => {
    const result = { supplierInvoiceId: invoiceId, attachmentPending: true };
    expect(captureCommitDecision({ success: true, result })).toEqual({ kind: 'recorded', result });
  });

  it.each([{}, { success: false, admission: recorded },
    { success: true, result: { createdInventoryCount: 1 } },
    { success: true, result: { supplierInvoiceId: 'not-an-invoice-id' } }])
  ('refuses envelopes that do not prove an invoice exists', (body) => {
    expect(captureCommitDecision(body)).toEqual({ kind: 'invalid' });
  });
});

describe('capture manifest on Save', () => {
  const page = (pageIndex: number, hash: string): CapturePageRow => ({
    pageIndex, contentHash: hash.repeat(64), filePath: `page-${hash}.jpg`, byteSize: 100, mime: 'image/jpeg',
  });

  it('uses stored receipt hashes in logical order after edits', () => {
    expect(capturePageManifest([page(0, 'b'), page(1, 'a')])).toEqual([
      { index: 0, sha256: 'b'.repeat(64) }, { index: 1, sha256: 'a'.repeat(64) },
    ]);
  });

  it.each([[], [page(1, 'a')], [page(0, 'x')], Array.from({ length: 11 }, (_, i) => page(i, 'a'))].map((pages) => ({ pages })))
  ('refuses empty, gapped, corrupt or oversized manifests', ({ pages }) => {
    expect(() => capturePageManifest(pages)).toThrow('Incomplete capture page manifest');
  });
});
