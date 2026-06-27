import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { translateRoleName } from '../../utils/role-labels';
import { useShift } from '../../contexts/shift-context';
import { useTheme } from '../../contexts/theme-context';
import { useFeatures } from '../../hooks/useFeatures';
import type { ZReportData } from '../../types/reports';
import { exportZReportToCSV, exportStaffOrdersToCSV } from '../../utils/reportExport';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { parseLocalDateString, toLocalDateString } from '../../utils/date';
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
  ChevronDown,
  Download,
  FileText,
  ListChecks,
  Lock,
  Printer,
  Receipt,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  Users,
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

// Normalize a raw backend slug to a canonical lookup key: lowercase, trim, and collapse
// '-'/'_'/whitespace so dine-in/dine_in, room_service/room-service, drive-through/
// drive_through and room_charge/room-charge each resolve to one localized label.
function normalizeZReportSlug(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '_');
}

// Localized display label for a Z-report audit row's order type. The raw filter values
// (order.orderType) are kept for matching; only the visible audit label is localized here.
function localizeZReportOrderType(
  value: unknown,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const key = ({
    delivery: 'delivery',
    dine_in: 'dineIn',
    pickup: 'pickup',
    takeaway: 'takeaway',
    drive_through: 'driveThrough',
    room_service: 'roomService',
  } as Record<string, string>)[normalizeZReportSlug(value)];
  if (!key) {
    return t('modals.zReport.orderTypes.unknown', { defaultValue: 'Unknown' });
  }
  return t(`modals.zReport.orderTypes.${key}`, { defaultValue: key });
}

// Localized display label for a Z-report audit row's payment/method/status token. The
// audit field can carry either a payment method (cash/card/split/room_charge) or a
// settlement status (pending/unpaid), so both are mapped; anything else (incl. missing
// or 'unknown') falls back to a localized Unknown label — never the raw slug.
function localizeZReportPaymentLabel(
  value: unknown,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const key = ({
    cash: 'cash',
    card: 'card',
    split: 'split',
    room_charge: 'roomCharge',
    pending: 'pending',
    unpaid: 'unpaid',
    unknown: 'unknown',
  } as Record<string, string>)[normalizeZReportSlug(value)];
  if (!key) {
    return t('modals.zReport.paymentLabels.unknown', { defaultValue: 'Unknown' });
  }
  return t(`modals.zReport.paymentLabels.${key}`, { defaultValue: key });
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
    ? 'z-report-glass-shell border-yellow-400/25 text-white shadow-2xl shadow-black/40'
    : 'z-report-glass-shell border-yellow-400/30 text-white shadow-2xl shadow-black/25';
  const modalInsetClassName = isDarkTheme
    ? 'border-yellow-400/15 bg-black/30 shadow-sm shadow-black/20 backdrop-blur-xl'
    : 'border-yellow-400/20 bg-black/25 shadow-sm shadow-black/15 backdrop-blur-xl';
  const strongTextClass = 'text-white';
  const mutedTextClass = 'text-white/85';
  const softTextClass = 'text-white/60';
  const glassControlClass = 'border-yellow-400/20 bg-black/30 text-white shadow-sm shadow-black/10 backdrop-blur-xl active:bg-white/[0.12]';
  const canExecuteZReport =
    isFeatureEnabled('zReportExecution') ||
    (!featuresLoading && (isMainTerminal || (!isMobileWaiter && !parentTerminalId)));
  const showMainTerminalWarning = !featuresLoading && !canExecuteZReport;
  // Round 320: the decision panel's 3-way action switch checks lockedTerminal FIRST, so the green submit
  // branch is reachable only when `canExecuteZReport && closeoutReady` -- identical to the prior gate.
  const lockedTerminal = !canExecuteZReport;
  const isPendingLocalSubmit = lockDate;
  const [activeTab, setActiveTab] = useState<'review' | 'money' | 'staff' | 'orders'>('review');
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
      setActiveTab('review');
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
  const submitButtonLabel = t('modals.zReport.commitZReport');
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
  // Round 322: the working day reads as a friendly, localized date in the header (not a raw ISO string),
  // with a small chip telling the cashier whether it is the live current day or a past day they picked.
  // Round 351 (live QA): the chip MUST be derived from the SAME date shown in the header
  // (resolvedBusinessDate) compared to the terminal-local today -- NOT from isUsingLiveDefaultDate. When the
  // report payload returns a different (past) date than the live-default selectedDate, the chip would otherwise
  // say "Today" for a past business day. It now says "Today" only when the displayed date is valid and equals
  // today; a returned past zReport.date shows "Past day" even if isUsingLiveDefaultDate is true.
  const businessDateValue = parseLocalDateString(resolvedBusinessDate);
  const isBusinessDateValid = !Number.isNaN(businessDateValue.getTime());
  const localToday = toLocalDateString(new Date());
  const isLiveDay = !lockDate && isBusinessDateValid && resolvedBusinessDate === localToday;
  const friendlyBusinessDate = !isBusinessDateValid
    ? resolvedBusinessDate
    : formatDate(businessDateValue, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const getRoleBadgeClasses = (role?: string) => {
    switch (String(role || '').toLowerCase()) {
      case 'driver':
        return 'border-white/[0.16] bg-white/[0.08] text-white/80';
      case 'cashier':
      case 'manager':
        return 'border-amber-300/30 bg-amber-500/15 text-amber-100';
      case 'server':
      case 'waiter':
        return 'border-white/[0.16] bg-white/[0.08] text-white/80';
      default:
        return 'border-white/[0.16] bg-white/[0.08] text-white/80';
    }
  };

  const getShiftStatusBadgeClasses = (status?: string) => {
    switch (String(status || '').toLowerCase()) {
      case 'active':
        return 'border-emerald-300/30 bg-emerald-500/15 text-emerald-100';
      case 'closed':
        return 'border-white/[0.16] bg-white/[0.08] text-white/80';
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
        className: 'border-white/[0.16] bg-white/[0.08] text-white/80',
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
  const activeShiftCount = staffReportsSorted.filter((staff) => !staff.checkOut && staff.shiftStatus !== 'closed').length;
  const closedShiftCount = staffReportsSorted.filter((staff) => Boolean(staff.checkOut) || staff.shiftStatus === 'closed').length;
  const totalShiftCount = zReport?.shiftCount ?? zReport?.shifts?.total ?? staffReportsSorted.length;
  const driverCount = zReport?.driverEarnings?.breakdown?.length ?? zReport?.shifts?.driver ?? 0;
  const completedDeliveries = zReport?.driverEarnings?.completedDeliveries ?? zReport?.driverEarnings?.totalDeliveries ?? 0;
  const hasActiveStaffShifts = activeShiftCount > 0;
  const cashDrawerBlocksCloseout = !hasActiveStaffShifts && (closeoutUnreconciledDrawers > 0 || closeoutHasVariance);
  const closeoutIssueCount =
    paymentBlockers.length +
    (hasActiveStaffShifts ? 1 : 0) +
    (cashDrawerBlocksCloseout ? closeoutUnreconciledDrawers : 0) +
    closeoutPendingExpenses +
    closeoutUnsettledDrivers +
    (cashDrawerBlocksCloseout && closeoutHasVariance ? 1 : 0) +
    (showMainTerminalWarning ? 1 : 0) +
    (error ? 1 : 0);
  const closeoutReady = Boolean(zReport) && !loading && closeoutIssueCount === 0;
  const closeoutNeedsCashierCheckout =
    !loading &&
    !closeoutReady &&
    cashDrawerBlocksCloseout &&
    !closeoutHasVariance &&
    paymentBlockers.length === 0 &&
    closeoutPendingExpenses === 0 &&
    closeoutUnsettledDrivers === 0 &&
    !showMainTerminalWarning &&
    !error;
  const closeoutNeedsStaffCheckout =
    !loading &&
    !closeoutReady &&
    hasActiveStaffShifts &&
    paymentBlockers.length === 0 &&
    closeoutPendingExpenses === 0 &&
    closeoutUnsettledDrivers === 0 &&
    !showMainTerminalWarning &&
    !error;
  const closeoutStatusLabel = loading
    ? t('modals.zReport.closeoutLoading')
    : closeoutReady
      ? t('modals.zReport.readyToClose')
      : closeoutNeedsStaffCheckout
        ? t('modals.zReport.allStaffCheckoutTitle')
        : closeoutNeedsCashierCheckout
        ? t('modals.zReport.clarity.cashDrawerCheckoutAction', { defaultValue: 'Close cashier shift' })
        : t('modals.zReport.needsAttention');

  // Round 323: a zero-variance unreconciled drawer is NOT a money discrepancy -- it just means the cashier
  // has not finished checkout/reconciliation yet. Split the cash-drawer copy so that case reads as a calm
  // "cashier checkout needed" instead of a scary variance warning. Blocking + counts are unchanged.
  const cashDrawerNeedsAttention = cashDrawerBlocksCloseout;
  const closeoutChecklistItems: Array<{
    key: string;
    label: string;
    description: string;
    state: CloseoutChecklistState;
    actionLabel?: string;
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
      // Three calm cases: (1) variance present -> money review wording with the amount; (2) both
      // unreconciled AND variance -> short checkout + variance line; (3) unreconciled with zero variance
      // -> plain "the cashier just needs to finish checkout", NOT a discrepancy warning.
      description: !cashDrawerNeedsAttention
        ? t('modals.zReport.cashDrawerReady')
        : closeoutHasVariance
          ? (closeoutUnreconciledDrawers > 0
            ? t('modals.zReport.cashDrawerCheckoutAndVariance', { variance: formatMoney(closeoutDrawerVariance) })
            : t('modals.zReport.cashDrawerNeedsReview', { variance: formatMoney(closeoutDrawerVariance) }))
          : t('modals.zReport.cashDrawerCheckoutNeeded'),
      // Zero-variance unresolved drawers want a calm "checkout" action; a real variance wants "reconcile".
      // Either way the state stays amber/warning -- never a red money/sync error.
      actionLabel: cashDrawerNeedsAttention
        ? (closeoutHasVariance
          ? t('modals.zReport.clarity.cashDrawerReconcileAction', { defaultValue: 'Reconcile drawer' })
          : t('modals.zReport.clarity.cashDrawerCheckoutAction', { defaultValue: 'Close cashier shift' }))
        : undefined,
      state: cashDrawerNeedsAttention ? 'warning' : 'ready',
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
      description: hasActiveStaffShifts
        ? t('modals.zReport.allStaffCheckoutSubtitle', { count: activeShiftCount })
        : showMainTerminalWarning
        ? t('modals.zReport.staffNeedsMainTerminal')
        : t('modals.zReport.staffReady'),
      actionLabel: hasActiveStaffShifts
        ? t('modals.zReport.allStaffCheckoutTitle')
        : undefined,
      state: hasActiveStaffShifts || showMainTerminalWarning ? 'warning' : 'ready',
    },
  ];

  // Round 304: the close-day hero names the ONE thing to fix first -- the first non-ready checklist
  // item, in checklist priority order (sync -> payments -> cash drawer -> expenses -> staff).
  const primaryIssue = closeoutChecklistItems.find((item) => item.state !== 'ready') ?? null;
  const closeoutSubtitle = lockedTerminal
    ? (showMainTerminalWarning
      ? t('terminal.messages.zReportMainOnly', 'Z-Report can only be executed from Main POS terminal')
      : t('common.loading', 'Loading...'))
    : loading
      ? t('modals.zReport.closeoutLoading')
      : closeoutReady
        ? t('modals.zReport.clarity.readyHint', { defaultValue: 'Everything checks out -- submit to admin.' })
        : closeoutNeedsStaffCheckout
          ? t('modals.zReport.allStaffCheckoutSubtitle', { count: activeShiftCount })
          : closeoutNeedsCashierCheckout
            ? t('modals.zReport.cashDrawerCheckoutNeeded')
            : primaryIssue?.description ?? t('modals.zReport.reviewBeforeClose');
  const canCommitZReport =
    !lockedTerminal &&
    closeoutReady &&
    !submitting &&
    !loading &&
    !Boolean(resolvingBlockerKey) &&
    paymentBlockers.length === 0;
  // Short, localized status word for each Check-tab row (icon + label + status).
  const closeoutStateLabel = (state: CloseoutChecklistState): string => {
    if (state === 'ready') return t('modals.zReport.clarity.statusReady', { defaultValue: 'Ready' });
    if (state === 'error') return t('modals.zReport.clarity.statusAction', { defaultValue: 'Action needed' });
    if (state === 'pending') return t('modals.zReport.clarity.statusChecking', { defaultValue: 'Checking…' });
    return t('modals.zReport.clarity.statusAttention', { defaultValue: 'Needs attention' });
  };

  const totalOrders = summarySales.totalOrders ?? 0;
  const cashCollected = summarySales.cashSales ?? 0;
  const cardCollected = summarySales.cardSales ?? 0;
  const totalSales = summarySales.totalSales ?? 0;
  const staffEarnedSoFar = staffReportsSorted.reduce(
    (total, staff) => total + resolveShiftEarnedTotal(staff),
    0,
  );
  const staffOrderCountSoFar = staffReportsSorted.reduce(
    (total, staff) => total + resolveShiftActivityCount(staff),
    0,
  );
  const hasStaffEarnedSoFar = staffReportsSorted.some((staff) => resolveShiftActivityCount(staff) > 0);
  const storeEarnedSoFar = hasStaffEarnedSoFar ? staffEarnedSoFar : totalSales;
  const storeOrderCountSoFar = hasStaffEarnedSoFar ? staffOrderCountSoFar : totalOrders;
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
  const otherCollected = Math.max(0, storeEarnedSoFar - cashCollected - cardCollected);
  const totalCashOut = expensesTotal + staffPaymentsTotal + drawerDrops + driverCashGiven;
  const totalCashInAdjustments = driverCashReturned;
  const netAfterExpenses = storeEarnedSoFar - expensesTotal - staffPaymentsTotal;
  const moneyOverviewMessage = loading
    ? t('modals.zReport.closeoutLoading')
    : closeoutReady
      ? t('modals.zReport.clarity.readyHint', { defaultValue: 'Everything checks out -- submit to admin.' })
      : closeoutNeedsStaffCheckout
        ? t('modals.zReport.allStaffCheckoutSubtitle', { count: activeShiftCount })
        : closeoutNeedsCashierCheckout
        ? t('modals.zReport.cashDrawerCheckoutNeeded')
        : closeoutIssueCount > 0
        ? t('modals.zReport.clarity.reviewHint', {
          count: closeoutIssueCount,
          defaultValue: 'Fix {{count}} item(s) below, then submit.',
        })
        : t('modals.zReport.reviewBeforeClose');
  const moneyOverviewCards = [
    {
      key: 'opening',
      label: t('modals.zReport.opening'),
      value: formatMoney(drawerOpening),
      tone: strongTextClass,
      helper: t('modals.zReport.cashDrawer', { defaultValue: 'Cash Drawer' }),
    },
    {
      key: 'earned',
      label: t('modals.zReport.actualEarned'),
      value: formatMoney(storeEarnedSoFar),
      tone: 'text-emerald-600 dark:text-emerald-300',
      helper: `${t('modals.zReport.orders', { defaultValue: 'Orders' })}: ${storeOrderCountSoFar} · ${t('modals.zReport.staff', { defaultValue: 'Staff' })}: ${totalShiftCount}`,
    },
    {
      key: 'expected',
      label: t('modals.zReport.expectedCash'),
      value: formatMoney(expectedCash),
      tone: Math.abs(closeoutDrawerVariance) >= 0.01
        ? 'text-amber-600 dark:text-amber-300'
        : 'text-emerald-600 dark:text-emerald-300',
      helper: t('modals.zReport.netCashPosition', { defaultValue: 'Net Cash Position' }),
    },
    {
      key: 'net',
      label: t('modals.zReport.cashFlow', { defaultValue: 'Cash Flow' }),
      value: formatMoney(netAfterExpenses),
      tone: strongTextClass,
      helper: t('modals.zReport.totalExpenses', { defaultValue: 'Total Expenses' }) + `: ${formatMoney(expensesTotal + staffPaymentsTotal)}`,
    },
  ];
  const moneyFlowRows = [
    { key: 'start', label: t('modals.zReport.opening'), value: formatMoney(drawerOpening), tone: strongTextClass },
    { key: 'cash', label: t('modals.zReport.cashSales'), value: `+${formatMoney(cashCollected)}`, tone: 'text-emerald-600 dark:text-emerald-300' },
    { key: 'card', label: t('modals.zReport.cardSales'), value: formatMoney(cardCollected), tone: strongTextClass },
    ...(otherCollected > 0
      ? [{ key: 'other', label: t('common.other', { defaultValue: 'Other' }), value: formatMoney(otherCollected), tone: strongTextClass }]
      : []),
    { key: 'out', label: t('modals.zReport.totalExpenses'), value: totalCashOut > 0 ? `-${formatMoney(totalCashOut)}` : formatMoney(0), tone: 'text-rose-600 dark:text-rose-300' },
    ...(totalCashInAdjustments > 0
      ? [{ key: 'returned', label: t('modals.zReport.driverCashReturned'), value: `+${formatMoney(totalCashInAdjustments)}`, tone: 'text-emerald-600 dark:text-emerald-300' }]
      : []),
    { key: 'variance', label: t('modals.zReport.variance'), value: formatMoney(closeoutDrawerVariance), tone: closeoutHasVariance ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300' },
  ];
  const drawerRows = Array.isArray(zReport?.drawers) ? zReport.drawers : [];
  const expenseRows = Array.isArray(summaryExpenses.items) ? summaryExpenses.items : [];
  // Round 304: the four tabs read like guided steps -- each carries a short icon + label. The Check
  // step keeps the 'review' key and the clarity.tabReview label (its EN value is now "Check"; el/de/fr/it
  // already read "Check"/"Verify").
  const reportTabs: Array<{
    key: typeof activeTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { key: 'review', label: t('modals.zReport.clarity.tabReview', { defaultValue: 'Check' }), icon: ListChecks, badge: closeoutIssueCount },
    { key: 'money', label: t('modals.zReport.clarity.tabMoney', { defaultValue: 'Money' }), icon: Banknote },
    { key: 'staff', label: t('modals.zReport.staff'), icon: Users },
    { key: 'orders', label: t('modals.zReport.orders'), icon: Receipt, badge: totalOrders },
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
    ? 'border-yellow-400/20 bg-black/35 text-white shadow-2xl shadow-black/25 backdrop-blur-2xl'
    : 'border-yellow-400/25 bg-black/30 text-white shadow-2xl shadow-black/20 backdrop-blur-2xl';
  const dashboardInsetClass = `${modalInsetClassName} text-white`;
  const dashboardTileClass = isDarkTheme
    ? 'border-white/[0.12] bg-white/[0.08] text-white shadow-lg shadow-black/10 backdrop-blur-xl'
    : 'border-white/[0.16] bg-white/[0.1] text-white shadow-lg shadow-black/10 backdrop-blur-xl';

  const renderChecklistIcon = (state: CloseoutChecklistState) => {
    if (state === 'ready') {
      return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    }
    if (state === 'error') {
      return <XCircle className="h-4 w-4 text-rose-500" />;
    }
    if (state === 'pending') {
      return <RefreshCw className="h-4 w-4 text-white/60" />;
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
          className="flex shrink-0 items-center justify-between gap-3 border-b border-yellow-400/15 bg-black/25 px-4 py-3 text-white backdrop-blur-xl"
        >
          {/* Round 322: a calm, human identity block -- "Close day" + the working day as a FRIENDLY
              localized date (e.g. "Wednesday, 25 June 2026"), never a raw ISO string. A small chip says
              whether it is today's live day or a past day. The verdict ("ready"/"needs attention") lives
              ONLY in the status card below, so the header no longer repeats it. */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-yellow-400/20 bg-white/[0.08] backdrop-blur-xl">
              <FileText className={`h-5 w-5 ${softTextClass}`} />
            </div>
            <div className="min-w-0">
              <h2 className={`text-2xl font-black tracking-tight ${strongTextClass}`}>
                {t('modals.zReport.clarity.assistantTitle', { defaultValue: 'Close day' })}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`break-words text-sm font-bold ${softTextClass}`}>{friendlyBusinessDate}</span>
                <span
                  data-z-report-day-chip
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-black ${isLiveDay ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : 'border-white/[0.18] bg-white/[0.08] text-white/70'}`}
                >
                  {isLiveDay ? <CheckCircle className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
                  {isLiveDay
                    ? t('modals.zReport.clarity.dayLive', { defaultValue: 'Today' })
                    : t('modals.zReport.clarity.dayHistorical', { defaultValue: 'Past day' })}
                </span>
              </div>
            </div>
          </div>

          {/* Round 316: the header is now JUST identity + close. Refresh / Print / CSV are no longer a
              competing command bar up here -- they moved into the details panel's tab row as a quiet
              secondary cluster, so the first thing the operator sees is the day, the status, and the steps. */}
          <button
            type="button"
            onClick={onClose}
            className={`flex h-11 w-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl border transition ${glassControlClass}`}
            aria-label={t('common.actions.close')}
          >
            <X className="h-5 w-5" />
          </button>
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
              <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${dashboardInsetClass}`}>
                {t('modals.zReport.loading')}
              </div>
            )}
            {error && (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-700 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        )}

        {/* === Round 320: ONE calm "Close day assistant" panel -- it answers the single question a cashier
            has ("Can I close the day now?") instead of three competing step cards. It holds, top to bottom:
            the compact business-day control + a quiet window/terminal detail line; a large ready/blocked/
            locked verdict with a single issue-count badge; and exactly ONE primary action. The action is a
            3-way mutually-exclusive switch:
              - locked (this terminal cannot close)  -> a calm Locked chip + a plain reason line (no submit),
              - ready (+ executable)                 -> the green submit, with the EXACT preserved gating,
              - blocked                              -> one amber "Review issues" jump to the Review tab.
            Because `lockedTerminal = !canExecuteZReport` is checked first, the green submit branch is reached
            only when `canExecuteZReport && closeoutReady` -- identical to the prior gate. Money / staff /
            order ledgers live behind the secondary detail tabs below. Handlers + aria-labels unchanged. === */}
        <div data-z-report-close-assistant className="flex shrink-0 flex-col gap-2.5">
          <div
            data-z-report-decision-panel
            className={`rounded-3xl border p-4 sm:p-5 ${
              lockedTerminal
                ? 'border-yellow-400/20 bg-black/25'
                : closeoutReady
                  ? 'border-emerald-400/40 bg-emerald-500/[0.08]'
                  : 'border-amber-400/45 bg-amber-400/[0.1]'
            }`}
          >
            {/* The verdict ("Can I close now?") + the single Commit Z report action. */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                {loading ? (
                  <RefreshCw className="mt-1 h-7 w-7 shrink-0 animate-spin text-white/60" />
                ) : lockedTerminal ? (
                  <Lock className="mt-1 h-7 w-7 shrink-0 text-white/60" />
                ) : closeoutReady ? (
                  <CheckCircle className="mt-1 h-8 w-8 shrink-0 text-emerald-400" />
                ) : (
                  <AlertTriangle className="mt-1 h-8 w-8 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0">
                  <div className={`break-words text-2xl font-black leading-tight ${strongTextClass}`}>{closeoutStatusLabel}</div>
                  <div className={`mt-1 max-w-3xl break-words text-sm font-semibold leading-5 ${mutedTextClass}`}>
                    {closeoutSubtitle}
                  </div>
                </div>
              </div>

              {/* The single Commit Z report action: grey when blocked, green when ready. */}
              <div data-z-report-primary-action className="shrink-0">
                <button
                  type="button"
                  onClick={handleSubmitReport}
                  className={`inline-flex min-h-[48px] w-full items-center justify-center rounded-2xl border px-6 text-base font-black transition sm:w-auto ${
                    canCommitZReport
                      ? 'border-emerald-500/40 bg-emerald-600 text-white shadow-lg shadow-emerald-500/20 active:scale-[0.99] active:bg-emerald-500'
                      : 'cursor-not-allowed border-white/[0.14] bg-white/[0.08] text-white/55 opacity-70'
                  }`}
                  disabled={!canCommitZReport}
                  aria-busy={submitting}
                >
                  {submitButtonLabel}
                </button>
              </div>
            </div>

            {/* Technical detail tucked behind a small summary: change the working day, and see From/Until +
                terminal in plain words. Closed by default so the first view stays calm. */}
            <details data-z-report-day-details className="group mt-3">
              <summary className={`flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-xl border px-3 text-xs font-black ${dashboardInsetClass} [&::-webkit-details-marker]:hidden`}>
                <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                <span>{t('modals.zReport.clarity.detailsSummary', { defaultValue: 'Details' })}</span>
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`flex items-center gap-1.5 text-xs font-black ${softTextClass}`}>
                    <CalendarDays className="h-4 w-4" />
                    {t('modals.zReport.clarity.dayStepTitle', { defaultValue: 'Business day' })}
                  </span>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => {
                      setIsUsingLiveDefaultDate(false);
                      setSelectedDate(e.target.value);
                    }}
                    className={`min-h-[44px] flex-1 rounded-xl border px-3 py-2 text-center text-sm font-black outline-none sm:flex-none ${glassControlClass}`}
                    aria-label={t('modals.zReport.selectBusinessDay')}
                    disabled={lockDate}
                  />
                </div>
                <div className={`break-words text-[11px] font-semibold ${softTextClass}`}>
                  {t('modals.zReport.clarity.from', { defaultValue: 'From' })}: {formatWindowDateTime(resolvedPeriod.start)} · {t('modals.zReport.clarity.until', { defaultValue: 'Until' })}: {formatWindowDateTime(resolvedPeriod.end)} · {t('modals.zReport.terminal')}: {zReport?.terminalName || '—'}
                </div>
              </div>
            </details>

            {submitResult && (
              <div className="mt-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs font-bold leading-5 text-emerald-800 dark:text-emerald-200">
                {submitResult}
              </div>
            )}
          </div>
        </div>

        {/* === Details: progressive-disclosure ledgers behind tabs (Money / Staff / Orders / Issues) === */}
        <div
          data-z-report-details
          className={`mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border ${dashboardPanelClass}`}
        >
            {/* Round 316: detail step tabs (the progressive-disclosure ledgers) share their row with the
                quiet secondary tools cluster (Refresh / Print / CSV) that used to crowd the header. Tabs lead
                on the left; the tools sit right, deliberately muted -- reachable, never competing with the
                three close-day steps above. */}
            <div className="flex shrink-0 flex-col gap-2 border-b border-white/10 p-3 lg:flex-row lg:items-center">
              <div className="grid flex-1 rounded-xl border border-white/[0.12] bg-black/10 p-1 backdrop-blur-xl sm:grid-cols-4">
                {reportTabs.map((tab) => {
                  const TabIcon = tab.icon;
                  return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 text-sm font-black transition-transform duration-150 active:scale-[0.98] ${
                      activeTab === tab.key
                        ? 'bg-yellow-400 text-black shadow-lg shadow-yellow-500/20'
                        : isDarkTheme
                          ? 'text-white/70'
                          : 'text-white/70'
                    }`}
                  >
                    <TabIcon className="h-4 w-4" />
                    <span>{tab.label}</span>
                    {typeof tab.badge === 'number' && tab.badge > 0 && (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-black ${activeTab === tab.key ? 'bg-black/15 text-black' : 'bg-amber-500/20 text-amber-700 dark:text-amber-200'}`}>{tab.badge}</span>
                    )}
                  </button>
                  );
                })}
              </div>
              <div
                data-z-report-utility-tools
                className="flex items-center justify-end gap-1 rounded-xl border border-white/[0.1] bg-white/[0.04] p-1 backdrop-blur-xl"
              >
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
                      className={`inline-flex h-9 min-h-[44px] items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold ${softTextClass} transition active:bg-white/[0.12] ${action.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                      aria-label={action.label}
                    >
                      <Icon className={`h-4 w-4 ${action.key === 'refresh' && loading ? 'animate-spin' : ''}`} />
                      <span className="hidden md:inline">{action.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div data-z-report-center-scroll className="min-h-0 flex-1 overflow-y-auto p-4 pb-6 scroll-pb-6 scrollbar-hide">
              {activeTab === 'money' && (
                <div data-z-report-modern-summary className="space-y-4">
                  {/* Round 316: the two money facts that used to sit on the first screen (Total sales +
                      Expected cash) now lead the Money tab, so they stay one tap away without crowding the
                      close-day steps. */}
                  <div data-z-report-money-glance className="grid grid-cols-2 gap-3">
                    <div className={`rounded-2xl border p-3 ${dashboardTileClass}`}>
                      <div className={`flex items-center gap-1.5 text-[11px] font-bold ${softTextClass}`}><Banknote className="h-3.5 w-3.5" />{t('modals.zReport.clarity.totalSales', { defaultValue: 'Total sales' })}</div>
                      <div className="mt-0.5 break-words text-lg font-black text-emerald-600 dark:text-emerald-300">{formatMoney(totalSales)}</div>
                    </div>
                    <div className={`rounded-2xl border p-3 ${dashboardTileClass}`}>
                      <div className={`flex items-center gap-1.5 text-[11px] font-bold ${softTextClass}`}><ShieldCheck className="h-3.5 w-3.5" />{t('modals.zReport.clarity.expectedCash', { defaultValue: 'Expected cash' })}</div>
                      <div className={`mt-0.5 break-words text-lg font-black ${strongTextClass}`}>{formatMoney(expectedCash)}</div>
                    </div>
                  </div>
                  <section data-z-report-money-reconciliation className="space-y-4">
                    <div>
                      <h3 className={`text-2xl font-black ${strongTextClass}`}>{t('modals.zReport.moneyReconciliation')}</h3>
                    </div>

                    <div className={`rounded-2xl border p-4 ${dashboardInsetClass}`}>
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
                  </section>
                </div>
              )}

              {(activeTab === 'review' || activeTab === 'money' || activeTab === 'staff' || activeTab === 'orders') && (
                <div data-z-report-modern-details className="space-y-4">
                  {activeTab === 'money' && (
                    <section className="grid gap-4 2xl:grid-cols-2">
                      <div className={`rounded-2xl border p-4 ${dashboardInsetClass}`}>
                        <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.drawerLedger')}</h3>
                        <div className="mt-4 space-y-3">
                          {drawerRows.length > 0 ? drawerRows.map((drawer) => {
                            const expected = resolveDrawerExpectedAmount(drawer);
                            const variance = Number(drawer.variance || 0);
                            const status = getDrawerStatusBadge(drawer);
                            const stats = [
                              { key: 'opening', label: t('modals.zReport.opening'), value: drawer.opening, tone: strongTextClass },
                              { key: 'cash', label: t('modals.zReport.cashSales'), value: drawer.cashSales, tone: 'text-amber-600 dark:text-amber-300' },
                              { key: 'card', label: t('modals.zReport.cardSales'), value: drawer.cardSales, tone: 'text-amber-600 dark:text-amber-300' },
                              { key: 'drops', label: t('modals.zReport.drops'), value: drawer.drops, tone: strongTextClass },
                              { key: 'given', label: t('modals.zReport.driverCashGiven'), value: drawer.driverCashGiven, tone: 'text-orange-600 dark:text-orange-300' },
                              { key: 'returned', label: t('modals.zReport.driverCashReturned'), value: drawer.driverCashReturned, tone: 'text-white/70' },
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

                                <div className="mt-4 rounded-2xl border border-white/[0.12] bg-black/10 p-4">
                                  <div className={`text-[11px] font-black uppercase tracking-[0.12em] ${softTextClass}`}>{t('modals.zReport.expected')}</div>
                                  <div className="mt-2 text-3xl font-black text-emerald-600 dark:text-emerald-300">{formatMoney(expected)}</div>
                                </div>

                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                                  {stats.map((row) => (
                                    <div key={row.key} className="min-w-0 rounded-2xl border border-white/[0.12] bg-black/10 p-3">
                                      <div className={`break-words text-xs font-black leading-4 ${softTextClass}`}>{row.label}</div>
                                      <div className={`mt-1 break-words text-base font-black ${row.tone}`}>{formatMoney(row.value)}</div>
                                    </div>
                                  ))}
                                </div>
                              </article>
                            );
                          }) : (
                            <div className="rounded-2xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-white/65">{t('modals.zReport.noDrawers')}</div>
                          )}
                        </div>
                      </div>

                      <div className={`rounded-2xl border p-4 ${dashboardInsetClass}`}>
                        <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.expenseLedger')}</h3>
                        <div className="mt-4 space-y-2">
                          {expenseRows.length > 0 ? expenseRows.map((expense) => (
                            <div key={expense.id} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-2xl border p-3 ${dashboardTileClass}`}>
                              <div className="min-w-0">
                                <div className="truncate text-sm font-black">{expense.description}</div>
                                <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>{expense.staffName || expense.expenseType || '-'}</div>
                              </div>
                              <div className="text-right text-sm font-black text-rose-600 dark:text-rose-300">{formatMoney(expense.amount)}</div>
                            </div>
                          )) : (
                            <div className="rounded-2xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-white/65">{t('modals.zReport.noExpenseDetails')}</div>
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
                          /* Round 321: only go two-column when there is more than one staff report -- a lone
                             staff card then uses the full content width instead of rendering as a half-width
                             column with an empty second track and a hard vertical split. */
                          <div className={`grid gap-3 ${staffReportsSorted.length > 1 ? 'xl:grid-cols-2' : 'grid-cols-1'}`}>
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
                                { key: 'card', label: t('modals.zReport.card'), value: formatMoney(staff.orders?.cardAmount), tone: 'text-amber-600 dark:text-amber-300' },
                                { key: 'return', label: t('modals.zReport.cashToReturn'), value: formatMoney(resolveStaffReturnAmount(staff)), tone: 'text-white/70' },
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
                                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getRoleBadgeClasses(staff.role)}`}>{translateRoleName(t, staff.role || '')}</span>
                                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getShiftStatusBadgeClasses(statusValue)}`}>{statusLabel}</span>
                                    </div>
                                  </div>

                                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    {statRows.map((row) => (
                                      <div key={row.key} className="min-w-0 rounded-2xl border border-white/[0.12] bg-black/10 p-3">
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
                          <div className="rounded-2xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-white/65">{t('modals.zReport.noStaffReports')}</div>
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
                                    ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20'
                                    : 'text-white/70 active:bg-white/[0.1]'
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
                                    : 'text-white/70 active:bg-white/[0.1]'
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
                          <div key={order.id || index} className={`grid gap-3 rounded-2xl border p-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_auto] ${dashboardTileClass}`}>
                            <div className="min-w-0">
                              <div className={`truncate text-sm font-black ${strongTextClass}`}>{order.orderNumber || '—'}</div>
                              <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>{order.staffName}</div>
                            </div>
                            <div className={`text-xs font-semibold ${softTextClass}`}>{localizeZReportOrderType(order.orderType, t)} · {localizeZReportPaymentLabel(order.paymentMethod, t)}</div>
                            <div className="text-right text-sm font-black text-emerald-600 dark:text-emerald-300">{formatMoney(order.amount)}</div>
                          </div>
                        )) : (
                          <div className="rounded-2xl border border-dashed border-white/[0.16] bg-white/[0.04] p-6 text-center text-sm font-semibold text-white/65">{t('modals.zReport.noOrdersMatchFilter')}</div>
                        )}
                      </div>
                    </section>
                  )}

                  {activeTab === 'review' && (
                    <div className="space-y-3">
                      <section data-z-report-review-money-overview className={`rounded-2xl border p-4 ${dashboardInsetClass}`}>
                        <div className="flex flex-col gap-4 xl:flex-row xl:items-stretch">
                          <div className="min-w-0 flex-1 rounded-2xl border border-yellow-400/25 bg-yellow-400/[0.08] p-4">
                            <div className={`text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                              {t('modals.zReport.tabs.overview', { defaultValue: 'Overview' })}
                            </div>
                            <div className="mt-2">
                              <div className="min-w-0">
                                <div className={`break-words text-sm font-bold ${mutedTextClass}`}>
                                  {t('modals.zReport.actualEarned')}
                                </div>
                                <div className="mt-1 break-words text-4xl font-black leading-none text-yellow-300 sm:text-5xl">
                                  {formatMoney(storeEarnedSoFar)}
                                </div>
                                <div data-z-report-earned-source className={`mt-2 break-words text-xs font-black uppercase tracking-[0.08em] ${softTextClass}`}>
                                  {t('modals.zReport.liveCurrentWindow')} · {t('modals.zReport.totalShifts')}: {totalShiftCount} · {t('common.status.active', { defaultValue: 'Active' })}: {activeShiftCount} · {t('common.status.closed', { defaultValue: 'Closed' })}: {closedShiftCount}
                                </div>
                              </div>
                            </div>
                            <div className={`mt-3 break-words text-sm font-semibold leading-6 ${mutedTextClass}`}>
                              {moneyOverviewMessage}
                            </div>
                          </div>

                          <div className="grid min-w-0 flex-[1.35] grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {moneyOverviewCards.map((item) => (
                              <div key={item.key} className={`rounded-2xl border p-3 ${dashboardTileClass}`}>
                                <div className={`break-words text-[11px] font-black uppercase tracking-[0.08em] ${softTextClass}`}>
                                  {item.label}
                                </div>
                                <div className={`mt-1 break-words text-xl font-black ${item.tone}`}>{item.value}</div>
                                <div className={`mt-1 break-words text-[11px] font-semibold leading-4 ${softTextClass}`}>
                                  {item.helper}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="mt-3 rounded-2xl border border-white/[0.12] bg-black/10 p-3">
                          <div className={`mb-2 text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                            {t('modals.zReport.cashFlow', { defaultValue: 'Cash Flow' })}
                          </div>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
                            {moneyFlowRows.map((row) => (
                              <div key={row.key} className="min-w-0 rounded-xl border border-white/[0.1] bg-white/[0.04] p-2.5">
                                <div className={`truncate text-[11px] font-bold ${softTextClass}`}>{row.label}</div>
                                <div className={`mt-1 truncate text-sm font-black ${row.tone}`}>{row.value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </section>

                      {/* Round 312: the at-a-glance checks live in the compact checks row above the tabs. Here
                          we drill into ONLY the checks that still need action (so a clean day stays short),
                          keep the full payment-blocker resolve panel for real blockers, and show a brief
                          all-clear when the day is ready -- no green-tick walls. */}
                      {closeoutChecklistItems.filter((item) => item.state !== 'ready').map((item) => (
                        <div key={item.key} className={`flex items-start gap-3 rounded-2xl border p-3 ${dashboardInsetClass}`}>
                          <div className="shrink-0">{renderChecklistIcon(item.state)}</div>
                          <div className="min-w-0 flex-1">
                            <div className={`break-words text-sm font-black ${strongTextClass}`}>{item.label}</div>
                            <div className={`mt-0.5 break-words text-xs font-semibold leading-5 ${mutedTextClass}`}>{item.description}</div>
                          </div>
                          <span
                            className={`shrink-0 text-[11px] font-black ${
                              item.state === 'error'
                                ? 'text-rose-600 dark:text-rose-300'
                                : item.state === 'pending'
                                  ? softTextClass
                                  : 'text-amber-600 dark:text-amber-300'
                            }`}
                          >
                            {item.actionLabel ?? closeoutStateLabel(item.state)}
                          </span>
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

                      {closeoutReady && (
                        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-center text-sm font-bold text-emerald-700 dark:text-emerald-200">
                          {t('modals.zReport.clarity.readyHint', { defaultValue: 'Everything checks out -- submit to admin.' })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
        </div>
      </div>
    </LiquidGlassModal>
  );

};

export default ZReportModal;
