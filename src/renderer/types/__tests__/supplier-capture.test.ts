import { describe, expect, it } from 'vitest'
import { resolvePosErrorAnswer } from '../../../../../shared/contracts/pos-error-codes'
import {
  supplierInvoiceStaffSessionHeader, supplierInvoiceActionKeyHeader,
  supplierHumanImportRoutes, supplierHumanImportKinds, supplierInvoiceRefusalCodes,
  supplierInvoiceJobStates, isSupplierInvoiceJobTerminal, shouldPollSupplierInvoiceAdmission,
  type SupplierCaptureAdmissionOutcome, type SupplierCaptureJobPollResponse,
  type SupplierInvoicePoCommandRequest, type SupplierInvoiceHumanCommandHeaders,
  type SupplierHumanImportPreviewRequest, type SupplierHumanImportFileResponse,
} from '../supplier-capture'

describe('desktop supplier capture shared barrel', () => {
  it('exports staff proof, ticket routes and all human refusal codes', () => {
    const headers: SupplierInvoiceHumanCommandHeaders = { 'x-staff-session-id': 'session', 'idempotency-key': 'action' }
    expect(headers[supplierInvoiceStaffSessionHeader]).toBe('session')
    expect(headers[supplierInvoiceActionKeyHeader]).toBe('action')
    expect(supplierHumanImportRoutes.tillPreview).toBe('/api/pos/suppliers/import/preview')
    expect(supplierHumanImportKinds).toEqual(['typed', 'barcode', 'spreadsheet'])
    expect(supplierInvoiceRefusalCodes).toEqual(expect.arrayContaining([
      'INVOICE_HUMAN_ACTOR_REQUIRED', 'INVOICE_DOCUMENT_PROVENANCE_REQUIRED', 'INVOICE_STORE_DENIED',
      'INVOICE_ADMISSION_REQUIRED', 'INVOICE_STATEMENT_ADMISSION_REQUIRED', 'INVOICE_HUMAN_IDEMPOTENCY_CONFLICT',
      'MANUAL_INVOICE_IDEMPOTENCY_CONFLICT', 'NOT_AVAILABLE_YET', 'PO_RECEIPT_LINES_REQUIRED',
    ]))
  })

  it('carries typed and spreadsheet provenance without inventing ticket claims on the response', () => {
    const typed: SupplierHumanImportPreviewRequest = { supplier: { id: 'supplier' }, rows: [{ source: 'manual', barcode: '123' }] }
    const file: SupplierHumanImportFileResponse = { success: true, rows: [{ source: 'file', name: 'Apples' }], humanImportTicket: 'opaque' }
    expect(typed.rows[0].source).toBe('manual')
    expect(file.humanImportTicket).toBe('opaque')
    expect(file).not.toHaveProperty('actionId')
  })

  it('stops excluded job polling and keeps its retained reason and subtype', () => {
    const admission: SupplierCaptureAdmissionOutcome = { status: 'excluded', jobId: 'job', reason: 'Not an invoice', captureSubtype: 'scanner' }
    const poll: SupplierCaptureJobPollResponse = { success: true, jobId: 'job', admission }
    expect(poll.admission).toEqual(admission)
    expect(shouldPollSupplierInvoiceAdmission(admission)).toBe(false)
    expect(isSupplierInvoiceJobTerminal('excluded')).toBe(true)
    expect(supplierInvoiceJobStates).toContain('excluded')
    expect(shouldPollSupplierInvoiceAdmission({ status: 'waiting', jobId: 'job', reason: 'queued' })).toBe(true)
  })

  it('keeps older outcomes valid and delivery lines distinct from link-only commands', () => {
    const old: SupplierCaptureAdmissionOutcome = { status: 'recorded', jobId: 'job', invoiceId: 'invoice', undoId: 'undo', stock: 'none', balanceConfirmed: true }
    expect(old).not.toHaveProperty('captureSubtype')
    const delivery: SupplierInvoicePoCommandRequest = { poLinkage: { purchaseOrderId: 'po', mode: 'record_delivery' }, receiptLines: [
      { purchase_order_item_id: 'item', quantity_received: '2', unit_cost: '0.123456', confirm_over_receipt: false, confirm_unplanned: false },
      { inventory_item_id: 'inventory', quantity_received: '1', confirm_unplanned: true },
    ] }
    const link: SupplierInvoicePoCommandRequest = { poLinkage: { purchaseOrderId: 'po', mode: 'confirm_existing' } }
    expect(delivery.receiptLines).toHaveLength(2)
    expect(link).not.toHaveProperty('receiptLines')
  })
})


it('treats an undone invoice delivery key as a refusal rather than a successful replay', () => {
  expect(supplierInvoiceRefusalCodes).toContain('PO_DELIVERY_UNDONE')
  expect(resolvePosErrorAnswer({ code: 'PO_DELIVERY_UNDONE' }, 409)).toMatchObject({
    code: 'PO_DELIVERY_UNDONE', disposition: 'reject', uncatalogued: false,
  })
})
