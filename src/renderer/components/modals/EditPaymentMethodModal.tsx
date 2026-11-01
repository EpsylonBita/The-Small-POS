import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCurrency } from '../../utils/format';
import { LiquidGlassModal } from '../ui/pos-glass-components';

type EditablePaymentMethod = 'cash' | 'card';

export interface EditablePaymentRow {
  id: string;
  method: EditablePaymentMethod;
  amount: number;
  currency?: string | null;
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
      className="max-w-lg!"
      closeOnBackdrop={!isSaving}
      closeOnEscape={!isSaving}
      closeDisabled={isSaving}
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
                      ? 'border-(--pos-s-sel-bg) ring-1 ring-(--pos-s-sel-bg) bg-(--pos-s-surface-2) dark:bg-zinc-800'
                      : 'border-zinc-300/70 bg-white/65 active:bg-zinc-100 dark:border-white/15 dark:bg-white/6 dark:active:bg-white/10'
                  } ${isSaving ? 'cursor-not-allowed opacity-70' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="liquid-glass-modal-text font-medium">
                      {t('modals.editPaymentMethod.paymentNumber', { number: index + 1 })}
                    </span>
                    <span className="liquid-glass-modal-text font-semibold">
                      {formatCurrency(payment.amount, payment.currency ?? null)}
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
              ? 'border-(--pos-s-border) dark:border-zinc-700 bg-(--pos-s-surface-2) dark:bg-zinc-800'
              : 'border-(--pos-s-border) dark:border-zinc-700 bg-(--pos-s-surface-2) dark:bg-zinc-800 active:bg-(--pos-s-surface-2) dark:active:bg-zinc-800'
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
              ? 'border-(--pos-s-border) dark:border-zinc-700 bg-(--pos-s-surface-2) dark:bg-zinc-800'
              : 'border-(--pos-s-border) dark:border-zinc-700 bg-(--pos-s-surface-2) dark:bg-zinc-800 active:bg-(--pos-s-surface-2) dark:active:bg-zinc-800'
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
          className={`flex-1 px-4 py-2 rounded-2xl border font-medium flex items-center justify-center min-h-touch transition-colors border-(--pos-s-border) bg-(--pos-s-surface-2) text-(--pos-s-fg) dark:border-zinc-700 dark:bg-zinc-800 ${
            isSaving ? 'opacity-70 cursor-not-allowed' : 'active:bg-(--pos-s-border) dark:active:bg-zinc-800'
          }`}
        >
          {t('modals.editPaymentMethod.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasChanged || isSaving}
          className={`flex-1 px-4 py-2 rounded-2xl font-medium flex items-center justify-center min-h-touch transition-colors ${
            !hasChanged || isSaving
              ? 'bg-zinc-100 text-zinc-400 border border-zinc-200/80 dark:bg-white/6 dark:text-zinc-500 dark:border-white/10 cursor-not-allowed'
              : 'bg-(--pos-s-yellow) active:bg-yellow-500 text-black'
          }`}
        >
          {isSaving ? t('modals.editPaymentMethod.saving') : t('modals.editPaymentMethod.save')}
        </button>
      </div>
    </LiquidGlassModal>
  );
};

export default EditPaymentMethodModal;
