import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Clock3,
  Copy,
  Monitor,
  RefreshCw,
  ScreenShare,
  Tv,
  Wifi,
  X,
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { environment } from '../../config/environment';
import {
  getBridge,
  offEvent,
  onEvent,
  type ExternalDisplayCapabilities,
  type ExternalDisplayInfo,
} from '../../lib';
import { useOrderStore } from '../hooks/useOrderStore';
import { formatCompactOrderNumberForDisplay, getVisibleOrderNumber } from '../utils/orderNumberUtils';

type DisplayStatus = 'pending' | 'preparing' | 'ready';

interface DisplayRow {
  order_id: string;
  client_order_id?: string | null;
  order_number?: string | null;
  order_type?: string | null;
  table_number?: string | null;
  status: string;
  created_at?: string | null;
  updated_at?: string | null;
}

interface CustomerDisplayApiStatus {
  configured?: boolean;
  enabled?: boolean;
  paired?: boolean;
  pairing_supported?: boolean;
  pairing_session_id?: string | null;
  error?: string | null;
}

const DISPLAY_STATUSES = new Set<DisplayStatus>(['pending', 'preparing', 'ready']);
const CUSTOMER_DISPLAY_CONTENT_TYPE = 'customer_display';

function isDisplayStatus(status: string): status is DisplayStatus {
  return DISPLAY_STATUSES.has(status as DisplayStatus);
}

function readSearchParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function isExternalDisplayWindow(): boolean {
  return readSearchParam('externalDisplay') === CUSTOMER_DISPLAY_CONTENT_TYPE;
}

const normalizeDisplayText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const getDisplayOrderLookupKeys = (record: Record<string, unknown> | null | undefined): string[] => {
  if (!record) return [];
  return [
    'id',
    'supabase_id',
    'supabaseId',
    'order_id',
    'client_order_id',
    'clientOrderId',
    'client_request_id',
    'clientRequestId',
    'display_order_number',
    'displayOrderNumber',
    'order_number',
    'orderNumber',
  ]
    .map((key) => normalizeDisplayText(record[key]))
    .filter(Boolean);
};

function getOrderIdentifier(order: DisplayRow, localOrder?: Record<string, unknown> | null): string {
  const localOrderNumber = getVisibleOrderNumber({
    display_order_number: normalizeDisplayText(localOrder?.display_order_number),
    displayOrderNumber: normalizeDisplayText(localOrder?.displayOrderNumber),
    order_number: normalizeDisplayText(localOrder?.order_number),
    orderNumber: normalizeDisplayText(localOrder?.orderNumber),
  });
  if (localOrderNumber) return formatCompactOrderNumberForDisplay(localOrderNumber);

  const orderNumber = typeof order.order_number === 'string' ? order.order_number.trim() : '';
  if (orderNumber) return formatCompactOrderNumberForDisplay(orderNumber);
  return order.order_id.slice(0, 8);
}

function getOrderUpdatedAtMs(order: DisplayRow): number {
  const rawTimestamp = order.updated_at || order.created_at;
  if (!rawTimestamp) return 0;
  const parsed = new Date(rawTimestamp).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(status: string): DisplayStatus | null {
  const normalized = status.toLowerCase();
  if (normalized === 'ready' || normalized === 'completed') return 'ready';
  if (normalized === 'preparing' || normalized === 'in_progress') return 'preparing';
  if (normalized === 'pending' || normalized === 'confirmed' || normalized === 'received') {
    return 'pending';
  }
  return null;
}

function isCustomerDisplayActive(capabilities: ExternalDisplayCapabilities | null): boolean {
  return Boolean(
    capabilities?.activePresentations?.some(
      (presentation) => presentation.contentType === CUSTOMER_DISPLAY_CONTENT_TYPE
    )
  );
}

const CustomerDisplayPage: React.FC = () => {
  const bridge = getBridge();
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const localOrders = useOrderStore((state) => state.orders);
  const loadLocalOrders = useOrderStore((state) => state.loadOrders);
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [displayStatus, setDisplayStatus] = useState<CustomerDisplayApiStatus | null>(null);
  const [capabilities, setCapabilities] = useState<ExternalDisplayCapabilities | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDisplayBusy, setIsDisplayBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDark = resolvedTheme === 'dark';
  const externalWindow = isExternalDisplayWindow();
  const localOrderLookup = useMemo(() => {
    const lookup = new Map<string, Record<string, unknown>>();
    localOrders.forEach((order) => {
      const record = order as unknown as Record<string, unknown>;
      getDisplayOrderLookupKeys(record).forEach((key) => {
        lookup.set(key, record);
      });
    });
    return lookup;
  }, [localOrders]);

  const findLocalOrderForDisplayRow = useCallback(
    (order: DisplayRow): Record<string, unknown> | null => {
      return (
        localOrderLookup.get(normalizeDisplayText(order.order_id)) ||
        localOrderLookup.get(normalizeDisplayText(order.client_order_id)) ||
        localOrderLookup.get(normalizeDisplayText(order.order_number)) ||
        null
      );
    },
    [localOrderLookup]
  );

  const fetchCapabilities = useCallback(async () => {
    if (externalWindow) return;
    try {
      const result = await bridge.externalDisplay.getCapabilities();
      setCapabilities(result);
    } catch (err) {
      setCapabilities({
        success: false,
        supported: false,
        displays: [],
        error: err instanceof Error ? err.message : 'Failed to inspect monitors',
      });
    }
  }, [bridge, externalWindow]);

  const fetchRows = useCallback(
    async (showLoading = false) => {
      if (showLoading) {
        setIsLoading(true);
      }
      try {
        const result = await bridge.adminApi.fetchFromAdmin('/api/pos/customer-display?limit=200');
        if (result?.success && result?.data?.success && Array.isArray(result.data.rows)) {
          setRows(result.data.rows as DisplayRow[]);
          setDisplayStatus({
            configured: Boolean(result.data.configured),
            enabled: Boolean(result.data.enabled),
            paired: Boolean(result.data.paired),
            pairing_supported: Boolean(result.data.pairing_supported),
            pairing_session_id:
              typeof result.data.pairing_session_id === 'string'
                ? result.data.pairing_session_id
                : null,
            error:
              typeof result.data.settings_error === 'string'
                ? result.data.settings_error
                : null,
          });
          setError(null);
          return;
        }
        throw new Error(result?.data?.error || result?.error || 'Failed to fetch customer display');
      } catch (err) {
        console.error('Customer display fetch failed', err);
        setError(
          err instanceof Error
            ? err.message
            : t('customerDisplay.errors.fetchRowsFailed', 'Failed to load customer display orders')
        );
        if (showLoading) {
          setRows([]);
        }
      } finally {
        if (showLoading) {
          setIsLoading(false);
        }
      }
    },
    [bridge, t]
  );

  useEffect(() => {
    void fetchRows(true);
    void fetchCapabilities();
    void loadLocalOrders().catch(() => {});
  }, [fetchCapabilities, fetchRows, loadLocalOrders]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (timeout) return;
      timeout = setTimeout(() => {
        timeout = null;
        void fetchRows(false);
      }, 150);
    };

    onEvent('order-status-updated', scheduleRefresh);
    onEvent('order-created', scheduleRefresh);
    onEvent('sync:complete', scheduleRefresh);

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      offEvent('order-status-updated', scheduleRefresh);
      offEvent('order-created', scheduleRefresh);
      offEvent('sync:complete', scheduleRefresh);
    };
  }, [fetchRows]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchRows(false);
    }, externalWindow ? 1000 : 2000);
    return () => clearInterval(interval);
  }, [externalWindow, fetchRows]);

  const displayOrders = useMemo(() => {
    return rows
      .map((order) => {
        const status = normalizeStatus(order.status);
        return status ? { ...order, status } : null;
      })
      .filter((order): order is DisplayRow & { status: DisplayStatus } => {
        return Boolean(order && isDisplayStatus(order.status));
      })
      .sort((a, b) => getOrderUpdatedAtMs(b) - getOrderUpdatedAtMs(a));
  }, [rows]);

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
          border: 'border-emerald-400/40',
          bg: 'bg-emerald-500/10',
          Icon: CheckCircle2,
        };
      }
      if (status === 'preparing') {
        return {
          label: t('customerDisplay.phases.preparing', 'Preparing'),
          sentence: t('customerDisplay.sentences.preparing', 'preparing'),
          detail: t('customerDisplay.descriptions.preparing', 'Kitchen is working'),
          color: 'text-amber-400',
          border: 'border-amber-400/40',
          bg: 'bg-amber-500/10',
          Icon: Clock3,
        };
      }
      return {
        label: t('customerDisplay.phases.received', 'Received'),
        sentence: t('customerDisplay.sentences.received', 'received'),
        detail: t('customerDisplay.descriptions.received', 'Order received'),
        color: 'text-sky-400',
        border: 'border-sky-400/40',
        bg: 'bg-sky-500/10',
        Icon: Clock3,
      };
    },
    [t]
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([fetchRows(false), fetchCapabilities()]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const openExternalDisplay = async (display?: ExternalDisplayInfo) => {
    setIsDisplayBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await bridge.externalDisplay.open({
        contentType: CUSTOMER_DISPLAY_CONTENT_TYPE,
        displayIndex: display?.index,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to open external customer display');
      }
      setNotice(
        t(
          'customerDisplay.notices.externalRunning',
          'Customer display is running on the selected monitor or TV.'
        )
      );
      await fetchCapabilities();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              'customerDisplay.errors.startExternalFailed',
              'Failed to open external customer display'
            )
      );
    } finally {
      setIsDisplayBusy(false);
    }
  };

  const closeExternalDisplay = async () => {
    setIsDisplayBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await bridge.externalDisplay.close({ contentType: CUSTOMER_DISPLAY_CONTENT_TYPE });
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to close external customer display');
      }
      setNotice(t('customerDisplay.notices.externalStopped', 'External customer display stopped.'));
      await fetchCapabilities();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              'customerDisplay.errors.stopExternalFailed',
              'Failed to stop external customer display'
            )
      );
    } finally {
      setIsDisplayBusy(false);
    }
  };

  const copyTvDisplayLink = async () => {
    setNotice(null);
    setError(null);
    try {
      const result = await bridge.adminApi.fetchFromAdmin('/api/pos/customer-display', {
        method: 'POST',
        body: JSON.stringify({ action: 'pair' }),
      });
      const sessionId =
        result?.data?.pairing_session_id ||
        result?.data?.pairingSessionId ||
        displayStatus?.pairing_session_id;
      if (!result?.success || !result?.data?.success || !sessionId) {
        throw new Error(result?.data?.error || result?.error || 'Failed to create TV link');
      }
      const language = (i18n.language || 'en').split('-')[0];
      const theme = isDark ? 'dark' : 'light';
      const url = `${environment.ADMIN_DASHBOARD_URL.replace(/\/+$/, '')}/display/customer/${encodeURIComponent(
        sessionId
      )}?lang=${encodeURIComponent(language)}&theme=${encodeURIComponent(theme)}`;
      await bridge.clipboard.writeText(url);
      setDisplayStatus((prev) => ({
        ...(prev || {}),
        paired: true,
        pairing_session_id: sessionId,
      }));
      setNotice(
        t(
          'customerDisplay.notices.tvLinkCopied',
          'TV link copied. Open it in a Smart TV browser or wireless receiver.'
        )
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('customerDisplay.errors.createTvLinkFailed', 'Failed to create TV display link')
      );
    }
  };

  const activeExternalDisplay = isCustomerDisplayActive(capabilities);
  const monitors = capabilities?.displays || [];
  const availableMonitors = monitors.length > 1 ? monitors : monitors.slice(0, 1);

  return (
    <div
      className={`h-full min-h-0 overflow-hidden ${
        isDark ? 'bg-black text-white' : 'bg-slate-50 text-slate-950'
      } ${externalWindow ? 'p-0' : 'p-4 md:p-6'}`}
    >
      <div
        className={`mx-auto flex h-full min-h-0 flex-col gap-4 overflow-hidden ${
          externalWindow ? 'max-w-none p-8' : 'max-w-7xl'
        }`}
      >
        <section
          className={`rounded-2xl border ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'px-8 py-6' : 'px-5 py-4'}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className={`grid h-12 w-12 place-items-center rounded-xl border ${
                  isDark ? 'border-zinc-700 bg-zinc-900' : 'border-slate-200 bg-slate-100'
                }`}
              >
                <Tv className="h-6 w-6 text-cyan-400" />
              </div>
              <div>
                <h1 className={externalWindow ? 'text-4xl font-black' : 'text-2xl font-black'}>
                  {t('customerDisplay.title', 'Customer Display')}
                </h1>
                <p className={isDark ? 'text-zinc-400' : 'text-slate-600'}>
                  {t(
                    'customerDisplay.subtitle',
                    'Live order phases for customer-facing screens'
                  )}
                </p>
              </div>
            </div>

            {!externalWindow && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyTvDisplayLink()}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                    isDark
                      ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
                      : 'border-slate-200 bg-white hover:bg-slate-100'
                  }`}
                >
                  <Copy className="h-4 w-4" />
                  {t('customerDisplay.actions.copyTvLink', 'Copy TV Link')}
                </button>
                {activeExternalDisplay ? (
                  <button
                    type="button"
                    onClick={() => void closeExternalDisplay()}
                    disabled={isDisplayBusy}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/20 disabled:opacity-60"
                  >
                    <X className="h-4 w-4" />
                    {t('customerDisplay.actions.stopExternal', 'Stop External')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void openExternalDisplay(availableMonitors[1] || availableMonitors[0])}
                    disabled={isDisplayBusy}
                    className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-60"
                  >
                    <ScreenShare className="h-4 w-4" />
                    {t('customerDisplay.actions.externalDisplay', 'External Display')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border transition ${
                    isDark
                      ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
                      : 'border-slate-200 bg-white hover:bg-slate-100'
                  } disabled:opacity-60`}
                  aria-label={t('common.refresh', 'Refresh')}
                >
                  <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}
          </div>

          {!externalWindow && (
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {(['pending', 'preparing', 'ready'] as DisplayStatus[]).map((phase) => {
                const meta = getPhase(phase);
                const Icon = meta.Icon;
                return (
                  <div
                    key={phase}
                    className={`rounded-xl border px-4 py-3 ${meta.border} ${meta.bg}`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`h-5 w-5 ${meta.color}`} />
                      <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-2 text-2xl font-black">{phaseCounts[phase]}</div>
                  </div>
                );
              })}
              <div
                className={`rounded-xl border px-4 py-3 ${
                  isDark ? 'border-zinc-800 bg-black' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Wifi className="h-5 w-5 text-emerald-400" />
                  <span className={isDark ? 'text-zinc-300' : 'text-slate-700'}>
                    {t('customerDisplay.displaySession', 'Display session')}
                  </span>
                </div>
                <div className="mt-2 text-sm font-semibold">
                  {displayStatus?.paired || activeExternalDisplay
                    ? t('customerDisplay.status.connected', 'Connected')
                    : displayStatus?.enabled
                      ? t('customerDisplay.status.enabled', 'Enabled')
                      : t('customerDisplay.status.ready', 'Ready')}
                </div>
              </div>
            </div>
          )}
        </section>

        {!externalWindow && monitors.length > 0 && (
          <section
            className={`rounded-2xl border p-4 ${
              isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="mb-3 flex items-center gap-2">
              <Monitor className="h-5 w-5 text-cyan-400" />
              <h2 className="font-bold">
                {t('customerDisplay.external.monitors', 'Connected monitors and TVs')}
              </h2>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              {monitors.map((monitor) => (
                <button
                  key={monitor.index}
                  type="button"
                  onClick={() => void openExternalDisplay(monitor)}
                  disabled={isDisplayBusy}
                  className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition ${
                    isDark
                      ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
                      : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                  } disabled:opacity-60`}
                >
                  <div className="font-semibold">{monitor.name}</div>
                  <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-slate-600'}>
                    {monitor.size?.width || 0} x {monitor.size?.height || 0}
                  </div>
                </button>
              ))}
            </div>
            <p className={`mt-3 text-sm ${isDark ? 'text-zinc-400' : 'text-slate-600'}`}>
              {t(
                'customerDisplay.external.help',
                'Cable displays and OS-level wireless displays appear here. For Smart TVs without monitor mode, copy the TV link.'
              )}
            </p>
          </section>
        )}

        {(notice || error || displayStatus?.error || capabilities?.error) && !externalWindow && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm font-medium ${
              error || displayStatus?.error || capabilities?.error
                ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {error || displayStatus?.error || capabilities?.error || notice}
          </div>
        )}

        <section
          className={`min-h-0 flex-1 overflow-y-auto rounded-2xl border p-4 scrollbar-hide ${
            isDark ? 'border-zinc-800 bg-zinc-950' : 'border-slate-200 bg-white'
          } ${externalWindow ? 'p-8' : ''}`}
        >
          {!isLoading && displayOrders.length === 0 ? (
            <div className="flex h-full min-h-[360px] items-center justify-center rounded-xl border border-dashed border-white/15 px-4 text-center text-lg">
              {t(
                'customerDisplay.empty',
                'No active customer-display orders right now.'
              )}
            </div>
          ) : isLoading ? (
            <div className="flex h-full min-h-[360px] items-center justify-center rounded-xl border border-dashed border-white/15 px-4 text-center text-lg">
              {t('customerDisplay.loading', 'Loading customer display...')}
            </div>
          ) : (
            <div
              className={
                externalWindow
                  ? 'grid grid-cols-1 gap-5 xl:grid-cols-2'
                  : 'grid grid-cols-1 gap-3 lg:grid-cols-2'
              }
            >
              {displayOrders.map((order) => {
                const phase = getPhase(order.status);
                const identifier = getOrderIdentifier(order, findLocalOrderForDisplayRow(order));
                const Icon = phase.Icon;

                return (
                  <div
                    key={order.order_id}
                    className={`rounded-2xl border px-5 py-4 ${phase.border} ${
                      isDark ? 'bg-black' : 'bg-slate-50'
                    } ${externalWindow ? 'px-7 py-6' : ''}`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div
                          className={`break-words font-black leading-tight ${
                            externalWindow ? 'text-4xl' : 'text-2xl'
                          }`}
                        >
                          {t('customerDisplay.orderLine', 'Order ({{number}}) is {{status}}', {
                            number: identifier,
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
                        className={`grid shrink-0 place-items-center rounded-full ${phase.bg} ${
                          externalWindow ? 'h-16 w-16' : 'h-12 w-12'
                        }`}
                      >
                        <Icon className={`${phase.color} ${externalWindow ? 'h-9 w-9' : 'h-6 w-6'}`} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default CustomerDisplayPage;
