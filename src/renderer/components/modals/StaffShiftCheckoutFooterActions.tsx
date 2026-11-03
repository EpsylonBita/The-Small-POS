import React from 'react';
import { Check, Printer } from 'lucide-react';

interface StaffShiftCheckoutFooterActionsProps {
  onPrint: () => void;
  onCheckout: () => void;
  printLabel: string;
  checkoutLabel: string;
  isPrinting?: boolean;
  isPrintDisabled?: boolean;
  isCheckoutLoading?: boolean;
  isCheckoutDisabled?: boolean;
}

export function StaffShiftCheckoutFooterActions({
  onPrint,
  onCheckout,
  printLabel,
  checkoutLabel,
  isPrinting = false,
  isPrintDisabled = false,
  isCheckoutLoading = false,
  isCheckoutDisabled = false,
}: StaffShiftCheckoutFooterActionsProps) {
  return (
    <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
      <button
        type="button"
        onClick={onPrint}
        disabled={isPrintDisabled}
        data-testid="staff-checkout-print-button"
        className="pos-solid-btn pos-solid-btn--md w-full sm:w-auto sm:min-w-[180px]"
      >
        {isPrinting ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {printLabel}
          </>
        ) : (
          <>
            <Printer className="h-5 w-5" />
            {printLabel}
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onCheckout}
        disabled={isCheckoutDisabled}
        data-testid="staff-checkout-confirm-button"
        className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary w-full sm:w-auto sm:min-w-[220px]"
      >
        {isCheckoutLoading ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {checkoutLabel}
          </>
        ) : (
          <>
            <Check className="h-5 w-5" />
            {checkoutLabel}
          </>
        )}
      </button>
    </div>
  );
}
