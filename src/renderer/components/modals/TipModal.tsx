import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, Bike, HandCoins, Scissors, UserRound, WalletCards } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import { roundMoney } from '@shared/utils/money';
import { parseMoneyInputValue } from '../../utils/moneyInput';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';
import type { TipSelection, TipStaffOption, TipRecipientRole } from '../../utils/tip-recipient';

export type { TipRecipientRole, TipSelection, TipStaffOption } from '../../utils/tip-recipient';
export { tipPaymentFields, tipStaffOptionsFromItems } from '../../utils/tip-recipient';

interface TipModalProps {
  isOpen: boolean;
  onClose: () => void;
  baseAmount: number;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  selection: TipSelection | null;
  onApply: (selection: TipSelection | null) => void;
  /** The order's stylists; the `staff` recipient is offered only when there is one. */
  staffOptions?: TipStaffOption[];
}

const TIP_PERCENTAGES = [5, 10, 15, 20];
const EMPTY_STAFF_OPTIONS: TipStaffOption[] = [];
const tipChoiceButtonBaseClass =
  'rounded-xl border border-slate-200/90 bg-white/90 shadow-[0_8px_20px_rgba(15,23,42,0.10)] transition-all dark:border-white/10 dark:bg-white/5 dark:shadow-[0_10px_24px_rgba(0,0,0,0.28)] active:translate-y-px active:shadow-inner';
const TIP_RECIPIENT_ICON_CLASSES: Record<TipRecipientRole, string> = {
  waiter: 'tip-recipient-icon-waiter',
  cashier: 'tip-recipient-icon-cashier',
  driver: 'tip-recipient-icon-driver',
  staff: 'text-amber-500 dark:text-amber-300',
};
// Module audit closure (2026-09-16): one rounding rule for the renderer.

const defaultRecipientForOrder = (
  orderType?: 'pickup' | 'delivery' | 'dine-in',
  hasStaff = false,
): TipRecipientRole => {
  if (hasStaff) return 'staff';
  if (orderType === 'delivery') return 'driver';
  if (orderType === 'dine-in') return 'waiter';
  return 'cashier';
};

export const TipModal: React.FC<TipModalProps> = ({
  isOpen,
  onClose,
  baseAmount,
  orderType,
  selection,
  onApply,
  staffOptions = EMPTY_STAFF_OPTIONS,
}) => {
  const { t } = useTranslation();
  const hasStaff = staffOptions.length > 0;
  const onlyStaffId = staffOptions.length === 1 ? staffOptions[0].staffId : null;
  // A host may rebuild the same options on every render: reset only on a real change.
  const staffKey = staffOptions.map(option => option.staffId).join('|');
  const staffOptionsRef = useRef(staffOptions);
  staffOptionsRef.current = staffOptions;
  const [manualAmount, setManualAmount] = useState('');
  const [selectedPercentage, setSelectedPercentage] = useState<number | null>(null);
  const [recipientRole, setRecipientRole] = useState<TipRecipientRole>(
    defaultRecipientForOrder(orderType, hasStaff),
  );
  const [recipientStaffId, setRecipientStaffId] = useState<string | null>(onlyStaffId);

  const allowedRecipients = useMemo<TipRecipientRole[]>(() => {
    const base: TipRecipientRole[] = orderType === 'delivery'
      ? ['driver']
      : orderType === 'dine-in' ? ['waiter', 'cashier'] : ['cashier'];
    return hasStaff ? ['staff', ...base] : base;
  }, [hasStaff, orderType]);

  useEffect(() => {
    if (!isOpen) return;
    setManualAmount(selection?.amount ? selection.amount.toFixed(2) : '');
    setSelectedPercentage(null);
    const restored = selection?.recipientRole && allowedRecipients.includes(selection.recipientRole)
      ? selection.recipientRole : null;
    setRecipientRole(restored || defaultRecipientForOrder(orderType, hasStaff));
    const restoredStaffId = restored === 'staff' &&
      staffOptionsRef.current.some(option => option.staffId === selection?.recipientStaffId)
      ? selection!.recipientStaffId! : null;
    setRecipientStaffId(restoredStaffId ?? onlyStaffId);
  }, [allowedRecipients, hasStaff, isOpen, onlyStaffId, orderType, selection, staffKey]);

  const tipAmount = roundMoney(parseMoneyInputValue(manualAmount));
  const totalWithTip = roundMoney(baseAmount + tipAmount);

  const choosePercentage = (percentage: number) => {
    setSelectedPercentage(percentage);
    setManualAmount(roundMoney(baseAmount * percentage / 100).toFixed(2));
  };

  const chosenStaff = recipientRole === 'staff'
    ? staffOptions.find(option => option.staffId === recipientStaffId) ?? null
    : null;
  // A staff tip names one of the order's stylists; the cashier picks when there are several.
  const staffChoiceMissing = tipAmount > 0 && recipientRole === 'staff' && !chosenStaff;

  const handleApply = () => {
    if (tipAmount <= 0) {
      onApply(null);
      onClose();
      return;
    }
    if (staffChoiceMissing) return;
    onApply(chosenStaff
      ? { amount: tipAmount, recipientRole, recipientStaffId: chosenStaff.staffId, recipientStaffName: chosenStaff.staffName }
      : { amount: tipAmount, recipientRole });
    onClose();
  };

  const recipientDetails: Record<
    TipRecipientRole,
    { icon: React.ComponentType<{ className?: string }>; label: string; help: string }
  > = {
    waiter: {
      icon: UserRound,
      label: t('modals.tip.recipients.waiter', 'Waiter'),
      help: t('modals.tip.recipients.waiterHelp', 'Credits the waiter assigned to this table.'),
    },
    cashier: {
      icon: WalletCards,
      label: t('modals.tip.recipients.cashier', 'Cashier'),
      help: t('modals.tip.recipients.cashierHelp', 'Credits the cashier with the active drawer.'),
    },
    driver: {
      icon: Bike,
      label: t('modals.tip.recipients.driver', 'Driver'),
      help: t(
        'modals.tip.recipients.driverHelp',
        'The tip is held for the driver and assigned automatically when a driver takes the delivery.',
      ),
    },
    staff: {
      icon: Scissors,
      label: t('salonStaff.tipRecipient', 'Staff member'),
      help: t('salonStaff.tipRecipientHelp', 'Credits the staff member who did the service.'),
    },
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.tip.title', 'Add Tip')}
      size="sm"
      className="max-w-md!"
      closeOnBackdrop={false}
    >
      <div className="space-y-3">
        <div>
          <p className="mb-1.5 text-sm font-semibold liquid-glass-modal-text">
            {t('modals.tip.presetLabel', 'Choose a tip')}
          </p>
          <div className="grid grid-cols-4 gap-2">
            {TIP_PERCENTAGES.map(percentage => (
              <button
                key={percentage}
                type="button"
                onClick={() => choosePercentage(percentage)}
                aria-pressed={selectedPercentage === percentage}
                className={`min-h-10 text-sm font-bold ${tipChoiceButtonBaseClass} ${
                  selectedPercentage === percentage
                    ? 'border-emerald-400/70! bg-emerald-50! text-emerald-700 dark:bg-emerald-500/25! dark:text-emerald-100'
                    : 'liquid-glass-modal-text'
                }`}
              >
                {percentage}%
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-semibold liquid-glass-modal-text">
            {t('modals.tip.manualLabel', 'Or enter an amount')}
          </label>
          <div className="relative">
            <Banknote className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-emerald-400" />
            <CentsMoneyInput
              aria-label={t('modals.tip.manualLabel', 'Or enter an amount')}
              value={manualAmount}
              onValueChange={value => {
                setSelectedPercentage(null);
                setManualAmount(value);
              }}
              placeholder="0,00"
              className="w-full rounded-xl border-2 border-slate-200/90 bg-white/90 py-2.5 pl-10 pr-4 text-lg font-bold liquid-glass-modal-text shadow-inner outline-hidden transition-colors focus:border-emerald-400/60 dark:border-white/15 dark:bg-white/10"
            />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-sm font-semibold liquid-glass-modal-text">
            {t('modals.tip.recipientLabel', 'Tip goes to')}
          </p>
          <div className="grid gap-2">
            {allowedRecipients.map(role => {
              const recipient = recipientDetails[role];
              const Icon = recipient.icon;
              const isSelected = recipientRole === role;
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => setRecipientRole(role)}
                  aria-pressed={isSelected}
                  className={`flex min-h-14 items-center gap-3 p-2.5 text-left ${tipChoiceButtonBaseClass} ${
                    isSelected
                      ? 'border-yellow-400/80! bg-yellow-50/90! dark:bg-yellow-400/10!'
                      : ''
                  }`}
                >
                  <Icon className={`h-6 w-6 shrink-0 ${TIP_RECIPIENT_ICON_CLASSES[role]}`} />
                  <span>
                    <span className="block font-semibold liquid-glass-modal-text">
                      {recipient.label}
                    </span>
                    <span className="block text-xs liquid-glass-modal-text-muted">
                      {recipient.help}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {recipientRole === 'staff' && (
            <div className="mt-2" data-testid="tip-staff-choices">
              {staffOptions.length > 1 && (
                <p className="mb-1.5 text-sm font-semibold liquid-glass-modal-text">
                  {t('salonStaff.tipChooseStaff', 'Who gets the tip?')}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                {staffOptions.map(option => (
                  <button
                    key={option.staffId}
                    type="button"
                    onClick={() => setRecipientStaffId(option.staffId)}
                    aria-pressed={recipientStaffId === option.staffId}
                    className={`min-h-10 truncate px-2 text-sm font-semibold ${tipChoiceButtonBaseClass} ${
                      recipientStaffId === option.staffId
                        ? 'border-yellow-400/80! bg-yellow-50/90! dark:bg-yellow-400/10! liquid-glass-modal-text'
                        : 'liquid-glass-modal-text'
                    }`}
                  >
                    {option.staffName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white/80 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/10 dark:bg-white/5 dark:shadow-none">
          <div className="flex items-center justify-between text-sm liquid-glass-modal-text-muted">
            <span>{t('modals.tip.tipAmount', 'Tip')}</span>
            <span>{formatCurrency(tipAmount)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-2 font-bold liquid-glass-modal-text">
            <span>{t('modals.tip.totalWithTip', 'Total with tip')}</span>
            <span className="text-xl text-emerald-400">{formatCurrency(totalWithTip)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              onApply(null);
              onClose();
            }}
            className="liquid-glass-modal-button flex-1 border-slate-200/90 bg-white/90 font-medium liquid-glass-modal-text shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition-all active:translate-y-px active:shadow-inner dark:border-white/10 dark:bg-white/10"
          >
            {t('modals.tip.noTip', 'No tip')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={staffChoiceMissing}
            className="liquid-glass-modal-button flex-1 disabled:cursor-not-allowed disabled:opacity-50 border-emerald-400/50 bg-emerald-50/90 font-medium text-emerald-700 shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition-all active:translate-y-px active:shadow-inner dark:border-emerald-500/30 dark:bg-emerald-600/20 dark:text-emerald-300"
          >
            <HandCoins className="mr-2 inline h-4 w-4" />
            {t('modals.tip.apply', 'Apply Tip')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
