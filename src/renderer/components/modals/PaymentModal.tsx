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

type ModalStep = 'minimum_warning' | 'payment_selection' | 'cash_input';

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
  const [cashReceived, setCashReceived] = useState<string>('');
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'cash' | 'card' | null>(null);

  // Check if order is below minimum (only if a minimum is set)
  const isBelowMinimum = minimumOrderAmount > 0 && orderTotal < minimumOrderAmount;

  // Determine initial step based on minimum order check
  const [currentStep, setCurrentStep] = useState<ModalStep>(
    isBelowMinimum ? 'minimum_warning' : 'payment_selection'
  );

  const originalTotal = orderTotal + discountAmount;

  // Calculate change
  const cashAmount = parseFloat(cashReceived) || 0;
  const changeAmount = cashAmount - orderTotal;
  const hasEnoughCash = cashAmount >= orderTotal;

  // Reset step when modal opens
  useEffect(() => {
    if (isOpen) {
      setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
      setIsProcessingPayment(isProcessing);
      setCashReceived('');
      setSelectedPaymentMethod(null);
    }
  }, [isOpen, isProcessing, isBelowMinimum]);

  // Handle payment method selection
  const handlePaymentMethodSelect = (method: 'cash' | 'card') => {
    setSelectedPaymentMethod(method);

    // For delivery orders or card payment, process immediately
    if (orderType === 'delivery' || method === 'card') {
      handleSimplePayment(method);
    } else {
      // For pickup/in-store with cash, show cash input
      setCurrentStep('cash_input');
    }
  };

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
        driverId: undefined,
        cashReceived: method === 'cash' ? (cashAmount || orderTotal) : undefined,
        change: method === 'cash' ? (changeAmount > 0 ? changeAmount : 0) : undefined
      });

      try {
        ActivityTracker.trackPaymentCompleted(orderTotal, method, txId, undefined);
      } catch { }

      toast.success(t(`modals.payment.${method}Success`));
      onClose();
    } catch (error) {
      toast.error(t('modals.payment.paymentFailed'));
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // Handle cash payment completion
  const handleCashPaymentComplete = () => {
    if (!hasEnoughCash) {
      toast.error(t('modals.payment.insufficientCash', 'Insufficient cash received'));
      return;
    }
    handleSimplePayment('cash');
  };

  const handleSkipMinimumWarning = () => {
    setCurrentStep('payment_selection');
  };

  const resetModal = () => {
    setCurrentStep(isBelowMinimum ? 'minimum_warning' : 'payment_selection');
    setIsProcessingPayment(false);
    setCashReceived('');
    setSelectedPaymentMethod(null);
  };

  const handleBackToPaymentSelection = () => {
    setCurrentStep('payment_selection');
    setCashReceived('');
    setSelectedPaymentMethod(null);
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
      <div>
        {/* Order Total with Discount Breakdown */}
        <div className="text-center mb-8">
          {discountAmount > 0 && (
            <div className="mb-4 space-y-2 p-4 rounded-xl bg-white/5 border border-white/10">
              <div className="flex justify-between text-sm">
                <span className="liquid-glass-modal-text-muted">
                  {t('modals.payment.originalTotal')}
                </span>
                <span className="liquid-glass-modal-text font-medium">
                  €{originalTotal.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-green-500 dark:text-green-400 font-medium">
                  {t('modals.payment.discount')}
                </span>
                <span className="text-green-500 dark:text-green-400 font-medium">
                  -€{discountAmount.toFixed(2)}
                </span>
              </div>
              <div className="border-t border-white/10 pt-2 mt-2"></div>
            </div>
          )}
          <p className="text-sm liquid-glass-modal-text-muted mb-2">
            {discountAmount > 0 ? t('modals.payment.finalAmount') : t('modals.payment.totalAmount')}
          </p>
          <p className="text-4xl font-bold text-emerald-500 dark:text-emerald-400 tracking-tight">
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
                className="liquid-glass-modal-button flex-1 font-medium bg-gray-500/20 hover:bg-gray-500/30 liquid-glass-modal-text"
              >
                {t('modals.payment.cancel')}
              </button>
              <button
                onClick={handleSkipMinimumWarning}
                className="liquid-glass-modal-button flex-1 font-medium bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border-orange-500/30"
              >
                {t('modals.payment.skip', 'Skip')}
              </button>
            </div>
          </div>
        )}

        {currentStep === 'payment_selection' && (
          <div className="relative">
            {!hasAnyPaymentMethod ? (
              <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 w-full">
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
            ) : (
              <div className="grid grid-cols-2 gap-6">
                {/* Cash Option */}
                <button
                  onClick={() => canUseCash && handlePaymentMethodSelect('cash')}
                  disabled={!canUseCash || isProcessingPayment}
                  className={`group relative flex flex-col items-center justify-center p-10 rounded-2xl border-2 transition-all duration-300 overflow-hidden
                    ${!canUseCash || isProcessingPayment
                      ? 'border-gray-400/20 bg-gray-500/5 opacity-50 cursor-not-allowed'
                      : 'border-green-400/30 bg-gradient-to-br from-green-500/10 to-green-600/5 hover:from-green-500/20 hover:to-green-600/10 hover:border-green-400/50 hover:scale-105 hover:shadow-xl hover:shadow-green-500/20 active:scale-100'
                    }`}
                >
                  <Banknote
                    className={`w-20 h-20 mb-3 transition-all duration-300 group-hover:scale-110
                      ${!canUseCash || isProcessingPayment ? 'text-gray-400' : 'text-green-400 group-hover:text-green-300'}`}
                    strokeWidth={1.5}
                  />

                  <span className={`text-2xl font-bold tracking-wide uppercase transition-colors duration-300
                    ${!canUseCash || isProcessingPayment ? 'text-gray-400' : 'text-green-400 group-hover:text-green-300'}`}
                  >
                    {t('modals.payment.cashSimple', 'CASH')}
                  </span>

                  {isMobileWaiter && !canUseCash && (
                    <p className="text-xs text-amber-400 mt-2 text-center">
                      {t('terminal.messages.cashDrawerMainOnly', 'Cash handled by Main POS')}
                    </p>
                  )}
                </button>

                {/* Card Option */}
                <button
                  onClick={() => canUseCard && handlePaymentMethodSelect('card')}
                  disabled={!canUseCard || isProcessingPayment}
                  className={`group relative flex flex-col items-center justify-center p-10 rounded-2xl border-2 transition-all duration-300 overflow-hidden
                    ${!canUseCard || isProcessingPayment
                      ? 'border-gray-400/20 bg-gray-500/5 opacity-50 cursor-not-allowed'
                      : 'border-blue-400/30 bg-gradient-to-br from-blue-500/10 to-blue-600/5 hover:from-blue-500/20 hover:to-blue-600/10 hover:border-blue-400/50 hover:scale-105 hover:shadow-xl hover:shadow-blue-500/20 active:scale-100'
                    }`}
                >
                  <CreditCard
                    className={`w-20 h-20 mb-3 transition-all duration-300 group-hover:scale-110
                      ${!canUseCard || isProcessingPayment ? 'text-gray-400' : 'text-blue-400 group-hover:text-blue-300'}`}
                    strokeWidth={1.5}
                  />

                  <span className={`text-2xl font-bold tracking-wide uppercase transition-colors duration-300
                    ${!canUseCard || isProcessingPayment ? 'text-gray-400' : 'text-blue-400 group-hover:text-blue-300'}`}
                  >
                    {t('modals.payment.cardSimple', 'CARD')}
                  </span>

                  {!canUseCard && (
                    <p className="text-xs text-amber-400 mt-2 text-center">
                      {t('terminal.messages.featureDisabled', 'Feature disabled for this terminal')}
                    </p>
                  )}
                </button>
              </div>
            )}

            {/* Processing indicator */}
            {isProcessingPayment && (
              <div className="mt-4 text-center">
                <p className="text-sm liquid-glass-modal-text-muted animate-pulse">
                  {t('modals.payment.processing')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step: Cash Input (only for pickup/in-store) */}
        {currentStep === 'cash_input' && (
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-sm liquid-glass-modal-text-muted mb-2">
                {t('modals.payment.enterCashReceived', 'Cash Received')}
              </p>
              <input
                type="number"
                inputMode="decimal"
                value={cashReceived}
                onChange={(e) => setCashReceived(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full text-center text-3xl font-bold p-4 rounded-xl bg-white/10 border-2 border-white/20 focus:border-green-400/50 focus:outline-none liquid-glass-modal-text transition-colors"
                step="0.01"
                min="0"
              />
            </div>

            {cashReceived && (
              <div className={`p-4 rounded-xl border-2 transition-colors ${
                hasEnoughCash
                  ? 'bg-green-500/10 border-green-400/30'
                  : 'bg-red-500/10 border-red-400/30'
              }`}>
                <div className="flex justify-between items-center mb-2">
                  <span className="liquid-glass-modal-text-muted">
                    {t('modals.payment.totalAmount')}
                  </span>
                  <span className="font-bold liquid-glass-modal-text">
                    €{orderTotal.toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between items-center mb-2">
                  <span className="liquid-glass-modal-text-muted">
                    {t('modals.payment.cashReceived', 'Cash Received')}
                  </span>
                  <span className="font-bold liquid-glass-modal-text">
                    €{cashAmount.toFixed(2)}
                  </span>
                </div>
                <div className="border-t border-white/10 pt-2 mt-2"></div>
                <div className="flex justify-between items-center">
                  <span className={`font-semibold ${
                    hasEnoughCash ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {t('modals.payment.change', 'Change')}
                  </span>
                  <span className={`text-2xl font-bold ${
                    hasEnoughCash ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {hasEnoughCash ? `€${changeAmount.toFixed(2)}` : t('modals.payment.insufficient', 'Insufficient')}
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleBackToPaymentSelection}
                disabled={isProcessingPayment}
                className="liquid-glass-modal-button flex-1 font-medium bg-gray-500/20 hover:bg-gray-500/30 liquid-glass-modal-text"
              >
                {t('common.actions.back', 'Back')}
              </button>
              <button
                onClick={handleCashPaymentComplete}
                disabled={!hasEnoughCash || isProcessingPayment}
                className={`liquid-glass-modal-button flex-1 font-medium ${
                  hasEnoughCash && !isProcessingPayment
                    ? 'bg-green-600/20 hover:bg-green-600/30 text-green-400 border-green-500/30'
                    : 'bg-gray-500/20 text-gray-400 cursor-not-allowed opacity-50'
                }`}
              >
                {isProcessingPayment ? t('modals.payment.processing') : t('modals.payment.completeCash', 'Complete')}
              </button>
            </div>
          </div>
        )}
      </div>
    </LiquidGlassModal >
  );
};