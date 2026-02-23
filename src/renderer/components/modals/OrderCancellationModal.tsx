import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface OrderCancellationModalProps {
  isOpen: boolean;
  orderCount: number;
  onConfirmCancel: (reason: string) => void;
  onClose: () => void;
}

export const OrderCancellationModal: React.FC<OrderCancellationModalProps> = ({
  isOpen,
  orderCount,
  onConfirmCancel,
  onClose
}) => {
  const { t } = useTranslation();
  const [cancelReason, setCancelReason] = useState('');



  const handleConfirm = () => {
    if (!cancelReason.trim()) {
      toast.error(t('modals.orderCancellation.reasonRequired'));
      return;
    }
    onConfirmCancel(cancelReason);
    setCancelReason(''); // Reset form
  };

  const handleClose = () => {
    setCancelReason(''); // Reset form on close
    onClose();
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.orderCancellation.title')}
      size="md"
      className="!max-w-lg"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <p className="liquid-glass-modal-text-muted mb-6">
        {t('modals.orderCancellation.message', { count: orderCount })}
      </p>

      <div className="mb-6">
        <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
          {t('modals.orderCancellation.reasonLabel')}
        </label>
        <textarea
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder={t('modals.orderCancellation.reasonPlaceholder')}
          className="liquid-glass-modal-input w-full resize-none"
          rows={4}
          maxLength={500}
        />
        <div className="text-xs liquid-glass-modal-text-muted mt-1">
          {t('modals.orderCancellation.characterCount', { current: cancelReason.length, max: 500 })}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleClose}
          className="flex-1 px-4 py-2 border liquid-glass-modal-border liquid-glass-modal-text hover:bg-white/10 dark:hover:bg-gray-800/20 rounded-lg transition-colors"
        >
          {t('modals.orderCancellation.cancel')}
        </button>
        <button
          onClick={handleConfirm}
          disabled={!cancelReason.trim()}
          className={`
            flex-1 px-4 py-2 rounded-lg font-medium transition-colors
            ${cancelReason.trim()
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
            }
          `}
        >
          {t('modals.orderCancellation.confirm')}
        </button>
      </div>
    </LiquidGlassModal>
  );
};

export default OrderCancellationModal;