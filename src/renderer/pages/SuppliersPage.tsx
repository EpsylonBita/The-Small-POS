import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AnimatePresence, motion } from 'framer-motion';
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
  Search,
  Trash2,
  Truck,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../contexts/theme-context';
import { useOnBarcodeScan } from '../contexts/barcode-scanner-context';
import { formatCurrency, formatDate } from '../utils/format';
import { posApiGet, posApiPost } from '../utils/api-helpers';
import { extractSupplierImportFile } from '../utils/supplier-import-parser';

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

const getCurrencySymbol = (currency: string, locale?: string): string => {
  try {
    const parts = new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find(part => part.type === 'currency')?.value || currency;
  } catch {
    return currency;
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

const SuppliersPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'suppliers' | 'invoices'>('suppliers');
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

  const panelClass = isDark ? 'bg-zinc-950 border-zinc-800 text-white' : 'bg-white border-gray-200 text-gray-950';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const fieldClass = isDark
    ? 'bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500'
    : 'bg-white border-gray-200 text-gray-950 placeholder:text-gray-400';
  const iconButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 hover:bg-gray-100';
  const currencySymbol = useMemo(() => getCurrencySymbol(currencyCode, i18n.language), [currencyCode, i18n.language]);
  const formatMoney = useCallback((amount: number) => formatCurrency(amount, currencyCode, i18n.language), [currencyCode, i18n.language]);

  const selectedSupplier = useMemo(
    () => suppliers.find(supplier => supplier.id === selectedSupplierId) || suppliers[0] || null,
    [selectedSupplierId, suppliers]
  );

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

  const commitImport = async () => {
    if (!importDraft) return;
    setSaving(true);
    setImportError(null);
    try {
      const result = await posApiPost<{ success: boolean; result?: { createdInventoryCount: number; updatedInventoryCount: number }; error?: string }>(
        'pos/suppliers/import/commit',
        { draft: importDraft }
      );
      if (!result.success || !result.data?.result) {
        throw new Error(result.error || result.data?.error || 'Commit failed');
      }
      toast.success(t('suppliers.import.saved', 'Supplier items saved to inventory'));
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
        return isDark ? 'bg-blue-500/15 text-blue-200 border-blue-500/30' : 'bg-blue-50 text-blue-700 border-blue-200';
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
            <div className="flex min-w-0 items-center gap-3">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-100'}`}>
                <Truck className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-bold">{t('suppliers.title', 'Suppliers')}</h1>
                <p className={`truncate text-sm ${subtleClass}`}>{t('suppliers.subtitle', 'Manage suppliers, invoices, and imported inventory')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setImportOpen(true)}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${isDark ? 'border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25' : 'border-blue-200 bg-blue-600 text-white hover:bg-blue-700'}`}
              >
                <Upload className="h-4 w-4" />
                {t('suppliers.import.open', 'Import items')}
              </button>
              <button
                onClick={fetchData}
                disabled={loading}
                title={t('common.refresh', 'Refresh')}
                aria-label={t('common.refresh', 'Refresh')}
                className={`inline-flex h-12 w-12 items-center justify-center rounded-xl border transition ${iconButtonClass}`}
              >
                <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: t('suppliers.total', 'Total'), value: stats.totalSuppliers, icon: Building2, iconClass: 'bg-blue-500/15 text-blue-500' },
              { label: t('suppliers.active', 'Active'), value: stats.activeSuppliers, icon: CheckCircle, iconClass: 'bg-emerald-500/15 text-emerald-500' },
              { label: t('suppliers.unpaid', 'Unpaid'), value: stats.unpaidInvoices, icon: Clock, iconClass: 'bg-amber-500/15 text-amber-500' },
              { label: t('suppliers.overdue', 'Overdue'), value: stats.overdueInvoices, icon: AlertCircle, iconClass: 'bg-red-500/15 text-red-500' },
              { label: t('suppliers.owed', 'Total Owed'), value: formatMoney(stats.totalOwed), currency: true, iconClass: 'bg-cyan-500/15 text-cyan-500' },
            ].map(stat => {
              const Icon = 'icon' in stat ? stat.icon : null;
              return (
                <div key={stat.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center gap-2">
                    <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${stat.iconClass}`}>
                      {stat.currency ? (
                        <span className="text-lg font-bold leading-none">{currencySymbol}</span>
                      ) : Icon ? (
                        <Icon className="h-5 w-5" />
                      ) : null}
                    </div>
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
              <button onClick={fetchData} className={`rounded-lg border px-3 py-2 text-sm ${iconButtonClass}`}>
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        )}

        <section className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className={`flex min-h-0 flex-col rounded-2xl border ${panelClass}`}>
            <div className="shrink-0 border-b border-inherit p-3 md:p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className={`flex w-full rounded-xl border p-1 lg:w-auto ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-100'}`}>
                  {(['suppliers', 'invoices'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition ${activeTab === tab ? (isDark ? 'bg-white text-black' : 'bg-black text-white') : subtleClass}`}
                    >
                      {tab === 'suppliers' ? <Building2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                      {tab === 'suppliers' ? t('suppliers.suppliers', 'Suppliers') : t('suppliers.invoices.title', 'Invoices')}
                    </button>
                  ))}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row lg:max-w-2xl">
                  <div className={`relative min-w-0 flex-1 rounded-xl border ${fieldClass}`}>
                    <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${subtleClass}`} />
                    <input
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder={t('suppliers.search', 'Search suppliers or invoices')}
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
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-3 md:p-4">
              {loading ? (
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
                          className={`min-h-[180px] rounded-xl border p-4 text-left transition ${selectedSupplier?.id === supplier.id ? (isDark ? 'border-blue-500 bg-blue-500/10' : 'border-blue-500 bg-blue-50') : isDark ? 'border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-base font-bold">{supplier.name}</h3>
                              <p className={`mt-1 truncate text-xs ${subtleClass}`}>{supplier.supplier_code || supplier.category || t('suppliers.noCategory', 'No category')}</p>
                            </div>
                            <span className={`shrink-0 rounded-full border px-2 py-1 text-xs font-semibold ${supplier.is_active ? (isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700') : (isDark ? 'border-zinc-700 bg-zinc-800 text-zinc-300' : 'border-gray-200 bg-gray-100 text-gray-600')}`}>
                              {supplier.is_active ? t('suppliers.active', 'Active') : t('suppliers.inactive', 'Inactive')}
                            </span>
                          </div>
                          <div className={`mt-4 space-y-2 text-sm ${subtleClass}`}>
                            {(supplier.contact_person || supplier.contact_name) && <p className="truncate">{supplier.contact_person || supplier.contact_name}</p>}
                            {supplier.phone && <p className="flex items-center gap-2 truncate"><Phone className="h-4 w-4" />{supplier.phone}</p>}
                            {supplier.email && <p className="flex items-center gap-2 truncate"><Mail className="h-4 w-4" />{supplier.email}</p>}
                          </div>
                          <div className={`mt-4 grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs ${isDark ? 'border-zinc-800 bg-black/20' : 'border-gray-200 bg-gray-50'}`}>
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
                    title={t('suppliers.empty.title', 'No suppliers found')}
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
                        className={`rounded-xl border p-4 text-left transition ${isDark ? 'border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
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
                                  className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${isDark ? 'border-blue-500/30 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25' : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
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
                                  className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
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
                                className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${isDark ? 'border-amber-500/30 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25' : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
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
                  title={t('suppliers.invoices.emptyTitle', 'No invoices found')}
                  description={t('suppliers.invoices.emptyDescription', 'Supplier invoices will appear here when they sync from the admin dashboard.')}
                />
              )}
            </div>
          </div>

          <aside className={`hidden min-h-0 flex-col rounded-2xl border xl:flex ${panelClass}`}>
            <div className="border-b border-inherit p-4">
              <p className={`text-xs font-semibold uppercase ${subtleClass}`}>{t('suppliers.detail.title', 'Supplier detail')}</p>
              <h2 className="mt-1 truncate text-xl font-bold">{selectedSupplier?.name || t('suppliers.noSelection', 'No supplier selected')}</h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
              {selectedSupplier ? (
                <div className="space-y-4">
                  <InfoLine icon={<Building2 className="h-4 w-4" />} label={t('suppliers.code', 'Code')} value={selectedSupplier.supplier_code || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Phone className="h-4 w-4" />} label={t('suppliers.phone', 'Phone')} value={selectedSupplier.phone || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Mail className="h-4 w-4" />} label={t('suppliers.email', 'Email')} value={selectedSupplier.email || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<MapPin className="h-4 w-4" />} label={t('suppliers.address', 'Address')} value={selectedSupplier.address || '-'} subtleClass={subtleClass} />
                  <InfoLine icon={<Clock className="h-4 w-4" />} label={t('suppliers.paymentTerms', 'Payment terms')} value={selectedSupplier.payment_terms || '-'} subtleClass={subtleClass} />
                  <div className={`rounded-xl border p-4 ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-gray-200 bg-gray-50'}`}>
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
                  title={t('suppliers.detail.emptyTitle', 'Pick a supplier')}
                  description={t('suppliers.detail.emptyDescription', 'Supplier contact and invoice information will show here.')}
                />
              )}
            </div>
          </aside>
        </section>
      </div>

      <AnimatePresence>
        {supplierSummary && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSupplierSummaryId(null)}
          >
            <motion.div
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
                  <h2 className="mt-1 truncate text-2xl font-bold">{supplierSummary.supplier.name}</h2>
                  <p className={`mt-1 truncate text-sm ${subtleClass}`}>{supplierSummary.supplier.supplier_code || supplierSummary.supplier.category || t('suppliers.noCategory', 'No category')}</p>
                </div>
                <button
                  onClick={() => setSupplierSummaryId(null)}
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${iconButtonClass}`}
                  aria-label={t('common.close', 'Close')}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: t('suppliers.invoices.totalSpent', 'Total spent'), value: formatMoney(supplierSummary.totalSpent), currency: true },
                    { label: t('suppliers.invoices.paidTotal', 'Paid total'), value: formatMoney(supplierSummary.paidAmount), icon: CheckCircle },
                    { label: t('suppliers.invoices.unpaidTotal', 'Unpaid total'), value: formatMoney(supplierSummary.unpaidAmount), icon: Clock },
                    { label: t('suppliers.invoices.invoiceCount', 'Invoices'), value: supplierSummary.invoices.length, icon: Receipt },
                  ].map(tile => {
                    const Icon = 'icon' in tile ? tile.icon : null;
                    return (
                      <div key={tile.label} className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/70' : 'border-gray-200 bg-gray-50'}`}>
                        <div className="flex items-center gap-2">
                          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-200' : 'bg-white text-gray-700'}`}>
                            {tile.currency ? (
                              <span className="text-lg font-bold leading-none">{currencySymbol}</span>
                            ) : Icon ? (
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
                              className={`w-full rounded-xl border p-3 text-left transition ${isDark ? 'border-zinc-800 bg-zinc-900/70 hover:bg-zinc-900' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
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
                        title={t('suppliers.invoices.emptyTitle', 'No invoices found')}
                        description={t('suppliers.invoices.emptyDescription', 'Supplier invoices will appear here when they sync from the admin dashboard.')}
                      />
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {selectedInvoice && selectedInvoiceStatus && (
          <motion.div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedInvoiceId(null)}
          >
            <motion.div
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
                    <h2 className="truncate text-2xl font-bold">{formatDate(getInvoiceDisplayDate(selectedInvoice))}</h2>
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
                  className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${iconButtonClass}`}
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
                          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${isDark ? 'bg-zinc-800 text-zinc-200' : 'bg-white text-gray-700'}`}>
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
                            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold disabled:opacity-50 ${isDark ? 'border-blue-500/30 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25' : 'border-blue-200 bg-blue-600 text-white hover:bg-blue-700'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                            {t('suppliers.invoices.recordPayment', 'Record payment')}
                          </button>
                          <button
                            disabled={saving}
                            onClick={() => void recordInvoicePayment(selectedInvoiceRemaining)}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold disabled:opacity-50 ${isDark ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
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
                          <div key={payment.id} className={`rounded-lg border p-3 ${isDark ? 'border-zinc-800 bg-zinc-950' : 'border-gray-200 bg-white'}`}>
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
                        <p className={`rounded-lg border p-3 text-sm ${isDark ? 'border-zinc-800 bg-zinc-950 text-zinc-400' : 'border-gray-200 bg-white text-gray-500'}`}>
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

        {importOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 260 }}
              className={`flex h-full w-full max-w-7xl flex-col border-l ${panelClass}`}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-inherit p-4">
                <div>
                  <h2 className="text-xl font-bold">{t('suppliers.import.title', 'Import supplier items')}</h2>
                  <p className={`text-sm ${subtleClass}`}>{t('suppliers.import.subtitle', 'Review rows first, then sync stock to inventory.')}</p>
                </div>
                <button
                  onClick={() => setImportOpen(false)}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border ${iconButtonClass}`}
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
                            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${isDark ? 'border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25' : 'border-blue-200 bg-blue-600 text-white hover:bg-blue-700'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            {t('suppliers.import.preview', 'Preview')}
                          </button>
                          <button
                            onClick={commitImport}
                            disabled={saving || !importDraft || importDraft.rows.some(row => row.status === 'error')}
                            title={!importDraft ? t('suppliers.import.saveRequiresPreview', 'Preview the rows before saving to inventory.') : undefined}
                            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${isDark ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'border-emerald-200 bg-emerald-600 text-white hover:bg-emerald-700'}`}
                          >
                            {saving && importDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {importDraft ? t('suppliers.import.commit', 'Save to inventory') : t('suppliers.import.saveAfterPreview', 'Save after preview')}
                          </button>
                        </div>
                      </div>
                      {importError && (
                        <div className={`mx-3 mt-3 flex gap-2 rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-red-200 bg-red-50 text-red-800'}`}>
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
                            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold ${isDark ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50' : 'border-emerald-200 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50'}`}
                          >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {t('suppliers.import.commit', 'Save to inventory')}
                          </button>
                        </div>
                        <div className="max-h-[38vh] overflow-y-auto scrollbar-hide p-3">
                          {importDraft.missingCategories.length > 0 && (
                            <div className={`mb-3 rounded-lg border p-3 text-sm ${isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
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
      </AnimatePresence>
    </div>
  );
};

interface EmptyStateProps {
  isDark: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ isDark, icon, title, description }) => (
  <div className={`flex min-h-[260px] flex-col items-center justify-center rounded-xl border p-8 text-center ${isDark ? 'border-zinc-800 bg-zinc-900/40 text-zinc-300' : 'border-gray-200 bg-white text-gray-600'}`}>
    <div className={`mb-3 flex h-14 w-14 items-center justify-center rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>{icon}</div>
    <h3 className="text-base font-bold">{title}</h3>
    <p className="mt-1 max-w-sm text-sm">{description}</p>
  </div>
);

const InfoLine: React.FC<{ icon: React.ReactNode; label: string; value: string; subtleClass: string }> = ({ icon, label, value, subtleClass }) => (
  <div className="flex items-start gap-3">
    <div className={subtleClass}>{icon}</div>
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
  onChange: (index: number, patch: Partial<ImportRawRow>) => void;
  onRemove: (index: number) => void;
  t: TFunction;
}

const ImportRowEditor: React.FC<ImportRowEditorProps> = ({ row, index, fieldClass, subtleClass, iconButtonClass, isDark, onChange, onRemove, t }) => (
  <div className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-black/20' : 'border-gray-200 bg-gray-50'}`}>
    <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_120px_120px_86px_86px_42px]">
      <input
        value={row.name}
        onChange={(event) => onChange(index, { name: event.target.value })}
        className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.itemName', 'Item name')}
      />
      <input
        value={row.sku || ''}
        onChange={(event) => onChange(index, { sku: event.target.value })}
        className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.sku', 'SKU')}
      />
      <input
        value={row.barcode || ''}
        onChange={(event) => onChange(index, { barcode: event.target.value })}
        className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.barcode', 'Barcode')}
      />
      <input
        type="number"
        min="0"
        value={row.quantity}
        onChange={(event) => onChange(index, { quantity: toNumber(event.target.value, 0) })}
        className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.quantity', 'Qty')}
      />
      <input
        type="number"
        min="0"
        value={row.cost}
        onChange={(event) => onChange(index, { cost: toNumber(event.target.value, 0) })}
        className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`}
        placeholder={t('suppliers.import.cost', 'Cost')}
      />
      <button
        onClick={() => onRemove(index)}
        className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border ${iconButtonClass}`}
        aria-label={t('common.delete', 'Delete')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
    <div className="mt-2 grid gap-2 md:grid-cols-4">
      <input value={row.unit} onChange={(event) => onChange(index, { unit: event.target.value })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.unit', 'Unit')} />
      <input value={row.category || ''} onChange={(event) => onChange(index, { category: event.target.value })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.category', 'Category')} />
      <input value={row.subcategory || ''} onChange={(event) => onChange(index, { subcategory: event.target.value })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.subcategory', 'Subcategory')} />
      <input value={row.notes || ''} onChange={(event) => onChange(index, { notes: event.target.value })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} placeholder={t('suppliers.import.notes', 'Notes')} />
    </div>
    <p className={`mt-2 text-xs ${subtleClass}`}>{t('suppliers.import.rowNumber', 'Row')} {index + 1}</p>
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
      ? (isDark ? 'border-blue-500/30 bg-blue-500/10 text-blue-200' : 'border-blue-200 bg-blue-50 text-blue-700')
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
              className={`h-10 min-w-[220px] rounded-lg border px-3 text-sm font-semibold outline-none ${fieldClass}`}
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
          <input type="number" min="0" value={row.quantity} onChange={(event) => onChange(index, { quantity: toNumber(event.target.value, 0) })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} />
          <input type="number" min="0" value={row.cost} onChange={(event) => onChange(index, { cost: toNumber(event.target.value, 0) })} className={`h-10 rounded-lg border px-3 text-sm outline-none ${fieldClass}`} />
          <select value={row.status} onChange={(event) => onChange(index, { status: event.target.value as ImportRowStatus })} className={`h-10 rounded-lg border px-2 text-sm outline-none ${fieldClass}`}>
            <option value="create">{t('suppliers.import.status.create', 'Create')}</option>
            <option value="update">{t('suppliers.import.status.update', 'Update')}</option>
            <option value="skip">{t('suppliers.import.status.skip', 'Skip')}</option>
          </select>
        </div>
      </div>
      {[...row.errors, ...row.warnings].length > 0 && (
        <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${row.errors.length > 0 ? (isDark ? 'border-red-500/30 text-red-200' : 'border-red-200 text-red-700') : (isDark ? 'border-amber-500/30 text-amber-200' : 'border-amber-200 text-amber-700')}`}>
          {[...row.errors, ...row.warnings].join(' ')}
        </div>
      )}
    </div>
  );
};

export default SuppliersPage;
