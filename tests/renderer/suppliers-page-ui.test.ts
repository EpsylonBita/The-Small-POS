import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const suppliersPagePath = path.join(projectRoot, 'src', 'renderer', 'pages', 'SuppliersPage.tsx');
const localesDir = path.join(projectRoot, 'src', 'locales');

const suppliersPageSource = () => readFileSync(suppliersPagePath, 'utf8');

function flattenKeys(value: unknown, prefix = '', out = new Set<string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flattenKeys(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  out.add(prefix);
  return out;
}

test('SuppliersPage is a hidden-scrollbar supplier workbench', () => {
  const source = suppliersPageSource();

  assert.match(source, /h-full min-h-0 overflow-hidden/);
  assert.match(source, /overflow-y-auto scrollbar-hide/);
  assert.match(source, /aria-label=\{t\('common.refresh'/);
  // Founder 01/11: the refresh button is the kit icon button (44 px, raised; was a custom 48 px square).
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}\s*className="pos-icon-btn"/);
  assert.match(source, /<RefreshCw className=\{`w-5 h-5 \$\{loading \? 'animate-spin' : ''\}`\} \/>/);
});

test('SuppliersPage supports POS-only scan and review-first import actions', () => {
  const source = suppliersPageSource();

  assert.match(source, /useOnBarcodeScan/);
  assert.match(source, /BarcodeDetector/);
  assert.match(source, /extractSupplierImportFile/);
  assert.match(source, /pos\/suppliers\/import\/preview/);
  assert.match(source, /pos\/suppliers\/import\/commit/);
  assert.match(source, /pos\/supplier-invoices\/\$\{invoiceId\}\/mark-\$\{status\}/);
  assert.match(source, /pos\/supplier-invoices\/\$\{selectedInvoice\.id\}\/payments/);
  assert.match(source, /partialPayment/);
  assert.match(source, /Supplier summary/);
  assert.match(source, /getInvoiceDisplayDate/);
  // Round 180: the owed/spent stats are icon-based (Wallet), not a currency-symbol span.
  assert.match(source, /\bWallet\b/);
  assert.match(source, /icon: Wallet/);
  assert.match(source, /formatCurrency\(amount, currencyCode, i18n\.language\)/);
  assert.doesNotMatch(source, /DollarSign/);
  assert.match(source, /saveAfterPreview/);
  assert.match(source, /endpointUnavailable/);
});

test('SuppliersPage import drawer portals above the page container with a blurred app backdrop', () => {
  const source = suppliersPageSource();

  assert.match(source, /import \{ renderModalPortal \} from '\.\.\/utils\/render-modal-portal';/);
  assert.match(source, /\{importOpen && renderModalPortal\(\s*<motion\.div/);
  // Founder 01/11: the shared glass backdrop and shell.
  assert.match(source, /className="fixed inset-0 z-1200 flex items-center justify-end p-0 sm:p-4 md:p-6"[\s\S]{0,400}<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/);
  assert.doesNotMatch(source, /\{importOpen && \(\s*<motion\.div\s+className="fixed inset-0 z-50/);
  assert.doesNotMatch(source, /<AnimatePresence>[\s\S]*\{importOpen && renderModalPortal/);

  const importPortalIndex = source.indexOf('{importOpen && renderModalPortal(');
  const priorAnimatePresenceOpen = source.lastIndexOf('<AnimatePresence>', importPortalIndex);
  const priorAnimatePresenceClose = source.lastIndexOf('</AnimatePresence>', importPortalIndex);
  assert.ok(
    priorAnimatePresenceOpen === -1 ||
    priorAnimatePresenceClose > priorAnimatePresenceOpen,
    'import drawer portal must not be a direct child of AnimatePresence',
  );
});

test('SuppliersPage supplier detail overlays portal above the page container with a blurred app backdrop', () => {
  const source = suppliersPageSource();

  assert.match(source, /\{supplierSummary && renderModalPortal\(\s*<motion\.div/);
  assert.match(source, /\{selectedInvoice && selectedInvoiceStatus && renderModalPortal\(\s*<motion\.div/);
  // Three centered overlays share the portal z-index: supplier summary,
  // invoice detail, and — since invoice-scan-capture task 12.3 — the scanned
  // invoice queue, so none of them can be trapped behind the page container.
  // Founder 01/11: the summary and the queue are the shared glass window (backdrop + shell); the invoice details
  // (payment) window keeps its own backdrop until the founder decides on it.
  assert.equal(
    [...source.matchAll(/className="fixed inset-0 z-1200 flex items-center justify-center p-4"/g)].length,
    2,
  );
  assert.equal(
    [...source.matchAll(/className="fixed inset-0 z-1200 flex items-center justify-center bg-black\/55 p-4 backdrop-blur-sm"/g)].length,
    1,
  );
  assert.match(source, /<div className="liquid-glass-modal-backdrop" onClick=\{\(\) => setSupplierSummaryId\(null\)\} aria-hidden="true" \/>/);
  assert.match(source, /<div className="liquid-glass-modal-backdrop" onClick=\{\(\) => setCaptureQueueOpen\(false\)\} aria-hidden="true" \/>/);
  assert.match(source, /const modalShellClass = 'liquid-glass-modal-shell relative flex w-full flex-col text-\(--pos-s-fg\)';/);
  assert.match(source, /aria-labelledby=\{summaryTitleId\}[\s\S]{0,120}className=\{`max-w-4xl \$\{modalShellClass\}`\}/);
  assert.match(source, /\{captureEnabled && captureQueueOpen && renderModalPortal\(/);
  assert.doesNotMatch(source, /\{supplierSummary && \(\s*<motion\.div/);
  assert.doesNotMatch(source, /\{selectedInvoice && selectedInvoiceStatus && \(\s*<motion\.div/);
  assert.doesNotMatch(source, /className="fixed inset-0 z-50 flex items-center justify-center/);
  assert.doesNotMatch(source, /className="fixed inset-0 z-60 flex items-center justify-center/);
});

test('SuppliersPage uses unwrapped icons and yellow transparent selection chrome', () => {
  const source = suppliersPageSource();

  assert.match(source, /<h1 className="truncate text-3xl font-bold tracking-tight">\{t\('suppliers\.title', 'Suppliers'\)\}<\/h1>/);
  // Founder 01/11: stat icons are neutral (muted), never green / amber / red decoration.
  assert.match(source, /<Icon className="h-5 w-5 shrink-0 text-\(--pos-s-muted\)" aria-hidden="true" \/>/);
  assert.doesNotMatch(source, /iconClass: 'text-(?:emerald|amber|red)-500'/);
  // Round 180: stats are icon-only now (Wallet etc.); the old currency-symbol span is gone.
  assert.doesNotMatch(source, /w-5 shrink-0 text-center text-lg font-bold leading-none/);
  // Founder 01/11: no yellow outlines as emphasis — Scan invoice is the one yellow primary.
  assert.doesNotMatch(source, /border-\(--pos-s-yellow\) text-\(--pos-s-fg\) active:bg-\(--pos-s-surface-2\)|border-yellow-400 text-gray-950/);
  // founder 31/10 + 01/11: the selected supplier card is a kit card with the 2 px yellow kit outline.
  assert.match(source, /\? 'border-2! border-\(--pos-s-sel-bg\)! p-\[15px\]' : 'p-4'/);
  assert.match(source, /shrink-0 text-xs font-semibold \$\{supplier\.is_active/);
  assert.match(source, /<div className="text-\(--pos-s-muted\)">\{icon\}<\/div>/);
  assert.doesNotMatch(source, /text-yellow-\d00/);
  assert.doesNotMatch(source, /<Truck className/);
  assert.doesNotMatch(source, /flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border[\s\S]*<Truck/);
  assert.doesNotMatch(source, /flex h-9 w-9 items-center justify-center rounded-lg \$\{stat\.iconClass\}/);
  assert.doesNotMatch(source, /border-blue-500 bg-blue-500\/10/);
  assert.doesNotMatch(source, /shrink-0 rounded-full border px-2 py-1 text-xs font-semibold \$\{supplier\.is_active/);
});

test('SuppliersPage search placeholder is tab-aware (suppliers vs invoices)', () => {
  const source = suppliersPageSource();

  // Placeholder must switch copy based on the active tab.
  assert.match(
    source,
    /placeholder=\{\s*activeTab === 'suppliers'\s*\?\s*t\('suppliers\.searchSuppliers'[^)]*\)\s*:\s*t\('suppliers\.searchInvoices'[^)]*\)\s*\}/,
  );
  // The supplier-only placeholder that showed on the invoices tab must be gone.
  assert.doesNotMatch(source, /placeholder=\{t\('suppliers\.search',/);
});

test('SuppliersPage search input has tab-aware accessibility support', () => {
  const source = suppliersPageSource();

  // The accessible name must switch with the active tab. UI Automation caches the
  // placeholder-derived name on Windows, so a tab-aware placeholder alone leaves
  // screen-reader/automation users with stale supplier copy on the invoices tab.
  assert.match(
    source,
    /aria-label=\{\s*activeTab === 'suppliers'\s*\?\s*t\('suppliers\.searchSuppliers'[^)]*\)\s*:\s*t\('suppliers\.searchInvoices'[^)]*\)\s*\}/,
  );
  // Remounting the input when the tab changes forces a fresh accessibility node.
  assert.match(source, /<input\s+key=\{activeTab\}/);
});

test('SuppliersPage supplier translation keys exist in every POS locale', () => {
  const requiredKeys = [
    'searchSuppliers',
    'searchInvoices',
    'import.open',
    'import.title',
    'import.preview',
    'import.commit',
    'import.fileReadFailed',
    'import.importedRows',
    'import.rowCount',
    'import.saveAfterPreview',
    'import.saveRequiresPreview',
    'import.previewThenSaveHelp',
    'import.endpointUnavailable',
    'import.adminHtmlError',
    'import.supplierEmail',
    'import.hardwareScanner',
    'import.supplierNotes',
    'import.supplierPhone',
    'import.camera',
    'import.status.create',
    'import.status.update',
    'import.status.skip',
    'invoices.markPaid',
    'invoices.markUnpaid',
    'invoices.invoiceDate',
    'invoices.partialPayment',
    'invoices.detailsTitle',
    'invoices.totalSpent',
    'invoices.paidTotal',
    'invoices.unpaidTotal',
    'invoices.invoiceCount',
    'invoices.paidAmount',
    'invoices.remaining',
    'invoices.paymentOptions',
    'invoices.paymentAmount',
    'invoices.reference',
    'invoices.paymentNotes',
    'invoices.recordPayment',
    'invoices.payRemaining',
    'invoices.payments',
    'invoices.noPayments',
    'invoices.noPaymentNeeded',
    'invoices.paymentRecorded',
    'invoices.paymentFailed',
    'invoices.paymentAmountRequired',
    'invoices.paymentAmountTooHigh',
    'invoices.methods.cash',
    'invoices.methods.bankTransfer',
    'invoices.methods.check',
    'invoices.methods.creditCard',
    'invoices.methods.other',
    // supplier-invoice-automation task 8.2 (§4.5, §4.13, R16.3): a payment the
    // supplier's own statement implied states no method, and a payment that was
    // undone is a contra row. Both are labelled in words, in all five locales.
    'paymentMethod.unknown',
    'payment.reversal',
    'summary.title',
    'status.unpaid',
    'status.partial',
    'status.paid',
    'status.overdue',
    'status.cancelled',
  ];

  const localeFiles = readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .sort();

  for (const file of localeFiles) {
    const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
    const available = flattenKeys(locale.suppliers);
    const missing = requiredKeys.filter(key => !available.has(key));

    assert.deepEqual(
      missing,
      [],
      `${file} is missing SuppliersPage translations:\n${missing.map(key => `  - suppliers.${key}`).join('\n')}`,
    );
  }
});

// Regression contract for the stale supplier detail (2026-06-21 review): the detail
// panel derived selectedSupplier from the full list (`suppliers.find() || suppliers[0]`)
// independent of the search filter, so a no-result supplier search still showed the
// previously selected supplier's details next to a "no suppliers found" list.
test('SuppliersPage supplier-tab detail derives from the filtered (visible) list, not stale data', () => {
  const source = suppliersPageSource();

  // selectedSupplier is tab-aware: on the Suppliers tab it resolves from filteredSuppliers
  // (keep current selection if still visible, else first visible, else null -> empty state).
  assert.match(
    source,
    /const selectedSupplier = useMemo\(\(\) => \{\s*if \(activeTab === 'suppliers'\) \{\s*return \(\s*filteredSuppliers\.find\(supplier => supplier\.id === selectedSupplierId\) \|\|\s*filteredSuppliers\[0\] \|\|\s*null\s*\);/,
    'suppliers-tab detail must derive from filteredSuppliers so a no-result search shows the empty state',
  );

  // The old unconditional all-suppliers derivation (which ignored the filter) is gone.
  assert.doesNotMatch(
    source,
    /const selectedSupplier = useMemo\(\s*\(\) => suppliers\.find\(supplier => supplier\.id === selectedSupplierId\) \|\| suppliers\[0\] \|\| null,/,
  );

  // The detail panel still renders the localized empty state when nothing is selected.
  assert.match(source, /suppliers\.detail\.emptyTitle/);
  assert.match(source, /suppliers\.detail\.emptyDescription/);
});

test('SuppliersPage invoices-tab detail still follows the selected invoice supplier (not regressed)', () => {
  const source = suppliersPageSource();

  // On the Invoices tab the panel derives from the full supplier list, so clicking an
  // invoice still shows its supplier regardless of the supplier search filter.
  assert.match(
    source,
    /return suppliers\.find\(supplier => supplier\.id === selectedSupplierId\) \|\| suppliers\[0\] \|\| null;/,
  );
  // Clicking an invoice still selects its supplier for the detail panel.
  assert.match(source, /setSelectedSupplierId\(invoice\.supplier_id\)/);
});

// Regression contract for the unlabelled import overlay (2026-06-21 live QA): the import
// drawer looked modal (portaled + blurred) but exposed no dialog semantics, so AT only
// saw a heading + controls appended after the page.
test('SuppliersPage import overlay exposes labelled dialog semantics with a blurred app backdrop', () => {
  const source = suppliersPageSource();

  // Stable title id from useId at the top level.
  assert.match(source, /import React, \{[^}]*\buseId\b[^}]*\} from 'react';/);
  assert.match(source, /const importTitleId = useId\(\);/);

  // The slide-in panel declares a labelled dialog wired to the visible import title.
  assert.match(
    source,
    /ref=\{importDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{importTitleId\}/,
    'the import panel must be a labelled dialog',
  );
  assert.match(
    source,
    /<h2 id=\{importTitleId\}[^>]*>\{t\('suppliers\.import\.title', 'Import supplier items'\)\}<\/h2>/,
  );

  // Still portaled outside the page container with the standard blurred app backdrop (founder 01/11: the shared
  // glass backdrop).
  assert.match(source, /\{importOpen && renderModalPortal\(\s*<motion\.div/);
  assert.match(source, /className="fixed inset-0 z-1200 flex items-center justify-end p-0 sm:p-4 md:p-6"/);
  assert.match(source, /<div className="liquid-glass-modal-backdrop" aria-hidden="true" \/>/);
});

// Regression contract for the non-dismissable import overlay (2026-06-21 live QA): Escape
// did nothing; only the X closed it. Escape must close it through a close-only path that
// triggers no preview/save/file-import/scan/barcode-add/row-delete side effect.
test('SuppliersPage import overlay Escape closes via the close-only path and triggers no data mutation', () => {
  const source = suppliersPageSource();

  // Close-only callback: flips importOpen first and never reaches a
  // mutation/submit handler. Since invoice-scan-capture task 12.4 it also
  // persists the review draft on the way out (leaving review must lose no
  // edits), so the contract is asserted against the callback body rather than
  // against an exact one-statement shape.
  assert.match(source, /const closeImport = useCallback\(\(\) => \{\s*setImportOpen\(false\);/);
  const closeImportBody = source.match(
    /const closeImport = useCallback\(\(\) => \{([\s\S]*?)\}, \[[\s\S]*?\]\);/,
  );
  assert.ok(closeImportBody, 'closeImport must remain a useCallback with a dependency array');
  assert.doesNotMatch(
    closeImportBody[1],
    /(previewImport|commitImport|handleFileImport|scanImageBarcode|appendBarcodeRow|removeDraftRow)/,
    'the import close path must not trigger preview/save/file-import/scan/barcode-add/row-delete',
  );
  // Leaving review persists the draft instead of discarding it. [R8.6]
  assert.match(closeImportBody[1], /saveCaptureDraft\(/);

  // Escape effect: gated on importOpen, topmost-[role="dialog"] gated, routed to close-only.
  assert.match(source, /if \(!importOpen\) \{\s*return;\s*\}/);
  assert.match(source, /const dialogs = Array\.from\(document\.querySelectorAll\('\[role="dialog"\]'\)\);/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== importDialogRef\.current/);
  assert.match(source, /event\.preventDefault\(\);\s*closeImport\(\);/);
  assert.match(source, /document\.addEventListener\('keydown', handleEscape\)/);
  assert.match(source, /document\.removeEventListener\('keydown', handleEscape\)/);

  // The X close button shares the same close-only path.
  assert.match(source, /onClick=\{closeImport\}/);

  // No Escape handler routes to the side-effecting handlers.
  assert.doesNotMatch(
    source,
    /event\.preventDefault\(\);\s*(void )?(previewImport|commitImport|handleFileImport|scanImageBarcode|appendBarcodeRow|removeDraftRow)\(/,
  );

  // Those side-effecting actions remain wired only to their own controls.
  assert.match(source, /onClick=\{previewImport\}/);
  assert.match(source, /onClick=\{commitImport\}/);
  assert.match(source, /onClick=\{\(\) => appendBarcodeRow\(manualBarcode\)\}/);
  assert.match(source, /onRemove=\{removeDraftRow\}/);
  assert.match(source, /void handleFileImport\(file\)/);
});

// Regression contract for the invisible desktop backdrop (2026-06-21 follow-up QA): the
// import panel used max-w-7xl (~1280px) so on a ~1282px POS desktop it covered the whole
// app with no visible blurred backdrop. The panel must stay width-constrained on desktop
// while remaining full-bleed (usable) on narrow/mobile widths.
test('SuppliersPage import overlay keeps a visible blurred backdrop on desktop (panel cannot cover the viewport)', () => {
  const source = suppliersPageSource();

  // The backdrop reserves visible margin on desktop and is full-bleed on mobile.
  assert.match(source, /flex items-center justify-end p-0 sm:p-4 md:p-6/);

  // The panel is full width only on small screens, then capped on desktop via a calc/min
  // width so a blurred strip of page is always visible behind it (gap = max(100vw-72rem, 8rem)).
  // Founder 01/11: the panel is the shared glass shell (w-full flex-col come from modalShellClass).
  assert.match(
    source,
    /className=\{`h-full max-w-none \$\{modalShellClass\} sm:max-w-\[min\(72rem,calc\(100vw-8rem\)\)\]`\}/,
    'the import panel must be width-constrained on desktop, full-bleed on mobile',
  );

  // No regression to the full-bleed desktop width that covered the app.
  assert.doesNotMatch(source, /max-w-7xl/);

  // The width cap must be desktop-scoped (sm:), never unconditional, so narrow/mobile
  // stays full-width usable.
  assert.doesNotMatch(source, /[^:]max-w-\[min\(72rem,calc\(100vw-8rem\)\)\]/);
});

// Regression contract for the non-dismissable supplier overlays (2026-06-21 live QA): the
// supplier summary modal (and the invoice details modal) closed only via backdrop/X - Escape
// did nothing. Both must close via the same topmost-[role="dialog"] close-only gate as the
// import drawer, without making payment/status/save easier to trigger.
test('SuppliersPage supplier summary modal closes on Escape via the topmost-dialog close-only path', () => {
  const source = suppliersPageSource();

  // Labelled dialog semantics so the panel joins the [role="dialog"] stack the gate scans.
  assert.match(source, /const summaryDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /const summaryTitleId = useId\(\);/);
  assert.match(
    source,
    /ref=\{summaryDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{summaryTitleId\}/,
  );
  assert.match(source, /<h2 id=\{summaryTitleId\}[^>]*>\{supplierSummary\.supplier\.name\}<\/h2>/);

  // Close-only callback: only clears the open id (never payment/status/save).
  assert.match(source, /const closeSupplierSummary = useCallback\(\(\) => \{\s*setSupplierSummaryId\(null\);\s*\}, \[\]\);/);

  // Escape effect: gated on supplierSummaryId, topmost-gated against the summary panel.
  assert.match(source, /if \(!supplierSummaryId\) \{\s*return;\s*\}/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== summaryDialogRef\.current/);
  assert.match(source, /event\.preventDefault\(\);\s*closeSupplierSummary\(\);/);

  // Backdrop + X close behavior unchanged (still clear the id directly).
  assert.ok(
    (source.match(/onClick=\{\(\) => setSupplierSummaryId\(null\)\}/g) || []).length >= 2,
    'summary backdrop + X must still close by clearing supplierSummaryId',
  );

  // Escape must not reach the payment/record action.
  assert.doesNotMatch(source, /event\.preventDefault\(\);\s*(void )?recordInvoicePayment/);
});

test('SuppliersPage invoice details modal closes on Escape via the same topmost-dialog close-only path', () => {
  const source = suppliersPageSource();

  assert.match(source, /const invoiceDialogRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /const invoiceTitleId = useId\(\);/);
  assert.match(
    source,
    /ref=\{invoiceDialogRef\}\s*role="dialog"\s*aria-modal="true"\s*aria-labelledby=\{invoiceTitleId\}/,
  );
  assert.match(source, /<h2 id=\{invoiceTitleId\}[^>]*>\{formatDate\(getInvoiceDisplayDate\(selectedInvoice\)\)\}<\/h2>/);

  assert.match(source, /const closeInvoiceDetails = useCallback\(\(\) => \{\s*if \(paymentPendingRef\.current\) return;\s*setSelectedInvoiceId\(null\);\s*\}, \[\]\);/);
  assert.match(source, /if \(!selectedInvoiceId\) \{\s*return;\s*\}/);
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== invoiceDialogRef\.current/);
  assert.match(source, /event\.preventDefault\(\);\s*closeInvoiceDetails\(\);/);
  assert.ok(
    (source.match(/onClick=\{closeInvoiceDetails\}/g) || []).length >= 2,
    'invoice backdrop + X must use the shared close handler that guards pending payments',
  );

  // The import drawer Escape behavior is preserved (its own ref/gate untouched), so the
  // three overlays each handle Escape independently via the shared topmost gate.
  assert.match(source, /dialogs\.length > 0 && dialogs\[dialogs\.length - 1\] !== importDialogRef\.current/);
  assert.match(source, /const closeImport = useCallback\(\(\) => \{\s*setImportOpen\(false\);/);
});

// Round 180 (touch-first, live QA): the SuppliersPage refresh button exposed a native Greek tooltip
// (title="Ανανέωση"); native title= attrs also lingered on the disabled import-save guidance. On a
// touchscreen POS there must be no native title tooltips. Accessible names come from aria-label, and
// the EmptyState heading is a VISIBLE <h3> (its component prop was renamed title -> heading so no
// `title=` token remains in the page to be mistaken for a DOM tooltip).
test('SuppliersPage has no native title tooltips; aria-labels and visible EmptyState heading preserved', () => {
  const source = suppliersPageSource();

  // No native DOM title attribute anywhere on the page.
  assert.doesNotMatch(source, /\btitle=/);

  // The EmptyState renders a VISIBLE heading (h3) via a `heading` prop (not a title tooltip); the
  // visible copy (i18n keys) is unchanged, only the prop name.
  assert.match(source, /heading: string;/);
  // Founder 01/11: the empty state needs no theme ternary (kit tokens), so it takes no isDark prop.
  assert.match(source, /const EmptyState: React\.FC<EmptyStateProps> = \(\{ icon, heading, description \}\)/);
  assert.match(source, /<h3 className="text-base font-bold">\{heading\}<\/h3>/);
  assert.match(source, /heading=\{t\('suppliers\.empty\.title', 'No suppliers found'\)\}/);

  // Icon-only controls keep accessible names via aria-label; refresh keeps its click handler.
  assert.match(source, /aria-label=\{t\('common\.refresh', 'Refresh'\)\}/);
  assert.match(source, /onClick=\{fetchData\}/);
  assert.match(source, /aria-label=\{t\('common\.close', 'Close'\)\}/);

  // The disabled import-save guidance no longer uses a native title; the button keeps its disabled
  // behavior, and its visible "Save after preview" label communicates the preview precondition.
  assert.doesNotMatch(source, /title=\{!importDraft/);
  assert.match(source, /disabled=\{saving \|\| !importDraft \|\| importDraft\.rows\.some\(row => row\.status === 'error'\)\}/);
  assert.match(source, /suppliers\.import\.saveAfterPreview/);
});

test('SuppliersPage supervisor polish keeps supplier/import controls rounded and on-palette', () => {
  const source = suppliersPageSource();

  assert.doesNotMatch(source, /rounded-lg|rounded-md/);
  assert.doesNotMatch(source, /hover:|group-hover:|dark:hover:/);
  assert.doesNotMatch(source, /\btitle=/);
  assert.doesNotMatch(source, /bg-blue|text-blue|border-blue|focus:ring-blue|focus:border-blue/);
  assert.doesNotMatch(source, /bg-purple|text-purple|border-purple|ring-purple/);
  // Founder 01/11: the import controls are the kit buttons, icon buttons and ONE kit field look (rounded-xl, 48 px);
  // the invoice details (payment) window keeps its own rounded controls.
  assert.match(source, /inline-flex min-h-10 items-center gap-2 rounded-2xl/);
  assert.match(source, /const kitFieldLook = 'min-h-\[48px\] rounded-xl border border-\(--pos-s-control\) bg-\(--pos-s-surface\) px-3 text-base font-semibold text-\(--pos-s-fg\)/);
  assert.match(source, /className="pos-icon-btn self-center"\s*aria-label=\{t\('common\.delete', 'Delete'\)\}/);
  assert.match(source, /className="pos-icon-btn"\s*aria-label=\{t\('suppliers\.import\.addBarcode', 'Add barcode'\)\}/);
  assert.match(source, /className=\{`min-w-\[220px\] flex-1 \$\{fieldClass\}`\}/);
  assert.match(source, /<p className=\{`mt-2 text-xs font-semibold \$\{row\.errors\.length > 0 \? 'text-\(--pos-s-bad\)' : 'text-\(--pos-s-warn\)'\}`\}>/);
  assert.doesNotMatch(source, /h-10 rounded-2xl border px-3 text-sm outline-hidden/);
});

test('Founder 01/11: the Suppliers page follows the kit (hero, tabs, tiles, cards, words)', () => {
  const source = suppliersPageSource();

  // Hero and panels are kit cards; Scan invoice is the one yellow primary, the rest neutral kit buttons.
  assert.match(source, /<section className="pos-card shrink-0 p-4 md:p-5">/);
  assert.match(source, /data-testid="capture-scan-invoice"[\s\S]{0,240}className=\{primaryButtonClass\}/);
  assert.match(source, /data-testid="capture-scan-settings"[\s\S]{0,240}className=\{secondaryButtonClass\}/);
  assert.match(source, /data-testid="capture-queue-open"[\s\S]{0,240}className=\{secondaryButtonClass\}/);
  assert.match(source, /onClick=\{\(\) => setImportOpen\(true\)\}\s*className=\{secondaryButtonClass\}/);
  const hero = source.slice(source.indexOf('<section className="pos-card shrink-0'), source.indexOf('</section>'));
  assert.equal((hero.match(/className=\{primaryButtonClass\}/g) || []).length, 1, 'one yellow primary in the hero');
  // The queued count is a plain amber word, no pill.
  assert.match(source, /data-testid="capture-pending-badge"\s*className="font-bold tabular-nums text-\(--pos-s-warn\)"/);
  // Tabs are kit options with the yellow selection (never a black / white fill).
  assert.match(source, /className=\{`pos-choice\$\{activeTab === tab \? ' is-selected' : ''\}`\}/);
  assert.doesNotMatch(source, /'bg-white text-black' : 'bg-black text-white'/);
  // Filters are the kit select; the search is the kit field.
  assert.equal((source.match(/className="pos-select"/g) || []).length, 2);
  // Stat numbers are coloured only when they state something, and only above zero.
  assert.match(source, /toneClass: stats\.unpaidInvoices > 0 \? 'text-\(--pos-s-warn\)' : ''/);
  assert.match(source, /toneClass: stats\.overdueInvoices > 0 \? 'text-\(--pos-s-bad\)' : ''/);
  assert.match(source, /toneClass: stats\.totalOwed > 0\.005 \? 'text-\(--pos-s-warn\)' : ''/);
  // Statuses are coloured words on the page and the summary (no pill).
  assert.match(source, /\$\{getInvoiceStatusTextClass\(paymentStatus\)\}/);
  assert.match(source, /\$\{getInvoiceStatusTextClass\(status\)\}/);
  assert.match(source, /supplier\.is_active \? 'text-\(--pos-s-ok\)' : 'text-\(--pos-s-muted\)'/);
  // Cards are kit cards in a grid inside a scroll column that keeps room for their shadows.
  assert.match(source, /className=\{`pos-card min-h-\[180px\] text-left/);
  assert.match(source, /className="pos-scroll-room min-h-0 flex-1 overflow-y-auto scrollbar-hide p-3 md:p-4"/);
  // The summary tiles carry neutral icons with no circle wrapper.
  assert.doesNotMatch(source, /flex h-9 w-9 items-center justify-center rounded-2xl \$\{isDark \? 'bg-zinc-800 text-zinc-200' : 'bg-white text-gray-700'\}`\}>\s*\{Icon \?/);
  // The empty state's icon has no grey box.
  assert.doesNotMatch(source, /mb-3 flex h-14 w-14 items-center justify-center rounded-xl/);
  // Review drawer: one yellow primary at a time (Preview until checked, then Save).
  assert.match(source, /className=\{importDraft \? secondaryButtonClass : primaryButtonClass\}/);
  assert.match(source, /className=\{importDraft \? primaryButtonClass : secondaryButtonClass\}/);
});

// (Founder 01/11 moved the refresh button and the aside tiles onto the kit classes; the guards below follow.)
// --- Round 257 (live QA, 1282x802 Greek/dark): the Suppliers detail aside clipped its invoice-count
// tile at the bottom edge, and the header refresh button was a stark black/white square that broke the
// POS glass/yellow/neutral system used by the recent hotel + Menu/Housekeeping pages. The refresh is
// now amber glass, and the desktop detail aside is compacted (p-3 header/body/card, space-y-3) with a
// generous bottom pad (pb-4) over the hidden scrollbar so the invoice-count tile is fully visible.
// Fetches/filters/imports/modal behaviour/locale keys are unchanged. ---

test('Round 257: the header refresh button is amber glass, not a stark black/white square', () => {
  const source = suppliersPageSource();
  // Founder 01/11: the kit icon button in both themes (raised, soft shadow, no outline).
  assert.match(source, /onClick=\{fetchData\}\s*disabled=\{loading\}\s*aria-label=\{t\('common\.refresh', 'Refresh'\)\}\s*className="pos-icon-btn"/);
  // The stark black/white refresh treatment is gone.
  assert.doesNotMatch(source, /border border-white\/80 bg-white text-black/);
  assert.doesNotMatch(source, /border border-black bg-black text-white/);
  // Touch-first, accessible-name-only — no hover utilities, no native title anywhere on the page.
  assert.match(source, /aria-label=\{t\('common\.refresh'/);
  assert.doesNotMatch(source, /hover:/);
  assert.doesNotMatch(source, /\btitle=/);
});

test('Round 257: the desktop supplier detail aside is compacted with bottom breathing room (no clipped invoice tile)', () => {
  const source = suppliersPageSource();
  // Aside header compacted to p-3 (anchored on the detail title so the summary modal is not matched).
  assert.match(source, /border-b border-\(--pos-s-border\) p-3">[\s\S]{0,140}suppliers\.detail\.title/);
  // Aside body: compact padding + a generous bottom pad (pb-4) over the preserved hidden scrollbar.
  assert.match(source, /min-h-0 flex-1 overflow-y-auto scrollbar-hide p-3 pb-4/);
  // Aside content stack + invoice tile are compacted (space-y-3 / p-3).
  assert.match(source, /\{selectedSupplier \? \(\s*<div className="space-y-3">/);
  // Founder 01/11: the invoice-count tile is the neutral kit tile (p-3).
  assert.match(source, /const tileClass = 'rounded-xl border border-\(--pos-s-border\) bg-\(--pos-s-surface-2\) p-3';/);
  assert.match(source, /<div className=\{tileClass\}>\s*<p className=\{`text-sm \$\{subtleClass\}`\}>\{t\('suppliers\.invoices\.title', 'Invoices'\)\}<\/p>/);
  // The old roomy aside spacing that caused the bottom clip is gone (scoped to the aside, so the
  // summary modal's own p-4 / space-y-4 stay untouched).
  assert.doesNotMatch(source, /\{selectedSupplier \? \(\s*<div className="space-y-4">/);
  assert.doesNotMatch(source, /scrollbar-hide p-4">\s*\{selectedSupplier \? \(/);
  assert.doesNotMatch(source, /rounded-xl border p-4 \$\{isDark \? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-50'\}/);
});

// --- supplier-invoice-automation task 8.2 (design §4.13, Process 8; R16.1, R16.3, R16.5) ---
//
// For a supplier the owner opted in, the server records the invoice at reading
// time. The till then shows the *result* and one action — «Άνοιγμα και
// διόρθωση» — which opens this same drawer in **correct** mode: the header,
// one PATCH, and never a second stock door. The switches themselves have no POS
// control at all (Out of Scope 7), and the two office-written payment rows are
// labelled in words rather than by their codes.

test('the recorded invoice opens the import drawer in correct mode and PATCHes the header only', () => {
  const source = suppliersPageSource();

  // The queue hands the stored automation block back for correction.
  assert.match(source, /onCorrect=\{openCaptureCorrection\}/);
  assert.match(source, /const openCaptureCorrection = useCallback\(/);
  assert.match(source, /suppliers\.capture\.automation\.noSaveNeeded/);

  // Correct mode is header-only, and its one write is the PATCH route.
  assert.match(source, /data-testid="capture-correct-header"/);
  assert.match(
    source,
    /posApiPatch<\{ success: boolean; error\?: string \}>\(\s*`pos\/supplier-invoices\/\$\{invoice\.invoiceId\}`/,
  );

  // It never previews, commits, applies stock, or confirms a capture commit.
  const correction = source.match(
    /const saveHeaderCorrection = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/,
  );
  assert.ok(correction, 'saveHeaderCorrection must remain a useCallback with a dependency array');
  assert.doesNotMatch(
    correction[1],
    /(previewImport|commitImport|confirmCaptureCommit|offlineCommitSupplierImport|advanceCapture|poLinkage)/,
    'correcting a recorded header must not preview, commit, queue or move stock',
  );
  // The body carries the header fields and nothing else — no status, no rows.
  assert.doesNotMatch(correction[1], /body\.(status|rows|paidDate|paid_date|supplierId)/);
});

test('no POS control pretends to set the owner switches', () => {
  const source = suppliersPageSource();

  // The two switch columns and their API spelling are never named on a till
  // surface: they are the admin dashboard's, and only the admin's (R16.5).
  assert.doesNotMatch(source, /record_automatically|recordAutomatically/);
  assert.doesNotMatch(source, /update_stock_automatically|updateStockAutomatically/);
});

test('the two office-written payment rows are labelled in words, never by their code', () => {
  const source = suppliersPageSource();

  // Exported, so the answer it gives is pinned by a real test
  // (`src/renderer/pages/__tests__/SuppliersPage.paymentLabels.test.ts`) and
  // not only by the shape of the source read here.
  assert.match(source, /export const getPaymentLabelKey = \(payment: SupplierPayment\): string =>/);
  // Two signals for a reversal: the negative amount a contra row carries — the
  // one the route sends today, and what the mobile till reads — and the word
  // the office stores, for the day `GET /api/pos/supplier-invoices` can select
  // `origin` safely (the column arrives with M4, which production has not
  // taken, and one missing name fails the whole select).
  assert.match(
    source,
    /if \(payment\.origin === 'reversal' \|\| toNumber\(payment\.amount\) < 0\) \{\s*return 'suppliers\.payment\.reversal';/,
  );
  assert.match(
    source,
    /if \(payment\.payment_method === 'unknown'\) \{\s*return 'suppliers\.paymentMethod\.unknown';/,
  );
  // The payment row renders through the key builder, so a method this build
  // does not know can never reach a till as a raw identifier.
  assert.match(source, /\{t\(getPaymentLabelKey\(payment\), payment\.payment_method\)\}/);
  // The method a person can choose is still the shipped five — `unknown` is
  // what the office writes, never an option in the form.
  assert.doesNotMatch(source, /<option value="unknown"/);
});
