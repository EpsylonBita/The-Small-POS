import React, { useState, useEffect } from 'react';
import { CreditCard, Banknote, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFeatures } from '../../hooks/useFeatures';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import toast from 'react-hot-toast';
import { ActivityTracker } from '../../services/ActivityTracker';

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderTotal: number;
  discountAmount?: number;
  isProcessing?: boolean;
  orderType?: 'pickup' | 'delivery';
  minimumOrderAmount?: number; // From delivery zone settings in admin dashboard
  onPaymentComplete: (paymentData: {
    method: 'cash' | 'card';
    amount: number;
    transactionId?: string;
    driverId?: string;
    cashReceived?: number;
    change?: number;
  }) => void;
}

type ModalStep = 'minimum_warning' | 'payment_selection';

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  orderTotal,
  discountAmount = 0,
  isProcessing = false,
  orderType,
  minimumOrderAmount = 0, // Default to 0 (no minimum) if not provided
  onPaymentComplete
}) => {
  const { t } = useTranslation();
  const { isFeatureEnabled, isMobileWaiter } = useFeatures();
  const canUseCash = isFeatureEnabled('cashPayments');
  const canUseCard = isFeatureEnabled('cardPayments');
  const hasAnyPaymentMethod = canUseCash || canUseCard;
  const [isProcessingPayment, setIsProcessingPayment] = useState(isProcessing);

  // Check if order is below minimum (only if a minimum is set)
  const isBelowMinimum = minimumOrderAmount > 0 && orderTotal < minimumOrderAmount;

  // Determine initial step based on minimum order check
  const [currentStep, setCurrentStep] = useState<ModalStep>(
    isBelowMinimum ? 'minimum_warning' : 'payment_selection'
  );

  const originalTotal = orderTotal + discountAmount;

  // Reset step when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
      setIsProcessingPayment(isProcessing);
    }
  }, [isOpen, isProcessing, isBelowMinimum]);

  // Simple payment handler - just method, no amount input needed
  const handleSimplePayment = async (method: 'cash' | 'card') => {
    setIsProcessingPayment(true);
    try {
      // Brief processing delay
      await new Promise(resolve => setTimeout(resolve, 500));

      const txId = `${method.toUpperCase()}-${Date.now()}`;

      onPaymentComplete({
        method,
        amount: orderTotal,
        transactionId: txId,
        // No driver selection - will be assigned later in orders grid for delivery
        driverId: undefined,
        // No cash received/change calculation for simplified flow
        cashReceived: method === 'cash' ? orderTotal : undefined,
        change: method === 'cash' ? 0 : undefined
      });

      try {
        ActivityTracker.trackPaymentCompleted(orderTotal, method, txId, undefined);
      } catch {}

      toast.success(t(`modals.payment.${method}Success`));
      onClose();
    } catch (error) {
      toast.error(t('modals.payment.paymentFailed'));
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleSkipMinimumWarning = () => {
    setCurrentStep('payment_selection');
  };

  const resetModal = () => {
    setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
    setIsProcessingPayment(false);
  };

  const handleClose = () => {
    // Prevent closing while a payment is actively processing
    if (isProcessingPayment) return;
    resetModal();
    onClose();
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('modals.payment.title')}
      size="md"
      closeOnBackdrop={false}
      closeOnEscape={!isProcessingPayment}
    >
      {/* Content */}
      <div className="p-6">
        {/* Order Total with Discount Breakdown */}
        <div className="text-center mb-6">
          {discountAmount > 0 && (
            <div className="mb-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="liquid-glass-modal-text-muted">
                  {t('modals.payment.originalTotal')}
                </span>
                <span className="liquid-glass-modal-text">
                  €{originalTotal.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-green-600 dark:text-green-400">
                  {t('modals.payment.discount')}
                </span>
                <span className="text-green-600 dark:text-green-400">
                  -€{discountAmount.toFixed(2)}
                </span>
              </div>
              <div className="border-t border-gray-200/20 pt-2"></div>
            </div>
          )}
          <p className="text-sm liquid-glass-modal-text-muted">
            {discountAmount > 0 ? t('modals.payment.finalAmount') : t('modals.payment.totalAmount')}
          </p>
          <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">
            €{orderTotal.toFixed(2)}
          </p>
        </div>

        {/* Step: Minimum Order Warning */}
        {currentStep === 'minimum_warning' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 rounded-xl bg-orange-500/10 border border-orange-500/30">
              <AlertTriangle className="w-8 h-8 text-orange-400 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-orange-400">
                  {t('modals.payment.belowMinimumTitle', 'Minimum Order Not Met')}
                </h3>
                <p className="text-sm text-orange-300/80">
                  {t('modals.payment.belowMinimumMessage', 'Order amount is below minimum order amount of €{{amount}}', { amount: minimumOrderAmount.toFixed(2) })}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-3 rounded-xl font-medium transition-all duration-200 bg-gray-500/20 hover:bg-gray-500/30 liquid-glass-modal-text"
              >
                {t('modals.payment.cancel')}
              </button>
              <button
                onClick={handleSkipMinimumWarning}
                className="flex-1 px-4 py-3 rounded-xl font-medium transition-all duration-200 bg-orange-600 hover:bg-orange-700 text-white"
              >
                {t('modals.payment.skip', 'Skip')}
              </button>
            </div>
          </div>
        )}

        {/* Step: Payment Selection - Simplified (Cash or Card buttons only) */}
        {currentStep === 'payment_selection' && (
          <div className="space-y-4">
            {/* No payment methods available message */}
            {!hasAnyPaymentMethod && (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle className="w-6 h-6 text-amber-400 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-amber-400">
                    {t('terminal.messages.noPaymentMethods', 'No payment methods available')}
                  </h3>
                  <p className="text-sm text-amber-300/80">
                    {t('terminal.messages.contactManager', 'Contact your manager for configuration changes.')}
                  </p>
                </div>
              </div>
            )}

            {/* Cash Payment Option - Direct payment button */}
            {canUseCash ? (
              <button
                onClick={() => handleSimplePayment('cash')}
                disabled={isProcessingPayment}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 text-left group ${
                  isProcessingPayment
                    ? 'bg-gray-400/50 cursor-not-allowed opacity-60'
                    : 'bg-gradient-to-r from-green-50 to-green-100 border-green-200 hover:border-green-400 hover:shadow-lg dark:from-green-900/30 dark:to-green-800/30 dark:border-green-400/30 dark:hover:border-green-400/60 dark:hover:shadow-green-400/20'
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-green-500 text-white dark:bg-green-600 dark:text-green-100">
                    <Banknote className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold liquid-glass-modal-text">
                      {t('modals.payment.cashPayment')}
                    </h3>
                    <p className="text-sm liquid-glass-modal-text-muted">
                      {t('modals.payment.payWithCash', 'Complete order with cash')}
                    </p>
                  </div>
                </div>
              </button>
            ) : isMobileWaiter && (
              <div className="w-full p-4 rounded-xl border-2 border-gray-400/30 bg-gray-500/10 opacity-60">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-gray-500 text-white">
                    <Banknote className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold liquid-glass-modal-text-muted">
                      {t('modals.payment.cashPayment')}
                    </h3>
                    <p className="text-sm text-amber-400">
                      {t('terminal.messages.cashDrawerMainOnly', 'Cash handled by Main POS')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Card Payment Option - Direct payment button */}
            {canUseCard ? (
              <button
                onClick={() => handleSimplePayment('card')}
                disabled={isProcessingPayment}
                className={`w-full p-4 rounded-xl border-2 transition-all duration-200 text-left group ${
                  isProcessingPayment
                    ? 'bg-gray-400/50 cursor-not-allowed opacity-60'
                    : 'bg-gradient-to-r from-blue-50 to-blue-100 border-blue-200 hover:border-blue-400 hover:shadow-lg dark:from-blue-900/30 dark:to-blue-800/30 dark:border-blue-400/30 dark:hover:border-blue-400/60 dark:hover:shadow-blue-400/20'
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-blue-500 text-white dark:bg-blue-600 dark:text-blue-100">
                    <CreditCard className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold liquid-glass-modal-text">
                      {t('modals.payment.cardPayment')}
                    </h3>
                    <p className="text-sm liquid-glass-modal-text-muted">
                      {t('modals.payment.payWithCard', 'Complete order with card')}
                    </p>
                  </div>
                </div>
              </button>
            ) : (
              <div className="w-full p-4 rounded-xl border-2 border-gray-400/30 bg-gray-500/10 opacity-60">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-gray-500 text-white">
                    <CreditCard className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold liquid-glass-modal-text-muted">
                      {t('modals.payment.cardPayment')}
                    </h3>
                    <p className="text-sm text-amber-400">
                      {t('terminal.messages.featureDisabled', 'Feature disabled for this terminal')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Processing indicator */}
            {isProcessingPayment && (
              <div className="text-center py-2">
                <p className="text-sm liquid-glass-modal-text-muted animate-pulse">
                  {t('modals.payment.processing')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </LiquidGlassModal>
  );
};