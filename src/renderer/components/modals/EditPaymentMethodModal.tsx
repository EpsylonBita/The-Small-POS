import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

type EditablePaymentMethod = 'cash' | 'card';

export interface EditablePaymentRow {
  id: string;
  method: EditablePaymentMethod;
  amount: number;
  transactionRef?: string | null;
}

interface EditPaymentMethodModalProps {
  isOpen: boolean;
  orderNumber?: string;
  currentMethod: EditablePaymentMethod;
  payments?: EditablePaymentRow[];
  isSaving?: boolean;
  onSave: (paymentId: string | null, nextMethod: EditablePaymentMethod) => void;
  onClose: () => void;
}

export const EditPaymentMethodModal: React.FC<EditPaymentMethodModalProps> = ({
  isOpen,
  orderNumber,
  currentMethod,
  payments = [],
  isSaving = false,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();
  const [selectedMethod, setSelectedMethod] = useState<EditablePaymentMethod>(currentMethod);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const firstPayment = payments[0];
    setSelectedPaymentId(firstPayment?.id ?? null);
    setSelectedMethod(firstPayment?.method ?? currentMethod);
  }, [isOpen, currentMethod, payments]);

  const selectedPayment = useMemo(
    () => payments.find((payment) => payment.id === selectedPaymentId) ?? null,
    [payments, selectedPaymentId],
  );
  const selectedCurrentMethod = selectedPayment?.method ?? currentMethod;
  const hasChanged = useMemo(
    () => selectedMethod !== selectedCurrentMethod,
    [selectedMethod, selectedCurrentMethod],
  );

  const selectPayment = (payment: EditablePaymentRow) => {
    if (isSaving) return;
    setSelectedPaymentId(payment.id);
    setSelectedMethod(payment.method);
  };

  const handleSubmit = () => {
    if (!hasChanged || isSaving) return;
    onSave(selectedPaymentId, selectedMethod);
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={() => {
        if (isSaving) return;
        onClose();
      }}
      title={orderNumber ? `${t('modals.editPaymentMethod.title')} - #${orderNumber}` : t('modals.editPaymentMethod.title')}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={!isSaving}
      closeOnEscape={!isSaving}
    >
      <p className="liquid-glass-modal-text-muted mb-6">
        {t('modals.editPaymentMethod.message')}
      </p>

      {payments.length > 1 && (
        <div className="mb-6">
          <p className="liquid-glass-modal-text mb-3 text-sm font-semibold">
            {t('modals.editPaymentMethod.selectPayment')}
          </p>
          <div className="space-y-2">
            {payments.map((payment, index) => {
              const isSelected = payment.id === selectedPaymentId;
              return (
                <button
                  key={payment.id}
                  type="button"
                  onClick={() => selectPayment(payment)}
                  disabled={isSaving}
                  className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                    isSelected
                      ? 'border-amber-400/70 bg-amber-100/60 dark:border-amber-400/50 dark:bg-amber-500/20'
                      : 'border-zinc-300/70 bg-white/65 active:bg-zinc-100 dark:border-white/15 dark:bg-white/[0.06] dark:active:bg-white/[0.1]'
                  } ${isSaving ? 'cursor-not-allowed opacity-70' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="liquid-glass-modal-text font-medium">
                      {t('modals.editPaymentMethod.paymentNumber', { number: index + 1 })}
                    </span>
                    <span className="liquid-glass-modal-text font-semibold">
                      {new Intl.NumberFormat(undefined, {
                        style: 'currency',
                        currency: 'EUR',
                      }).format(payment.amount)}
                    </span>
                  </div>
                  <div className="liquid-glass-modal-text-muted mt-1 text-sm">
                    {t(`modals.editPaymentMethod.methods.${payment.method}`)}
                    {payment.transactionRef ? ` · ${payment.transactionRef}` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-3 mb-6">
        <button
          type="button"
          onClick={() => setSelectedMethod('cash')}
          disabled={isSaving}
          className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 liquid-glass-modal-text ${
            selectedMethod === 'cash'
              ? 'border-green-300/70 dark:border-green-400/40 bg-green-100/50 dark:bg-green-500/20'
              : 'border-green-200/50 dark:border-green-400/30 bg-green-50/40 dark:bg-green-500/10 active:bg-green-100/50 dark:active:bg-green-500/20'
          } ${isSaving ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          <div className="font-medium">{t('modals.editPaymentMethod.methods.cash')}</div>
        </button>

        <button
          type="button"
          onClick={() => setSelectedMethod('card')}
          disabled={isSaving}
          className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 liquid-glass-modal-text ${
            selectedMethod === 'card'
              ? 'border-amber-300/70 dark:border-amber-400/40 bg-amber-100/50 dark:bg-amber-500/20'
              : 'border-amber-200/50 dark:border-amber-400/30 bg-amber-50/40 dark:bg-amber-500/10 active:bg-amber-100/50 dark:active:bg-amber-500/20'
          } ${isSaving ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          <div className="font-medium">{t('modals.editPaymentMethod.methods.card')}</div>
        </button>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={isSaving}
          className={`flex-1 px-4 py-2 rounded-2xl border font-medium flex items-center justify-center min-h-[44px] transition-colors border-red-300/70 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-200 ${
            isSaving ? 'opacity-70 cursor-not-allowed' : 'active:bg-red-100 dark:active:bg-red-500/15'
          }`}
        >
          {t('modals.editPaymentMethod.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasChanged || isSaving}
          className={`flex-1 px-4 py-2 rounded-2xl font-medium flex items-center justify-center min-h-[44px] transition-colors ${
            !hasChanged || isSaving
              ? 'bg-zinc-100 text-zinc-400 border border-zinc-200/80 dark:bg-white/[0.06] dark:text-zinc-500 dark:border-white/10 cursor-not-allowed'
              : 'bg-green-600 active:bg-green-700 text-white'
          }`}
        >
          {isSaving ? t('modals.editPaymentMethod.saving') : t('modals.editPaymentMethod.save')}
        </button>
      </div>
    </LiquidGlassModal>
  );
};

export default EditPaymentMethodModal;
