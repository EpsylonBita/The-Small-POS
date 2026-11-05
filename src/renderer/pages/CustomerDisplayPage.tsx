import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  Clock3,
  Monitor,
  RefreshCw,
  ScreenShare,
  X,
} from 'lucide-react';
import { getBridge } from '../../lib';
import { isExternalDisplayFree } from '../services/ExternalDisplayOwnership';
import { pageMotionContainer, pageMotionItem } from '../components/ui/page-motion';
import type { CustomerTwintQr } from '../services/CustomerDisplayQrOverlay';
import {
  CustomerDisplayContext,
  isExternalDisplayWindow,
  type DisplayModel,
  type DisplaySnapshot,
  type DisplayStatus,
} from './CustomerDisplayOwner';

function LocalCustomerDisplayPage() {
  const context = useContext(CustomerDisplayContext);
  if (!context) throw new Error('Customer display requires its persistent owner');
  useEffect(() => context.attach(), [context.attach]);
  return <CustomerDisplayView model={context.model} externalWindow={false} />;
}
function ExternalCustomerDisplayPage() {
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const { i18n } = useTranslation();
  useEffect(() => {
    let disposed = false; let reading = false;
    const read = async () => {
      if (reading) return; reading = true;
      try { const value = await getBridge().invoke('customer-display-snapshot'); if (!disposed) setSnapshot(value || null); }
      catch { if (!disposed) setSnapshot(null); }
      finally { reading = false; }
    };
    void read(); const timer = setInterval(() => void read(), 500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (snapshot?.locale && snapshot.locale !== i18n.language) void i18n.changeLanguage(snapshot.locale); }, [snapshot?.locale, i18n]);
  if (!snapshot) return <div className="h-screen bg-black" />;
  if (snapshot.twintQr) return <CustomerTwintQrView qr={snapshot.twintQr} />;
  return <CustomerDisplayView externalWindow model={{ ...snapshot, capabilities: null, isRefreshing: false, isDisplayBusy: false, notice: null, error: null, loadError: null, activeExternalDisplay: true, externalChoices: [], runningDisplayId: null, canOpenExternal: false, openExternalDisplay: async () => {}, closeExternalDisplay: async () => {} } as unknown as DisplayModel} />;
}
function CustomerTwintQrView({ qr }: { qr: CustomerTwintQr }) {
  const { t } = useTranslation();
  return <div className="h-screen bg-white text-black flex flex-col items-center justify-center gap-6 p-8">
    <strong className="text-5xl">TWINT — CHF {qr.amount.toFixed(2)}</strong>
    <img src={qr.qrImageData} alt={t('twintPayment.qrAlt', 'Official shop TWINT QR')} className="max-h-[60vh] max-w-full" />
    <p className="text-2xl">{t('twintPayment.exactAmount', 'Scan the shop QR and enter this exact amount in TWINT.')}</p>
  </div>;
}
function CustomerDisplayPage() { return isExternalDisplayWindow() ? <ExternalCustomerDisplayPage /> : <LocalCustomerDisplayPage />; }
function CustomerDisplayView({ model, externalWindow }: { model: DisplayModel; externalWindow: boolean }) {
  const { t } = useTranslation();
  const { displayOrders, capabilities, isRefreshing, isLoading, isDisplayBusy, notice, error, loadError, isDark, activeExternalDisplay, externalChoices, runningDisplayId, canOpenExternal, handleRefresh, openExternalDisplay, closeExternalDisplay } = model;
  const phaseCounts = useMemo(
    () =>
      displayOrders.reduce(
        (acc, order) => {
          acc[order.status] += 1;
          return acc;
        },
        { pending: 0, preparing: 0, ready: 0 } as Record<DisplayStatus, number>
      ),
    [displayOrders]
  );

  const getPhase = useCallback(
    (status: DisplayStatus) => {
      if (status === 'ready') {
        return {
          label: t('customerDisplay.phases.ready', 'Ready'),
          sentence: t('customerDisplay.sentences.ready', 'ready'),
          detail: t('customerDisplay.descriptions.ready', 'Ready for pickup'),
          color: 'text-emerald-400',
          border: 'border-(--pos-s-border)',
          Icon: CheckCircle2,
        };
      }
      if (status === 'preparing') {
        return {
          label: t('customerDisplay.phases.preparing', 'Preparing'),
          sentence: t('customerDisplay.sentences.preparing', 'preparing'),
          detail: t('customerDisplay.descriptions.preparing', 'Kitchen is working'),
          color: 'text-amber-400',
          border: 'border-(--pos-s-border)',
          Icon: Clock3,
        };
      }
      return {
        label: t('customerDisplay.phases.received', 'Received'),
        sentence: t('customerDisplay.sentences.received', 'received'),
        detail: t('customerDisplay.descriptions.received', 'Order received'),
        color: 'text-yellow-400',
        border: 'border-(--pos-s-border)',
        Icon: Clock3,
      };
    },
    [t]
  );

  const failure = error || loadError || capabilities?.error;

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={pageMotionContainer}
      className={`h-full min-h-0 overflow-hidden ${
        isDark ? 'text-white' : 'text-slate-950'
      } ${externalWindow ? 'p-0' : 'p-4 md:p-6'}`}
    >
      <motion.div
        variants={pageMotionContainer}
        className={`mx-auto flex h-full min-h-0 flex-col gap-4 overflow-hidden ${
          externalWindow ? 'max-w-none p-8' : 'max-w-7xl'
        }`}
      >
        <motion.section
          variants={pageMotionItem}
          className={`rounded-2xl border ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'px-8 py-6' : 'px-5 py-4'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1
                className={
                  externalWindow
                    ? 'truncate text-4xl font-black tracking-tight'
                    : 'truncate text-3xl font-bold tracking-tight'
                }
              >
                {t('customerDisplay.title', 'Customer Display')}
              </h1>
              <p className={`mt-1 truncate ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
                {t(
                  'customerDisplay.subtitle',
                  'Live order phases for customer-facing screens'
                )}
              </p>
            </div>

            {!externalWindow && (
              <div className="flex flex-wrap items-center gap-2">
                {activeExternalDisplay ? (
                  <button
                    type="button"
                    onClick={() => void closeExternalDisplay()}
                    disabled={isDisplayBusy}
                    className="pos-raised inline-flex items-center gap-2 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) px-3 py-2 text-sm font-semibold text-red-800 dark:text-red-200 transition-all active:scale-[0.98] active:bg-(--pos-s-surface-2) disabled:opacity-60 disabled:active:scale-100"
                  >
                    <X className="h-4 w-4" />
                    {t('customerDisplay.actions.stopExternal', 'Stop External')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void openExternalDisplay()}
                    disabled={isDisplayBusy || !canOpenExternal}
                    className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 ${
                      isDark
                        ? 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-200 active:bg-(--pos-s-surface-2)'
                        : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-amber-800 active:bg-(--pos-s-surface-2)'
                    }`}
                  >
                    <ScreenShare className="h-4 w-4" />
                    {t('customerDisplay.actions.externalDisplay', 'External Display')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                  aria-label={t('common.refresh', 'Refresh')}
                  className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-xs active:scale-95 ${
                    isDark
                      ? 'border border-white/80 bg-white text-black active:bg-zinc-200'
                      : 'border border-black bg-black text-white active:bg-zinc-800'
                  } ${isRefreshing ? 'opacity-60 cursor-not-allowed active:scale-100' : ''}`}
                >
                  <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}
          </div>

          {!externalWindow && (
            <motion.div variants={pageMotionContainer} className="mt-4 grid gap-3 md:grid-cols-4">
              {(['pending', 'preparing', 'ready'] as DisplayStatus[]).map((phase) => {
                const meta = getPhase(phase);
                const Icon = meta.Icon;
                return (
                  <motion.div
                    variants={pageMotionItem}
                    key={phase}
                    className={`rounded-xl border bg-transparent px-4 py-3 ${meta.border}`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${meta.color}`} />
                      <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-2 text-2xl font-black">{phaseCounts[phase]}</div>
                  </motion.div>
                );
              })}
              <motion.div
                variants={pageMotionItem}
                className={`rounded-xl border px-4 py-3 ${
                  isDark ? 'border-zinc-800 bg-transparent' : 'border-slate-200 bg-transparent'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Monitor className="h-5 w-5 text-emerald-400" />
                  <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                    {t('customerDisplay.actions.externalDisplay', 'External Display')}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold">
                  {activeExternalDisplay
                    ? t('customerDisplay.status.connected', 'Connected')
                    : t('customerDisplay.status.ready', 'Ready')}
                </div>
              </motion.div>
            </motion.div>
          )}
        </motion.section>

        {!externalWindow && (
          <motion.section
            variants={pageMotionItem}
            className={`rounded-2xl border p-4 ${
              isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="mb-3 flex items-center gap-2">
              <Monitor className="h-5 w-5 text-amber-400" />
              <h2 className="font-bold">
                {t('customerDisplay.external.monitors', 'Connected monitors and TVs')}
              </h2>
            </div>
            {externalChoices.length > 0 && (
              <motion.div variants={pageMotionContainer} className="pos-scroll-row gap-2">
                {externalChoices.map((display) => {
                  // Shows this content now; any other reservation (other content or a closing window) blocks it.
                  const running = display.id === runningDisplayId;
                  const free = isExternalDisplayFree(display);
                  return (
                    <motion.button
                      variants={pageMotionItem}
                      key={display.id}
                      type="button"
                      onClick={() => void openExternalDisplay(display)}
                      disabled={isDisplayBusy || !free}
                      className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition-all active:scale-[0.98] disabled:active:scale-100 ${
                        running
                          ? 'border-(--pos-s-border) bg-(--pos-s-surface-2)'
                          : `${
                              isDark
                                ? 'border-zinc-700 bg-zinc-900 active:bg-zinc-800'
                                : 'border-slate-200 bg-slate-50 active:bg-slate-100'
                            } disabled:opacity-60`
                      }`}
                    >
                      <div className="font-semibold">{display.name}</div>
                      <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-slate-600'}>
                        {display.size?.width || 0} x {display.size?.height || 0}
                      </div>
                      {running ? (
                        <div className="mt-1 text-xs font-semibold text-emerald-400">
                          {t('customerDisplay.external.running', 'Showing the customer display')}
                        </div>
                      ) : !free ? (
                        <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
                          {t('customerDisplay.external.inUse', 'In use')}
                        </div>
                      ) : null}
                    </motion.button>
                  );
                })}
              </motion.div>
            )}
            <p className={`${externalChoices.length > 0 ? 'mt-3 ' : ''}text-sm ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              {t(
                'customerDisplay.external.help',
                'Cable displays and OS-level wireless displays appear here. Select one to show the customer display.'
              )}
            </p>
          </motion.section>
        )}

        {(notice || failure) && !externalWindow && (
          <motion.div
            variants={pageMotionItem}
            className={`rounded-xl border px-4 py-3 text-sm font-medium ${
              failure
                ? 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-red-800 dark:text-red-200'
                : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-200'
            }`}
          >
            {failure || notice}
          </motion.div>
        )}

        <motion.section
          variants={pageMotionItem}
          className={`min-h-0 flex-1 overflow-y-auto rounded-2xl border p-4 scrollbar-hide ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'p-8' : ''}`}
        >
          {!isLoading && displayOrders.length === 0 ? (
            <motion.div
              variants={pageMotionItem}
              className={`flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed px-4 text-center text-lg ${
                isDark ? 'border-white/15' : 'border-slate-300'
              }`}
            >
              {t(
                'customerDisplay.empty',
                'No active customer-display orders right now.'
              )}
            </motion.div>
          ) : isLoading ? (
            <motion.div
              variants={pageMotionItem}
              className={`flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed px-4 text-center text-lg ${
                isDark ? 'border-white/15' : 'border-slate-300'
              }`}
            >
              {t('customerDisplay.loading', 'Loading customer display...')}
            </motion.div>
          ) : (
            <motion.div
              variants={pageMotionContainer}
              className={
                externalWindow
                  ? 'grid grid-cols-1 gap-5 xl:grid-cols-2'
                  : 'grid grid-cols-1 gap-3 lg:grid-cols-2'
              }
            >
              {displayOrders.map((order) => {
                const phase = getPhase(order.status);
                const Icon = phase.Icon;

                return (
                  <motion.div
                    variants={pageMotionItem}
                    key={order.order_id}
                    className={`rounded-2xl border px-5 py-4 ${phase.border} ${
                      isDark ? 'bg-black' : 'bg-slate-50'
                    } ${externalWindow ? 'px-7 py-6' : ''}`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div
                          className={`wrap-break-word font-black leading-tight ${
                            externalWindow ? 'text-4xl' : 'text-2xl'
                          }`}
                        >
                          {t('customerDisplay.orderLine', 'Order ({{number}}) is {{status}}', {
                            number: order.order_number,
                            status: phase.sentence,
                          })}
                        </div>
                        <div
                          className={`mt-2 ${
                            isDark ? 'text-zinc-400' : 'text-slate-600'
                          } ${externalWindow ? 'text-xl' : 'text-sm'}`}
                        >
                          {phase.detail}
                        </div>
                      </div>
                      <div
                        className={`grid shrink-0 place-items-center rounded-full bg-transparent ${
                          externalWindow ? 'h-16 w-16' : 'h-12 w-12'
                        }`}
                      >
                        <Icon className={`${phase.color} ${externalWindow ? 'h-9 w-9' : 'h-6 w-6'}`} />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </motion.section>
      </motion.div>
    </motion.div>
  );
};

export default CustomerDisplayPage;
