import React, { useEffect, useMemo, useState } from 'react';
import { Banknote, Bike, HandCoins, UserRound, WalletCards } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import {
  formatMoneyInputFromNumber,
  formatMoneyInputWithCents,
  parseMoneyInputValue,
} from '../../utils/moneyInput';
import { LiquidGlassModal } from '../ui/pos-glass-components';

export type TipRecipientRole = 'waiter' | 'cashier' | 'driver';

export interface TipSelection {
  amount: number;
  recipientRole: TipRecipientRole;
}

interface TipModalProps {
  isOpen: boolean;
  onClose: () => void;
  baseAmount: number;
  orderType?: 'pickup' | 'delivery' | 'dine-in';
  selection: TipSelection | null;
  onApply: (selection: TipSelection | null) => void;
}

const TIP_PERCENTAGES = [5, 10, 15, 20];
const tipChoiceButtonBaseClass =
  'rounded-xl border border-slate-200/90 bg-white/90 shadow-[0_8px_20px_rgba(15,23,42,0.10)] transition-all dark:border-white/10 dark:bg-white/5 dark:shadow-[0_10px_24px_rgba(0,0,0,0.28)] active:translate-y-px active:shadow-inner';
const TIP_RECIPIENT_ICON_CLASSES: Record<TipRecipientRole, string> = {
  waiter: 'tip-recipient-icon-waiter',
  cashier: 'tip-recipient-icon-cashier',
  driver: 'tip-recipient-icon-driver',
};
const roundMoney = (value: number) =>
  Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;

const defaultRecipientForOrder = (
  orderType?: 'pickup' | 'delivery' | 'dine-in',
): TipRecipientRole => {
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
}) => {
  const { t } = useTranslation();
  const [manualAmount, setManualAmount] = useState('');
  const [selectedPercentage, setSelectedPercentage] = useState<number | null>(null);
  const [recipientRole, setRecipientRole] = useState<TipRecipientRole>(
    defaultRecipientForOrder(orderType),
  );

  useEffect(() => {
    if (!isOpen) return;
    setManualAmount(selection?.amount ? formatMoneyInputFromNumber(selection.amount) : '');
    setSelectedPercentage(null);
    setRecipientRole(selection?.recipientRole || defaultRecipientForOrder(orderType));
  }, [isOpen, orderType, selection]);

  const allowedRecipients = useMemo<TipRecipientRole[]>(() => {
    if (orderType === 'delivery') return ['driver'];
    if (orderType === 'dine-in') return ['waiter', 'cashier'];
    return ['cashier'];
  }, [orderType]);

  const tipAmount = roundMoney(parseMoneyInputValue(manualAmount));
  const totalWithTip = roundMoney(baseAmount + tipAmount);

  const choosePercentage = (percentage: number) => {
    setSelectedPercentage(percentage);
    setManualAmount(formatMoneyInputFromNumber(roundMoney(baseAmount * percentage / 100)));
  };

  const handleApply = () => {
    if (tipAmount <= 0) {
      onApply(null);
      onClose();
      return;
    }
    onApply({ amount: tipAmount, recipientRole });
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
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.tip.title', 'Add Tip')}
      size="sm"
      className="!max-w-md"
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
                    ? '!border-emerald-400/70 !bg-emerald-50 text-emerald-700 dark:!bg-emerald-500/25 dark:text-emerald-100'
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
            <input
              type="text"
              inputMode="decimal"
              value={manualAmount}
              onChange={event => {
                setSelectedPercentage(null);
                setManualAmount(formatMoneyInputWithCents(event.target.value));
              }}
              placeholder="0,00"
              className="w-full rounded-xl border-2 border-slate-200/90 bg-white/90 py-2.5 pl-10 pr-4 text-lg font-bold liquid-glass-modal-text shadow-inner outline-none transition-colors focus:border-emerald-400/60 dark:border-white/15 dark:bg-white/10"
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
                      ? '!border-yellow-400/80 !bg-yellow-50/90 dark:!bg-yellow-400/10'
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
            className="liquid-glass-modal-button flex-1 border-emerald-400/50 bg-emerald-50/90 font-medium text-emerald-700 shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition-all active:translate-y-px active:shadow-inner dark:border-emerald-500/30 dark:bg-emerald-600/20 dark:text-emerald-300"
          >
            <HandCoins className="mr-2 inline h-4 w-4" />
            {t('modals.tip.apply', 'Apply Tip')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
