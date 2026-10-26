/**
 * "Change driver" in an order's Edit options (founder request, Tomikro
 * 26/10/2026): the cashier picked the wrong driver and the order went to the
 * delivered list. The native command `order_change_driver` moves the order,
 * its driver earning and the courier's cash to the driver who carried it,
 * while both shifts are open. Android: `src/utils/driverChange.ts`.
 */

type OrderLike = {
  status?: string | null;
  orderType?: string | null;
  order_type?: string | null;
  driverId?: string | null;
  driver_id?: string | null;
  driverName?: string | null;
  driver_name?: string | null;
} | null | undefined;

const CLOSED_STATUSES = new Set(['cancelled', 'canceled', 'refunded']);

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** A delivery order that is not cancelled or refunded, delivered ones included. */
export function canChangeOrderDriver(order: OrderLike): boolean {
  if (!order) return false;
  const type = text(order.orderType ?? order.order_type).toLowerCase();
  if (type !== 'delivery') return false;
  return !CLOSED_STATUSES.has(text(order.status).toLowerCase());
}

/** The order's current driver, if it has one. */
export function currentOrderDriver(order: OrderLike): { id: string; name: string | null } | null {
  if (!order) return null;
  const id = text(order.driverId) || text(order.driver_id);
  if (!id) return null;
  const name = text(order.driverName) || text(order.driver_name);
  return { id, name: name || null };
}

/** The refusal codes the native command answers with (`DRIVER_CHANGE_*`). */
export const DRIVER_CHANGE_ERROR_CODES = [
  'DRIVER_CHANGE_CANCELLED',
  'DRIVER_CHANGE_NOT_DELIVERY',
  'DRIVER_CHANGE_PLATFORM_FLEET',
  'DRIVER_CHANGE_SAME_DRIVER',
  'DRIVER_CHANGE_NEW_DRIVER_OFF_SHIFT',
  'DRIVER_CHANGE_SHIFT_CLOSED',
  'DRIVER_CHANGE_ADJUSTED_ORDER',
  'DRIVER_CHANGE_SYNC_IN_PROGRESS',
  'DRIVER_CHANGE_CURRENCY_MISMATCH',
  'DRIVER_CHANGE_MONEY_CHANGED',
] as const;

export type DriverChangeErrorCode = (typeof DRIVER_CHANGE_ERROR_CODES)[number];

const errorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['error', 'message', 'reason', 'code']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return '';
};

/** The `DRIVER_CHANGE_*` code an error names, if any. */
export function driverChangeErrorCode(error: unknown): DriverChangeErrorCode | null {
  const message = errorText(error);
  return DRIVER_CHANGE_ERROR_CODES.find(code => message.includes(code)) ?? null;
}

/** The locale key that explains a refusal (`orderDashboard.driverChange.errors.*`). */
export function driverChangeErrorKey(error: unknown): string {
  const code = driverChangeErrorCode(error);
  switch (code) {
    case 'DRIVER_CHANGE_CANCELLED':
      return 'orderDashboard.driverChange.errors.cancelled';
    case 'DRIVER_CHANGE_NOT_DELIVERY':
      return 'orderDashboard.driverChange.errors.notDelivery';
    case 'DRIVER_CHANGE_PLATFORM_FLEET':
      return 'orderDashboard.driverChange.errors.platformFleet';
    case 'DRIVER_CHANGE_SAME_DRIVER':
      return 'orderDashboard.driverChange.errors.sameDriver';
    case 'DRIVER_CHANGE_NEW_DRIVER_OFF_SHIFT':
      return 'orderDashboard.driverChange.errors.newDriverOffShift';
    case 'DRIVER_CHANGE_SHIFT_CLOSED':
      return 'orderDashboard.driverChange.errors.shiftClosed';
    case 'DRIVER_CHANGE_ADJUSTED_ORDER':
      return 'orderDashboard.driverChange.errors.adjustedOrder';
    case 'DRIVER_CHANGE_SYNC_IN_PROGRESS':
      return 'orderDashboard.driverChange.errors.syncInProgress';
    case 'DRIVER_CHANGE_CURRENCY_MISMATCH':
      return 'orderDashboard.driverChange.errors.currencyMismatch';
    case 'DRIVER_CHANGE_MONEY_CHANGED':
      return 'orderDashboard.driverChange.errors.moneyChanged';
    default:
      return 'orderDashboard.driverChange.errors.failed';
  }
}
