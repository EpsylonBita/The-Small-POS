import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { useFeatures } from '../../hooks/useFeatures';
import type { ZReportData } from '../../types/reports';
import { exportZReportToCSV, exportStaffOrdersToCSV } from '../../utils/reportExport';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { toLocalDateString } from '../../utils/date';
import { liquidGlassModalButton } from '../../styles/designSystem';
import { clearBusinessDayStorage } from '../../utils/session-utils';
import {
  normalizeZReportData,
  resolveShiftActivityCount,
  resolveShiftEarnedTotal,
  resolveShiftWindow,
  resolveZReportPeriod,
  type ZReportStaffReport,
} from '../../utils/zReport';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { POSGlassTooltip } from '../ui/POSGlassTooltip';
import { VarianceBadge } from '../ui/VarianceBadge';
import { Banknote, CheckCircle, Circle, CreditCard, XCircle } from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../../lib';
import type { ZReportSubmitResponse } from '../../../lib/ipc-contracts';

interface ZReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchId: string;
  date?: string; // yyyy-mm-dd
  lockDate?: boolean;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    const directMessage = candidate.message ?? candidate.error ?? candidate.reason;
    if (typeof directMessage === 'string' && directMessage.trim()) {
      return directMessage;
    }
  }

  return fallback;
}

const ZReportModal: React.FC<ZReportModalProps> = ({
  isOpen,
  onClose,
  branchId,
  date,
  lockDate = false,
}) => {
  const bridge = getBridge();
  const { clearShift } = useShift();
  const { t } = useTranslation();
  const { isFeatureEnabled, isMainTerminal, isMobileWaiter, loading: featuresLoading, parentTerminalId } = useFeatures();
  const canExecuteZReport =
    isFeatureEnabled('zReportExecution') ||
    (!featuresLoading && (isMainTerminal || (!isMobileWaiter && !parentTerminalId)));
  const showMainTerminalWarning = !featuresLoading && !canExecuteZReport;
  const isPendingLocalSubmit = lockDate;
  const [activeTab, setActiveTab] = useState<'summary' | 'details'>('summary');
  const [selectedDate, setSelectedDate] = useState<string>(() => date || toLocalDateString(new Date()));
  const [isUsingLiveDefaultDate, setIsUsingLiveDefaultDate] = useState(() => !lockDate);
  const [zReport, setZReport] = useState<ZReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const wasOpenRef = useRef(false);
  const pendingOpenDateRef = useRef<string | null>(null);

  // NEW: State for expandable orders
  const [expandedStaff, setExpandedStaff] = useState<Set<string>>(new Set());
  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'delivery' | 'dine-in' | 'pickup'>('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<'all' | 'cash' | 'card'>('all');

  // Helpers for symbols
  const getStatusSymbol = (status: string): React.ReactNode => {
    if (status === 'completed' || status === 'delivered') {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    if (status === 'cancelled') {
      return <XCircle className="w-4 h-4 text-red-500" />;
    }
    return <Circle className="w-3 h-3 text-gray-400" />;
  };

  const getPaymentSymbol = (method?: string): React.ReactNode => {
    if (method === 'cash') return <Banknote className="w-4 h-4 text-green-500" />;
    if (method === 'card') return <CreditCard className="w-4 h-4 text-blue-500" />;
    if (method === 'mixed') {
      return (
        <span className="inline-flex items-center gap-1">
          <Banknote className="w-4 h-4 text-green-500" />
          <CreditCard className="w-4 h-4 text-blue-500" />
        </span>
      );
    }
    return <Circle className="w-3 h-3 text-gray-400" />;
  };

  const filterOrders = (orders: any[] | null | undefined): any[] => {
    if (!orders || !Array.isArray(orders)) return [];
    return orders.filter(o => {
      if (!o) return false;
      const typeMatch = orderTypeFilter === 'all' || o.orderType === orderTypeFilter;
      const paymentMatch = paymentMethodFilter === 'all' || o.paymentMethod === paymentMethodFilter;
      return typeMatch && paymentMatch;
    });
  };

  const staffReportsSorted = useMemo(() => {
    const list = Array.isArray(zReport?.staffReports) ? [...zReport.staffReports] : [];
    if (!list.length) return list;
    return list.sort((a, b) => {
      const roleCompare = String(a.role || '').localeCompare(String(b.role || ''));
      if (roleCompare !== 0) {
        return roleCompare;
      }

      const checkInCompare = String(a.checkIn || '').localeCompare(String(b.checkIn || ''));
      if (checkInCompare !== 0) {
        return checkInCompare;
      }

      return String(a.staffName || a.staffId).localeCompare(String(b.staffName || b.staffId));
    });
  }, [zReport]);

  const formatMoney = (value?: number) => formatCurrency(value ?? 0);
  const formatWindowDateTime = (value?: string | null) => (
    value
      ? `${formatDate(value)} ${formatTime(value)}`
      : '—'
  );

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const nextDate = date || toLocalDateString(new Date());
      pendingOpenDateRef.current = nextDate;
      setActiveTab('summary');
      setExpandedStaff(new Set());
      setOrderTypeFilter('all');
      setPaymentMethodFilter('all');
      setError(null);
      setSubmitResult(null);
      setPrinting(false);
      setSubmitting(false);
      setZReport(null);
      setLoading(true);
      setSelectedDate(nextDate);
      setIsUsingLiveDefaultDate(!lockDate);
    }

    if (!isOpen) {
      pendingOpenDateRef.current = null;
    }

    wasOpenRef.current = isOpen;
  }, [date, isOpen, lockDate]);

  useEffect(() => {
    if (!isOpen || !branchId || !selectedDate) return;
    if (pendingOpenDateRef.current && pendingOpenDateRef.current !== selectedDate) return;

    pendingOpenDateRef.current = null;

    let active = true;
    const shouldAutoRefresh = isUsingLiveDefaultDate && !lockDate;

    const load = async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const result = await bridge.reports.generateZReport({ branchId, date: selectedDate });
        if (!active) return;

        const report = normalizeZReportData(result?.data || result);
        setZReport(report || null);

        if (shouldAutoRefresh && typeof report?.date === 'string' && report.date.trim()) {
          setSelectedDate((prev) => (prev === report.date ? prev : report.date));
        }

        if (!silent) {
          setError(null);
        }
      } catch (e: unknown) {
        if (!active) return;

        if (silent) {
          console.warn('[ZReportModal] Silent live refresh failed:', e);
          return;
        }

        setError(extractErrorMessage(e, t('modals.zReport.loadFailed')));
      } finally {
        if (!active || silent) return;
        setLoading(false);
      }
    };

    void load(false);

    if (!shouldAutoRefresh) {
      return () => {
        active = false;
      };
    }

    const handleShiftUpdated = () => {
      void load(true);
    };

    const intervalId = setInterval(() => {
      void load(true);
    }, 30000);

    onEvent('shift-updated', handleShiftUpdated);

    return () => {
      active = false;
      clearInterval(intervalId);
      offEvent('shift-updated', handleShiftUpdated);
    };
  }, [bridge, branchId, isOpen, isUsingLiveDefaultDate, lockDate, selectedDate, t]);

  const title = useMemo(() => t('modals.zReport.title', { date: selectedDate }), [selectedDate, t]);
  const submitButtonLabel = isPendingLocalSubmit
    ? t('modals.zReport.completePendingLocalSubmit')
    : t('modals.zReport.submitToAdmin');
  const resolvedBusinessDate = zReport?.date || selectedDate;
  const resolvedPeriod = useMemo(() => resolveZReportPeriod(zReport), [zReport]);
  const summarySales = zReport?.sales || { totalOrders: 0, totalSales: 0, cashSales: 0, cardSales: 0 };
  const summaryCashDrawer: ZReportData['cashDrawer'] = zReport?.cashDrawer || {
    totalVariance: 0,
    totalCashDrops: 0,
    unreconciledCount: 0,
    openingTotal: 0,
    driverCashGiven: 0,
    driverCashReturned: 0,
  };
  const summaryExpenses: Partial<ZReportData['expenses']> = zReport?.expenses || { total: 0, items: [] };
  const hasSalesByType = Boolean(summarySales.byType && (summarySales.byType.instore || summarySales.byType.delivery));
  const liveModeLabel = isUsingLiveDefaultDate && !lockDate
    ? t('modals.zReport.liveCurrentWindow')
    : t('modals.zReport.historicalPreview');

  const summaryMetrics = [
    { key: 'orders', label: t('modals.zReport.totalOrders'), value: summarySales.totalOrders ?? 0, tone: 'text-cyan-300' },
    { key: 'earned', label: t('modals.zReport.actualEarned'), value: formatMoney(summarySales.totalSales), tone: 'text-emerald-300' },
    { key: 'cash', label: t('modals.zReport.cashSales'), value: formatMoney(summarySales.cashSales), tone: 'text-amber-200' },
    { key: 'card', label: t('modals.zReport.cardSales'), value: formatMoney(summarySales.cardSales), tone: 'text-sky-300' },
  ];

  const getRoleBadgeClasses = (role?: string) => {
    switch (String(role || '').toLowerCase()) {
      case 'driver':
        return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-900 dark:text-indigo-100';
      case 'cashier':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100';
      default:
        return 'border-slate-400/30 bg-slate-500/10 text-slate-900 dark:text-slate-100';
    }
  };

  const renderStaffOrderDetails = (staff: ZReportStaffReport) => {
    if (!Array.isArray(staff.ordersDetails) || staff.ordersDetails.length === 0) {
      return null;
    }

    const filteredOrdersList = filterOrders(staff.ordersDetails);

    return (
      <div className="mt-4 border-t border-white/10 pt-4">
        <button
          onClick={() => {
            const newExpanded = new Set(expandedStaff);
            if (newExpanded.has(staff.staffShiftId)) {
              newExpanded.delete(staff.staffShiftId);
            } else {
              newExpanded.add(staff.staffShiftId);
            }
            setExpandedStaff(newExpanded);
          }}
          className="flex items-center gap-2 text-sm font-semibold text-cyan-700 dark:text-cyan-300"
        >
          <span>{expandedStaff.has(staff.staffShiftId) ? '▼' : '▶'}</span>
          <span>{t('modals.zReport.orderDetails')} ({staff.ordersDetails.length})</span>
        </button>

        {expandedStaff.has(staff.staffShiftId) && (
          <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
            {staff.ordersTruncated && (
              <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200">
                Warning: Only the first 1000 orders are displayed. Export CSV to see all data.
              </div>
            )}
            <div className="flex bg-slate-200/50 py-2 text-xs font-bold dark:bg-slate-800/50">
              <div className="w-[15%] px-2 text-left text-slate-700 dark:text-slate-200">{t('modals.zReport.orderNumber')}</div>
              <div className="w-[15%] px-2 text-left text-slate-700 dark:text-slate-200">{t('modals.zReport.type')}</div>
              <div className="w-[20%] px-2 text-left text-slate-700 dark:text-slate-200">{t('modals.zReport.location')}</div>
              <div className="w-[15%] px-2 text-right text-slate-700 dark:text-slate-200">{t('modals.zReport.amount')}</div>
              <div className="w-[10%] px-2 text-center text-slate-700 dark:text-slate-200">{t('modals.zReport.payment')}</div>
              <div className="w-[10%] px-2 text-center text-slate-700 dark:text-slate-200">{t('modals.zReport.status')}</div>
              <div className="w-[15%] px-2 text-left text-slate-700 dark:text-slate-200">{t('modals.zReport.time')}</div>
            </div>
            {filteredOrdersList.length > 0 ? (
              <div className="w-full">
                {filteredOrdersList.map((order, index) => {
                  if (!order) return null;
                  return (
                    <div key={order.id || index} className="flex items-center border-t border-slate-400/15 bg-white/40 text-xs hover:bg-slate-200/30 dark:bg-slate-900/20 dark:hover:bg-slate-700/30">
                      <div className="w-[15%] px-2 py-3 font-mono font-semibold text-blue-700 dark:text-blue-400">{order.orderNumber || '—'}</div>
                      <div className="w-[15%] px-2 py-3 font-medium capitalize text-slate-700 dark:text-slate-300">{order.orderType || '—'}</div>
                      <div className="w-[20%] px-2 py-3 text-slate-600 dark:text-slate-400">
                        {order.orderType === 'delivery'
                          ? (order.deliveryAddress || 'N/A')
                          : order.orderType === 'dine-in'
                            ? `Table ${order.tableNumber || 'N/A'}`
                            : '—'}
                      </div>
                      <div className="w-[15%] px-2 py-3 text-right font-bold text-emerald-700 dark:text-emerald-400">{formatMoney(order.amount)}</div>
                      <div className="w-[10%] px-2 py-3 text-center text-lg">{getPaymentSymbol(order.paymentMethod)}</div>
                      <div className={`w-[10%] px-2 py-3 text-center text-lg ${order.status === 'cancelled' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                        {getStatusSymbol(order.status || '')}
                      </div>
                      <div className="w-[15%] px-2 py-3 text-xs font-medium text-slate-500 dark:text-slate-400">
                        {order.createdAt ? formatTime(order.createdAt) : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-4 text-center text-sm font-medium text-slate-500 dark:text-slate-400">
                {t('modals.zReport.noOrdersMatchFilter')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="full"
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      {/* Z Report content with crisp text styling */}
      <div className="z-report-content">
        <div className="mb-5 space-y-4">
          <div className="rounded-2xl border border-slate-300/40 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 px-4 py-4 shadow-[0_20px_60px_rgba(15,23,42,0.35)]">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                    {liveModeLabel}
                  </span>
                  {isPendingLocalSubmit && (
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200">
                      {t('modals.zReport.pendingLocalSubmitTitle')}
                    </span>
                  )}
                  {showMainTerminalWarning && (
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200">
                      {t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')}
                    </span>
                  )}
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                    {t('modals.zReport.businessWindow')}
                  </div>
                  <div className="mt-1 text-2xl font-black tracking-tight text-white">
                    {t('modals.zReport.actualEarned')}: {formatMoney(summarySales.totalSales)}
                  </div>
                  <div className="mt-1 text-sm text-slate-300">
                    {formatWindowDateTime(resolvedPeriod.start)} {'\u2192'} {formatWindowDateTime(resolvedPeriod.end)}
                  </div>
                </div>
              </div>

              <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-300">
                  {t('modals.zReport.selectBusinessDay')}
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setIsUsingLiveDefaultDate(false);
                    setSelectedDate(e.target.value);
                  }}
                  className="liquid-glass-modal-input mt-3 font-semibold"
                  aria-label={t('modals.zReport.selectBusinessDay')}
                  disabled={lockDate}
                />
                <div className="mt-3 text-xs font-medium text-slate-300">
                  {lockDate ? t('modals.zReport.pendingDateLocked') : liveModeLabel}
                </div>
                {error && (
                  <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200">
                    {error}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
              {[
                { label: t('modals.zReport.businessDay'), value: resolvedBusinessDate },
                { label: t('modals.zReport.periodStart'), value: formatWindowDateTime(resolvedPeriod.start) },
                { label: t('modals.zReport.periodEnd'), value: formatWindowDateTime(resolvedPeriod.end) },
                { label: t('modals.zReport.terminal'), value: zReport?.terminalName || '—' },
                { label: t('modals.zReport.totalShifts'), value: zReport?.shiftCount ?? zReport?.shifts?.total ?? 0 },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-white/10 bg-white/5 px-3 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {item.label}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-white">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {isPendingLocalSubmit && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
              <div className="text-sm font-bold text-amber-800 dark:text-amber-300">
                {t('modals.zReport.pendingLocalSubmitTitle')}
              </div>
              <div className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-200/90">
                {t('modals.zReport.pendingLocalSubmitHelp')}
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          {(['summary', 'details'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === tab ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30' : 'bg-white/20 dark:bg-black/20 text-slate-700 dark:text-slate-200 hover:bg-white/30 dark:hover:bg-black/30 border border-slate-300/50 dark:border-slate-600/50'}`}>
              {t(`modals.zReport.tabs.${tab}`)}
            </button>
          ))}
        </div>

        {/* Scrollable Content */}
        <div className="max-h-[55vh] overflow-y-auto mb-4 rounded-lg scrollbar-hide">
        {loading && (
          <div className="py-12 text-center text-sm liquid-glass-modal-text-muted">{t('modals.zReport.loading')}</div>
        )}
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm font-medium text-red-200">
            {error}
          </div>
        )}
        {!loading && !error && activeTab === 'summary' && zReport && (() => {
          const sales = summarySales;
          const cashDrawer = summaryCashDrawer;
          const expenses = summaryExpenses;
          const cashCollected = sales.cashSales ?? 0;
          const cardCollected = sales.cardSales ?? 0;
          const collectedTotal = cashCollected + cardCollected;
          const paymentBase = collectedTotal > 0 ? collectedTotal : 1;
          const cashPercent = Math.round((cashCollected / paymentBase) * 100);
          const cardPercent = Math.round((cardCollected / paymentBase) * 100);
          const instoreTotal = (sales.byType?.instore?.cash?.total ?? 0) + (sales.byType?.instore?.card?.total ?? 0);
          const deliveryTotal = (sales.byType?.delivery?.cash?.total ?? 0) + (sales.byType?.delivery?.card?.total ?? 0);
          const channelBase = instoreTotal + deliveryTotal > 0 ? instoreTotal + deliveryTotal : 1;
          const instorePercent = Math.round((instoreTotal / channelBase) * 100);
          const deliveryPercent = Math.round((deliveryTotal / channelBase) * 100);
          const expenseItemsCount = Array.isArray(expenses.items) ? expenses.items.length : 0;
          const pendingExpenseCount = expenses.pendingCount ?? 0;
          const unresolvedDriverCount = zReport.driverEarnings?.unsettledCount ?? 0;
          const drawerVariance = cashDrawer.totalVariance ?? 0;
          const unreconciledDrawers = cashDrawer.unreconciledCount ?? 0;

          return (
          <div className="space-y-4">
            {staffReportsSorted.length > 0 && (
              <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4 dark:bg-cyan-900/20">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-extrabold uppercase tracking-wide text-cyan-900 dark:text-cyan-200">
                      {t('modals.zReport.liveShiftBreakdown')}
                    </h3>
                    <p className="mt-1 text-xs font-medium text-cyan-800/80 dark:text-cyan-200/70">
                      {t('modals.zReport.actualEarned')} · {t('modals.zReport.businessWindow')}
                    </p>
                  </div>
                  <div className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-900 dark:text-cyan-100">
                    {staffReportsSorted.length} {t('modals.zReport.totalShifts')}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
                  {staffReportsSorted.map((staff) => {
                    const shiftWindow = resolveShiftWindow(staff);
                    const activityKey = String(staff.role || '').toLowerCase() === 'driver'
                      ? 'modals.zReport.deliveries'
                      : 'modals.zReport.orders';
                    const badgeClasses = String(staff.role || '').toLowerCase() === 'driver'
                      ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-900 dark:text-indigo-100'
                      : String(staff.role || '').toLowerCase() === 'cashier'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100'
                        : 'border-slate-400/30 bg-slate-500/10 text-slate-900 dark:text-slate-100';

                    return (
                      <div key={staff.staffShiftId} className="rounded-xl border border-white/15 bg-slate-950/35 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold text-white">{staff.staffName || staff.staffId}</div>
                            <div className="mt-1 text-xs font-medium text-slate-300">
                              {formatWindowDateTime(shiftWindow.start)} {'\u2192'} {staff.checkOut ? formatWindowDateTime(shiftWindow.end) : t('common.status.active', { defaultValue: 'Active' })}
                            </div>
                          </div>
                          <div className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClasses}`}>
                            {staff.role}
                          </div>
                        </div>

                        <div className="mt-4">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                            {t('modals.zReport.actualEarned')}
                          </div>
                          <div className="mt-1 text-2xl font-black text-emerald-300">
                            {formatMoney(resolveShiftEarnedTotal(staff))}
                          </div>
                        </div>

                        <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                            <div className="font-medium text-slate-400">{t(activityKey)}</div>
                            <div className="mt-1 font-bold text-white">{resolveShiftActivityCount(staff)}</div>
                          </div>
                          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                            <div className="font-medium text-slate-400">{t('modals.zReport.cashSales')}</div>
                            <div className="mt-1 font-bold text-amber-200">{formatMoney(staff.orders?.cashAmount)}</div>
                          </div>
                          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                            <div className="font-medium text-slate-400">{t('modals.zReport.cardSales')}</div>
                            <div className="mt-1 font-bold text-sky-200">{formatMoney(staff.orders?.cardAmount)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/20 via-emerald-500/10 to-slate-900/40 p-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {summaryMetrics.map((metric) => (
                  <div key={metric.key} className="rounded-xl border border-white/10 bg-slate-950/35 px-4 py-4">
                    <div className="text-xs font-bold uppercase tracking-wide text-slate-300">{metric.label}</div>
                    <div className={`mt-2 text-2xl font-black ${metric.tone}`}>{metric.value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-5 2xl:grid-cols-[1.35fr_0.95fr]">
              <div className="space-y-5">
                <div className="rounded-3xl border border-slate-200/10 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 p-5 shadow-[0_20px_50px_rgba(15,23,42,0.35)]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                        {t('modals.zReport.salesSummary')}
                      </div>
                      <div className="mt-2 text-3xl font-black text-white">{formatMoney(sales.totalSales)}</div>
                      <div className="mt-1 text-sm text-slate-400">{t('modals.zReport.actualEarned')}</div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-right">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {t('modals.zReport.ordersByMethod')}
                      </div>
                      <div className="mt-2 text-lg font-bold text-slate-100">{formatMoney(collectedTotal)}</div>
                      <div className="text-xs text-slate-400">{t('modals.zReport.sales')}</div>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    {[
                      {
                        key: 'cash',
                        label: t('modals.zReport.cashSales'),
                        value: formatMoney(cashCollected),
                        percent: cashPercent,
                        tone: 'from-amber-400 to-yellow-200',
                        labelTone: 'text-amber-200',
                      },
                      {
                        key: 'card',
                        label: t('modals.zReport.cardSales'),
                        value: formatMoney(cardCollected),
                        percent: cardPercent,
                        tone: 'from-sky-400 to-cyan-200',
                        labelTone: 'text-sky-200',
                      },
                    ].map((row) => (
                      <div key={row.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className={`text-sm font-bold ${row.labelTone}`}>{row.label}</div>
                            <div className="mt-1 text-xs text-slate-400">{row.percent}%</div>
                          </div>
                          <div className={`text-lg font-black ${row.labelTone}`}>{row.value}</div>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                          <div className={`h-full rounded-full bg-gradient-to-r ${row.tone}`} style={{ width: `${Math.min(row.percent, 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {t('modals.zReport.totalOrders')}
                      </div>
                      <div className="mt-2 text-2xl font-black text-cyan-300">{sales.totalOrders ?? 0}</div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {t('modals.zReport.totalShifts')}
                      </div>
                      <div className="mt-2 text-2xl font-black text-fuchsia-300">{zReport.shiftCount ?? zReport.shifts?.total ?? 0}</div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-5 xl:grid-cols-2">
                  <div className="rounded-3xl border border-violet-400/20 bg-gradient-to-br from-violet-950/70 via-slate-950 to-slate-900 p-5 shadow-[0_18px_40px_rgba(139,92,246,0.12)]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-200/70">
                          {t('modals.zReport.salesSummary')}
                        </div>
                        <div className="mt-2 text-xl font-black text-white">{t('modals.zReport.instore')} / {t('modals.zReport.delivery')}</div>
                      </div>
                      <div className="rounded-full border border-violet-400/20 bg-violet-400/10 px-3 py-1 text-xs font-semibold text-violet-100">
                        {hasSalesByType ? t('modals.zReport.sales') : t('modals.zReport.totalSales')}
                      </div>
                    </div>

                    <div className="mt-5 space-y-4">
                      {[
                        {
                          key: 'instore',
                          label: t('modals.zReport.instore'),
                          total: instoreTotal,
                          percent: instorePercent,
                          cashCount: sales.byType?.instore?.cash?.count ?? 0,
                          cardCount: sales.byType?.instore?.card?.count ?? 0,
                          cashTotal: sales.byType?.instore?.cash?.total ?? 0,
                          cardTotal: sales.byType?.instore?.card?.total ?? 0,
                          accent: 'text-violet-200',
                          fill: 'from-violet-400 to-fuchsia-300',
                        },
                        {
                          key: 'delivery',
                          label: t('modals.zReport.delivery'),
                          total: deliveryTotal,
                          percent: deliveryPercent,
                          cashCount: sales.byType?.delivery?.cash?.count ?? 0,
                          cardCount: sales.byType?.delivery?.card?.count ?? 0,
                          cashTotal: sales.byType?.delivery?.cash?.total ?? 0,
                          cardTotal: sales.byType?.delivery?.card?.total ?? 0,
                          accent: 'text-orange-200',
                          fill: 'from-orange-400 to-amber-300',
                        },
                      ].map((channel) => (
                        <div key={channel.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className={`text-sm font-bold ${channel.accent}`}>{channel.label}</div>
                              <div className="mt-1 text-xs text-slate-400">{channel.percent}%</div>
                            </div>
                            <div className={`text-lg font-black ${channel.accent}`}>{formatMoney(channel.total)}</div>
                          </div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                            <div className={`h-full rounded-full bg-gradient-to-r ${channel.fill}`} style={{ width: `${Math.min(channel.percent, 100)}%` }} />
                          </div>
                          <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                            <div className="rounded-xl border border-white/10 bg-slate-950/45 px-3 py-3">
                              <div className="font-semibold text-slate-400">{t('modals.zReport.cash')} ({channel.cashCount})</div>
                              <div className="mt-1 font-bold text-amber-200">{formatMoney(channel.cashTotal)}</div>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-slate-950/45 px-3 py-3">
                              <div className="font-semibold text-slate-400">{t('modals.zReport.card')} ({channel.cardCount})</div>
                              <div className="mt-1 font-bold text-sky-200">{formatMoney(channel.cardTotal)}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-indigo-400/20 bg-gradient-to-br from-slate-900 via-indigo-950/35 to-slate-950 p-5 shadow-[0_18px_40px_rgba(99,102,241,0.12)]">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-200/70">
                      {t('modals.zReport.shiftsOverview')}
                    </div>
                    <div className="mt-2 text-xl font-black text-white">{t('modals.zReport.totalShifts')}</div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.totalOrders')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-cyan-300">{sales.totalOrders ?? 0}</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.totalShifts')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-fuchsia-300">{zReport.shiftCount ?? zReport.shifts?.total ?? 0}</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.totalExpenses')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-rose-300">{formatMoney(expenses.total)}</div>
                        <div className="mt-1 text-xs text-slate-400">{expenseItemsCount} {t('modals.zReport.expenses')}</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.unsettledCount')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-amber-200">{unresolvedDriverCount}</div>
                        <div className="mt-1 text-xs text-slate-400">{t('modals.zReport.deliveries')}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <div className="rounded-3xl border border-amber-400/20 bg-gradient-to-br from-slate-950 via-amber-950/35 to-slate-900 p-5 shadow-[0_18px_40px_rgba(245,158,11,0.14)]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200/70">
                        {t('modals.zReport.cashDrawer')}
                      </div>
                      <div className="mt-2 text-xl font-black text-white">{t('modals.zReport.totalVariance')}</div>
                    </div>
                    <POSGlassTooltip content={t('modals.staffShift.varianceExplanation', 'Difference between counted cash and expected cash')}>
                      <VarianceBadge variance={drawerVariance} size="sm" />
                    </POSGlassTooltip>
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    {[
                      { key: 'opening', label: t('modals.zReport.openingTotal'), value: formatMoney(cashDrawer.openingTotal), tone: 'text-amber-200' },
                      { key: 'drops', label: t('modals.zReport.totalCashDrops'), value: formatMoney(cashDrawer.totalCashDrops), tone: 'text-yellow-200' },
                      { key: 'given', label: t('modals.zReport.driverCashGiven'), value: formatMoney(cashDrawer.driverCashGiven), tone: 'text-orange-200' },
                      { key: 'returned', label: t('modals.zReport.driverCashReturned'), value: formatMoney(cashDrawer.driverCashReturned), tone: 'text-emerald-200' },
                    ].map((item) => (
                      <div key={item.key} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{item.label}</div>
                        <div className={`mt-2 text-xl font-black ${item.tone}`}>{item.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold text-white">{t('modals.zReport.unreconciledDrawers')}</div>
                        <div className="mt-1 text-xs text-slate-400">{t('modals.zReport.drawers')}</div>
                      </div>
                      <div className={`text-3xl font-black ${unreconciledDrawers > 0 ? 'text-amber-200' : 'text-emerald-300'}`}>
                        {unreconciledDrawers}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 border-t border-white/10 pt-4 text-xs text-amber-100/70">
                    <span className="font-semibold">{t('receipt.formula.label')}</span>{' '}
                    {t('receipt.zreport.formula.cashDrawer')}
                  </div>
                </div>

                <div className="rounded-3xl border border-rose-400/20 bg-gradient-to-br from-slate-950 via-rose-950/35 to-slate-900 p-5 shadow-[0_18px_40px_rgba(244,63,94,0.12)]">
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-200/70">
                    {t('modals.zReport.expenses')}
                  </div>
                  <div className="mt-2 text-xl font-black text-white">{t('modals.zReport.totalExpenses')}</div>

                  <div className="mt-5 grid gap-3">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                        {t('modals.zReport.totalExpenses')}
                      </div>
                      <div className="mt-2 text-2xl font-black text-rose-300">{formatMoney(expenses.total)}</div>
                    </div>

                    {expenses.staffPaymentsTotal !== undefined && (
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.staffPaymentsTotal')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-fuchsia-300">{formatMoney(expenses.staffPaymentsTotal)}</div>
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.pendingCount')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-amber-200">{pendingExpenseCount}</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                          {t('modals.zReport.expenses')}
                        </div>
                        <div className="mt-2 text-2xl font-black text-cyan-300">{expenseItemsCount}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 border-t border-white/10 pt-4 text-xs text-rose-100/70">
                    {t('receipt.zreport.formula.staffPayments')}
                  </div>
                </div>
              </div>
            </div>


          </div>
        );
        })()}


        {!loading && !error && activeTab === 'details' && zReport && (() => {
          // Safe accessors for nested properties that may be missing
          const detailsExpenses: Partial<ZReportData['expenses']> = zReport.expenses || { total: 0, items: [] };

          return (
          <div className="space-y-5 text-sm">
            {staffReportsSorted.length > 0 && (
              <div className="rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-slate-950 via-cyan-950/30 to-slate-900 p-5 shadow-[0_18px_40px_rgba(8,145,178,0.12)]">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h3 className="text-sm font-extrabold uppercase tracking-[0.16em] text-cyan-100">{t('modals.zReport.staffPerformance')}</h3>
                    <p className="mt-1 text-xs font-medium text-cyan-100/70">
                      {t('modals.zReport.orderDetails')} · {t('modals.zReport.actualEarned')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <select value={orderTypeFilter} onChange={(e) => setOrderTypeFilter(e.target.value as typeof orderTypeFilter)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-white">
                      <option value="all">{t('modals.zReport.filters.allTypes')}</option>
                      <option value="delivery">{t('modals.zReport.filters.delivery')}</option>
                      <option value="dine-in">{t('modals.zReport.filters.dineIn')}</option>
                      <option value="pickup">{t('modals.zReport.filters.pickup')}</option>
                    </select>
                    <select value={paymentMethodFilter} onChange={(e) => setPaymentMethodFilter(e.target.value as typeof paymentMethodFilter)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-white">
                      <option value="all">{t('modals.zReport.filters.allPayments')}</option>
                      <option value="cash">{t('modals.zReport.filters.cash')}</option>
                      <option value="card">{t('modals.zReport.filters.card')}</option>
                    </select>
                  </div>
                </div>

                <div className="mt-5 space-y-4">
                  {staffReportsSorted.map((staff) => {
                    const role = String(staff.role || '').toLowerCase();
                    const isDriver = role === 'driver';
                    const shiftWindow = resolveShiftWindow(staff);
                    const badgeClasses = getRoleBadgeClasses(staff.role);
                    const driverBreakdown = Array.isArray(zReport.cashDrawer?.driverCashBreakdown)
                      ? zReport.cashDrawer.driverCashBreakdown.find((row) => row.driverShiftId === staff.staffShiftId)
                      : undefined;
                    const filteredOrdersCount = Array.isArray(staff.ordersDetails) ? filterOrders(staff.ordersDetails).length : 0;
                    const secondaryMetrics = [
                      {
                        key: 'payments',
                        label: t('modals.zReport.staffPayments'),
                        value: formatMoney(staff.payments?.staffPayments),
                        tone: 'text-fuchsia-300',
                        visible: staff.payments?.staffPayments !== undefined,
                      },
                      {
                        key: 'expenses',
                        label: t('modals.zReport.expensesShort'),
                        value: formatMoney(staff.expenses?.total),
                        tone: 'text-rose-300',
                        visible: staff.expenses?.total !== undefined,
                      },
                      {
                        key: 'opening',
                        label: t('modals.zReport.opening'),
                        value: formatMoney(staff.drawer?.opening),
                        tone: 'text-amber-200',
                        visible: staff.drawer?.opening !== undefined,
                      },
                      {
                        key: 'variance',
                        label: t('modals.zReport.totalVariance'),
                        value: formatMoney(staff.drawer?.variance),
                        tone: (staff.drawer?.variance ?? 0) === 0 ? 'text-emerald-300' : 'text-amber-200',
                        visible: staff.drawer?.variance !== undefined,
                      },
                      {
                        key: 'return',
                        label: t('modals.zReport.cashToReturn'),
                        value: formatMoney(isDriver ? (staff.driver?.cashToReturn ?? driverBreakdown?.cashToReturn) : (staff.returnedToDrawerAmount ?? staff.drawer?.expected)),
                        tone: 'text-cyan-300',
                        visible: isDriver
                          ? staff.driver?.cashToReturn !== undefined || driverBreakdown?.cashToReturn !== undefined
                          : staff.returnedToDrawerAmount !== undefined || staff.drawer?.expected !== undefined,
                      },
                    ].filter((metric) => metric.visible);

                    return (
                      <div key={staff.staffShiftId} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
                        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-lg font-black text-white">{staff.staffName || staff.staffId}</div>
                              <div className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClasses}`}>
                                {staff.role}
                              </div>
                            </div>
                            <div className="mt-2 text-xs font-medium text-slate-300">
                              {formatWindowDateTime(shiftWindow.start)} {'\u2192'} {staff.checkOut ? formatWindowDateTime(shiftWindow.end) : t('common.status.active', { defaultValue: 'Active' })}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-right">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-100/70">
                              {t('modals.zReport.actualEarned')}
                            </div>
                            <div className="mt-2 text-2xl font-black text-emerald-300">
                              {formatMoney(resolveShiftEarnedTotal(staff))}
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 md:grid-cols-4">
                          <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                              {isDriver ? t('modals.zReport.deliveries') : t('modals.zReport.orders')}
                            </div>
                            <div className="mt-2 text-2xl font-black text-cyan-300">{resolveShiftActivityCount(staff)}</div>
                            <div className="mt-1 text-xs text-slate-400">{filteredOrdersCount} {t('modals.zReport.orderDetails')}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{t('modals.zReport.cashSales')}</div>
                            <div className="mt-2 text-2xl font-black text-amber-200">{formatMoney(staff.orders?.cashAmount)}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{t('modals.zReport.cardSales')}</div>
                            <div className="mt-2 text-2xl font-black text-sky-200">{formatMoney(staff.orders?.cardAmount)}</div>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-slate-950/45 px-4 py-4">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                              {isDriver ? t('modals.zReport.cashCollected') : t('modals.zReport.totalOrders')}
                            </div>
                            <div className="mt-2 text-2xl font-black text-fuchsia-300">
                              {isDriver ? formatMoney(staff.driver?.cashCollected ?? driverBreakdown?.cashCollected) : staff.orders?.count ?? 0}
                            </div>
                          </div>
                        </div>

                        {secondaryMetrics.length > 0 && (
                          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                            {secondaryMetrics.map((metric) => (
                              <div key={metric.key} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{metric.label}</div>
                                <div className={`mt-2 text-lg font-black ${metric.tone}`}>{metric.value}</div>
                              </div>
                            ))}
                          </div>
                        )}

                        {renderStaffOrderDetails(staff)}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-3xl border border-amber-400/20 bg-gradient-to-br from-slate-950 via-amber-950/30 to-slate-900 p-5 shadow-[0_18px_40px_rgba(245,158,11,0.12)]">
              <h3 className="mb-4 text-sm font-extrabold uppercase tracking-[0.16em] text-amber-100">{t('modals.zReport.drawers')}</h3>
              {zReport.drawers && zReport.drawers.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left">
                      <tr className="border-b border-white/10 bg-white/[0.04]">
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.staffName')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.opening')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.cashSales')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.cardSales')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.staffPayments')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.driverCashGiven')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.driverCashReturned')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.drops')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.expected')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.closing')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.variance')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.reconciled')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {zReport.drawers.map(d => (
                        <tr key={d.id} className="border-b border-white/10 hover:bg-white/[0.03]">
                          <td className="py-3 pr-3 font-semibold text-cyan-200">{d.staffName || '-'}</td>
                          <td className="py-3 pr-3 font-medium text-slate-100">{formatMoney(d.opening)}</td>
                          <td className="py-3 pr-3 font-bold text-amber-200">{formatMoney(d.cashSales)}</td>
                          <td className="py-3 pr-3 font-bold text-sky-200">{formatMoney(d.cardSales)}</td>
                          <td className="py-3 pr-3 font-bold text-rose-300">{formatMoney(d.staffPayments)}</td>
                          <td className="py-3 pr-3 font-bold text-orange-200">{formatMoney(d.driverCashGiven)}</td>
                          <td className="py-3 pr-3 font-bold text-emerald-300">{formatMoney(d.driverCashReturned)}</td>
                          <td className="py-3 pr-3 font-bold text-yellow-200">{formatMoney(d.drops)}</td>
                          <td className="py-3 pr-3 font-medium text-slate-100">{formatMoney(d.expected)}</td>
                          <td className="py-3 pr-3 font-medium text-slate-100">{formatMoney(d.closing)}</td>
                          <td className={`py-3 pr-3 font-bold ${(d.variance ?? 0) !== 0 ? 'text-amber-200' : 'text-emerald-300'}`}>{formatMoney(d.variance)}</td>
                          <td className={`py-3 pr-3 font-bold ${Boolean(d.reconciled) ? 'text-emerald-300' : 'text-amber-200'}`}>{Boolean(d.reconciled) ? t('modals.zReport.yes') : t('modals.zReport.no')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="font-medium text-slate-400">{t('modals.zReport.noDrawers')}</div>
              )}
            </div>

            <div className="rounded-3xl border border-rose-400/20 bg-gradient-to-br from-slate-950 via-rose-950/30 to-slate-900 p-5 shadow-[0_18px_40px_rgba(244,63,94,0.12)]">
              <h3 className="mb-4 text-sm font-extrabold uppercase tracking-[0.16em] text-rose-100">{t('modals.zReport.expenses')}</h3>
              {detailsExpenses.items && detailsExpenses.items.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="text-left">
                      <tr className="border-b border-white/10 bg-white/[0.04]">
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.description')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.type')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.staff')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.amount')}</th>
                        <th className="py-3 pr-3 font-bold uppercase tracking-wide text-slate-300">{t('modals.zReport.createdAt')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailsExpenses.items.map(e => (
                        <tr key={e.id} className="border-b border-white/10 hover:bg-white/[0.03]">
                          <td className="py-3 pr-3 font-medium text-slate-100">{e.description}</td>
                          <td className="py-3 pr-3 font-semibold text-fuchsia-200">{e.expenseType || '-'}</td>
                          <td className="py-3 pr-3 font-semibold text-cyan-200">{e.staffName || '-'}</td>
                          <td className="py-3 pr-3 font-bold text-rose-300">{formatMoney(e.amount)}</td>
                          <td className="py-3 pr-3 font-medium text-slate-400">{e.createdAt || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="font-medium text-slate-400">{t('modals.zReport.noExpenseDetails')}</div>
              )}
            </div>
          </div>
        );
        })()}
        </div>
      </div>

      {/* Footer - Outside scrollable area but inside crisp wrapper */}
      <div className="z-report-content rounded-xl -mx-2 px-2 -mb-2 pb-2 mt-2">
        <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-slate-300/50 dark:border-slate-600/50">
        <button
          onClick={() => zReport && exportZReportToCSV(zReport, `z-report-${resolvedBusinessDate}`)}
          className={liquidGlassModalButton('secondary', 'sm') + ' text-sm'}
          disabled={!zReport}
        >
          {t('modals.zReport.exportCSV')}
        </button>
        <button
          onClick={() => zReport?.staffReports && exportStaffOrdersToCSV(zReport.staffReports, `z-report-orders-${resolvedBusinessDate}`)}
          className={liquidGlassModalButton('secondary', 'sm') + ' text-sm'}
          disabled={!zReport}
        >
          {t('modals.zReport.exportOrdersCSV')}
        </button>
        <button
          onClick={async () => {
            if (!zReport) return;
            setPrinting(true);
            try {
              const result = await bridge.invoke('report:print-z-report', {
                snapshot: zReport,
                terminalName: typeof zReport.terminalName === 'string' ? zReport.terminalName : undefined,
              });
              if (result?.success === false) {
                throw new Error(result?.error || t('modals.zReport.printFailed', 'Failed to queue print'));
              }
              setSubmitResult(t('modals.zReport.printQueued', 'Z-Report print queued'));
            } catch (err) {
              console.error('[ZReportModal] Z-Report print error:', err);
              setSubmitResult(
                t('modals.zReport.printFailed', {
                  defaultValue: `Print failed: ${err instanceof Error ? err.message : 'unknown error'}`,
                  error: err instanceof Error ? err.message : 'unknown error',
                })
              );
            } finally {
              setPrinting(false);
            }
          }}
          className={`${liquidGlassModalButton('primary', 'sm')} text-sm ${printing ? 'opacity-60 cursor-not-allowed' : ''}`}
          disabled={printing || !zReport}
        >
          {printing ? t('modals.zReport.printing', 'Printing...') : t('modals.zReport.print')}
        </button>
        {/* Z-Report Submit Button - disabled for mobile waiter terminals */}
        {canExecuteZReport ? (
          <button
            onClick={async () => {
              setSubmitResult(null);
              setSubmitting(true);
              try {
                console.log('[ZReportModal] Starting Z-Report submission...', { branchId, date: selectedDate });
                const res: ZReportSubmitResponse = await bridge.reports.submitZReport({ branchId, date: selectedDate });
                
                // Check for IPC wrapper error (success === false)
                if (res?.success === false) {
                  // IPC returned an error - extract specific error message
                  const errorMessage = res?.error || res?.message || t('modals.zReport.unknownError');
                  console.error('[ZReportModal] IPC error response:', { error: errorMessage, fullResponse: res });
                  setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
                  return; // Don't proceed, button will be re-enabled in finally
                }
                
                // Check for actual success response
                if (res?.success && res?.localDayClosed) {
                  console.log('[ZReportModal] Z-Report submitted successfully:', {
                    id: res?.zReportId,
                    cleanup: res?.cleanup,
                    syncState: res?.syncState,
                  });

                  const successMessage =
                    res?.syncState === 'applied'
                      ? t('modals.zReport.submitSuccessSynced')
                      : isPendingLocalSubmit
                        ? t('modals.zReport.pendingLocalSubmitQueued')
                        : t('modals.zReport.submitSuccessQueued');
                  setSubmitResult(successMessage);

                  // Clear only business-day state and logout.
                  try { await bridge.auth.logout(); } catch { }
                  try { clearBusinessDayStorage(); } catch { }
                  try { clearShift(); } catch { }

                  // Reload after a short delay so the operator can read the
                  // local-close message before the login screen appears.
                  setTimeout(() => { window.location.reload(); }, 900);
                } else {
                  // Unexpected response format - extract any available error info
                  const errorMessage = res?.error || res?.message || t('modals.zReport.unknownError');
                  console.error('[ZReportModal] Unexpected response format:', res);
                  setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
                }
              } catch (e: unknown) {
                // Log full error details for debugging (Requirements 3.4)
                console.error('[ZReportModal] Submit error caught:', e);
                // Display specific error message to user
                const errorMessage = extractErrorMessage(e, t('modals.zReport.submissionFailed'));
                setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
              } finally {
                // Always reset button state (Requirements 5.2, 5.4)
                setSubmitting(false);
              }
            }}
            className={`px-3 py-2 rounded-md text-sm ${submitting ? 'bg-gray-400 cursor-not-allowed text-white' : liquidGlassModalButton('primary', 'sm')}`}
            disabled={submitting || loading}
            aria-busy={submitting}
          >
            {submitting ? t('modals.zReport.submitting') : submitButtonLabel}
          </button>
        ) : showMainTerminalWarning ? (
          <div className="flex items-center gap-2">
            <button
              disabled
              className="px-3 py-2 rounded-md text-sm bg-gray-400 cursor-not-allowed text-white opacity-50"
              title={t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')}
            >
              {submitButtonLabel}
            </button>
            <span className="text-xs text-amber-400">
              {t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')}
            </span>
          </div>
        ) : (
          <button
            disabled
            className="px-3 py-2 rounded-md text-sm bg-gray-400 cursor-not-allowed text-white opacity-50"
            aria-busy="true"
          >
            {t('common.loading', 'Loading...')}
          </button>
        )}
        {submitResult && <span className="ml-2 text-xs text-slate-600 dark:text-slate-300 font-medium">{submitResult}</span>}
        </div>
      </div>
    </LiquidGlassModal >
  );
};

export default ZReportModal;
