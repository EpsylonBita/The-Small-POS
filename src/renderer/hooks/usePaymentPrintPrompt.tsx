import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Printer, ReceiptText } from 'lucide-react';

import { getBridge } from '../../lib';
import { LiquidGlassModal } from '../components/ui/pos-glass-components';
import { formatCurrency } from '../utils/format';

type Bridge = ReturnType<typeof getBridge>;

export interface PaymentPrintPromptContext {
  orderId?: string;
  orderNumber?: string | null;
  amount?: number | null;
}

interface PendingPaymentPrintPrompt {
  context: PaymentPrintPromptContext;
  resolve: (shouldPrint: boolean) => void;
}

export const PAYMENT_PRINT_PROMPT_CATEGORY = 'receipt';
export const PAYMENT_PRINT_PROMPT_KEY = 'ask_before_print';

export const parsePaymentPrintPromptSetting = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
};

export const isPaymentPrintPromptEnabled = async (bridge: Bridge = getBridge()): Promise<boolean> => {
  const rawValue = await bridge.settings
    .get({
      category: PAYMENT_PRINT_PROMPT_CATEGORY,
      key: PAYMENT_PRINT_PROMPT_KEY,
      defaultValue: false,
    })
    .catch(() => false);

  return parsePaymentPrintPromptSetting(rawValue);
};

export function usePaymentPrintPrompt() {
  const bridge = useMemo(() => getBridge(), []);
  const { t } = useTranslation();
  const [pendingPrompt, setPendingPrompt] = useState<PendingPaymentPrintPrompt | null>(null);

  const shouldAskPaymentPrint = useCallback(
    () => isPaymentPrintPromptEnabled(bridge),
    [bridge],
  );

  const askForPaymentPrint = useCallback(
    async (context: PaymentPrintPromptContext = {}): Promise<boolean> => {
      const enabled = await isPaymentPrintPromptEnabled(bridge);
      if (!enabled) return true;

      return new Promise<boolean>((resolve) => {
        setPendingPrompt({ context, resolve });
      });
    },
    [bridge],
  );

  const resolvePrompt = useCallback((shouldPrint: boolean) => {
    setPendingPrompt((current) => {
      current?.resolve(shouldPrint);
      return null;
    });
  }, []);

  const paymentPrintPromptModal = pendingPrompt ? (
    <LiquidGlassModal
      isOpen
      onClose={() => resolvePrompt(false)}
      title={t('paymentPrintPrompt.title', 'Print receipt?')}
      size="sm"
      closeOnBackdrop={false}
      closeOnEscape={false}
      contentClassName="!px-6 !py-5"
    >
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-yellow-400/35 bg-yellow-400/15 text-yellow-300">
            <Printer className="h-6 w-6" />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm leading-6 liquid-glass-modal-text-muted">
              {t(
                'paymentPrintPrompt.message',
                'Do you want to print the receipt for this payment?',
              )}
            </p>
            {(pendingPrompt.context.orderNumber || typeof pendingPrompt.context.amount === 'number') && (
              <div className="rounded-xl border liquid-glass-modal-border bg-white/5 px-3 py-2 text-sm">
                {pendingPrompt.context.orderNumber && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="liquid-glass-modal-text-muted">
                      {t('paymentPrintPrompt.order', 'Order')}
                    </span>
                    <span className="truncate font-semibold liquid-glass-modal-text">
                      {pendingPrompt.context.orderNumber}
                    </span>
                  </div>
                )}
                {typeof pendingPrompt.context.amount === 'number' && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="liquid-glass-modal-text-muted">
                      {t('paymentPrintPrompt.amount', 'Amount')}
                    </span>
                    <span className="font-semibold text-emerald-400">
                      {formatCurrency(pendingPrompt.context.amount)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => resolvePrompt(false)}
            className="rounded-xl border liquid-glass-modal-border bg-white/5 px-4 py-3 text-sm font-semibold liquid-glass-modal-text transition-colors active:bg-white/10"
          >
            {t('paymentPrintPrompt.skip', 'Do not print')}
          </button>
          <button
            type="button"
            onClick={() => resolvePrompt(true)}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-yellow-400 px-4 py-3 text-sm font-bold text-black transition-colors active:bg-yellow-300"
          >
            <ReceiptText className="h-4 w-4" />
            {t('paymentPrintPrompt.print', 'Print receipt')}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  ) : null;

  return {
    askForPaymentPrint,
    shouldAskPaymentPrint,
    paymentPrintPromptModal,
  };
}
