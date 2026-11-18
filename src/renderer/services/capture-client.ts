/**
 * Renderer-side door to the invoice capture store and its sources.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — design surface
 * **D-UI**. Requirements R1.4, R2.1-R2.6, R3.1, R5.1, R5.2, R8.6, R10.5,
 * R11.4, R11.5, R13.4, R14.4.
 *
 * Two things live here and nowhere else:
 *
 * 1. **The IPC surface.** Thin, typed wrappers over the `capture_*` Tauri
 *    commands. Every capture screen calls these instead of `invoke`, so the
 *    payload shapes are stated once and the components stay declarative.
 * 2. **Source configuration.** Capture sources are per-terminal by
 *    construction (R14.4): they live in `local_settings` category `capture`
 *    under `capture.sources` / `capture.default_source`. That is the exact
 *    category and key `capture::watcher::load_watched_folder_sources` reads,
 *    so saving a watched folder here is what starts the folder being watched.
 *    Nothing here is sensitive — device names and folder paths only — so the
 *    keyring is deliberately not involved.
 */

import { getBridge } from '../../lib';
import type {
  CaptureSourceConfig,
  CaptureSourceKind,
  CaptureStatus,
} from '../types/supplier-capture';

import type { SupplierCaptureAdmissionOutcome, SupplierCapturePageManifestEntry } from '../../../../shared/types/supplier-capture';

export type CaptureCommitDecision =
  | { kind: 'recorded'; result: Record<string, unknown> }
  | { kind: 'waiting' | 'needs_review' | 'failed' | 'excluded'; jobId: string }
  | { kind: 'invalid' };

/** A success envelope alone never proves that the invoice was recorded. */
export function captureCommitDecision(value: unknown): CaptureCommitDecision {
  if (!value || typeof value !== 'object') return { kind: 'invalid' };
  const body = value as Record<string, unknown>;
  if (body.success !== true) return { kind: 'invalid' };
  const uuid = (v: unknown): v is string => typeof v === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if ('admission' in body) {
    if (!body.admission || typeof body.admission !== 'object') return { kind: 'invalid' };
    const admission = body.admission as Record<string, unknown>;
    if (!uuid(admission.jobId)) return { kind: 'invalid' };
    if (admission.status === 'recorded' && uuid(admission.invoiceId) && uuid(admission.undoId)
      && ['applied', 'pending_mapping', 'none'].includes(String(admission.stock))
      && typeof admission.balanceConfirmed === 'boolean') {
      const recorded = admission as unknown as Extract<SupplierCaptureAdmissionOutcome, { status: 'recorded' }>;
      return { kind: 'recorded', result: { ...recorded } };
    }
    if (admission.status === 'waiting' && ['daily_cap', 'module_required', 'queued'].includes(String(admission.reason))) {
      return { kind: 'waiting', jobId: admission.jobId };
    }
    if (admission.status === 'excluded' && typeof admission.reason === 'string') {
      return { kind: 'excluded', jobId: admission.jobId };
    }
    if ((admission.status === 'needs_review' || admission.status === 'failed') && Array.isArray(admission.reasons)) {
      return { kind: admission.status, jobId: admission.jobId };
    }
    // Never fall back to an old result block when admission refused recording.
    return { kind: 'invalid' };
  }
  const legacy = body.result;
  if (legacy && typeof legacy === 'object'
    && uuid((legacy as Record<string, unknown>).supplierInvoiceId)) {
    return { kind: 'recorded', result: legacy as Record<string, unknown> };
  }
  return { kind: 'invalid' };
}

/** Receipt hashes travel in logical order, including legacy captures on Save. */
export function capturePageManifest(pages: CapturePageRow[]): SupplierCapturePageManifestEntry[] {
  if (!pages.length || pages.length > MAX_CAPTURE_PAGES) throw new Error('Incomplete capture page manifest');
  return pages.map((page, index) => {
    if (page.pageIndex !== index || !/^[a-f0-9]{64}$/.test(page.contentHash)) throw new Error('Incomplete capture page manifest');
    return { index, sha256: page.contentHash };
  });
}

/** Desktop-only source profile, persisted in the existing settings JSON. */
export type DesktopCaptureSourceConfig = CaptureSourceConfig & { feedMode?: 'flatbed' | 'feeder' };

/** `local_settings` category the watched-folder engine reads its sources from. */
export const CAPTURE_SETTINGS_CATEGORY = 'capture';
export const CAPTURE_SOURCES_KEY = 'capture.sources';
export const CAPTURE_DEFAULT_SOURCE_KEY = 'capture.default_source';

/**
 * Pages one captured document holds. Mirrors `MAX_CAPTURE_PAGES` in
 * `capture/mod.rs` and `MAX_OCR_PAGES` on the server — the user is told at
 * capture time rather than after an upload round trip (R12.3).
 */
export const MAX_CAPTURE_PAGES = 10;

/** One page of an in-flight or queued captured document. */
export interface CapturePageRow {
  pageIndex: number;
  filePath: string;
  contentHash: string;
  byteSize: number;
  mime: string;
}

/** One local history entry (R13.4). */
export interface CaptureEventRow {
  id: string;
  captureId: string | null;
  eventType: string;
  staffId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** One watched-folder ingest decision — including the visible skips (R3.4). */
export interface CaptureIngestRow {
  contentHash: string;
  sourcePath: string | null;
  captureId: string | null;
  outcome: 'ingested' | 'skipped_duplicate' | 'skipped_unsupported' | 'skipped_oversize';
  seenAt: string;
}

/** A captured document as the queue and page views read it. */
export interface CaptureDocumentRow {
  captureId: string;
  status: CaptureStatus;
  sourceKind: string;
  sourceName: string | null;
  deviceId?: string | null;
  sourceId?: string | null;
  acquiring?: boolean;
  needsRender?: boolean;
  renderRetryAt?: string | null;
  scanDetail?: string | null;
  staffId: string | null;
  capturedAt: string;
  pageCount: number;
  /** Parsed `SupplierImportOcrResponse`, or null while recognition is pending. */
  recognition: Record<string, unknown> | null;
  /** Parsed review edits, or null when the user has not touched review yet. */
  draft: Record<string, unknown> | null;
  storageKeys: Array<string | null>;
  /** Stable outcome/reason code; screens map it to one plain sentence. */
  reasonCode: string | null;
  attempts: number;
  updatedAt: string;
  pages: CapturePageRow[];
}

interface CommandEnvelope {
  success?: boolean;
  code?: string;
  [key: string]: unknown;
}

/**
 * Every capture command answers with the same `{ success, ... }` envelope, so
 * the return type is the caller's payload shape intersected with it. A command
 * that answered with nothing becomes `{}` rather than throwing — the callers
 * below all read `success` first, and an absent envelope is simply a failure.
 */
async function call<T = Record<string, never>>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<CommandEnvelope & T> {
  const bridge = getBridge();
  const result = payload === undefined
    ? await bridge.invoke(command)
    : await bridge.invoke(command, payload);
  return (result ?? {}) as CommandEnvelope & T;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** Every not-yet-finished document on this terminal, oldest capture first. */
export async function listCaptureDocuments(): Promise<CaptureDocumentRow[]> {
  const result = await call<{ documents?: CaptureDocumentRow[] }>('capture_list_documents');
  return Array.isArray(result.documents) ? result.documents : [];
}

export interface CaptureDocumentDetail {
  document: CaptureDocumentRow | null;
  events: CaptureEventRow[];
}

export async function getCaptureDocument(captureId: string): Promise<CaptureDocumentDetail> {
  const result = await call<{ document?: CaptureDocumentRow; events?: CaptureEventRow[] }>(
    'capture_get_document',
    { captureId },
  );
  return {
    document: result.success && result.document ? result.document : null,
    events: Array.isArray(result.events) ? result.events : [],
  };
}

export interface CaptureHistory {
  events: CaptureEventRow[];
  ingest: CaptureIngestRow[];
}

export async function getCaptureHistory(limit?: number): Promise<CaptureHistory> {
  const result = await call<{ events?: CaptureEventRow[]; ingest?: CaptureIngestRow[] }>(
    'capture_history',
    limit === undefined ? {} : { limit },
  );
  return {
    events: Array.isArray(result.events) ? result.events : [],
    ingest: Array.isArray(result.ingest) ? result.ingest : [],
  };
}

/** Open a new document in `capturing`. The id is minted by Rust. */
export async function startCaptureDocument(input: {
  sourceKind: CaptureSourceKind;
  sourceName?: string | null;
  staffId?: string | null;
  sourceId?: string;
  deviceId?: string;
  feedMode?: 'flatbed' | 'feeder';
}): Promise<string> {
  const result = await call<{ captureId?: string }>('capture_start_document', {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    deviceId: input.deviceId,
    feedMode: input.feedMode,
    sourceName: input.sourceName ?? undefined,
    staffId: input.staffId ?? undefined,
  });
  if (!result.success || typeof result.captureId !== 'string') {
    throw new Error('Could not start a new scan');
  }
  return result.captureId;
}

/** Retain the original before starting the existing durable capture pipeline. */
export async function importCaptureFile(file: File, staffId: string | null): Promise<string> {
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('CAPTURE_TOO_LARGE');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const result = await call<{ captureId?: string }>('capture_start_document', {
    sourceKind: 'file_pick', sourceName: file.name, staffId: staffId ?? undefined,
    fileBase64: btoa(binary), fileName: file.name,
  });
  if (!result.success || !result.captureId) throw new Error(result.code ?? 'Document could not be retained');
  return result.captureId;
}

export function captureSubtype(document: CaptureDocumentRow): 'scanner' | 'camera' | 'file' | 'unknown' {
  const admission = document.recognition?.admission as { captureSubtype?: unknown } | undefined;
  const subtype = admission?.captureSubtype;
  if (subtype === 'scanner' || subtype === 'camera' || subtype === 'file') return subtype;
  // Local source identity is acquisition provenance, never inferred from a reading.
  if (document.sourceKind === 'connected_scanner' || document.sourceKind === 'usb_scanner') return 'scanner';
  if (document.sourceKind === 'file_pick') return 'file';
  if (document.sourceKind === 'camera') return 'camera';
  return 'unknown';
}

export interface AdvanceResult {
  success: boolean;
  /** `no_pages` when a document was finished with nothing on it. */
  code?: string;
  status?: CaptureStatus;
}

/**
 * Move a document to `status`. The state machine lives in Rust, so an
 * impossible move is refused there rather than trusted here.
 *
 * `waiting` wakes the capture worker immediately; `discarded` also deletes the
 * capture's local files, which is why the caller must confirm first (R10.5).
 */
export async function advanceCapture(input: {
  captureId: string;
  status: CaptureStatus;
  reason?: string | null;
  staffId?: string | null;
  admissionResponse?: Record<string, unknown>;
}): Promise<AdvanceResult> {
  const result = await call<{ status?: CaptureStatus }>('capture_advance', {
    captureId: input.captureId,
    status: input.status,
    reason: input.reason ?? undefined,
    staffId: input.staffId ?? undefined,
    ...(input.admissionResponse ? { admissionResponse: input.admissionResponse } : {}),
  });
  return {
    success: result.success === true,
    code: typeof result.code === 'string' ? result.code : undefined,
    status: result.status,
  };
}

/** Persist review edits so leaving (or restarting) loses nothing (R8.6). */
export async function saveCaptureDraft(
  captureId: string,
  draft: Record<string, unknown>,
): Promise<void> {
  await call('capture_save_draft', { captureId, draft });
}

/** Record the server's verbatim commit result and move to `committed`. */
export async function confirmCaptureCommit(input: {
  captureId: string;
  result: Record<string, unknown>;
  staffId?: string | null;
}): Promise<void> {
  await call('capture_confirm_commit', {
    captureId: input.captureId,
    result: input.result,
    staffId: input.staffId ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Pages (R5.2 — all available before the document is finished, none required)
// ---------------------------------------------------------------------------

export async function removeCapturePage(
  captureId: string,
  pageIndex: number,
): Promise<{ success: boolean; pageCount: number }> {
  const result = await call<{ pageCount?: number }>('capture_remove_page', {
    captureId,
    pageIndex,
  });
  if (!result.success) throw new Error(typeof result.code === 'string' ? result.code : 'Could not remove page');
  return { success: true, pageCount: typeof result.pageCount === 'number' ? result.pageCount : 0 };
}

/** `order` lists the current page indexes in the order the user wants them. */
export async function reorderCapturePages(
  captureId: string,
  order: number[],
): Promise<boolean> {
  const result = await call('capture_reorder_pages', { captureId, order });
  if (!result.success) throw new Error(typeof result.code === 'string' ? result.code : 'Could not reorder pages');
  return result.success === true;
}

/** A thumbnail `data:` URL for one stored page, or null when unreadable. */
export async function rotateCapturePage(captureId: string, pageIndex: number): Promise<void> {
  const result = await call('capture_reorder_pages', { captureId, rotatePageIndex: pageIndex });
  if (!result.success) throw new Error(typeof result.code === 'string' ? result.code : 'Page rotation failed');
}

export async function getCapturePagePreview(
  captureId: string,
  pageIndex: number,
): Promise<string | null> {
  const result = await call<{ dataUrl?: string }>('capture_page_preview', {
    captureId,
    pageIndex,
  });
  return result.success && typeof result.dataUrl === 'string' ? result.dataUrl : null;
}

/** A thumbnail of a connected scanner's test page, for visual confirmation (R2.2). */
export async function getCaptureTestPreview(path: string): Promise<string | null> {
  const result = await call<{ dataUrl?: string }>('capture_test_preview', { path });
  return result.success && typeof result.dataUrl === 'string' ? result.dataUrl : null;
}

// ---------------------------------------------------------------------------
// Connected scanner (WIA)
// ---------------------------------------------------------------------------

export interface ScannerDevice {
  deviceId: string;
  name: string;
}

/**
 * A scanner situation is a *result*, not a thrown error: the adapter answers
 * with a stable reason code the caller maps to one plain sentence (R12.1).
 */
export type ScannerOutcome<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: string;
      /**
       * What the driver actually said — "decode scanned page: The image format
       * Bmp is not supported", "the scanner produced no page", a Windows error
       * code. Live 06/09/2026 this was logged and thrown away, and the screen
       * blamed the cable for a scan that had physically happened. It is shown
       * under the plain sentence, never instead of it.
       */
      detail?: string;
      pages?: CapturePageRow[];
      stoppedEarly?: boolean;
    };

function toOutcome<T extends object>(
  result: CommandEnvelope,
  extract: (value: CommandEnvelope) => T,
): ScannerOutcome<T> {
  if (result.success === true) {
    return { ok: true, ...extract(result) };
  }
  const detail = typeof result.detail === 'string' ? result.detail.trim() : '';
  return {
    ok: false,
    code: typeof result.code === 'string' ? result.code : 'device_error',
    ...(detail ? { detail } : {}),
    ...(Array.isArray(result.pages) ? { pages: result.pages as CapturePageRow[], stoppedEarly: result.stoppedEarly === true } : {}),
  };
}

/** Scanners this terminal can see. An empty list is a success, not an error. */
export async function listScanners(): Promise<ScannerOutcome<{ devices: ScannerDevice[] }>> {
  const result = await call<{ devices?: ScannerDevice[] }>('capture_scanner_list');
  return toOutcome(result, (value) => ({
    devices: Array.isArray(value.devices) ? (value.devices as ScannerDevice[]) : [],
  }));
}

/** One silent test page, saved under `captures/_test/` (R2.2). */
export async function testScanner(
  deviceId: string,
  feedMode: 'flatbed' | 'feeder' = 'flatbed',
): Promise<ScannerOutcome<{ path: string }>> {
  const result = await call<{ path?: string }>('capture_scanner_test', { deviceId, feedMode });
  return toOutcome(result, (value) => ({
    path: typeof value.path === 'string' ? value.path : '',
  }));
}

export interface AcquiredPages {
  pages: CapturePageRow[];
  /** True when the device fed a stack rather than a single flatbed page. */
  feederUsed: boolean;
  /** True when the transfer stopped because the document hit the page cap. */
  reachedPageCap: boolean;
  /**
   * True when the run ended without the device ever saying it was finished —
   * it went busy mid-stack instead.
   *
   * The pages that came back are real and already on disk. What is not known is
   * whether the feeder still holds sheets, and a run that reports this must not
   * be presented as an ordinary, finished success: that is how somebody presses
   * Done over half an invoice.
   */
  stoppedEarly: boolean;
}

/**
 * Pull pages from a device into an existing document.
 *
 * Appends — the starting page index comes from the store, so an ADF stack and
 * a user pressing "Add another page" behave identically.
 */
export async function acquireFromScanner(input: {
  captureId: string;
  deviceId: string;
  replacePageIndex?: number;
}): Promise<ScannerOutcome<AcquiredPages>> {
  const result = await call<{
    pages?: CapturePageRow[];
    feederUsed?: boolean;
    reachedPageCap?: boolean;
    stoppedEarly?: boolean;
  }>('capture_scanner_acquire', input);
  return toOutcome(result, (value) => ({
    pages: Array.isArray(value.pages) ? (value.pages as CapturePageRow[]) : [],
    feederUsed: value.feederUsed === true,
    reachedPageCap: value.reachedPageCap === true,
    stoppedEarly: value.stoppedEarly === true,
  }));
}

// ---------------------------------------------------------------------------
// Source configuration (per-terminal, `local_settings` category `capture`)
// ---------------------------------------------------------------------------

function isSourceConfig(value: unknown): value is CaptureSourceConfig {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && typeof entry.kind === 'string';
}

/**
 * Tolerate both shapes the settings store can hand back: the Rust command
 * parses a stored JSON blob for us, but a value written by an older path (or a
 * hand-edited row) may still arrive as a raw string.
 */
function parseSourceList(raw: unknown): CaptureSourceConfig[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  // One malformed entry must not hide every other configured source — the
  // same warn-and-skip discipline the Rust loader uses.
  return value.filter(isSourceConfig);
}

export async function loadCaptureSources(): Promise<CaptureSourceConfig[]> {
  try {
    const raw = await getBridge().terminalConfig.getSetting({
      category: CAPTURE_SETTINGS_CATEGORY,
      key: CAPTURE_SOURCES_KEY,
    });
    return parseSourceList(raw);
  } catch {
    return [];
  }
}

export async function loadDefaultCaptureSourceId(): Promise<string | null> {
  try {
    const raw = await getBridge().terminalConfig.getSetting({
      category: CAPTURE_SETTINGS_CATEGORY,
      key: CAPTURE_DEFAULT_SOURCE_KEY,
    });
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Write the terminal's source list and its default in one settings update.
 *
 * The `isDefault` flag on each entry and the `capture.default_source` key are
 * kept consistent here rather than by callers, so "the default" has exactly one
 * answer no matter which screen last wrote the list.
 */
export async function saveCaptureSources(
  sources: CaptureSourceConfig[],
  defaultSourceId: string | null,
): Promise<void> {
  const resolvedDefault = sources.some((source) => source.id === defaultSourceId)
    ? defaultSourceId
    : (sources[0]?.id ?? null);

  const normalized = sources.map((source) => ({
    ...source,
    isDefault: source.id === resolvedDefault,
  }));

  await getBridge().settings.updateLocal({
    settingType: CAPTURE_SETTINGS_CATEGORY,
    settings: {
      [CAPTURE_SOURCES_KEY]: normalized,
      [CAPTURE_DEFAULT_SOURCE_KEY]: resolvedDefault ?? '',
    },
  });
}

/**
 * The source a scan starts from when the user just presses "Scan invoice".
 *
 * Falls back to the first configured source so a terminal with exactly one
 * scanner never asks the user to pick (R1.2 — no setup step in between).
 */
export function resolveDefaultSource(
  sources: CaptureSourceConfig[],
  defaultSourceId: string | null,
): DesktopCaptureSourceConfig | null {
  if (sources.length === 0) return null;
  return (
    sources.find((source) => source.id === defaultSourceId) ??
    sources.find((source) => source.isDefault) ??
    sources[0]
  );
}
