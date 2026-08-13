/**
 * Renderer-side PDF rasterization for watched-folder captures.
 *
 * Spec: `.claude/specs/invoice-scan-capture/design.md` — decision **D1**,
 * design surface **D-Rust3**. Requirements R5.3, R12.3, R12.4.
 *
 * The Rust side deliberately bundles no PDF renderer (pdfium was rejected for
 * binary size and packaging risk), so when the watched folder ingests a PDF the
 * worker keeps the original, emits `capture:needs-render`, and waits. This
 * module is the other half: it pulls the retained PDF back through
 * `capture_read_original`, rasterizes it with the `pdfjs-dist` the app already
 * ships, and returns pages through `capture_attach_rendered_pages`.
 *
 * Failure is never silence. A PDF that will not open, has no pages, or exceeds
 * the page cap comes back through the *same* command with a `failureReason`,
 * which parks the document as `needs_attention` with its original still on disk
 * and retry/manual-entry paths open (R12.4). The one thing that must never
 * happen is a document sitting in `capturing` forever because a render threw.
 */

import { getBridge } from '../../lib';
import { extractSupplierImportFile } from '../utils/supplier-import-parser';
import { MAX_CAPTURE_PAGES, saveCaptureDraft } from './capture-client';

/** Longest edge of a rasterized page, in pixels. */
const RENDER_MAX_EDGE = 2000;

/**
 * JPEG rather than PNG, at a quality that stays comfortably inside the 10 MB
 * per-page ceiling the store and the server both enforce. A 2000 px PNG of a
 * dense invoice routinely clears 8 MB; the same page as JPEG is well under one.
 */
const RENDER_MIME = 'image/jpeg';
const RENDER_QUALITY = 0.85;

export interface RenderedCapturePage {
  pageIndex: number;
  mime: string;
  /** Base64 image bytes, without the `data:` prefix. */
  data: string;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
  }
  return pdfjsLib;
}

/** Fetch a capture's retained original PDF, or null when it cannot be read. */
export async function readCaptureOriginal(captureId: string): Promise<Uint8Array | null> {
  const result = (await getBridge().invoke('capture_read_original', { captureId })) as
    | { success?: boolean; data?: string }
    | null;
  if (!result?.success || typeof result.data !== 'string') return null;
  return base64ToBytes(result.data);
}

/**
 * Rasterize a PDF into capture pages.
 *
 * Throws only for a PDF that cannot be opened at all; every other outcome is a
 * value the caller turns into a stated reason.
 */
export async function rasterizePdf(bytes: Uint8Array): Promise<RenderedCapturePage[]> {
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({
    // A fresh copy: pdf.js transfers ownership of the buffer it is handed, and
    // the caller still needs these bytes for the text-layer fast path.
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  } as never).promise;

  const pages: RenderedCapturePage[] = [];
  const pageCount = Math.min(pdf.numPages, MAX_CAPTURE_PAGES);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const longestEdge = Math.max(base.width, base.height) || 1;
    const scale = Math.min(RENDER_MAX_EDGE / longestEdge, 4);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is unavailable for PDF rendering');
    }

    await page.render({ canvasContext: context, viewport, canvas } as never).promise;

    pages.push({
      pageIndex: pageNumber - 1,
      mime: RENDER_MIME,
      data: dataUrlToBase64(canvas.toDataURL(RENDER_MIME, RENDER_QUALITY)),
    });
  }

  return pages;
}

/**
 * Optional text-layer fast path (D1).
 *
 * A PDF produced by an MFP's "scan to searchable PDF" or emailed straight from
 * a supplier's accounting software carries real text, and reading that text is
 * strictly better than OCR-ing a picture of it. When it yields rows, they are
 * seeded into the capture's `draft_json`, which is what the review drawer opens
 * from — so by the time recognition finishes the user already has the good
 * rows, and OCR remains the fallback for the (common) image-only case.
 *
 * `supplier-import-parser.ts` is used exactly as it ships and is not modified.
 * Anything that goes wrong here is swallowed: this is an optimization, and an
 * optimization must never be able to fail a capture.
 */
async function seedTextLayerDraft(captureId: string, bytes: Uint8Array): Promise<void> {
  try {
    const file = new File([bytes as BlobPart], 'original.pdf', { type: 'application/pdf' });
    const parsed = await extractSupplierImportFile(file);
    if (parsed.rows.length === 0) return;

    await saveCaptureDraft(captureId, {
      source: 'text_layer',
      rows: parsed.rows,
      supplier: {
        name: parsed.supplier?.name ?? '',
        email: parsed.supplier?.email ?? '',
        phone: parsed.supplier?.phone ?? '',
        notes: parsed.supplier?.notes ?? '',
      },
      invoice: {
        invoiceNumber: parsed.supplier?.invoiceNumber ?? '',
        invoiceDate: parsed.supplier?.invoiceDate ?? '',
      },
    });
  } catch (error) {
    console.warn('[capture] text-layer fast path skipped:', error);
  }
}

async function attachRenderedPages(
  captureId: string,
  pages: RenderedCapturePage[],
  failureReason?: string,
): Promise<void> {
  await getBridge().invoke('capture_attach_rendered_pages', {
    captureId,
    pages,
    failureReason,
  });
}

/**
 * Handle one `capture:needs-render` event end to end.
 *
 * Always answers `capture_attach_rendered_pages` — with pages on success, with
 * a stated reason otherwise — so the document leaves `capturing` either way.
 */
export async function renderCaptureDocument(captureId: string): Promise<void> {
  let bytes: Uint8Array | null = null;
  try {
    bytes = await readCaptureOriginal(captureId);
  } catch (error) {
    console.error('[capture] could not read the original document:', error);
  }

  if (!bytes || bytes.length === 0) {
    await attachRenderedPages(captureId, [], 'CAPTURE_UNREADABLE');
    return;
  }

  let pages: RenderedCapturePage[];
  let pageOverflow = false;
  try {
    const pdfjsLib = await loadPdfjs();
    const probe = await pdfjsLib.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    } as never).promise;
    pageOverflow = probe.numPages > MAX_CAPTURE_PAGES;
    await probe.destroy();

    pages = await rasterizePdf(bytes);
  } catch (error) {
    console.error('[capture] PDF rasterization failed:', error);
    await attachRenderedPages(captureId, [], 'CAPTURE_UNREADABLE');
    return;
  }

  if (pageOverflow) {
    // Refusing the whole document is kinder than silently importing the first
    // ten pages of a longer one and calling that the invoice (R12.3).
    await attachRenderedPages(captureId, [], 'CAPTURE_TOO_MANY_PAGES');
    return;
  }

  if (pages.length === 0) {
    await attachRenderedPages(captureId, [], 'CAPTURE_UNREADABLE');
    return;
  }

  await seedTextLayerDraft(captureId, bytes);
  await attachRenderedPages(captureId, pages);
}
