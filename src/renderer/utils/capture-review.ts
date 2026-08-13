/**
 * Mapping between the capture pipeline and the existing supplier import drawer.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**, decision **D10**. Requirements R6.3, R6.4, R7.1, R7.2, R7.6, R9.2,
 * R12.1, R15.3.
 *
 * Capture does not get its own review screen: a recognised invoice is poured
 * into the drawer the suppliers page already has, and then travels the normal
 * preview → commit path. This module is that pour, plus the vocabulary that
 * turns internal codes into keys the locale files answer.
 *
 * Two rules are enforced here rather than left to components:
 *
 * - **Every parsed row survives.** [`mapRecognitionToDraft`] returns as many
 *   rows as the server parsed — the client never drops or filters them
 *   (R6.4). A row with a blank name still comes through, because a row the
 *   user has to fix is strictly better than a row that silently vanished.
 * - **Confidence is never a number.** The only confidence a component can ask
 *   for is a [`ConfidenceTier`], and the only question it can ask about one is
 *   [`needsDoubleCheck`]. There is no accessor here that returns a score, so a
 *   numeral cannot reach a screen (R7.6).
 */

import type { ConfidenceTier } from '../types/supplier-capture';

/** i18n namespace every user-facing capture string resolves under. */
export const CAPTURE_I18N_PREFIX = 'suppliers.capture';

/**
 * A draft row, structurally identical to the import drawer's own row shape.
 * Declared here so the mapper has a return type without the drawer having to
 * export its internals.
 */
export interface CaptureDraftRow {
  name: string;
  nameEl?: string | null;
  sku?: string | null;
  barcode?: string | null;
  quantity: number;
  unit: string;
  cost: number;
  minStockLevel?: number;
  category?: string | null;
  subcategory?: string | null;
  notes?: string | null;
}

export interface CaptureDraftSupplier {
  name: string;
  email: string;
  phone: string;
  notes: string;
}

export interface CaptureDraftInvoice {
  invoiceNumber: string;
  invoiceDate: string;
}

export interface CaptureReviewPrefill {
  rows: CaptureDraftRow[];
  supplier: CaptureDraftSupplier;
  invoice: CaptureDraftInvoice;
  /** One tier per row, aligned index-for-index with `rows`. */
  rowConfidence: ConfidenceTier[];
  /** `poor` is the R7.2 trigger for the two equal choices. */
  quality: 'good' | 'poor';
  pageCount: number;
}

// ---------------------------------------------------------------------------
// Recognition → drawer
// ---------------------------------------------------------------------------

function readString(source: unknown, ...keys: string[]): string {
  if (!source || typeof source !== 'object') return '';
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNumber(source: unknown, key: string, fallback: number): number {
  if (!source || typeof source !== 'object') return fallback;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isTier(value: unknown): value is ConfidenceTier {
  return value === 'ok' || value === 'check' || value === 'low';
}

/**
 * Turn a stored `SupplierImportOcrResponse` into everything the drawer needs
 * to open prefilled.
 *
 * Anything the recogniser could not find comes back as an empty string rather
 * than a guess: a blank field the user fills in is honest, an invented one is
 * not. Tiers are padded to the row count so a component can index into them
 * without a bounds check.
 */
export function mapRecognitionToDraft(
  recognition: Record<string, unknown> | null | undefined,
): CaptureReviewPrefill {
  const empty: CaptureReviewPrefill = {
    rows: [],
    supplier: { name: '', email: '', phone: '', notes: '' },
    invoice: { invoiceNumber: '', invoiceDate: '' },
    rowConfidence: [],
    quality: 'poor',
    pageCount: 0,
  };
  if (!recognition || typeof recognition !== 'object') return empty;

  const parsed = recognition.parsed as Record<string, unknown> | undefined;
  const rawRows = Array.isArray(parsed?.rows) ? (parsed?.rows as unknown[]) : [];

  const rows: CaptureDraftRow[] = rawRows.map((raw) => ({
    name: readString(raw, 'name'),
    nameEl: readString(raw, 'nameEl') || null,
    sku: readString(raw, 'sku') || null,
    barcode: readString(raw, 'barcode') || null,
    quantity: Math.max(0, readNumber(raw, 'quantity', 1)),
    unit: readString(raw, 'unit') || 'pcs',
    cost: Math.max(0, readNumber(raw, 'cost', 0)),
    minStockLevel: Math.max(0, readNumber(raw, 'minStockLevel', 0)),
    category: readString(raw, 'category') || null,
    subcategory: readString(raw, 'subcategory') || null,
    notes: readString(raw, 'notes') || null,
  }));

  const rawTiers = Array.isArray(recognition.rowConfidence)
    ? (recognition.rowConfidence as unknown[])
    : [];
  const rowConfidence: ConfidenceTier[] = rows.map((_row, index) => {
    const tier = rawTiers[index];
    // An absent or unrecognised tier becomes `check`, not `ok`: the safe
    // default is asking the user to look, never quietly claiming confidence.
    return isTier(tier) ? tier : 'check';
  });

  const pages = Array.isArray(recognition.pages) ? recognition.pages.length : 0;

  return {
    rows,
    supplier: {
      name: readString(parsed?.supplier, 'name'),
      email: readString(parsed?.supplier, 'email'),
      phone: readString(parsed?.supplier, 'phone'),
      notes: readString(parsed?.supplier, 'notes'),
    },
    invoice: {
      invoiceNumber: readString(parsed?.invoice, 'invoiceNumber'),
      invoiceDate: readString(parsed?.invoice, 'invoiceDate'),
    },
    rowConfidence,
    quality: recognition.quality === 'poor' ? 'poor' : 'good',
    pageCount: pages,
  };
}

/**
 * Whether a row should carry the "double-check this" highlight (R7.1).
 *
 * This is the entire confidence API a component gets. There is deliberately no
 * `confidenceScore()` beside it.
 */
export function needsDoubleCheck(tier: ConfidenceTier | undefined): boolean {
  return tier === 'check' || tier === 'low';
}

/** How many rows the user is being asked to double-check. */
export function doubleCheckCount(tiers: ConfidenceTier[]): number {
  return tiers.filter(needsDoubleCheck).length;
}

// ---------------------------------------------------------------------------
// Plain-language vocabulary (R12.1, R15.3)
// ---------------------------------------------------------------------------

/**
 * Every capture lifecycle status, as the queue view enumerates them.
 * Each one owns a `suppliers.capture.status.<status>` key in all five locales.
 */
export const CAPTURE_STATUS_KEYS = [
  'capturing',
  'waiting',
  'uploading',
  'reading',
  'ready_review',
  'needs_attention',
  'parked',
  'committing',
  'committed',
  'discarded',
] as const;

/**
 * Reason codes a document can carry. Superset of the shared
 * `captureOutcomeCodes` — it also covers the local-only reasons the watcher
 * and the renderer's own PDF rasterization can set.
 */
export const CAPTURE_REASON_KEYS = [
  'MODULE_REQUIRED',
  'PO_INVOICE_ALREADY_APPLIED',
  'PO_STATE_CONFLICT',
  'CAPTURE_TOO_LARGE',
  'CAPTURE_TOO_MANY_PAGES',
  'CAPTURE_UNREADABLE',
  'COMMIT_IN_PROGRESS',
  'CAPTURE_ALREADY_COMMITTED',
  'render_failed',
  'commit_rejected',
] as const;

/**
 * Connected-scanner situations. Five, not four: the adapter's documented
 * catch-all `device_error` covers jams, open covers, and driver faults, and it
 * needs a sentence of its own or those all render a raw code.
 */
export const CAPTURE_DEVICE_KEYS = [
  'device_offline',
  'device_busy',
  'device_removed',
  'scan_cancelled',
  'device_error',
] as const;

/** Watched-folder ingest decisions the history section renders. */
export const CAPTURE_INGEST_KEYS = [
  'ingested',
  'skipped_duplicate',
  'skipped_unsupported',
  'skipped_oversize',
] as const;

/** Capture source kinds. The desktop shows the first two plus file pick. */
export const CAPTURE_SOURCE_KIND_KEYS = [
  'connected_scanner',
  'watched_folder',
  'camera',
  'usb_scanner',
  'file_pick',
] as const;

/** Live source status chips (R1.4). */
export const CAPTURE_SOURCE_STATUS_KEYS = ['ready', 'unavailable', 'watching'] as const;

/**
 * Every `capture_events.event_type` the Rust side writes, plus the `generic`
 * catch-all. These are the sentences the history section renders (R13.4), so
 * each one owns a `suppliers.capture.history.<type>` key in all five locales.
 *
 * Kept in step with the `record_event` call sites in `capture/store.rs`,
 * `capture/watcher.rs`, `capture/worker.rs`, and
 * `commands/capture_documents.rs`. An event type added there without a key
 * here renders the `generic` sentence rather than a raw identifier.
 */
export const CAPTURE_EVENT_KEYS = [
  'captured',
  'page_added',
  'page_removed',
  'pages_reordered',
  'pages_rendered',
  'status_changed',
  'discarded',
  'ingested',
  'ingest_skipped',
  'committed',
  'local_files_cleaned',
  'generic',
] as const;

const STATUS_SET: ReadonlySet<string> = new Set(CAPTURE_STATUS_KEYS);
const REASON_SET: ReadonlySet<string> = new Set(CAPTURE_REASON_KEYS);
const DEVICE_SET: ReadonlySet<string> = new Set(CAPTURE_DEVICE_KEYS);
const INGEST_SET: ReadonlySet<string> = new Set(CAPTURE_INGEST_KEYS);
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(CAPTURE_SOURCE_KIND_KEYS);
const EVENT_SET: ReadonlySet<string> = new Set(CAPTURE_EVENT_KEYS);

/**
 * Build a locale key for a runtime value, falling back to the family's own
 * catch-all when the value is one this build does not know.
 *
 * An unknown code must still produce a *sentence*: falling back to the raw
 * code would put `WIA_ERROR_0x80210015` in front of a user, which is exactly
 * what R12.1 forbids.
 */
function familyKey(
  family: string,
  value: string | null | undefined,
  known: ReadonlySet<string>,
  fallback: string,
): string {
  const candidate = (value ?? '').trim();
  const resolved = known.has(candidate) ? candidate : fallback;
  return `${CAPTURE_I18N_PREFIX}.${family}.${resolved}`;
}

export function statusKey(status: string | null | undefined): string {
  return familyKey('status', status, STATUS_SET, 'needs_attention');
}

export function reasonKey(code: string | null | undefined): string {
  return familyKey('reason', code, REASON_SET, 'unknown');
}

export function deviceKey(code: string | null | undefined): string {
  return familyKey('device', code, DEVICE_SET, 'device_error');
}

export function ingestKey(outcome: string | null | undefined): string {
  return familyKey('history', outcome, INGEST_SET, 'ingested');
}

/**
 * History sentence for one local event.
 *
 * Shares the `history` family with [`ingestKey`] on purpose: to a user reading
 * "recent activity" there is no difference between "this file was skipped as a
 * duplicate" and "these pages were reordered" — both are just things that
 * happened, in one list, in one voice.
 */
export function eventKey(eventType: string | null | undefined): string {
  return familyKey('history', eventType, EVENT_SET, 'generic');
}

export function sourceKindKey(kind: string | null | undefined): string {
  return familyKey('sourceKind', kind, SOURCE_KIND_SET, 'file_pick');
}

export function sourceStatusKey(status: 'ready' | 'unavailable' | 'watching'): string {
  return `${CAPTURE_I18N_PREFIX}.sourceStatus.${status}`;
}

/**
 * Statuses that mean the document still owes somebody something, and therefore
 * belong in the suppliers-header badge count (R11.5).
 *
 * `committing` is deliberately in: a queued offline commit is unfinished work
 * the user should still be able to see.
 */
const BADGE_STATUSES: ReadonlySet<string> = new Set([
  'capturing',
  'waiting',
  'uploading',
  'reading',
  'ready_review',
  'needs_attention',
  'parked',
  'committing',
]);

export function badgeCount(documents: Array<{ status: string }>): number {
  return documents.filter((document) => BADGE_STATUSES.has(document.status)).length;
}

// ---------------------------------------------------------------------------
// PO linkage (R9.2)
// ---------------------------------------------------------------------------

/** The subset of a purchase order this module needs. */
export interface LinkablePurchaseOrder {
  id: string;
  supplierName: string | null;
  orderReference: string;
  status: string;
  expectedDeliveryDate: string | null;
}

const RECEIVABLE_PO_STATUSES: ReadonlySet<string> = new Set([
  'ordered',
  'partially_received',
]);

function normalizeSupplierName(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Open purchase orders that plausibly match the recognised supplier.
 *
 * Matching is deliberately loose (case, spacing, and punctuation folded, then
 * a containment test either way) because the recognised name comes off a
 * scanned page: "ACME FOODS O.E." and "Acme Foods OE" are the same supplier.
 * Being loose is safe — the result is only ever an *offer* the user can
 * decline, and declining is the default (R9.2).
 */
export function suggestPurchaseOrders<T extends LinkablePurchaseOrder>(
  purchaseOrders: T[],
  supplierName: string,
): T[] {
  const needle = normalizeSupplierName(supplierName);
  if (!needle) return [];

  return purchaseOrders.filter((po) => {
    if (!RECEIVABLE_PO_STATUSES.has(po.status)) return false;
    const candidate = normalizeSupplierName(po.supplierName);
    if (!candidate) return false;
    return candidate.includes(needle) || needle.includes(candidate);
  });
}
