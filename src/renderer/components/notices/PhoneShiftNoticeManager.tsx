/**
 * The Main's notice when a phone shift closes (founder rule 13/10/2026:
 * phones always hand over to the Main): who closed, on which phone, the
 * orders and sales, and whether the cash still has to be taken.
 *
 * Mounted once by App.tsx beside WaiterServiceRequestManager while a user is
 * logged in. usePhoneShiftNotices decides when (Main only, each shift once);
 * this renders one toast per closed shift. «Staff shifts» opens the staff
 * modal through GlobalCashierGate (PHONE_SHIFT_STAFF_OPEN_EVENT). The toast
 * root is a cashier-recovery surface, so the locked-day click fence lets it
 * through.
 */
import React from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Smartphone } from 'lucide-react';
import { PHONE_SHIFT_STAFF_OPEN_EVENT, usePhoneShiftNotices } from '../../hooks/usePhoneShiftNotices';
import {
  unitShiftCashToReceive,
  unitShiftPhoneLabel,
  unitShiftPhoneState,
  unitShiftStaffLabel,
  type UnitClosedShift,
} from '../../utils/unit-shift-readiness';
import { formatCurrency } from '../../utils/format';

/** A pending till stays up longer: its cash still has to be taken. */
const PENDING_NOTICE_MS = 30_000;
const NOTICE_MS = 12_000;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The shift's own currency when it has one, else the store's (formatCurrency default). */
function shiftMoney(amount: number | null, currency: string | null): string {
  const code = currency && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : undefined;
  return formatCurrency(amount ?? 0, code);
}

export interface PhoneShiftNoticeText {
  title: string;
  summary: string;
  handover: string;
}

export function phoneShiftNoticeText(shift: UnitClosedShift, t: Translate): PhoneShiftNoticeText {
  const name = unitShiftStaffLabel(shift);
  const phoneState = unitShiftPhoneState(shift);
  const phone = phoneState === 'active'
    ? unitShiftPhoneLabel(shift)
    : `${unitShiftPhoneLabel(shift)} (${phoneState === 'deactivated'
      ? t('phoneShifts.phoneDeactivated', { defaultValue: 'phone deactivated' })
      : t('phoneShifts.phoneRemoved', { defaultValue: 'phone removed' })})`;
  const title = shift.closed_by === 'main'
    ? t('notices.phoneShift.closedByMain', {
      defaultValue: "{{name}}'s shift on {{phone}} was closed at the register",
      name,
      phone,
    })
    : t('notices.phoneShift.closed', {
      defaultValue: '{{name}} closed their shift on {{phone}}',
      name,
      phone,
    });
  const summary = t('notices.phoneShift.summary', {
    defaultValue: 'Orders: {{orders}} · Sales: {{sales}}',
    orders: String(Math.max(0, Math.round(shift.total_orders_count ?? 0))),
    sales: shiftMoney(shift.total_sales_amount, shift.currency),
  });
  const amount = unitShiftCashToReceive(shift);
  let handover: string;
  switch (shift.handover) {
    case 'pending':
      handover = t('notices.phoneShift.cashToReceive', {
        defaultValue: 'Cash to receive: {{amount}}',
        amount: shiftMoney(amount, shift.currency),
      });
      break;
    case 'received':
      handover = amount > 0
        ? t('notices.phoneShift.receivedAmount', {
          defaultValue: 'Received by the register: {{amount}}',
          amount: shiftMoney(amount, shift.currency),
        })
        : t('notices.phoneShift.received', { defaultValue: 'Received by the register' });
      break;
    case 'none':
      handover = t('phoneShifts.handover.none', { defaultValue: 'Nothing to hand over' });
      break;
    default:
      handover = t('phoneShifts.handover.not_counted', { defaultValue: 'Not counted' });
  }
  return { title, summary, handover };
}

export function openPhoneShiftStaff(): void {
  window.dispatchEvent(new CustomEvent(PHONE_SHIFT_STAFF_OPEN_EVENT));
}

export function showPhoneShiftNotice(shift: UnitClosedShift, t: Translate): void {
  const text = phoneShiftNoticeText(shift, t);
  const pending = shift.handover === 'pending';
  toast.custom(
    (instance) => (
      <div
        data-cashier-recovery="true"
        data-testid={`phone-shift-notice-${shift.id}`}
        role="status"
        aria-live="polite"
        className={`pointer-events-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-900 shadow-2xl transition-opacity dark:border-white/15 dark:bg-gray-900 dark:text-white ${instance.visible ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold">{text.title}</p>
            <p>{text.summary}</p>
            <p className={pending ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-300'}>
              {text.handover}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                data-testid="phone-shift-notice-open"
                className="min-h-[44px] rounded-full bg-amber-400 px-4 py-1.5 text-xs font-semibold text-gray-950 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                onClick={() => {
                  toast.dismiss(instance.id);
                  openPhoneShiftStaff();
                }}
              >
                {t('notices.phoneShift.openStaff', { defaultValue: 'Staff shifts' })}
              </button>
              <button
                type="button"
                data-testid="phone-shift-notice-dismiss"
                className="min-h-[44px] rounded-full border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:border-white/20 dark:text-gray-100 dark:hover:bg-white/10"
                onClick={() => toast.dismiss(instance.id)}
              >
                {t('common.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>
        </div>
      </div>
    ),
    { id: `phone-shift-closed:${shift.id}`, duration: pending ? PENDING_NOTICE_MS : NOTICE_MS },
  );
}

export function PhoneShiftNoticeManager({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  usePhoneShiftNotices(enabled, (shift) => showPhoneShiftNotice(shift, t as unknown as Translate));
  return null;
}

export default PhoneShiftNoticeManager;
