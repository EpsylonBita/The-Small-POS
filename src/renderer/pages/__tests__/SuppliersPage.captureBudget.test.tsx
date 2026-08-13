/**
 * invoice-scan-capture Task 18.1 (desktop counted budgets) and the desktop half
 * of Task 18.3 (per-source walkthroughs).
 *
 * Spec: `.claude/specs/invoice-scan-capture/requirements.md` R15.1, R15.2,
 * R15.4, R15.6; `design.md` Testing Strategy → "R15 budget assertions (Vitest)"
 * and Cross-cutting → "R15 per-source walkthroughs".
 *
 * These are **measurement** tests, not presence tests. Nothing here asserts
 * that a button exists and calls it a budget:
 *
 * - every click is performed through {@link Walkthrough.press}, which counts it;
 * - the screen the user is on is read back out of the rendered DOM after each
 *   step by {@link activeScreen}, and the budget is checked against the number
 *   of **distinct** screens.
 *
 * So an interstitial — a source picker, an "are you ready?" confirmation, a
 * separate review landing page — fails the suite by arithmetic rather than by
 * anyone noticing. The exact interaction trail is pinned too, which means a
 * regression cannot be papered over by a `<=` that still happens to hold.
 *
 * Both desktop-owned `CaptureSourceKind`s get a full walkthrough:
 *
 * - **connected_scanner** — Suppliers → Scan invoice → pages → check → Save;
 * - **watched_folder** — nothing at all, then the arrival notice → check →
 *   Save, with an explicit assertion that no file browsing happened anywhere
 *   (R15.4).
 *
 * The transport is mocked at the IPC / HTTP seam only; the real
 * `SuppliersPage`, `CapturePagesPanel`, `CaptureNotificationManager` and the
 * real `react-hot-toast` toaster all run, because "the arrival notice is one
 * tap away" is only true if the notice is a real, clickable thing.
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Walkthrough,
  activeScreen,
  enabledControlsOn,
  primaryActionsOn,
  screenRoot,
} from './capture-budget-harness';

// ---------------------------------------------------------------------------
// Mocks — the IPC and HTTP seams, and the heavy siblings of the suppliers page
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(handler);
    },
    offEvent: (name: string, handler: (payload: unknown) => void) => {
      listeners.get(name)?.delete(handler);
    },
    posApiGet: vi.fn(),
    posApiPost: vi.fn(),
    posApiFetch: vi.fn(),
    loadCaptureSources: vi.fn(),
    loadDefaultCaptureSourceId: vi.fn(),
    listCaptureDocuments: vi.fn(),
    getCaptureDocument: vi.fn(),
    getCapturePagePreview: vi.fn(),
    startCaptureDocument: vi.fn(),
    acquireFromScanner: vi.fn(),
    advanceCapture: vi.fn(),
    saveCaptureDraft: vi.fn(),
    confirmCaptureCommit: vi.fn(),
    removeCapturePage: vi.fn(),
    reorderCapturePages: vi.fn(),
    offlineCommitSupplierImport: vi.fn(),
    loadPurchaseOrderSnapshot: vi.fn(),
    extractSupplierImportFile: vi.fn(),
    openFileDialog: vi.fn(),
  };
});

/** Push one backend event at the frontend, the way the Rust workers do. */
function emitBackend(name: string, payload: unknown): void {
  mocks.listeners.get(name)?.forEach((handler) => handler(payload));
}

vi.mock('react-i18next', async () => {
  const { useTranslationEn } = await import('../../test/en-translate');
  return {
    useTranslation: useTranslationEn,
    // `src/lib/i18n.ts` boots i18next as a side effect of importing
    // `utils/format`; it only needs the plugin object to exist.
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        ({
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          variants: _variants,
          whileTap: _whileTap,
          whileHover: _whileHover,
          layout: _layout,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode }) =>
          React.createElement(tag, props as Record<string, unknown>, children),
    },
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../contexts/theme-context', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('../../contexts/module-context', () => ({
  useModules: () => ({ isModuleEnabled: () => true }),
}));

vi.mock('../../contexts/shift-context', () => ({
  useShift: () => ({ staff: { databaseStaffId: 'staff-1', name: 'Ada' } }),
}));

vi.mock('../../contexts/barcode-scanner-context', () => ({
  useOnBarcodeScan: () => undefined,
}));

vi.mock('../../components/procurement/PurchaseOrdersTab', () => ({
  default: () => null,
}));

vi.mock('../../services/capture-pdf-render', () => ({
  renderCaptureDocument: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => mocks.openFileDialog(...args),
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    invoke: vi.fn(),
    settings: { updateLocal: vi.fn() },
    terminalConfig: { getSetting: vi.fn() },
  }),
  onEvent: mocks.onEvent,
  offEvent: mocks.offEvent,
}));

vi.mock('../../utils/api-helpers', () => ({
  posApiGet: (...args: unknown[]) => mocks.posApiGet(...args),
  posApiPost: (...args: unknown[]) => mocks.posApiPost(...args),
  posApiFetch: (...args: unknown[]) => mocks.posApiFetch(...args),
}));

vi.mock('../../utils/supplier-import-parser', () => ({
  extractSupplierImportFile: (...args: unknown[]) => mocks.extractSupplierImportFile(...args),
}));

vi.mock('../../services/offline-mutations', () => ({
  offlineCommitSupplierImport: (...args: unknown[]) =>
    mocks.offlineCommitSupplierImport(...args),
}));

vi.mock('../../services/purchase-order-snapshot', () => ({
  loadPurchaseOrderSnapshot: (...args: unknown[]) => mocks.loadPurchaseOrderSnapshot(...args),
}));

vi.mock('../../services/capture-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/capture-client')>();
  return {
    ...actual,
    loadCaptureSources: mocks.loadCaptureSources,
    loadDefaultCaptureSourceId: mocks.loadDefaultCaptureSourceId,
    listCaptureDocuments: mocks.listCaptureDocuments,
    getCaptureDocument: mocks.getCaptureDocument,
    getCapturePagePreview: mocks.getCapturePagePreview,
    startCaptureDocument: mocks.startCaptureDocument,
    acquireFromScanner: mocks.acquireFromScanner,
    advanceCapture: mocks.advanceCapture,
    saveCaptureDraft: mocks.saveCaptureDraft,
    confirmCaptureCommit: mocks.confirmCaptureCommit,
    removeCapturePage: mocks.removeCapturePage,
    reorderCapturePages: mocks.reorderCapturePages,
  };
});

import { Toaster, toast } from 'react-hot-toast';
import CaptureNotificationManager from '../../components/CaptureNotificationManager';
import SuppliersPage from '../SuppliersPage';

// jsdom ships no `matchMedia`; the real toaster asks it about reduced motion.
// The toaster is not stubbed here on purpose — the watched-folder path's whole
// claim is that the arrival notice is a real thing a finger can land on.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAPTURE_ID = 'cap-budget-1';

const SCANNER_SOURCE = {
  id: 'src-scanner',
  kind: 'connected_scanner' as const,
  name: 'Back office scanner',
  deviceId: 'wia-1',
  isDefault: true,
};

const FOLDER_SOURCE = {
  id: 'src-folder',
  kind: 'watched_folder' as const,
  name: 'Scans folder',
  folderPath: 'C:/scans',
  isDefault: true,
};

function page(index: number) {
  return {
    pageIndex: index,
    filePath: `C:/captures/${CAPTURE_ID}/page-00${index}.png`,
    contentHash: `hash-${index}`,
    byteSize: 4096,
    mime: 'image/png',
  };
}

/** One recognised single-page invoice — a good result, nothing to fix. */
const RECOGNITION = {
  quality: 'good',
  rowConfidence: ['ok'],
  pages: [{ index: 0, storageKey: 'org/branch/captures/cap/page-000.jpg', confidence: 'ok' }],
  parsed: {
    supplier: { name: 'Fresh Farms' },
    invoice: { invoiceNumber: 'INV-9', invoiceDate: '2026-08-06' },
    rows: [{ name: 'Tomatoes', quantity: 2, unit: 'kg', cost: 3 }],
  },
};

function captureDocument(overrides: Record<string, unknown> = {}) {
  return {
    captureId: CAPTURE_ID,
    status: 'capturing',
    sourceKind: 'connected_scanner',
    sourceName: SCANNER_SOURCE.name,
    staffId: 'staff-1',
    capturedAt: '2026-08-06T09:00:00.000Z',
    pageCount: 1,
    recognition: null,
    draft: null,
    storageKeys: ['org/branch/captures/cap/page-000.jpg'],
    reasonCode: null,
    attempts: 0,
    updatedAt: '2026-08-06T09:00:00.000Z',
    pages: [page(0)],
    ...overrides,
  };
}

function serverDraft() {
  return {
    organizationId: 'org-1',
    branchId: 'branch-1',
    supplier: {
      id: 'sup-1',
      name: 'Fresh Farms',
      action: 'existing',
      contactPerson: null,
      email: null,
      phone: null,
      notes: null,
    },
    invoice: {
      invoiceNumber: 'INV-9',
      invoiceDate: '2026-08-06',
      dueDate: null,
      amount: 6,
      status: 'unpaid',
      notes: null,
    },
    rows: [
      {
        rowNumber: 1,
        status: 'update',
        name: 'Tomatoes',
        sku: '',
        barcode: '',
        quantity: 2,
        unit: 'kg',
        cost: 3,
        minStockLevel: 0,
        category: '',
        subcategory: '',
        notes: '',
        categoryPath: [],
        existingInventoryItemId: 'inv-1',
        errors: [],
        warnings: [],
      },
    ],
    missingCategories: [],
  };
}

function openPurchaseOrder() {
  return {
    id: 'po-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    supplierId: 'sup-1',
    supplierName: 'Fresh Farms',
    orderReference: 'PO-1001',
    status: 'ordered',
    expectedDeliveryDate: '2026-08-07',
    notes: null,
    items: [],
    orderedTotalCost: 100,
    receivedProgress: { orderedQty: 10, receivedQty: 0 },
    createdAt: null,
    updatedAt: null,
  };
}

/** The capture store, as the walkthrough advances it. */
let documentState: ReturnType<typeof captureDocument>;

function renderSuppliersWorkstation() {
  return render(
    <>
      <Toaster />
      <CaptureNotificationManager />
      <SuppliersPage />
    </>,
  );
}

async function landOnSuppliers(): Promise<Walkthrough> {
  renderSuppliersWorkstation();
  await screen.findByTestId('capture-scan-invoice');
  // The sources load asynchronously; a scan started before they arrive would
  // (correctly) offer setup instead, so the walk begins once the terminal
  // genuinely has its configured source.
  await waitFor(() => expect(mocks.loadCaptureSources).toHaveBeenCalled());
  await act(async () => undefined);
  return new Walkthrough();
}

/** Preview then Save inside the import drawer — the review screen's own steps. */
async function checkAndSave(walk: Walkthrough): Promise<void> {
  const drawer = screenRoot('review');
  expect(drawer).not.toBeNull();

  walk.press(within(drawer as HTMLElement).getByText('Preview').closest('button'), 'preview');
  // The checked draft lights up Save in both the drawer header and the review
  // panel — the same action, offered twice, so the count is not asserted here.
  await waitFor(() =>
    expect(
      within(screenRoot('review') as HTMLElement).getAllByText('Save to inventory').length,
    ).toBeGreaterThan(0),
  );

  walk.press(
    within(screenRoot('review') as HTMLElement)
      .getAllByText('Save to inventory')[0]
      .closest('button'),
    'save',
  );
  await screen.findByText('Invoice saved.');
  walk.observe();
}

beforeEach(() => {
  mocks.listeners.clear();
  documentState = captureDocument();

  mocks.posApiGet.mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('pos/suppliers')) return { success: true, data: { suppliers: [] } };
    return { success: true, data: { invoices: [], currency: 'EUR' } };
  });
  mocks.posApiPost.mockImplementation(async (endpoint: string) => {
    if (endpoint === 'pos/suppliers/import/preview') {
      return { success: true, data: { success: true, draft: serverDraft() } };
    }
    return { success: true, data: { success: true } };
  });
  mocks.posApiFetch.mockResolvedValue({
    success: true,
    status: 200,
    data: {
      success: true,
      result: { createdInventoryCount: 0, updatedInventoryCount: 1 },
    },
  });

  mocks.loadCaptureSources.mockResolvedValue([SCANNER_SOURCE]);
  mocks.loadDefaultCaptureSourceId.mockResolvedValue(SCANNER_SOURCE.id);
  mocks.listCaptureDocuments.mockImplementation(async () => [documentState]);
  mocks.getCaptureDocument.mockImplementation(async () => ({
    document: documentState,
    events: [],
  }));
  mocks.getCapturePagePreview.mockResolvedValue('data:image/png;base64,AAA');
  mocks.startCaptureDocument.mockResolvedValue(CAPTURE_ID);
  mocks.acquireFromScanner.mockResolvedValue({
    ok: true,
    pages: [page(0)],
    feederUsed: false,
    reachedPageCap: false,
  });
  mocks.advanceCapture.mockResolvedValue({ success: true });
  mocks.saveCaptureDraft.mockResolvedValue(undefined);
  mocks.confirmCaptureCommit.mockResolvedValue(undefined);
  mocks.removeCapturePage.mockResolvedValue({ success: true, pageCount: 0 });
  mocks.reorderCapturePages.mockResolvedValue(true);
  mocks.offlineCommitSupplierImport.mockResolvedValue(undefined);
  mocks.loadPurchaseOrderSnapshot.mockReturnValue({
    purchaseOrders: [],
    serverCursor: null,
  });
  mocks.extractSupplierImportFile.mockResolvedValue({ rows: [], supplier: null });
});

afterEach(() => {
  // The toast store lives in the module, not in the tree: without this a
  // notice raised by one walkthrough would still be on screen for the next one
  // and a "one notice, one tap" assertion would be measuring the wrong toast.
  toast.remove();
  cleanup();
});

// ---------------------------------------------------------------------------
// Task 18.1 — R15.1: starting a capture costs at most two interactions
// ---------------------------------------------------------------------------

describe('R15.1 — starting a scan is within the two-interaction budget', () => {
  it('takes exactly one counted click from the suppliers page to a scanning document', async () => {
    const walk = await landOnSuppliers();
    expect(walk.observe()).toBe('suppliers');

    walk.press(screen.getByTestId('capture-scan-invoice'));

    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');
    walk.observe();

    // The number, counted — not the button, spotted.
    expect(walk.interactionCount).toBeLessThanOrEqual(2);
    expect(walk.interactions).toEqual(['capture-scan-invoice']);
    expect(mocks.startCaptureDocument).toHaveBeenCalledTimes(1);
  });

  it('puts no interstitial between the suppliers page and the pages view', async () => {
    const walk = await landOnSuppliers();
    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');
    walk.observe();

    // Every screen the single click passed through, in order. A source picker,
    // a "which scanner?" sheet or a confirmation would show up as a third key
    // here and fail the suite.
    expect(walk.visited).toEqual(['suppliers', 'pages']);
  });

  it('does not spend a click on choosing a source when several are configured', async () => {
    mocks.loadCaptureSources.mockResolvedValue([
      SCANNER_SOURCE,
      { ...FOLDER_SOURCE, isDefault: false },
    ]);
    const walk = await landOnSuppliers();

    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');

    expect(walk.interactionCount).toBe(1);
    expect(mocks.startCaptureDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: 'connected_scanner' }),
    );
  });

  it('offers setup instead of an error when the terminal has no source, still inside the budget', async () => {
    mocks.loadCaptureSources.mockResolvedValue([]);
    mocks.loadDefaultCaptureSourceId.mockResolvedValue(null);
    const walk = await landOnSuppliers();

    walk.press(screen.getByTestId('capture-scan-invoice'));
    await waitFor(() => expect(activeScreen()).toBe('scan-settings'));

    expect(walk.interactionCount).toBe(1);
    expect(screen.getByText('No scanner set up yet')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 18.1 — R15.2: the happy path fits in four screens, one primary each
// ---------------------------------------------------------------------------

describe('R15.2 — the happy path stays inside the four-screen budget', () => {
  it('scan → pages → review → saved visits at most four distinct screens', async () => {
    const walk = await landOnSuppliers();

    // 1. Suppliers → start scanning.
    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');

    // 2. Pages → done. The document leaves for recognition.
    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() =>
      expect(mocks.advanceCapture).toHaveBeenCalledWith(
        expect.objectContaining({ captureId: CAPTURE_ID, status: 'waiting' }),
      ),
    );
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));
    walk.observe();

    // Recognition finishes in the background and says so.
    documentState = captureDocument({ status: 'ready_review', recognition: RECOGNITION });
    await act(async () => {
      emitBackend('capture:status-changed', {
        captureId: CAPTURE_ID,
        status: 'ready_review',
      });
    });

    // 3. The notice → review.
    walk.press(await screen.findByRole('button', { name: 'Check invoice' }), 'check-invoice');
    await waitFor(() => expect(activeScreen()).toBe('review'));

    // 4. Review → saved.
    await checkAndSave(walk);

    expect(walk.screenCount).toBeLessThanOrEqual(4);
    expect(walk.distinctScreens).toEqual(['suppliers', 'pages', 'review']);
  });

  it('lands the user back where they started, so "saved" costs no fifth screen', async () => {
    const walk = await landOnSuppliers();
    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');
    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));

    documentState = captureDocument({ status: 'ready_review', recognition: RECOGNITION });
    await act(async () => {
      emitBackend('capture:status-changed', { captureId: CAPTURE_ID, status: 'ready_review' });
    });
    walk.press(await screen.findByRole('button', { name: 'Check invoice' }), 'check-invoice');
    await waitFor(() => expect(activeScreen()).toBe('review'));
    await checkAndSave(walk);

    await waitFor(() => expect(activeScreen()).toBe('suppliers'));
    walk.observe();
    // The confirmation is one sentence on the screen the user came from — not a
    // "done!" page that would spend the fourth budget slot. [R9.4]
    expect(screen.getByText('Invoice saved.')).toBeInTheDocument();
    expect(walk.distinctScreens).toEqual(['suppliers', 'pages', 'review']);
  });

  it('gives every screen exactly one primary action that carries the flow forward', async () => {
    const walk = await landOnSuppliers();

    // Suppliers: the scan entry is the only primary in the capture surface; the
    // settings and queue entries are secondary chrome beside it.
    expect(primaryActionsOn('suppliers')).toEqual(['capture-scan-invoice']);
    expect(enabledControlsOn('suppliers')).toEqual(
      expect.arrayContaining(['capture-scan-settings', 'capture-queue-open']),
    );

    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');

    /*
      Pages: two primary-styled buttons, deliberately. R4.3 / R5.1 require "Add
      another page" and "Done" to be equally obvious choices, so the R15.2
      reading applied here is "one primary action *forward*". The set is pinned
      so a third primary — a real interstitial — fails, and the sibling is
      proved not to advance immediately below.
    */
    expect(primaryActionsOn('pages')).toEqual(['capture-add-page', 'capture-done']);

    walk.press(screen.getByTestId('capture-add-page'));
    await waitFor(() => expect(mocks.acquireFromScanner).toHaveBeenCalledTimes(2));
    // Still on the same screen: adding a page is an option, not a step.
    expect(activeScreen()).toBe('pages');

    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));

    documentState = captureDocument({ status: 'ready_review', recognition: RECOGNITION });
    await act(async () => {
      emitBackend('capture:status-changed', { captureId: CAPTURE_ID, status: 'ready_review' });
    });
    walk.press(await screen.findByRole('button', { name: 'Check invoice' }), 'check-invoice');
    await waitFor(() => expect(activeScreen()).toBe('review'));

    // Review on arrival: Save is inert until the check has run, so exactly one
    // primary is pressable — and it is the one that moves the flow on.
    expect(primaryActionsOn('review')).toEqual(['Preview']);
    expect(
      within(screenRoot('review') as HTMLElement).getByText('Save after preview').closest('button'),
    ).toBeDisabled();
  });

  it('fails the budget the moment an interstitial appears between two screens', async () => {
    // A guard on the instrument itself: the screen counter must react to a view
    // that was never part of the flow, otherwise every budget above is vacuous.
    const walk = await landOnSuppliers();
    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');

    const withoutDetour = walk.screenCount;

    // Stand in for an interstitial by opening a view mid-flow.
    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));
    walk.press(screen.getByTestId('capture-queue-open'), 'interstitial');
    await waitFor(() => expect(activeScreen()).toBe('queue'));

    expect(walk.screenCount).toBeGreaterThan(withoutDetour);
    expect(walk.distinctScreens).toContain('queue');
  });
});

// ---------------------------------------------------------------------------
// Task 18.3 — connected scanner, end to end
// ---------------------------------------------------------------------------

describe('Task 18.3 — connected_scanner walkthrough', () => {
  it('drives a scanner from the suppliers header to "Invoice saved." inside both budgets', async () => {
    mocks.loadPurchaseOrderSnapshot.mockReturnValue({
      purchaseOrders: [openPurchaseOrder()],
      serverCursor: null,
    });

    const walk = await landOnSuppliers();

    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');
    // The device really was driven — this is the scanner path, not a file pick.
    await waitFor(() =>
      expect(mocks.acquireFromScanner).toHaveBeenCalledWith({
        captureId: CAPTURE_ID,
        deviceId: SCANNER_SOURCE.deviceId,
      }),
    );
    const startCost = walk.interactionCount;

    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));

    documentState = captureDocument({ status: 'ready_review', recognition: RECOGNITION });
    await act(async () => {
      emitBackend('capture:status-changed', { captureId: CAPTURE_ID, status: 'ready_review' });
    });
    walk.press(await screen.findByRole('button', { name: 'Check invoice' }), 'check-invoice');
    await waitFor(() => expect(activeScreen()).toBe('review'));

    await checkAndSave(walk);

    expect(startCost).toBeLessThanOrEqual(2);
    expect(walk.screenCount).toBeLessThanOrEqual(4);
    expect(walk.distinctScreens).toEqual(['suppliers', 'pages', 'review']);
    expect(walk.interactions).toEqual([
      'capture-scan-invoice',
      'capture-done',
      'check-invoice',
      'preview',
      'save',
    ]);

    const commit = mocks.posApiFetch.mock.calls.find(
      ([endpoint]) => endpoint === 'pos/suppliers/import/commit',
    );
    expect(commit).toBeDefined();
    const body = JSON.parse(String((commit?.[1] as RequestInit).body));
    expect(body.capture).toMatchObject({
      captureId: CAPTURE_ID,
      sourceKind: 'connected_scanner',
    });
    // Nothing optional was touched, so nothing optional rides the commit.
    expect(body.poLinkage).toBeUndefined();
  });

  it('shows every secondary option and needs none of them', async () => {
    mocks.loadPurchaseOrderSnapshot.mockReturnValue({
      purchaseOrders: [openPurchaseOrder()],
      serverCursor: null,
    });

    const walk = await landOnSuppliers();
    walk.press(screen.getByTestId('capture-scan-invoice'));
    await screen.findByTestId('capture-add-page');
    await screen.findByTestId('capture-page-0');

    // Visible on the pages screen: retake, reorder, remove. [R5.2, R15.6]
    const pages = screenRoot('pages') as HTMLElement;
    const firstPage = within(pages).getByTestId('capture-page-0');
    expect(within(firstPage).getByLabelText('Scan this page again')).toBeInTheDocument();
    expect(within(firstPage).getByLabelText('Move later')).toBeInTheDocument();
    expect(within(firstPage).getByLabelText('Remove this page')).toBeInTheDocument();

    walk.press(screen.getByTestId('capture-done'));
    await waitFor(() => expect(activeScreen()).toBe('suppliers'));
    documentState = captureDocument({ status: 'ready_review', recognition: RECOGNITION });
    await act(async () => {
      emitBackend('capture:status-changed', { captureId: CAPTURE_ID, status: 'ready_review' });
    });
    walk.press(await screen.findByRole('button', { name: 'Check invoice' }), 'check-invoice');
    await waitFor(() => expect(activeScreen()).toBe('review'));

    // Visible on the review screen: purchase-order linkage, declined by default,
    // and the manual-entry row controls. [R9.2, R15.6]
    const drawer = screenRoot('review') as HTMLElement;
    const linkage = within(drawer).getByTestId('capture-po-linkage');
    expect(within(linkage).getByText('PO-1001', { exact: false })).toBeInTheDocument();
    const declineRadio = within(linkage).getByLabelText('No, this is something else');
    expect(declineRadio).toBeChecked();

    await checkAndSave(walk);

    // Skipped, all of them, and the invoice still saved.
    expect(mocks.removeCapturePage).not.toHaveBeenCalled();
    expect(mocks.reorderCapturePages).not.toHaveBeenCalled();
    expect(screen.getByText('Invoice saved.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 18.3 — watched folder: the zero-file-browsing path (R15.4)
// ---------------------------------------------------------------------------

describe('Task 18.3 — watched_folder walkthrough', () => {
  beforeEach(() => {
    mocks.loadCaptureSources.mockResolvedValue([FOLDER_SOURCE]);
    mocks.loadDefaultCaptureSourceId.mockResolvedValue(FOLDER_SOURCE.id);
    documentState = captureDocument({
      status: 'ready_review',
      sourceKind: 'watched_folder',
      sourceName: FOLDER_SOURCE.name,
      recognition: RECOGNITION,
    });
  });

  it('goes arrival notice → check → save with no file browsing at all', async () => {
    const walk = await landOnSuppliers();

    // Press Scan on the machine: the POS is told, nobody touched it.
    await act(async () => {
      emitBackend('capture:document-arrived', {
        captureId: CAPTURE_ID,
        sourceName: FOLDER_SOURCE.name,
      });
    });

    expect(await screen.findByText('A new invoice arrived.')).toBeInTheDocument();
    // Zero interactions have been spent getting the invoice onto the till.
    expect(walk.interactionCount).toBe(0);

    walk.press(screen.getByRole('button', { name: 'Check invoice' }), 'arrival-notice');
    await waitFor(() => expect(activeScreen()).toBe('review'));

    await checkAndSave(walk);

    expect(walk.interactions).toEqual(['arrival-notice', 'preview', 'save']);
    expect(walk.distinctScreens).toEqual(['suppliers', 'review']);
    expect(walk.screenCount).toBeLessThanOrEqual(4);

    // The R15.4 promise, asserted rather than described: no folder picker, no
    // file input, no "choose the scan" step anywhere on the path.
    expect(mocks.openFileDialog).not.toHaveBeenCalled();
    expect(mocks.extractSupplierImportFile).not.toHaveBeenCalled();
    expect(walk.interactions).not.toContain('capture-scan-invoice');
    expect(document.querySelector('input[type="file"]:not(.hidden)')).toBeNull();
  });

  it('answers "press Scan on your machine" rather than opening a picker if Scan is pressed here', async () => {
    const walk = await landOnSuppliers();

    walk.press(screen.getByTestId('capture-scan-invoice'));

    expect(
      await screen.findByText('Press Scan on your machine. The invoice will show up here on its own.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(activeScreen()).toBe('queue'));
    // No document was opened locally and no picker was raised — the folder is
    // driven from the machine, never from here. [R15.4, R17.7]
    expect(mocks.startCaptureDocument).not.toHaveBeenCalled();
    expect(mocks.openFileDialog).not.toHaveBeenCalled();
    expect(walk.interactionCount).toBe(1);
  });

  it('reaches review from the queue too, still inside the four-screen budget', async () => {
    const walk = await landOnSuppliers();

    walk.press(screen.getByTestId('capture-queue-open'));
    await waitFor(() => expect(activeScreen()).toBe('queue'));

    walk.press(
      await within(screenRoot('queue') as HTMLElement).findByText('Check & Save'),
      'queue-check',
    );
    await waitFor(() => expect(activeScreen()).toBe('review'));

    await checkAndSave(walk);

    expect(walk.distinctScreens).toEqual(['suppliers', 'queue', 'review']);
    expect(walk.screenCount).toBeLessThanOrEqual(4);
  });
});
