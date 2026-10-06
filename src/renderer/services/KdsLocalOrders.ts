import { getVisibleOrderNumber } from '../utils/orderNumberUtils';
import type { LocalPreparationPhase } from './KdsLocalPhaseStore';
import {
  isCustomerOriginOrder,
  isExternalPlatformOrder,
  type OrderApprovalFields,
} from '../../../../shared/order-approval';
import { isBoxDecisionClosed } from '../../../../shared/box-order-contract';

/**
 * Local order rules shared by the Windows KDS and the connected customer display:
 * which local orders are active kitchen work, which terminal and tenant they belong
 * to, their identities and public number, and their board stage under the local
 * preparation mark. Pure functions over local SQLite order rows: no I/O, and
 * nothing here changes an order's status, payment or closure.
 */

/** Kitchen board stage. "Collected" orders leave the board; none of these is a canonical order status. */
export type KitchenBoardStatus = 'pending' | 'preparing' | 'ready';

const CLOSED_ORDER_STATUSES = new Set(['completed', 'delivered', 'cancelled', 'canceled', 'voided', 'refunded']);
// A canonical "ready" order stays kitchen work until a waiter collects it locally.
const ACTIVE_KITCHEN_ORDER_STATUSES = new Set(['pending', 'confirmed', 'preparing', 'ready']);
const ORDER_IDENTITY_KEYS = ['id', 'supabase_id', 'supabaseId', 'client_order_id', 'clientOrderId', 'client_request_id', 'clientRequestId'];

export const normalizeKdsString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export const readKdsString = (record: Record<string, unknown> | null | undefined, key: string): string =>
  normalizeKdsString(record?.[key]);

// SQLite rows may carry flags as booleans or 0/1.
const isFlagSet = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true';

const isRepairSettlement = (record: Record<string, unknown>): boolean => {
  const nested = record['orders'];
  const order = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
  return (readKdsString(record, 'order_context') || readKdsString(record, 'orderContext') || readKdsString(order, 'order_context')) === 'repair_settlement';
};

// Identity only: two live orders may share a visible number, so numbers never dedupe.
export const getKdsRecordIdentityKeys = (record: Record<string, unknown>): string[] =>
  [...new Set(ORDER_IDENTITY_KEYS.map((key) => readKdsString(record, key)).filter(Boolean))];

export const getKdsVisibleOrderNumber = (order: Record<string, unknown>): string =>
  getVisibleOrderNumber({
    display_order_number: readKdsString(order, 'display_order_number'),
    displayOrderNumber: readKdsString(order, 'displayOrderNumber'),
    order_number: readKdsString(order, 'order_number'),
    orderNumber: readKdsString(order, 'orderNumber'),
  });

const isGeneratedMobileTerminalId = (value: string): boolean => value.startsWith('mobile-terminal-');

export const matchesKdsTerminal = (terminalId: string | null, order: Record<string, unknown>): boolean => {
  if (!terminalId) return false;
  const sourceTerminalId = readKdsString(order, 'source_terminal_id') || readKdsString(order, 'sourceTerminalId');
  const orderTerminalId = readKdsString(order, 'terminal_id') || readKdsString(order, 'terminalId');
  const ownerTerminalId = readKdsString(order, 'owner_terminal_id') || readKdsString(order, 'ownerTerminalId');

  if (sourceTerminalId) return sourceTerminalId === terminalId;
  if (orderTerminalId) return orderTerminalId === terminalId || isGeneratedMobileTerminalId(orderTerminalId);
  return ownerTerminalId === terminalId || isGeneratedMobileTerminalId(ownerTerminalId);
};

// A row that explicitly names another organization or branch never reaches this kitchen.
export const matchesKdsTenant = (organizationId: string | null, branchId: string | null, order: Record<string, unknown>): boolean => {
  const orderOrganizationId = readKdsString(order, 'organization_id') || readKdsString(order, 'organizationId');
  const orderBranchId = readKdsString(order, 'branch_id') || readKdsString(order, 'branchId');
  return (!orderOrganizationId || orderOrganizationId === organizationId) && (!orderBranchId || orderBranchId === branchId);
};

/**
 * Not kitchen work yet: a delivery platform order (efood, Wolt, BOX…) still
 * waiting for the store's accept, and any BOX order whose decision the server
 * closed (BOX expired or refused it, or staff must check it with BOX first;
 * shared/box-order-contract.ts). A pending BOX order has no order items until
 * BOX confirms the accept. Customer self-orders (QR, web, kiosk) are not
 * platform orders and keep their place on the board.
 */
const isUnconfirmedPlatformOrder = (order: Record<string, unknown>, status: string): boolean => {
  const fields = order as OrderApprovalFields;
  return (
    (status === 'pending' && isExternalPlatformOrder(fields) && !isCustomerOriginOrder(fields)) ||
    isBoxDecisionClosed(order)
  );
};

/**
 * Active kitchen work: not closed, finished, cancelled, refunded, ghost, a repair settlement, in a Z report or
 * an unconfirmed platform order.
 */
export const isActiveLocalKitchenOrder = (order: Record<string, unknown>): boolean => {
  const status = readKdsString(order, 'status').toLowerCase();
  return (
    ACTIVE_KITCHEN_ORDER_STATUSES.has(status) &&
    !CLOSED_ORDER_STATUSES.has(status) &&
    !isFlagSet(order['is_closed']) &&
    !isFlagSet(order['order_is_closed']) &&
    !isFlagSet(order['is_ghost']) &&
    !readKdsString(order, 'z_report_id') &&
    !readKdsString(order, 'zReportId') &&
    !isRepairSettlement(order) &&
    !isUnconfirmedPlatformOrder(order, status)
  );
};

/** The canonical order status as a kitchen board stage. */
export const readCanonicalKitchenStatus = (order: Record<string, unknown>): KitchenBoardStatus => {
  const status = readKdsString(order, 'status').toLowerCase();
  return status === 'ready' ? 'ready' : status === 'preparing' ? 'preparing' : 'pending';
};

/**
 * Board stage under the order's latest local mark; null once a waiter collected it.
 * A mark only moves an order forward: it never downgrades a canonical stage.
 */
export const overlayKitchenStatus = (
  canonical: KitchenBoardStatus,
  phase: LocalPreparationPhase | undefined
): KitchenBoardStatus | null => {
  if (phase === 'collected') return null;
  if (phase === 'ready') return 'ready';
  if (phase === 'preparing' && canonical === 'pending') return 'preparing';
  return canonical;
};
