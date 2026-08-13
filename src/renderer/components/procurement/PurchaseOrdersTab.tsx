/**
 * Purchase Orders tab on the POS suppliers surface
 * (procurement-loop Tasks 10.2 + 10.4).
 *
 * View + receive only — POS never creates or edits purchase orders
 * [R10.4]. The list and detail render from the locally persisted
 * snapshot (`purchase-order-snapshot.ts`), so the surface works offline
 * with a staleness label [R11.1]; receipts recorded offline queue
 * durably (`offline-mutations.ts` → `po_receipts`) and render
 * immediately as optimistic "pending sync" entries that adjust the
 * remaining quantities locally, with parked (MODULE_REQUIRED) and
 * needs-attention (PO_STATE_CONFLICT / dead-letter) states surfaced
 * from the queue rows themselves [R11.6, R11.7].
 *
 * The tab renders only when the `suppliers` module is enabled for the
 * org AND this terminal (module-context reflects the terminal filter
 * through the existing module-sync path) [R12.5, R12.6]. Isolated from
 * checkout/order flows — failures degrade only this surface [R16.6].
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  Truck,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTheme } from '../../contexts/theme-context';
import { useModules } from '../../contexts/module-context';
import { useShift } from '../../contexts/shift-context';
import { onEvent, offEvent } from '../../../lib';
import { formatCurrency, formatDate } from '../../utils/format';
import { posApiPost, isModuleRequiredApiError } from '../../utils/api-helpers';
import { renderModalPortal } from '../../utils/render-modal-portal';
import {
  PURCHASE_ORDER_SNAPSHOT_EVENT,
  loadPurchaseOrderSnapshot,
  syncPurchaseOrderSnapshot,
  type PosPurchaseOrder,
  type PosPurchaseOrderItem,
  type PurchaseOrderSnapshot,
} from '../../services/purchase-order-snapshot';
import {
  listQueuedPoReceipts,
  pendingQuantitiesByItem,
  retryQueuedPoReceipt,
  type QueuedPoReceipt,
} from '../../services/po-receipt-queue';
import { offlineCommitPoReceipt } from '../../services/offline-mutations';
import { PARITY_QUEUE_STATUS_EVENT } from '../../services/ParitySyncCoordinator';
import type { PurchaseOrderStatus } from '../../../../../shared/types/procurement';

const RECEIVABLE_STATUSES: PurchaseOrderStatus[] = ['ordered', 'partially_received'];

interface ReceiveLineDraft {
  quantity: string;
  unitCost: string;
  confirmOverReceipt: boolean;
}

type ReceiveOutcome =
  | { type: 'conflict'; poStatus: string | null }
  | { type: 'module_required' }
  | { type: 'confirmation_required' }
  | { type: 'rejected'; message: string }
  | { type: 'transport' };

/**
 * Classify a failed receipts POST by status + error text. Missing HTTP
 * status means the request never reached the server (transport) — safe
 * to queue offline with the SAME capture-time key: if the request did
 * land, the server collapses the replay. [R11.4]
 */
export function classifyReceiveFailure(result: {
  error?: string;
  status?: number;
}): ReceiveOutcome {
  const error = result.error ?? '';
  if (isModuleRequiredApiError(error)) {
    return { type: 'module_required' };
  }
  if (result.status === 409 || error.includes('PO_STATE_CONFLICT')) {
    const match = error.match(/"poStatus"\s*:\s*"([a-z_]+)"/);
    return { type: 'conflict', poStatus: match?.[1] ?? null };
  }
  if (
    result.status === 422 ||
    error.includes('OVER_RECEIPT_CONFIRMATION_REQUIRED') ||
    error.includes('UNPLANNED_LINE_CONFIRMATION_REQUIRED')
  ) {
    return { type: 'confirmation_required' };
  }
  if (typeof result.status === 'number') {
    return { type: 'rejected', message: error };
  }
  return { type: 'transport' };
}

function toQuantity(value: string): number {
  const parsed = Number((value || '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusChipClasses(status: PurchaseOrderStatus, isDark: boolean): string {
  if (status === 'ordered') {
    return isDark ? 'bg-sky-900/50 text-sky-200' : 'bg-sky-100 text-sky-800';
  }
  if (status === 'partially_received') {
    return isDark ? 'bg-amber-900/50 text-amber-200' : 'bg-amber-100 text-amber-800';
  }
  if (status === 'received_closed') {
    return isDark ? 'bg-emerald-900/50 text-emerald-200' : 'bg-emerald-100 text-emerald-800';
  }
  if (status === 'cancelled') {
    return isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-200 text-gray-600';
  }
  return isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-700';
}

const PurchaseOrdersTab: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { isModuleEnabled } = useModules();
  const { staff } = useShift();
  const isDark = resolvedTheme === 'dark';

  const [snapshot, setSnapshot] = useState<PurchaseOrderSnapshot>(() =>
    loadPurchaseOrderSnapshot(),
  );
  const [queuedReceipts, setQueuedReceipts] = useState<QueuedPoReceipt[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PurchaseOrderStatus>('all');
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [refreshing, setRefreshing] = useState(false);

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveLines, setReceiveLines] = useState<Record<string, ReceiveLineDraft>>({});
  const [receiveNotes, setReceiveNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // Capture-time idempotency key: generated when the dialog opens and
  // kept across retries of the same capture (a failed commit rolls the
  // server's key reservation back), cleared only on success/close. [R11.4]
  const receiveKeyRef = useRef<string | null>(null);
  const receiveDialogRef = useRef<HTMLDivElement>(null);
  const receiveTitleId = useId();

  const refreshQueuedReceipts = useCallback(async () => {
    try {
      setQueuedReceipts(await listQueuedPoReceipts());
    } catch {
      // Queue inspection is advisory — the queue itself is durable.
    }
  }, []);

  useEffect(() => {
    const handleSnapshot = (next: PurchaseOrderSnapshot) => setSnapshot(next);
    const handleQueueStatus = () => {
      void refreshQueuedReceipts();
    };
    onEvent(PURCHASE_ORDER_SNAPSHOT_EVENT, handleSnapshot);
    onEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueStatus);
    void refreshQueuedReceipts();
    // Kick a snapshot refresh on mount; offline this resolves to the
    // stored snapshot without advancing the cursor.
    void syncPurchaseOrderSnapshot().catch(() => undefined);
    return () => {
      offEvent(PURCHASE_ORDER_SNAPSHOT_EVENT, handleSnapshot);
      offEvent(PARITY_QUEUE_STATUS_EVENT, handleQueueStatus);
    };
  }, [refreshQueuedReceipts]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const purchaseOrders = snapshot.purchaseOrders;

  const selectedPo = useMemo(
    () => purchaseOrders.find((po) => po.id === selectedPoId) ?? null,
    [purchaseOrders, selectedPoId],
  );

  const filteredOrders = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return purchaseOrders.filter((po) => {
      const matchesSearch =
        !needle ||
        po.orderReference.toLowerCase().includes(needle) ||
        (po.supplierName ?? '').toLowerCase().includes(needle);
      const matchesStatus = statusFilter === 'all' || po.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [purchaseOrders, searchTerm, statusFilter]);

  const selectedPending = useMemo(
    () => (selectedPo ? pendingQuantitiesByItem(selectedPo, queuedReceipts) : new Map<string, number>()),
    [selectedPo, queuedReceipts],
  );

  const selectedQueuedReceipts = useMemo(
    () =>
      selectedPo
        ? queuedReceipts.filter((receipt) => receipt.purchaseOrderId === selectedPo.id)
        : [],
    [selectedPo, queuedReceipts],
  );

  const staffId = staff?.databaseStaffId || staff?.staffId || null;

  const panelClass = isDark
    ? 'bg-zinc-950 border-zinc-800 text-white'
    : 'bg-white border-gray-200 text-gray-950';
  const subtleClass = isDark ? 'text-zinc-400' : 'text-gray-500';
  const fieldClass = isDark
    ? 'bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-500'
    : 'bg-white border-gray-200 text-gray-950 placeholder:text-gray-400';
  const iconButtonClass = isDark
    ? 'border-zinc-800 bg-zinc-900 text-zinc-100 active:bg-zinc-800'
    : 'border-gray-200 bg-white text-gray-800 active:bg-gray-100';

  const formatMoney = useCallback(
    (amount: number) => formatCurrency(amount, 'EUR', i18n.language),
    [i18n.language],
  );
  const formatShortDate = useCallback(
    (value: string | null) =>
      value
        ? formatDate(value, { day: '2-digit', month: 'short', year: 'numeric' }, i18n.language)
        : '—',
    [i18n.language],
  );

  const closeReceive = useCallback(() => {
    setReceiveOpen(false);
    setDialogError(null);
    receiveKeyRef.current = null;
  }, []);

  // Escape closes the receive dialog through the shared topmost-dialog gate.
  useEffect(() => {
    if (!receiveOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== receiveDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeReceive();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [receiveOpen, closeReceive]);

  const openReceive = useCallback(() => {
    if (!selectedPo) {
      return;
    }
    const drafts: Record<string, ReceiveLineDraft> = {};
    for (const item of selectedPo.items) {
      // Default each line to its remaining quantity, minus what is
      // already queued locally so a second offline capture cannot
      // double-receive the same goods. [R6.1, R11.1]
      const pendingQty = selectedPending.get(item.id) ?? 0;
      const remaining = Math.max(item.remainingQuantity - pendingQty, 0);
      drafts[item.id] = {
        quantity: String(remaining),
        unitCost: item.expectedUnitCost !== null ? String(item.expectedUnitCost) : '',
        confirmOverReceipt: false,
      };
    }
    setReceiveLines(drafts);
    setReceiveNotes('');
    setDialogError(null);
    receiveKeyRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setReceiveOpen(true);
  }, [selectedPo, selectedPending]);

  const submitReceive = useCallback(async () => {
    if (!selectedPo || submitting) {
      return;
    }
    if (!staffId) {
      toast.error(
        t('procurement.receive.noStaff', 'Sign in with a staff PIN to record receipts.'),
      );
      return;
    }

    const lines = selectedPo.items
      .map((item) => {
        const draft = receiveLines[item.id];
        const quantity = draft ? toQuantity(draft.quantity) : 0;
        if (!draft || quantity === 0) {
          return null;
        }
        const unitCost = draft.unitCost.trim() ? toQuantity(draft.unitCost) : null;
        return {
          purchaseOrderItemId: item.id,
          quantityReceived: quantity,
          ...(unitCost !== null && unitCost >= 0 ? { unitCost } : {}),
          ...(draft.confirmOverReceipt ? { confirmOverReceipt: true } : {}),
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);

    if (lines.length === 0) {
      setDialogError(t('procurement.receive.noLines', 'Enter at least one received quantity.'));
      return;
    }

    const idempotencyKey = receiveKeyRef.current;
    if (!idempotencyKey) {
      return;
    }
    const recordedAt = new Date().toISOString();
    const notes = receiveNotes.trim() || undefined;

    setSubmitting(true);
    setDialogError(null);

    const queueOffline = async () => {
      await offlineCommitPoReceipt({
        purchaseOrderId: selectedPo.id,
        staffId,
        lines,
        idempotencyKey,
        recordedAt,
        kind: 'delivery',
        notes: notes ?? null,
      });
      toast.success(
        t('procurement.receive.queuedOffline', 'Receipt saved locally and queued for sync.'),
      );
      receiveKeyRef.current = null;
      setReceiveOpen(false);
      await refreshQueuedReceipts();
    };

    try {
      if (!isOnline) {
        await queueOffline();
        return;
      }

      const result = await posApiPost(
        `pos/purchase-orders/${encodeURIComponent(selectedPo.id)}/receipts`,
        {
          idempotencyKey,
          staffId,
          source: 'pos_desktop',
          recordedAt,
          kind: 'delivery',
          ...(notes ? { notes } : {}),
          lines,
        },
      );

      if (result.success) {
        const wasReplay = Boolean(
          (result.data as { wasReplay?: boolean } | undefined)?.wasReplay,
        );
        toast.success(
          wasReplay
            ? t('procurement.receive.replayed', 'Receipt was already recorded.')
            : t('procurement.receive.recorded', 'Receipt recorded.'),
        );
        receiveKeyRef.current = null;
        setReceiveOpen(false);
        await syncPurchaseOrderSnapshot().catch(() => undefined);
        return;
      }

      const outcome = classifyReceiveFailure(result);
      if (outcome.type === 'transport') {
        // Never reached the server — queue with the SAME key. [R11.4]
        await queueOffline();
        return;
      }
      if (outcome.type === 'conflict') {
        setDialogError(
          t('procurement.receive.conflict', {
            defaultValue:
              'This purchase order changed on the server ({{status}}). The receipt was not applied.',
            status: outcome.poStatus
              ? t(`procurement.status.${outcome.poStatus}`, outcome.poStatus)
              : t('procurement.status.cancelled', 'Cancelled'),
          }),
        );
        return;
      }
      if (outcome.type === 'module_required') {
        setDialogError(
          t(
            'procurement.receive.moduleRequired',
            'The suppliers module is not active for this terminal.',
          ),
        );
        return;
      }
      if (outcome.type === 'confirmation_required') {
        setDialogError(
          t(
            'procurement.receive.confirmationRequired',
            'Confirm the flagged lines and submit again.',
          ),
        );
        return;
      }
      setDialogError(
        outcome.message || t('procurement.receive.failed', 'Failed to record the receipt.'),
      );
    } catch (error) {
      console.error('Failed to record purchase order receipt:', error);
      setDialogError(t('procurement.receive.failed', 'Failed to record the receipt.'));
    } finally {
      setSubmitting(false);
    }
  }, [
    isOnline,
    receiveLines,
    receiveNotes,
    refreshQueuedReceipts,
    selectedPo,
    staffId,
    submitting,
    t,
  ]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncPurchaseOrderSnapshot();
      await refreshQueuedReceipts();
    } finally {
      setRefreshing(false);
    }
  }, [refreshQueuedReceipts]);

  const handleRetryQueued = useCallback(
    async (queueId: string) => {
      try {
        await retryQueuedPoReceipt(queueId);
        toast.success(t('procurement.pending.retryQueued', 'Receipt queued for retry.'));
        await refreshQueuedReceipts();
      } catch {
        toast.error(t('procurement.receive.failed', 'Failed to record the receipt.'));
      }
    },
    [refreshQueuedReceipts, t],
  );

  // Module gating belt-and-braces: the suppliers view itself is already
  // module-guarded by the layout; this keeps the tab inert if it is ever
  // composed elsewhere. [R12.1, R12.5]
  if (!isModuleEnabled('suppliers')) {
    return null;
  }

  const renderStatusChip = (status: PurchaseOrderStatus) => (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusChipClasses(status, isDark)}`}
    >
      {t(`procurement.status.${status}`, status)}
    </span>
  );

  const renderItemRow = (item: PosPurchaseOrderItem) => {
    const pendingQty = selectedPending.get(item.id) ?? 0;
    const remaining = Math.max(item.remainingQuantity - pendingQty, 0);
    return (
      <div
        key={item.id}
        className={`grid grid-cols-[minmax(0,1fr)_repeat(3,72px)] items-center gap-2 rounded-xl border p-3 text-sm ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}
      >
        <div className="min-w-0">
          <p className="truncate font-semibold">{item.itemNameSnapshot}</p>
          <p className={`truncate text-xs ${subtleClass}`}>
            {t(`procurement.flavor.${item.flavor}`, item.flavor)}
            {item.unit ? ` · ${item.unit}` : ''}
            {item.expectedUnitCost !== null ? ` · ${formatMoney(item.expectedUnitCost)}` : ''}
            {item.isUnplanned ? ` · ${t('procurement.detail.unplanned', 'Unplanned')}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className={`text-[11px] uppercase ${subtleClass}`}>
            {t('procurement.detail.orderedQty', 'Ordered')}
          </p>
          <p className="font-semibold">{item.quantityOrdered}</p>
        </div>
        <div className="text-right">
          <p className={`text-[11px] uppercase ${subtleClass}`}>
            {t('procurement.detail.receivedQty', 'Received')}
          </p>
          <p className="font-semibold">
            {item.quantityReceived}
            {pendingQty > 0 && (
              <span className={isDark ? 'text-amber-300' : 'text-amber-600'}> +{pendingQty}</span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className={`text-[11px] uppercase ${subtleClass}`}>
            {t('procurement.detail.remainingQty', 'Remaining')}
          </p>
          <p className="font-semibold">{remaining}</p>
        </div>
      </div>
    );
  };

  const renderQueuedReceiptCard = (receipt: QueuedPoReceipt) => {
    const isAttention = receipt.state === 'conflict' || receipt.state === 'failed';
    const cardClass = isAttention
      ? isDark
        ? 'border-red-900 bg-red-950/30 text-red-100'
        : 'border-red-200 bg-red-50 text-red-800'
      : isDark
        ? 'border-amber-900 bg-amber-950/30 text-amber-100'
        : 'border-amber-200 bg-amber-50 text-amber-800';
    return (
      <div key={receipt.queueId} className={`rounded-xl border p-3 text-sm ${cardClass}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            {isAttention ? (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            )}
            {isAttention
              ? t('procurement.pending.conflictTitle', 'Needs attention')
              : receipt.state === 'parked'
                ? t('procurement.pending.parked', 'Waiting for module access')
                : t('procurement.pending.title', 'Pending sync')}
          </div>
          {isAttention && (
            <button
              onClick={() => handleRetryQueued(receipt.queueId)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-semibold ${iconButtonClass}`}
            >
              {t('procurement.pending.retry', 'Retry sync')}
            </button>
          )}
        </div>
        {isAttention && (
          <p className="mt-1 text-xs">
            {receipt.state === 'conflict'
              ? t('procurement.pending.conflictBody', {
                  defaultValue:
                    'The purchase order changed while offline. The recorded quantities are preserved below.',
                })
              : receipt.errorMessage ??
                t('procurement.receive.failed', 'Failed to record the receipt.')}
          </p>
        )}
        <p className={`mt-1 text-xs ${isAttention ? '' : ''}`}>
          {t('procurement.pending.entry', {
            defaultValue: 'Recorded {{time}} — waiting to sync',
            time: receipt.recordedAt ? formatShortDate(receipt.recordedAt) : '—',
          })}
        </p>
        <div className="mt-2 space-y-1 text-xs">
          <p className="font-semibold">
            {t('procurement.pending.quantities', 'Recorded quantities')}
          </p>
          {receipt.lines.map((line, index) => {
            const item = selectedPo?.items.find((i) => i.id === line.purchaseOrderItemId);
            return (
              <p key={`${receipt.queueId}-${index}`}>
                {item?.itemNameSnapshot ??
                  t('procurement.detail.unplanned', 'Unplanned')}: {line.quantityReceived}
                {line.unitCost !== null ? ` × ${formatMoney(line.unitCost)}` : ''}
              </p>
            );
          })}
        </div>
      </div>
    );
  };

  const renderDetail = (po: PosPurchaseOrder) => {
    const canReceive = RECEIVABLE_STATUSES.includes(po.status);
    return (
      <div className={`flex min-h-0 flex-1 flex-col gap-3 rounded-2xl border p-4 ${panelClass}`}>
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => setSelectedPoId(null)}
            className={`inline-flex items-center gap-1 rounded-xl border px-3 py-2 text-sm ${iconButtonClass}`}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('procurement.detail.back', 'Back to list')}
          </button>
          {renderStatusChip(po.status)}
        </div>

        <div>
          <h3 className="text-lg font-bold">{po.orderReference}</h3>
          <p className={`text-sm ${subtleClass}`}>
            {po.supplierName ?? t('procurement.supplier', 'Supplier')}
            {' · '}
            {t('procurement.expected', 'Expected')}: {formatShortDate(po.expectedDeliveryDate)}
          </p>
          <p className={`text-sm ${subtleClass}`}>
            {t('procurement.progress', {
              defaultValue: 'Received {{received}} of {{ordered}}',
              received: po.receivedProgress.receivedQty,
              ordered: po.receivedProgress.orderedQty,
            })}
            {' · '}
            {formatMoney(po.orderedTotalCost)}
          </p>
          {po.notes && (
            <p className={`mt-1 text-sm ${subtleClass}`}>
              {t('procurement.detail.notes', 'Notes')}: {po.notes}
            </p>
          )}
        </div>

        {selectedQueuedReceipts.length > 0 && (
          <div className="space-y-2">{selectedQueuedReceipts.map(renderQueuedReceiptCard)}</div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-hide">
          <p className={`text-xs font-semibold uppercase ${subtleClass}`}>
            {t('procurement.detail.items', 'Items')}
          </p>
          {po.items.map(renderItemRow)}
        </div>

        {canReceive && (
          <button
            onClick={openReceive}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-bold ${isDark ? 'bg-white text-black' : 'bg-black text-white'}`}
          >
            <PackageCheck className="h-4 w-4" />
            {t('procurement.receive.action', 'Receive delivery')}
          </button>
        )}
      </div>
    );
  };

  const renderReceiveDialog = () => {
    if (!receiveOpen || !selectedPo) {
      return null;
    }
    return renderModalPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div
          ref={receiveDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={receiveTitleId}
          className={`flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-2xl border p-4 ${panelClass}`}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 id={receiveTitleId} className="text-lg font-bold">
              {t('procurement.receive.title', {
                defaultValue: 'Receive against {{reference}}',
                reference: selectedPo.orderReference,
              })}
            </h3>
            <button
              onClick={closeReceive}
              aria-label={t('common.close', 'Close')}
              className={`rounded-xl border p-2 ${iconButtonClass}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!isOnline && (
            <p
              className={`rounded-xl border p-2 text-xs ${isDark ? 'border-amber-900 bg-amber-950/30 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
            >
              {t(
                'procurement.offline.receiveNote',
                'Receipts recorded offline are saved on this terminal and sync automatically after reconnect.',
              )}
            </p>
          )}

          {dialogError && (
            <div
              className={`flex items-center gap-2 rounded-xl border p-3 text-sm ${isDark ? 'border-red-900 bg-red-950/30 text-red-100' : 'border-red-200 bg-red-50 text-red-700'}`}
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {dialogError}
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-hide">
            {selectedPo.items.map((item) => {
              const draft = receiveLines[item.id];
              if (!draft) {
                return null;
              }
              const pendingQty = selectedPending.get(item.id) ?? 0;
              const remaining = Math.max(item.remainingQuantity - pendingQty, 0);
              const overReceipt = toQuantity(draft.quantity) > remaining;
              return (
                <div
                  key={item.id}
                  className={`rounded-xl border p-3 ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-gray-200 bg-gray-50'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-semibold">{item.itemNameSnapshot}</p>
                    <p className={`shrink-0 text-xs ${subtleClass}`}>
                      {t('procurement.detail.remainingQty', 'Remaining')}: {remaining}
                    </p>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className={`text-xs ${subtleClass}`}>
                      {t('procurement.receive.quantity', 'Quantity')}
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        value={draft.quantity}
                        onChange={(event) =>
                          setReceiveLines((prev) => ({
                            ...prev,
                            [item.id]: { ...prev[item.id], quantity: event.target.value },
                          }))
                        }
                        className={`mt-1 h-10 w-full rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                      />
                    </label>
                    <label className={`text-xs ${subtleClass}`}>
                      {t('procurement.receive.unitCost', 'Unit cost')}
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={draft.unitCost}
                        onChange={(event) =>
                          setReceiveLines((prev) => ({
                            ...prev,
                            [item.id]: { ...prev[item.id], unitCost: event.target.value },
                          }))
                        }
                        className={`mt-1 h-10 w-full rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
                      />
                    </label>
                  </div>
                  {overReceipt && (
                    <label
                      className={`mt-2 flex items-center gap-2 text-xs ${isDark ? 'text-amber-200' : 'text-amber-700'}`}
                    >
                      <input
                        type="checkbox"
                        checked={draft.confirmOverReceipt}
                        onChange={(event) =>
                          setReceiveLines((prev) => ({
                            ...prev,
                            [item.id]: {
                              ...prev[item.id],
                              confirmOverReceipt: event.target.checked,
                            },
                          }))
                        }
                      />
                      {t(
                        'procurement.receive.confirmOverReceipt',
                        'Confirm receiving more than ordered',
                      )}
                    </label>
                  )}
                </div>
              );
            })}
          </div>

          <input
            value={receiveNotes}
            onChange={(event) => setReceiveNotes(event.target.value)}
            placeholder={t('procurement.receive.notesPlaceholder', 'Delivery notes (optional)')}
            className={`h-10 w-full rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
          />

          <button
            onClick={submitReceive}
            disabled={submitting}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-bold disabled:opacity-60 ${isDark ? 'bg-white text-black' : 'bg-black text-white'}`}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('procurement.receive.submitting', 'Recording...')}
              </>
            ) : (
              t('procurement.receive.submit', 'Record receipt')
            )}
          </button>
        </div>
      </div>,
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className={`relative min-w-0 flex-1 rounded-xl border ${fieldClass}`}>
          <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${subtleClass}`} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t('procurement.searchPlaceholder', 'Search purchase orders...')}
            aria-label={t('procurement.searchPlaceholder', 'Search purchase orders...')}
            className="h-11 w-full rounded-xl bg-transparent pl-10 pr-3 text-sm outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          aria-label={t('procurement.filterAll', 'All statuses')}
          className={`h-11 rounded-xl border px-3 text-sm outline-none ${fieldClass}`}
        >
          <option value="all">{t('procurement.filterAll', 'All statuses')}</option>
          <option value="ordered">{t('procurement.status.ordered', 'Ordered')}</option>
          <option value="partially_received">
            {t('procurement.status.partially_received', 'Partially received')}
          </option>
          <option value="received_closed">
            {t('procurement.status.received_closed', 'Received / Closed')}
          </option>
          <option value="cancelled">{t('procurement.status.cancelled', 'Cancelled')}</option>
        </select>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label={t('common.refresh', 'Refresh')}
          className={`inline-flex h-11 items-center gap-2 rounded-xl border px-3 text-sm disabled:opacity-60 ${iconButtonClass}`}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className={`text-xs ${subtleClass}`}>
        {snapshot.fetchedAt
          ? t('procurement.lastSynced', {
              defaultValue: 'Last synced {{time}}',
              time: formatShortDate(snapshot.fetchedAt),
            })
          : t('procurement.neverSynced', 'Not synced yet')}
      </p>

      {selectedPo ? (
        renderDetail(selectedPo)
      ) : filteredOrders.length > 0 ? (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto scrollbar-hide md:grid-cols-2 2xl:grid-cols-3">
          {filteredOrders.map((po) => {
            const pendingForPo = queuedReceipts.some(
              (receipt) =>
                receipt.purchaseOrderId === po.id &&
                (receipt.state === 'pending' || receipt.state === 'parked'),
            );
            const attentionForPo = queuedReceipts.some(
              (receipt) =>
                receipt.purchaseOrderId === po.id &&
                (receipt.state === 'conflict' || receipt.state === 'failed'),
            );
            return (
              <button
                key={po.id}
                onClick={() => setSelectedPoId(po.id)}
                className={`rounded-xl border p-4 text-left transition ${isDark ? 'border-zinc-800 bg-zinc-900/60 active:bg-zinc-900' : 'border-gray-200 bg-white active:bg-gray-50'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-bold">{po.orderReference}</h3>
                    <p className={`mt-1 truncate text-xs ${subtleClass}`}>
                      {po.supplierName ?? t('procurement.supplier', 'Supplier')}
                    </p>
                  </div>
                  {renderStatusChip(po.status)}
                </div>
                <div className={`mt-3 space-y-1 text-sm ${subtleClass}`}>
                  <p className="flex items-center gap-2">
                    <Truck className="h-4 w-4 shrink-0" />
                    {t('procurement.expected', 'Expected')}: {formatShortDate(po.expectedDeliveryDate)}
                  </p>
                  <p className="flex items-center gap-2">
                    <ClipboardList className="h-4 w-4 shrink-0" />
                    {t('procurement.progress', {
                      defaultValue: 'Received {{received}} of {{ordered}}',
                      received: po.receivedProgress.receivedQty,
                      ordered: po.receivedProgress.orderedQty,
                    })}
                  </p>
                  {pendingForPo && (
                    <p className={isDark ? 'text-amber-300' : 'text-amber-600'}>
                      {t('procurement.pending.title', 'Pending sync')}
                    </p>
                  )}
                  {attentionForPo && (
                    <p className={isDark ? 'text-red-300' : 'text-red-600'}>
                      {t('procurement.pending.conflictTitle', 'Needs attention')}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={`flex flex-1 items-center justify-center rounded-2xl border p-8 text-sm ${panelClass} ${subtleClass}`}>
          {t('procurement.empty', 'No purchase orders for this branch yet.')}
        </div>
      )}

      {renderReceiveDialog()}
    </div>
  );
};

export default PurchaseOrdersTab;
