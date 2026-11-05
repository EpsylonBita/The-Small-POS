import React, { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BellRing,
  ChefHat,
  Clock,
  CheckCircle,
  AlertTriangle,
  HandPlatter,
  Timer,
  Utensils,
  Coffee,
  Flame,
  Snowflake,
  RefreshCw,
  Volume2,
  VolumeX,
  Play,
  Pause,
  LayoutGrid,
  List,
  Monitor,
  ScreenShare,
  X
} from 'lucide-react';
import { useTheme } from '../contexts/theme-context';
import { getBridge } from '../../lib';
import { isExternalDisplayFree, liveExternalPresentation } from '../services/ExternalDisplayOwnership';
import { formatCompactOrderNumberForDisplay } from '../utils/orderNumberUtils';
import {
  KITCHEN_DISPLAY_CONTENT_TYPE,
  KdsContext,
  isKitchenExternalDisplayWindow,
  type KdsModel,
  type KdsSnapshot,
  type KdsStation,
  type KitchenOrder,
  type KitchenStatus,
} from './KitchenDisplayOwner';

function LocalKitchenDisplayPage() {
  const context = useContext(KdsContext);
  if (!context) throw new Error('Kitchen display requires its persistent owner');
  useEffect(() => context.attach(), [context.attach]);
  return <KitchenDisplayView model={context.model} externalWindow={false} />;
}

function ExternalKitchenDisplayPage() {
  const [snapshot, setSnapshot] = useState<KdsSnapshot | null>(null);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await getBridge().invoke('kds-display-snapshot');
        if (!disposed) setSnapshot(next || null);
      } catch { if (!disposed) setSnapshot(null); }
      finally { reading = false; }
    };
    void read();
    // Reads only the Rust memory snapshot. No API, credentials, orders store or subscription.
    const timer = setInterval(() => void read(), 500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  if (!snapshot) return <div className="h-screen bg-black" />;
  const intent = (action: string, value?: unknown, status?: KitchenStatus) =>
    getBridge().invoke('kds-display-intent', { scope: snapshot.identityScope, session: snapshot.sessionId, action, value, status }).catch(() => {});
  const model = {
    ...snapshot,
    // The receiver never controls a screen: it holds no monitor list, display state or token.
    displayCapabilities: null, displayNotice: null, displayError: null, isDisplayBusy: false, externalDisplays: [],
    setStationFilter: (value: string) => { void intent('station', value); },
    setViewMode: (value: string) => { void intent('view', value); },
    setSoundEnabled: (value: boolean) => { void intent('sound', value); },
    setAutoRefresh: (value: boolean) => { void intent('auto', value); },
    refreshIdentity: () => intent('refresh'),
    fetchOrders: () => intent('refresh'),
    handleBumpOrder: (id: string, status?: KitchenStatus) =>
      intent('bump', id, status ?? snapshot.orders.find(order => order.id === id)?.status),
    openExternalDisplay: async () => {}, closeExternalDisplay: async () => {},
  } as KdsModel;
  return <KitchenDisplayView model={model} externalWindow />;
}

function KitchenDisplayView({ model, externalWindow }: { model: KdsModel; externalWindow: boolean }) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const { loading, stations, stationFilter, viewMode, soundEnabled, autoRefresh, error, stale, isLive, displayCapabilities, displayNotice, displayError, isDisplayBusy, isIdentityResolving, isIdentityReady, missing, activeExternalDisplay, externalDisplays, setStationFilter, setViewMode, setSoundEnabled, setAutoRefresh, refreshIdentity, fetchOrders, handleBumpOrder, openExternalDisplay, closeExternalDisplay } = model;
  const freeExternalDisplays = externalDisplays.filter(isExternalDisplayFree);
  const runningDisplayId = activeExternalDisplay
    ? liveExternalPresentation(displayCapabilities, KITCHEN_DISPLAY_CONTENT_TYPE)?.displayId
    : undefined;
  const orders = model.stationFilter === 'all' ? model.orders : model.orders.filter(order =>
    order.station_id === model.stationFilter || order.items.some(item => item.station === model.stationFilter));
  // Format order type for display using i18n (handles both legacy and new formats)
  const formatOrderType = (type: string): string => {
    // Map to translation keys (use existing orderType namespace)
    const keyMap: Record<string, string> = {
      'dine-in': 'orderType.dineIn',
      'dine_in': 'orderType.dineIn',  // legacy
      'pickup': 'orderType.pickup',
      'takeaway': 'orderType.takeaway',
      'delivery': 'orderType.delivery',
      'drive-through': 'orderType.driveThrough',
      'room_service': 'orderType.roomService',
    };
    const key = keyMap[type];
    return key ? t(key, type) : type;  // fallback to raw type if no translation
  };

  const getOrderTypeTextColor = (type: string): string => {
    const colors: Record<string, string> = {
      'dine-in': 'text-yellow-500',
      'dine_in': 'text-yellow-500',
      'pickup': 'text-amber-500',
      'takeaway': 'text-green-500',
      'delivery': 'text-emerald-500',
      'drive-through': 'text-red-500',
      'room_service': 'text-amber-500',
    };
    return colors[type] || 'text-gray-500';
  };

  const getTimeSinceOrder = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('kitchen.justNow', 'Just now');
    if (mins < 60) return `${mins} ${t('kitchen.min', 'min')}`;
    return t('kitchen.hoursAgo', '{{hours}}h {{mins}}m', { hours: Math.floor(mins / 60), mins: mins % 60 });
  };

  const getTimeColor = (createdAt: string): string => {
    const diff = Date.now() - new Date(createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins > 20) return 'text-red-500';
    if (mins > 10) return 'text-yellow-500';
    return 'text-green-500';
  };

  const StationIcon = ({ station }: { station: string }) => {
    switch (station) {
      case 'grill': return <Flame className="w-4 h-4 text-amber-500" />;
      case 'cold': return <Snowflake className="w-4 h-4 text-slate-500" />;
      case 'hot': return <Utensils className="w-4 h-4 text-red-500" />;
      case 'dessert': return <Coffee className="w-4 h-4 text-yellow-500" />;
      case 'drinks': return <Coffee className="w-4 h-4 text-emerald-500" />;
      default: return <ChefHat className="w-4 h-4" />;
    }
  };

  const stats = {
    pending: orders.filter(o => o.status === 'pending').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    ready: orders.filter(o => o.status === 'ready').length,
    total: orders.length,
    avgTime: orders.length > 0 ? Math.round(orders.reduce((sum, o) => sum + (Date.now() - new Date(o.created_at).getTime()) / 60000, 0) / orders.length) : 0
  };
  const showMissingContext = !isIdentityResolving && !isIdentityReady;

  const OrderCard = ({ order }: { order: KitchenOrder }) => {
    const timeColor = getTimeColor(order.created_at);
    const isLiveDraft = order.isDraft;
    const isReady = !isLiveDraft && order.status === 'ready';
    const orderLabel = isLiveDraft
      ? t('kitchen.liveDraft.badge', 'Live Draft')
      : formatCompactOrderNumberForDisplay(order.order_number);
    return (
      <motion.div
        initial={false}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`p-4 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} ${order.priority === 'rush' ? 'ring-2 ring-red-500' : isReady ? 'ring-2 ring-(--pos-s-fg)' : ''}`}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="min-w-0 wrap-break-word text-xl font-bold leading-tight">
              {orderLabel}
            </span>
            {isReady && (
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${isDark ? 'border-emerald-600 bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-200' : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-emerald-700'}`}>
                <BellRing className="h-3.5 w-3.5" />
                {t('kitchen.ready', 'Ready')}
              </span>
            )}
            <span className={`text-xs font-medium ${getOrderTypeTextColor(order.order_type)}`}>
              {formatOrderType(order.order_type)}
            </span>
            {isLiveDraft && (
              <span className="text-xs font-medium text-amber-400">
                {t('kitchen.liveDraft.subtitle', 'Live cart in progress')}
              </span>
            )}
            {order.table_number && <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{order.table_number}</span>}
          </div>
          <div className={`flex shrink-0 items-center gap-1 ${timeColor}`}>
            <Clock className="w-4 h-4" />
            <span className="text-sm font-medium">{getTimeSinceOrder(order.created_at)}</span>
          </div>
        </div>
        <div className="space-y-2 mb-4">
          {order.items.map((item) => (
            <div key={item.id} className={`flex items-center justify-between gap-2 p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}>
              <div className="flex min-w-0 items-center gap-2">
                <StationIcon station={item.station} />
                <span className="font-medium">{item.quantity}x</span>
                <div className="min-w-0">
                  <span className="wrap-break-word">{item.name}</span>
                  {item.modifiers && item.modifiers.length > 0 && (
                    <p className={`wrap-break-word text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{item.modifiers.join(', ')}</p>
                  )}
                </div>
              </div>
              {item.notes && <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{item.notes}</span>}
            </div>
          ))}
        </div>
        {order.notes && (
          <div className={`mb-3 p-2 rounded-xl ${isDark ? 'bg-(--pos-s-surface-2) border border-(--pos-s-border)' : 'bg-(--pos-s-surface-2) border border-(--pos-s-border)'}`}>
            <p className="text-sm text-yellow-600">{order.notes}</p>
          </div>
        )}
        {isLiveDraft ? (
          <div className={`w-full py-3 rounded-xl text-center font-medium ${isDark ? 'bg-zinc-800 text-zinc-300' : 'bg-gray-100 text-gray-600'}`}>
            {t('kitchen.liveDraft.noAction', 'Waiting for checkout')}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void handleBumpOrder(order.id, order.status)}
            className={`w-full py-3 rounded-xl font-medium transition-all active:scale-[0.98] ${order.status === 'pending' ? 'bg-yellow-400 text-black active:bg-yellow-300' : order.status === 'preparing' ? 'bg-yellow-400 text-black active:bg-yellow-300' : isDark ? 'border border-zinc-600 bg-zinc-800 text-zinc-100 active:bg-zinc-700' : 'border border-gray-300 bg-gray-100 text-gray-900 active:bg-gray-200'}`}
          >
            {order.status === 'pending' ? (
              <><Play className="w-4 h-4 inline mr-2" />{t('kitchen.startPreparing', 'Start Preparing')}</>
            ) : order.status === 'preparing' ? (
              <><CheckCircle className="w-4 h-4 inline mr-2" />{t('kitchen.markReady', 'Mark Ready')}</>
            ) : (
              <><HandPlatter className="w-4 h-4 inline mr-2" />{t('kitchen.markCollected', 'Mark Collected')}</>
            )}
          </button>
        )}
      </motion.div>
    );
  };

  return (
    <div className={`h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-4 md:p-5 ${externalWindow || isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'} ${externalWindow ? 'h-screen' : ''}`}>
      {/* Header + Stats Card */}
      <div className={`rounded-2xl border mb-5 px-4 py-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight">
            {t('kitchen.title', 'Kitchen Display')}
          </h1>
          <p className={`mt-1 truncate text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t('kitchen.subtitle', 'Real-time order preparation')}
            {autoRefresh && isLive ? ` • ${t('common.live', 'Live')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!externalWindow && (
            <>
              {activeExternalDisplay ? (
                <button
                  type="button"
                  onClick={() => void closeExternalDisplay()}
                  disabled={isDisplayBusy}
                  className="pos-raised p-3 rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) text-red-800 dark:text-red-200 transition-all active:scale-95 active:bg-(--pos-s-surface-2) disabled:opacity-60 disabled:active:scale-100"
                  aria-label={t('kitchen.externalDisplay.stop', 'Stop external display')}
                >
                  <X className="w-5 h-5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void openExternalDisplay()}
                  disabled={isDisplayBusy || !displayCapabilities?.supported || freeExternalDisplays.length === 0}
                  className={`p-3 rounded-xl border transition-all active:scale-95 disabled:opacity-60 disabled:active:scale-100 ${isDark ? 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-200 active:bg-(--pos-s-surface-2)' : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-amber-800 active:bg-(--pos-s-surface-2)'}`}
                  aria-label={t('kitchen.externalDisplay.open', 'Open on connected display')}
                >
                  <ScreenShare className="w-5 h-5" />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
            aria-label={viewMode === 'grid' ? t('kitchen.view.list', 'List view') : t('kitchen.view.grid', 'Grid view')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'}`}
          >
            {viewMode === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setSoundEnabled(!soundEnabled)}
            aria-label={soundEnabled ? t('kitchen.sound.disable', 'Mute sound') : t('kitchen.sound.enable', 'Enable sound')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'}`}
          >
            {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-label={autoRefresh ? t('kitchen.autoRefresh.pause', 'Pause live refresh') : t('kitchen.autoRefresh.resume', 'Resume live refresh')}
            className={`p-3 rounded-xl border transition-all active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 active:bg-zinc-800' : 'bg-white border-gray-300 active:bg-gray-100'} ${autoRefresh ? 'text-green-500' : ''}`}
          >
            {autoRefresh ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isIdentityReady) {
                void fetchOrders(true);
                return;
              }
              void refreshIdentity();
            }}
            disabled={loading}
            aria-label={t('common.refresh', 'Refresh')}
            className={`h-12 w-12 rounded-xl inline-flex items-center justify-center transition-all shadow-xs active:scale-95 ${
              isDark
                ? 'border border-white/80 bg-white text-black active:bg-zinc-200'
                : 'border border-black bg-black text-white active:bg-zinc-800'
            } ${loading ? 'opacity-60 cursor-not-allowed active:scale-100' : ''}`}
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><AlertTriangle className="w-5 h-5 text-yellow-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.pending', 'Pending')}</p>
              <p className="text-2xl font-bold">{stats.pending}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><ChefHat className="w-5 h-5 text-amber-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.preparing', 'Preparing')}</p>
              <p className="text-2xl font-bold">{stats.preparing}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><BellRing className="w-5 h-5 text-emerald-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.ready', 'Ready')}</p>
              <p className="text-2xl font-bold">{stats.ready}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><CheckCircle className="w-5 h-5 text-green-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.total', 'Total')}</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className={`p-4 rounded-xl ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isDark ? 'bg-zinc-800' : 'bg-gray-100'}`}><Timer className="w-5 h-5 text-slate-500" /></div>
            <div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{t('kitchen.avgTime', 'Avg Time')}</p>
              <p className="text-2xl font-bold">{stats.avgTime} {t('kitchen.min', 'min')}</p>
            </div>
          </div>
        </div>
      </div>
      </div>

      {!externalWindow && displayCapabilities?.supported && (
        <div className={`rounded-2xl border mb-5 p-4 ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
          <div className="mb-3 flex items-center gap-2">
            <Monitor className="h-5 w-5 text-amber-400" />
            <h2 className="font-bold">
              {t('kitchen.externalDisplay.connectedDisplays', 'Connected monitors and TVs')}
            </h2>
          </div>
          {externalDisplays.length > 0 && (
            <div className="pos-scroll-row gap-2">
              {externalDisplays.map((display) => display.id === runningDisplayId ? (
                <div
                  key={display.id}
                  aria-current="true"
                  className={`min-w-[210px] rounded-xl border px-3 py-3 text-left ${isDark ? 'border-(--pos-s-border) bg-(--pos-s-surface-2)' : 'border-(--pos-s-border) bg-(--pos-s-surface-2)'}`}
                >
                  <div className="font-semibold">{display.name}</div>
                  <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-gray-600'}>
                    {display.size?.width || 0} x {display.size?.height || 0}
                  </div>
                  <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    {t('kitchen.externalDisplay.runningHere', 'Running here')}
                  </div>
                </div>
              ) : (
                // Another content or a closing window holds this screen until the native side frees it.
                <button
                  key={display.id}
                  type="button"
                  onClick={() => void openExternalDisplay(display)}
                  disabled={isDisplayBusy || !isExternalDisplayFree(display)}
                  className={`min-w-[210px] rounded-xl border px-3 py-3 text-left transition-all active:scale-[0.98] ${
                    isDark
                      ? 'border-zinc-700 bg-zinc-900 active:bg-zinc-800'
                      : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                  } disabled:opacity-60 disabled:active:scale-100`}
                >
                  <div className="font-semibold">{display.name}</div>
                  <div className={isDark ? 'text-sm text-zinc-400' : 'text-sm text-gray-600'}>
                    {display.size?.width || 0} x {display.size?.height || 0}
                  </div>
                  {!isExternalDisplayFree(display) && (
                    <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-gray-700'}`}>
                      {t('kitchen.externalDisplay.inUse', 'In use')}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          <p className={`mt-3 text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.externalDisplay.help',
              'Connect an HDMI display or an OS-level wireless display, then select it here.'
            )}
          </p>
        </div>
      )}

      {(displayNotice || displayError || displayCapabilities?.error) && !externalWindow && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-sm font-medium ${
            displayError || displayCapabilities?.error
              ? 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-red-800 dark:text-red-200'
              : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-200'
          }`}
        >
          {displayError || displayCapabilities?.error || displayNotice}
        </div>
      )}

      {/* Station Filter */}
      <div className="pos-scroll-row mb-5 gap-2">
        {[{ id: 'all', name: t('kitchen.allStations', 'All'), station_type: 'all' } as KdsStation, ...stations].map((station) => (
          <button
            key={station.id}
            onClick={() => setStationFilter(station.id === 'all' ? 'all' : station.id)}
            className={`px-4 py-2 rounded-xl font-medium whitespace-nowrap transition-all border active:scale-[0.98] ${stationFilter === (station.id === 'all' ? 'all' : station.id) ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)' : isDark ? 'bg-zinc-950 text-zinc-300 border-zinc-800 active:bg-zinc-900' : 'bg-white text-gray-600 border-gray-200 active:bg-gray-100'}`}
          >
            {station.id === 'all' ? t('kitchen.allStations', 'All') : station.name}
          </button>
        ))}
      </div>

      {/* Orders Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={`p-6 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'} animate-pulse`}>
              <div className={`h-6 rounded-sm w-1/2 mb-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              <div className="space-y-2">
                <div className={`h-10 rounded-sm ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
                <div className={`h-10 rounded-sm ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
              </div>
              <div className={`h-12 rounded-sm mt-4 ${isDark ? 'bg-zinc-800' : 'bg-gray-200'}`} />
            </div>
          ))}
        </div>
      ) : showMissingContext ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-amber-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2">
            {t('kitchen.contextMissing.title', 'Kitchen context is missing')}
          </h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
            {t(
              'kitchen.contextMissing.body',
              missing.branch
                ? 'This terminal is not assigned to a branch. Check terminal settings and try again.'
                : 'Kitchen context is incomplete. Check terminal settings and try again.'
            )}
          </p>
          <button
            onClick={() => {
              void refreshIdentity();
            }}
            className="pos-raised pos-raised--yellow px-6 py-2 rounded-xl bg-yellow-400 text-black font-medium transition-all active:scale-[0.98] active:bg-yellow-300"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('kitchen.contextMissing.action', 'Retry Context')}
          </button>
        </div>
      ) : error ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <AlertTriangle className="w-16 h-16 mx-auto mb-4 text-red-500 opacity-75" />
          <h3 className="text-xl font-semibold mb-2 text-red-500">{t('kitchen.loadError', 'Unable to Load Orders')}</h3>
          <p className={`mb-4 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{error}</p>
          <button
            onClick={() => {
              void fetchOrders(true);
            }}
            className="pos-raised pos-raised--yellow px-6 py-2 rounded-xl bg-yellow-400 text-black font-medium transition-all active:scale-[0.98] active:bg-yellow-300"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            {t('common.retry', 'Retry')}
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div className={`p-12 rounded-xl text-center ${isDark ? 'bg-black border border-zinc-800' : 'bg-white border border-gray-200'}`}>
          <ChefHat className="w-16 h-16 mx-auto mb-4 text-gray-400 opacity-50" />
          <h3 className="text-xl font-semibold mb-2">{t('kitchen.noOrders', 'No Active Orders')}</h3>
          <p className={isDark ? 'text-zinc-400' : 'text-gray-600'}>{t('kitchen.noOrdersDesc', 'New orders will appear here automatically')}</p>
        </div>
      ) : (
        <AnimatePresence initial={false}>
          <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4' : 'space-y-4'}>
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </AnimatePresence>
      )}
    </div>
  );
};

const KitchenDisplayPage: React.FC = () => isKitchenExternalDisplayWindow()
  ? <ExternalKitchenDisplayPage /> : <LocalKitchenDisplayPage />;
export default KitchenDisplayPage;
