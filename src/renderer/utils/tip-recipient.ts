/**
 * Who receives a tip (waiter, cashier, driver, or a stylist of the order).
 * One recipient per tip; a `staff` tip names a `staff_id` of the order's
 * lines, and native resolves that stylist's active shift (salon, 21/10/2026).
 */
export type TipRecipientRole = 'waiter' | 'cashier' | 'driver' | 'staff';

export interface TipSelection {
  amount: number;
  recipientRole: TipRecipientRole;
  /** `staff` only: one of the order's stylists (`staff_id` on its lines). */
  recipientStaffId?: string;
  recipientStaffName?: string;
}

/** A staff member named on the order's lines, who can receive its tip. */
export interface TipStaffOption {
  staffId: string;
  staffName: string;
}

const TIP_RECIPIENT_ROLES: readonly TipRecipientRole[] = ['waiter', 'cashier', 'driver', 'staff'];

const lineStaffId = (line: Record<string, any> | null | undefined): string =>
  String(line?.staff_id ?? line?.staffId ?? line?.metadata?.staff_id ?? '').trim();

/**
 * The distinct staff of an order's lines (`staff_id`, name from
 * `metadata.staff_name`), in line order. A tip can go to one of them.
 */
export function tipStaffOptionsFromItems(items: unknown): TipStaffOption[] {
  if (!Array.isArray(items)) return [];
  const byId = new Map<string, string>();
  for (const line of items as Array<Record<string, any>>) {
    const staffId = lineStaffId(line);
    if (!staffId) continue;
    const name = String(line?.metadata?.staff_name ?? line?.staff_name ?? line?.staffName ?? '').trim();
    if (!byId.has(staffId) || (!byId.get(staffId) && name)) byId.set(staffId, name);
  }
  return [...byId].map(([staffId, staffName]) => ({ staffId, staffName: staffName || staffId }));
}

/** The payment fields of a tip choice; a `staff` tip carries the stylist's id. */
export function tipPaymentFields(selection: TipSelection | null | undefined): {
  tipAmount?: number;
  tipRecipientRole?: TipRecipientRole;
  tipRecipientStaffId?: string;
} {
  if (!selection) return { tipAmount: undefined, tipRecipientRole: undefined };
  return {
    tipAmount: selection.amount,
    tipRecipientRole: selection.recipientRole,
    ...(selection.recipientRole === 'staff' && selection.recipientStaffId
      ? { tipRecipientStaffId: selection.recipientStaffId }
      : {}),
  };
}

/**
 * The recipient fields an order's first payment carries. A waiter tip goes to
 * the table's waiter; a staff tip only to a stylist on the order's own lines
 * (an invalid id is dropped while the role stays, so native refuses it
 * instead of defaulting to the cashier); other roles name no
 * staff and native resolves them.
 */
export function resolveOrderTipRecipient(input: {
  tipAmount: number;
  requestedRole: unknown;
  requestedStaffId?: unknown;
  items: unknown;
  waiterId?: string;
  waiterShiftId?: string;
}): {
  tipRecipientRole?: TipRecipientRole;
  tipRecipientStaffId?: string;
  tipRecipientStaffShiftId?: string;
} {
  const requested = String(input.requestedRole || '') as TipRecipientRole;
  if (!(input.tipAmount > 0) || !TIP_RECIPIENT_ROLES.includes(requested)) return {};
  if (requested === 'waiter') {
    return { tipRecipientRole: 'waiter', tipRecipientStaffId: input.waiterId, tipRecipientStaffShiftId: input.waiterShiftId };
  }
  if (requested === 'staff') {
    const staffId = String(input.requestedStaffId ?? '').trim();
    const onLines = Boolean(staffId) && tipStaffOptionsFromItems(input.items).some(option => option.staffId === staffId);
    return { tipRecipientRole: 'staff', tipRecipientStaffId: onLines ? staffId : undefined };
  }
  return { tipRecipientRole: requested };
}
