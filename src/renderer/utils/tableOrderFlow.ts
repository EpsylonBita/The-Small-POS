import type { TableStatus } from '../types/tables';

type ServiceOrderType = 'pickup' | 'delivery' | 'dine-in';

interface TableLike {
  id?: string | null;
  status?: string | null;
  tableNumber?: number | string | null;
  current_order_id?: string | null;
  currentOrderId?: string | null;
  table_session_id?: string | null;
  tableSessionId?: string | null;
  unpaidBalance?: number | string | null;
  balance?: {
    order_total?: number | string | null;
    paid_total?: number | string | null;
    outstanding_balance?: number | string | null;
    payment_status?: string | null;
  } | null;
}

type OrderLike = Record<string, unknown> & {
  id?: string | null;
  order_number?: string | null;
  orderNumber?: string | null;
  supabase_id?: string | null;
  supabaseId?: string | null;
  client_request_id?: string | null;
  clientRequestId?: string | null;
  client_order_id?: string | null;
  clientOrderId?: string | null;
  order_type?: string | null;
  orderType?: string | null;
  table_id?: string | null;
  tableId?: string | null;
  table_session_id?: string | null;
  tableSessionId?: string | null;
  table_number?: string | number | null;
  tableNumber?: string | number | null;
  status?: string | null;
  guest_count?: number | string | null;
  guestCount?: number | string | null;
  customer_name?: string | null;
  customerName?: string | null;
  notes?: string | null;
};

export interface TableSessionOpenPayload {
  [key: string]: unknown;
  action: 'open' | 'reopen';
  table_id: string | null;
  table_number: string | number | null;
  active_order_id: string | null;
  active_order_client_id: string | null;
  client_order_id: string | null;
  client_request_id: string | null;
  guest_count: number;
  customer_name: string;
  client_event_id: string;
}

const UUID_V4_OR_COMPAT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeGuestCount(value: unknown, fallback = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(1, Math.min(99, Math.trunc(numeric)));
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function normalizeTextReference(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isUuidLike(value: unknown): value is string {
  const normalized = normalizeTextReference(value);
  return Boolean(normalized && UUID_V4_OR_COMPAT_RE.test(normalized));
}

function firstTextReference(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeTextReference(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

const TABLE_DISPLAY_STATUSES = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'maintenance',
  'unavailable',
] as const satisfies readonly TableStatus[];

function normalizeTableStatus(value: unknown): TableStatus {
  const status = String(value ?? '').trim().toLowerCase();
  return TABLE_DISPLAY_STATUSES.includes(status as TableStatus)
    ? (status as TableStatus)
    : 'available';
}

function normalizeOrderType(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function readMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function isCompletedPaymentStatus(value: unknown): boolean {
  const status = String(value ?? '').trim().toLowerCase();
  return status === 'paid' || status === 'completed' || status === 'settled' || status === 'closed';
}

function tablePaymentLooksSettled(table: TableLike): boolean {
  const record = table as Record<string, unknown>;
  const paymentStatus =
    table.balance?.payment_status ??
    record.paymentStatus ??
    record.payment_status;
  if (isCompletedPaymentStatus(paymentStatus)) {
    return true;
  }

  const orderTotal = readMoney(table.balance?.order_total);
  const paidTotal = readMoney(table.balance?.paid_total);
  const outstandingBalance = readMoney(table.unpaidBalance ?? table.balance?.outstanding_balance);
  return orderTotal > 0 && outstandingBalance <= 0.005 && paidTotal + 0.005 >= orderTotal;
}

export function normalizeTableNumberForMatch(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }

  const direct = raw.match(/^#?\s*T?(\d+)$/i);
  if (direct?.[1]) {
    return direct[1];
  }

  const labeled = raw.match(/(?:table|τραπέζι)\s*#?\s*T?(\d+)/i);
  if (labeled?.[1]) {
    return labeled[1];
  }

  return null;
}

export function getTableNumberForTableServiceOrder(order: OrderLike | null | undefined): string | null {
  if (!order) {
    return null;
  }

  return (
    normalizeTableNumberForMatch(order.table_number) ||
    normalizeTableNumberForMatch(order.tableNumber) ||
    normalizeTableNumberForMatch(order.customer_name) ||
    normalizeTableNumberForMatch(order.customerName) ||
    normalizeTableNumberForMatch(order.notes)
  );
}

export function isTableServiceOrder(order: OrderLike | null | undefined): boolean {
  if (!order) {
    return false;
  }

  const orderType = normalizeOrderType(order.order_type ?? order.orderType);
  if (orderType === 'dine-in' || orderType === 'dine_in' || orderType === 'table') {
    return true;
  }

  return (
    hasValue(order.table_id) ||
    hasValue(order.tableId) ||
    hasValue(order.table_session_id) ||
    hasValue(order.tableSessionId) ||
    hasValue(order.table_number) ||
    hasValue(order.tableNumber) ||
    Boolean(getTableNumberForTableServiceOrder(order))
  );
}

export function shouldShowInStandardOrderLane(order: OrderLike): boolean {
  if (isTableServiceOrder(order)) {
    return false;
  }

  const status = String(order.status || '').toLowerCase();
  return ['pending', 'confirmed', 'preparing', 'ready'].includes(status);
}

export function isUnsettledOrderPaymentStatus(order: OrderLike): boolean {
  const paymentStatus = String(order.payment_status ?? order.paymentStatus ?? '').trim().toLowerCase();
  return !['paid', 'completed', 'refunded'].includes(paymentStatus);
}

function normalizeComparableId(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return raw.length > 0 ? raw : null;
}

function orderMatchesId(order: OrderLike, targetId: string | null): boolean {
  if (!targetId) {
    return false;
  }

  return [
    order.id,
    order.supabase_id,
    order.supabaseId,
    order.order_number,
    order.orderNumber,
    order.client_request_id,
    order.clientRequestId,
    order.client_order_id,
    order.clientOrderId,
  ].some((value) => normalizeComparableId(value) === targetId);
}

function findTableOrderForTableCandidate<T extends OrderLike>(
  orders: T[],
  table: TableLike | null | undefined,
  options: { requireUnsettledPayment: boolean },
): T | null {
  if (!table || !Array.isArray(orders) || orders.length === 0) {
    return null;
  }

  const currentOrderId = normalizeComparableId(table.currentOrderId);
  const tableSessionId = normalizeComparableId(table.tableSessionId ?? table.table_session_id);
  const tableId = normalizeComparableId(table.id);
  const tableNumber =
    normalizeTableNumberForMatch(table.tableNumber) ||
    normalizeTableNumberForMatch((table as Record<string, unknown>).number);
  const activeStatuses = new Set(['pending', 'confirmed', 'preparing', 'ready']);

  let best: { order: T; score: number; createdAt: number } | null = null;

  for (const order of orders) {
    const status = String(order.status || '').trim().toLowerCase();
    if (status && !activeStatuses.has(status)) {
      continue;
    }

    if (options.requireUnsettledPayment && !isUnsettledOrderPaymentStatus(order)) {
      continue;
    }

    if (!isTableServiceOrder(order)) {
      continue;
    }

    let score = 0;
    if (orderMatchesId(order, currentOrderId)) {
      score = 100;
    } else if (
      tableSessionId &&
      normalizeComparableId(order.tableSessionId ?? order.table_session_id) === tableSessionId
    ) {
      score = 90;
    } else if (
      tableId &&
      normalizeComparableId(order.tableId ?? order.table_id) === tableId
    ) {
      score = 80;
    } else if (
      tableNumber &&
      getTableNumberForTableServiceOrder(order) === tableNumber
    ) {
      score = 70;
    }

    if (score === 0) {
      continue;
    }

    const createdAt = new Date(
      String(order.created_at ?? order.createdAt ?? 0),
    ).getTime();

    if (!best || score > best.score || (score === best.score && createdAt > best.createdAt)) {
      best = {
        order,
        score,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      };
    }
  }

  return best?.order || null;
}

export function findTableOrderForTable<T extends OrderLike>(
  orders: T[],
  table: TableLike | null | undefined,
): T | null {
  return findTableOrderForTableCandidate(orders, table, { requireUnsettledPayment: false });
}

export function findOpenTableOrderForTable<T extends OrderLike>(
  orders: T[],
  table: TableLike | null | undefined,
): T | null {
  return findTableOrderForTableCandidate(orders, table, { requireUnsettledPayment: true });
}

export function tableHasOpenCheckReference(table: TableLike | null | undefined): boolean {
  if (!table) {
    return false;
  }

  if (tablePaymentLooksSettled(table)) {
    return false;
  }

  const orderTotal = readMoney(table.balance?.order_total);
  const outstandingBalance = readMoney(table.unpaidBalance ?? table.balance?.outstanding_balance);

  return (
    hasValue(table.currentOrderId) ||
    hasValue(table.current_order_id) ||
    hasValue(table.tableSessionId) ||
    hasValue(table.table_session_id) ||
    orderTotal > 0 ||
    outstandingBalance > 0
  );
}

export function resolveTableDisplayStatus(table: TableLike | null | undefined): TableStatus {
  const status = normalizeTableStatus(table?.status);

  if (status === 'occupied' && !tableHasOpenCheckReference(table)) {
    return 'available';
  }

  return status;
}

export function shouldApplyOptimisticTableOverride(
  table: TableLike | null | undefined,
  override: Partial<TableLike> | null | undefined,
): boolean {
  if (!table || !override) {
    return false;
  }

  const overrideStatus = normalizeTableStatus(override.status);
  if (overrideStatus === 'occupied') {
    const serverStatus = normalizeTableStatus(table.status);
    if (serverStatus !== 'occupied') {
      return false;
    }
    if (tablePaymentLooksSettled(table)) {
      return false;
    }
  }

  return true;
}

export function shouldBypassPaymentForTableOrder(input: {
  orderType?: string | null;
  tableNumber?: string | number | null;
  editMode?: boolean;
  ghostMode?: boolean;
}): boolean {
  if (input.editMode || input.ghostMode) {
    return false;
  }

  return input.orderType === 'dine-in' || Boolean(String(input.tableNumber || '').trim());
}

export function buildTableOrderCreateFields(input: {
  serviceOrderType?: ServiceOrderType | string | null;
  pricingOrderType?: ServiceOrderType | string | null;
  table?: TableLike | null;
  tableNumber?: string | number | null;
  tableSessionId?: string | null;
  guestCount?: unknown;
}) {
  const serviceOrderType = input.serviceOrderType || input.pricingOrderType || 'pickup';
  if (serviceOrderType !== 'dine-in') {
    return {
      order_type: input.pricingOrderType || serviceOrderType,
    };
  }

  const tableNumber = input.table?.tableNumber ?? input.tableNumber ?? null;

  return {
    order_type: 'dine-in',
    table_number: tableNumber !== null && tableNumber !== undefined ? String(tableNumber) : null,
    table_id: input.table?.id ?? null,
    table_session_id: input.tableSessionId ?? input.table?.tableSessionId ?? input.table?.table_session_id ?? null,
    guest_count: normalizeGuestCount(input.guestCount),
    payment_method: null,
    payment_status: 'pending',
  };
}

export function buildTableSessionOpenPayload(input: {
  table: TableLike;
  orderId: unknown;
  orderResult?: Record<string, unknown> | null;
  orderData?: OrderLike | null;
  guestCount?: unknown;
  customerName?: string | null;
}): TableSessionOpenPayload {
  const orderId = normalizeTextReference(input.orderId);
  const orderResult = input.orderResult || {};
  const orderData = input.orderData || {};
  const clientOrderId = firstTextReference(
    orderResult.clientOrderId,
    orderResult.client_order_id,
    orderResult.clientRequestId,
    orderResult.client_request_id,
    orderData.clientOrderId,
    orderData.client_order_id,
    orderData.clientRequestId,
    orderData.client_request_id,
    orderId,
  );
  const activeOrderId = isUuidLike(orderId) ? orderId : null;
  const eventReference = clientOrderId || orderId || firstTextReference(input.table.id, input.table.tableNumber) || 'open';

  return {
    action: 'open',
    table_id: input.table.id ?? null,
    table_number: input.table.tableNumber ?? null,
    active_order_id: activeOrderId,
    active_order_client_id: clientOrderId,
    client_order_id: clientOrderId,
    client_request_id: clientOrderId,
    guest_count: normalizeGuestCount(input.guestCount),
    customer_name:
      firstTextReference(input.customerName) ||
      `Table ${firstTextReference(input.table.tableNumber) || ''}`.trim(),
    client_event_id: `pos-tauri-table-session-${eventReference}`,
  };
}

export function buildOptimisticOccupiedTable<T extends object>(
  table: T,
  input: {
    orderId?: string | null;
    tableSessionId?: string | null;
    guestCount?: unknown;
    occupiedSince?: string | null;
  },
): T & {
  status: 'occupied';
  currentOrderId?: string;
  tableSessionId: string | null;
  guestCount: number;
  occupiedSince?: string;
} {
  return {
    ...table,
    status: 'occupied',
    ...(input.orderId ? { currentOrderId: input.orderId } : {}),
    tableSessionId: input.tableSessionId || null,
    guestCount: normalizeGuestCount(input.guestCount),
    ...(input.occupiedSince ? { occupiedSince: input.occupiedSince } : {}),
  };
}

export function buildReleasedTableAfterSettlement<T extends object>(
  table: T,
): T & {
  status: 'available';
  currentOrderId?: undefined;
  tableSessionId: null;
  guestCount: null;
  occupiedSince?: undefined;
  unpaidBalance: 0;
  balance: null;
} {
  return {
    ...table,
    status: 'available',
    currentOrderId: undefined,
    tableSessionId: null,
    guestCount: null,
    occupiedSince: undefined,
    unpaidBalance: 0,
    balance: null,
  };
}

export function buildOrderServiceTableMetadata(orderData: OrderLike): {
  tableNumber?: string;
  table_number?: string;
  tableId?: string;
  table_id?: string;
  tableSessionId?: string;
  table_session_id?: string;
  guestCount?: number;
  guest_count?: number;
} {
  const tableNumber = orderData.tableNumber ?? orderData.table_number;
  const tableId = orderData.tableId ?? orderData.table_id;
  const tableSessionId = orderData.tableSessionId ?? orderData.table_session_id;
  const rawGuestCount = orderData.guestCount ?? orderData.guest_count;
  const tableService = isTableServiceOrder(orderData);

  if (!tableService && !hasValue(tableNumber) && !hasValue(tableId) && !hasValue(tableSessionId)) {
    return {};
  }

  const metadata: {
    tableNumber?: string;
    table_number?: string;
    tableId?: string;
    table_id?: string;
    tableSessionId?: string;
    table_session_id?: string;
    guestCount?: number;
    guest_count?: number;
  } = {};

  if (hasValue(tableNumber)) {
    const normalizedTableNumber = String(tableNumber).trim();
    metadata.tableNumber = normalizedTableNumber;
    metadata.table_number = normalizedTableNumber;
  }

  if (hasValue(tableId)) {
    const normalizedTableId = String(tableId).trim();
    metadata.tableId = normalizedTableId;
    metadata.table_id = normalizedTableId;
  }

  if (hasValue(tableSessionId)) {
    const normalizedSessionId = String(tableSessionId).trim();
    metadata.tableSessionId = normalizedSessionId;
    metadata.table_session_id = normalizedSessionId;
  }

  if (rawGuestCount !== null && rawGuestCount !== undefined && rawGuestCount !== '') {
    const normalizedCovers = normalizeGuestCount(rawGuestCount);
    metadata.guestCount = normalizedCovers;
    metadata.guest_count = normalizedCovers;
  } else if (tableService) {
    metadata.guestCount = 1;
    metadata.guest_count = 1;
  }

  return metadata;
}

export function buildTableSessionPaymentPayload(input: {
  orderId: string;
  tableSessionId: string;
  amount: unknown;
  method: 'cash' | 'card' | 'online' | 'digital_wallet' | 'split' | 'gift_card' | 'other';
  tipAmount?: unknown;
  seatNumber?: unknown;
  idempotencyKey?: string | null;
  items?: Array<Record<string, unknown>>;
}) {
  const amount = Math.max(0, Number(input.amount || 0));
  const tipAmount = Math.max(0, Number(input.tipAmount || 0));
  const amountCents = Math.round(amount * 100);
  const tipAmountCents = Math.round(tipAmount * 100);
  const seatNumber = input.seatNumber === null || input.seatNumber === undefined || input.seatNumber === ''
    ? null
    : normalizeGuestCount(input.seatNumber);

  return {
    order_id: input.orderId,
    table_session_id: input.tableSessionId,
    amount,
    amount_cents: amountCents,
    payment_method: input.method,
    tip_amount: tipAmount,
    tip_amount_cents: tipAmountCents,
    seat_number: seatNumber,
    idempotency_key: input.idempotencyKey || undefined,
    ...(input.items
      ? {
          items: input.items.map(item => {
            if (typeof item.item_amount_cents === 'number') {
              return item;
            }
            const itemAmount = Number(item.itemAmount ?? item.item_amount ?? item.amount ?? 0);
            return {
              ...item,
              item_amount_cents: Math.round(Math.max(0, itemAmount) * 100),
            };
          }),
        }
      : {}),
  };
}
