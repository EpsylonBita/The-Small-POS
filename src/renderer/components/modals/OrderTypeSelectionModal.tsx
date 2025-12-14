import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface OrderTypeSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOrderTypeSelect: (type: 'pickup' | 'delivery') => void;
}

export const OrderTypeSelectionModal = memo<OrderTypeSelectionModalProps>(({
  isOpen,
  onClose,
  onOrderTypeSelect
}) => {
  const { t } = useTranslation();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.orderType.title')}
      size="md"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div className="p-6 space-y-4">
        {/* Pickup Option */}
        <button
          onClick={() => onOrderTypeSelect('pickup')}
          className="w-full p-6 rounded-xl border-2 transition-all duration-200 text-left group bg-gradient-to-r from-blue-50/50 to-blue-100/50 dark:from-blue-900/30 dark:to-blue-800/30 border-blue-200/50 dark:border-blue-400/30 hover:border-blue-400 dark:hover:border-blue-400/60"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-blue-500 text-white dark:bg-blue-600 dark:text-blue-100">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-1 liquid-glass-modal-text">
                {t('modals.orderType.pickup')}
              </h3>
              <p className="text-sm liquid-glass-modal-text-muted">
                {t('modals.orderType.pickupDescription')}
              </p>
            </div>
          </div>
        </button>

        {/* Delivery Option */}
        <button
          onClick={() => onOrderTypeSelect('delivery')}
          className="w-full p-6 rounded-xl border-2 transition-all duration-200 text-left group bg-gradient-to-r from-green-50/50 to-green-100/50 dark:from-green-900/30 dark:to-green-800/30 border-green-200/50 dark:border-green-400/30 hover:border-green-400 dark:hover:border-green-400/60"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-green-500 text-white dark:bg-green-600 dark:text-green-100">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-semibold mb-1 liquid-glass-modal-text">
                {t('modals.orderType.delivery')}
              </h3>
              <p className="text-sm liquid-glass-modal-text-muted">
                {t('modals.orderType.deliveryDescription')}
              </p>
            </div>
          </div>
        </button>
      </div>
    </LiquidGlassModal>
  );
});

OrderTypeSelectionModal.displayName = 'OrderTypeSelectionModal';