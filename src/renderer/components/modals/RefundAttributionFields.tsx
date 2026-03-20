import React from 'react';
import { Banknote, CreditCard, Truck, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface RefundAttributionFieldsProps {
  refundMethod: 'cash' | 'card';
  onRefundMethodChange: (method: 'cash' | 'card') => void;
  cashHandler?: 'cashier_drawer' | 'driver_shift';
  onCashHandlerChange?: (handler: 'cashier_drawer' | 'driver_shift') => void;
  allowDriverCashHandler?: boolean;
  disabled?: boolean;
}

export const RefundAttributionFields: React.FC<RefundAttributionFieldsProps> = ({
  refundMethod,
  onRefundMethodChange,
  cashHandler = 'cashier_drawer',
  onCashHandlerChange,
  allowDriverCashHandler = false,
  disabled = false,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
          {t('modals.refund.refundRoute', { defaultValue: 'Refund Route' })}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRefundMethodChange('cash')}
            className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
              refundMethod === 'cash'
                ? 'bg-green-600/20 text-green-300 border-green-500/30'
                : ''
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Banknote className="w-4 h-4" />
            {t('modals.refund.cashRefund', { defaultValue: 'Cash Refund' })}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRefundMethodChange('card')}
            className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
              refundMethod === 'card'
                ? 'bg-blue-600/20 text-blue-300 border-blue-500/30'
                : ''
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <CreditCard className="w-4 h-4" />
            {t('modals.refund.cardRefund', { defaultValue: 'Card Refund' })}
          </button>
        </div>
      </div>

      {refundMethod === 'cash' && onCashHandlerChange && (
        <div>
          <label className="block text-sm font-medium liquid-glass-modal-text-muted mb-2">
            {t('modals.refund.cashReturnedBy', { defaultValue: 'Cash Returned By' })}
          </label>
          <div className={`grid gap-2 ${allowDriverCashHandler ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onCashHandlerChange('cashier_drawer')}
              className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
                cashHandler === 'cashier_drawer'
                  ? 'bg-amber-600/20 text-amber-300 border-amber-500/30'
                  : ''
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <Wallet className="w-4 h-4" />
              {t('modals.refund.cashierCash', { defaultValue: 'Cashier Cash' })}
            </button>
            {allowDriverCashHandler && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCashHandlerChange('driver_shift')}
                className={`liquid-glass-modal-button justify-center gap-2 text-sm ${
                  cashHandler === 'driver_shift'
                    ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/30'
                    : ''
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Truck className="w-4 h-4" />
                {t('modals.refund.driverCash', { defaultValue: 'Driver Cash' })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default RefundAttributionFields;
