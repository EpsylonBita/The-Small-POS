import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  ArrowRightLeft,
  Banknote,
  Check,
  CreditCard,
  HandCoins,
  Layers,
  Loader2,
  Minus,
  MoveRight,
  PencilLine,
  Percent,
  Plus,
  Receipt,
  Shuffle,
  Split,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { emitCompatEvent, getBridge, type RecordPaymentParams } from '../../../lib';
import { useI18n } from '../../contexts/i18n-context';
import type { Order } from '../../types/orders';
import type { RestaurantTable } from '../../types/tables';
import { posApiGet, posApiPatch, posApiPost } from '../../utils/api-helpers';
import {
  buildTableSessionOpenPayload,
  buildTableSessionPaymentPayload,
  findOpenTableOrderForTable,
  findTableOrderForTable,
  normalizeGuestCount,
} from '../../utils/tableOrderFlow';
import {
  buildUnpaidAmountByItemId,
  applyTableCheckOrderLevelDiscount,
  mergeRemoteTableCheckItemsWithLocalAdjustments,
  resolveTableCheckOrderTotal,
  resolveTableCheckItemDiscount,
  scopeTableCheckItemsToActiveAllocations,
  sumTableCheckLineTotals,
  sumTableCheckItemDiscounts,
} from '../../utils/tableCheckPayments';
import { formatCurrency } from '../../utils/format';
import { formatTableDisplayNumber } from '../../utils/table-display';
import { translateRoleName } from '../../utils/role-labels';
import { renderModalPortal } from '../../utils/render-modal-portal';
import {
  beginBatchItemSelection,
  clearMissingBatchItemSelection,
  getSelectedBatchItems,
  isBatchItemSelectionActive,
  toggleBatchItemSelection,
} from '../../../../../shared/pos/table-batch-selection';
import {
  enqueueTableItemTransfer,
  enqueueTablePayment,
  enqueueTableSessionOpen,
  enqueueTableSessionUpdate,
  isRetryableTableServiceError,
} from '../../utils/tableSessionOfflineQueue';

type PaymentMethod = 'cash' | 'card';
type SecondaryModal = 'pay-table' | 'item-actions' | 'transfer-item' | 'batch-pay' | 'batch-transfer' | 'batch-discount' | 'move-table' | 'merge-table' | 'covers' | 'assign-waiter' | null;
type ItemActionMode = 'menu' | 'pay' | 'price' | 'discount';
type DiscountMode = 'percentage' | 'fixed';

interface TableSessionBalance {
  order_total?: number;
  paid_total?: number;
  tip_total?: number;
  outstanding_balance?: number;
  payment_status?: string | null;
}

interface TableSessionOrderItem {
  id: string;
  order_item_id?: string | null;
  orderItemId?: string | null;
  source_order_item_id?: string | null;
  sourceOrderItemId?: string | null;
  menu_item_id?: string | null;
  menuItemId?: string | null;
  name?: string | null;
  menu_item_name?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  unit_price?: number | string | null;
  unitPrice?: number | string | null;
  total_price?: number | string | null;
  totalPrice?: number | string | null;
  subtotal?: number | string | null;
  original_unit_price?: number | string | null;
  originalUnitPrice?: number | string | null;
  is_price_overridden?: boolean | null;
  isPriceOverridden?: boolean | null;
  discount?: number | string | null;
  discountAmount?: number | string | null;
  special_instructions?: string | null;
  specialInstructions?: string | null;
  notes?: string | null;
  customizations?: unknown;
  selectedIngredients?: unknown;
  modifiers?: unknown;
  ingredients?: unknown;
}

interface TableSessionAllocation {
  id?: string;
  order_item_id?: string | null;
  table_id?: string | null;
  seat_number?: number | null;
  quantity?: number | string | null;
  paid_quantity?: number | string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface TableSessionDetails {
  id: string;
  primary_table_id?: string | null;
  active_order_id?: string | null;
  guest_count?: number | null;
  status?: 'open' | 'partially_paid' | 'settled' | 'closed' | 'cancelled';
  opened_by_waiter_id?: string | null;
  opened_at?: string | null;
  metadata?: Record<string, unknown> | null;
  balance?: TableSessionBalance;
  order?: {
    id: string;
    order_number?: string | null;
    total_amount?: number | string | null;
    payment_status?: string | null;
    order_items?: TableSessionOrderItem[];
  } | null;
  items?: TableSessionAllocation[];
  tables?: Array<{
    table_id?: string | null;
    role?: string | null;
    released_at?: string | null;
  }>;
}

interface TableCheckManagerModalProps {
  isOpen: boolean;
  table: RestaurantTable | null;
  tables: RestaurantTable[];
  onClose: () => void;
  onAddItems: (table: RestaurantTable, guestCount: number, session: TableSessionDetails) => void;
  onRefreshTables: () => Promise<void> | void;
  onRefreshOrders: () => Promise<void> | void;
  localOrders?: Order[];
}

type PaymentHistoryRecord = Record<string, unknown> & {
  id?: string;
  method?: string;
  amount?: number;
  amount_cents?: number;
  amountCents?: number;
  tipAmount?: number;
  tip_amount?: number;
  tip_amount_cents?: number;
  tipAmountCents?: number;
  status?: string;
  createdAt?: string;
  created_at?: string;
  items?: Array<Record<string, unknown>>;
};

type PaidItemRecord = Record<string, unknown> & {
  itemIndex?: number;
  item_index?: number;
  itemQuantity?: number;
  item_quantity?: number;
  itemAmount?: number;
  item_amount?: number;
};

interface WaiterOption {
  id: string;
  name: string;
  role?: string | null;
  active?: boolean;
}

const panelMotion = {
  initial: { opacity: 0, y: 18, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 12, scale: 0.985 },
  transition: { duration: 0.18, ease: 'easeOut' },
} as const;

const sheetMotion = {
  initial: { opacity: 0, y: 24, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 18, scale: 0.97 },
  transition: { duration: 0.16, ease: 'easeOut' },
} as const;

// Locale-aware currency so the Greek app reads "16,65 €", not a hardcoded "€16.65".
const money = (value: unknown) => formatCurrency(Number(value || 0));

const parseMoneyInput = (value: string): number => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const formatMoneyInput = (value: string): string => parseMoneyInput(value).toFixed(2);

const parseDateMs = (value: unknown): number | null => {
  if (!value) return null;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const formatOccupiedSince = (
  value: unknown,
  nowMs: number,
  labels: {
    hoursMinutes: (hours: number, minutes: number) => string;
    minutes: (minutes: number) => string;
    occupiedSince: (time: string, duration: string) => string;
  },
): string | null => {
  const startedMs = parseDateMs(value);
  if (!startedMs) return null;

  const elapsedMinutes = Math.max(0, Math.floor((nowMs - startedMs) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  const duration = hours > 0 ? labels.hoursMinutes(hours, minutes) : labels.minutes(minutes);
  const time = new Date(startedMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return labels.occupiedSince(time, duration);
};

const itemQuantity = (item: TableSessionOrderItem): number => Math.max(1, Number(item.quantity || 1));

const itemUnitPrice = (item: TableSessionOrderItem): number => {
  const quantity = itemQuantity(item);
  const total = Number(item.total_price ?? item.totalPrice ?? item.subtotal ?? 0);
  if (total > 0) {
    return total / quantity;
  }
  return Math.max(0, Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0));
};

const itemLineTotal = (item: TableSessionOrderItem): number =>
  Number((itemUnitPrice(item) * itemQuantity(item)).toFixed(2));

const itemDisplayName = (item: TableSessionOrderItem, fallback = 'Item'): string => {
  return item.name || item.menu_item_name || fallback;
};

const buildTransferPricingPayload = (
  item: TableSessionOrderItem,
  quantity: number,
): Record<string, number | boolean> => {
  const boundedQuantity = Math.max(0, Number(quantity || 0));
  const sourceQuantity = itemQuantity(item);
  const effectiveUnitPrice = Number(itemUnitPrice(item).toFixed(2));
  const effectiveTotalPrice = Number((effectiveUnitPrice * boundedQuantity).toFixed(2));
  const originalUnitPrice = Math.max(
    effectiveUnitPrice,
    Number(item.original_unit_price ?? item.originalUnitPrice ?? effectiveUnitPrice) || effectiveUnitPrice,
  );
  const lineDiscount = resolveTableCheckItemDiscount(item);
  const discountAmount = Number(((lineDiscount * boundedQuantity) / sourceQuantity).toFixed(2));
  const isPriceOverridden =
    item.is_price_overridden === true ||
    item.isPriceOverridden === true ||
    discountAmount > 0.009 ||
    Math.abs(originalUnitPrice - effectiveUnitPrice) > 0.005;

  return {
    effective_unit_price: effectiveUnitPrice,
    effective_total_price: effectiveTotalPrice,
    original_unit_price: Number(originalUnitPrice.toFixed(2)),
    discount_amount: discountAmount,
    is_price_overridden: isPriceOverridden,
  };
};

const emitTableSessionBalanceUpdate = (
  tableId: string | null | undefined,
  session: TableSessionDetails | null | undefined,
  guestCount?: unknown,
) => {
  if (!tableId || !session) {
    return;
  }

  const orderTotal = Number(session.balance?.order_total ?? session.order?.total_amount ?? 0) || 0;
  const paidTotal = Number(session.balance?.paid_total ?? 0) || 0;
  const tipTotal = Number(session.balance?.tip_total ?? 0) || 0;

  emitCompatEvent('table-session-balance-updated', {
    tableId,
    orderId: session.active_order_id || session.order?.id || null,
    tableSessionId: session.id || null,
    guestCount: guestCount ?? session.guest_count ?? null,
    occupiedSince: session.opened_at || null,
    orderTotal,
    paidTotal,
    tipTotal,
  });
};

const localSessionIdPrefix = 'local-table-session:';
const glassSurfaceClass =
  'rounded-xl border liquid-glass-modal-border bg-white/55 shadow-[0_14px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:bg-black/20 dark:shadow-[0_18px_42px_rgba(2,6,23,0.35)]';
const glassSubtleSurfaceClass =
  'rounded-xl border liquid-glass-modal-border bg-white/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-xl dark:bg-white/[0.045]';
const glassInputClass = 'liquid-glass-modal-input w-full';

const isLocalSessionId = (sessionId: string | null | undefined): boolean =>
  typeof sessionId === 'string' && sessionId.startsWith(localSessionIdPrefix);

function isOutstandingTableSessionBalanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('cannot close a table session with an outstanding balance') ||
    (
      normalized.includes('outstanding_balance') &&
      normalized.includes('paid_total')
    )
  );
}

const readOrderTotal = (order: Order): number =>
  Number((order as any).total_amount ?? (order as any).totalAmount ?? 0) || 0;

const readOrderPaidTotal = (order: Order): number =>
  Number((order as any).paid_total ?? (order as any).paidTotal ?? 0) || 0;

const readOrderPaymentStatus = (order: Order): string =>
  String((order as any).payment_status ?? (order as any).paymentStatus ?? 'pending') || 'pending';

const localOrderItems = (order: Order, itemFallback = 'Item'): TableSessionOrderItem[] => {
  const rawItems = Array.isArray((order as any).items) ? ((order as any).items as any[]) : [];
  return rawItems.map((item, index) => {
    const quantity = Number(item.quantity || 1) || 1;
    const unitPrice = Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0) || 0;
    const totalPrice = Number(item.total_price ?? item.totalPrice ?? unitPrice * quantity) || 0;
    const sourceOrderItemId =
      item.order_item_id ??
      item.orderItemId ??
      item.source_order_item_id ??
      item.sourceOrderItemId ??
      item.original_order_item_id ??
      item.originalOrderItemId ??
      item.id ??
      null;
    return {
      id: String(item.id || item.order_item_id || item.menu_item_id || `local-item-${index}`),
      order_item_id: sourceOrderItemId,
      orderItemId: sourceOrderItemId,
      source_order_item_id: sourceOrderItemId,
      sourceOrderItemId: sourceOrderItemId,
      menu_item_id: item.menu_item_id || item.menuItemId || null,
      menuItemId: item.menuItemId || item.menu_item_id || null,
      name: item.name || item.menu_item_name || item.menuItemName || itemFallback,
      menu_item_name: item.menu_item_name || item.name || item.menuItemName || itemFallback,
      quantity,
      price: unitPrice,
      unit_price: unitPrice,
      total_price: totalPrice,
      original_unit_price: item.original_unit_price ?? item.originalUnitPrice ?? unitPrice,
      is_price_overridden: item.is_price_overridden === true || item.isPriceOverridden === true,
      discount: item.discount,
      discountAmount: item.discountAmount ?? item.discount_amount,
      special_instructions: item.special_instructions || item.specialInstructions || null,
      notes: item.notes || null,
      customizations:
        item.customizations ??
        item.selectedIngredients ??
        item.modifiers ??
        item.ingredients ??
        null,
    };
  });
};

const buildLocalSessionFromOrder = (table: RestaurantTable, order: Order, itemFallback = 'Item'): TableSessionDetails => {
  const orderTotal = readOrderTotal(order);
  const paymentStatus = readOrderPaymentStatus(order);
  const paidTotal = readOrderPaidTotal(order);
  const isSettled = paymentStatus === 'paid' || paymentStatus === 'completed';
  const orderItems = applyTableCheckOrderLevelDiscount(localOrderItems(order, itemFallback), orderTotal) as TableSessionOrderItem[];
  const sessionId =
    (table.tableSessionId as string | null | undefined) ||
    ((order as any).tableSessionId as string | null | undefined) ||
    ((order as any).table_session_id as string | null | undefined) ||
    `${localSessionIdPrefix}${order.id}`;

  return {
    id: sessionId,
    primary_table_id: table.id,
    active_order_id: order.id,
    guest_count: normalizeGuestCount(
      (order as any).guest_count ??
      (order as any).guestCount ??
      table.guestCount ??
      table.capacity ??
      1,
    ),
    status: isSettled ? 'settled' : paidTotal > 0 ? 'partially_paid' : 'open',
    opened_by_waiter_id: table.currentWaiterId || null,
    opened_at: (order as any).created_at || (order as any).createdAt || null,
    metadata: {
      current_waiter_id: table.currentWaiterId || null,
      current_waiter_name: table.currentWaiterName || null,
    },
    balance: {
      order_total: orderTotal,
      paid_total: isSettled ? orderTotal : paidTotal,
      tip_total: Number((order as any).tip_amount ?? (order as any).tipAmount ?? 0) || 0,
      outstanding_balance: isSettled ? 0 : Math.max(0, orderTotal - paidTotal),
      payment_status: paymentStatus,
    },
    order: {
      id: order.id,
      order_number: (order as any).order_number || (order as any).orderNumber || null,
      total_amount: orderTotal,
      payment_status: paymentStatus,
      order_items: orderItems,
    },
    items: orderItems.map((item) => ({
      id: `local-allocation:${item.id}`,
      order_item_id: item.id,
      table_id: table.id,
      seat_number: null,
      quantity: item.quantity || 0,
      paid_quantity: 0,
      status: 'open',
    })),
    tables: [
      {
        table_id: table.id,
        role: 'primary',
        released_at: null,
      },
    ],
  };
};

const mergeSessionWithLocalOrder = (
  table: RestaurantTable,
  remoteSession: TableSessionDetails,
  localOrder: Order | null,
  itemFallback = 'Item',
): TableSessionDetails => {
  if (!localOrder) {
    return remoteSession;
  }

  const localSession = buildLocalSessionFromOrder(table, localOrder, itemFallback);
  const remoteTotal = Number(remoteSession.balance?.order_total ?? remoteSession.order?.total_amount ?? 0) || 0;
  const remotePaid = Number(remoteSession.balance?.paid_total ?? 0) || 0;
  const remoteTips = Number(remoteSession.balance?.tip_total ?? 0) || 0;
  const localTotal = Number(localSession.balance?.order_total ?? 0) || 0;
  const localPaid = Number(localSession.balance?.paid_total ?? 0) || 0;
  const localTips = Number(localSession.balance?.tip_total ?? 0) || 0;
  const hasLocalOrderItems = (localSession.order?.order_items?.length || 0) > 0;
  const remoteOrderItems = remoteSession.order?.order_items || [];
  const remoteAllocations = remoteSession.items || [];
  const hasRemoteAllocationScope = remoteAllocations.some(allocation => Boolean(allocation.order_item_id));
  const scopedRemoteOrderItems = hasRemoteAllocationScope
    ? scopeTableCheckItemsToActiveAllocations(remoteOrderItems, remoteAllocations) as TableSessionOrderItem[]
    : remoteOrderItems;
  const localOrderItemsForDisplay = localSession.order?.order_items || [];
  const shouldDecorateScopedItemsWithLocalOrder =
    hasLocalOrderItems && (!hasRemoteAllocationScope || scopedRemoteOrderItems.length > 0);
  const mergedOrderItems = shouldDecorateScopedItemsWithLocalOrder
    ? mergeRemoteTableCheckItemsWithLocalAdjustments(scopedRemoteOrderItems, localOrderItemsForDisplay) as TableSessionOrderItem[]
    : scopedRemoteOrderItems;
  const useLocalAllocations = hasLocalOrderItems && !hasRemoteAllocationScope && scopedRemoteOrderItems.length === 0;
  const remoteItemsWereScoped = hasRemoteAllocationScope && scopedRemoteOrderItems.length !== remoteOrderItems.length;

  if (!hasLocalOrderItems && !remoteItemsWereScoped && localTotal <= remoteTotal + 0.001 && localPaid <= remotePaid + 0.001 && localTips <= remoteTips + 0.001) {
    return remoteSession;
  }

  // An order-level discount lives on the order total, not the per-line prices, so
  // the raw scoped line sum would resurrect the pre-discount subtotal. Prefer the
  // local (canonical charged) order total, fall back to the remote session total,
  // and distribute it across the scoped lines. applyTableCheckOrderLevelDiscount is
  // idempotent, so this is a no-op when the lines already carry the discount.
  const authoritativeOrderTotal = localTotal > 0 ? localTotal : remoteTotal;
  const discountedOrderItems = (
    hasRemoteAllocationScope
      ? applyTableCheckOrderLevelDiscount(mergedOrderItems || [], authoritativeOrderTotal)
      : mergedOrderItems
  ) as TableSessionOrderItem[];
  const orderTotal = hasRemoteAllocationScope
    ? sumTableCheckLineTotals(discountedOrderItems)
    : resolveTableCheckOrderTotal({
        remoteTotal,
        localTotal,
        hasLocalOrderItems,
      });
  const paidTotal = hasRemoteAllocationScope
    ? Number(remotePaid.toFixed(2))
    : Number(Math.max(remotePaid, localPaid).toFixed(2));
  const tipTotal = hasRemoteAllocationScope
    ? Number(remoteTips.toFixed(2))
    : Number(Math.max(remoteTips, localTips).toFixed(2));
  const outstanding = Number(Math.max(0, orderTotal - paidTotal).toFixed(2));
  const paymentStatus = outstanding <= 0.01 ? 'paid' : paidTotal > 0 ? 'partially_paid' : 'pending';

  return {
    ...remoteSession,
    active_order_id: remoteSession.active_order_id || localSession.active_order_id,
    guest_count: remoteSession.guest_count ?? localSession.guest_count,
    opened_at: remoteSession.opened_at || localSession.opened_at,
    status: outstanding <= 0.01 ? 'settled' : paidTotal > 0 ? 'partially_paid' : remoteSession.status,
    balance: {
      ...remoteSession.balance,
      order_total: orderTotal,
      paid_total: paidTotal,
      tip_total: tipTotal,
      outstanding_balance: outstanding,
      payment_status: paymentStatus,
    },
    order: {
      ...(remoteSession.order || localSession.order || { id: String(localOrder.id) }),
      id: remoteSession.order?.id || localSession.order?.id || String(localOrder.id),
      order_number: localSession.order?.order_number || remoteSession.order?.order_number || null,
      total_amount: orderTotal,
      payment_status: paymentStatus,
      order_items: discountedOrderItems,
    },
    items: useLocalAllocations ? localSession.items : remoteSession.items,
  };
};

// Local bridge lookups must never block the table check. A promise that hangs
// (never settles) would never reach try/catch/finally, leaving the modal stuck on
// the loading spinner. This races the lookup against a short timer and resolves to
// the fallback on hang OR rejection, so the load always proceeds.
const LOCAL_LOOKUP_TIMEOUT_MS = 2000;
function resolveWithTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = LOCAL_LOOKUP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); finish(value); },
      () => { clearTimeout(timer); finish(fallback); },
    );
  });
}

const fetchBridgeOrders = async (): Promise<Order[]> => {
  try {
    const bridge = getBridge();
    const result: any = await bridge.orders.getAll();
    const orders = result?.data ?? result;
    return Array.isArray(orders) ? (orders as Order[]) : [];
  } catch {
    return [];
  }
};

const unwrapBridgeArray = <T,>(result: unknown): T[] => {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (result && typeof result === 'object') {
    const data = (result as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data as T[];
    }
  }
  return [];
};

const fetchLocalPaymentSnapshot = async (
  orderId: string | null | undefined,
): Promise<{ payments: PaymentHistoryRecord[]; paidItems: PaidItemRecord[] }> => {
  if (!orderId) {
    return { payments: [], paidItems: [] };
  }

  try {
    const bridge = getBridge();
    const [paymentResult, paidItemsResult] = await Promise.all([
      bridge.payments.getOrderPayments(orderId),
      bridge.payments.getPaidItems(orderId),
    ]);
    return {
      payments: unwrapBridgeArray<PaymentHistoryRecord>(paymentResult)
        .filter(payment => ['completed', 'paid'].includes(String(payment.status || '').toLowerCase()))
        .sort((left, right) =>
          new Date(String(right.createdAt || right.created_at || 0)).getTime()
          - new Date(String(left.createdAt || left.created_at || 0)).getTime(),
        ),
      paidItems: unwrapBridgeArray<PaidItemRecord>(paidItemsResult),
    };
  } catch (error) {
    console.warn('[TableCheckManagerModal] Failed to load local payment snapshot:', error);
    return { payments: [], paidItems: [] };
  }
};

const paymentRecordAmount = (payment: PaymentHistoryRecord): number => {
  const cents = Number(payment.amount_cents ?? payment.amountCents);
  if (Number.isFinite(cents) && cents > 0) {
    return Number((cents / 100).toFixed(2));
  }
  return Number(payment.amount || 0) || 0;
};

const paymentRecordTip = (payment: PaymentHistoryRecord): number => {
  const cents = Number(payment.tip_amount_cents ?? payment.tipAmountCents);
  if (Number.isFinite(cents) && cents > 0) {
    return Number((cents / 100).toFixed(2));
  }
  return Number(payment.tipAmount ?? payment.tip_amount ?? 0) || 0;
};

const formatPaymentTimestamp = (value: unknown): string => {
  const parsed = parseDateMs(value);
  if (!parsed) {
    return '';
  }
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const toEditableOrderItem = (item: TableSessionOrderItem, itemFallback = 'Item'): Record<string, unknown> => {
  const quantity = itemQuantity(item);
  const unitPrice = itemUnitPrice(item);
  const totalPrice = Number((unitPrice * quantity).toFixed(2));
  const sourceOrderItemId =
    item.order_item_id ??
    item.orderItemId ??
    item.source_order_item_id ??
    item.sourceOrderItemId ??
    item.id;
  return {
    ...item,
    id: item.id,
    order_item_id: sourceOrderItemId,
    orderItemId: sourceOrderItemId,
    source_order_item_id: sourceOrderItemId,
    sourceOrderItemId: sourceOrderItemId,
    menu_item_id: item.menu_item_id ?? item.menuItemId ?? item.id,
    menuItemId: item.menuItemId ?? item.menu_item_id ?? item.id,
    name: itemDisplayName(item, itemFallback),
    menu_item_name: item.menu_item_name || itemDisplayName(item, itemFallback),
    quantity,
    price: unitPrice,
    unit_price: unitPrice,
    unitPrice,
    total_price: totalPrice,
    totalPrice,
    special_instructions: item.special_instructions ?? item.specialInstructions ?? null,
    specialInstructions: item.specialInstructions ?? item.special_instructions ?? null,
    notes: item.notes ?? null,
    customizations:
      item.customizations ??
      item.selectedIngredients ??
      item.modifiers ??
      item.ingredients ??
      null,
  };
};

const tableItemFromEditable = (item: Record<string, unknown>): TableSessionOrderItem => ({
  id: String(item.id || item.order_item_id || item.orderItemId || item.menu_item_id || item.menuItemId || crypto.randomUUID()),
  order_item_id: typeof item.order_item_id === 'string' ? item.order_item_id : null,
  orderItemId: typeof item.orderItemId === 'string' ? item.orderItemId : null,
  source_order_item_id: typeof item.source_order_item_id === 'string' ? item.source_order_item_id : null,
  sourceOrderItemId: typeof item.sourceOrderItemId === 'string' ? item.sourceOrderItemId : null,
  menu_item_id: typeof item.menu_item_id === 'string' ? item.menu_item_id : null,
  menuItemId: typeof item.menuItemId === 'string' ? item.menuItemId : null,
  name: typeof item.name === 'string' ? item.name : null,
  menu_item_name: typeof item.menu_item_name === 'string' ? item.menu_item_name : null,
  quantity: Number(item.quantity || 1),
  price: Number(item.price ?? item.unit_price ?? item.unitPrice ?? 0),
  unit_price: Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0),
  total_price: Number(item.total_price ?? item.totalPrice ?? 0),
  original_unit_price: item.original_unit_price as number | string | null | undefined,
  is_price_overridden: item.is_price_overridden === true || item.isPriceOverridden === true,
  discount: item.discount as number | string | null | undefined,
  discountAmount: item.discountAmount as number | string | null | undefined,
  special_instructions: typeof item.special_instructions === 'string' ? item.special_instructions : null,
  notes: typeof item.notes === 'string' ? item.notes : null,
  customizations:
    item.customizations ??
    item.selectedIngredients ??
    item.modifiers ??
    item.ingredients ??
    null,
});

interface TileProps {
  label: string;
  value: string;
  tone?: 'default' | 'due' | 'paid' | 'tip';
}

const MetricTile: React.FC<TileProps> = ({ label, value, tone = 'default' }) => {
  const color = {
    default: 'text-slate-950 dark:text-white',
    due: 'text-amber-700 dark:text-amber-300',
    paid: 'text-emerald-700 dark:text-emerald-300',
    tip: 'text-blue-700 dark:text-blue-300',
  }[tone];

  return (
    <div className={`${glassSubtleSurfaceClass} px-4 py-3`}>
      <p className="text-[11px] font-medium uppercase tracking-wide liquid-glass-modal-text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
};

interface FormFieldProps {
  label: string;
  children: React.ReactNode;
}

const FormField: React.FC<FormFieldProps> = ({ label, children }) => (
  <label className="block">
    <span className="text-xs font-medium liquid-glass-modal-text-muted">{label}</span>
    <div className="mt-1">{children}</div>
  </label>
);

interface FieldGroupProps {
  label: string;
  labelId: string;
  children: React.ReactNode;
}

// Non-<label> field wrapper for composite controls (the TableDestinationPicker
// listbox). A <label> must not wrap multiple interactive option buttons — that
// folds the field label into every option's accessible name (the live
// "Τραπέζι προορισμού Τραπέζι #TP01" double-announce). Here the label is a
// <span id> referenced by the inner listbox via aria-labelledby instead.
const FieldGroup: React.FC<FieldGroupProps> = ({ label, labelId, children }) => (
  <div role="group" aria-labelledby={labelId}>
    <span id={labelId} className="text-xs font-medium liquid-glass-modal-text-muted">
      {label}
    </span>
    <div className="mt-1">{children}</div>
  </div>
);

interface TableDestinationPickerProps {
  value: string;
  onChange: (tableId: string) => void;
  options: RestaurantTable[];
  optionLabel: (table: RestaurantTable) => string;
  emptyLabel: string;
  labelledBy: string;
}

// Dark-mode-safe replacement for the native table-picker dropdown. On
// Windows/Tauri the native popup renders as an unstyleable light-gray menu with
// low-contrast text that escapes the dark glass modal, so the destination list is
// a custom listbox of explicitly-colored buttons inside the portal-level
// secondary sheet. Selection still emits the raw table id (value/onChange) — only
// the visible label goes through optionLabel — so writes, matching and the
// disabled-until-selected gating are unchanged.
const TableDestinationPicker: React.FC<TableDestinationPickerProps> = ({
  value,
  onChange,
  options,
  optionLabel,
  emptyLabel,
  labelledBy,
}) => {
  if (options.length === 0) {
    return (
      <p
        role="status"
        aria-labelledby={labelledBy}
        className="rounded-xl border liquid-glass-modal-border bg-white/35 px-3 py-2 text-sm liquid-glass-modal-text-muted backdrop-blur-xl dark:bg-white/[0.045]"
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      role="listbox"
      aria-labelledby={labelledBy}
      className="max-h-44 space-y-1 overflow-y-auto rounded-xl border liquid-glass-modal-border bg-white/35 p-1.5 backdrop-blur-xl dark:bg-white/[0.045]"
    >
      {options.map(option => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onChange(option.id)}
            className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
              selected
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-900 hover:bg-black/5 dark:text-zinc-100 dark:hover:bg-white/10'
            }`}
          >
            <span className="truncate">{optionLabel(option)}</span>
            {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
          </button>
        );
      })}
    </div>
  );
};

interface ActionButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'cash' | 'card' | 'warn' | 'purple';
  className?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  children,
  onClick,
  disabled = false,
  tone = 'default',
  className = '',
}) => {
  const toneClass = {
    default: 'liquid-glass-modal-secondary',
    cash: 'liquid-glass-modal-success',
    card: 'liquid-glass-modal-primary',
    warn: 'liquid-glass-modal-warning',
    purple: 'liquid-glass-modal-preparing',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`liquid-glass-modal-button flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 ${toneClass} ${className}`}
    >
      {children}
    </button>
  );
};

interface SecondarySheetProps {
  title: string;
  subtitle?: React.ReactNode;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  closeLabel?: string;
}

const SecondarySheet: React.FC<SecondarySheetProps> = ({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  closeLabel = 'Close',
}) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetTitleId = useId();

  // Escape closes ONLY this nested sheet - it is the topmost [role="dialog"] while
  // open, so the parent table-account modal self-suppresses and stays open. Routes
  // through onClose (closeSecondaryModal); it never submits a payment or clicks
  // Cash/Card (those are buttons inside the sheet body).
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== sheetRef.current) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return renderModalPortal(
    // Secondary sheets mount at document.body (above the main table-check modal,
    // z 20000) with a full-viewport blurred backdrop, per the founder rule that
    // every modal opens outside the container and blurs the rest of the screen.
    <motion.div
      className="fixed inset-0 z-[20050] flex items-center justify-center bg-black/35 p-4 backdrop-blur-md dark:bg-black/55"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        {...sheetMotion}
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={sheetTitleId}
        className="liquid-glass-modal-shell !w-full !max-w-2xl overflow-hidden"
      >
        <div className="liquid-glass-modal-header px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border liquid-glass-modal-border bg-white/15 text-blue-700 backdrop-blur-xl dark:text-blue-300">
              {icon}
            </div>
            <div className="min-w-0">
              <h3 id={sheetTitleId} className="truncate text-lg font-semibold liquid-glass-modal-title">{title}</h3>
              {subtitle ? (
                typeof subtitle === 'string' || typeof subtitle === 'number' ? (
                  <p className="truncate text-sm liquid-glass-modal-text-muted">{subtitle}</p>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    {subtitle}
                  </div>
                )
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="liquid-glass-modal-close"
            aria-label={closeLabel}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5 liquid-glass-modal-content">{children}</div>
        {footer ? <div className="border-t liquid-glass-modal-border px-5 py-4">{footer}</div> : null}
      </motion.div>
    </motion.div>
  );
};

export const TableCheckManagerModal: React.FC<TableCheckManagerModalProps> = ({
  isOpen,
  table,
  tables,
  onClose,
  onAddItems,
  onRefreshTables,
  onRefreshOrders,
  localOrders = [],
}) => {
  const { t } = useI18n();
  const tr = useCallback(
    (key: string, defaultValue: string, options: Record<string, unknown> = {}) =>
      String(t(`tableCheckManager.${key}`, { defaultValue, ...options })),
    [t],
  );
  const translatedItemFallback = tr('labels.item', 'Item');
  const [session, setSession] = useState<TableSessionDetails | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [secondaryModal, setSecondaryModal] = useState<SecondaryModal>(null);
  const [selectedItem, setSelectedItem] = useState<TableSessionOrderItem | null>(null);
  const [itemActionMode, setItemActionMode] = useState<ItemActionMode>('menu');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [tipAmount, setTipAmount] = useState('0.00');
  const [seatNumber, setSeatNumber] = useState('');
  const [guestCount, setGuestCount] = useState(1);
  const [targetTableId, setTargetTableId] = useState('');
  const [mergeTableId, setMergeTableId] = useState('');
  const [transferItemId, setTransferItemId] = useState('');
  const [transferQuantity, setTransferQuantity] = useState('1');
  const [transferSeatNumber, setTransferSeatNumber] = useState('');
  const [itemPayQuantity, setItemPayQuantity] = useState('1');
  const [itemPriceValue, setItemPriceValue] = useState('');
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [occupiedClockMs, setOccupiedClockMs] = useState(() => Date.now());
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryRecord[]>([]);
  const [paidItemRecords, setPaidItemRecords] = useState<PaidItemRecord[]>([]);
  const [waiterOptions, setWaiterOptions] = useState<WaiterOption[]>([]);
  const [selectedWaiterId, setSelectedWaiterId] = useState('');
  const [isLoadingWaiters, setIsLoadingWaiters] = useState(false);
  const [batchSelectedItemIds, setBatchSelectedItemIds] = useState<string[]>([]);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const mainDialogRef = useRef<HTMLDivElement>(null);
  const mainTitleId = useId();

  // Escape closes the table-account modal, matching the fixed table/room modals.
  // Only the topmost [role="dialog"] responds, so while a nested secondary sheet
  // (e.g. the payment sheet) is open this self-suppresses and the sheet closes
  // first. Routes through the close-only onClose prop and never settles/pays.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== mainDialogRef.current) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const outstanding = Number(session?.balance?.outstanding_balance || 0);
  const paidTotal = Number(session?.balance?.paid_total || 0);
  const orderTotal = Number(session?.balance?.order_total || session?.order?.total_amount || 0);
  const tipTotal = Number(session?.balance?.tip_total || 0);
  // Single display derivation: distribute any order-level discount onto the line
  // items so per-item unpaid amounts, the summary, the discount line and payment
  // defaults all reflect the discounted balance instead of the pre-discount
  // subtotal. Idempotent - a no-op when the lines already carry the discount.
  const orderItems = useMemo(() => {
    const items = session?.order?.order_items || [];
    const target = Number(session?.balance?.order_total ?? session?.order?.total_amount ?? 0) || 0;
    return applyTableCheckOrderLevelDiscount(items, target) as TableSessionOrderItem[];
  }, [session?.order?.order_items, session?.balance?.order_total, session?.order?.total_amount]);
  const discountTotal = useMemo(() => sumTableCheckItemDiscounts(orderItems), [orderItems]);
  const availableTables = useMemo(
    () => tables.filter(candidate => candidate.id !== table?.id && candidate.status === 'available'),
    [table?.id, tables],
  );
  const sessionMetadata = useMemo<Record<string, unknown>>(
    () => (session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
    [session?.metadata],
  );
  const currentWaiterId = String(
    session?.opened_by_waiter_id ||
      sessionMetadata.current_waiter_id ||
      table?.currentWaiterId ||
      '',
  );
  const currentWaiterName =
    (typeof sessionMetadata.current_waiter_name === 'string' && sessionMetadata.current_waiter_name.trim()) ||
    table?.currentWaiterName ||
    waiterOptions.find(option => option.id === currentWaiterId)?.name ||
    '';
  const currentWaiterLabel = currentWaiterName || tr('labels.unassignedWaiter', 'Unassigned');
  const staffMemberFallbackLabel = tr('labels.staffMember', 'Staff member');

  const paidQuantityByItemId = useMemo(() => {
    const map = new Map<string, number>();
    for (const paidItem of paidItemRecords) {
      const itemIndex = Number(paidItem.itemIndex ?? paidItem.item_index ?? -1);
      const item = Number.isInteger(itemIndex) && itemIndex >= 0 ? orderItems[itemIndex] : null;
      if (!item) {
        continue;
      }
      const quantity = Math.max(0, Number(paidItem.itemQuantity ?? paidItem.item_quantity ?? 0) || 0);
      map.set(item.id, Number(((map.get(item.id) || 0) + quantity).toFixed(3)));
    }
    return map;
  }, [orderItems, paidItemRecords]);

  const availableQuantityByItemId = useMemo(() => {
    const totalByItemId = new Map<string, number>();
    const unpaidByItemId = new Map<string, number>();
    for (const allocation of session?.items || []) {
      if (!allocation.order_item_id || allocation.status === 'transferred' || allocation.status === 'voided') {
        continue;
      }
      const quantity = Number(allocation.quantity || 0);
      const paidQuantity = Number(allocation.paid_quantity || 0);
      const unpaidQuantity = Math.max(0, quantity - paidQuantity);
      totalByItemId.set(allocation.order_item_id, Number(((totalByItemId.get(allocation.order_item_id) || 0) + quantity).toFixed(3)));
      unpaidByItemId.set(allocation.order_item_id, Number(((unpaidByItemId.get(allocation.order_item_id) || 0) + unpaidQuantity).toFixed(3)));
    }

    const map = new Map<string, number>();
    for (const item of orderItems) {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const allocationTotal = totalByItemId.get(item.id);
      const allocationUnpaid = unpaidByItemId.get(item.id);
      const allocationPaid = allocationTotal !== undefined && allocationUnpaid !== undefined
        ? Math.max(0, allocationTotal - allocationUnpaid)
        : 0;
      const ledgerPaid = paidQuantityByItemId.get(item.id) || 0;
      const paidQuantity = Math.max(allocationPaid, ledgerPaid);
      map.set(item.id, Number(Math.max(0, quantity - paidQuantity).toFixed(3)));
    }
    return map;
  }, [orderItems, paidQuantityByItemId, session?.items]);

  const unpaidAmountByItemId = useMemo(
    () => buildUnpaidAmountByItemId(orderItems, paidItemRecords, paidTotal, itemLineTotal),
    [orderItems, paidItemRecords, paidTotal],
  );

  const selectedTransferItem =
    (transferItemId ? orderItems.find(item => item.id === transferItemId) : null) ||
    selectedItem ||
    orderItems[0] ||
    null;
  const selectedTransferAvailable = selectedTransferItem
    ? availableQuantityByItemId.get(selectedTransferItem.id) || Number(selectedTransferItem.quantity || 0)
    : 0;
  const selectedItemAvailable = selectedItem
    ? availableQuantityByItemId.get(selectedItem.id) || Number(selectedItem.quantity || 0)
    : 0;
  const selectedItemUnpaidAmount = selectedItem
    ? unpaidAmountByItemId.get(selectedItem.id) ?? Number((itemUnitPrice(selectedItem) * selectedItemAvailable).toFixed(2))
    : 0;
  const selectedItemPaidAmount = selectedItem
    ? Math.max(0, Number((itemLineTotal(selectedItem) - selectedItemUnpaidAmount).toFixed(2)))
    : 0;
  const selectedItemPayAmount = selectedItem
    ? Math.min(
        selectedItemUnpaidAmount,
        Number((itemUnitPrice(selectedItem) * Math.max(1, Number(itemPayQuantity || 1))).toFixed(2)),
      )
    : 0;
  const isBatchMode = isBatchItemSelectionActive(batchSelectedItemIds);
  const batchSelectedItems = useMemo(
    () => getSelectedBatchItems(orderItems, batchSelectedItemIds),
    [batchSelectedItemIds, orderItems],
  );
  const batchUnpaidItemEntries = useMemo(
    () => batchSelectedItems
      .map(item => {
        const itemQuantityValue = Math.max(0, availableQuantityByItemId.get(item.id) || 0);
        const itemAmount = Math.max(0, unpaidAmountByItemId.get(item.id) || 0);
        return { item, itemQuantity: itemQuantityValue, itemAmount };
      })
      .filter(entry => entry.itemQuantity > 0 && entry.itemAmount > 0.009),
    [availableQuantityByItemId, batchSelectedItems, unpaidAmountByItemId],
  );
  const batchSelectedTotal = useMemo(
    () => Number(batchUnpaidItemEntries.reduce((sum, entry) => sum + entry.itemAmount, 0).toFixed(2)),
    [batchUnpaidItemEntries],
  );
  const isSessionLocalOnly = isLocalSessionId(session?.id);

  const loadSession = useCallback(async () => {
    if (!isOpen || !table) {
      return;
    }

    setIsLoading(true);
    const applySession = (nextSession: TableSessionDetails) => {
      setSession(nextSession);
      const covers = normalizeGuestCount(nextSession.guest_count || table.guestCount || 1);
      setGuestCount(covers);
      setPaymentAmount(Number(nextSession.balance?.outstanding_balance || 0).toFixed(2));
      emitTableSessionBalanceUpdate(table.id, nextSession, covers);
      setTargetTableId('');
      setMergeTableId('');
      const firstItem = nextSession.order?.order_items?.[0];
      setTransferItemId(firstItem?.id || '');
      setTransferQuantity('1');
      setItemPayQuantity('1');
    };

    let localOrder: Order | null = null;
    let localFallback: TableSessionDetails | null = null;
    let localOrderRepairId = '';

    try {
      const localOrderFromState =
        findOpenTableOrderForTable(localOrders as any[], table) ||
        (table.currentOrderId ? findTableOrderForTable(localOrders as any[], table) : null);

      // Local bridge order lookup — time-bounded so a hung/failed/rejecting promise
      // degrades to the in-memory local orders instead of stranding the modal on the
      // loading spinner (a never-settling promise never reaches try/catch/finally).
      const bridgeOrders = (await resolveWithTimeout(fetchBridgeOrders(), [] as Order[])) as any[];

      localOrder =
        findOpenTableOrderForTable(bridgeOrders, table) ||
        localOrderFromState ||
        (table.currentOrderId ? findTableOrderForTable(bridgeOrders, table) : null);
      localFallback = localOrder ? buildLocalSessionFromOrder(table, localOrder, translatedItemFallback) : null;
      localOrderRepairId = localOrder
        ? String(
            (localOrder as any).supabase_id ??
              (localOrder as any).supabaseId ??
              localOrder.id ??
              ''
          ).trim()
        : '';

      // Local payment snapshot — time-bounded too; on hang/failure use an empty
      // snapshot so the check still loads.
      const localPaymentSnapshot = await resolveWithTimeout(
        fetchLocalPaymentSnapshot(localOrder?.id),
        { payments: [], paidItems: [] },
      );
      setPaymentHistory(localPaymentSnapshot.payments);
      setPaidItemRecords(localPaymentSnapshot.paidItems);

      let sessionId = table.tableSessionId;
      if (!sessionId) {
        try {
          const listResult = await posApiGet<{ success?: boolean; sessions?: TableSessionDetails[] }>(
            `/api/pos/table-sessions?table_id=${encodeURIComponent(table.id)}`,
          );
          if (!listResult.success || listResult.data?.success === false) {
            throw new Error(listResult.error || tr('errors.loadSessionsFailed', 'Failed to load table sessions'));
          }
          sessionId = listResult.data?.sessions?.[0]?.id || null;
        } catch (listError) {
          if (localFallback) {
            applySession(localFallback);
            return;
          }
          throw listError;
        }
      }

      const repairOrderReference = table.currentOrderId || localOrderRepairId;

      if (!sessionId && repairOrderReference) {
        const repairPayload = buildTableSessionOpenPayload({
          table,
          orderId: repairOrderReference,
          orderData: localOrder as any,
          guestCount: table.guestCount || 1,
          customerName: tr('labels.tableNumber', 'Table {{number}}', { number: table.tableNumber }),
        });

        try {
          const openResult = await posApiPost<{ success?: boolean; session?: TableSessionDetails; error?: string }>(
            '/api/pos/table-sessions',
            repairPayload,
          );
          if (!openResult.success || openResult.data?.success === false || !openResult.data?.session) {
            throw new Error(openResult.error || openResult.data?.error || tr('errors.reopenFailed', 'Failed to reopen table check'));
          }

          sessionId = openResult.data.session.id;
          await Promise.resolve(onRefreshTables());
        } catch (openError) {
          if (isRetryableTableServiceError(openError)) {
            try {
              await enqueueTableSessionOpen({
                organizationId: table.organizationId,
                branchId: table.branchId,
                payload: repairPayload,
              });
            } catch (queueError) {
              console.warn('[TableCheckManagerModal] Failed to queue table session repair:', queueError);
            }

            if (localFallback) {
              applySession(localFallback);
            }
            return;
          }

          if (localFallback) {
            applySession(localFallback);
            return;
          }
          throw openError;
        }
      }

      if (!sessionId) {
        if (localFallback) {
          applySession(localFallback);
          return;
        }
        throw new Error(tr('errors.noActiveSession', 'No active table session found for this table.'));
      }

      const detailResult = await posApiGet<{ success?: boolean; session?: TableSessionDetails }>(
        `/api/pos/table-sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!detailResult.success || detailResult.data?.success === false || !detailResult.data?.session) {
        if (localFallback) {
          applySession(localFallback);
          return;
        }
        throw new Error(detailResult.error || tr('errors.loadCheckFailed', 'Failed to load table check'));
      }

      applySession(mergeSessionWithLocalOrder(table, detailResult.data.session, localOrder || null, translatedItemFallback));
    } catch (error) {
      if (localFallback) {
        applySession(localFallback);
        return;
      }
      console.error('[TableCheckManagerModal] Failed to load table check:', error);
      toast.error(error instanceof Error ? error.message : tr('errors.loadCheckFailed', 'Failed to load table check'));
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, localOrders, onRefreshTables, table, tr, translatedItemFallback]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    setBatchSelectedItemIds(current => {
      const next = clearMissingBatchItemSelection(current, orderItems.map(item => item.id));
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [orderItems]);

  useEffect(() => {
    if (!isOpen) {
      setBatchSelectedItemIds([]);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !table?.branchId) {
      setWaiterOptions(current => (current.length > 0 ? [] : current));
      return;
    }

    let cancelled = false;
    const loadWaiters = async () => {
      setIsLoadingWaiters(true);
      try {
        const result = await getBridge().staffAuth.refreshDirectory({ branchId: table.branchId });
        if (cancelled) {
          return;
        }
        const staff = Array.isArray(result?.staff) ? result.staff : [];
        const options = staff
          .filter(member => member?.id && member.isActive !== false && member.canLoginPos !== false)
          .map(member => ({
            id: String(member.id),
            name: member.name || staffMemberFallbackLabel,
            role: member.currentShift?.role || null,
            active: Boolean(member.currentShift?.shiftId),
          }));
        const tableServiceRoles = new Set(['server', 'waiter', 'cashier', 'manager']);
        const activeTableServiceOptions = options.filter(option =>
          option.active && (!option.role || tableServiceRoles.has(String(option.role).toLowerCase())),
        );
        setWaiterOptions(activeTableServiceOptions.length > 0 ? activeTableServiceOptions : options);
      } catch (error) {
        if (!cancelled) {
          console.warn('[TableCheckManagerModal] Failed to load waiter directory:', error);
          setWaiterOptions([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingWaiters(false);
        }
      }
    };

    void loadWaiters();

    return () => {
      cancelled = true;
    };
  }, [isOpen, table?.branchId, staffMemberFallbackLabel]);

  useEffect(() => () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setOccupiedClockMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshAll = async () => {
    await Promise.all([
      Promise.resolve(onRefreshTables()),
      Promise.resolve(onRefreshOrders()),
    ]);
    await loadSession();
  };

  const closeSecondaryModal = () => {
    setSecondaryModal(null);
    setItemActionMode('menu');
  };

  const openPayTableModal = (amount?: number) => {
    setPaymentAmount(Number(amount ?? outstanding).toFixed(2));
    setTipAmount('0.00');
    setSeatNumber('');
    setSecondaryModal('pay-table');
  };

  const openAssignWaiterModal = () => {
    setSelectedWaiterId(currentWaiterId || '');
    setSecondaryModal('assign-waiter');
  };

  const openItemActions = (item: TableSessionOrderItem) => {
    setSelectedItem(item);
    setTransferItemId(item.id);
    setItemPayQuantity('1');
    setItemPriceValue(itemUnitPrice(item).toFixed(2));
    setDiscountMode('percentage');
    setDiscountValue('');
    setItemActionMode('menu');
    setSecondaryModal('item-actions');
  };

  const openTransferModal = (item?: TableSessionOrderItem) => {
    const targetItem = item || selectedTransferItem;
    if (targetItem) {
      setSelectedItem(targetItem);
      setTransferItemId(targetItem.id);
      const available = availableQuantityByItemId.get(targetItem.id) || Number(targetItem.quantity || 1);
      setTransferQuantity(String(Math.max(1, Math.min(1, available))));
    }
    setTargetTableId('');
    setTransferSeatNumber('');
    setSecondaryModal('transfer-item');
  };

  const openMoveTableModal = () => {
    // Always start with no destination so a canceled prior selection cannot carry
    // into the next move attempt; the final action stays disabled until reselected.
    setTargetTableId('');
    setSecondaryModal('move-table');
  };

  const openMergeTableModal = () => {
    // Mirror the move opener: clear any stale merge target on open.
    setMergeTableId('');
    setSecondaryModal('merge-table');
  };

  const clearBatchSelection = () => {
    setBatchSelectedItemIds([]);
  };

  const openBatchPayModal = () => {
    if (batchUnpaidItemEntries.length === 0) {
      toast.error(tr('errors.noBatchPayableItems', 'Select at least one unpaid item.'));
      return;
    }
    setPaymentAmount(batchSelectedTotal.toFixed(2));
    setTipAmount('0.00');
    setSeatNumber('');
    setSecondaryModal('batch-pay');
  };

  const openBatchTransferModal = () => {
    if (batchUnpaidItemEntries.length === 0) {
      toast.error(tr('errors.noBatchTransferItems', 'Select at least one unpaid item to move.'));
      return;
    }
    setTargetTableId('');
    setTransferSeatNumber('');
    setSecondaryModal('batch-transfer');
  };

  const openBatchDiscountModal = () => {
    if (batchSelectedItems.length === 0) {
      toast.error(tr('errors.noBatchSelectedItems', 'Select at least one item.'));
      return;
    }
    setDiscountMode('percentage');
    setDiscountValue('');
    setSecondaryModal('batch-discount');
  };

  const clearPressTimer = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const handleItemPointerDown = (item: TableSessionOrderItem, event: React.PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    clearPressTimer();
    longPressTriggeredRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      closeSecondaryModal();
      setBatchSelectedItemIds(current => beginBatchItemSelection(current, item.id));
    }, 430);
  };

  const handleItemPointerUp = (item: TableSessionOrderItem) => {
    clearPressTimer();
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (isBatchMode) {
      setBatchSelectedItemIds(current => toggleBatchItemSelection(current, item.id));
      return;
    }
    openItemActions(item);
  };

  const patchSession = async (body: Record<string, unknown>, successMessage: string) => {
    if (!session) return;
    if (isSessionLocalOnly) {
      toast.error(tr('errors.localSessionDetailsSyncing', 'This table check is still syncing. Refresh after sync before changing table details.'));
      return;
    }
    setIsSaving(true);
    const requestBody = {
      ...body,
      client_event_id: `pos-tauri-table-${body.action}-${session.id}-${Date.now()}`,
    };
    try {
      const result = await posApiPatch<{ success?: boolean; session?: TableSessionDetails; error?: string }>(
        `/api/pos/table-sessions/${encodeURIComponent(session.id)}`,
        requestBody,
      );
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || tr('errors.sessionUpdateFailed', 'Table session update failed'));
      }
      setSession(result.data?.session || session);
      toast.success(successMessage);
      closeSecondaryModal();
      await refreshAll();
    } catch (error) {
      console.error('[TableCheckManagerModal] Session update failed:', error);
      if (isRetryableTableServiceError(error)) {
        try {
          await enqueueTableSessionUpdate({
            organizationId: table?.organizationId,
            branchId: table?.branchId,
            sessionId: session.id,
            payload: requestBody,
          });
          toast.success(tr('messages.tableActionQueued', 'Table action queued for sync'));
          closeSecondaryModal();
          return;
        } catch (queueError) {
          console.warn('[TableCheckManagerModal] Failed to queue session update:', queueError);
        }
      }
      toast.error(error instanceof Error ? error.message : tr('errors.sessionUpdateFailed', 'Table session update failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const closeSettledTableAfterPayment = async () => {
    if (!session || !table?.id) {
      return;
    }

    const requestBody = {
      action: 'close',
      status: 'closed',
      release_status: 'cleaning',
      force: true,
      client_event_id: `pos-tauri-table-close-${session.id}-${Date.now()}`,
    };

    const emitCleaningRelease = () => {
      emitCompatEvent('table-session-settled', {
        tableId: table.id,
        tableSessionId: session.id,
        orderId: session.active_order_id,
        releaseStatus: 'cleaning',
      });
    };

    try {
      if (isSessionLocalOnly) {
        await enqueueTableSessionUpdate({
          organizationId: table.organizationId,
          branchId: table.branchId,
          sessionId: session.id,
          payload: requestBody,
        });
      } else {
        const result = await posApiPatch<{ success?: boolean; session?: TableSessionDetails; error?: string }>(
          `/api/pos/table-sessions/${encodeURIComponent(session.id)}`,
          requestBody,
        );
        if (!result.success || result.data?.success === false) {
          throw new Error(result.error || result.data?.error || tr('errors.sessionUpdateFailed', 'Table session update failed'));
        }
      }
    } catch (error) {
      if (isRetryableTableServiceError(error) || isOutstandingTableSessionBalanceError(error)) {
        try {
          await enqueueTableSessionUpdate({
            organizationId: table.organizationId,
            branchId: table.branchId,
            sessionId: session.id,
            payload: requestBody,
          });
        } catch (queueError) {
          console.warn('[TableCheckManagerModal] Failed to queue settled table close:', queueError);
        }
      } else {
        console.error('[TableCheckManagerModal] Failed to close settled table:', error);
        toast.error(error instanceof Error ? error.message : tr('errors.sessionUpdateFailed', 'Table session update failed'));
      }
    }

    emitCleaningRelease();
    closeSecondaryModal();
    onClose();
    void Promise.all([
      Promise.resolve(onRefreshTables()),
      Promise.resolve(onRefreshOrders()),
    ]).catch(() => undefined);
  };

  const recordPayment = async (
    method: PaymentMethod,
    options?: {
      item?: TableSessionOrderItem;
      itemQuantity?: number;
      itemAmount?: number;
      items?: Array<{ item: TableSessionOrderItem; itemQuantity: number; itemAmount?: number }>;
    },
  ): Promise<boolean> => {
    if (!session?.active_order_id) {
      toast.error(tr('errors.noActiveOrder', 'No active order is linked to this table.'));
      return false;
    }

    const itemPaymentEntries = options?.items?.length
      ? options.items
      : options?.item
        ? [{
            item: options.item,
            itemQuantity: Math.max(1, options.itemQuantity || 1),
            itemAmount: options.itemAmount,
          }]
        : [];
    const amount = itemPaymentEntries.length > 0
      ? Number(itemPaymentEntries.reduce((sum, entry) => {
          const quantity = Math.max(1, Number(entry.itemQuantity || 1));
          const itemAmount = entry.itemAmount !== undefined
            ? Math.max(0, Number(entry.itemAmount || 0))
            : Number((itemUnitPrice(entry.item) * quantity).toFixed(2));
          return sum + itemAmount;
        }, 0).toFixed(2))
      : parseMoneyInput(paymentAmount);

    if (amount <= 0) {
      toast.error(tr('errors.paymentAmountRequired', 'Enter a payment amount greater than zero.'));
      return false;
    }
    const tipValue = parseMoneyInput(tipAmount);
    const nextPaidAfterPayment = Number((paidTotal + amount).toFixed(2));
    const nextOutstandingAfterPayment = Number(Math.max(0, orderTotal - nextPaidAfterPayment).toFixed(2));
    const isFullySettledAfterPayment = nextOutstandingAfterPayment <= 0.01;
    const localPaymentItems: RecordPaymentParams['items'] | undefined = itemPaymentEntries.length > 0
      ? itemPaymentEntries.map(entry => {
          const itemPaymentQuantity = Math.max(1, Number(entry.itemQuantity || 1));
          const itemAmount = entry.itemAmount !== undefined
            ? Math.max(0, Number(entry.itemAmount || 0))
            : Number((itemUnitPrice(entry.item) * itemPaymentQuantity).toFixed(2));
          const selectedItemIndex = Math.max(0, orderItems.findIndex(item => item.id === entry.item.id));
          return {
            order_item_id: entry.item.id,
            itemIndex: selectedItemIndex,
            itemName: itemDisplayName(entry.item, translatedItemFallback),
            item_name: itemDisplayName(entry.item, translatedItemFallback),
            itemQuantity: itemPaymentQuantity,
            item_quantity: itemPaymentQuantity,
            quantity: itemPaymentQuantity,
            itemAmount,
            item_amount: itemAmount,
            item_amount_cents: Math.round(itemAmount * 100),
          };
        })
      : undefined;

    const payload = buildTableSessionPaymentPayload({
      orderId: session.active_order_id,
      tableSessionId: session.id,
      amount,
      method,
      tipAmount: tipValue,
      seatNumber,
      idempotencyKey: `pos-tauri-table-payment-${session.id}-${Date.now()}`,
      items: localPaymentItems,
    });
    const localPaymentPayload: RecordPaymentParams = {
      orderId: session.active_order_id,
      order_id: session.active_order_id,
      method,
      payment_method: method,
      amount,
      amount_cents: Math.round(amount * 100),
      currency: 'EUR',
      cashReceived: method === 'cash' ? amount : undefined,
      changeGiven: method === 'cash' ? 0 : undefined,
      tipAmount: tipValue,
      tip_amount: tipValue,
      tip_amount_cents: Math.round(tipValue * 100),
      tableSessionId: session.id,
      table_session_id: session.id,
      seatNumber: seatNumber ? Number(seatNumber) : undefined,
      seat_number: seatNumber ? Number(seatNumber) : undefined,
      paymentOrigin: 'manual' as const,
      idempotencyKey: payload.idempotency_key,
      idempotency_key: payload.idempotency_key,
      items: localPaymentItems,
    };

    setIsSaving(true);
    try {
      const bridge = getBridge();
      const result: any = await bridge.payments.recordPayment(localPaymentPayload);
      if (result?.success === false) {
        throw new Error(result?.error || tr('errors.paymentFailed', 'Payment failed'));
      }

      setSession(current => {
        if (!current?.balance) {
          return current;
        }
        const nextPaid = Number(((Number(current.balance.paid_total || 0) + amount)).toFixed(2));
        const nextTip = Number(((Number(current.balance.tip_total || 0) + tipValue)).toFixed(2));
        const nextOutstanding = Number(Math.max(0, Number(current.balance.order_total || 0) - nextPaid).toFixed(2));
        return {
          ...current,
          status: nextOutstanding <= 0.01 ? 'settled' : 'partially_paid',
          balance: {
            ...current.balance,
            paid_total: nextPaid,
            tip_total: nextTip,
            outstanding_balance: nextOutstanding,
            payment_status: nextOutstanding <= 0.01 ? 'paid' : 'partially_paid',
          },
          order: current.order
            ? {
                ...current.order,
                payment_status: nextOutstanding <= 0.01 ? 'paid' : 'partially_paid',
              }
            : current.order,
        };
      });
      const createdAt = new Date().toISOString();
      const paymentId = String(result?.paymentId || result?.payment_id || crypto.randomUUID());
      setPaymentHistory(current => [
        {
          id: paymentId,
          method,
          amount,
          amount_cents: Math.round(amount * 100),
          tipAmount: tipValue,
          tip_amount_cents: Math.round(tipValue * 100),
          status: 'completed',
          createdAt,
          items: localPaymentItems,
        },
        ...current.filter(payment => payment.id !== paymentId),
      ]);
      if (localPaymentItems?.length) {
        setPaidItemRecords(current => [
          ...localPaymentItems.map(item => ({
            itemIndex: Number(item.itemIndex ?? 0),
            itemQuantity: Number(item.itemQuantity ?? item.quantity ?? 1),
            itemAmount: Number(item.itemAmount ?? item.item_amount ?? amount),
          })),
          ...current,
        ]);
      }
      toast.success(tr('messages.paymentRecorded', '{{method}} payment recorded', {
        method: method === 'cash' ? tr('paymentMethods.cash', 'Cash') : tr('paymentMethods.card', 'Card'),
      }));
      if (isFullySettledAfterPayment) {
        await closeSettledTableAfterPayment();
      } else {
        closeSecondaryModal();
        await refreshAll().catch(() => undefined);
      }
      return true;
    } catch (error) {
      console.error('[TableCheckManagerModal] Payment failed:', error);
      if (isRetryableTableServiceError(error)) {
        try {
          await enqueueTablePayment({
            organizationId: table?.organizationId,
            branchId: table?.branchId,
            payload,
          });
          toast.success(tr('messages.paymentQueued', 'Payment queued for sync'));
          closeSecondaryModal();
          await refreshAll();
          return true;
        } catch (queueError) {
          console.warn('[TableCheckManagerModal] Failed to queue payment:', queueError);
        }
      }
      toast.error(error instanceof Error ? error.message : tr('errors.paymentFailed', 'Payment failed'));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const saveUpdatedOrderItems = async (
    nextItems: Array<Record<string, unknown>>,
    successMessage: string,
  ) => {
    const orderId = session?.active_order_id || session?.order?.id;
    if (!orderId) {
      toast.error(tr('errors.noActiveOrder', 'No active order is linked to this table.'));
      return;
    }

    setIsSaving(true);
    try {
      const bridge = getBridge();
      const result: any = await bridge.orders.updateItems(orderId, nextItems as any);
      if (result?.success === false) {
        throw new Error(result.error || tr('errors.orderItemUpdateFailed', 'Order item update failed'));
      }

      const nextOrderItems = nextItems.map(tableItemFromEditable);
      const nextTotal = Number(nextOrderItems.reduce((sum, item) => sum + itemLineTotal(item), 0).toFixed(2));
      const nextOutstanding = Math.max(0, nextTotal - paidTotal);
      setSession(prev => prev
        ? {
            ...prev,
            balance: {
              ...prev.balance,
              order_total: nextTotal,
              outstanding_balance: nextOutstanding,
            },
            order: {
              ...(prev.order || { id: orderId }),
              total_amount: nextTotal,
              order_items: nextOrderItems,
            },
          }
        : prev);
      setPaymentAmount(nextOutstanding.toFixed(2));
      toast.success(successMessage);
      closeSecondaryModal();
      await Promise.resolve(onRefreshOrders());
    } catch (error) {
      console.error('[TableCheckManagerModal] Item edit failed:', error);
      toast.error(error instanceof Error ? error.message : tr('errors.orderItemUpdateFailed', 'Order item update failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const applySelectedItemPrice = () => {
    if (!selectedItem) return;
    const nextUnitPrice = parseMoneyInput(itemPriceValue);
    const nextItems = orderItems.map(item => {
      const editable = toEditableOrderItem(item, translatedItemFallback);
      if (item.id !== selectedItem.id) {
        return editable;
      }
      const quantity = itemQuantity(item);
      return {
        ...editable,
        original_unit_price: editable.original_unit_price ?? itemUnitPrice(item),
        originalUnitPrice: editable.originalUnitPrice ?? itemUnitPrice(item),
        price: nextUnitPrice,
        unit_price: nextUnitPrice,
        unitPrice: nextUnitPrice,
        total_price: Number((nextUnitPrice * quantity).toFixed(2)),
        totalPrice: Number((nextUnitPrice * quantity).toFixed(2)),
        is_price_overridden: true,
        isPriceOverridden: true,
      };
    });
    void saveUpdatedOrderItems(nextItems, tr('messages.itemPriceUpdated', 'Item price updated'));
  };

  const applySelectedItemDiscount = () => {
    if (!selectedItem) return;
    const rawValue = parseMoneyInput(discountValue);
    const currentTotal = itemLineTotal(selectedItem);
    const discountAmount =
      discountMode === 'percentage'
        ? currentTotal * (Math.min(rawValue, 100) / 100)
        : Math.min(rawValue, currentTotal);
    const nextTotal = Math.max(0, Number((currentTotal - discountAmount).toFixed(2)));
    const nextUnitPrice = Number((nextTotal / itemQuantity(selectedItem)).toFixed(2));
    const nextItems = orderItems.map(item => {
      const editable = toEditableOrderItem(item, translatedItemFallback);
      if (item.id !== selectedItem.id) {
        return editable;
      }
      return {
        ...editable,
        original_unit_price: editable.original_unit_price ?? itemUnitPrice(item),
        originalUnitPrice: editable.originalUnitPrice ?? itemUnitPrice(item),
        price: nextUnitPrice,
        unit_price: nextUnitPrice,
        unitPrice: nextUnitPrice,
        total_price: nextTotal,
        totalPrice: nextTotal,
        discount: Number(discountAmount.toFixed(2)),
        discountAmount: Number(discountAmount.toFixed(2)),
        is_price_overridden: true,
        isPriceOverridden: true,
      };
    });
    void saveUpdatedOrderItems(nextItems, tr('messages.discountApplied', 'Discount applied'));
  };

  const emitTargetTransferBalanceUpdate = (nextTargetTableId: string, movedTotal: number) => {
    const targetTable = tables.find(candidate => candidate.id === nextTargetTableId);
    const existingBalance = targetTable?.balance || null;
    const existingOrderTotal = Math.max(0, Number(existingBalance?.order_total ?? 0) || 0);
    const existingPaidTotal = Math.max(0, Number(existingBalance?.paid_total ?? 0) || 0);
    const existingTipTotal = Math.max(0, Number(existingBalance?.tip_total ?? 0) || 0);

    emitCompatEvent('table-session-balance-updated', {
      tableId: nextTargetTableId,
      orderId: session?.active_order_id || session?.order?.id || targetTable?.currentOrderId || null,
      tableSessionId: targetTable?.tableSessionId || null,
      guestCount: targetTable?.guestCount ?? table?.guestCount ?? 1,
      occupiedSince: targetTable?.occupiedSince || new Date().toISOString(),
      orderTotal: Number((existingOrderTotal + Math.max(0, movedTotal)).toFixed(2)),
      paidTotal: existingPaidTotal,
      tipTotal: existingTipTotal,
    });
  };

  const transferItem = async () => {
    if (!session || !selectedTransferItem || !targetTableId) {
      toast.error(tr('errors.selectItemAndTargetTable', 'Select an item and target table.'));
      return;
    }
    if (isSessionLocalOnly) {
      toast.error(tr('errors.localSessionTransferSyncing', 'This table check is still syncing. Refresh after sync before moving items.'));
      return;
    }

    const requestedQuantity = Math.max(0, Number(transferQuantity || 0));
    if (requestedQuantity <= 0 || requestedQuantity > selectedTransferAvailable) {
      toast.error(tr('errors.quantityUpTo', 'Enter a quantity up to {{quantity}}.', { quantity: selectedTransferAvailable }));
      return;
    }

    setIsSaving(true);
    const transferPayload = {
      order_item_id: selectedTransferItem.id,
      quantity: requestedQuantity,
      target_table_id: targetTableId,
      source_table_id: table?.id,
      target_seat_number: transferSeatNumber ? normalizeGuestCount(transferSeatNumber) : null,
      ...buildTransferPricingPayload(selectedTransferItem, requestedQuantity),
      client_event_id: `pos-tauri-table-item-transfer-${session.id}-${Date.now()}`,
    };
    try {
      const result = await posApiPost<{ success?: boolean; source_session?: TableSessionDetails; error?: string }>(
        `/api/pos/table-sessions/${encodeURIComponent(session.id)}/items/transfer`,
        transferPayload,
      );
      if (!result.success || result.data?.success === false) {
        throw new Error(result.error || result.data?.error || tr('errors.itemTransferFailed', 'Item transfer failed'));
      }
      const nextSourceSession = result.data?.source_session || session;
      setSession(nextSourceSession);
      emitTableSessionBalanceUpdate(table?.id, nextSourceSession, nextSourceSession.guest_count ?? table?.guestCount);
      emitTargetTransferBalanceUpdate(targetTableId, Number((itemUnitPrice(selectedTransferItem) * requestedQuantity).toFixed(2)));
      toast.success(tr('messages.itemMoved', 'Item moved to target table'));
      closeSecondaryModal();
      await refreshAll();
    } catch (error) {
      console.error('[TableCheckManagerModal] Item transfer failed:', error);
      if (isRetryableTableServiceError(error)) {
        try {
          await enqueueTableItemTransfer({
            organizationId: table?.organizationId,
            branchId: table?.branchId,
            sourceSessionId: session.id,
            payload: transferPayload,
          });
          toast.success(tr('messages.itemTransferQueued', 'Item transfer queued for sync'));
          closeSecondaryModal();
          return;
        } catch (queueError) {
          console.warn('[TableCheckManagerModal] Failed to queue item transfer:', queueError);
        }
      }
      toast.error(error instanceof Error ? error.message : tr('errors.itemTransferFailed', 'Item transfer failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const recordBatchPayment = async (method: PaymentMethod) => {
    if (batchUnpaidItemEntries.length === 0) {
      toast.error(tr('errors.noBatchPayableItems', 'Select at least one unpaid item.'));
      return;
    }
    const saved = await recordPayment(method, { items: batchUnpaidItemEntries });
    if (saved) {
      clearBatchSelection();
    }
  };

  const transferBatchItems = async () => {
    if (!session || !targetTableId) {
      toast.error(tr('errors.selectItemAndTargetTable', 'Select an item and target table.'));
      return;
    }
    if (isSessionLocalOnly) {
      toast.error(tr('errors.localSessionTransferSyncing', 'This table check is still syncing. Refresh after sync before moving items.'));
      return;
    }
    if (batchUnpaidItemEntries.length === 0) {
      toast.error(tr('errors.noBatchTransferItems', 'Select at least one unpaid item to move.'));
      return;
    }

    setIsSaving(true);
    const transferPayloads = batchUnpaidItemEntries.map((entry, index) => ({
      order_item_id: entry.item.id,
      quantity: entry.itemQuantity,
      target_table_id: targetTableId,
      source_table_id: table?.id,
      target_seat_number: transferSeatNumber ? normalizeGuestCount(transferSeatNumber) : null,
      ...buildTransferPricingPayload(entry.item, entry.itemQuantity),
      client_event_id: `pos-tauri-table-batch-transfer-${session.id}-${entry.item.id}-${Date.now()}-${index}`,
    }));

    try {
      let nextSourceSession: TableSessionDetails | null = null;
      for (const payload of transferPayloads) {
        const result = await posApiPost<{ success?: boolean; source_session?: TableSessionDetails; error?: string }>(
          `/api/pos/table-sessions/${encodeURIComponent(session.id)}/items/transfer`,
          payload,
        );
        if (!result.success || result.data?.success === false) {
          throw new Error(result.error || result.data?.error || tr('errors.itemTransferFailed', 'Item transfer failed'));
        }
        nextSourceSession = result.data?.source_session || nextSourceSession;
      }

      if (nextSourceSession) {
        setSession(nextSourceSession);
        emitTableSessionBalanceUpdate(table?.id, nextSourceSession, nextSourceSession.guest_count ?? table?.guestCount);
      }
      emitTargetTransferBalanceUpdate(
        targetTableId,
        Number(batchUnpaidItemEntries.reduce((sum, entry) => {
          return sum + itemUnitPrice(entry.item) * entry.itemQuantity;
        }, 0).toFixed(2)),
      );
      toast.success(tr('messages.batchItemsMoved', '{{count}} items moved to target table', { count: transferPayloads.length }));
      clearBatchSelection();
      closeSecondaryModal();
      await refreshAll();
    } catch (error) {
      console.error('[TableCheckManagerModal] Batch item transfer failed:', error);
      if (isRetryableTableServiceError(error)) {
        try {
          await Promise.all(transferPayloads.map(payload => enqueueTableItemTransfer({
            organizationId: table?.organizationId,
            branchId: table?.branchId,
            sourceSessionId: session.id,
            payload,
          })));
          toast.success(tr('messages.itemTransferQueued', 'Item transfer queued for sync'));
          clearBatchSelection();
          closeSecondaryModal();
          return;
        } catch (queueError) {
          console.warn('[TableCheckManagerModal] Failed to queue batch item transfer:', queueError);
        }
      }
      toast.error(error instanceof Error ? error.message : tr('errors.itemTransferFailed', 'Item transfer failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const applyBatchItemDiscount = () => {
    if (batchSelectedItems.length === 0) {
      toast.error(tr('errors.noBatchSelectedItems', 'Select at least one item.'));
      return;
    }

    const rawValue = parseMoneyInput(discountValue);
    const selectedIds = new Set(batchSelectedItems.map(item => item.id));
    const selectedTotal = batchSelectedItems.reduce((sum, item) => sum + itemLineTotal(item), 0);
    const nextItems = orderItems.map(item => {
      const editable = toEditableOrderItem(item, translatedItemFallback);
      if (!selectedIds.has(item.id)) {
        return editable;
      }

      const currentTotal = itemLineTotal(item);
      const discountAmount =
        discountMode === 'percentage'
          ? currentTotal * (Math.min(rawValue, 100) / 100)
          : selectedTotal > 0
            ? Math.min(currentTotal, rawValue * (currentTotal / selectedTotal))
            : 0;
      const nextTotal = Math.max(0, Number((currentTotal - discountAmount).toFixed(2)));
      const nextUnitPrice = Number((nextTotal / itemQuantity(item)).toFixed(2));
      return {
        ...editable,
        original_unit_price: editable.original_unit_price ?? itemUnitPrice(item),
        originalUnitPrice: editable.originalUnitPrice ?? itemUnitPrice(item),
        price: nextUnitPrice,
        unit_price: nextUnitPrice,
        unitPrice: nextUnitPrice,
        total_price: nextTotal,
        totalPrice: nextTotal,
        discount: Number(discountAmount.toFixed(2)),
        discountAmount: Number(discountAmount.toFixed(2)),
        is_price_overridden: true,
        isPriceOverridden: true,
      };
    });

    void saveUpdatedOrderItems(
      nextItems,
      tr('messages.batchDiscountApplied', 'Discount applied to selected items'),
    ).then(clearBatchSelection);
  };

  const saveGuestCount = () => {
    void patchSession(
      { action: 'set_guest_count', guest_count: guestCount },
      tr('messages.guestCountUpdated', 'Guest count updated'),
    );
  };

  const saveWaiterAssignment = () => {
    const selectedWaiter = waiterOptions.find(option => option.id === selectedWaiterId);
    void patchSession(
      {
        action: 'assign_waiter',
        waiter_id: selectedWaiterId || null,
        waiter_name: selectedWaiter?.name || null,
      },
      selectedWaiter
        ? tr('messages.waiterAssigned', 'Waiter assigned')
        : tr('messages.waiterCleared', 'Waiter assignment cleared'),
    );
  };

  const closeTable = () => {
    void patchSession(
      { action: 'close', status: 'closed', release_status: 'cleaning' },
      tr('messages.tableClosedCleaning', 'Table closed and moved to cleaning'),
    );
  };

  const linkedTableLabels = (session?.tables || [])
    .filter(link => !link.released_at)
    .map(link => {
      const linked = tables.find(candidate => candidate.id === link.table_id);
      return linked ? formatTableDisplayNumber(linked.tableNumber) : link.table_id?.slice(0, 6);
    })
    .filter(Boolean);

  if (!isOpen || !table) {
    return null;
  }

  const mainSubtitle = [
    session?.order?.order_number
      ? tr('labels.orderNumber', 'Order {{number}}', { number: session.order.order_number })
      : tr('labels.openTableSession', 'Open table session'),
    linkedTableLabels.length > 0 ? linkedTableLabels.join(', ') : null,
  ].filter(Boolean).join(' · ');
  const occupiedSinceLabel = formatOccupiedSince(
    session?.opened_at || table.occupiedSince,
    occupiedClockMs,
    {
      hoursMinutes: (hours, minutes) => tr('time.hoursMinutes', '{{hours}}h {{minutes}}m', { hours, minutes }),
      minutes: (minutes) => tr('time.minutes', '{{minutes}}m', { minutes }),
      occupiedSince: (time, duration) => tr('labels.occupiedSince', 'Occupied since {{time}} · {{duration}}', { time, duration }),
    },
  );

  const modalContent = (
    <motion.div
      className="liquid-glass-modal-viewport"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="liquid-glass-modal-backdrop" aria-hidden="true" />
      <motion.div
        {...panelMotion}
        ref={mainDialogRef}
        className="liquid-glass-modal-shell relative flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={mainTitleId}
      >
        <div className="liquid-glass-modal-header px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border liquid-glass-modal-border bg-blue-500/15 text-blue-700 backdrop-blur-xl dark:text-blue-300">
              <Receipt className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id={mainTitleId} className="truncate text-xl font-semibold liquid-glass-modal-title">
                {tr('title', 'Table {{number}} Check', { number: formatTableDisplayNumber(table.tableNumber) })}
              </h2>
              <p className="truncate text-sm liquid-glass-modal-text-muted">{mainSubtitle}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {occupiedSinceLabel ? (
                  <span className="truncate text-xs font-medium text-blue-700/80 dark:text-blue-200/80">{occupiedSinceLabel}</span>
                ) : null}
                <button
                  type="button"
                  onClick={openAssignWaiterModal}
                  className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border border-blue-400/25 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-800 transition-colors hover:bg-blue-500/15 dark:text-blue-200"
                >
                  <UserCheck className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{currentWaiterLabel}</span>
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-lg border px-3 py-1 text-xs font-semibold ${
              outstanding > 0
                ? 'liquid-glass-modal-warning'
                : 'liquid-glass-modal-success'
            }`}>
              {outstanding > 0 ? tr('status.open', 'Open') : tr('status.settled', 'Settled')}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="liquid-glass-modal-close"
              aria-label={tr('aria.closeTableCheck', 'Close table check')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center liquid-glass-modal-text-muted">
            <Loader2 className="mr-2 h-6 w-6 animate-spin" />
            {tr('messages.loading', 'Loading table check...')}
          </div>
        ) : !session ? (
          <div className="flex flex-1 items-center justify-center liquid-glass-modal-text-muted">
            {tr('messages.noOpenCheck', 'No open check found for this table.')}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden p-5 lg:grid-cols-[1fr_360px]">
            <section className={`flex min-h-0 flex-col overflow-hidden ${glassSurfaceClass}`}>
              <div className="flex items-center justify-between border-b liquid-glass-modal-border px-4 py-3">
                <div>
                  <h3 className="text-base font-semibold liquid-glass-modal-text">{tr('labels.items', 'Items')}</h3>
                  <p className="text-xs liquid-glass-modal-text-muted">
                    {tr('labels.onCheck', '{{count}} on check', { count: orderItems.length })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isBatchMode ? (
                    <button
                      type="button"
                      onClick={clearBatchSelection}
                      className="rounded-lg border liquid-glass-modal-border px-3 py-2 text-sm font-semibold liquid-glass-modal-text-muted transition-colors hover:bg-white/25 dark:hover:bg-white/10"
                    >
                      {tr('actions.clearSelection', 'Clear')}
                    </button>
                  ) : null}
                  <ActionButton onClick={() => onAddItems(table, guestCount, session)} tone="card" className="min-h-10">
                    <Plus className="h-4 w-4" />
                    {tr('actions.addItems', 'Add Items')}
                  </ActionButton>
                </div>
              </div>
              <AnimatePresence>
                {isBatchMode ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="border-b liquid-glass-modal-border px-4 py-3"
                  >
                    <div className={`${glassSubtleSurfaceClass} flex flex-wrap items-center justify-between gap-3 p-3`}>
                      <div>
                        <p className="text-sm font-semibold liquid-glass-modal-text">
                          {tr('labels.batchSelectedCount', '{{count}} selected', { count: batchSelectedItems.length })}
                        </p>
                        <p className="text-xs liquid-glass-modal-text-muted">
                          {tr('labels.batchSelectedTotal', '{{amount}} unpaid selected', { amount: money(batchSelectedTotal) })}
                        </p>
                      </div>
                      <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:min-w-[420px]">
                        <ActionButton onClick={openBatchPayModal} disabled={batchSelectedTotal <= 0} tone="card" className="min-h-10">
                          <HandCoins className="h-4 w-4" />
                          {tr('actions.paySelected', 'Pay Selected')}
                        </ActionButton>
                        <ActionButton onClick={openBatchDiscountModal} tone="cash" className="min-h-10">
                          <Percent className="h-4 w-4" />
                          {tr('actions.discountSelected', 'Discount')}
                        </ActionButton>
                        <ActionButton onClick={openBatchTransferModal} disabled={batchUnpaidItemEntries.length === 0} tone="warn" className="min-h-10">
                          <MoveRight className="h-4 w-4" />
                          {tr('actions.transferSelected', 'Transfer')}
                        </ActionButton>
                      </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
                {orderItems.length === 0 ? (
                  <div className="flex h-full items-center justify-center liquid-glass-modal-text-muted">
                    {tr('messages.noItems', 'No items on this check yet.')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {orderItems.map((item, index) => {
                      const availableQuantity = availableQuantityByItemId.get(item.id) ?? Number(item.quantity || 0);
                      const paidQuantity = Math.max(0, Number(item.quantity || 0) - availableQuantity);
                      const unpaidAmount = unpaidAmountByItemId.get(item.id) ?? Number((itemUnitPrice(item) * availableQuantity).toFixed(2));
                      const paidAmount = Math.max(0, Number((itemLineTotal(item) - unpaidAmount).toFixed(2)));
                      const itemDiscountAmount = resolveTableCheckItemDiscount(item);
                      const itemPaid = availableQuantity <= 0;
                      const isSelectedForBatch = batchSelectedItemIds.includes(item.id);
                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          onPointerDown={(event) => handleItemPointerDown(item, event)}
                          onPointerUp={() => handleItemPointerUp(item)}
                          onPointerCancel={clearPressTimer}
                          onPointerLeave={clearPressTimer}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              if (isBatchMode) {
                                setBatchSelectedItemIds(current => toggleBatchItemSelection(current, item.id));
                              } else {
                                openItemActions(item);
                              }
                            }
                          }}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(index * 0.025, 0.18) }}
                          whileHover={{ scale: 1.01 }}
                          whileTap={{ scale: 0.99 }}
                          className={`${glassSubtleSurfaceClass} grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:border-blue-400/40 hover:bg-blue-500/10 focus:outline-none focus:ring-2 focus:ring-blue-400/40 ${
                            isSelectedForBatch ? 'border-blue-400/70 bg-blue-500/15' : ''
                          }`}
                        >
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                            isSelectedForBatch
                              ? 'border-blue-400 bg-blue-500 text-white'
                              : isBatchMode
                                ? 'liquid-glass-modal-border bg-white/10 text-transparent'
                                : 'border-transparent bg-transparent text-transparent'
                          }`}>
                            <Check className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-base font-semibold text-gray-900 dark:text-white">{itemDisplayName(item, translatedItemFallback)}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-zinc-300">
                              <span>{tr('labels.quantityShortValue', 'Qty {{quantity}}', { quantity: Number(item.quantity || 0) })}</span>
                              <span className="h-1 w-1 rounded-full bg-slate-500/40 dark:bg-white/25" />
                              <span className={itemPaid ? 'text-emerald-700 dark:text-emerald-300' : undefined}>
                                {itemPaid
                                  ? tr('labels.paid', 'Paid')
                                  : tr('labels.unpaidQuantity', 'Unpaid {{quantity}}', { quantity: availableQuantity })}
                              </span>
                              {paidQuantity > 0 && !itemPaid ? (
                                <>
                                  <span className="h-1 w-1 rounded-full bg-slate-500/40 dark:bg-white/25" />
                                  <span className="text-emerald-700 dark:text-emerald-300">
                                    {tr('labels.paidQuantity', 'Paid {{quantity}}', { quantity: paidQuantity })}
                                  </span>
                                </>
                              ) : null}
                              {item.is_price_overridden || item.discount || item.discountAmount || itemDiscountAmount > 0.009 ? (
                                <>
                                  <span className="h-1 w-1 rounded-full bg-slate-500/40 dark:bg-white/25" />
                                  <span className="text-emerald-700 dark:text-emerald-300">
                                    {itemDiscountAmount > 0.009
                                      ? tr('labels.discountAmount', 'Discount {{amount}}', { amount: money(itemDiscountAmount) })
                                      : tr('labels.adjusted', 'Adjusted')}
                                  </span>
                                </>
                              ) : null}
                            </div>
                          </div>
                          <div className="text-right">
                            {unpaidAmount > 0.009 ? (
                              <>
                                <p className="text-base font-semibold text-amber-700 dark:text-amber-300">
                                  {tr('labels.unpaidAmount', 'Unpaid {{amount}}', { amount: money(unpaidAmount) })}
                                </p>
                                {paidAmount > 0.009 ? (
                                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                    {tr('labels.paidAmount', 'Paid {{amount}}', { amount: money(paidAmount) })}
                                  </p>
                                ) : null}
                                <p className="text-xs text-gray-600 dark:text-zinc-300">
                                  {tr('labels.totalAmount', 'Total {{amount}}', { amount: money(itemLineTotal(item)) })}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-base font-semibold text-emerald-700 dark:text-emerald-300">{tr('labels.paid', 'Paid')}</p>
                                <p className="text-xs text-gray-600 dark:text-zinc-300">
                                  {tr('labels.totalAmount', 'Total {{amount}}', { amount: money(itemLineTotal(item)) })}
                                </p>
                              </>
                            )}
                            <p className="text-xs text-gray-600 dark:text-zinc-300">
                              {tr('labels.eachAmount', '{{amount}} each', { amount: money(itemUnitPrice(item)) })}
                            </p>
                          </div>
                        </motion.button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <aside className="hide-scrollbar flex min-h-0 flex-col gap-3 overflow-y-auto">
              <div className={`${glassSurfaceClass} border-blue-400/25 p-4`}>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700/75 dark:text-blue-200/75">
                  {tr('labels.due', 'Due')}
                </p>
                <p className="mt-1 text-4xl font-semibold liquid-glass-modal-text">{money(outstanding)}</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <MetricTile label={tr('labels.total', 'Total')} value={money(orderTotal)} />
                  {discountTotal > 0.009 ? (
                    <MetricTile label={tr('labels.discount', 'Discount')} value={money(discountTotal)} tone="due" />
                  ) : null}
                  <MetricTile label={tr('labels.paid', 'Paid')} value={money(paidTotal)} tone="paid" />
                  <MetricTile label={tr('labels.tips', 'Tips')} value={money(tipTotal)} tone="tip" />
                  <button
                    type="button"
                    onClick={() => setSecondaryModal('covers')}
                    className={`${glassSubtleSurfaceClass} px-4 py-3 text-left transition-colors hover:bg-white/45 dark:hover:bg-white/[0.08]`}
                  >
                    <p className="text-[11px] font-medium uppercase tracking-wide liquid-glass-modal-text-muted">
                      {tr('labels.covers', 'Covers')}
                    </p>
                    <p className="mt-1 text-xl font-semibold liquid-glass-modal-text">{guestCount}</p>
                  </button>
                </div>
              </div>

              {paymentHistory.length > 0 ? (
                <div className={`${glassSurfaceClass} p-3`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide liquid-glass-modal-text-muted">
                      {tr('labels.paymentsAdded', 'Payments Added')}
                    </p>
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{money(paidTotal)}</span>
                  </div>
                  <div className="space-y-2">
                    {paymentHistory.slice(0, 5).map((payment, index) => {
                      const amount = paymentRecordAmount(payment);
                      const tip = paymentRecordTip(payment);
                      const method = String(payment.method || '').toLowerCase() === 'card'
                        ? tr('paymentMethods.card', 'Card')
                        : tr('paymentMethods.cash', 'Cash');
                      const time = formatPaymentTimestamp(payment.createdAt || payment.created_at);
                      return (
                        <div key={payment.id || `${method}-${amount}-${index}`} className={`${glassSubtleSurfaceClass} flex items-center justify-between gap-3 px-3 py-2`}>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold liquid-glass-modal-text">+ {money(amount)} {method}</p>
                            <p className="truncate text-xs liquid-glass-modal-text-muted">
                              {time || tr('labels.recorded', 'Recorded')}
                              {tip > 0 ? ` · ${tr('labels.tipAmount', 'Tip {{amount}}', { amount: money(tip) })}` : ''}
                            </p>
                          </div>
                          <span className="shrink-0 text-xs font-semibold text-amber-700 dark:text-amber-300">
                            {tr('labels.dueAmount', 'Due {{amount}}', { amount: money(outstanding) })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t liquid-glass-modal-border pt-2 text-sm">
                    <span className="liquid-glass-modal-text-muted">{tr('labels.unpaid', 'Unpaid')}</span>
                    <span className="font-semibold liquid-glass-modal-text">{money(outstanding)}</span>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={() => openPayTableModal()} tone="card" disabled={outstanding <= 0}>
                  <HandCoins className="h-4 w-4" />
                  {tr('actions.pay', 'Pay')}
                </ActionButton>
                <ActionButton onClick={() => openPayTableModal(outstanding / Math.max(1, guestCount))} disabled={outstanding <= 0}>
                  <Users className="h-4 w-4" />
                  {tr('actions.perPerson', 'Per Person')}
                </ActionButton>
                <ActionButton onClick={openMoveTableModal}>
                  <ArrowRightLeft className="h-4 w-4" />
                  {tr('actions.move', 'Move')}
                </ActionButton>
                <ActionButton onClick={openMergeTableModal} tone="purple">
                  <Shuffle className="h-4 w-4" />
                  {tr('actions.merge', 'Merge')}
                </ActionButton>
                <ActionButton onClick={openAssignWaiterModal}>
                  <UserCheck className="h-4 w-4" />
                  {tr('actions.assignWaiter', 'Assign')}
                </ActionButton>
              </div>

              <div className={`${glassSurfaceClass} p-3`}>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide liquid-glass-modal-text-muted">
                  {tr('labels.settlement', 'Settlement')}
                </p>
                <ActionButton onClick={closeTable} disabled={isSaving || outstanding > 0} tone="cash" className="w-full">
                  <Check className="h-4 w-4" />
                  {tr('actions.closeTable', 'Close Table')}
                </ActionButton>
              </div>
            </aside>
          </div>
        )}

        <AnimatePresence>
          {secondaryModal === 'pay-table' ? (
            <SecondarySheet
              title={tr('actions.payTable', 'Pay Table')}
              subtitle={tr('labels.outstandingAmount', 'Outstanding {{amount}}', { amount: money(outstanding) })}
              icon={<HandCoins className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid grid-cols-3 gap-3">
                <FormField label={tr('labels.amount', 'Amount')}>
                  <input
                    value={paymentAmount}
                    onChange={(event) => setPaymentAmount(event.target.value)}
                    onBlur={() => setPaymentAmount(formatMoneyInput(paymentAmount))}
                    inputMode="decimal"
                    className={glassInputClass}
                  />
                </FormField>
                <FormField label={tr('labels.tip', 'Tip')}>
                  <input
                    value={tipAmount}
                    onChange={(event) => setTipAmount(event.target.value)}
                    onBlur={() => setTipAmount(formatMoneyInput(tipAmount))}
                    inputMode="decimal"
                    className={glassInputClass}
                  />
                </FormField>
                <FormField label={tr('labels.seat', 'Seat')}>
                  <input
                    value={seatNumber}
                    onChange={(event) => setSeatNumber(event.target.value)}
                    placeholder={tr('labels.all', 'All')}
                    className={glassInputClass}
                  />
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={() => setPaymentAmount(outstanding.toFixed(2))}>
                  {tr('actions.fullTable', 'Full Table')}
                </ActionButton>
                <ActionButton onClick={() => setPaymentAmount((outstanding / Math.max(1, guestCount)).toFixed(2))}>
                  <Users className="h-4 w-4" />
                  {tr('actions.perPerson', 'Per Person')}
                </ActionButton>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={() => void recordPayment('cash')} disabled={isSaving} tone="cash">
                  <Banknote className="h-4 w-4" />
                  {tr('paymentMethods.cash', 'Cash')}
                </ActionButton>
                <ActionButton onClick={() => void recordPayment('card')} disabled={isSaving} tone="card">
                  <CreditCard className="h-4 w-4" />
                  {tr('paymentMethods.card', 'Card')}
                </ActionButton>
              </div>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'batch-pay' && isBatchMode ? (
            <SecondarySheet
              title={tr('actions.paySelectedItems', 'Pay Selected Items')}
              subtitle={tr('labels.batchSelectedSummary', '{{count}} items · {{amount}} unpaid', {
                count: batchUnpaidItemEntries.length,
                amount: money(batchSelectedTotal),
              })}
              icon={<HandCoins className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid grid-cols-3 gap-3">
                <MetricTile label={tr('labels.amount', 'Amount')} value={money(batchSelectedTotal)} tone="due" />
                <FormField label={tr('labels.tip', 'Tip')}>
                  <input
                    value={tipAmount}
                    onChange={(event) => setTipAmount(event.target.value)}
                    onBlur={() => setTipAmount(formatMoneyInput(tipAmount))}
                    inputMode="decimal"
                    className={glassInputClass}
                  />
                </FormField>
                <FormField label={tr('labels.seat', 'Seat')}>
                  <input
                    value={seatNumber}
                    onChange={(event) => setSeatNumber(event.target.value)}
                    placeholder={tr('labels.all', 'All')}
                    className={glassInputClass}
                  />
                </FormField>
              </div>
              <div className={`${glassSubtleSurfaceClass} max-h-36 overflow-y-auto p-3 text-sm liquid-glass-modal-text-muted`}>
                {batchUnpaidItemEntries.map(entry => (
                  <div key={entry.item.id} className="flex items-center justify-between gap-3 py-1">
                    <span className="truncate">{itemDisplayName(entry.item, translatedItemFallback)} · {tr('labels.quantityShortValue', 'Qty {{quantity}}', { quantity: entry.itemQuantity })}</span>
                    <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">{money(entry.itemAmount)}</span>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton onClick={() => void recordBatchPayment('cash')} disabled={isSaving || batchSelectedTotal <= 0} tone="cash">
                  <Banknote className="h-4 w-4" />
                  {tr('paymentMethods.cash', 'Cash')}
                </ActionButton>
                <ActionButton onClick={() => void recordBatchPayment('card')} disabled={isSaving || batchSelectedTotal <= 0} tone="card">
                  <CreditCard className="h-4 w-4" />
                  {tr('paymentMethods.card', 'Card')}
                </ActionButton>
              </div>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'batch-transfer' && isBatchMode ? (
            <SecondarySheet
              title={tr('actions.transferSelectedItems', 'Transfer Selected Items')}
              subtitle={tr('labels.batchSelectedCount', '{{count}} selected', { count: batchUnpaidItemEntries.length })}
              icon={<MoveRight className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid grid-cols-2 gap-3">
                <FieldGroup label={tr('labels.targetTable', 'Target Table')} labelId="table-check-batch-target">
                  <TableDestinationPicker
                    value={targetTableId}
                    onChange={setTargetTableId}
                    options={availableTables}
                    optionLabel={(candidate) => tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(candidate.tableNumber) })}
                    emptyLabel={tr('labels.selectTable', 'Select table')}
                    labelledBy="table-check-batch-target"
                  />
                </FieldGroup>
                <FormField label={tr('labels.seat', 'Seat')}>
                  <input
                    value={transferSeatNumber}
                    onChange={(event) => setTransferSeatNumber(event.target.value)}
                    placeholder={tr('labels.optional', 'Optional')}
                    className={glassInputClass}
                  />
                </FormField>
              </div>
              <div className={`${glassSubtleSurfaceClass} max-h-40 overflow-y-auto p-3 text-sm liquid-glass-modal-text-muted`}>
                {batchUnpaidItemEntries.map(entry => (
                  <div key={entry.item.id} className="flex items-center justify-between gap-3 py-1">
                    <span className="truncate">{itemDisplayName(entry.item, translatedItemFallback)}</span>
                    <span className="shrink-0 font-semibold liquid-glass-modal-text">
                      {tr('labels.quantityShortValue', 'Qty {{quantity}}', { quantity: entry.itemQuantity })}
                    </span>
                  </div>
                ))}
              </div>
              <ActionButton onClick={() => void transferBatchItems()} disabled={isSaving || !targetTableId} tone="warn" className="w-full">
                <MoveRight className="h-4 w-4" />
                {tr('actions.moveSelectedQuantities', 'Move Selected Quantities')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'batch-discount' && isBatchMode ? (
            <SecondarySheet
              title={tr('actions.discountSelectedItems', 'Discount Selected Items')}
              subtitle={tr('labels.batchSelectedSummary', '{{count}} items · {{amount}} unpaid', {
                count: batchSelectedItems.length,
                amount: money(batchSelectedTotal),
              })}
              icon={<Percent className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className={`${glassSubtleSurfaceClass} grid grid-cols-2 gap-2 p-1`}>
                <button
                  type="button"
                  onClick={() => setDiscountMode('percentage')}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    discountMode === 'percentage'
                      ? 'liquid-glass-modal-primary'
                      : 'liquid-glass-modal-text-muted hover:bg-white/20 dark:hover:bg-white/10'
                  }`}
                >
                  {tr('labels.percent', 'Percent')}
                </button>
                <button
                  type="button"
                  onClick={() => setDiscountMode('fixed')}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    discountMode === 'fixed'
                      ? 'liquid-glass-modal-primary'
                      : 'liquid-glass-modal-text-muted hover:bg-white/20 dark:hover:bg-white/10'
                  }`}
                >
                  {tr('labels.amount', 'Amount')}
                </button>
              </div>
              <FormField label={discountMode === 'percentage' ? tr('labels.percent', 'Percent') : tr('labels.amount', 'Amount')}>
                <input
                  value={discountValue}
                  onChange={(event) => setDiscountValue(event.target.value)}
                  onBlur={() => setDiscountValue(formatMoneyInput(discountValue))}
                  inputMode="decimal"
                  className={glassInputClass}
                />
              </FormField>
              <ActionButton onClick={applyBatchItemDiscount} disabled={isSaving} tone="cash" className="w-full">
                <Check className="h-4 w-4" />
                {tr('actions.applyDiscountToSelected', 'Apply to Selected')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'item-actions' && selectedItem ? (
            <SecondarySheet
              title={itemDisplayName(selectedItem, translatedItemFallback)}
              subtitle={
                <>
                  {selectedItemUnpaidAmount > 0.009 ? (
                    <span className="font-semibold text-amber-700 dark:text-amber-300">
                      {tr('labels.unpaidAmount', 'Unpaid {{amount}}', { amount: money(selectedItemUnpaidAmount) })}
                    </span>
                  ) : (
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">{tr('labels.paid', 'Paid')}</span>
                  )}
                  {selectedItemPaidAmount > 0.009 ? (
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                      {tr('labels.paidAmount', 'Paid {{amount}}', { amount: money(selectedItemPaidAmount) })}
                    </span>
                  ) : null}
                  <span className="liquid-glass-modal-text-muted">
                    {tr('labels.totalAndQty', 'Total {{amount}} · Qty {{quantity}}', {
                      amount: money(itemLineTotal(selectedItem)),
                      quantity: itemQuantity(selectedItem),
                    })}
                  </span>
                </>
              }
              icon={<Layers className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              {itemActionMode === 'menu' ? (
                <div className="grid gap-2">
                  <ActionButton onClick={() => setItemActionMode('pay')} tone="card">
                    <HandCoins className="h-4 w-4" />
                    {tr('actions.payItem', 'Pay Item')}
                  </ActionButton>
                  <ActionButton onClick={() => setItemActionMode('price')}>
                    <PencilLine className="h-4 w-4" />
                    {tr('actions.changePrice', 'Change Price')}
                  </ActionButton>
                  <ActionButton onClick={() => setItemActionMode('discount')} tone="cash">
                    <Percent className="h-4 w-4" />
                    {tr('actions.discount', 'Discount')}
                  </ActionButton>
                  <ActionButton onClick={() => openTransferModal(selectedItem)} tone="warn">
                    <MoveRight className="h-4 w-4" />
                    {tr('actions.transfer', 'Transfer')}
                  </ActionButton>
                </div>
              ) : null}

              {itemActionMode === 'pay' ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-[1fr_110px] gap-3">
                    <MetricTile label={tr('labels.amount', 'Amount')} value={money(selectedItemPayAmount)} tone="due" />
                    <FormField label={tr('labels.quantityShort', 'Qty')}>
                      <input
                        value={itemPayQuantity}
                        onChange={(event) => setItemPayQuantity(event.target.value)}
                        className={glassInputClass}
                      />
                    </FormField>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ActionButton
                      onClick={() => void recordPayment('cash', {
                        item: selectedItem,
                        itemQuantity: Math.min(Number(itemPayQuantity || 1), selectedItemAvailable || 1),
                        itemAmount: selectedItemPayAmount,
                      })}
                      disabled={isSaving}
                      tone="cash"
                    >
                      <Banknote className="h-4 w-4" />
                      {tr('paymentMethods.cash', 'Cash')}
                    </ActionButton>
                    <ActionButton
                      onClick={() => void recordPayment('card', {
                        item: selectedItem,
                        itemQuantity: Math.min(Number(itemPayQuantity || 1), selectedItemAvailable || 1),
                        itemAmount: selectedItemPayAmount,
                      })}
                      disabled={isSaving}
                      tone="card"
                    >
                      <CreditCard className="h-4 w-4" />
                      {tr('paymentMethods.card', 'Card')}
                    </ActionButton>
                  </div>
                </div>
              ) : null}

              {itemActionMode === 'price' ? (
                <div className="space-y-4">
                  <FormField label={tr('labels.unitPrice', 'Unit Price')}>
                    <input
                      value={itemPriceValue}
                      onChange={(event) => setItemPriceValue(event.target.value)}
                      onBlur={() => setItemPriceValue(formatMoneyInput(itemPriceValue))}
                      inputMode="decimal"
                      className={glassInputClass}
                    />
                  </FormField>
                  <ActionButton onClick={applySelectedItemPrice} disabled={isSaving} tone="card" className="w-full">
                    <Check className="h-4 w-4" />
                    {tr('actions.savePrice', 'Save Price')}
                  </ActionButton>
                </div>
              ) : null}

              {itemActionMode === 'discount' ? (
                <div className="space-y-4">
                  <div className={`${glassSubtleSurfaceClass} grid grid-cols-2 gap-2 p-1`}>
                    <button
                      type="button"
                      onClick={() => setDiscountMode('percentage')}
                      className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                        discountMode === 'percentage'
                          ? 'liquid-glass-modal-primary'
                          : 'liquid-glass-modal-text-muted hover:bg-white/20 dark:hover:bg-white/10'
                      }`}
                    >
                      {tr('labels.percent', 'Percent')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountMode('fixed')}
                      className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                        discountMode === 'fixed'
                          ? 'liquid-glass-modal-primary'
                          : 'liquid-glass-modal-text-muted hover:bg-white/20 dark:hover:bg-white/10'
                      }`}
                    >
                      {tr('labels.amount', 'Amount')}
                    </button>
                  </div>
                  <FormField label={discountMode === 'percentage' ? tr('labels.percent', 'Percent') : tr('labels.amount', 'Amount')}>
                    <input
                      value={discountValue}
                      onChange={(event) => setDiscountValue(event.target.value)}
                      className={glassInputClass}
                    />
                  </FormField>
                  <ActionButton onClick={applySelectedItemDiscount} disabled={isSaving} tone="cash" className="w-full">
                    <Check className="h-4 w-4" />
                    {tr('actions.applyDiscount', 'Apply Discount')}
                  </ActionButton>
                </div>
              ) : null}
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'transfer-item' && selectedTransferItem ? (
            <SecondarySheet
              title={tr('actions.transferItem', 'Transfer Item')}
              subtitle={itemDisplayName(selectedTransferItem, translatedItemFallback)}
              icon={<MoveRight className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid grid-cols-2 gap-3">
                <FieldGroup label={tr('labels.targetTable', 'Target Table')} labelId="table-check-transfer-target">
                  <TableDestinationPicker
                    value={targetTableId}
                    onChange={setTargetTableId}
                    options={availableTables}
                    optionLabel={(candidate) => tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(candidate.tableNumber) })}
                    emptyLabel={tr('labels.selectTable', 'Select table')}
                    labelledBy="table-check-transfer-target"
                  />
                </FieldGroup>
                <FormField label={tr('labels.quantityShort', 'Qty')}>
                  <input
                    value={transferQuantity}
                    onChange={(event) => setTransferQuantity(event.target.value)}
                    className={glassInputClass}
                  />
                </FormField>
                <FormField label={tr('labels.seat', 'Seat')}>
                  <input
                    value={transferSeatNumber}
                    onChange={(event) => setTransferSeatNumber(event.target.value)}
                    placeholder={tr('labels.optional', 'Optional')}
                    className={glassInputClass}
                  />
                </FormField>
                <MetricTile label={tr('labels.available', 'Available')} value={String(selectedTransferAvailable)} />
              </div>
              <ActionButton onClick={() => void transferItem()} disabled={isSaving || !targetTableId} tone="warn" className="w-full">
                <MoveRight className="h-4 w-4" />
                {tr('actions.moveQuantity', 'Move Quantity')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'move-table' ? (
            <SecondarySheet
              title={tr('actions.moveTable', 'Move Table')}
              subtitle={tr('labels.fromTable', 'From table {{number}}', { number: formatTableDisplayNumber(table.tableNumber) })}
              icon={<ArrowRightLeft className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <FieldGroup label={tr('labels.targetTable', 'Target Table')} labelId="table-check-move-target">
                <TableDestinationPicker
                  value={targetTableId}
                  onChange={setTargetTableId}
                  options={availableTables}
                  optionLabel={(candidate) => tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(candidate.tableNumber) })}
                  emptyLabel={tr('labels.selectTable', 'Select table')}
                  labelledBy="table-check-move-target"
                />
              </FieldGroup>
              <ActionButton
                onClick={() => targetTableId && void patchSession(
                  { action: 'move_table', target_table_id: targetTableId, release_source_tables: true },
                  tr('messages.tableMoved', 'Table moved'),
                )}
                disabled={isSaving || !targetTableId}
                tone="card"
                className="w-full"
              >
                <ArrowRightLeft className="h-4 w-4" />
                {tr('actions.moveCheck', 'Move Check')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'merge-table' ? (
            <SecondarySheet
              title={tr('actions.mergeTable', 'Merge Table')}
              subtitle={tr('labels.intoTable', 'Into table {{number}}', { number: formatTableDisplayNumber(table.tableNumber) })}
              icon={<Shuffle className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <FieldGroup label={tr('labels.table', 'Table')} labelId="table-check-merge-target">
                <TableDestinationPicker
                  value={mergeTableId}
                  onChange={setMergeTableId}
                  options={availableTables}
                  optionLabel={(candidate) => tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(candidate.tableNumber) })}
                  emptyLabel={tr('labels.selectTable', 'Select table')}
                  labelledBy="table-check-merge-target"
                />
              </FieldGroup>
              <ActionButton
                onClick={() => mergeTableId && void patchSession(
                  { action: 'merge_table', table_ids: [mergeTableId] },
                  tr('messages.tableMerged', 'Table merged into check'),
                )}
                disabled={isSaving || !mergeTableId}
                tone="purple"
                className="w-full"
              >
                <Shuffle className="h-4 w-4" />
                {tr('actions.merge', 'Merge')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'assign-waiter' ? (
            <SecondarySheet
              title={tr('actions.assignWaiter', 'Assign Waiter')}
              subtitle={tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(table.tableNumber) })}
              icon={<UserCheck className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedWaiterId('')}
                  className={`${glassSubtleSurfaceClass} flex items-center justify-between gap-3 px-3 py-3 text-left transition-colors ${
                    selectedWaiterId === ''
                      ? 'border-blue-400/50 bg-blue-500/10'
                      : 'hover:bg-white/45 dark:hover:bg-white/[0.08]'
                  }`}
                >
                  <span className="font-semibold liquid-glass-modal-text">{tr('labels.unassignedWaiter', 'Unassigned')}</span>
                  {selectedWaiterId === '' ? <Check className="h-4 w-4 text-blue-700 dark:text-blue-300" /> : null}
                </button>
                {isLoadingWaiters ? (
                  <div className="flex items-center justify-center rounded-2xl border liquid-glass-modal-border px-3 py-6 liquid-glass-modal-text-muted">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {tr('messages.loadingStaff', 'Loading staff...')}
                  </div>
                ) : waiterOptions.length === 0 ? (
                  <div className="rounded-2xl border liquid-glass-modal-border px-3 py-6 text-center liquid-glass-modal-text-muted">
                    {tr('messages.noWaitersAvailable', 'No active staff available.')}
                  </div>
                ) : (
                  waiterOptions.map(waiter => (
                    <button
                      key={waiter.id}
                      type="button"
                      onClick={() => setSelectedWaiterId(waiter.id)}
                      className={`${glassSubtleSurfaceClass} flex items-center justify-between gap-3 px-3 py-3 text-left transition-colors ${
                        selectedWaiterId === waiter.id
                          ? 'border-blue-400/50 bg-blue-500/10'
                          : 'hover:bg-white/45 dark:hover:bg-white/[0.08]'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold liquid-glass-modal-text">{waiter.name}</span>
                        <span className="block truncate text-xs liquid-glass-modal-text-muted">
                          {translateRoleName(t, waiter.role || '', staffMemberFallbackLabel)}
                        </span>
                      </span>
                      {selectedWaiterId === waiter.id ? <Check className="h-4 w-4 text-blue-700 dark:text-blue-300" /> : null}
                    </button>
                  ))
                )}
              </div>
              <ActionButton onClick={saveWaiterAssignment} disabled={isSaving} tone="card" className="w-full">
                <Check className="h-4 w-4" />
                {tr('actions.saveWaiter', 'Save Waiter')}
              </ActionButton>
            </SecondarySheet>
          ) : null}

          {secondaryModal === 'covers' ? (
            <SecondarySheet
              title={tr('labels.covers', 'Covers')}
              subtitle={tr('labels.tableNumber', 'Table {{number}}', { number: formatTableDisplayNumber(table.tableNumber) })}
              icon={<Users className="h-5 w-5" />}
              onClose={closeSecondaryModal}
              closeLabel={tr('actions.close', 'Close')}
            >
              <div className="grid grid-cols-[64px_1fr_64px] gap-3">
                <ActionButton onClick={() => setGuestCount(count => Math.max(1, count - 1))}>
                  <Minus className="h-5 w-5" />
                </ActionButton>
                <input
                  value={guestCount}
                  onChange={(event) => setGuestCount(normalizeGuestCount(event.target.value))}
                  className={`${glassInputClass} text-center text-xl font-semibold`}
                />
                <ActionButton onClick={() => setGuestCount(count => Math.min(99, count + 1))}>
                  <Plus className="h-5 w-5" />
                </ActionButton>
              </div>
              <ActionButton onClick={saveGuestCount} disabled={isSaving} tone="card" className="w-full">
                <Check className="h-4 w-4" />
                {tr('actions.saveCovers', 'Save Covers')}
              </ActionButton>
            </SecondarySheet>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default TableCheckManagerModal;
