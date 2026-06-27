import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

type EditablePaymentMethod = 'cash' | 'card';

interface EditPaymentMethodModalProps {
  isOpen: boolean;
  orderNumber?: string;
  currentMethod: EditablePaymentMethod;
  isSaving?: boolean;
  onSave: (nextMethod: EditablePaymentMethod) => void;
  onClose: () => void;
}

export const EditPaymentMethodModal: React.FC<EditPaymentMethodModalProps> = ({
  isOpen,
  orderNumber,
  currentMethod,
  isSaving = false,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();
  const [selectedMethod, setSelectedMethod] = useState<EditablePaymentMethod>(currentMethod);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedMethod(currentMethod);
  }, [isOpen, currentMethod]);

  const hasChanged = useMemo(() => selectedMethod !== currentMethod, [selectedMethod, currentMethod]);

  const handleSubmit = () => {
    if (!hasChanged || isSaving) return;
    onSave(selectedMethod);
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
