import React from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';

interface EditOptionsModalProps {
  isOpen: boolean;
  orderCount: number;
  onEditInfo: () => void;
  onEditOrder: () => void;
  onClose: () => void;
}

export const EditOptionsModal: React.FC<EditOptionsModalProps> = ({
  isOpen,
  orderCount,
  onEditInfo,
  onEditOrder,
  onClose
}) => {
  const { t } = useTranslation();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.editOptions.title')}
      size="md"
    >
            <p className="liquid-glass-modal-text-muted mb-6">
              {t('modals.editOptions.message', { count: orderCount })}
            </p>
            
            <div className="space-y-3 mb-6">
              {/* Edit Customer Info Option */}
              <button
                onClick={onEditInfo}
                className="w-full p-4 rounded-lg border text-left transition-all duration-200 border-blue-200/50 dark:border-blue-400/30 bg-blue-50/50 dark:bg-blue-500/10 hover:bg-blue-100/50 dark:hover:bg-blue-500/20 liquid-glass-modal-text"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/20 dark:bg-blue-500/30 flex items-center justify-center backdrop-blur-sm">
                    <svg className="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editCustomerInfo')}</div>
                    <div className="text-sm opacity-75 liquid-glass-modal-text-muted">{t('modals.editOptions.editCustomerInfoDesc')}</div>
                  </div>
                </div>
              </button>

              {/* Edit Order Items Option */}
              <button
                onClick={onEditOrder}
                className="w-full p-4 rounded-lg border text-left transition-all duration-200 border-green-200/50 dark:border-green-400/30 bg-green-50/50 dark:bg-green-500/10 hover:bg-green-100/50 dark:hover:bg-green-500/20 liquid-glass-modal-text"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-500/20 dark:bg-green-500/30 flex items-center justify-center backdrop-blur-sm">
                    <svg className="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editOrderItems')}</div>
                    <div className="text-sm opacity-75 liquid-glass-modal-text-muted">{t('modals.editOptions.editOrderItemsDesc')}</div>
                  </div>
                </div>
              </button>
            </div>
    </LiquidGlassModal>
  );
};

export default EditOptionsModal;