import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { DeliveryScooterIcon } from '../icons/OrderTypeGlyphs';

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
  /**
   * "Change driver" (founder request, Tomikro 26/10/2026): one delivery order
   * that is not cancelled, delivered ones included. The cashier picked the
   * wrong driver; the driver earning and the courier's cash follow the change.
   */
  canChangeDriver?: boolean;
  currentDriverName?: string | null;
  onChangeDriver?: () => void;
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
  canChangeDriver = false,
  currentDriverName,
  onChangeDriver,
  onClose
}) => {
  
  const reduceMotion = useReducedMotion();
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  const { t } = useTranslation();

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.editOptions.title')}
      size="md"
      className="max-w-lg! [&_.liquid-glass-modal-header]:border-b-0!"
    >
            <p className="liquid-glass-modal-text-muted mb-6">
              {t('modals.editOptions.message', { count: orderCount })}
            </p>
            
            <div className="space-y-3 mb-6">
              {/* Edit Customer Info Option */}
              <button
                onClick={onEditInfo}
                className="pos-glass-tap-card min-h-touch w-full p-4 text-left liquid-glass-modal-text focus-visible:outline-2 focus-visible:outline-yellow-400"
              >
                <div className="flex items-center gap-4">
                  <svg aria-hidden="true" className="h-7 w-7 shrink-0 text-slate-600 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <div>
                    <div className="font-medium">{t('modals.editOptions.editCustomerInfo')}</div>
                    <div className="text-sm liquid-glass-modal-text-muted">{t('modals.editOptions.editCustomerInfoDesc')}</div>
                  </div>
                </div>
              </button>

              {/* Edit Order Items Option */}
              <button
                onClick={onEditOrder}
                className="pos-glass-tap-card min-h-touch w-full p-4 text-left liquid-glass-modal-text focus-visible:outline-2 focus-visible:outline-yellow-400"
              >
                <div className="flex items-center gap-4">
                  <svg aria-hidden="true" className="h-7 w-7 shrink-0 text-emerald-700 dark:text-emerald-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
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
                className={`pos-glass-tap-card min-h-touch w-full p-4 text-left liquid-glass-modal-text focus-visible:outline-2 focus-visible:outline-yellow-400 ${canEditPayment ? '' : 'cursor-not-allowed'}`}
              >
                <div className="flex items-center gap-4">
                  <svg aria-hidden="true" className={`h-7 w-7 shrink-0 ${
                      canEditPayment
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-500 dark:text-slate-400'
                    }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 8.25h19.5m-18 7.5h3m-3 3h5.25m9-10.5H5.25A2.25 2.25 0 003 10.5v6A2.25 2.25 0 005.25 18.75h13.5A2.25 2.25 0 0021 16.5v-6A2.25 2.25 0 0018.75 8.25z" />
                  </svg>
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

              <AnimatePresence initial={false}>{orderCount === 1 && canChangeDriver && onChangeDriver && (
                <motion.div {...revealMotion}><button
                  type="button"
                  data-testid="edit-options-change-driver"
                  onClick={onChangeDriver}
                  className="pos-glass-tap-card min-h-touch w-full p-4 text-left liquid-glass-modal-text focus-visible:outline-2 focus-visible:outline-yellow-400"
                >
                  <div className="flex items-center gap-4">
                    <DeliveryScooterIcon className="h-7 w-7 shrink-0 text-sky-700 dark:text-sky-300" />
                    <div>
                      <div className="font-medium">{t('modals.editOptions.changeDriver')}</div>
                      <div className="text-sm liquid-glass-modal-text-muted" data-testid="edit-options-current-driver">
                        {currentDriverName
                          ? t('modals.editOptions.changeDriverCurrent', { name: currentDriverName })
                          : t('modals.editOptions.changeDriverNone')}
                      </div>
                    </div>
                  </div>
                </button></motion.div>
              )}</AnimatePresence>

              <AnimatePresence initial={false}>{orderCount === 1 && (
                <motion.div {...revealMotion} className="pos-glass-form-card w-full text-left liquid-glass-modal-text">
                  <div className="flex items-center gap-4 mb-3">
                    <svg aria-hidden="true" className="h-7 w-7 shrink-0 text-amber-700 dark:text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h11m-8 5h8m-11 5h11m3-10 3 3m0 0-3 3m3-3h-7" />
                    </svg>
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
                          className={`min-h-touch rounded-xl border px-3 py-2 text-sm font-semibold transition-all ${
                            isActive
                              ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) cursor-default'
                              : 'pos-glass-field focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--pos-s-fg)'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}</AnimatePresence>
            </div>
    </LiquidGlassModal>
  );
};

export default EditOptionsModal;
