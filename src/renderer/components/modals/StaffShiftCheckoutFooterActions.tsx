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
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-300/80 bg-white px-5 py-4 text-base font-bold text-slate-700 shadow-[0_4px_16px_0_rgba(15,23,42,0.08)] transition-all duration-300 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none dark:border-white/15 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08] sm:w-auto sm:min-w-[180px]"
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
        className="flex w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-red-600 to-red-700 px-6 py-4 text-lg font-bold text-white shadow-[0_4px_16px_0_rgba(239,68,68,0.5)] transition-all duration-300 hover:from-red-700 hover:to-red-800 hover:shadow-[0_6px_24px_0_rgba(239,68,68,0.7)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:w-auto sm:min-w-[220px]"
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
