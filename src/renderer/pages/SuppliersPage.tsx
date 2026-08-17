import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Ban,
  Building2,
  Camera,
  Check,
  CheckCircle,
  Clock,
  CreditCard,
  FileText,
  Filter,
  Loader2,
  Mail,
  MapPin,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Receipt,
  Save,
  ScanLine,
  Search,
  Settings,
  Trash2,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useModules } from '../contexts/module-context';
import { useShift } from '../contexts/shift-context';
import { useOnBarcodeScan } from '../contexts/barcode-scanner-context';
import { formatCurrency, formatDate } from '../utils/format';
import { posApiFetch, posApiGet, posApiPost } from '../utils/api-helpers';
import { extractSupplierImportFile } from '../utils/supplier-import-parser';
import { renderModalPortal } from '../utils/render-modal-portal';
import PurchaseOrdersTab from '../components/procurement/PurchaseOrdersTab';
import CaptureScanSettingsModal from '../components/suppliers/CaptureScanSettingsModal';
import CapturePagesPanel from '../components/suppliers/CapturePagesPanel';
import CaptureQueuePanel from '../components/suppliers/CaptureQueuePanel';
import { CAPTURE_REVIEW_REQUEST_EVENT } from '../components/CaptureNotificationManager';
import {
  acquireFromScanner,
  advanceCapture,
  confirmCaptureCommit,
  getCaptureDocument,
  listCaptureDocuments,
  loadCaptureSources,
  loadDefaultCaptureSourceId,
  resolveDefaultSource,
  saveCaptureDraft,
  startCaptureDocument,
  type CaptureDocumentRow,
} from '../services/capture-client';
import { offlineCommitSupplierImport } from '../services/offline-mutations';
import {
  loadPurchaseOrderSnapshot,
  type PosPurchaseOrder,
} from '../services/purchase-order-snapshot';
import {
  badgeCount,
  deviceKey,
  doubleCheckCount,
  mapRecognitionToDraft,
  needsDoubleCheck,
  suggestPurchaseOrders,
} from '../utils/capture-review';
import type { CaptureSourceConfig, ConfidenceTier } from '../types/supplier-capture';

interface Supplier {
  id: string;
  supplier_code?: string;
  name: string;
  contact_name?: string;
  contact_person?: string;
  email?: string;
  phone?: string;
  address?: string;
  category?: string;
  payment_terms?: string;
  is_active: boolean;
  total_orders?: number;
  total_spent?: number;
  last_order_date?: string;
}

type InvoiceStatus = 'unpaid' | 'paid' | 'overdue' | 'cancelled';
type PaymentStatus = InvoiceStatus | 'partial';
type PaymentMethod = 'cash' | 'bank_transfer' | 'check' | 'credit_card' | 'other';

interface SupplierPayment {
  id: string;
  amount: number | string;
  payment_date: string;
  payment_method: PaymentMethod | string;
  payment_number?: string | null;
  reference_number?: string | null;
  notes?: string | null;
}

interface Invoice {
  id: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date?: string | null;
  amount: number | string;
  status: InvoiceStatus;
  due_date: string;
  paid_date?: string | null;
  notes?: string | null;
  created_at: string;
  suppliers?: { id?: string; name?: string } | null;
  supplier_payments?: SupplierPayment[];
  paid_amount?: number | string;
  remaining_amount?: number | string;
  payment_status?: PaymentStatus;
}

interface ImportRawRow {
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

type ImportRowStatus = 'create' | 'update' | 'skip' | 'error';

interface SupplierImportRow extends ImportRawRow {
  rowNumber: number;
  status: ImportRowStatus;
  categoryPath: string[];
  existingInventoryItemId: string | null;
  errors: string[];
  warnings: string[];
}

interface SupplierImportDraft {
  organizationId: string;
  branchId: string;
  supplier: {
    id: string | null;
    name: string;
    action: 'create' | 'existing';
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    notes: string | null;
  };
  invoice: {
    invoiceNumber: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    amount: number | null;
    status: InvoiceStatus;
    notes: string | null;
  } | null;
  rows: SupplierImportRow[];
  missingCategories: Array<{ name: string; parentName: string | null; parentId?: string | null }>;
}

type BarcodeDetectorLike = new (options?: { formats?: string[] }) => {
  detect: (source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};

const emptyImportRow = (barcode = ''): ImportRawRow => ({
  name: barcode ? `Item ${barcode}` : '',
  sku: '',
  barcode,
  quantity: 1,
  unit: 'pcs',
  cost: 0,
  minStockLevel: 0,
  category: '',
  subcategory: '',
  notes: '',
});

function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

const normalizeCurrencyCode = (value: unknown): string => {
  if (typeof value !== 'string') return 'EUR';
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return 'EUR';

  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(0);
    return currency;
  } catch {
    return 'EUR';
  }
};

const getInvoiceAmount = (invoice: Invoice): number => toNumber(invoice.amount);

const getInvoicePaidAmount = (invoice: Invoice): number => {
  if (invoice.paid_amount !== undefined && invoice.paid_amount !== null) {
    const explicitPaidAmount = toNumber(invoice.paid_amount);
    if (invoice.status === 'paid' && explicitPaidAmount <= 0.01 && (!invoice.supplier_payments || invoice.supplier_payments.length === 0)) {
      return getInvoiceAmount(invoice);
    }
    return explicitPaidAmount;
  }
  if (invoice.status === 'paid' && (!invoice.supplier_payments || invoice.supplier_payments.length === 0)) {
    return getInvoiceAmount(invoice);
  }
  return (invoice.supplier_payments || []).reduce((sum, payment) => sum + toNumber(payment.amount), 0);
};

const getInvoiceRemainingAmount = (invoice: Invoice): number => {
  if (invoice.status === 'paid' && (!invoice.supplier_payments || invoice.supplier_payments.length === 0)) {
    return 0;
  }
  if (invoice.remaining_amount !== undefined && invoice.remaining_amount !== null) {
    return Math.max(toNumber(invoice.remaining_amount), 0);
  }
  return Math.max(getInvoiceAmount(invoice) - getInvoicePaidAmount(invoice), 0);
};

const getInvoicePaymentStatus = (invoice: Invoice): PaymentStatus => {
  const paidAmount = getInvoicePaidAmount(invoice);
  const remainingAmount = getInvoiceRemainingAmount(invoice);

  if (invoice.payment_status === 'partial' || (paidAmount > 0.01 && remainingAmount > 0.01 && invoice.status !== 'cancelled')) {
    return 'partial';
  }
  if (invoice.status === 'paid' || remainingAmount <= 0.01) {
    return 'paid';
  }
  return invoice.status;
};

const getInvoiceDisplayDate = (invoice: Invoice): string =>
  invoice.invoice_date || invoice.created_at || invoice.due_date;

const getDateInputValue = () => new Date().toISOString().slice(0, 10);

function getSupplierImportErrorMessage(
  t: TFunction,
  error: unknown,
  fallbackKey: 'previewFailed' | 'saveFailed'
): string {
  const fallback = fallbackKey === 'previewFailed'
    ? t('suppliers.import.previewFailed', 'Could not preview import')
    : t('suppliers.import.saveFailed', 'Failed to save supplier items');
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  const lower = raw.toLowerCase();

  if (
    lower.includes('admin dashboard endpoint not found') ||
    lower.includes('http 404') ||
    lower.includes('page not found')
  ) {
    return t(
      'suppliers.import.endpointUnavailable',
      'Supplier import API is not available on the connected admin dashboard. Restart or update the admin dashboard, then try Preview again.'
    );
  }

  if (lower.includes('<!doctype html') || lower.includes('<html') || lower.includes('__next_data__')) {
    return t(
      'suppliers.import.adminHtmlError',
      'Admin dashboard returned a page instead of an API response. Check the admin URL and try again.'
    );
  }

  return raw.length > 500 ? `${raw.slice(0, 240).trim()}...` : raw;
}

/**
 * Pull the typed outcome code out of a rejected commit's error text.
 *
 * The code is what the queue stores and later renders as one plain sentence;
 * the raw server text never becomes the primary thing a user reads (R12.1).
 * An unrecognised rejection still gets a code — `commit_rejected` — so the
 * document is never left with a blank reason.
 */
function extractCaptureReason(message: string): string {
  const codes = [
    'MODULE_REQUIRED',
    'PO_INVOICE_ALREADY_APPLIED',
    'PO_STATE_CONFLICT',
    'CAPTURE_TOO_LARGE',
    'CAPTURE_TOO_MANY_PAGES',
    'CAPTURE_UNREADABLE',
  ];
  return codes.find(code => message.includes(code)) || 'commit_rejected';
}

const SuppliersPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { isModuleEnabled } = useModules();
  const { staff } = useShift();
  const isDark = resolvedTheme === 'dark';
  // Belt-and-braces module gate: the suppliers view is already guarded by the
  // layout, and this keeps every capture entry point off the page if it is
  // ever composed somewhere that is not. [R14.1]
  const captureEnabled = isModuleEnabled('suppliers');
  const captureStaffId = (staff?.databaseStaffId as string | undefined) ?? null;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'suppliers' | 'invoices' | 'orders'>('suppliers');
  const [searchTerm, setSearchTerm] = useState('');
  const [supplierFilter, setSupplierFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [invoiceFilter, setInvoiceFilter] = useState<'all' | PaymentStatus>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [supplierEmail, setSupplierEmail] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [supplierNotes, setSupplierNotes] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [draftRows, setDraftRows] = useState<ImportRawRow[]>([emptyImportRow()]);
  const [manualBarcode, setManualBarcode] = useState('');
  const [importDraft, setImportDraft] = useState<SupplierImportDraft | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [supplierSummaryId, setSupplierSummaryId] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentDate, setPaymentDate] = useState(getDateInputValue());
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');

  // ---- Invoice capture (spec .claude/specs/invoice-scan-capture, D-UI) ---- //
  const [captureSources, setCaptureSources] = useState<CaptureSourceConfig[]>([]);
  const [captureDefaultId, setCaptureDefaultId] = useState<string | null>(null);
  const [scanSettingsOpen, setScanSettingsOpen] = useState(false);
  const [captureQueueOpen, setCaptureQueueOpen] = useState(false);
  const [capturePending, setCapturePending] = useState(0);
  const [activeCapture, setActiveCapture] = useState<{
    captureId: string;
    deviceId: string | null;
    sourceName: string | null;
  } | null>(null);
  const [scanStarting, setScanStarting] = useState(false);
  /** The document currently open in the import drawer, if the drawer came from a scan. */
  const [reviewCapture, setReviewCapture] = useState<CaptureDocumentRow | null>(null);
  const [reviewConfidence, setReviewConfidence] = useState<ConfidenceTier[]>([]);
  const [reviewQuality, setReviewQuality] = useState<'good' | 'poor'>('good');
  const [reviewPoOptions, setReviewPoOptions] = useState<PosPurchaseOrder[]>([]);
  /** null is the default and the decline (R9.2) — linkage is always opt-in. */
  const [reviewPoId, setReviewPoId] = useState<string | null>(null);

  // Ref + stable title id so the portaled import overlay can declare labelled dialog
  // semantics and join the topmost-[role="dialog"] Escape stack used across the POS.
  const importDialogRef = useRef<HTMLDivElement>(null);
  const importTitleId = useId();
  const summaryDialogRef = useRef<HTMLDivElement>(null);
  const summaryTitleId = useId();
  const invoiceDialogRef = useRef<HTMLDivElement>(null);
  const invoiceTitleId = useId();
  const captureQueueDialogRef = useRef<HTMLDivElement>(null);
  const captureQueueTitleId = useId();

  const panelClass = isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-gray-200 text-gray-950';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const fieldClass = isDark
    ? 'bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500'
    : 'bg-white border-gray-200 text-gray-950 placeholder:text-gray-400';
  const iconButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100';
  const formatMoney = useCallback((amount: number) => formatCurrency(amount, currencyCode, i18n.language), [currencyCode, i18n.language]);

  // Close-only path for the import overlay. The X button and Escape share it; it only
  // flips importOpen and never calls previewImport/commitImport/handleFileImport/
  // scanImageBarcode/appendBarcodeRow or any row mutation, so dismissing the overlay
  // can never trigger a preview, save, file import, scan, barcode add, or delete.
  const closeImport = useCallback(() => {
    setImportOpen(false);
    // Leaving review keeps every edit: the draft is written back to the
    // capture row, so returning later — or after a restart — resumes exactly
    // where the user left off. Failing to persist must not trap them in the
    // drawer, so this is fire-and-forget. [R8.6, R17.3]
    if (reviewCapture) {
      void saveCaptureDraft(reviewCapture.captureId, {
        source: 'review',
        rows: draftRows,
        supplier: {
          name: supplierName,
          email: supplierEmail,
          phone: supplierPhone,
          notes: supplierNotes,
        },
        invoice: { invoiceNumber, invoiceDate },
        poLinkage: reviewPoId ? { purchaseOrderId: reviewPoId } : null,
      }).catch((error) => console.warn('[capture] could not save review edits:', error));
    }
  }, [
    draftRows,
    invoiceDate,
    invoiceNumber,
    reviewCapture,
    reviewPoId,
    supplierEmail,
    supplierName,
    supplierNotes,
    supplierPhone,
  ]);

  // Escape closes the import overlay, mirroring the app-level POS modals. Only the
  // frontmost [role="dialog"] reacts, so a future nested dialog opened above it closes
  // first and this overlay is never dismissed out of order. Gated on importOpen so the
  // listener is only live while the overlay is showing.
  useEffect(() => {
    if (!importOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== importDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeImport();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [importOpen, closeImport]);

  // Close-only paths for the supplier summary + invoice details overlays. Escape and the
  // X/backdrop share them; they only clear the open id and never trigger payment/status/save.
  const closeSupplierSummary = useCallback(() => {
    setSupplierSummaryId(null);
  }, []);

  const closeInvoiceDetails = useCallback(() => {
    setSelectedInvoiceId(null);
  }, []);

  // Escape closes the supplier summary overlay, mirroring the import drawer. Only the
  // frontmost [role="dialog"] reacts, so a dialog opened above it closes first.
  useEffect(() => {
    if (!supplierSummaryId) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== summaryDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeSupplierSummary();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [supplierSummaryId, closeSupplierSummary]);

  // Escape closes the invoice details overlay, same topmost-dialog gate / close-only path.
  useEffect(() => {
    if (!selectedInvoiceId) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== invoiceDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeInvoiceDetails();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [selectedInvoiceId, closeInvoiceDetails]);

  // Escape closes the capture queue overlay, same topmost-dialog gate and the
  // same close-only path — dismissing it never advances or discards a document.
  useEffect(() => {
    if (!captureQueueOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== captureQueueDialogRef.current) {
        return;
      }
      event.preventDefault();
      setCaptureQueueOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [captureQueueOpen]);

  const supplierById = useMemo(() => {
    const map = new Map<string, Supplier>();
    suppliers.forEach(supplier => map.set(supplier.id, supplier));
    return map;
  }, [suppliers]);

  const selectedInvoice = useMemo(
    () => invoices.find(invoice => invoice.id === selectedInvoiceId) || null,
    [invoices, selectedInvoiceId]
  );

  const supplierSummary = useMemo(() => {
    if (!supplierSummaryId) return null;
    const supplier = supplierById.get(supplierSummaryId);
    if (!supplier) return null;

    const supplierInvoices = invoices.filter(invoice => invoice.supplier_id === supplier.id);
    const paidInvoices = supplierInvoices.filter(invoice => getInvoicePaymentStatus(invoice) === 'paid');
    const unpaidInvoices = supplierInvoices.filter(invoice => {
      const status = getInvoicePaymentStatus(invoice);
      return status !== 'paid' && status !== 'cancelled';
    });
    const totalSpent = supplierInvoices.reduce((sum, invoice) => sum + getInvoiceAmount(invoice), 0);
    const paidAmount = supplierInvoices.reduce((sum, invoice) => sum + getInvoicePaidAmount(invoice), 0);
    const unpaidAmount = supplierInvoices.reduce((sum, invoice) => sum + getInvoiceRemainingAmount(invoice), 0);

    return {
      supplier,
      invoices: supplierInvoices,
      paidInvoices: paidInvoices.length,
      unpaidInvoices: unpaidInvoices.length,
      totalSpent,
      paidAmount,
      unpaidAmount,
    };
  }, [invoices, supplierById, supplierSummaryId]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [supplierResult, invoiceResult] = await Promise.all([
        posApiGet<{ suppliers?: Supplier[] }>('pos/suppliers?active=true'),
        posApiGet<{ invoices?: Invoice[]; currency?: string }>('pos/supplier-invoices'),
      ]);

      if (!supplierResult.success) throw new Error(supplierResult.error || 'Failed to load suppliers');
      if (!invoiceResult.success) throw new Error(invoiceResult.error || 'Failed to load supplier invoices');

      const nextSuppliers = supplierResult.data?.suppliers || [];
      setSuppliers(nextSuppliers);
      setInvoices(invoiceResult.data?.invoices || []);
      setCurrencyCode(normalizeCurrencyCode(invoiceResult.data?.currency));
      if (!selectedSupplierId && nextSuppliers.length > 0) {
        setSelectedSupplierId(nextSuppliers[0].id);
      }
    } catch (fetchError) {
      console.error('Failed to fetch suppliers:', fetchError);
      const message = t('suppliers.errors.loadFailed', 'Failed to load suppliers');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [selectedSupplierId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const appendBarcodeRow = useCallback((barcode: string) => {
    const cleanBarcode = barcode.trim();
    if (!cleanBarcode) return;
    setDraftRows(rows => [emptyImportRow(cleanBarcode), ...rows]);
    setManualBarcode('');
    setImportOpen(true);
    setImportDraft(null);
    setImportError(null);
    toast.success(t('suppliers.import.scanAdded', 'Barcode added to review'));
  }, [t]);

  useOnBarcodeScan((barcode) => {
    if (importOpen) {
      appendBarcodeRow(barcode);
    }
  }, [importOpen, appendBarcodeRow]);

  const filteredSuppliers = useMemo(() => {
    const needle = normalizeText(searchTerm);
    return suppliers.filter(supplier => {
      const matchesSearch =
        normalizeText(supplier.name).includes(needle) ||
        normalizeText(supplier.contact_name || supplier.contact_person).includes(needle) ||
        normalizeText(supplier.email).includes(needle) ||
        normalizeText(supplier.phone).includes(needle);
      const matchesFilter =
        supplierFilter === 'all' ||
        (supplierFilter === 'active' && supplier.is_active) ||
        (supplierFilter === 'inactive' && !supplier.is_active);
      return matchesSearch && matchesFilter;
    });
  }, [searchTerm, supplierFilter, suppliers]);

  // The detail panel must reflect the visible list. On the Suppliers tab, keep the
  // current selection only while it is still in filteredSuppliers; otherwise fall back
  // to the first visible supplier (or null -> empty detail state when the search has
  // no results), so a no-result search never leaves stale supplier details on screen.
  // On the Invoices tab the panel follows the supplier of the clicked invoice, so it
  // derives from the full supplier list regardless of the supplier search filter.
  const selectedSupplier = useMemo(() => {
    if (activeTab === 'suppliers') {
      return (
        filteredSuppliers.find(supplier => supplier.id === selectedSupplierId) ||
        filteredSuppliers[0] ||
        null
      );
    }
    return suppliers.find(supplier => supplier.id === selectedSupplierId) || suppliers[0] || null;
  }, [activeTab, filteredSuppliers, selectedSupplierId, suppliers]);

  const filteredInvoices = useMemo(() => {
    const needle = normalizeText(searchTerm);
    return invoices.filter(invoice => {
      const supplierName = invoice.suppliers?.name || supplierById.get(invoice.supplier_id)?.name || '';
      const paymentStatus = getInvoicePaymentStatus(invoice);
      const matchesSearch =
        normalizeText(invoice.invoice_number).includes(needle) ||
        normalizeText(supplierName).includes(needle);
      const matchesFilter = invoiceFilter === 'all' || paymentStatus === invoiceFilter;
      return matchesSearch && matchesFilter;
    });
  }, [invoiceFilter, invoices, searchTerm, supplierById]);

  const stats = useMemo(() => {
    const openInvoices = invoices.filter(invoice => {
      const status = getInvoicePaymentStatus(invoice);
      return status === 'unpaid' || status === 'overdue' || status === 'partial';
    });
    return {
      totalSuppliers: suppliers.length,
      activeSuppliers: suppliers.filter(supplier => supplier.is_active).length,
      unpaidInvoices: openInvoices.length,
      overdueInvoices: invoices.filter(invoice => invoice.status === 'overdue').length,
      totalOwed: openInvoices.reduce((sum, invoice) => sum + getInvoiceRemainingAmount(invoice), 0),
    };
  }, [invoices, suppliers]);

  const draftRowCount = useMemo(
    () => draftRows.filter(row => row.name.trim() || row.barcode?.trim() || row.sku?.trim()).length,
    [draftRows]
  );

  const draftInvoiceAmount = useMemo(
    () => draftRows.reduce((sum, row) => sum + (toNumber(row.quantity) * toNumber(row.cost)), 0),
    [draftRows]
  );

  const updateDraftRow = (index: number, patch: Partial<ImportRawRow>) => {
    setDraftRows(rows => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    setImportDraft(null);
    setImportError(null);
  };

  const updateReviewRow = (index: number, patch: Partial<SupplierImportRow>) => {
    setImportDraft(draft => {
      if (!draft) return draft;
      return {
        ...draft,
        rows: draft.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
      };
    });
  };

  const removeDraftRow = (index: number) => {
    setDraftRows(rows => rows.filter((_, rowIndex) => rowIndex !== index));
    setImportDraft(null);
    setImportError(null);
  };

  const handleFileImport = async (file: File) => {
    setFileNotice(null);
    setImportError(null);
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    let parsedRows: ImportRawRow[];

    try {
      const parsedFile = await extractSupplierImportFile(file);
      parsedRows = parsedFile.rows;
      if (parsedFile.supplier) {
        setSupplierName(current => current.trim() || parsedFile.supplier?.name || '');
        setSupplierEmail(current => current.trim() || parsedFile.supplier?.email || '');
        setSupplierPhone(current => current.trim() || parsedFile.supplier?.phone || '');
        setSupplierNotes(current => current.trim() || parsedFile.supplier?.notes || '');
        setInvoiceNumber(current => current.trim() || parsedFile.supplier?.invoiceNumber || '');
        setInvoiceDate(current => current.trim() || parsedFile.supplier?.invoiceDate || '');
      }
    } catch (importError) {
      console.error('Supplier file import failed:', importError);
      const message = t('suppliers.import.fileReadFailed', 'Could not read that file. Try another file or add rows manually.');
      setFileNotice(message);
      toast.error(message);
      return;
    }

    if (parsedRows.length === 0) {
      setFileNotice(t('suppliers.import.fileNeedsReview', 'No table rows were detected. Add or correct rows manually before preview.'));
      setDraftRows(rows => [emptyImportRow(), ...rows]);
      return;
    }

    if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].includes(extension)) {
      setFileNotice(t('suppliers.import.importedRows', {
        count: parsedRows.length,
        defaultValue: '{{count}} rows imported. Scroll the draft list to review every item before saving.',
      }));
    }

    setDraftRows(rows => [...parsedRows, ...rows.filter(row => row.name || row.barcode || row.sku)]);
    setImportDraft(null);
    setImportError(null);
  };

  const handleCameraFile = async (file: File) => {
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorLike }).BarcodeDetector;
    if (!Detector) {
      toast.error(t('suppliers.import.cameraUnavailable', 'Camera barcode detection is not available on this device'));
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
      const matches = await detector.detect(bitmap);
      const barcode = matches.find(match => match.rawValue)?.rawValue;
      bitmap.close();
      if (!barcode) {
        toast.error(t('suppliers.import.noBarcodeFound', 'No barcode was found in the image'));
        return;
      }
      appendBarcodeRow(barcode);
    } catch (cameraError) {
      console.error('Camera barcode detection failed:', cameraError);
      toast.error(t('suppliers.import.cameraFailed', 'Unable to scan that image'));
    }
  };

  const previewImport = async () => {
    const rows = draftRows.filter(row => row.name.trim() || row.barcode?.trim() || row.sku?.trim());
    if (!supplierName.trim()) {
      toast.error(t('suppliers.import.supplierRequired', 'Supplier name is required'));
      return;
    }
    if (rows.length === 0) {
      toast.error(t('suppliers.import.rowsRequired', 'Add at least one item row'));
      return;
    }

    setSaving(true);
    setImportError(null);
    try {
      const result = await posApiPost<{ success: boolean; draft?: SupplierImportDraft; error?: string }>('pos/suppliers/import/preview', {
        supplier: {
          name: supplierName.trim(),
          email: supplierEmail.trim() || null,
          phone: supplierPhone.trim() || null,
          notes: supplierNotes.trim() || null,
        },
        invoice: {
          invoiceNumber: invoiceNumber.trim() || null,
          invoiceDate: invoiceDate.trim() || null,
          amount: draftInvoiceAmount,
          status: 'unpaid',
          notes: supplierNotes.trim() || null,
        },
        rows,
      });
      if (!result.success || !result.data?.draft) {
        throw new Error(result.error || result.data?.error || 'Preview failed');
      }
      setImportDraft(result.data.draft);
      toast.success(t('suppliers.import.previewReady', 'Import review is ready'));
    } catch (previewError) {
      const message = getSupplierImportErrorMessage(t, previewError, 'previewFailed');
      setImportError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const resetImportForm = useCallback(() => {
    setImportOpen(false);
    setSupplierName('');
    setSupplierEmail('');
    setSupplierPhone('');
    setSupplierNotes('');
    setInvoiceNumber('');
    setInvoiceDate('');
    setDraftRows([emptyImportRow()]);
    setImportDraft(null);
    setImportError(null);
    setReviewCapture(null);
    setReviewConfidence([]);
    setReviewQuality('good');
    setReviewPoOptions([]);
    setReviewPoId(null);
  }, []);

  // ---- Invoice capture wiring ------------------------------------------ //

  const refreshCaptureSources = useCallback(async () => {
    const [sources, defaultId] = await Promise.all([
      loadCaptureSources(),
      loadDefaultCaptureSourceId(),
    ]);
    setCaptureSources(current =>
      JSON.stringify(current) === JSON.stringify(sources) ? current : sources
    );
    setCaptureDefaultId(current => (current === defaultId ? current : defaultId));
  }, []);

  /**
   * Recount the waiting/needs-attention badge (R11.5).
   *
   * Writes state only on a real change: the worker re-announces statuses it
   * has already reported, and a header badge that re-renders on every
   * announcement is a header badge that flickers.
   */
  const refreshCaptureQueue = useCallback(async () => {
    try {
      const documents = await listCaptureDocuments();
      const next = badgeCount(documents);
      setCapturePending(current => (current === next ? current : next));
    } catch {
      // The queue is durable in SQLite; failing to *count* it is cosmetic.
    }
  }, []);

  useEffect(() => {
    if (!captureEnabled) return;
    void refreshCaptureSources();
    void refreshCaptureQueue();
  }, [captureEnabled, refreshCaptureQueue, refreshCaptureSources]);

  /**
   * Open the existing import drawer, prefilled from a captured document.
   *
   * Capture deliberately has no review screen of its own: everything a scanned
   * invoice needs already exists in this drawer, so it is poured in and then
   * travels the ordinary preview → commit path. Saved review edits win over
   * the raw recognition, which is what makes leaving and coming back — or the
   * text-layer fast path — behave the way the user expects. [R8.6, D1]
   */
  const openCaptureReview = useCallback(
    (document: CaptureDocumentRow) => {
      const prefill = mapRecognitionToDraft(document.recognition);
      const draft = document.draft;
      const draftRowsFromDraft = Array.isArray(draft?.rows)
        ? (draft?.rows as ImportRawRow[])
        : null;

      const rows = draftRowsFromDraft ?? prefill.rows;
      const supplier = (draft?.supplier as Record<string, string> | undefined) ?? prefill.supplier;
      const invoice = (draft?.invoice as Record<string, string> | undefined) ?? prefill.invoice;

      setSupplierName(supplier.name || '');
      setSupplierEmail(supplier.email || '');
      setSupplierPhone(supplier.phone || '');
      setSupplierNotes(supplier.notes || '');
      setInvoiceNumber(invoice.invoiceNumber || '');
      setInvoiceDate(invoice.invoiceDate || '');
      // Every parsed row is kept — the client never drops one. An empty
      // recognition still opens with one blank row so manual entry works from
      // the same screen. [R6.4, R7.5]
      setDraftRows(rows.length > 0 ? rows : [emptyImportRow()]);
      setImportDraft(null);
      setImportError(null);
      setFileNotice(null);

      setReviewCapture(document);
      setReviewConfidence(prefill.rowConfidence);
      setReviewQuality(prefill.quality);

      const openOrders = suggestPurchaseOrders(
        loadPurchaseOrderSnapshot().purchaseOrders,
        supplier.name || ''
      );
      setReviewPoOptions(openOrders);
      // Declining is the default: the offer is never pre-accepted. [R9.2]
      setReviewPoId(null);

      setCaptureQueueOpen(false);
      setImportOpen(true);
    },
    []
  );

  const openCaptureReviewById = useCallback(
    async (captureId: string) => {
      const { document } = await getCaptureDocument(captureId);
      if (document) openCaptureReview(document);
    },
    [openCaptureReview]
  );

  // "Check invoice" on a capture toast lands on that document, not just on
  // this page. [R3.6, R11.9]
  useEffect(() => {
    if (!captureEnabled) return;
    const handleReviewRequest = (event: Event) => {
      const captureId = (event as CustomEvent<{ captureId?: string }>).detail?.captureId;
      if (captureId) void openCaptureReviewById(captureId);
    };
    window.addEventListener(CAPTURE_REVIEW_REQUEST_EVENT, handleReviewRequest as EventListener);
    return () =>
      window.removeEventListener(CAPTURE_REVIEW_REQUEST_EVENT, handleReviewRequest as EventListener);
  }, [captureEnabled, openCaptureReviewById]);

  /**
   * Start a scan from this terminal's default source.
   *
   * One click from the suppliers header to a scanner spinning up: no source
   * picker, no confirmation, no interstitial (R15.1). With nothing configured
   * the button offers setup instead of raising an error (R1.3).
   */
  const startScan = useCallback(async () => {
    if (captureSources.length === 0) {
      setScanSettingsOpen(true);
      return;
    }

    const source = resolveDefaultSource(captureSources, captureDefaultId);
    if (!source) {
      setScanSettingsOpen(true);
      return;
    }

    // A watched folder is scanned from the machine, not from here. Saying so
    // is the whole "zero file browsing" experience: press Scan over there, the
    // invoice turns up in the queue. [R15.4]
    if (source.kind === 'watched_folder') {
      toast.success(
        t(
          'suppliers.capture.scan.pressScanOnMachine',
          'Press Scan on your machine. The invoice will show up here on its own.'
        )
      );
      setCaptureQueueOpen(true);
      return;
    }

    setScanStarting(true);
    try {
      const captureId = await startCaptureDocument({
        sourceKind: source.kind,
        sourceName: source.name,
        staffId: captureStaffId,
      });
      // The panel opens before the scanner answers, so the user sees something
      // happen well inside a second and watches the pages land. [R17.1]
      setActiveCapture({
        captureId,
        deviceId: source.deviceId ?? null,
        sourceName: source.name,
      });

      if (source.deviceId) {
        const outcome = await acquireFromScanner({ captureId, deviceId: source.deviceId });
        if (!outcome.ok) {
          toast.error(
            t(
              deviceKey(outcome.code),
              t(
                'suppliers.capture.device.device_error',
                'The scanner did not answer. Check it is on and connected.'
              )
            )
          );
        } else if (outcome.stoppedEarly) {
          // This is the FIRST run of the stack, and it happens here rather than
          // in the pages panel — so the panel's own notice never gets the
          // chance to speak for it. Without this, a feeder cut short by a busy
          // device opens a panel showing pages, saying nothing at all, over an
          // invoice that is not all there. [R12.1]
          toast.error(
            t(
              'suppliers.capture.pages.stoppedEarly',
              'The scanner stopped before the feeder was empty. If any pages are still in it, add them before you finish.'
            )
          );
        }
      }
      await refreshCaptureQueue();
    } catch (scanError) {
      console.error('[capture] could not start a scan:', scanError);
      toast.error(
        t('suppliers.capture.scan.startFailed', 'Could not start scanning. Try again.')
      );
    } finally {
      setScanStarting(false);
    }
  }, [captureDefaultId, captureSources, captureStaffId, refreshCaptureQueue, t]);

  /** Finish the in-flight document and hand it to the recognition queue. */
  const finishCapture = useCallback(
    async (captureId: string) => {
      const outcome = await advanceCapture({ captureId, status: 'waiting' });
      if (!outcome.success && outcome.code === 'no_pages') {
        toast.error(
          t('suppliers.capture.pages.needAPage', 'Add at least one page before finishing.')
        );
        return false;
      }
      setActiveCapture(null);
      await refreshCaptureQueue();
      toast.success(
        t('suppliers.capture.scan.reading', 'Reading your invoice… you can carry on working.')
      );
      return true;
    },
    [refreshCaptureQueue, t]
  );

  const finishCaptureAndStartAnother = useCallback(
    async (captureId: string) => {
      if (await finishCapture(captureId)) {
        await startScan();
      }
    },
    [finishCapture, startScan]
  );

  /**
   * "Scan again" from a poor result: the current document is thrown away and a
   * fresh one started for the same invoice. Explicit, confirmed by the button
   * press itself, and the only thing lost is a scan the user just told us was
   * no good. [R7.3]
   */
  const rescanCurrentInvoice = useCallback(async () => {
    const document = reviewCapture;
    resetImportForm();
    if (document) {
      await advanceCapture({
        captureId: document.captureId,
        status: 'discarded',
        staffId: captureStaffId,
      });
      await refreshCaptureQueue();
    }
    await startScan();
  }, [captureStaffId, refreshCaptureQueue, resetImportForm, reviewCapture, startScan]);

  const commitImport = async () => {
    if (!importDraft) return;
    setSaving(true);
    setImportError(null);

    // A scanned invoice carries its provenance and (optionally) its purchase
    // order alongside the draft. Both blocks are absent for a hand-built
    // import, which is what keeps this one code path serving both. [R9.1, R13.1]
    const capture = reviewCapture
      ? {
          captureId: reviewCapture.captureId,
          sourceKind: reviewCapture.sourceKind,
          sourceName: reviewCapture.sourceName ?? undefined,
          capturedAt: reviewCapture.capturedAt,
          capturedByStaffId: reviewCapture.staffId ?? undefined,
          committedByStaffId: captureStaffId ?? undefined,
          storageKeys: reviewCapture.storageKeys.filter(
            (key): key is string => typeof key === 'string' && key.length > 0,
          ),
        }
      : null;
    const poLinkage = reviewPoId
      ? { purchaseOrderId: reviewPoId, mode: 'record_delivery' as const }
      : null;

    try {
      if (capture) {
        await advanceCapture({ captureId: capture.captureId, status: 'committing' });
      }

      const result = await posApiFetch<{
        success: boolean;
        result?: { createdInventoryCount: number; updatedInventoryCount: number };
        error?: string;
      }>('pos/suppliers/import/commit', {
        method: 'POST',
        body: JSON.stringify({
          draft: importDraft,
          ...(capture ? { capture } : {}),
          ...(poLinkage ? { poLinkage } : {}),
        }),
      });

      if (!result.success || !result.data?.result) {
        const message = result.error || result.data?.error || 'Commit failed';

        // No HTTP status means the request never reached the server. The
        // reviewed invoice is queued with the SAME capture id as its
        // idempotency key, so if it did land after all the server collapses
        // the replay onto one invoice. [R9.5, R11.6]
        if (capture && typeof result.status !== 'number') {
          await offlineCommitSupplierImport({
            draft: importDraft as unknown as Record<string, unknown>,
            capture: {
              captureId: capture.captureId,
              sourceKind: capture.sourceKind,
              capturedAt: capture.capturedAt,
              sourceName: capture.sourceName,
              capturedByStaffId: capture.capturedByStaffId,
              committedByStaffId: capture.committedByStaffId,
              storageKeys: capture.storageKeys,
            },
            ...(poLinkage ? { poLinkage } : {}),
            staffId: captureStaffId ?? '',
          });
          toast.success(
            t(
              'suppliers.capture.review.queued',
              'Saved here. It will reach the office as soon as you are back online.',
            ),
          );
          resetImportForm();
          await refreshCaptureQueue();
          return;
        }

        // The server answered and refused. The document keeps its edits and
        // becomes actionable with a stated reason. [R9.6, R11.6]
        if (capture) {
          await advanceCapture({
            captureId: capture.captureId,
            status: 'needs_attention',
            reason: extractCaptureReason(message),
            staffId: captureStaffId,
          });
          await refreshCaptureQueue();
        }
        throw new Error(message);
      }

      if (capture) {
        await confirmCaptureCommit({
          captureId: capture.captureId,
          result: result.data as unknown as Record<string, unknown>,
          staffId: captureStaffId,
        });
        await refreshCaptureQueue();
      }

      toast.success(
        capture
          ? t('suppliers.capture.review.saved', 'Invoice saved.')
          : t('suppliers.import.saved', 'Supplier items saved to inventory'),
      );
      resetImportForm();
      await fetchData();
    } catch (commitError) {
      const message = getSupplierImportErrorMessage(t, commitError, 'saveFailed');
      setImportError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const markInvoiceStatus = async (invoiceId: string, status: 'paid' | 'unpaid') => {
    setSaving(true);
    try {
      const result = await posApiPost<{ success: boolean; invoice?: Invoice; error?: string }>(
        `pos/supplier-invoices/${invoiceId}/mark-${status}`,
        {}
      );
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || 'Status update failed');
      }
      toast.success(status === 'paid'
        ? t('suppliers.invoices.markedPaid', 'Invoice marked paid')
        : t('suppliers.invoices.markedUnpaid', 'Invoice marked unpaid'));
      await fetchData();
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : t('suppliers.invoices.statusFailed', 'Could not update invoice status'));
    } finally {
      setSaving(false);
    }
  };

  const openInvoiceDetails = (invoice: Invoice, options?: { partial?: boolean }) => {
    const remaining = getInvoiceRemainingAmount(invoice);
    setSelectedSupplierId(invoice.supplier_id);
    setSelectedInvoiceId(invoice.id);
    setPaymentAmount(options?.partial ? '' : (remaining > 0.01 ? remaining.toFixed(2) : ''));
    setPaymentMethod('cash');
    setPaymentDate(getDateInputValue());
    setPaymentReference('');
    setPaymentNotes('');
  };

  const recordInvoicePayment = async (amountOverride?: number) => {
    if (!selectedInvoice) return;

    const amount = amountOverride ?? toNumber(paymentAmount);
    const remaining = getInvoiceRemainingAmount(selectedInvoice);
    if (amount <= 0) {
      toast.error(t('suppliers.invoices.paymentAmountRequired', 'Enter a payment amount'));
      return;
    }
    if (amount > remaining + 0.01) {
      toast.error(t('suppliers.invoices.paymentAmountTooHigh', 'Payment is higher than the remaining amount'));
      return;
    }

    setSaving(true);
    try {
      const result = await posApiPost<{ success: boolean; invoice?: Invoice; error?: string }>(
        `pos/supplier-invoices/${selectedInvoice.id}/payments`,
        {
          amount,
          payment_date: paymentDate,
          payment_method: paymentMethod,
          reference_number: paymentReference.trim() || null,
          notes: paymentNotes.trim() || null,
        }
      );
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || 'Payment failed');
      }

      toast.success(t('suppliers.invoices.paymentRecorded', 'Payment recorded'));
      setPaymentAmount('');
      setPaymentReference('');
      setPaymentNotes('');
      await fetchData();
    } catch (paymentError) {
      toast.error(paymentError instanceof Error ? paymentError.message : t('suppliers.invoices.paymentFailed', 'Could not record payment'));
    } finally {
      setSaving(false);
    }
  };

  const getInvoiceStatusClass = (status: PaymentStatus) => {
    switch (status) {
      case 'paid':
        return isDark ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'partial':
        return isDark ? 'bg-amber-500/15 text-amber-200 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200';
      case 'overdue':
        return isDark ? 'bg-red-500/15 text-red-300 border-red-500/30' : 'bg-red-50 text-red-700 border-red-200';
      case 'cancelled':
        return isDark ? 'bg-zinc-800 text-zinc-300 border-zinc-700' : 'bg-gray-100 text-gray-600 border-gray-200';
      case 'unpaid':
      default:
        return isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200';
    }
  };

  const selectedInvoiceStatus = selectedInvoice ? getInvoicePaymentStatus(selectedInvoice) : null;
  const selectedInvoicePaid = selectedInvoice ? getInvoicePaidAmount(selectedInvoice) : 0;
  const selectedInvoiceRemaining = selectedInvoice ? getInvoiceRemainingAmount(selectedInvoice) : 0;
  const selectedInvoicePayments = selectedInvoice?.supplier_payments || [];
  const selectedInvoiceSupplierName = selectedInvoice
    ? selectedInvoice.suppliers?.name || supplierById.get(selectedInvoice.supplier_id)?.name || t('suppliers.unknownSupplier', 'Unknown supplier')
    : '';
  const selectedInvoiceCanPay = Boolean(selectedInvoice && selectedInvoiceStatus !== 'paid' && selectedInvoiceStatus !== 'cancelled');

  return (
    <div className={`h-full min-h-0 overflow-hidden p-4 md:p-5 ${isDark ? 'text-white' : 'text-gray-950'}`}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <section className={`shrink-0 rounded-2xl border p-4 md:p-5 ${panelClass}`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-3xl font-bold tracking-tight">{t('suppliers.title', 'Suppliers')}</h1>
              <p className={`mt-1 truncate text-sm ${subtleClass}`}>{t('suppliers.subtitle', 'Manage suppliers, invoices, and imported inventory')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/*
                Invoice capture entry points. One click from here to a scanner
                spinning up; the settings button is the secondary, and the
                badge is the "queued work cannot be forgotten" indicator.
                [R1.1, R11.5, R15.1]
              */}
              {captureEnabled && (
                <>
                  <button
                    data-testid="capture-scan-invoice"
                    onClick={() => void startScan()}
                    disabled={scanStarting}
                    className={`inline-flex items-center gap-2 rounded-xl border bg-transparent px-4 py-3 text-sm font-semibold ${isDark ? 'border-yellow-400/70 text-white active:bg-yellow-400/10' : 'border-yellow-400 text-gray-950 active:bg-yellow-50'}`}
                  >
                    {scanStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                    {t('suppliers.capture.scan.open', 'Scan invoice')}
                  </button>
                  <button
                    data-testid="capture-scan-settings"
                    onClick={() => setScanSettingsOpen(true)}
                    className={`inline-flex items-center gap-2 rounded-xl border bg-transparent px-4 py-3 text-sm font-semibold ${iconButtonClass}`}
                  >
                    <Settings className="h-4 w-4" />
                    {t('suppliers.capture.settings.open', 'Scan settings')}
                  </button>
                  <button
                    data-testid="capture-queue-open"
                    onClick={() => setCaptureQueueOpen(true)}
                    className={`inline-flex items-center gap-2 rounded-xl border bg-transparent px-4 py-3 text-sm font-semibold ${iconButtonClass}`}
                  >
                    <Clock className="h-4 w-4" />
                    {t('suppliers.capture.queue.open', 'Scanned invoices')}
                    {capturePending > 0 && (
                      <span
                        data-testid="capture-pending-badge"
                        className={`rounded-full border px-2 py-0.5 text-xs font-bold ${isDark ? 'border-amber-400/50 text-amber-200' : 'border-amber-400 text-amber-700'}`}
                      >
                        {capturePending}
                      </span>
                    )}
                  </button>
                </>
              )}
              <button
                onClick={() => setImportOpen(true)}
                className={`inline-flex items-center gap-2 rounded-xl border bg-transparent px-4 py-3 text-sm font-semibold ${isDark ? 'border-yellow-400/70 text-white active:bg-yellow-400/10' : 'border-yellow-400 text-gray-950 active:bg-yellow-50'}`}
              >
                <Upload className="h-4 w-4" />
                {t('suppliers.import.open', 'Import items')}
              </button>
              <button
                onClick={fetchData}
                disabled={loading}
                aria-label={t('common.refresh', 'Refresh')}
                className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all ${isDark ? 'border border-amber-400/30 bg-amber-500/15 text-amber-300 active:bg-amber-500/25' : 'border border-amber-400/40 bg-amber-50 text-amber-600 active:bg-amber-100'} ${loading ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'}`}
              >
                <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: t('suppliers.total', 'Total'), value: stats.totalSuppliers, icon: Building2, iconClass: 'text-zinc-400' },
              { label: t('suppliers.active', 'Active'), value: stats.activeSuppliers, icon: CheckCircle, iconClass: 'text-emerald-500' },
              { label: t('suppliers.unpaid', 'Unpaid'), value: stats.unpaidInvoices, icon: Clock, iconClass: 'text-amber-500' },
              { label: t('suppliers.overdue', 'Overdue'), value: stats.overdueInvoices, icon: AlertCircle, iconClass: 'text-red-500' },
              { label: t('suppliers.owed', 'Total Owed'), value: formatMoney(stats.totalOwed), icon: Wallet, iconClass: 'text-amber-500' },
            ].map(stat => {
              const Icon = 'icon' in stat ? stat.icon : null;
              return (
                <div key={stat.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-2">
                    {Icon ? (
                      <Icon className={`h-5 w-5 shrink-0 ${stat.iconClass}`} />
                    ) : null}
                    <div className="min-w-0">
                      <p className={`truncate text-xs ${subtleClass}`}>{stat.label}</p>
                      <p className="truncate text-lg font-bold">{stat.value}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {error && !loading && (
          <div className={`shrink-0 rounded-xl border p-4 ${isDark ? 'border-red-900 bg-red-950/30 text-red-100' : 'border-red-200 bg-red-50 text-red-700'}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5" />
                <span className="font-medium">{error}</span>
              </div>
              <button onClick={fetchData} className={`rounded-2xl border px-3 py-2 text-sm ${iconButtonClass}`}>
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        )}

        <section className={`grid min-h-0 flex-1 gap-4 ${activeTab === 'orders' ? '' : 'xl:grid-cols-[minmax(0,1fr)_360px]'}`}>
          <div className={`flex min-h-0 flex-col rounded-2xl border ${panelClass}`}>
            <div className="shrink-0 border-b border-inherit p-3 md:p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className={`flex w-full rounded-xl border p-1 lg:w-auto ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-100'}`}>
                  {(['suppliers', 'invoices', 'orders'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`inline-flex min-h-10 items-center gap-2 rounded-2xl px-4 text-sm font-semibold transition ${activeTab === tab ? (isDark ? 'bg-white text-black' : 'bg-black text-white') : subtleClass}`}
                    >
                      {tab === 'suppliers' ? <Building2 className="h-4 w-4" /> : tab === 'invoices' ? <FileText className="h-4 w-4" /> : <Package className="h-4 w-4" />}
                      {tab === 'suppliers'
                        ? t('suppliers.suppliers', 'Suppliers')
                        : tab === 'invoices'
                          ? t('suppliers.invoices.title', 'Invoices')
                          : t('procurement.tab', 'Purchase orders')}
                    </button>
                  ))}
                </div>

                {activeTab !== 'orders' && (
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row lg:max-w-2xl">
                  <div className={`relative min-w-0 flex-1 rounded-xl border ${fieldClass}`}>
                    <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${subtleClass}`} />
                    <input
                      key={activeTab}
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder={
                        activeTab === 'suppliers'
                          ? t('suppliers.searchSuppliers', 'Search suppliers...')
                          : t('suppliers.searchInvoices', 'Search invoices...')
                      }
                      aria-label={
                        activeTab === 'suppliers'
                          ? t('suppliers.searchSuppliers', 'Search suppliers...')
                          : t('suppliers.searchInvoices', 'Search invoices...')
                      }
                      className="h-11 w-full rounded-xl bg-transparent pl-10 pr-3 text-sm outline-none"
                    />
                  </div>
                  <div className={`relative rounded-xl border ${fieldClass}`}>
                    <Filter className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${subtleClass}`} />
                    {activeTab === 'suppliers' ? (
                      <select
                        value={supplierFilter}
                        onChange={(event) => setSupplierFilter(event.target.value as typeof supplierFilter)}
                        className="h-11 rounded-xl bg-transparent pl-10 pr-8 text-sm outline-none"
                      >
                        <option value="all">{t('common.all', 'All')}</option>
                        <option value="active">{t('suppliers.active', 'Active')}</option>
                        <option value="inactive">{t('suppliers.inactive', 'Inactive')}</option>
                      </select>
                    ) : (
                      <select
                        value={invoiceFilter}
                        onChange={(event) => setInvoiceFilter(event.target.value as typeof invoiceFilter)}
                        className="h-11 rounded-xl bg-transparent pl-10 pr-8 text-sm outline-none"
                      >
                        <option value="all">{t('common.all', 'All')}</option>
                        <option value="unpaid">{t('suppliers.status.unpaid', 'Unpaid')}</option>
                        <option value="partial">{t('suppliers.status.partial', 'Partial')}</option>
                        <option value="paid">{t('suppliers.status.paid', 'Paid')}</option>
                        <option value="overdue">{t('suppliers.status.overdue', 'Overdue')}</option>
                        <option value="cancelled">{t('suppliers.status.cancelled', 'Cancelled')}</option>
                      </select>
                    )}
                  </div>
                </div>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-3 md:p-4">
              {activeTab === 'orders' ? (
                <PurchaseOrdersTab />
              ) : loading ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {[1, 2, 3, 4, 5, 6].map(item => (
                    <div key={item} className={`h-40 animate-pulse rounded-xl border ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-100'}`} />
                  ))}
                </div>
              ) : activeTab === 'suppliers' ? (
                filteredSuppliers.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {filteredSuppliers.map((supplier) => {
                      const supplierInvoices = invoices.filter(invoice => invoice.supplier_id === supplier.id);
                      const supplierTotal = supplierInvoices.reduce((sum, invoice) => sum + getInvoiceAmount(invoice), 0);
                      const supplierOpen = supplierInvoices.reduce((sum, invoice) => sum + getInvoiceRemainingAmount(invoice), 0);

                      return (
                        <button
                          key={supplier.id}
                          onClick={() => {
                            setSelectedSupplierId(supplier.id);
                            setSupplierSummaryId(supplier.id);
                          }}
                          className={`min-h-[180px] rounded-xl border p-4 text-left transition ${selectedSupplier?.id === supplier.id ? (isDark ? 'border-yellow-400 bg-transparent text-white' : 'border-yellow-400 bg-transparent text-gray-950') : isDark ? 'border-zinc-800 bg-zinc-900/60 active:bg-zinc-900' : 'border-gray-200 bg-white active:bg-gray-50'}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-base font-bold">{supplier.name}</h3>
                              <p className={`mt-1 truncate text-xs ${subtleClass}`}>{supplier.supplier_code || supplier.category || t('suppliers.noCategory', 'No category')}</p>
                            </div>
                            <span className={`shrink-0 text-xs font-semibold ${supplier.is_active ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : (isDark ? 'text-zinc-300' : 'text-gray-600')}`}>
                              {supplier.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
                            </span>
                          </div>
                          <div className={`mt-4 space-y-2 text-sm ${subtleClass}`}>
                            {(supplier.contact_person || supplier.contact_name) && <p className="truncate">{supplier.contact_person || supplier.contact_name}</p>}
                            {supplier.phone && <p className="flex items-center gap-2 truncate"><Phone className="h-4 w-4" />{supplier.phone}</p>}
                            {supplier.email && <p className="flex items-center gap-2 truncate"><Mail className="h-4 w-4" />{supplier.email}</p>}
                          </div>
                          <div className={`mt-4 grid grid-cols-2 gap-2 rounded-2xl border p-3 text-xs ${isDark ? 'border-zinc-800 bg-black/20' : 'border-gray-200 bg-gray-50'}`}>
                            <div>
                              <p className={subtleClass}>{t('suppliers.invoices.totalSpent', 'Total spent')}</p>
                              <p className="mt-1 font-bold">{formatMoney(supplierTotal)}</p>
                            </div>
                            <div>
                              <p className={subtleClass}>{t('suppliers.invoices.unpaidTotal', 'Unpaid')}</p>
                              <p className="mt-1 font-bold">{formatMoney(supplierOpen)}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    isDark={isDark}
                    icon={<Building2 className="h-8 w-8" />}
                    heading={t('suppliers.empty.title', 'No suppliers found')}
                    description={t('suppliers.empty.description', 'Add or import supplier items to start syncing inventory.')}
                  />
                )
              ) : filteredInvoices.length > 0 ? (
                <div className="space-y-3">
                  {filteredInvoices.map(invoice => {
                    const supplierName = invoice.suppliers?.name || supplierById.get(invoice.supplier_id)?.name || t('suppliers.unknownSupplier', 'Unknown supplier');
                    const paymentStatus = getInvoicePaymentStatus(invoice);
                    const paidAmount = getInvoicePaidAmount(invoice);
                    const remainingAmount = getInvoiceRemainingAmount(invoice);
                    return (
                      <div
                        key={invoice.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openInvoiceDetails(invoice)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openInvoiceDetails(invoice);
                          }
                        }}
                        className={`rounded-xl border p-4 text-left transition ${isDark ? 'border-zinc-800 bg-zinc-900/60 active:bg-zinc-900' : 'border-gray-200 bg-white active:bg-gray-50'}`}
                      >
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-bold">{formatDate(getInvoiceDisplayDate(invoice))}</h3>
                              <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${isDark ? 'border-zinc-700 bg-zinc-950 text-zinc-200' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                                #{invoice.invoice_number}
                              </span>
                              <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${getInvoiceStatusClass(paymentStatus)}`}>
                                {t(`suppliers.status.${paymentStatus}`, paymentStatus)}
                              </span>
                            </div>
                            <p className={`mt-1 text-sm ${subtleClass}`}>{supplierName}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                            <div className="mr-2 text-right">
                              <p className="text-lg font-bold">{formatMoney(toNumber(invoice.amount))}</p>
                              <p className={`text-xs ${subtleClass}`}>{t('suppliers.invoices.remaining', 'Remaining')}: {formatMoney(remainingAmount)}</p>
                              {paidAmount > 0.01 && (
                                <p className={`text-xs ${subtleClass}`}>{t('suppliers.invoices.paidAmount', 'Paid')}: {formatMoney(paidAmount)}</p>
                              )}
                              <p className={`text-xs ${subtleClass}`}>{t('suppliers.invoices.dueDate', 'Due Date')}: {formatDate(invoice.due_date)}</p>
                            </div>
                            {paymentStatus !== 'paid' && (
                              <>
                                <button
                                  disabled={saving}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openInvoiceDetails(invoice, { partial: true });
                                  }}
                                  className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold ${isDark ? 'border-amber-500/30 bg-amber-500/15 text-amber-200 active:bg-amber-500/25' : 'border-amber-200 bg-amber-50 text-amber-700 active:bg-amber-100'}`}
                                >
                                  <CreditCard className="h-4 w-4" />
                                  {t('suppliers.invoices.partialPayment', 'Partial')}
                                </button>
                                <button
                                  disabled={saving}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    markInvoiceStatus(invoice.id, 'paid');
                                  }}
                                  className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold ${isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200 active:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-50 text-emerald-700 active:bg-emerald-100'}`}
                                >
                                  <Check className="h-4 w-4" />
                                  {t('suppliers.invoices.markPaid', 'Paid')}
                                </button>
                              </>
                            )}
                            {paymentStatus === 'paid' && (
                              <button
                                disabled={saving}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  markInvoiceStatus(invoice.id, 'unpaid');
                                }}
                                className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold ${isDark ? 'border-amber-500/30 bg-amber-500/15 text-amber-200 active:bg-amber-500/25' : 'border-amber-200 bg-amber-50 text-amber-700 active:bg-amber-100'}`}
                              >
                                <Ban className="h-4 w-4" />
                                {t('suppliers.invoices.markUnpaid', 'Unpaid')}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  isDark={isDark}
                  icon={<FileText className="h-8 w-8" />}
                  heading={t('suppliers.invoices.emptyTitle', 'No invoices found')}
                  description={t('suppliers.invoices.emptyDescription', 'Supplier invoices will appear here when they sync from the admin dashboard.')}
                />
              )}
            </div>
          </div>

          <aside className={`${activeTab === 'orders' ? 'hidden' : 'hidden xl:flex'} min-h-0 flex-col rounded-2xl border ${panelClass}`}>
            <div className="border-b border-inherit p-3">
              <p className={`text-xs font-semibold uppercase ${subtleClass}`}>{t('suppliers.detail.title', 'Supplier detail')}</p>
              <h2 className="mt-1 truncate text-xl font-bold">{selectedSupplier?.name || t('suppliers.noSelection', 'No supplier selected')}</h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-3 pb-4">
              {selectedSupplier ? (
                <div className="space-y-3">
                  <InfoLine icon={<Building2 className="h-4 w-4" />} label={t('suppliers.code', 'Code')} value={selectedSupplier.supplier_code || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Phone className="h-4 w-4" />} label={t('suppliers.phone', 'Phone')} value={selectedSupplier.phone || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Mail className="h-4 w-4" />} label={t('suppliers.email', 'Email')} value={selectedSupplier.email || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<MapPin className="h-4 w-4" />} label={t('suppliers.address', 'Address')} value={selectedSupplier.address || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Clock className="h-4 w-4" />} label={t('suppliers.paymentTerms', 'Payment terms')} value={selectedSupplier.payment_terms || '-'} subtleClass={subtleClass} />
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-50'}`}>
                    <p className={`text-sm ${subtleClass}`}>{t('suppliers.invoices.title', 'Invoices')}</p>
                    <p className="mt-2 text-2xl font-bold">
                      {invoices.filter(invoice => invoice.supplier_id === selectedSupplier.id).length}
                    </p>
                  </div>
                </div>
              ) : (
                <EmptyState
                  isDark={isDark}
                  icon={<Package className="h-8 w-8" />}
                  heading={t('suppliers.detail.emptyTitle', 'Pick a supplier')}
                  description={t('suppliers.detail.emptyDescription', 'Supplier contact and invoice information will show here.')}
                />
              )}
            </div>
          </aside>
        </section>
      </div>

      {supplierSummary && renderModalPortal(
          <motion.div
            className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSupplierSummaryId(null)}
          >
            <motion.div
              ref={summaryDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={summaryTitleId}
              initial={{ scale: 0.98, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 16 }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              onClick={(event) => event.stopPropagation()}
              className={`flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border shadow-2xl ${panelClass}`}
            >
              <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-4">
                <div className="min-w-0">
                  <p className={`text-xs font-semibold uppercase ${subtleClass}`}>{t('suppliers.summary.title', 'Supplier summary')}</p>
                  <h2 id={summaryTitleId} className="mt-1 truncate text-2xl font-bold">{supplierSummary.supplier.name}</h2>
                  <p className={`mt-1 truncate text-sm ${subtleClass}`}>{supplierSummary.supplier.supplier_code || supplierSummary.supplier.category || t('suppliers.noCategory', 'No category')}</p>
                </div>
                <button
                  onClick={() => setSupplierSummaryId(null)}
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${iconButtonClass}`}
                  aria-label={t('common.close', 'Close')}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: t('suppliers.invoices.totalSpent', 'Total spent'), value: formatMoney(supplierSummary.totalSpent), icon: Wallet },
                    { label: t('suppliers.invoices.paidTotal', 'Paid total'), value: formatMoney(supplierSummary.paidAmount), icon: CheckCircle },
                    { label: t('suppliers.invoices.unpaidTotal', 'Unpaid total'), value: formatMoney(supplierSummary.unpaidAmount), icon: Clock },
                    { label: t('suppliers.invoices.invoiceCount', 'Invoices'), value: supplierSummary.invoices.length, icon: Receipt },
                  ].map(tile => {
                    const Icon = 'icon' in tile ? tile.icon : null;
                    return (
                      <div key={tile.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`flex h-9 w-9 items-center justify-center rounded-2xl ${isDark ? 'bg-zinc-800 text-zinc-200' : 'bg-white text-gray-700'}`}>
                            {Icon ? (
                              <Icon className="h-5 w-5" />
                            ) : null}
                          </div>
                          <div className="min-w-0">
                            <p className={`truncate text-xs ${subtleClass}`}>{tile.label}</p>
                            <p className="truncate text-lg font-bold">{tile.value}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
                    <div className="space-y-4">
                      <InfoLine icon={<Phone className="h-4 w-4" />} label={t('suppliers.phone', 'Phone')} value={supplierSummary.supplier.phone || '-'} subtleClass={subtleClass} />
                      <InfoLine icon={<Mail className="h-4 w-4" />} label={t('suppliers.email', 'Email')} value={supplierSummary.supplier.email || '-'} subtleClass={subtleClass} />
                      <InfoLine icon={<MapPin className="h-4 w-4" />} label={t('suppliers.address', 'Address')} value={supplierSummary.supplier.address || '-'} subtleClass={subtleClass} />
                      <InfoLine icon={<Clock className="h-4 w-4" />} label={t('suppliers.paymentTerms', 'Payment terms')} value={supplierSummary.supplier.payment_terms || '-'} subtleClass={subtleClass} />
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="font-bold">{t('suppliers.invoices.title', 'Invoices')}</h3>
                      <span className={`text-xs ${subtleClass}`}>
                        {supplierSummary.paidInvoices} {t('suppliers.status.paid', 'Paid')} · {supplierSummary.unpaidInvoices} {t('suppliers.status.unpaid', 'Unpaid')}
                      </span>
                    </div>
                    {supplierSummary.invoices.length > 0 ? (
                      <div className="space-y-2">
                        {supplierSummary.invoices.map(invoice => {
                          const status = getInvoicePaymentStatus(invoice);
                          return (
                            <button
                              key={invoice.id}
                              onClick={() => {
                                setSupplierSummaryId(null);
                                openInvoiceDetails(invoice);
                              }}
                              className={`w-full rounded-xl border p-3 text-left transition ${isDark ? 'border-zinc-800 bg-zinc-900/70 active:bg-zinc-900' : 'border-gray-200 bg-white active:bg-gray-50'}`}
                            >
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-bold">{formatDate(getInvoiceDisplayDate(invoice))}</span>
                                    <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${isDark ? 'border-zinc-700 bg-zinc-950 text-zinc-200' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                                      #{invoice.invoice_number}
                                    </span>
                                    <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${getInvoiceStatusClass(status)}`}>
                                      {t(`suppliers.status.${status}`, status)}
                                    </span>
                                  </div>
                                  <p className={`mt-1 text-xs ${subtleClass}`}>{t('suppliers.invoices.dueDate', 'Due Date')}: {formatDate(invoice.due_date)}</p>
                                </div>
                                <div className="text-left sm:text-right">
                                  <p className="font-bold">{formatMoney(getInvoiceAmount(invoice))}</p>
                                  <p className={`text-xs ${subtleClass}`}>{t('suppliers.invoices.remaining', 'Remaining')}: {formatMoney(getInvoiceRemainingAmount(invoice))}</p>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <EmptyState
                        isDark={isDark}
                        icon={<FileText className="h-8 w-8" />}
                        heading={t('suppliers.invoices.emptyTitle', 'No invoices found')}
                        description={t('suppliers.invoices.emptyDescription', 'Supplier invoices will appear here when they sync from the admin dashboard.')}
                      />
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
      )}

      {selectedInvoice && selectedInvoiceStatus && renderModalPortal(
          <motion.div
            className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedInvoiceId(null)}
          >
            <motion.div
              ref={invoiceDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={invoiceTitleId}
              initial={{ scale: 0.98, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.98, y: 16 }}
              transition={{ type: 'spring', damping: 26, stiffness: 260 }}
              onClick={(event) => event.stopPropagation()}
              className={`flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border shadow-2xl ${panelClass}`}
            >
              <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-4">
                <div className="min-w-0">
                  <p className={`text-xs font-semibold uppercase ${subtleClass}`}>{t('suppliers.invoices.detailsTitle', 'Invoice details')}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 id={invoiceTitleId} className="truncate text-2xl font-bold">{formatDate(getInvoiceDisplayDate(selectedInvoice))}</h2>
                    <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${isDark ? 'border-zinc-700 bg-zinc-950 text-zinc-200' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                      #{selectedInvoice.invoice_number}
                    </span>
                    <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${getInvoiceStatusClass(selectedInvoiceStatus)}`}>
                      {t(`suppliers.status.${selectedInvoiceStatus}`, selectedInvoiceStatus)}
                    </span>
                  </div>
                  <p className={`mt-1 truncate text-sm ${subtleClass}`}>{selectedInvoiceSupplierName}</p>
                </div>
                <button
                  onClick={() => setSelectedInvoiceId(null)}
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${iconButtonClass}`}
                  aria-label={t('common.close', 'Close')}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { label: t('suppliers.invoices.amount', 'Amount'), value: formatMoney(getInvoiceAmount(selectedInvoice)), icon: Receipt },
                    { label: t('suppliers.invoices.paidAmount', 'Paid'), value: formatMoney(selectedInvoicePaid), icon: Wallet },
                    { label: t('suppliers.invoices.remaining', 'Remaining'), value: formatMoney(selectedInvoiceRemaining), icon: CreditCard },
                  ].map(tile => {
                    const Icon = tile.icon;
                    return (
                      <div key={tile.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`flex h-9 w-9 items-center justify-center rounded-2xl ${isDark ? 'bg-zinc-800 text-zinc-200' : 'bg-white text-gray-700'}`}>
                            <Icon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <p className={`truncate text-xs ${subtleClass}`}>{tile.label}</p>
                            <p className="truncate text-lg font-bold">{tile.value}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                  <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-bold">{t('suppliers.invoices.paymentOptions', 'Payment options')}</h3>
                      <span className={`text-xs ${subtleClass}`}>{t('suppliers.invoices.dueDate', 'Due')}: {formatDate(selectedInvoice.due_date)}</span>
                    </div>

                    {selectedInvoiceCanPay ? (
                      <div className="mt-4 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={paymentAmount}
                            onChange={(event) => setPaymentAmount(event.target.value)}
                            className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                            placeholder={t('suppliers.invoices.paymentAmount', 'Payment amount')}
                          />
                          <select
                            value={paymentMethod}
                            onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                            className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          >
                            <option value="cash">{t('suppliers.invoices.methods.cash', 'Cash')}</option>
                            <option value="bank_transfer">{t('suppliers.invoices.methods.bankTransfer', 'Bank transfer')}</option>
                            <option value="check">{t('suppliers.invoices.methods.check', 'Check')}</option>
                            <option value="credit_card">{t('suppliers.invoices.methods.creditCard', 'Credit card')}</option>
                            <option value="other">{t('suppliers.invoices.methods.other', 'Other')}</option>
                          </select>
                          <input
                            type="date"
                            value={paymentDate}
                            onChange={(event) => setPaymentDate(event.target.value)}
                            className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <input
                            value={paymentReference}
                            onChange={(event) => setPaymentReference(event.target.value)}
                            className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                            placeholder={t('suppliers.invoices.reference', 'Reference')}
                          />
                          <input
                            value={paymentNotes}
                            onChange={(event) => setPaymentNotes(event.target.value)}
                            className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                            placeholder={t('suppliers.invoices.paymentNotes', 'Payment notes')}
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            disabled={saving}
                            onClick={() => void recordInvoicePayment()}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold disabled:opacity-50 ${isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200 active:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-600 text-white active:bg-emerald-700'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                            {t('suppliers.invoices.recordPayment', 'Record payment')}
                          </button>
                          <button
                            disabled={saving}
                            onClick={() => void recordInvoicePayment(selectedInvoiceRemaining)}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold disabled:opacity-50 ${isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200 active:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-50 text-emerald-700 active:bg-emerald-100'}`}
                          >
                            <Check className="h-4 w-4" />
                            {t('suppliers.invoices.payRemaining', 'Pay remaining')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className={`mt-4 rounded-xl border p-3 text-sm ${isDark ? 'border-zinc-800 bg-zinc-950 text-zinc-300' : 'border-gray-200 bg-white text-gray-600'}`}>
                        {t('suppliers.invoices.noPaymentNeeded', 'This invoice has no remaining balance.')}
                      </div>
                    )}
                  </div>

                  <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}>
                    <h3 className="font-bold">{t('suppliers.invoices.payments', 'Payments')}</h3>
                    <div className="mt-3 space-y-2">
                      {selectedInvoicePayments.length > 0 ? (
                        selectedInvoicePayments.map(payment => (
                          <div key={payment.id} className={`rounded-2xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-950' : 'border-gray-200 bg-white'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-bold">{formatMoney(toNumber(payment.amount))}</p>
                              <span className={`text-xs ${subtleClass}`}>{formatDate(payment.payment_date)}</span>
                            </div>
                            <p className={`mt-1 text-xs ${subtleClass}`}>
                              {t(`suppliers.invoices.methods.${payment.payment_method === 'bank_transfer' ? 'bankTransfer' : payment.payment_method === 'credit_card' ? 'creditCard' : payment.payment_method}`, payment.payment_method)}
                            </p>
                            {payment.reference_number && <p className={`mt-1 break-words text-xs ${subtleClass}`}>{payment.reference_number}</p>}
                          </div>
                        ))
                      ) : (
                        <p className={`rounded-2xl border p-3 text-sm ${isDark ? 'border-zinc-800 bg-zinc-950 text-zinc-400' : 'border-gray-200 bg-white text-gray-500'}`}>
                          {t('suppliers.invoices.noPayments', 'No payments recorded yet')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
      )}

      {importOpen && renderModalPortal(
          <motion.div
            className="fixed inset-0 z-[1200] flex justify-end bg-black/50 backdrop-blur-sm p-0 sm:p-4 md:p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              ref={importDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={importTitleId}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 260 }}
              className={`flex h-full w-full max-w-none flex-col border-l ${panelClass} sm:max-w-[min(72rem,calc(100vw-8rem))] sm:rounded-2xl sm:border`}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-inherit p-4">
                <div>
                  <h2 id={importTitleId} className="text-xl font-bold">{t('suppliers.import.title', 'Import supplier items')}</h2>
                  <p className={`text-sm ${subtleClass}`}>{t('suppliers.import.subtitle', 'Review rows first, then sync stock to inventory.')}</p>
                </div>
                <button
                  onClick={closeImport}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${iconButtonClass}`}
                  aria-label={t('common.close', 'Close')}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
                <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                      <label className={`text-sm font-semibold ${subtleClass}`}>{t('suppliers.import.supplierName', 'Supplier name')}</label>
                      <input
                        value={supplierName}
                        onChange={(event) => {
                          setSupplierName(event.target.value);
                          setImportDraft(null);
                          setImportError(null);
                        }}
                        className={`mt-2 h-11 w-full rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                        placeholder={t('suppliers.import.supplierPlaceholder', 'Fresh Farms')}
                      />
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <input
                          value={supplierPhone}
                          onChange={(event) => {
                            setSupplierPhone(event.target.value);
                            setImportDraft(null);
                            setImportError(null);
                          }}
                          className={`h-10 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          placeholder={t('suppliers.import.supplierPhone', 'Phone')}
                        />
                        <input
                          value={supplierEmail}
                          onChange={(event) => {
                            setSupplierEmail(event.target.value);
                            setImportDraft(null);
                            setImportError(null);
                          }}
                          className={`h-10 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          placeholder={t('suppliers.import.supplierEmail', 'Email')}
                        />
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <input
                          value={invoiceNumber}
                          onChange={(event) => {
                            setInvoiceNumber(event.target.value);
                            setImportDraft(null);
                            setImportError(null);
                          }}
                          className={`h-10 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          placeholder={t('suppliers.import.invoiceNumber', 'Invoice number')}
                        />
                        <input
                          value={invoiceDate}
                          onChange={(event) => {
                            setInvoiceDate(event.target.value);
                            setImportDraft(null);
                            setImportError(null);
                          }}
                          className={`h-10 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          placeholder={t('suppliers.import.invoiceDate', 'Invoice date')}
                        />
                      </div>
                      <textarea
                        value={supplierNotes}
                        onChange={(event) => {
                          setSupplierNotes(event.target.value);
                          setImportDraft(null);
                          setImportError(null);
                        }}
                        className={`mt-2 min-h-20 w-full resize-none rounded-xl border px-3 py-2 text-sm outline-none ${fieldClass}`}
                        placeholder={t('suppliers.import.supplierNotes', 'Supplier notes from invoice')}
                      />
                    </div>

                    <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                      <p className="font-semibold">{t('suppliers.import.addRows', 'Add rows')}</p>
                      <div className="mt-3 grid gap-2">
                        <button
                          onClick={() => {
                            setDraftRows(rows => [emptyImportRow(), ...rows]);
                            setImportDraft(null);
                            setImportError(null);
                          }}
                          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold ${iconButtonClass}`}
                        >
                          <Plus className="h-4 w-4" />
                          {t('suppliers.import.manualRow', 'Manual row')}
                        </button>
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold ${iconButtonClass}`}
                        >
                          <Upload className="h-4 w-4" />
                          {t('suppliers.import.file', 'File import')}
                        </button>
                        <button
                          onClick={() => cameraInputRef.current?.click()}
                          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold ${iconButtonClass}`}
                        >
                          <Camera className="h-4 w-4" />
                          {t('suppliers.import.camera', 'Camera scan')}
                        </button>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt,.tsv,.xlsx,.xls,.pdf,.doc,.docx"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void handleFileImport(file);
                          event.currentTarget.value = '';
                        }}
                      />
                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void handleCameraFile(file);
                          event.currentTarget.value = '';
                        }}
                      />
                      {fileNotice && <p className={`mt-3 text-xs ${subtleClass}`}>{fileNotice}</p>}
                    </div>

                    <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                      <p className="font-semibold">{t('suppliers.import.hardwareScanner', 'Hardware scanner')}</p>
                      <p className={`mt-1 text-xs ${subtleClass}`}>{t('suppliers.import.hardwareHelp', 'Open this drawer and scan. The barcode is added automatically.')}</p>
                      <div className="mt-3 flex gap-2">
                        <input
                          value={manualBarcode}
                          onChange={(event) => setManualBarcode(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') appendBarcodeRow(manualBarcode);
                          }}
                          className={`min-w-0 flex-1 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                          placeholder={t('suppliers.import.barcodePlaceholder', 'Barcode')}
                        />
                        <button
                          onClick={() => appendBarcodeRow(manualBarcode)}
                          className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border ${iconButtonClass}`}
                          aria-label={t('suppliers.import.addBarcode', 'Add barcode')}
                        >
                          <Package className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-4">
                    {/*
                      A hard-to-read scan is a bump, not a dead end: two equally
                      weighted choices, neither of them the "correct" one, and
                      the ordinary Save path stays open behind both. [R7.2]
                    */}
                    {reviewCapture && reviewQuality === 'poor' && (
                      <div
                        data-testid="capture-poor-quality"
                        className={`rounded-xl border p-4 ${isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
                      >
                        <p className="font-semibold">
                          {t('suppliers.capture.review.poorTitle', 'This scan is hard to read')}
                        </p>
                        <p className="mt-1 text-sm">
                          {t('suppliers.capture.review.poorDescription', 'You can scan it again, or just type in what it says.')}
                        </p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <button
                            data-testid="capture-scan-again"
                            onClick={() => void rescanCurrentInvoice()}
                            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${iconButtonClass}`}
                          >
                            <RefreshCw className="h-4 w-4" />
                            {t('suppliers.capture.review.scanAgain', 'Scan it again')}
                          </button>
                          <button
                            data-testid="capture-fill-by-hand"
                            onClick={() => setReviewQuality('good')}
                            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${iconButtonClass}`}
                          >
                            <Save className="h-4 w-4" />
                            {t('suppliers.capture.review.fillByHand', 'Fill it in by hand')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/*
                      Purchase-order linkage, in plain language, only when there
                      is actually an open order for this supplier. Declining is
                      the default and stays selected unless the user says
                      otherwise. [R9.2, R15.6]
                    */}
                    {reviewCapture && reviewPoOptions.length > 0 && (
                      <div
                        data-testid="capture-po-linkage"
                        className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}
                      >
                        <p className="font-semibold">
                          {t('suppliers.capture.review.poTitle', 'This delivery was expected — is this it?')}
                        </p>
                        <div className="mt-3 space-y-2">
                          {reviewPoOptions.map(order => (
                            <label
                              key={order.id}
                              className="flex min-h-10 items-center gap-3 text-sm"
                            >
                              <input
                                type="radio"
                                name="capture-po-linkage"
                                className="h-5 w-5"
                                checked={reviewPoId === order.id}
                                onChange={() => setReviewPoId(order.id)}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {order.orderReference}
                                {order.expectedDeliveryDate ? ` · ${formatDate(order.expectedDeliveryDate)}` : ''}
                              </span>
                            </label>
                          ))}
                          <label className="flex min-h-10 items-center gap-3 text-sm">
                            <input
                              type="radio"
                              name="capture-po-linkage"
                              className="h-5 w-5"
                              checked={reviewPoId === null}
                              onChange={() => setReviewPoId(null)}
                            />
                            <span>{t('suppliers.capture.review.poDecline', 'No, this is something else')}</span>
                          </label>
                        </div>
                      </div>
                    )}

                    <div className={`rounded-xl border ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-white'}`}>
                      <div className="flex items-center justify-between gap-3 border-b border-inherit p-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-bold">{t('suppliers.import.draftRows', 'Draft rows')}</h3>
                            <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${isDark ? 'border-zinc-700 bg-zinc-950 text-zinc-200' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                              {t('suppliers.import.rowCount', { count: draftRowCount, defaultValue: '{{count}} rows' })}
                            </span>
                          </div>
                          <p className={`text-xs ${subtleClass}`}>{t('suppliers.import.reviewBeforeSave', 'Edit quantities, costs, and categories before preview.')}</p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <button
                            onClick={previewImport}
                            disabled={saving}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold ${isDark ? 'border-amber-500/40 bg-amber-500/15 text-amber-200 active:bg-amber-500/25' : 'border-amber-200 bg-amber-50 text-amber-700 active:bg-amber-100'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            {t('suppliers.import.preview', 'Preview')}
                          </button>
                          <button
                            onClick={commitImport}
                            disabled={saving || !importDraft || importDraft.rows.some(row => row.status === 'error')}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-2xl border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 active:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-600 text-white active:bg-emerald-700'}`}
                          >
                            {saving && importDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {importDraft ? t('suppliers.import.commit', 'Save to inventory') : t('suppliers.import.saveAfterPreview', 'Save after preview')}
                          </button>
                        </div>
                      </div>
                      {importError && (
                        <div className={`mx-3 mt-3 flex gap-2 rounded-2xl border px-3 py-2 text-sm ${isDark ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-red-200 bg-red-50 text-red-800'}`}>
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{importError}</span>
                        </div>
                      )}
                      {!importDraft && !importError && (
                        <p className={`mx-3 mt-3 text-xs ${subtleClass}`}>
                          {t('suppliers.import.previewThenSaveHelp', 'Preview validates supplier, category, and inventory matches. The save action becomes available after that check.')}
                        </p>
                      )}
                      <div className="max-h-[min(64vh,720px)] overflow-y-auto scrollbar-hide p-3">
                        <div className="space-y-2">
                          {draftRows.map((row, index) => (
                            <ImportRowEditor
                              key={`${index}-${row.barcode}-${row.sku}`}
                              row={row}
                              index={index}
                              fieldClass={fieldClass}
                              subtleClass={subtleClass}
                              iconButtonClass={iconButtonClass}
                              isDark={isDark}
                              doubleCheck={needsDoubleCheck(reviewConfidence[index])}
                              onChange={updateDraftRow}
                              onRemove={removeDraftRow}
                              t={t}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    {importDraft && (
                      <div className={`rounded-xl border ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-white'}`}>
                        <div className="flex flex-col gap-3 border-b border-inherit p-3 lg:flex-row lg:items-center lg:justify-between">
                          <div>
                            <h3 className="font-bold">{t('suppliers.import.review', 'Review inventory sync')}</h3>
                            <p className={`text-xs ${subtleClass}`}>
                              {t('suppliers.import.rowCount', { count: importDraft.rows.length, defaultValue: '{{count}} rows' })} · {t('suppliers.import.missingCategories', 'Missing categories')}: {importDraft.missingCategories.length}
                            </p>
                          </div>
                          <button
                            onClick={commitImport}
                            disabled={saving || importDraft.rows.some(row => row.status === 'error')}
                            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-semibold ${isDark ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 active:bg-emerald-500/25 disabled:opacity-50' : 'border-emerald-200 bg-emerald-600 text-white active:bg-emerald-700 disabled:opacity-50'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {t('suppliers.import.commit', 'Save to inventory')}
                          </button>
                        </div>
                        <div className="max-h-[38vh] overflow-y-auto scrollbar-hide p-3">
                          {importDraft.missingCategories.length > 0 && (
                            <div className={`mb-3 rounded-2xl border p-3 text-sm ${isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                              {importDraft.missingCategories.map(category => (
                                <span key={`${category.parentName}-${category.name}`} className="mr-2 inline-flex rounded-full border border-current/20 px-2 py-1 text-xs">
                                  {category.parentName ? `${category.parentName} / ${category.name}` : category.name}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="space-y-2">
                            {importDraft.rows.map((row, index) => (
                              <ReviewRow
                                key={`${row.rowNumber}-${row.barcode}-${row.sku}`}
                                row={row}
                                index={index}
                                fieldClass={fieldClass}
                                subtleClass={subtleClass}
                                isDark={isDark}
                                onChange={updateReviewRow}
                                t={t}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
      )}

      {captureEnabled && (
        <CaptureScanSettingsModal
          isOpen={scanSettingsOpen}
          onClose={() => setScanSettingsOpen(false)}
          onSourcesChanged={(sources, defaultSourceId) => {
            setCaptureSources(sources);
            setCaptureDefaultId(defaultSourceId);
          }}
        />
      )}

      {captureEnabled && (
        <CapturePagesPanel
          isOpen={activeCapture !== null}
          captureId={activeCapture?.captureId ?? null}
          deviceId={activeCapture?.deviceId ?? null}
          sourceName={activeCapture?.sourceName ?? null}
          onClose={() => {
            // Closing is not abandoning: the document stays `capturing` and
            // reappears in the queue with "Carry on scanning". [R11.4]
            setActiveCapture(null);
            void refreshCaptureQueue();
          }}
          onDone={finishCapture}
          onFinishAndStartAnother={finishCaptureAndStartAnother}
        />
      )}

      {captureEnabled && captureQueueOpen && renderModalPortal(
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onClick={() => setCaptureQueueOpen(false)}
        >
          <div
            ref={captureQueueDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={captureQueueTitleId}
            onClick={(event) => event.stopPropagation()}
            className={`flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border shadow-2xl ${panelClass}`}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-inherit p-4">
              <div className="min-w-0">
                <h2 id={captureQueueTitleId} className="truncate text-2xl font-bold">
                  {t('suppliers.capture.queue.title', 'Scanned invoices')}
                </h2>
                <p className={`mt-1 text-sm ${subtleClass}`}>
                  {t('suppliers.capture.queue.subtitle', 'Everything scanned here that is not filed yet.')}
                </p>
              </div>
              <button
                onClick={() => setCaptureQueueOpen(false)}
                aria-label={t('common.close', 'Close')}
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${iconButtonClass}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
              <CaptureQueuePanel
                onReview={openCaptureReview}
                onContinueCapture={(document) => {
                  setCaptureQueueOpen(false);
                  setActiveCapture({
                    captureId: document.captureId,
                    deviceId: resolveDefaultSource(captureSources, captureDefaultId)?.deviceId ?? null,
                    sourceName: document.sourceName,
                  });
                }}
                staffId={captureStaffId}
                onChanged={refreshCaptureQueue}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface EmptyStateProps {
  isDark: boolean;
  icon: React.ReactNode;
  heading: string;
  description: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ isDark, icon, heading, description }) => (
  <div className={`flex min-h-[260px] flex-col items-center justify-center rounded-xl border p-8 text-center ${isDark ? 'border-zinc-800 bg-zinc-900/40 text-zinc-300' : 'border-gray-200 bg-white text-gray-600'}`}>
    <div className={`mb-3 flex h-14 w-14 items-center justify-center rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>{icon}</div>
    <h3 className="text-base font-bold">{heading}</h3>
    <p className="mt-1 max-w-sm text-sm">{description}</p>
  </div>
);

const InfoLine: React.FC<{ icon: React.ReactNode; label: string; value: string; subtleClass: string }> = ({ icon, label, value, subtleClass }) => (
  <div className="flex items-start gap-3">
    <div className="text-yellow-400">{icon}</div>
    <div className="min-w-0">
      <p className={`text-xs ${subtleClass}`}>{label}</p>
      <p className="break-words text-sm font-medium">{value}</p>
    </div>
  </div>
);

interface ImportRowEditorProps {
  row: ImportRawRow;
  index: number;
  fieldClass: string;
  subtleClass: string;
  iconButtonClass: string;
  isDark: boolean;
  /**
   * True when the reader was not sure about this row and the user should look
   * at it. Derived from the server's tri-state confidence — the numeric score
   * behind it never reaches this component, let alone the screen. [R7.1, R7.6]
   */
  doubleCheck?: boolean;
  onChange: (index: number, patch: Partial<ImportRawRow>) => void;
  onRemove: (index: number) => void;
  t: TFunction;
}

const ImportRowEditor: React.FC<ImportRowEditorProps> = ({ row, index, fieldClass, subtleClass, iconButtonClass, isDark, doubleCheck, onChange, onRemove, t }) => (
  <div className={`rounded-xl border p-3 ${doubleCheck ? (isDark ? 'border-amber-500/50 bg-amber-500/10' : 'border-amber-300 bg-amber-50') : (isDark ? 'border-zinc-800 bg-black/20' : 'border-gray-200 bg-gray-50')}`}>
    <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_120px_120px_86px_86px_42px]">
      <input
        value={row.name}
        onChange={(event) => onChange(index, { name: event.target.value })}
        className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.itemName', 'Item name')}
      />
      <input
        value={row.sku || ''}
        onChange={(event) => onChange(index, { sku: event.target.value })}
        className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.sku', 'SKU')}
      />
      <input
        value={row.barcode || ''}
        onChange={(event) => onChange(index, { barcode: event.target.value })}
        className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.barcode', 'Barcode')}
      />
      <input
        type="number"
        min="0"
        value={row.quantity}
        onChange={(event) => onChange(index, { quantity: toNumber(event.target.value, 0) })}
        className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.quantity', 'Qty')}
      />
      <input
        type="number"
        min="0"
        value={row.cost}
        onChange={(event) => onChange(index, { cost: toNumber(event.target.value, 0) })}
        className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.cost', 'Cost')}
      />
      <button
        onClick={() => onRemove(index)}
        className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl border ${iconButtonClass}`}
        aria-label={t('common.delete', 'Delete')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
    <div className="mt-2 grid gap-2 md:grid-cols-4">
      <input value={row.unit} onChange={(event) => onChange(index, { unit: event.target.value })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.unit', 'Unit')} />
      <input value={row.category || ''} onChange={(event) => onChange(index, { category: event.target.value })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.category', 'Category')} />
      <input value={row.subcategory || ''} onChange={(event) => onChange(index, { subcategory: event.target.value })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.subcategory', 'Subcategory')} />
      <input value={row.notes || ''} onChange={(event) => onChange(index, { notes: event.target.value })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.notes', 'Notes')} />
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className={`text-xs ${subtleClass}`}>{t('suppliers.import.rowNumber', 'Row')} {index + 1}</p>
      {doubleCheck && (
        <span
          data-testid={`capture-double-check-${index}`}
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${isDark ? 'border-amber-500/50 text-amber-200' : 'border-amber-300 text-amber-800'}`}
        >
          {t('suppliers.capture.review.doubleCheck', 'Double-check this')}
        </span>
      )}
    </div>
  </div>
);

interface ReviewRowProps {
  row: SupplierImportRow;
  index: number;
  fieldClass: string;
  subtleClass: string;
  isDark: boolean;
  onChange: (index: number, patch: Partial<SupplierImportRow>) => void;
  t: TFunction;
}

const ReviewRow: React.FC<ReviewRowProps> = ({ row, index, fieldClass, subtleClass, isDark, onChange, t }) => {
  const statusClass = row.status === 'error'
    ? (isDark ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700')
    : row.status === 'update'
      ? (isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700')
      : row.status === 'skip'
        ? (isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-300' : 'border-gray-200 bg-gray-100 text-gray-600')
        : (isDark ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700');

  return (
    <div className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-black/20' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={row.name}
              onChange={(event) => onChange(index, { name: event.target.value })}
              className={`h-10 min-w-[220px] rounded-2xl border px-3 text-sm font-semibold outline-none ${fieldClass}`}
            />
            <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${statusClass}`}>
              {t(`suppliers.import.status.${row.status}`, row.status)}
            </span>
          </div>
          <p className={`mt-1 text-xs ${subtleClass}`}>
            {row.categoryPath.join(' / ') || t('suppliers.import.noCategory', 'No category')} - {row.barcode || row.sku || t('suppliers.import.noCode', 'No code')}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <input type="number" min="0" value={row.quantity} onChange={(event) => onChange(index, { quantity: toNumber(event.target.value, 0) })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} />
          <input type="number" min="0" value={row.cost} onChange={(event) => onChange(index, { cost: toNumber(event.target.value, 0) })} className={`h-10 rounded-2xl border px-3 text-sm outline-none ${fieldClass}`} />
          <select value={row.status} onChange={(event) => onChange(index, { status: event.target.value as ImportRowStatus })} className={`h-10 rounded-2xl border px-2 text-sm outline-none ${fieldClass}`}>
            <option value="create">{t('suppliers.import.status.create', 'Create')}</option>
            <option value="update">{t('suppliers.import.status.update', 'Update')}</option>
            <option value="skip">{t('suppliers.import.status.skip', 'Skip')}</option>
          </select>
        </div>
      </div>
      {[...row.errors, ...row.warnings].length > 0 && (
        <div className={`mt-2 rounded-2xl border px-3 py-2 text-xs ${row.errors.length > 0 ? (isDark ? 'border-red-500/30 text-red-200' : 'border-red-200 text-red-700') : (isDark ? 'border-amber-500/30 text-amber-200' : 'border-amber-200 text-amber-700')}`}>
          {[...row.errors, ...row.warnings].join(' ')}
        </div>
      )}
    </div>
  );
};

export default SuppliersPage;
