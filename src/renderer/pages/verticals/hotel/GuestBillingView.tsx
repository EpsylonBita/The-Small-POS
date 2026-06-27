import React, { memo, useState, useEffect, useCallback, useId } from 'react';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { CreditCard, User, Calendar, Plus, Search, FileText, RefreshCw, AlertCircle, LogOut, X } from 'lucide-react';
import { getBridge, isBrowser } from '../../../../lib';
import { posApiGet, posApiFetch, posApiPost, isModuleRequiredApiError } from '../../../utils/api-helpers';
import {
  FOLIO_CHARGE_TYPES,
  FOLIO_PAYMENT_METHODS,
  FOLIO_STATUSES,
  FOLIO_STATUS_PRESENTATION,
  folioChargesEndpoint,
  folioCheckoutEndpoint,
  folioPaymentsEndpoint,
  isFolioStatus,
  parseFolioCheckoutOutstanding,
  summarizeFolios,
  type FolioChargeType,
  type FolioPaymentMethod,
  type FolioStatus,
} from '../../../utils/guest-billing';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';
import { formatCurrency } from '../../../utils/format';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

interface GuestFolio {
  id: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  roomNumber: string;
  roomId: string;
  checkIn: string;
  checkOut: string | null;
  /** Server truth - guest_folios DB CHECK (`active | closed | disputed`). */
  status: FolioStatus;
  totalCharges: number;
  totalPayments: number;
  balance: number;
  notes?: string | null;
  branchId: string;
  organizationId: string;
}

interface ApiFoliosResponse {
  success: boolean;
  folios: GuestFolio[];
  error?: string;
}

interface FolioTotalsPayload {
  id: string;
  total_charges: number;
  total_payments: number;
  balance: number;
  updated_at?: string;
}

interface FolioMutationResponse {
  success: boolean;
  error?: string;
  folio?: FolioTotalsPayload;
}

interface FolioCheckoutResponse {
  success: boolean;
  error?: string;
  reconciliation?: {
    status: string;
    paid?: boolean;
    total_charges?: number;
    total_payments?: number;
    balance?: number;
    check_out_date?: string;
  };
}

type FolioActionKind = 'charge' | 'payment';

interface FolioActionSubmit {
  kind: FolioActionKind;
  chargeType: FolioChargeType;
  description: string;
  amount: number;
  quantity: number;
  paymentMethod: FolioPaymentMethod;
  reference: string;
  notes: string;
}

const fieldClass = (isDark: boolean) =>
  `w-full px-3 py-2.5 rounded-xl text-sm border focus:outline-none focus:ring-2 focus:ring-yellow-400 ${
    isDark ? 'bg-zinc-900/60 border-white/10 text-zinc-100' : 'bg-white/75 border-gray-200/80 text-gray-900'
  }`;

const labelClass = (isDark: boolean) =>
  `block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`;

/**
 * Shared Add Charge / Add Payment modal posting to the existing POS folio
 * routes (hotel-rooms-full-pass Task 10.4 - Req 1.7 single shared folio
 * operable from desktop).
 */
const FolioActionModal: React.FC<{
  kind: FolioActionKind;
  folio: GuestFolio;
  isDark: boolean;
  initialAmount?: number | null;
  onClose: () => void;
  onSubmit: (input: FolioActionSubmit) => Promise<string | null>;
  t: TFunction;
}> = ({ kind, folio, isDark, initialAmount, onClose, onSubmit, t }) => {
  const titleId = useId();
  const [chargeType, setChargeType] = useState<FolioChargeType>('service');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(
    initialAmount && initialAmount > 0 ? initialAmount.toFixed(2) : '',
  );
  const [quantity, setQuantity] = useState('1');
  const [paymentMethod, setPaymentMethod] = useState<FolioPaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const chargeTypeLabels: Record<FolioChargeType, string> = {
    room: t('guestBilling.chargeTypes.room', { defaultValue: 'Room' }),
    food: t('guestBilling.chargeTypes.food', { defaultValue: 'Food' }),
    beverage: t('guestBilling.chargeTypes.beverage', { defaultValue: 'Beverage' }),
    service: t('guestBilling.chargeTypes.service', { defaultValue: 'Service' }),
    tax: t('guestBilling.chargeTypes.tax', { defaultValue: 'Tax' }),
    other: t('guestBilling.chargeTypes.other', { defaultValue: 'Other' }),
  };
  const paymentMethodLabels: Record<FolioPaymentMethod, string> = {
    cash: t('guestBilling.paymentMethods.cash', { defaultValue: 'Cash' }),
    card: t('guestBilling.paymentMethods.card', { defaultValue: 'Card' }),
    bank_transfer: t('guestBilling.paymentMethods.bankTransfer', { defaultValue: 'Bank Transfer' }),
    other: t('guestBilling.paymentMethods.other', { defaultValue: 'Other' }),
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setFormError(null);

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setFormError(t('guestBilling.validation.amount', { defaultValue: 'Enter an amount greater than zero.' }));
      return;
    }
    const parsedQuantity = Number(quantity || '1');
    if (kind === 'charge' && (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0)) {
      setFormError(t('guestBilling.validation.quantity', { defaultValue: 'Quantity must be greater than zero.' }));
      return;
    }
    if (kind === 'charge' && description.trim().length === 0) {
      setFormError(t('guestBilling.validation.description', { defaultValue: 'Description is required.' }));
      return;
    }

    setSubmitting(true);
    try {
      const error = await onSubmit({
        kind,
        chargeType,
        description: description.trim(),
        amount: parsedAmount,
        quantity: parsedQuantity,
        paymentMethod,
        reference: reference.trim(),
        notes: notes.trim(),
      });
      if (error) {
        setFormError(error);
        return;
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    kind === 'charge'
      ? t('guestBilling.chargeModal.title', { defaultValue: 'Add Charge' })
      : t('guestBilling.paymentModal.title', { defaultValue: 'Add Payment' });

  return renderModalPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-label={t('common.close', { defaultValue: 'Close' })}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full max-w-md max-h-[90vh] overflow-y-auto scrollbar-hide rounded-3xl border shadow-2xl backdrop-blur-2xl ring-1 ${
          isDark ? 'bg-zinc-900/70 border-white/10 ring-white/10 text-zinc-100' : 'bg-white/75 border-white/60 ring-white/50 text-gray-900'
        }`}
      >
        <div
          className={`sticky top-0 flex items-center justify-between p-4 border-b backdrop-blur-xl ${
            isDark ? 'border-white/10 bg-zinc-950/45' : 'border-white/45 bg-white/35'
          }`}
        >
          <div>
            <h2 id={titleId} className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{title}</h2>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {folio.guestName} - {t('guestBilling.room', { defaultValue: 'Room' })} {folio.roomNumber}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition-transform active:scale-95 ${isDark ? 'text-zinc-300 active:bg-white/10' : 'text-gray-600 active:bg-black/5'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {kind === 'charge' ? (
            <>
              <div>
                <label className={labelClass(isDark)}>
                  {t('guestBilling.fields.chargeType', { defaultValue: 'Charge Type' })}
                </label>
                <select
                  value={chargeType}
                  onChange={(e) => setChargeType(e.target.value as FolioChargeType)}
                  className={fieldClass(isDark)}
                >
                  {FOLIO_CHARGE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {chargeTypeLabels[type]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass(isDark)}>
                  {t('guestBilling.fields.description', { defaultValue: 'Description' })}{' '}
                  <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  className={fieldClass(isDark)}
                />
              </div>
            </>
          ) : (
            <div>
              <label className={labelClass(isDark)}>
                {t('guestBilling.fields.paymentMethod', { defaultValue: 'Payment Method' })}
              </label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as FolioPaymentMethod)}
                className={fieldClass(isDark)}
              >
                {FOLIO_PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {paymentMethodLabels[method]}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass(isDark)}>
                {t('guestBilling.fields.amount', { defaultValue: 'Amount' })}{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={fieldClass(isDark)}
              />
            </div>
            {kind === 'charge' ? (
              <div>
                <label className={labelClass(isDark)}>
                  {t('guestBilling.fields.quantity', { defaultValue: 'Quantity' })}
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className={fieldClass(isDark)}
                />
              </div>
            ) : (
              <div>
                <label className={labelClass(isDark)}>
                  {t('guestBilling.fields.reference', { defaultValue: 'Reference' })}
                </label>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={255}
                  className={fieldClass(isDark)}
                />
              </div>
            )}
          </div>

          <div>
            <label className={labelClass(isDark)}>
              {t('guestBilling.fields.notes', { defaultValue: 'Notes' })}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              rows={2}
              className={fieldClass(isDark)}
            />
          </div>

          {kind === 'payment' && (
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.outstandingBalanceLabel', { defaultValue: 'Outstanding balance' })}:{' '}
              <span className="font-medium">{formatCurrency(folio.balance)}</span>
            </p>
          )}

          {formError && (
            <div className="flex items-start gap-2 p-2 rounded-xl bg-red-500/10 text-red-500 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className={`flex-1 py-2.5 rounded-xl border font-medium transition-transform active:scale-95 ${isDark ? 'border-red-400/40 bg-red-500/15 text-red-200 active:bg-red-500/25' : 'border-red-500/40 bg-red-50 text-red-700 active:bg-red-100'} disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100`}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className={`flex-1 py-2.5 rounded-xl border font-medium transition-transform active:scale-95 ${
                kind === 'charge'
                  ? 'border-yellow-500 bg-yellow-400 text-black active:bg-yellow-500'
                  : 'border-green-600 bg-green-600 text-white active:bg-green-700'
              } disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100`}
            >
              {submitting
                ? t('common.loading', { defaultValue: 'Loading...' })
                : kind === 'charge'
                  ? t('guestBilling.chargeModal.submit', { defaultValue: 'Post Charge' })
                  : t('guestBilling.paymentModal.submit', { defaultValue: 'Post Payment' })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const GuestBillingView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { getSetting } = useTerminalSettings();
  const bridge = getBridge();
  const [folios, setFolios] = useState<GuestFolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFolio, setSelectedFolio] = useState<GuestFolio | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | FolioStatus>('all');
  const [actionModal, setActionModal] = useState<FolioActionKind | null>(null);
  const [paymentPrefill, setPaymentPrefill] = useState<number | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [outstandingNotice, setOutstandingNotice] = useState<{
    folioId: string;
    balance: number | null;
  } | null>(null);

  const fetchFolios = useCallback(async (options?: { silent?: boolean }) => {
    try {
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);

      // Get branch_id from terminal settings
      const branchId = getSetting<string>('terminal', 'branch_id', '');
      const params = new URLSearchParams();
      if (branchId) params.append('branch_id', branchId);

      const response = isBrowser()
        ? await posApiGet<ApiFoliosResponse>(
            `/pos/guest-billing?${params.toString()}`
          )
        : await bridge.adminApi.fetchFromAdmin(
            `/api/pos/guest-billing${params.toString() ? `?${params.toString()}` : ''}`,
            { method: 'GET' },
          ) as { success: boolean; data?: ApiFoliosResponse; error?: string };

      if (response.success && response.data?.folios) {
        setFolios(response.data.folios);
      } else {
        setError(response.error || response.data?.error || 'Failed to fetch guest folios');
      }
    } catch (err: any) {
      console.error('[GuestBillingView] Fetch error:', err);
      setError(err.message || 'Failed to fetch guest folios');
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [getSetting]);

  useEffect(() => {
    fetchFolios();
  }, [fetchFolios]);

  const isDark = resolvedTheme === 'dark';
  const formatMoney = (amount: number) => formatCurrency(amount);

  const moduleRequiredMessage = t('guestBilling.errors.moduleRequired', {
    defaultValue: 'The guest billing module is not active for this organization.',
  });

  /** Apply server-confirmed folio totals to the list and the open details panel. */
  const applyFolioTotals = useCallback((folioId: string, totals: FolioTotalsPayload) => {
    const patch = (folio: GuestFolio): GuestFolio => ({
      ...folio,
      totalCharges: Number(totals.total_charges) || 0,
      totalPayments: Number(totals.total_payments) || 0,
      balance: Number(totals.balance) || 0,
    });
    setFolios((prev) => prev.map((folio) => (folio.id === folioId ? patch(folio) : folio)));
    setSelectedFolio((prev) => (prev && prev.id === folioId ? patch(prev) : prev));
  }, []);

  const handleFolioAction = useCallback(
    async (folio: GuestFolio, input: FolioActionSubmit): Promise<string | null> => {
      const endpoint =
        input.kind === 'charge' ? folioChargesEndpoint(folio.id) : folioPaymentsEndpoint(folio.id);
      const body =
        input.kind === 'charge'
          ? {
              chargeType: input.chargeType,
              description: input.description,
              amount: input.amount,
              quantity: input.quantity,
              ...(input.notes ? { notes: input.notes } : {}),
            }
          : {
              amount: input.amount,
              paymentMethod: input.paymentMethod,
              reference: input.reference || null,
              notes: input.notes || null,
            };

      const response = await posApiPost<FolioMutationResponse>(endpoint, body);
      const payload = response.data;
      if (!response.success || payload?.success === false) {
        const message = response.error || payload?.error || null;
        if (isModuleRequiredApiError(message)) {
          return moduleRequiredMessage;
        }
        return (
          message ||
          t('guestBilling.errors.actionFailed', { defaultValue: 'Failed to update the folio.' })
        );
      }

      if (payload?.folio) {
        applyFolioTotals(folio.id, payload.folio);
      }
      setOutstandingNotice((prev) => (prev?.folioId === folio.id ? null : prev));
      toast.success(
        input.kind === 'charge'
          ? t('guestBilling.chargeModal.success', { defaultValue: 'Charge posted to folio' })
          : t('guestBilling.paymentModal.success', { defaultValue: 'Payment posted to folio' }),
      );
      void fetchFolios({ silent: true });
      return null;
    },
    [applyFolioTotals, fetchFolios, moduleRequiredMessage, t],
  );

  const handleCheckout = useCallback(
    async (folio: GuestFolio) => {
      if (checkoutBusy) return;
      setCheckoutBusy(true);
      try {
        const response = await posApiFetch<FolioCheckoutResponse>(folioCheckoutEndpoint(folio.id), {
          method: 'POST',
          body: JSON.stringify({ resolution: 'close_paid' }),
        });
        const payload = response.data;

        if (response.success && payload?.success !== false) {
          const reconciledStatus = payload?.reconciliation?.status;
          const nextStatus: FolioStatus = isFolioStatus(reconciledStatus)
            ? reconciledStatus
            : 'closed';
          const checkOutDate = payload?.reconciliation?.check_out_date ?? null;
          const patch = (entry: GuestFolio): GuestFolio => ({
            ...entry,
            status: nextStatus,
            checkOut: checkOutDate ?? entry.checkOut,
            totalCharges: Number(payload?.reconciliation?.total_charges ?? entry.totalCharges) || 0,
            totalPayments: Number(payload?.reconciliation?.total_payments ?? entry.totalPayments) || 0,
            balance: Number(payload?.reconciliation?.balance ?? 0) || 0,
          });
          setFolios((prev) => prev.map((entry) => (entry.id === folio.id ? patch(entry) : entry)));
          setSelectedFolio((prev) => (prev && prev.id === folio.id ? patch(prev) : prev));
          setOutstandingNotice((prev) => (prev?.folioId === folio.id ? null : prev));
          toast.success(
            t('guestBilling.checkoutModal.success', { defaultValue: 'Guest checked out' }),
          );
          void fetchFolios({ silent: true });
          return;
        }

        const message = response.error || payload?.error || null;
        if (isModuleRequiredApiError(message)) {
          toast.error(moduleRequiredMessage);
          return;
        }

        // 409 outstanding balance - surface the balance and steer the user
        // to Add Payment first (Req 2.3 flavor of the folio checkout flow).
        const outstanding = parseFolioCheckoutOutstanding(message, response.status);
        if (outstanding.outstanding) {
          setOutstandingNotice({ folioId: folio.id, balance: outstanding.balance });
          setPaymentPrefill(outstanding.balance ?? folio.balance);
          setActionModal('payment');
          toast.error(
            t('guestBilling.checkoutModal.outstanding', {
              defaultValue: 'Outstanding balance of {{balance}} - collect a payment first.',
              balance: formatCurrency(outstanding.balance ?? folio.balance),
            }),
          );
          return;
        }

        toast.error(
          message ||
            t('guestBilling.errors.actionFailed', { defaultValue: 'Failed to update the folio.' }),
        );
      } catch (err: any) {
        console.error('[GuestBillingView] Checkout error:', err);
        toast.error(
          err?.message ||
            t('guestBilling.errors.actionFailed', { defaultValue: 'Failed to update the folio.' }),
        );
      } finally {
        setCheckoutBusy(false);
      }
    },
    [checkoutBusy, fetchFolios, moduleRequiredMessage, t],
  );

  const filteredFolios = folios.filter(f => {
    const matchesSearch = f.guestName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          f.roomNumber.includes(searchTerm);
    const matchesStatus = statusFilter === 'all' || f.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statusLabel = (status: FolioStatus) => {
    const presentation = FOLIO_STATUS_PRESENTATION[status] ?? FOLIO_STATUS_PRESENTATION.active;
    return t(presentation.labelKey, { defaultValue: presentation.defaultLabel });
  };
  const statusBadgeClass = (status: FolioStatus) =>
    (FOLIO_STATUS_PRESENTATION[status] ?? FOLIO_STATUS_PRESENTATION.active).badgeClass;

  const stats = summarizeFolios(folios);

  // Loading state
  if (loading) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex items-center justify-center">
        <motion.div variants={pageMotionItem} className="text-center">
          <RefreshCw className={`w-8 h-8 animate-spin mx-auto mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
          <p className={isDark ? 'text-gray-400' : 'text-gray-500'}>
            {t('common.loading', { defaultValue: 'Loading...' })}
          </p>
        </motion.div>
      </motion.div>
    );
  }

  // Error state
  if (error) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex items-center justify-center">
        <motion.div variants={pageMotionItem} className={`text-center p-6 rounded-3xl border ${isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-white/80 border-white/60 shadow-lg'}`}>
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <p className={`font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('guestBilling.error.title', { defaultValue: 'Failed to load guest folios' })}
          </p>
          <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
          <button
            type="button"
            onClick={() => fetchFolios()}
            className="px-4 py-2 bg-yellow-400 text-black rounded-xl border border-yellow-500 font-medium transition-transform active:scale-95 active:bg-yellow-500"
          >
            {t('common.retry', { defaultValue: 'Retry' })}
          </button>
        </motion.div>
      </motion.div>
    );
  }

  // Empty state
  if (folios.length === 0) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex items-center justify-center">
        <motion.div variants={pageMotionItem} className="text-center">
          <User className={`w-12 h-12 mx-auto mb-3 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
          <p className={`font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('guestBilling.empty.title', { defaultValue: 'No guest folios' })}
          </p>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {t('guestBilling.empty.description', { defaultValue: 'Guest folios will appear here when created.' })}
          </p>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col gap-4 p-4">
      <motion.div variants={pageMotionItem} className="min-w-0">
        <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('navigation.menu.guest_billing', { defaultValue: 'Guest Billing' })}
        </h1>
      </motion.div>
      <div className="flex min-h-0 flex-1 gap-4">
      {/* Left Panel - Folio List */}
      <motion.div variants={pageMotionItem} className="flex-1 flex flex-col min-w-0">
        {/* Stats */}
        <motion.div variants={pageMotionContainer} className="flex gap-4 mb-4">
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border ${isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-white/80 border-gray-200 shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.activeFolios', { defaultValue: 'Active Folios' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.activeCount}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border ${isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-white/80 border-gray-200 shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.outstandingBalance', { defaultValue: 'Outstanding Balance' })}
            </div>
            <div className={`text-xl font-bold text-amber-500`}>{formatMoney(stats.activeBalance)}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border ${isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-white/80 border-gray-200 shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.stats.disputed', { defaultValue: 'Disputed' })}
            </div>
            <div className={`text-xl font-bold text-red-500`}>{stats.disputedCount}</div>
          </motion.div>
        </motion.div>

        {/* Search & Filters */}
        <motion.div variants={pageMotionItem} className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('guestBilling.searchPlaceholder', { defaultValue: 'Search guest or room...' })}
              className={`w-full pl-10 pr-4 py-2 rounded-xl ${isDark ? 'bg-zinc-900/70 text-white border-white/10' : 'bg-white text-gray-900 border-gray-200'} border focus:outline-none focus:ring-2 focus:ring-yellow-400`}
            />
          </div>
          {(['all', ...FOLIO_STATUSES] as const).map(status => (
            <motion.button
              variants={pageMotionItem}
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-2 rounded-xl text-sm transition-transform active:scale-95 ${
                statusFilter === status
                  ? 'bg-yellow-400 text-black border border-yellow-500'
                  : isDark ? 'bg-zinc-900/70 text-gray-300 border border-white/10 active:bg-white/10' : 'bg-gray-100 text-gray-600 border border-gray-200 active:bg-white'
              }`}
            >
              {status === 'all' ? t('common.all', { defaultValue: 'All' }) : statusLabel(status)}
            </motion.button>
          ))}
        </motion.div>

        {/* Folio List */}
        <motion.div variants={pageMotionContainer} className="flex-1 overflow-y-auto scrollbar-hide space-y-2">
          {filteredFolios.map(folio => (
            <motion.button
              variants={pageMotionItem}
              key={folio.id}
              type="button"
              onClick={() => setSelectedFolio(folio)}
              className={`w-full p-4 rounded-2xl text-left transition-transform active:scale-[0.99] border ${
                selectedFolio?.id === folio.id ? 'ring-2 ring-yellow-400' : ''
              } ${isDark ? 'bg-zinc-900/70 border-white/10 active:bg-white/10' : 'bg-white border-gray-200 shadow-sm active:bg-gray-50'}`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <User className={`w-4 h-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{folio.guestName}</span>
                </div>
                <span className={`px-2 py-1 rounded text-xs ${statusBadgeClass(folio.status)}`}>
                  {statusLabel(folio.status)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                  {t('guestBilling.room', { defaultValue: 'Room' })} {folio.roomNumber}
                </span>
                <span className={`font-bold ${folio.balance > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                  {formatMoney(folio.balance)}
                </span>
              </div>
            </motion.button>
          ))}
        </motion.div>
      </motion.div>

      {/* Right Panel - Folio Details */}
      {selectedFolio && (
        <motion.div variants={pageMotionItem} className={`w-96 rounded-3xl border p-4 flex flex-col min-h-0 ${isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-white/85 border-gray-200 shadow-lg'}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('guestBilling.folioDetails', { defaultValue: 'Folio Details' })}
            </h3>
            <button
              type="button"
              onClick={() => setSelectedFolio(null)}
              aria-label={t('common.close', { defaultValue: 'Close' })}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition-transform active:scale-95 ${isDark ? 'text-gray-400 active:bg-white/10' : 'text-gray-500 active:bg-black/5'}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Guest Info */}
          <div className={`p-3 rounded-2xl mb-4 border ${isDark ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center justify-between">
              <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedFolio.guestName}</div>
              <span className={`px-2 py-1 rounded text-xs ${statusBadgeClass(selectedFolio.status)}`}>
                {statusLabel(selectedFolio.status)}
              </span>
            </div>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('guestBilling.room', { defaultValue: 'Room' })} {selectedFolio.roomNumber}
            </div>
            {selectedFolio.guestEmail && (
              <div className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {selectedFolio.guestEmail}
              </div>
            )}
            {selectedFolio.guestPhone && (
              <div className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {selectedFolio.guestPhone}
              </div>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs">
              <span className={`flex items-center gap-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                <Calendar className="w-3 h-3" />
                {selectedFolio.checkIn} - {selectedFolio.checkOut || t('guestBilling.ongoing', { defaultValue: 'Ongoing' })}
              </span>
            </div>
          </div>

          {/* Totals Summary */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <div className="space-y-3 mb-4">
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.totalCharges', { defaultValue: 'Total Charges' })}
                </span>
                <span className={isDark ? 'text-white' : 'text-gray-900'}>
                  {formatMoney(selectedFolio.totalCharges)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.totalPayments', { defaultValue: 'Total Payments' })}
                </span>
                <span className="text-green-500">
                  -{formatMoney(selectedFolio.totalPayments)}
                </span>
              </div>
            </div>
            {selectedFolio.notes && (
              <div className={`p-2 rounded-xl text-sm ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}>
                <div className={`text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  {t('guestBilling.notes', { defaultValue: 'Notes' })}
                </div>
                <div className={isDark ? 'text-gray-300' : 'text-gray-600'}>{selectedFolio.notes}</div>
              </div>
            )}
          </div>

          {/* Balance & Actions */}
          <div className={`pt-4 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
            {outstandingNotice && outstandingNotice.folioId === selectedFolio.id && (
              <div className="flex items-start gap-2 p-2 mb-3 rounded-xl bg-amber-500/10 text-amber-500 text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  {t('guestBilling.checkoutModal.outstanding', {
                    defaultValue: 'Outstanding balance of {{balance}} - collect a payment first.',
                    balance: formatCurrency(outstandingNotice.balance ?? selectedFolio.balance),
                  })}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between mb-4">
              <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('guestBilling.balance', { defaultValue: 'Balance' })}
              </span>
              <span className="text-xl font-bold text-amber-500">{formatMoney(selectedFolio.balance)}</span>
            </div>
            {selectedFolio.status === 'active' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentPrefill(null);
                      setActionModal('charge');
                    }}
                    className="flex items-center justify-center gap-2 py-2 rounded-xl border border-yellow-500 bg-yellow-400 text-black font-medium transition-transform active:scale-95 active:bg-yellow-500"
                  >
                    <Plus className="w-4 h-4" />
                    {t('guestBilling.addCharge', { defaultValue: 'Add Charge' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentPrefill(selectedFolio.balance > 0 ? selectedFolio.balance : null);
                      setActionModal('payment');
                    }}
                    className="flex items-center justify-center gap-2 py-2 rounded-xl bg-green-600 text-white font-medium transition-transform active:scale-95 active:bg-green-700"
                  >
                    <CreditCard className="w-4 h-4" />
                    {t('guestBilling.payment', { defaultValue: 'Payment' })}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => handleCheckout(selectedFolio)}
                  disabled={checkoutBusy}
                  className={`w-full mt-2 py-2 rounded-xl flex items-center justify-center gap-2 bg-amber-600 text-white font-medium transition-transform active:scale-95 active:bg-amber-700 ${
                    checkoutBusy ? 'opacity-60' : ''
                  }`}
                >
                  <LogOut className="w-4 h-4" />
                  {checkoutBusy
                    ? t('common.loading', { defaultValue: 'Loading...' })
                    : t('guestBilling.checkout', { defaultValue: 'Checkout' })}
                </button>
              </>
            )}
            <button type="button" className={`w-full mt-2 py-2 rounded-xl flex items-center justify-center gap-2 transition-transform active:scale-95 ${
              isDark ? 'bg-white/10 text-white active:bg-white/15' : 'bg-gray-100 text-gray-700 active:bg-gray-200'
            }`}>
              <FileText className="w-4 h-4" />
              {t('guestBilling.printFolio', { defaultValue: 'Print Folio' })}
            </button>
          </div>
        </motion.div>
      )}
      </div>

      {actionModal && selectedFolio && (
        <FolioActionModal
          kind={actionModal}
          folio={selectedFolio}
          isDark={isDark}
          initialAmount={actionModal === 'payment' ? paymentPrefill : null}
          onClose={() => {
            setActionModal(null);
            setPaymentPrefill(null);
          }}
          onSubmit={(input) => handleFolioAction(selectedFolio, input)}
          t={t}
        />
      )}
    </motion.div>
  );
});

GuestBillingView.displayName = 'GuestBillingView';
export default GuestBillingView;
