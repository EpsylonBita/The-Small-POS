import React, { useEffect, useRef, useState } from 'react';
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
  const reasonInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const focusTimer = window.setTimeout(() => {
      reasonInputRef.current?.focus();
      reasonInputRef.current?.select();
    }, 75);

    return () => window.clearTimeout(focusTimer);
  }, [isOpen]);

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
      initialFocusRef={reasonInputRef}
      footer={(
        /* Fixed glass action bar: neutral safe close + red destructive confirm (disabled until a reason is given). */
        <div className="flex gap-3 border-t border-white/15 bg-white/[0.05] px-6 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={handleClose}
            className="liquid-glass-modal-button liquid-glass-modal-secondary flex-1 rounded-xl"
          >
            {t('modals.orderCancellation.keepOrder')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!cancelReason.trim()}
            className="liquid-glass-modal-button liquid-glass-modal-error flex-1 rounded-xl disabled:opacity-50 disabled:saturate-0 disabled:cursor-not-allowed"
          >
            {t('modals.orderCancellation.confirm')}
          </button>
        </div>
      )}
    >
      <p className="liquid-glass-modal-text-muted mb-6">
        {t('modals.orderCancellation.message', { count: orderCount })}
      </p>

      <div className="mb-6">
        <label className="block text-sm font-medium liquid-glass-modal-text mb-2">
          {t('modals.orderCancellation.reasonLabel')}
        </label>
        <textarea
          ref={reasonInputRef}
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
    </LiquidGlassModal>
  );
};

export default OrderCancellationModal;
