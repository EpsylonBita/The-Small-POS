import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bike, HandCoins, Scissors, UserRound, WalletCards } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import { roundMoney } from '@shared/utils/money';
import { parseMoneyInputValue } from '../../utils/moneyInput';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';
import type { TipSelection, TipStaffOption, TipRecipientRole } from '../../utils/tip-recipient';
import { CashHandIcon } from '../icons/PaymentMethodIcons';

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
  'rounded-xl border transition-all focus-visible:outline-2 focus-visible:outline-yellow-400';
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

// Remove interactive content at the original conditional boundary; only its empty
// visual wrapper remains for the exit collapse (founder 11/11/2026).
function TipStaffReveal({ children, ...props }: React.ComponentProps<typeof motion.div>) {
  const isPresent = useIsPresent();
  return <motion.div {...props}>{isPresent ? children : null}</motion.div>;
}

export const TipModal: React.FC<TipModalProps> = ({
  isOpen,
  onClose,
  baseAmount,
  orderType,
  selection,
  onApply,
  staffOptions = EMPTY_STAFF_OPTIONS,
}) => {
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

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
      className="max-w-md! [&_.liquid-glass-modal-header]:border-b-0!"
      closeOnBackdrop={false}
    >
      <div className="space-y-3">
        <div className="pos-glass-form-card">
          <p className="mb-1.5 text-xs font-semibold liquid-glass-modal-text-muted">
            {t('modals.tip.presetLabel', 'Choose a tip')}
          </p>
          <div className="grid grid-cols-4 gap-2">
            {TIP_PERCENTAGES.map(percentage => (
              <button
                key={percentage}
                type="button"
                onClick={() => choosePercentage(percentage)}
                aria-pressed={selectedPercentage === percentage}
                className={`min-h-touch text-sm font-bold ${tipChoiceButtonBaseClass} ${
                  selectedPercentage === percentage
                    ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]'
                    : 'pos-glass-field'
                }`}
              >
                {percentage}%
              </button>
            ))}
          </div>
          <div className="mt-3">
          <label className="mb-1.5 block text-xs font-semibold liquid-glass-modal-text-muted">
            {t('modals.tip.manualLabel', 'Or enter an amount')}
          </label>
          <div className="relative">
            <CashHandIcon className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-emerald-700 dark:text-emerald-400" />
            <CentsMoneyInput
              aria-label={t('modals.tip.manualLabel', 'Or enter an amount')}
              value={manualAmount}
              onValueChange={value => {
                setSelectedPercentage(null);
                setManualAmount(value);
              }}
              placeholder="0,00"
              className="liquid-glass-modal-input pos-glass-field min-h-touch w-full py-2.5 pl-10! pr-4 text-lg font-bold"
            />
          </div>
        </div>

        </div>
        <div className="pos-glass-form-card">
          <p className="mb-1.5 text-xs font-semibold liquid-glass-modal-text-muted">
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
                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]'
                      : 'pos-glass-tap-card'
                  }`}
                >
                  <Icon className={`h-6 w-6 shrink-0 ${TIP_RECIPIENT_ICON_CLASSES[role]}`} />
                  <span>
                    <span className={`block font-semibold ${isSelected ? 'text-(--pos-s-sel-fg)' : 'liquid-glass-modal-text'}`}>
                      {recipient.label}
                    </span>
                    <span className={`block text-xs ${isSelected ? 'text-(--pos-s-sel-fg)' : 'liquid-glass-modal-text-muted'}`}>
                      {recipient.help}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <AnimatePresence initial={false}>{recipientRole === 'staff' && (
            <TipStaffReveal {...revealMotion} className="mt-2">
              <div data-testid="tip-staff-choices">
              <AnimatePresence initial={false}>{staffOptions.length > 1 && (
                <motion.p {...revealMotion} className="mb-1.5 text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('salonStaff.tipChooseStaff', 'Who gets the tip?')}
                </motion.p>
              )}</AnimatePresence>
              <div className="grid grid-cols-2 gap-2">
                {staffOptions.map(option => (
                  <button
                    key={option.staffId}
                    type="button"
                    onClick={() => setRecipientStaffId(option.staffId)}
                    aria-pressed={recipientStaffId === option.staffId}
                    className={`min-h-touch truncate px-2 text-sm font-semibold ${tipChoiceButtonBaseClass} ${
                      recipientStaffId === option.staffId
                        ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg) shadow-[var(--pos-s-depth-card)] active:translate-y-px active:shadow-[var(--pos-s-depth-press)]'
                        : 'pos-glass-field'
                    }`}
                  >
                    {option.staffName}
                  </button>
                ))}
              </div>
              </div>
            </TipStaffReveal>
          )}</AnimatePresence>
        </div>

        <div className="pos-glass-form-card p-3!">
          <div className="flex items-center justify-between text-sm liquid-glass-modal-text-muted">
            <span>{t('modals.tip.tipAmount', 'Tip')}</span>
            <span>{formatCurrency(tipAmount)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between pt-2 font-bold liquid-glass-modal-text">
            <span>{t('modals.tip.totalWithTip', 'Total with tip')}</span>
            <span className="text-xl liquid-glass-modal-text">{formatCurrency(totalWithTip)}</span>
          </div>
        </div>

        <div className="flex gap-3 px-6 pb-5 pt-2">
          <button
            type="button"
            onClick={() => {
              onApply(null);
              onClose();
            }}
            className="liquid-glass-modal-button flex-1 border-(--pos-s-border) bg-(--pos-s-surface) font-medium text-(--pos-s-fg) shadow-[0_10px_24px_rgba(0,0,0,0.12)] transition-all active:translate-y-px active:shadow-inner"
          >
            {t('modals.tip.noTip', 'No tip')}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={staffChoiceMissing}
            className="liquid-glass-modal-button pos-modal-primary flex-1 disabled:cursor-not-allowed disabled:opacity-60 font-semibold shadow-[0_10px_24px_rgba(0,0,0,0.12)] transition-all active:translate-y-px active:shadow-inner"
          >
            <HandCoins className="mr-2 inline h-4 w-4" />
            {t('modals.tip.apply', 'Apply Tip')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
