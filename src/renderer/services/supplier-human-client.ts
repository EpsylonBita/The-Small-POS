import { posApiFetch, type PosApiResult } from '../utils/api-helpers';

/** This is a staff selector, never a session credential. Native resolves the hosted session. */
export function supplierCommandHeaders(staffId: string | null, actionKey: string): Record<string, string> {
  return { ...(staffId ? { 'x-supplier-staff-id': staffId } : {}), 'idempotency-key': actionKey };
}

export async function supplierHumanCommand<T>(
  endpoint: string, body: unknown, staffId: string | null, actionKey: string,
): Promise<PosApiResult<T>> {
  return posApiFetch<T>(endpoint, {
    method: 'POST', headers: supplierCommandHeaders(staffId, actionKey), body: JSON.stringify(body),
  });
}

export function supplierSessionRequired(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return /INVOICE_HUMAN_ACTOR_REQUIRED|SUPPLIER_STAFF_SESSION_REQUIRED|INVOICE_REVIEWER_REQUIRED/.test(message);
}

export interface SupplierHumanResult {
  supplierInvoiceId?: string | null;
  createdInventoryCount?: number;
  updatedInventoryCount?: number;
  warnings?: string[];
  stockLines?: Array<{ inventory_item_id: string; movement_id: string; line_index: number;
    requested_quantity?: number | string; applied_quantity?: number | string; itemName?: string }>;
}

/** A new admission envelope always takes priority over any legacy result. */
export function supplierHumanRecorded(body: { success?: boolean; admission?: unknown; result?: SupplierHumanResult } | undefined): boolean {
  if (!body || body.success !== true || 'admission' in body || !body.result) return false;
  // Legacy import responses can represent inventory-only entry, with no invoice.
  return typeof body.result.createdInventoryCount === 'number'
    && typeof body.result.updatedInventoryCount === 'number';
}
