import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { useTheme } from '../../contexts/theme-context';
import { useFeatures } from '../../hooks/useFeatures';
import type { ZReportData } from '../../types/reports';
import { exportZReportToCSV, exportStaffOrdersToCSV } from '../../utils/reportExport';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { toLocalDateString } from '../../utils/date';
import { clearBusinessDayStorage } from '../../utils/session-utils';
import {
  normalizeZReportData,
  resolveShiftActivityCount,
  resolveShiftEarnedTotal,
  resolveShiftWindow,
  resolveZReportPeriod,
} from '../../utils/zReport';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { UnsettledPaymentBlockersPanel } from '../ui/UnsettledPaymentBlockersPanel';
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  CheckCircle,
  CreditCard,
  Download,
  FileText,
  Printer,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  X,
  XCircle,
} from 'lucide-react';
import { getBridge, offEvent, onEvent } from '../../../lib';
import type {
  UnsettledPaymentBlocker,
  ZReportSubmitResponse,
} from '../../../lib/ipc-contracts';
import {
  extractPaymentIntegrityPayload,
  formatOperatorFacingError,
  formatPaymentIntegrityError,
} from '../../../lib/payment-integrity';

interface ZReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchId: string;
  date?: string; // yyyy-mm-dd
  lockDate?: boolean;
}

type CloseoutChecklistState = 'ready' | 'warning' | 'error' | 'pending';

function extractErrorMessage(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return formatOperatorFacingError(error, fallback, t);
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
  const { resolvedTheme } = useTheme();
  const { isFeatureEnabled, isMainTerminal, isMobileWaiter, loading: featuresLoading, parentTerminalId } = useFeatures();
  const isDarkTheme = resolvedTheme === 'dark';
  const modalContentClassName = isDarkTheme
    ? 'z-report-glass-content !overflow-hidden !p-4 text-white'
    : 'z-report-glass-content !overflow-hidden !p-4 text-white';
  const modalShellClassName = isDarkTheme
    ? 'z-report-glass-shell border-white/[0.15] text-white shadow-2xl shadow-black/30'
    : 'z-report-glass-shell border-white/[0.18] text-white shadow-2xl shadow-black/20';
  const modalInsetClassName = isDarkTheme
    ? 'border-white/[0.12] bg-white/[0.055] shadow-sm shadow-black/10 backdrop-blur-xl'
    : 'border-white/[0.18] bg-white/[0.07] shadow-sm shadow-black/10 backdrop-blur-xl';
  const strongTextClass = 'text-white';
  const mutedTextClass = 'text-slate-200/90';
  const softTextClass = 'text-slate-300/75';
  const glassControlClass = 'border-white/[0.15] bg-white/[0.12] text-white shadow-sm shadow-black/10 backdrop-blur-xl hover:bg-white/[0.18]';
  const canExecuteZReport =
    isFeatureEnabled('zReportExecution') ||
    (!featuresLoading && (isMainTerminal || (!isMobileWaiter && !parentTerminalId)));
  const showMainTerminalWarning = !featuresLoading && !canExecuteZReport;
  const isPendingLocalSubmit = lockDate;
  const [activeTab, setActiveTab] = useState<'summary' | 'cash' | 'staff' | 'orders'>('summary');
  const [selectedDate, setSelectedDate] = useState<string>(() => date || toLocalDateString(new Date()));
  const [isUsingLiveDefaultDate, setIsUsingLiveDefaultDate] = useState(() => !lockDate);
  const [zReport, setZReport] = useState<ZReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [paymentBlockers, setPaymentBlockers] = useState<
    UnsettledPaymentBlocker[]
  >([]);
  const [resolvingBlockerKey, setResolvingBlockerKey] = useState<string | null>(null);
  const [reportReloadVersion, setReportReloadVersion] = useState(0);
  const wasOpenRef = useRef(false);
  const pendingOpenDateRef = useRef<string | null>(null);

  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'delivery' | 'dine-in' | 'pickup'>('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<'all' | 'cash' | 'card'>('all');

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
      setOrderTypeFilter('all');
      setPaymentMethodFilter('all');
      setError(null);
      setSubmitResult(null);
      setPaymentBlockers([]);
      setPrinting(false);
      setSubmitting(false);
      setResolvingBlockerKey(null);
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
        setPaymentBlockers([]);
      }

      try {
        const result = await bridge.reports.generateZReport({ branchId, date: selectedDate });
        if (!active) return;

        if (result?.success === false) {
          const paymentIntegrityPayload = extractPaymentIntegrityPayload(result);
          if (!silent) {
            setPaymentBlockers(paymentIntegrityPayload?.blockers || []);
            setError(
              formatPaymentIntegrityError(
                result,
                t('modals.zReport.loadFailed'),
                t,
              ),
            );
          }
          return;
        }

        const report = normalizeZReportData(result?.data || result);
        setZReport(report || null);

        if (shouldAutoRefresh && typeof report?.date === 'string' && report.date.trim()) {
          setSelectedDate((prev) => (prev === report.date ? prev : report.date));
        }

        if (!silent) {
          setPaymentBlockers([]);
          setError(null);
        }
      } catch (e: unknown) {
        if (!active) return;

        if (silent) {
          console.warn('[ZReportModal] Silent live refresh failed:', e);
          return;
        }

        setError(extractErrorMessage(e, t('modals.zReport.loadFailed'), t));
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
  }, [bridge, branchId, isOpen, isUsingLiveDefaultDate, lockDate, reportReloadVersion, selectedDate, t]);

  const handleResolveBlocker = useCallback(
    async (blocker: UnsettledPaymentBlocker, method: 'cash' | 'card') => {
      const actionKey = `${blocker.orderId}:${method}`;
      setResolvingBlockerKey(actionKey);
      setSubmitResult(null);

      try {
        const result = await bridge.reports.resolvePaymentBlocker({
          orderId: blocker.orderId,
          method,
        });

        if (result?.success === false) {
          const paymentIntegrityPayload = extractPaymentIntegrityPayload(result);
          if (paymentIntegrityPayload?.blockers?.length) {
            setPaymentBlockers(paymentIntegrityPayload.blockers);
          }
          const errorMessage = formatPaymentIntegrityError(
            result,
            t('modals.zReport.submissionFailed'),
            t,
          );
          setSubmitResult(
            t('modals.zReport.resolveBlockerFailed', {
              orderNumber: blocker.orderNumber,
              error: errorMessage,
            }),
          );
          return;
        }

        setError(null);
        setSubmitResult(
          t('modals.zReport.resolveBlockerSuccess', {
            orderNumber: blocker.orderNumber,
            method: t(
              method === 'cash'
                ? 'modals.zReport.cash'
                : 'modals.zReport.card',
            ).toLowerCase(),
          }),
        );
        setReportReloadVersion((current) => current + 1);
      } catch (e: unknown) {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(e);
        if (paymentIntegrityPayload?.blockers?.length) {
          setPaymentBlockers(paymentIntegrityPayload.blockers);
        }
        const errorMessage = extractErrorMessage(
          e,
          t('modals.zReport.submissionFailed'),
          t,
        );
        setSubmitResult(
          t('modals.zReport.resolveBlockerFailed', {
            orderNumber: blocker.orderNumber,
            error: errorMessage,
          }),
        );
      } finally {
        setResolvingBlockerKey(null);
      }
    },
    [bridge, t],
  );

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
  const liveModeLabel = isUsingLiveDefaultDate && !lockDate
    ? t('modals.zReport.liveCurrentWindow')
    : t('modals.zReport.historicalPreview');

  const getRoleBadgeClasses = (role?: string) => {
    switch (String(role || '').toLowerCase()) {
      case 'driver':
        return 'border-indigo-300/30 bg-indigo-500/15 text-indigo-100';
      case 'cashier':
      case 'manager':
        return 'border-amber-300/30 bg-amber-500/15 text-amber-100';
      case 'server':
      case 'waiter':
        return 'border-cyan-300/30 bg-cyan-500/15 text-cyan-100';
      default:
        return 'border-slate-200/20 bg-white/[0.08] text-slate-100';
    }
  };

  const getShiftStatusBadgeClasses = (status?: string) => {
    switch (String(status || '').toLowerCase()) {
      case 'active':
        return 'border-emerald-300/30 bg-emerald-500/15 text-emerald-100';
      case 'closed':
        return 'border-slate-200/20 bg-white/[0.08] text-slate-100';
      default:
        return 'border-amber-300/30 bg-amber-500/15 text-amber-100';
    }
  };

  const formatShiftStatus = (staff: any) => {
    const status = String(staff?.shiftStatus || (staff?.checkOut ? 'closed' : 'active')).toLowerCase();
    if (status === 'active') {
      return t('common.status.active', { defaultValue: 'Active' });
    }
    if (status === 'closed') {
      return t('modals.zReport.closed', { defaultValue: 'Closed' });
    }
    return status || '—';
  };

  const toFiniteNumberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const resolveStaffReturnAmount = (staff: any): number => {
    const candidates = [
      staff?.returnedToDrawerAmount,
      staff?.driver?.cashToReturn,
      staff?.drawer?.expected,
    ];
    for (const candidate of candidates) {
      const numeric = toFiniteNumberOrNull(candidate);
      if (numeric !== null) return numeric;
    }
    return 0;
  };

  const resolveDrawerExpectedAmount = (drawer: any): number => {
    const explicit = toFiniteNumberOrNull(drawer?.expected);
    if (explicit !== null) return explicit;
    return (
      Number(drawer?.opening || 0) +
      Number(drawer?.cashSales || 0) -
      Number(drawer?.refunds || 0) -
      Number(drawer?.drops || 0) -
      Number(drawer?.staffPayments || 0) -
      Number(drawer?.driverCashGiven || 0) +
      Number(drawer?.driverCashReturned || 0)
    );
  };

  const getDrawerStatusBadge = (drawer: any) => {
    if (drawer?.reconciled) {
      return {
        label: t('modals.zReport.reconciled'),
        className: 'border-emerald-300/30 bg-emerald-500/15 text-emerald-100',
      };
    }
    if (!drawer?.closedAt) {
      return {
        label: t('common.status.active', { defaultValue: 'Active' }),
        className: 'border-cyan-300/30 bg-cyan-500/15 text-cyan-100',
      };
    }
    return {
      label: t('modals.zReport.needsAttention'),
      className: 'border-amber-300/30 bg-amber-500/15 text-amber-100',
    };
  };

  const orderTypeFilterOptions = [
    { value: 'all' as const, label: t('modals.zReport.filters.allTypes') },
    { value: 'delivery' as const, label: t('modals.zReport.filters.delivery') },
    { value: 'dine-in' as const, label: t('modals.zReport.filters.dineIn') },
    { value: 'pickup' as const, label: t('modals.zReport.filters.pickup') },
  ];

  const paymentMethodFilterOptions = [
    { value: 'all' as const, label: t('modals.zReport.filters.allPayments') },
    { value: 'cash' as const, label: t('modals.zReport.filters.cash') },
    { value: 'card' as const, label: t('modals.zReport.filters.card') },
  ];

  const handleRefreshReport = useCallback(() => {
    setSubmitResult(null);
    setError(null);
    setReportReloadVersion((current) => current + 1);
  }, []);

  const handleExportReport = useCallback(() => {
    if (!zReport) return;
    exportZReportToCSV(zReport, `z-report-${resolvedBusinessDate}`);
  }, [resolvedBusinessDate, zReport]);

  const handleExportOrdersReport = useCallback(() => {
    if (!zReport?.staffReports) return;
    exportStaffOrdersToCSV(zReport.staffReports, `z-report-orders-${resolvedBusinessDate}`);
  }, [resolvedBusinessDate, zReport]);

  const handlePrintReport = useCallback(async () => {
    if (!zReport) return;
    setPrinting(true);
    try {
      const result = await bridge.reports.printZReport({
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
        }),
      );
    } finally {
      setPrinting(false);
    }
  }, [bridge, t, zReport]);

  const handleSubmitReport = useCallback(async () => {
    setSubmitResult(null);
    setPaymentBlockers([]);
    setSubmitting(true);
    try {
      console.log('[ZReportModal] Starting Z-Report submission...', { branchId, date: selectedDate });
      const res: ZReportSubmitResponse = await bridge.reports.submitZReport({ branchId, date: selectedDate });

      if (res?.success === false) {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(res);
        setPaymentBlockers(paymentIntegrityPayload?.blockers || []);
        const errorMessage = formatOperatorFacingError(
          res,
          res?.error || res?.message || t('modals.zReport.unknownError'),
          t,
        );
        console.error('[ZReportModal] IPC error response:', { error: errorMessage, fullResponse: res });
        setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
        return;
      }

      if (res?.success && res?.localDayClosed) {
        setPaymentBlockers([]);
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

        try { await bridge.auth.logout(); } catch { }
        try { clearBusinessDayStorage(); } catch { }
        try { clearShift(); } catch { }

        setTimeout(() => { window.location.reload(); }, 900);
      } else {
        const errorMessage = formatOperatorFacingError(
          res,
          res?.error || res?.message || t('modals.zReport.unknownError'),
          t,
        );
        console.error('[ZReportModal] Unexpected response format:', res);
        setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
      }
    } catch (e: unknown) {
      console.error('[ZReportModal] Submit error caught:', e);
      const paymentIntegrityPayload = extractPaymentIntegrityPayload(e);
      setPaymentBlockers(paymentIntegrityPayload?.blockers || []);
      const errorMessage = extractErrorMessage(
        e,
        t('modals.zReport.submissionFailed'),
        t,
      );
      setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
    } finally {
      setSubmitting(false);
    }
  }, [branchId, bridge, clearShift, isPendingLocalSubmit, selectedDate, t]);

  const closeoutDrawerVariance = summaryCashDrawer.totalVariance ?? 0;
  const closeoutUnreconciledDrawers = summaryCashDrawer.unreconciledCount ?? 0;
  const closeoutPendingExpenses = summaryExpenses.pendingCount ?? 0;
  const closeoutUnsettledDrivers = zReport?.driverEarnings?.unsettledCount ?? 0;
  const closeoutHasVariance = Math.abs(closeoutDrawerVariance) >= 0.01;
  const closeoutIssueCount =
    paymentBlockers.length +
    closeoutUnreconciledDrawers +
    closeoutPendingExpenses +
    closeoutUnsettledDrivers +
    (closeoutHasVariance ? 1 : 0) +
    (showMainTerminalWarning ? 1 : 0) +
    (error ? 1 : 0);
  const closeoutReady = Boolean(zReport) && !loading && closeoutIssueCount === 0;
  const closeoutStatusLabel = loading
    ? t('modals.zReport.closeoutLoading')
    : closeoutReady
      ? t('modals.zReport.readyToClose')
      : t('modals.zReport.needsAttention');

  const closeoutChecklistItems: Array<{
    key: string;
    label: string;
    description: string;
    state: CloseoutChecklistState;
  }> = [
    {
      key: 'sync',
      label: t('modals.zReport.adminSync'),
      description: loading
        ? t('modals.zReport.syncChecking')
        : error
          ? t('modals.zReport.syncNeedsRetry')
          : t('modals.zReport.syncReady'),
      state: loading ? 'pending' : error ? 'error' : 'ready',
    },
    {
      key: 'payments',
      label: t('modals.zReport.paymentsCaptured'),
      description: paymentBlockers.length > 0
        ? t('modals.zReport.paymentsNeedAction', { count: paymentBlockers.length })
        : t('modals.zReport.paymentsReady'),
      state: paymentBlockers.length > 0 ? 'error' : 'ready',
    },
    {
      key: 'cash-drawer',
      label: t('modals.zReport.cashDrawer'),
      description: closeoutUnreconciledDrawers > 0 || closeoutHasVariance
        ? t('modals.zReport.cashDrawerNeedsReview', {
          drawers: closeoutUnreconciledDrawers,
          variance: formatMoney(closeoutDrawerVariance),
        })
        : t('modals.zReport.cashDrawerReady'),
      state: closeoutUnreconciledDrawers > 0 || closeoutHasVariance ? 'warning' : 'ready',
    },
    {
      key: 'expenses',
      label: t('modals.zReport.expenses'),
      description: closeoutPendingExpenses > 0
        ? t('modals.zReport.expensesNeedReview', { count: closeoutPendingExpenses })
        : t('modals.zReport.expensesReady'),
      state: closeoutPendingExpenses > 0 ? 'warning' : 'ready',
    },
    {
      key: 'staff',
      label: t('modals.zReport.staffPerformance'),
      description: showMainTerminalWarning
        ? t('modals.zReport.staffNeedsMainTerminal')
        : t('modals.zReport.staffReady'),
      state: showMainTerminalWarning ? 'warning' : 'ready',
    },
  ];

  const totalOrders = summarySales.totalOrders ?? 0;
  const cashCollected = summarySales.cashSales ?? 0;
  const cardCollected = summarySales.cardSales ?? 0;
  const totalSales = summarySales.totalSales ?? 0;
  const expensesTotal = summaryExpenses.total ?? 0;
  const drawerOpening = summaryCashDrawer.openingTotal ?? 0;
  const drawerDrops = summaryCashDrawer.totalCashDrops ?? 0;
  const staffPaymentsTotal = summaryExpenses.staffPaymentsTotal ?? 0;
  const driverCashGiven = summaryCashDrawer.driverCashGiven ?? 0;
  const driverCashReturned = summaryCashDrawer.driverCashReturned ?? 0;
  const expectedCash =
    drawerOpening +
    cashCollected -
    expensesTotal -
    staffPaymentsTotal -
    drawerDrops -
    driverCashGiven +
    driverCashReturned;
  const drawerRows = Array.isArray(zReport?.drawers) ? zReport.drawers : [];
  const expenseRows = Array.isArray(summaryExpenses.items) ? summaryExpenses.items : [];
  const activeShiftCount = staffReportsSorted.filter((staff) => !staff.checkOut && staff.shiftStatus !== 'closed').length;
  const closedShiftCount = staffReportsSorted.filter((staff) => Boolean(staff.checkOut) || staff.shiftStatus === 'closed').length;
  const totalShiftCount = zReport?.shiftCount ?? zReport?.shifts?.total ?? staffReportsSorted.length;
  const driverCount = zReport?.driverEarnings?.breakdown?.length ?? zReport?.shifts?.driver ?? 0;
  const completedDeliveries = zReport?.driverEarnings?.completedDeliveries ?? zReport?.driverEarnings?.totalDeliveries ?? 0;
  const reportTabs: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'summary', label: t('modals.zReport.tabs.overview', { defaultValue: t('modals.zReport.tabs.summary') }) },
    { key: 'cash', label: t('modals.zReport.cashDrawer') },
    { key: 'staff', label: t('modals.zReport.staff') },
    { key: 'orders', label: t('modals.zReport.orders') },
  ];
  const allOrderDetails = staffReportsSorted.flatMap((staff) =>
    Array.isArray(staff.ordersDetails)
      ? staff.ordersDetails.map((order) => ({
        ...order,
        staffName: staff.staffName || staff.staffId,
      }))
      : [],
  );
  const filteredOrderDetails = filterOrders(allOrderDetails);
  const dashboardPanelClass = isDarkTheme
    ? 'border-white/[0.12] bg-white/[0.045] text-white shadow-2xl shadow-black/20 backdrop-blur-2xl'
    : 'border-white/[0.18] bg-white/[0.065] text-white shadow-2xl shadow-black/20 backdrop-blur-2xl';
  const dashboardInsetClass = `${modalInsetClassName} text-white`;
  const dashboardTileClass = isDarkTheme
    ? 'border-white/[0.12] bg-white/[0.06] text-white shadow-lg shadow-black/10 backdrop-blur-xl'
    : 'border-white/[0.18] bg-white/[0.08] text-white shadow-lg shadow-black/10 backdrop-blur-xl';

  const renderChecklistIcon = (state: CloseoutChecklistState) => {
    if (state === 'ready') {
      return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    }
    if (state === 'error') {
      return <XCircle className="h-4 w-4 text-rose-500" />;
    }
    if (state === 'pending') {
      return <RefreshCw className="h-4 w-4 text-cyan-500" />;
    }
    return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  };

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      className={modalShellClassName}
      header={(
        <header
          data-z-report-command-header
          className="flex shrink-0 flex-col gap-3 border-b border-white/10 bg-white/[0.06] px-4 py-3 text-white backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.15] bg-white/[0.12] backdrop-blur-xl">
              <FileText className={`h-5 w-5 ${softTextClass}`} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className={`text-2xl font-black tracking-tight ${strongTextClass}`}>
                  {t('modals.zReport.title', { date: '' }).replace(/\s+-\s*$/, '')}
                </h2>
                <span className={`text-sm font-bold ${softTextClass}`}>{resolvedBusinessDate}</span>
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                  {liveModeLabel}
                </span>
              </div>
              <div className={`mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold ${softTextClass}`}>
                <span>{t('modals.zReport.businessWindow')}: {formatWindowDateTime(resolvedPeriod.start)} - {formatWindowDateTime(resolvedPeriod.end)}</span>
                <span>{t('modals.zReport.terminal')}: {zReport?.terminalName || '—'}</span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {[
              { key: 'refresh', label: t('modals.zReport.refresh'), icon: RefreshCw, onClick: handleRefreshReport, disabled: loading },
              { key: 'print', label: t('modals.zReport.print'), icon: Printer, onClick: handlePrintReport, disabled: printing || !zReport },
              { key: 'export', label: t('modals.zReport.exportCSV'), icon: UploadCloud, onClick: handleExportReport, disabled: !zReport },
            ].map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className={`flex h-12 min-w-[68px] flex-col items-center justify-center gap-1 rounded-xl border px-3 text-[11px] font-bold transition ${glassControlClass} ${action.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  title={action.label}
                >
                  <Icon className={`h-4 w-4 ${action.key === 'refresh' && loading ? 'animate-spin' : ''}`} />
                  <span>{action.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={onClose}
              className={`flex h-12 min-w-[68px] flex-col items-center justify-center gap-1 rounded-xl border px-3 text-[11px] font-bold transition ${glassControlClass}`}
              title={t('common.actions.close')}
            >
              <X className="h-4 w-4" />
              <span>{t('common.actions.close')}</span>
            </button>
          </div>
        </header>
      )}
      size="full"
      contentClassName={modalContentClassName}
      closeOnBackdrop={true}
      closeOnEscape={true}
    >
      <div
        data-z-report-workbench
        className="z-report-content flex h-[calc(92vh-5.75rem)] min-h-[620px] flex-col overflow-hidden"
      >
        {(loading || error) && (
          <div className="mb-3 shrink-0">
            {loading && (
              <div className={`rounded-xl border px-4 py-3 text-sm font-bold ${dashboardInsetClass}`}>
                {t('modals.zReport.loading')}
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-700 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[260px_minmax(0,1fr)_270px] 2xl:grid-cols-[270px_minmax(0,1fr)_285px]">
          <aside
            data-z-report-closeout-checklist
            className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border ${dashboardPanelClass}`}
          >
            <div className={`m-3 rounded-2xl border p-4 backdrop-blur-xl ${closeoutReady ? 'border-emerald-400/40 bg-emerald-500/[0.12] text-emerald-950 dark:text-emerald-50' : 'border-amber-400/50 bg-amber-400/[0.16] text-amber-950 dark:text-amber-50'}`}>
              <div className="flex items-start gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${closeoutReady ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}>
                  {closeoutReady ? <CheckCircle className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
                </div>
                <div className="min-w-0">
                  <div className="break-words text-lg font-black text-inherit">{closeoutStatusLabel}</div>
                  <div className="mt-1 text-xs font-semibold leading-5 text-inherit opacity-80">
                    {closeoutReady ? t('modals.zReport.syncReady') : t('modals.zReport.reviewItems')}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3 scrollbar-hide">
              {closeoutChecklistItems.map((item) => (
                <div key={item.key} className={`rounded-xl border p-3 ${dashboardInsetClass}`}>
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">{renderChecklistIcon(item.state)}</div>
                    <div className="min-w-0">
                      <div className={`break-words text-sm font-black ${strongTextClass}`}>{item.label}</div>
                      <div className={`mt-1 break-words text-xs font-semibold leading-5 ${mutedTextClass}`}>{item.description}</div>
                    </div>
                  </div>
                </div>
              ))}

              {paymentBlockers.length > 0 && (
                <UnsettledPaymentBlockersPanel
                  blockers={paymentBlockers}
                  title={t('modals.zReport.paymentIntegrityTitle', {
                    defaultValue: 'Orders Blocking Z-Report Closeout',
                  })}
                  helperText={t('modals.zReport.paymentIntegrityResolveHelper', {
                    defaultValue:
                      'Resolve the missing balance here. The fix is recorded against the original business-day drawer before you retry the Z-report.',
                  })}
                  onResolveBlocker={handleResolveBlocker}
                  resolvingKey={resolvingBlockerKey}
                />
              )}
            </div>

            <div className={`m-3 mt-0 rounded-xl border p-3 ${dashboardInsetClass}`}>
              <label className="block">
                <span className={`flex items-center gap-2 text-xs font-black ${mutedTextClass}`}>
                  <CalendarDays className="h-4 w-4" />
                  {t('modals.zReport.selectBusinessDay')}
                </span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setIsUsingLiveDefaultDate(false);
                    setSelectedDate(e.target.value);
                  }}
                  className={`mt-3 w-full rounded-xl border px-3 py-2 text-sm font-black outline-none ${glassControlClass}`}
                  aria-label={t('modals.zReport.selectBusinessDay')}
                  disabled={lockDate}
                />
              </label>
              <div className={`mt-3 text-xs font-semibold ${softTextClass}`}>{liveModeLabel}</div>
            </div>
          </aside>

          <main
            data-z-report-main-panel
            className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border ${dashboardPanelClass}`}
          >
            <div className="shrink-0 border-b border-white/10 p-3">
              <div className="grid rounded-xl border border-white/[0.12] bg-black/10 p-1 backdrop-blur-xl sm:grid-cols-4">
                {reportTabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`min-h-[44px] rounded-lg px-3 text-sm font-black transition ${
                      activeTab === tab.key
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                        : isDarkTheme
                          ? 'text-slate-300 hover:bg-white/[0.06]'
                          : 'text-slate-200/80 hover:bg-white/[0.1]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-hide">
              {activeTab === 'summary' && (
                <div data-z-report-modern-summary className="space-y-4">
                  <section data-z-report-money-reconciliation className="space-y-4">
                    <div>
                      <h3 className={`text-2xl font-black ${strongTextClass}`}>{t('modals.zReport.moneyReconciliation')}</h3>
                    </div>

                    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
                      {[
                        { key: 'total', icon: FileText, label: t('modals.zReport.actualEarned'), value: formatMoney(totalSales), tone: 'text-emerald-600 dark:text-emerald-300' },
                        { key: 'cash', icon: Banknote, label: t('modals.zReport.cashSales'), value: formatMoney(cashCollected), tone: 'text-amber-600 dark:text-amber-300' },
                        { key: 'card', icon: CreditCard, label: t('modals.zReport.cardSales'), value: formatMoney(cardCollected), tone: 'text-blue-600 dark:text-blue-300' },
                        { key: 'expenses', icon: FileText, label: t('modals.zReport.totalExpenses'), value: formatMoney(expensesTotal), tone: 'text-orange-600 dark:text-orange-300' },
                        { key: 'variance', icon: AlertTriangle, label: t('modals.zReport.variance'), value: formatMoney(closeoutDrawerVariance), tone: closeoutHasVariance ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300' },
                      ].map((card) => {
                        const Icon = card.icon;
                        return (
                          <div key={card.key} className={`min-w-0 rounded-xl border p-4 ${dashboardTileClass}`}>
                            <div className="flex min-w-0 items-start gap-3">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.12] backdrop-blur-xl">
                                <Icon className={`h-4 w-4 ${softTextClass}`} />
                              </div>
                              <div className="min-w-0">
                                <div className={`break-words text-xs font-bold leading-4 ${softTextClass}`}>{card.label}</div>
                                <div className={`mt-2 break-words text-xl font-black leading-tight ${card.tone}`}>{card.value}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                      <div className="grid gap-3 text-center text-sm font-black md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr]">
                        <div><div className={softTextClass}>{t('modals.zReport.opening')}</div><div>{formatMoney(drawerOpening)}</div></div>
                        <div className={`hidden md:block ${softTextClass}`}>+</div>
                        <div><div className={softTextClass}>{t('modals.zReport.cashSales')}</div><div>{formatMoney(cashCollected)}</div></div>
                        <div className={`hidden md:block ${softTextClass}`}>-</div>
                        <div><div className={softTextClass}>{t('modals.zReport.totalExpenses')}</div><div>{formatMoney(expensesTotal + staffPaymentsTotal)}</div></div>
                        <div className={`hidden md:block ${softTextClass}`}>=</div>
                        <div><div className={softTextClass}>{t('modals.zReport.expected')}</div><div className="text-emerald-600 dark:text-emerald-300">{formatMoney(expectedCash)}</div></div>
                      </div>
                    </div>

                    <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
                      {[
                        { key: 'shifts', icon: CheckCircle, label: t('modals.zReport.totalShifts'), value: totalShiftCount, helper: `${t('common.status.active', { defaultValue: 'Active' })}: ${activeShiftCount} · ${t('modals.zReport.closing')}: ${closedShiftCount}` },
                        { key: 'orders', icon: FileText, label: t('modals.zReport.orders'), value: totalOrders, helper: t('modals.zReport.totalOrders') },
                        { key: 'drivers', icon: CreditCard, label: t('modals.zReport.deliveries'), value: driverCount, helper: `${t('modals.zReport.totalDeliveries')}: ${completedDeliveries}` },
                        { key: 'drawers', icon: AlertTriangle, label: t('modals.zReport.unreconciledDrawers'), value: closeoutUnreconciledDrawers, helper: closeoutHasVariance ? formatMoney(closeoutDrawerVariance) : t('modals.zReport.yes') },
                      ].map((card) => {
                        const Icon = card.icon;
                        return (
                          <div key={card.key} className={`min-w-0 rounded-xl border p-4 ${dashboardTileClass}`}>
                            <div className="flex items-start gap-3">
                              <Icon className="mt-1 h-5 w-5 shrink-0 text-cyan-500" />
                              <div className="min-w-0">
                                <div className={`break-words text-sm font-black ${strongTextClass}`}>{card.label}</div>
                                <div className={`mt-2 text-2xl font-black ${strongTextClass}`}>{card.value}</div>
                                <div className={`mt-1 break-words text-xs font-semibold leading-5 ${softTextClass}`}>{card.helper}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}

              {activeTab !== 'summary' && (
                <div data-z-report-modern-details className="space-y-4">
                  {activeTab === 'cash' && (
                    <section className="grid gap-4 2xl:grid-cols-2">
                      <div className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                        <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.drawerLedger')}</h3>
                        <div className="mt-4 space-y-3">
                          {drawerRows.length > 0 ? drawerRows.map((drawer) => {
                            const expected = resolveDrawerExpectedAmount(drawer);
                            const variance = Number(drawer.variance || 0);
                            const status = getDrawerStatusBadge(drawer);
                            const stats = [
                              { key: 'opening', label: t('modals.zReport.opening'), value: drawer.opening, tone: strongTextClass },
                              { key: 'cash', label: t('modals.zReport.cashSales'), value: drawer.cashSales, tone: 'text-amber-600 dark:text-amber-300' },
                              { key: 'card', label: t('modals.zReport.cardSales'), value: drawer.cardSales, tone: 'text-blue-600 dark:text-blue-300' },
                              { key: 'drops', label: t('modals.zReport.drops'), value: drawer.drops, tone: strongTextClass },
                              { key: 'given', label: t('modals.zReport.driverCashGiven'), value: drawer.driverCashGiven, tone: 'text-orange-600 dark:text-orange-300' },
                              { key: 'returned', label: t('modals.zReport.driverCashReturned'), value: drawer.driverCashReturned, tone: 'text-cyan-600 dark:text-cyan-300' },
                              { key: 'staff', label: t('modals.zReport.staffPayments'), value: drawer.staffPayments, tone: 'text-rose-600 dark:text-rose-300' },
                              { key: 'variance', label: t('modals.zReport.variance'), value: variance, tone: Math.abs(variance) < 0.01 ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300' },
                            ];

                            return (
                              <article key={drawer.id} className={`rounded-xl border p-4 ${dashboardTileClass}`}>
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className={`truncate text-base font-black ${strongTextClass}`}>{drawer.staffName || '-'}</div>
                                    <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>
                                      {formatWindowDateTime(drawer.openedAt)} - {drawer.closedAt ? formatWindowDateTime(drawer.closedAt) : t('common.status.active', { defaultValue: 'Active' })}
                                    </div>
                                  </div>
                                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${status.className}`}>{status.label}</span>
                                </div>

                                <div className="mt-4 rounded-xl border border-white/[0.12] bg-black/10 p-4">
                                  <div className={`text-[11px] font-black uppercase tracking-[0.12em] ${softTextClass}`}>{t('modals.zReport.expected')}</div>
                                  <div className="mt-2 text-3xl font-black text-emerald-600 dark:text-emerald-300">{formatMoney(expected)}</div>
                                </div>

                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                                  {stats.map((row) => (
                                    <div key={row.key} className="min-w-0 rounded-lg border border-white/[0.12] bg-black/10 p-3">
                                      <div className={`break-words text-xs font-black leading-4 ${softTextClass}`}>{row.label}</div>
                                      <div className={`mt-1 break-words text-base font-black ${row.tone}`}>{formatMoney(row.value)}</div>
                                    </div>
                                  ))}
                                </div>
                              </article>
                            );
                          }) : (
                            <div className="rounded-xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-slate-300/80">{t('modals.zReport.noDrawers')}</div>
                          )}
                        </div>
                      </div>

                      <div className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                        <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.expenseLedger')}</h3>
                        <div className="mt-4 space-y-2">
                          {expenseRows.length > 0 ? expenseRows.map((expense) => (
                            <div key={expense.id} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border p-3 ${dashboardTileClass}`}>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-black">{expense.description}</div>
                                <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>{expense.staffName || expense.expenseType || '-'}</div>
                              </div>
                              <div className="text-right text-sm font-black text-rose-600 dark:text-rose-300">{formatMoney(expense.amount)}</div>
                            </div>
                          )) : (
                            <div className="rounded-xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-slate-300/80">{t('modals.zReport.noExpenseDetails')}</div>
                          )}
                        </div>
                      </div>
                    </section>
                  )}

                  {activeTab === 'staff' && (
                    <section className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                      <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.staffPerformance')}</h3>
                      <div className="mt-4">
                        {staffReportsSorted.length > 0 ? (
                          <div className="grid gap-3 xl:grid-cols-2">
                            {staffReportsSorted.map((staff) => {
                              const shiftWindow = resolveShiftWindow(staff);
                              const statusLabel = formatShiftStatus(staff);
                              const statusValue = String(staff.shiftStatus || (staff.checkOut ? 'closed' : 'active'));
                              const activityLabel = String(staff.role || '').toLowerCase() === 'driver'
                                ? t('modals.zReport.deliveries')
                                : t('modals.zReport.orders');
                              const statRows = [
                                { key: 'activity', label: activityLabel, value: resolveShiftActivityCount(staff), tone: strongTextClass },
                                { key: 'sales', label: t('modals.zReport.sales'), value: formatMoney(resolveShiftEarnedTotal(staff)), tone: 'text-emerald-600 dark:text-emerald-300' },
                                { key: 'cash', label: t('modals.zReport.cash'), value: formatMoney(staff.orders?.cashAmount), tone: 'text-amber-600 dark:text-amber-300' },
                                { key: 'card', label: t('modals.zReport.card'), value: formatMoney(staff.orders?.cardAmount), tone: 'text-blue-600 dark:text-blue-300' },
                                { key: 'return', label: t('modals.zReport.cashToReturn'), value: formatMoney(resolveStaffReturnAmount(staff)), tone: 'text-cyan-600 dark:text-cyan-300' },
                              ];
                              return (
                                <article key={staff.staffShiftId} className={`rounded-xl border p-4 ${dashboardTileClass}`}>
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className={`truncate text-base font-black ${strongTextClass}`}>{staff.staffName || staff.staffId}</div>
                                      <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>
                                        {formatWindowDateTime(shiftWindow.start)} - {staff.checkOut ? formatWindowDateTime(shiftWindow.end) : t('common.status.active', { defaultValue: 'Active' })}
                                      </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getRoleBadgeClasses(staff.role)}`}>{staff.role || '—'}</span>
                                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getShiftStatusBadgeClasses(statusValue)}`}>{statusLabel}</span>
                                    </div>
                                  </div>

                                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    {statRows.map((row) => (
                                      <div key={row.key} className="min-w-0 rounded-lg border border-white/[0.12] bg-black/10 p-3">
                                        <div className={`break-words text-xs font-black leading-4 ${softTextClass}`}>{row.label}</div>
                                        <div className={`mt-1 break-words text-base font-black ${row.tone}`}>{row.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="rounded-xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-slate-300/80">{t('modals.zReport.noStaffReports')}</div>
                        )}
                      </div>
                    </section>
                  )}

                  {activeTab === 'orders' && (
                    <section className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.orderDetails')}</h3>
                        <div className="flex flex-col gap-2 xl:items-end">
                          <div className="flex flex-wrap gap-1 rounded-xl border border-white/[0.12] bg-black/10 p-1 backdrop-blur-xl">
                            {orderTypeFilterOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setOrderTypeFilter(option.value)}
                                className={`min-h-[36px] rounded-lg px-3 text-xs font-black transition ${
                                  orderTypeFilter === option.value
                                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                                    : 'text-slate-200/80 hover:bg-white/[0.1]'
                                }`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1 rounded-xl border border-white/[0.12] bg-black/10 p-1 backdrop-blur-xl">
                            {paymentMethodFilterOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setPaymentMethodFilter(option.value)}
                                className={`min-h-[36px] rounded-lg px-3 text-xs font-black transition ${
                                  paymentMethodFilter === option.value
                                    ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                    : 'text-slate-200/80 hover:bg-white/[0.1]'
                                }`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 space-y-2">
                        {filteredOrderDetails.length > 0 ? filteredOrderDetails.map((order, index) => (
                          <div key={order.id || index} className={`grid gap-3 rounded-xl border p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto] ${dashboardTileClass}`}>
                            <div className="min-w-0">
                              <div className={`truncate text-sm font-black ${strongTextClass}`}>{order.orderNumber || '—'}</div>
                              <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>{order.staffName}</div>
                            </div>
                            <div className={`text-xs font-semibold ${softTextClass}`}>{order.orderType || '—'} · {order.paymentMethod || '—'}</div>
                            <div className="text-right text-sm font-black text-emerald-600 dark:text-emerald-300">{formatMoney(order.amount)}</div>
                          </div>
                        )) : (
                          <div className="rounded-xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-slate-300/80">{t('modals.zReport.noOrdersMatchFilter')}</div>
                        )}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
          </main>

          <aside
            data-z-report-action-panel
            className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border p-4 ${dashboardPanelClass}`}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-emerald-500/25 bg-emerald-500/10 text-emerald-500">
                <UploadCloud className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className={`text-xs font-black uppercase tracking-[0.18em] ${softTextClass}`}>{t('modals.zReport.actionPanelTitle')}</div>
                <div className={`mt-1 break-words text-xl font-black ${strongTextClass}`}>{submitButtonLabel}</div>
              </div>
            </div>

            <p className={`mt-4 break-words text-sm font-semibold leading-6 ${mutedTextClass}`}>
              {t('modals.zReport.commitHelp')}
            </p>

            <div className={`mt-4 rounded-xl border p-4 ${dashboardInsetClass}`}>
              <div className="flex items-center justify-between gap-3">
                <span className={`break-words text-xs font-black uppercase tracking-[0.14em] ${softTextClass}`}>{t('modals.zReport.reviewItems')}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-black ${closeoutReady ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : 'bg-amber-500/15 text-amber-700 dark:text-amber-200'}`}>{closeoutIssueCount}</span>
              </div>
              <div className={`mt-4 text-3xl font-black ${strongTextClass}`}>{formatMoney(totalSales)}</div>
              <div className={`mt-1 text-xs font-bold ${softTextClass}`}>{resolvedBusinessDate}</div>
            </div>

            <div className="mt-5 space-y-2">
              {canExecuteZReport ? (
                <button
                  type="button"
                  onClick={handleSubmitReport}
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-600 px-4 py-3 text-sm font-black text-white shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-500 ${submitting || loading || Boolean(resolvingBlockerKey) || paymentBlockers.length > 0 ? 'cursor-not-allowed opacity-55' : ''}`}
                  disabled={submitting || loading || Boolean(resolvingBlockerKey) || paymentBlockers.length > 0}
                  aria-busy={submitting}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {submitting ? t('modals.zReport.submitting') : submitButtonLabel}
                </button>
              ) : (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-bold text-amber-700 dark:text-amber-200">
                  {showMainTerminalWarning
                    ? t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')
                    : t('common.loading', 'Loading...')}
                </div>
              )}
              <button type="button" onClick={handlePrintReport} disabled={printing || !zReport} className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-black transition ${glassControlClass} ${printing || !zReport ? 'cursor-not-allowed opacity-60' : ''}`}>
                <Printer className="h-4 w-4" />
                {printing ? t('modals.zReport.printing', 'Printing...') : t('modals.zReport.print')}
              </button>
              <button type="button" onClick={handleExportReport} disabled={!zReport} className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-black transition ${glassControlClass} ${!zReport ? 'cursor-not-allowed opacity-60' : ''}`}>
                <FileText className="h-4 w-4" />
                {t('modals.zReport.exportCSV')}
              </button>
            </div>

            <div className={`mt-5 min-h-0 flex-1 overflow-y-auto border-t pt-4 scrollbar-hide ${isDarkTheme ? 'border-white/10' : 'border-white/[0.64]'}`}>
              <div className={`text-xs font-black uppercase tracking-[0.18em] ${softTextClass}`}>{t('modals.zReport.salesSummary')}</div>
              <div className="mt-3 space-y-2 text-sm">
                {[
                  { label: t('modals.zReport.businessDay'), value: resolvedBusinessDate },
                  { label: t('modals.zReport.periodStart'), value: formatWindowDateTime(resolvedPeriod.start) },
                  { label: t('modals.zReport.periodEnd'), value: formatWindowDateTime(resolvedPeriod.end) },
                  { label: t('modals.zReport.terminal'), value: zReport?.terminalName || '—' },
                  { label: t('modals.zReport.totalShifts'), value: totalShiftCount },
                ].map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-3">
                    <span className={`break-words ${softTextClass}`}>{row.label}</span>
                    <span className={`text-right font-black ${strongTextClass}`}>{row.value}</span>
                  </div>
                ))}
              </div>

              {submitResult && (
                <div className="mt-4 rounded-xl border border-cyan-500/25 bg-cyan-500/10 p-3 text-xs font-bold leading-5 text-cyan-800 dark:text-cyan-200">
                  {submitResult}
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className={`mt-3 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-3 text-xs font-semibold ${dashboardInsetClass}`}>
          <span className="flex items-center gap-2"><ShieldCheck className={`h-4 w-4 ${softTextClass}`} />{t('modals.zReport.syncReady')}</span>
          <span>{t('modals.zReport.periodEnd')}: {formatWindowDateTime(resolvedPeriod.end)}</span>
          <span>{closeoutReady ? t('modals.zReport.readyToClose') : t('modals.zReport.needsAttention')}</span>
        </div>
      </div>
    </LiquidGlassModal>
  );

};

export default ZReportModal;
