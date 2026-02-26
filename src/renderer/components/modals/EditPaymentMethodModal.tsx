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
          className={`w-full p-4 rounded-lg border text-left transition-all duration-200 liquid-glass-modal-text ${
            selectedMethod === 'cash'
              ? 'border-green-300/70 dark:border-green-400/40 bg-green-100/50 dark:bg-green-500/20'
              : 'border-green-200/50 dark:border-green-400/30 bg-green-50/40 dark:bg-green-500/10 hover:bg-green-100/50 dark:hover:bg-green-500/20'
          } ${isSaving ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          <div className="font-medium">{t('modals.editPaymentMethod.methods.cash')}</div>
        </button>

        <button
          type="button"
          onClick={() => setSelectedMethod('card')}
          disabled={isSaving}
          className={`w-full p-4 rounded-lg border text-left transition-all duration-200 liquid-glass-modal-text ${
            selectedMethod === 'card'
              ? 'border-blue-300/70 dark:border-blue-400/40 bg-blue-100/50 dark:bg-blue-500/20'
              : 'border-blue-200/50 dark:border-blue-400/30 bg-blue-50/40 dark:bg-blue-500/10 hover:bg-blue-100/50 dark:hover:bg-blue-500/20'
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
          className={`flex-1 px-4 py-2 border liquid-glass-modal-border liquid-glass-modal-text rounded-lg transition-colors ${
            isSaving ? 'opacity-70 cursor-not-allowed' : 'hover:bg-white/10 dark:hover:bg-gray-800/20'
          }`}
        >
          {t('modals.editPaymentMethod.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasChanged || isSaving}
          className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
            !hasChanged || isSaving
              ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              : 'bg-blue-500 hover:bg-blue-600 text-white'
          }`}
        >
          {isSaving ? t('modals.editPaymentMethod.saving') : t('modals.editPaymentMethod.save')}
        </button>
      </div>
    </LiquidGlassModal>
  );
};

export default EditPaymentMethodModal;
