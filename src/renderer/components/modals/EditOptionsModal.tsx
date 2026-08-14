import React from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { liquidGlassModalTone } from '../../styles/designSystem';

interface EditOptionsModalProps {
  isOpen: boolean;
  orderCount: number;
  onEditInfo: () => void;
  onEditOrder: () => void;
  onChangeOrderType: (type: "pickup" | "delivery" | "dine-in") => void;
  currentOrderType?: "pickup" | "delivery" | "dine-in";
  onEditPayment: () => void;
  canEditPayment: boolean;
  paymentEditHint?: string;
  onClose: () => void;
}

export const EditOptionsModal: React.FC<EditOptionsModalProps> = ({
  isOpen,
  orderCount,
  onEditInfo,
  onEditOrder,
  onChangeOrderType,
  currentOrderType = "pickup",
  onEditPayment,
  canEditPayment,
  paymentEditHint,
  onClose
}) => {
  const { t } = useTranslation();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.editOptions.title')}
      size="md"
      className="!max-w-lg"
    >
            <p className="liquid-glass-modal-text-muted mb-6">
              {t('modals.editOptions.message', { count: orderCount })}
            </p>
            
            <div className="space-y-3 mb-6">
              {/* Edit Customer Info Option */}
              <button
                onClick={onEditInfo}
                className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 active:bg-slate-100 dark:active:bg-slate-800 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/60 dark:focus-visible:ring-slate-300/60 ${liquidGlassModalTone('neutral')}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl border border-slate-300 bg-white/80 dark:border-white/10 dark:bg-slate-800/80 flex items-center justify-center backdrop-blur-sm">
                    <svg className="w-6 h-6 text-slate-600 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editCustomerInfo')}</div>
                    <div className="text-sm liquid-glass-modal-text-muted">{t('modals.editOptions.editCustomerInfoDesc')}</div>
                  </div>
                </div>
              </button>

              {/* Edit Order Items Option */}
              <button
                onClick={onEditOrder}
                className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 active:bg-emerald-100 dark:active:bg-emerald-500/20 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:focus-visible:ring-emerald-300/60 ${liquidGlassModalTone('success')}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl border border-emerald-200 bg-emerald-100/80 dark:border-emerald-400/30 dark:bg-emerald-500/15 flex items-center justify-center backdrop-blur-sm">
                    <svg className="w-6 h-6 text-emerald-700 dark:text-emerald-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editOrderItems')}</div>
                    <div className="text-sm liquid-glass-modal-text-muted">{t('modals.editOptions.editOrderItemsDesc')}</div>
                  </div>
                </div>
              </button>

              {/* Edit Payment Method Option */}
              <button
                onClick={onEditPayment}
                disabled={!canEditPayment}
                className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 ${
                  canEditPayment
                    ? `${liquidGlassModalTone('warning')} active:bg-amber-100 dark:active:bg-amber-500/20 active:scale-[0.99] focus-visible:ring-amber-500/60 dark:focus-visible:ring-amber-300/60`
                    : `${liquidGlassModalTone('neutral')} cursor-not-allowed`
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-2xl border flex items-center justify-center backdrop-blur-sm ${
                    canEditPayment
                      ? 'border-amber-200 bg-amber-100/80 dark:border-amber-400/30 dark:bg-amber-500/15'
                      : 'border-slate-300 bg-white/70 dark:border-white/10 dark:bg-slate-800/70'
                  }`}>
                    <svg className={`w-6 h-6 ${
                      canEditPayment
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-500 dark:text-slate-400'
                    }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 8.25h19.5m-18 7.5h3m-3 3h5.25m9-10.5H5.25A2.25 2.25 0 003 10.5v6A2.25 2.25 0 005.25 18.75h13.5A2.25 2.25 0 0021 16.5v-6A2.25 2.25 0 0018.75 8.25z" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editPaymentMethod')}</div>
                    <div className="text-sm liquid-glass-modal-text-muted">
                      {canEditPayment
                        ? t('modals.editOptions.editPaymentMethodDesc')
                        : (paymentEditHint || t('orderDashboard.paymentMethodEditUnavailable'))
                      }
                    </div>
                  </div>
                </div>
              </button>

              {orderCount === 1 && (
                <div className={`w-full p-4 rounded-2xl border text-left transition-all duration-200 ${liquidGlassModalTone('warning')}`}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 rounded-2xl border border-amber-200 bg-amber-100/80 dark:border-amber-400/30 dark:bg-amber-500/15 flex items-center justify-center backdrop-blur-sm">
                      <svg className="w-6 h-6 text-amber-700 dark:text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h11m-8 5h8m-11 5h11m3-10 3 3m0 0-3 3m3-3h-7" />
                      </svg>
                    </div>
                    <div>
                      <div className="font-medium">{t('modals.editOptions.changeOrderType', 'Change Order Type')}</div>
                      <div className="text-sm liquid-glass-modal-text-muted">
                        {t('modals.editOptions.changeOrderTypeDesc', 'Reprice the order using pickup, delivery, or dine-in tiers')}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ["pickup", t('orders.type.pickup', 'Pickup')],
                      ["delivery", t('orders.type.delivery', 'Delivery')],
                      ["dine-in", t('orders.type.dineIn', 'Dine In')],
                    ] as const).map(([type, label]) => {
                      const isActive = currentOrderType === type;
                      return (
                        <button
                          key={type}
                          onClick={() => onChangeOrderType(type)}
                          disabled={isActive}
                          className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-all ${
                            isActive
                              ? 'border-yellow-400 bg-yellow-400 text-black cursor-default'
                              : 'border-slate-300 bg-white/80 text-slate-900 active:bg-slate-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 dark:border-white/20 dark:bg-white/10 dark:text-slate-100 dark:active:bg-white/20 dark:focus-visible:ring-amber-300/60'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
    </LiquidGlassModal>
  );
};

export default EditOptionsModal;
