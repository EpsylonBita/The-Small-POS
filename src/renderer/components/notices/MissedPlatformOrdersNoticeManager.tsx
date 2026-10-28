/**
 * The notice for platform (efood/Wolt) orders the server declined while this
 * till was offline. Android parity with `MissedPlatformOrdersNotice.ts`
 * (offline week Ω6, 22/10/2026): how many, and about how much money.
 *
 * Mounted once by App.tsx beside the other notice managers while a user is
 * logged in. `useMissedPlatformOrdersNotice` decides when to look; this
 * renders one toast per check that found declines. Nothing here changes an
 * order: the declines already happened on the platform's side.
 */
import React from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import {
  useMissedPlatformOrdersNotice,
  type MissedPlatformOrdersResult,
} from '../../hooks/useMissedPlatformOrdersNotice';
import { formatCurrency } from '../../utils/format';

/** Same as Android's toast. */
export const MISSED_PLATFORM_ORDERS_NOTICE_MS = 12_000;

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface MissedPlatformOrdersNoticeText {
  title: string;
  body: string;
}

export function missedPlatformOrdersNoticeText(
  result: MissedPlatformOrdersResult,
  t: Translate,
): MissedPlatformOrdersNoticeText {
  return {
    title: t('missedPlatformOrders.title', {
      count: result.count,
      defaultValue_one: '{{count}} platform order was declined while the till was offline',
      defaultValue_other: '{{count}} platform orders were declined while the till was offline',
    }),
    body: t('missedPlatformOrders.body', {
      // The store's currency (formatCurrency default): never an assumed €.
      total: formatCurrency(result.total),
      defaultValue:
        '≈{{total}} in orders declined automatically (till offline). Keep the till connected to receive platform orders.',
    }),
  };
}

export function showMissedPlatformOrdersNotice(result: MissedPlatformOrdersResult, t: Translate): void {
  const text = missedPlatformOrdersNoticeText(result, t);
  toast.custom(
    (instance) => (
      <div
        data-testid="missed-platform-orders-notice"
        role="alert"
        aria-live="assertive"
        className={`pointer-events-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-red-200 bg-white p-4 text-sm text-gray-900 shadow-2xl transition-opacity dark:border-red-400/30 dark:bg-gray-900 dark:text-white ${instance.visible ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold">{text.title}</p>
            <p className="text-gray-700 dark:text-gray-200">{text.body}</p>
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                data-testid="missed-platform-orders-notice-dismiss"
                className="min-h-touch rounded-full border border-gray-300 px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-400 dark:border-white/20 dark:text-gray-100 dark:hover:bg-white/10"
                onClick={() => toast.dismiss(instance.id)}
              >
                {t('missedPlatformOrders.dismiss', { defaultValue: 'OK' })}
              </button>
            </div>
          </div>
        </div>
      </div>
    ),
    { id: 'missed-platform-orders', duration: MISSED_PLATFORM_ORDERS_NOTICE_MS },
  );
}

export function MissedPlatformOrdersNoticeManager({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  useMissedPlatformOrdersNotice(enabled, (result) =>
    showMissedPlatformOrdersNotice(result, t as unknown as Translate),
  );
  return null;
}

export default MissedPlatformOrdersNoticeManager;
