import twintLogo from '../../../../../shared/payments/assets/twint-logo.png';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { translateRoleName } from '../../utils/role-labels';
import { CashierRecovery } from '../../contexts/cashier-gate-context';
import { useShift } from '../../contexts/shift-context';
import { useTheme } from '../../contexts/theme-context';
import { useFeatures } from '../../hooks/useFeatures';
import type {
  ZReportData,
  ZReportDayOrder,
  ZReportFiscalQueue,
  ZReportGiftCloseBlocker,
  ZReportPhoneShiftHandover,
} from '../../types/reports';
import { getSyncQueueBridge } from '../../services/SyncQueueBridge';
import ZReportExportDialog, { type ZReportExportKind } from './ZReportExportDialog';
import { formatCurrency, formatDate, formatTime } from '../../utils/format';
import { parseLocalDateString, toLocalDateString } from '../../utils/date';
import { clearBusinessDayStorage } from '../../utils/session-utils';
import {
  GIFT_CLOSE_LABELS,
  classifyGiftCloseFinalizationError,
  giftCloseRecoveryKey,
  giftCloseStaffLabel,
  normalizeZReportData,
  resolvePersistedZReportId,
  resolveShiftActivityCount,
  resolveShiftEarnedTotal,
  resolveShiftWindow,
  resolveZReportGiftClose,
  resolveZReportPeriod,
  resolveZReportPresentation,
  resolveZReportTwintTotal,
} from '../../utils/zReport';
import {
  readUnitShiftReadinessRemembered,
  readinessSinceFromPeriodStart,
  unitHasPhones,
  unitIsQuiet,
  type RememberedUnitReadiness,
  unitShiftCashToReceive,
  unitShiftPhoneLabel,
  unitShiftPhoneState,
  unitShiftStaffLabel,
  type UnitReadinessResult,
  type UnitShift,
} from '../../utils/unit-shift-readiness';
import {
  closedShiftInZWindow,
  extractUnitShiftsZRefusal,
  frozenZCutoffMs,
  phoneShiftCurrency,
  phoneShiftRowFromReadiness,
  phoneShiftRowFromStoredZ,
  unitShiftHoldsZ,
  type PhoneShiftStaffRow,
  type UnitShiftsZRefusal,
} from './z-report/phone-shifts';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { heldEditClosingKey, UnsettledPaymentBlockersPanel } from '../ui/UnsettledPaymentBlockersPanel';
import { setAsideResolvingKey } from '../../utils/paymentSetAside';
import { unsavedResolvingKey, unsavedSavingKey } from '../../utils/unsavedPayments';
import {
  listTwintReturnedOutsidePos,
  resolveReturnedTwintReceipt,
  type TwintReturnedReceipt,
} from '../../services/TwintReceiptRecoveryService';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import {
  useRecordPaymentBlocker,
  type RecordPaymentBlockerOutcome,
} from '../../hooks/useRecordPaymentBlocker';
import { isNewOrderCheckoutBlocker } from '../ui/UnsettledPaymentBlockersPanel';
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
  formatSetAsidePaymentMessage,
  getLocalizedPaymentMethod,
  paymentBlockerKey,
} from '../../../lib/payment-integrity';
import { extractPrivilegedActionError } from '../../utils/privileged-actions';
import { formatFiscalCloseBlockedError } from '../../../lib/fiscal-closeout';

interface ZReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  branchId: string;
  date?: string; // yyyy-mm-dd
  lockDate?: boolean;
}

type CloseoutChecklistState = 'ready' | 'warning' | 'error' | 'pending';

/**
 * The submit answer, with the local close of a Z without a connection
 * (offline week, founder 21/10/2026): `{ success, localClose, pendingUpload,
 * zReportId, reportDate, localDayClosed }`.
 */
type LocalCloseAwareSubmitResponse = ZReportSubmitResponse & {
  localClose?: boolean;
  pendingUpload?: boolean;
  reportDate?: string;
};

/** How long the local-close message stays before the day restarts. */
const LOCAL_CLOSE_RELOAD_DELAY_MS = 6000;

// English fallbacks of the shared `phoneShifts.handover.*` keys.
const PHONE_SHIFT_HANDOVER_LABELS: Record<ZReportPhoneShiftHandover, string> = {
  received: 'Received',
  pending: 'To receive',
  none: 'Nothing to hand over',
  not_counted: 'Not counted',
};

function extractErrorMessage(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const message = formatOperatorFacingError(error, fallback, t);
  if (['ORDER_CURRENCY_UNAVAILABLE', 'PAYMENT_CURRENCY_UNAVAILABLE', 'ORIGINAL_CURRENCY_UNAVAILABLE'].includes(message.trim())) {
    return t('modals.zReport.recordPaymentOriginalCurrencyMissing');
  }
  return message;
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
  if (normalizeZReportSlug(value) === 'twint') return 'TWINT';
  const key = ({
    cash: 'cash',
    card: 'card',
    split: 'split',
    room_charge: 'roomCharge',
    platform_online: 'platformOnline',
    platform_cod: 'platformCod',
    pending: 'pending',
    unpaid: 'unpaid',
    unknown: 'unknown',
  } as Record<string, string>)[normalizeZReportSlug(value)];
  if (!key) {
    return t('modals.zReport.paymentLabels.unknown', { defaultValue: 'Unknown' });
  }
  return t(`modals.zReport.paymentLabels.${key}`, { defaultValue: key });
}

// Platform-settled tenders (efood/wolt prepaid online, or COD the platform's own
// rider collected) share one «Platforms» chip in the Orders tab filter.
function isPlatformTender(value: unknown): boolean {
  const slug = normalizeZReportSlug(value);
  return slug === 'platform_online' || slug === 'platform_cod';
}

// The fiscal close-day guard's view of this Z (native `fiscalQueue`), or null
// when the preview carries none (older build, or the queue could not be read:
// the submit's own guard still decides).
function resolveFiscalQueue(report: ZReportData | null): ZReportFiscalQueue | null {
  const candidate = report?.fiscalQueue;
  if (!candidate || typeof candidate !== 'object' || !('blocking' in candidate)) {
    return null;
  }
  return candidate;
}

// A report day ("2026-09-29") in the screen's date format; unparseable input
// is shown as is rather than as a dash.
function formatFiscalBusinessDay(isoDay: string): string {
  const parsed = parseLocalDateString(isoDay);
  if (Number.isNaN(parsed.getTime())) {
    return isoDay;
  }
  return formatDate(parsed, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const ZReportModal: React.FC<ZReportModalProps> = ({
  isOpen,
  onClose,
  branchId,
  date,
  lockDate = false,
}) => {
  const bridge = getBridge();
  const { clearShift, staff, activeShift } = useShift();
  const { runWithPrivilegedConfirmation, confirmationModal } = usePrivilegedActionConfirmation();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { isFeatureEnabled, isMainTerminal, isMobileWaiter, loading: featuresLoading, parentTerminalId } = useFeatures();
  const isDarkTheme = resolvedTheme === 'dark';
  const modalContentClassName = isDarkTheme
    ? 'z-report-glass-content overflow-hidden! p-4! text-white'
    : 'z-report-glass-content overflow-hidden! p-4! text-slate-950';
  const modalShellClassName = isDarkTheme
    ? 'z-report-glass-shell border-yellow-400/25 text-white shadow-2xl shadow-black/40'
    : 'z-report-glass-shell border-yellow-500/30 text-slate-950 shadow-2xl shadow-slate-950/20';
  const modalInsetClassName = isDarkTheme
    ? 'border-yellow-400/15 bg-black/30 shadow-xs shadow-black/20 backdrop-blur-xl'
    : 'border-yellow-500/25 bg-white/70 shadow-xs shadow-slate-950/10 backdrop-blur-xl';
  const strongTextClass = isDarkTheme ? 'text-white' : 'text-slate-950';
  const mutedTextClass = isDarkTheme ? 'text-white/85' : 'text-slate-700';
  const softTextClass = isDarkTheme ? 'text-white/60' : 'text-slate-500';
  const glassControlClass = isDarkTheme
    ? 'border-yellow-400/20 bg-black/30 text-white shadow-xs shadow-black/10 backdrop-blur-xl active:bg-white/12'
    : 'border-yellow-500/25 bg-white/80 text-slate-900 shadow-xs shadow-slate-950/10 backdrop-blur-xl active:bg-white';
  const canExecuteZReport =
    isFeatureEnabled('zReportExecution') ||
    (!featuresLoading && (isMainTerminal || (!isMobileWaiter && !parentTerminalId)));
  const showMainTerminalWarning = !featuresLoading && !canExecuteZReport;
  // Round 320: terminal capability is kept separate from report warnings so the submit gate can match
  // the native closeout preconditions exactly.
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
  // A payment set aside as a possible duplicate, waiting for the operator to
  // confirm it was given back (always asked, then authorized: 30/09/2026).
  const [setAsideConfirmation, setSetAsideConfirmation] = useState<UnsettledPaymentBlocker | null>(null);
  const [unsavedConfirmation, setUnsavedConfirmation] = useState<UnsettledPaymentBlocker | null>(null);
  // A cashier-confirmed TWINT receipt that can never be saved, waiting for a
  // manager to record it as returned through TWINT outside the POS, with a
  // reference (fix review 06/10/2026).
  const [twintReturn, setTwintReturn] = useState<UnsettledPaymentBlocker | null>(null);
  const [twintReturnReference, setTwintReturnReference] = useState('');
  const [twintReturnPin, setTwintReturnPin] = useState('');
  const [twintReturnError, setTwintReturnError] = useState<string | null>(null);
  const [twintReturned, setTwintReturned] = useState<TwintReturnedReceipt[]>([]);
  const [retryingFiscalQueue, setRetryingFiscalQueue] = useState(false);
  // The export picker (founder, 14/10/2026): every Z export reads a stored Z.
  const [exportDialogIntent, setExportDialogIntent] = useState<ZReportExportKind | null>(null);
  const [reportReloadVersion, setReportReloadVersion] = useState(0);
  // The till's own connection (native health probe). Offline the day cannot
  // close, so the checklist must not read "No sync blocker detected" (offline
  // audit 07/10/2026). Informational: the native Z refusal decides.
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  // Phone shifts of this Main's unit (founder rule 13/10/2026): the latest
  // server read and the window it was made for. A read made for another
  // window never counts.
  const [phoneShiftsRead, setPhoneShiftsRead] = useState<{
    key: string;
    result: UnitReadinessResult;
    /** The last good read (this one, or the remembered one when it failed). */
    lastGood?: RememberedUnitReadiness | null;
  } | null>(null);
  const [phoneShiftsReading, setPhoneShiftsReading] = useState(false);
  const [phoneShiftsReadVersion, setPhoneShiftsReadVersion] = useState(0);
  const phoneShiftsSeqRef = useRef(0);
  // When the shown preview arrived: a live preview ends at its build moment,
  // a frozen (issued) Z window at its cutoff.
  const [zReportReceivedAt, setZReportReceivedAt] = useState<number | null>(null);
  const wasOpenRef = useRef(false);
  const pendingOpenDateRef = useRef<string | null>(null);
  // Async results (print, submit, blocker resolve) belong to the open + branch + business day that
  // started them. The scope bumps synchronously on every change, so a late result is dropped instead
  // of landing on the report the operator switched to.
  const statusScopeRef = useRef(0);
  useLayoutEffect(() => {
    statusScopeRef.current += 1;
    setPrinting(false);
    setSubmitting(false);
    setResolvingBlockerKey(null);
    return () => { statusScopeRef.current += 1; };
  }, [branchId, isOpen, selectedDate]);

  const [orderTypeFilter, setOrderTypeFilter] = useState<'all' | 'delivery' | 'dine-in' | 'pickup'>('all');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState<'all' | 'cash' | 'card' | 'twint' | 'platform'>('all');

  const filterOrders = (orders: any[] | null | undefined): any[] => {
    if (!orders || !Array.isArray(orders)) return [];
    return orders.filter(o => {
      if (!o) return false;
      const typeMatch = orderTypeFilter === 'all' || o.orderType === orderTypeFilter;
      // «Platforms» = every platform order: the platform-settled ones AND the
      // ones our own driver delivered for the platform (cash/card in hand).
      const paymentMatch = paymentMethodFilter === 'all'
        || (paymentMethodFilter === 'platform'
          ? Boolean(o.platform) || isPlatformTender(o.paymentMethod)
          : o.paymentMethod === paymentMethodFilter);
      return typeMatch && paymentMatch;
    });
  };

  const reportSections = resolveZReportPresentation(zReport);
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

  // Founder (06/09/2026): the Orders tab must list every order of the day,
  // store AND platform. Platform orders (efood/wolt) carry no staff shift, so
  // they never enter staffReports[].ordersDetails; the Z builder now emits a
  // day-level list (`dayOrders`, same predicate as the headline count).
  // Reports persisted before 1.4.97 lack it and fall back to the staff union.
  type ZReportOrderRow = ZReportDayOrder & { staffName?: string | null };
  const dayOrderDetails = useMemo<ZReportOrderRow[]>(() => {
    const staffNameByShiftId = new Map<string, string>();
    staffReportsSorted.forEach((staff) => {
      if (staff.staffShiftId) {
        staffNameByShiftId.set(staff.staffShiftId, staff.staffName || staff.staffId);
      }
    });
    if (Array.isArray(zReport?.dayOrders)) {
      return zReport.dayOrders.map((order) => ({
        ...order,
        staffName: order.staffName
          || (order.staffShiftId ? staffNameByShiftId.get(order.staffShiftId) : undefined)
          || null,
      }));
    }
    return staffReportsSorted.flatMap((staff) =>
      Array.isArray(staff.ordersDetails)
        ? staff.ordersDetails.map((order) => ({
          ...order,
          staffName: staff.staffName || staff.staffId,
        }))
        : [],
    );
  }, [staffReportsSorted, zReport]);
  const dayOrderDetailCount = dayOrderDetails.length;

  const giftClose = useMemo(() => resolveZReportGiftClose(zReport), [zReport]);
  const reportCurrency = typeof zReport?.currency === 'string' && /^[A-Z]{3}$/.test(zReport.currency)
    ? zReport.currency : null;
  const formatMoney = (value?: number) => formatCurrency(value ?? 0, reportCurrency);
  const staffTipRows = (Array.isArray(zReport?.staffTips) ? zReport?.staffTips ?? [] : [])
    .filter((tip) => Number.isFinite(tip?.amount) && Math.abs(tip.amount) >= 0.005);
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
      setSetAsideConfirmation(null);
      setRetryingFiscalQueue(false);
      setExportDialogIntent(null);
      setZReport(null);
      setZReportReceivedAt(null);
      setPhoneShiftsRead(null);
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
        setZReportReceivedAt(Date.now());

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

  // "Record cash" / "Record card" (item F, 30/09/2026; parity with Android's
  // "Record the payment"): recording money no one collected is a sensitive
  // action. Confirmed first, then approved like the other money actions on
  // this terminal (cashier or manager shift + PIN); the till keys it
  // `z-record:<order>:<cents>` and audits who recorded it, with
  // `charged: false`. Nothing is ever charged.
  // The report scope the record was started on: a late answer for a branch or
  // day the operator has left is dropped, like every other async result here.
  const recordScopeRef = useRef<number | null>(null);
  const handleRecordBlockerOutcome = useCallback(
    (
      blocker: UnsettledPaymentBlocker,
      method: 'cash' | 'card',
      outcome: RecordPaymentBlockerOutcome,
    ) => {
      const startedScope = recordScopeRef.current;
      recordScopeRef.current = null;
      if (startedScope !== null && statusScopeRef.current !== startedScope) return;
      const methodLabel = t(
        method === 'cash' ? 'modals.zReport.cash' : 'modals.zReport.card',
      ).toLowerCase();
      switch (outcome.kind) {
        case 'cancelled':
          return;
        case 'shift_required':
          setSubmitResult(
            t('modals.zReport.setAsideShiftRequired', {
              defaultValue:
                'A cashier or manager has to be checked in on this terminal to confirm it.',
            }),
          );
          return;
        case 'refused': {
          const paymentIntegrityPayload = extractPaymentIntegrityPayload(outcome.result);
          if (paymentIntegrityPayload?.blockers?.length) {
            setPaymentBlockers(paymentIntegrityPayload.blockers);
          }
          setSubmitResult(
            t('modals.zReport.resolveBlockerFailed', {
              orderNumber: blocker.orderNumber,
              error: extractErrorMessage(
                outcome.result,
                t('modals.zReport.submissionFailed'),
                t,
              ),
            }),
          );
          setReportReloadVersion((current) => current + 1);
          return;
        }
        case 'failed': {
          const paymentIntegrityPayload = extractPaymentIntegrityPayload(outcome.error);
          if (paymentIntegrityPayload?.blockers?.length) {
            setPaymentBlockers(paymentIntegrityPayload.blockers);
          }
          setSubmitResult(
            t('modals.zReport.resolveBlockerFailed', {
              orderNumber: blocker.orderNumber,
              error: extractErrorMessage(
                outcome.error,
                t('modals.zReport.submissionFailed'),
                t,
              ),
            }),
          );
          return;
        }
        case 'already_recorded':
          setError(null);
          setSubmitResult(
            t('modals.zReport.recordAlreadyRecorded', {
              orderNumber: blocker.orderNumber,
              method: methodLabel,
              defaultValue:
                'This {{method}} payment for {{orderNumber}} was already recorded. Nothing was added.',
            }),
          );
          setReportReloadVersion((current) => current + 1);
          return;
        case 'recorded':
          setError(null);
          setSubmitResult(
            t('modals.zReport.resolveBlockerSuccess', {
              orderNumber: blocker.orderNumber,
              method: methodLabel,
            }),
          );
          setReportReloadVersion((current) => current + 1);
      }
    },
    [t],
  );

  const recordBlocker = useRecordPaymentBlocker({
    runWithPrivilegedConfirmation,
    record: (blocker, method, amountCents) => {
      recordScopeRef.current = statusScopeRef.current;
      setSubmitResult(null);
      return bridge.reports.resolvePaymentBlocker({
        orderId: blocker.orderId,
        method,
        amountCents,
      });
    },
    onOutcome: handleRecordBlockerOutcome,
    setBusyKey: setResolvingBlockerKey,
    formatMoney,
  });
  // The panel's "Record cash" / "Record card": opens the confirmation.
  const handleResolveBlocker = recordBlocker.requestRecord;

  // "Money given back to the customer" for a set-aside payment. Asked first in
  // a confirmation dialog, then authorized like a money action on this
  // terminal (cashier or manager shift + PIN). Local only: the server never
  // recorded the payment. The report is read again so the blocker only
  // disappears once a fresh check no longer finds it.
  const handleConfirmSetAsideReturned = useCallback(async () => {
    const blocker = setAsideConfirmation;
    const paymentId = blocker?.reviewPayment?.paymentId;
    if (!blocker || !paymentId) {
      setSetAsideConfirmation(null);
      return;
    }
    setSetAsideConfirmation(null);
    setResolvingBlockerKey(setAsideResolvingKey(paymentId));
    setSubmitResult(null);
    try {
      const resolvedBy =
        (staff as { databaseStaffId?: string } | null | undefined)?.databaseStaffId
        || activeShift?.staff_id
        || null;
      const result = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: () =>
          bridge.payments.resolveSetAsidePayment({
            paymentId,
            outcome: 'returned_to_customer',
            resolvedBy,
          }),
        title: t('modals.zReport.setAsideApprovalTitle', {
          defaultValue: 'Confirm the money was given back',
        }),
        subtitle: t('modals.zReport.setAsideApprovalSubtitle', {
          defaultValue: 'Enter the cashier or manager PIN to confirm it.',
        }),
      });
      setSubmitResult(
        result?.alreadyResolved
          ? t('modals.zReport.setAsideAlreadyResolved', {
            defaultValue: 'This payment was already recorded as given back.',
          })
          : t('modals.zReport.setAsideResolved', {
            defaultValue: 'Recorded as given back to the customer. It stays out of the totals.',
          }),
      );
    } catch (e: unknown) {
      const privilegedError = extractPrivilegedActionError(e, 'cash_drawer_control');
      if (
        privilegedError?.code === 'UNAUTHORIZED'
        && /shift/i.test(privilegedError.reason ?? '')
      ) {
        setSubmitResult(
          t('modals.zReport.setAsideShiftRequired', {
            defaultValue:
              'A cashier or manager has to be checked in on this terminal to confirm it.',
          }),
        );
      } else if (e instanceof Error && e.message === 'Privileged action confirmation cancelled') {
        // The operator closed the PIN prompt: nothing was recorded.
      } else {
        setSubmitResult(
          t('modals.zReport.setAsideResolveFailed', {
            error: extractErrorMessage(e, t('modals.zReport.unknownError'), t),
            defaultValue: 'Could not record it: {{error}}',
          }),
        );
      }
    } finally {
      setResolvingBlockerKey(null);
      setReportReloadVersion((current) => current + 1);
    }
  }, [activeShift?.staff_id, bridge, runWithPrivilegedConfirmation, setAsideConfirmation, staff, t]);

  // "Save payment again" for a card charged on this till whose payment is not
  // saved yet: the same write and key, no new charge. The report is read
  // again so the blocker only disappears on a fresh check (30/09/2026).
  const handleSaveUnsavedAgain = useCallback(async (blocker: UnsettledPaymentBlocker) => {
    const idempotencyKey = blocker.unsavedPayment?.idempotencyKey;
    if (!idempotencyKey) return;
    setResolvingBlockerKey(unsavedSavingKey(idempotencyKey));
    setSubmitResult(null);
    try {
      const result = await bridge.payments.saveUnsavedPayments({ idempotencyKey });
      const setAside = Array.isArray(result?.setAside) ? result.setAside : [];
      if (Number(result?.saved || 0) > 0) {
        setSubmitResult(t('modals.zReport.unsavedSaved', { defaultValue: 'Payment saved.' }));
      } else if (setAside.length > 0) {
        setSubmitResult(
          formatSetAsidePaymentMessage(setAside[0], t, formatMoney)
            ?? t('modals.zReport.unsavedSaved', { defaultValue: 'Payment saved.' }),
        );
      } else {
        setSubmitResult(
          t('modals.zReport.unsavedStillNotSaved', {
            defaultValue:
              'Still not saved on this till. Do not charge again. Try again, or give the money back to the customer and confirm it here.',
          }),
        );
      }
    } catch (e: unknown) {
      setSubmitResult(
        t('modals.zReport.unsavedStillNotSaved', {
          defaultValue:
            'Still not saved on this till. Do not charge again. Try again, or give the money back to the customer and confirm it here.',
        }),
      );
      console.warn('[ZReportModal] Save payment again failed:', e);
    } finally {
      setResolvingBlockerKey(null);
      setReportReloadVersion((current) => current + 1);
    }
  }, [bridge, formatMoney, t]);

  // "Money given back to the customer" for a card charged and never saved:
  // asked first in a confirmation dialog, then authorized like the other
  // money actions (cashier or manager shift + PIN). The audit is written
  // before the record goes; the order is left as it is.
  const handleConfirmUnsavedReturned = useCallback(async () => {
    const blocker = unsavedConfirmation;
    const idempotencyKey = blocker?.unsavedPayment?.idempotencyKey;
    setUnsavedConfirmation(null);
    if (!blocker || !idempotencyKey) {
      return;
    }
    setResolvingBlockerKey(unsavedResolvingKey(idempotencyKey));
    setSubmitResult(null);
    try {
      const resolvedBy =
        (staff as { databaseStaffId?: string } | null | undefined)?.databaseStaffId
        || activeShift?.staff_id
        || null;
      const result = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: () =>
          bridge.payments.resolveUnsavedPayment({
            idempotencyKey,
            outcome: 'returned_to_customer',
            resolvedBy,
          }),
        title: t('modals.zReport.unsavedApprovalTitle', {
          defaultValue: 'Confirm the money was given back',
        }),
        subtitle: t('modals.zReport.unsavedApprovalSubtitle', {
          defaultValue: 'Enter the cashier or manager PIN to confirm it.',
        }),
      });
      const outcome = result?.result;
      setSubmitResult(
        outcome === 'saved'
          ? t('modals.zReport.unsavedSavedAfterAll', {
            defaultValue: 'This payment was saved after all: there is nothing to give back.',
          })
          : outcome === 'resolved'
            ? t('modals.zReport.unsavedResolved', {
              defaultValue: 'Recorded as given back to the customer. The payment will not be saved.',
            })
            : t('modals.zReport.unsavedAlreadyResolved', {
              defaultValue: 'This payment was already recorded as given back.',
            }),
      );
    } catch (e: unknown) {
      const privilegedError = extractPrivilegedActionError(e, 'cash_drawer_control');
      if (
        privilegedError?.code === 'UNAUTHORIZED'
        && /shift/i.test(privilegedError.reason ?? '')
      ) {
        setSubmitResult(
          t('modals.zReport.setAsideShiftRequired', {
            defaultValue:
              'A cashier or manager has to be checked in on this terminal to confirm it.',
          }),
        );
      } else if (e instanceof Error && e.message === 'Privileged action confirmation cancelled') {
        // The operator closed the PIN prompt: nothing was recorded.
      } else {
        setSubmitResult(
          t('modals.zReport.unsavedResolveFailed', {
            error: extractErrorMessage(e, t('modals.zReport.unknownError'), t),
            defaultValue: 'Could not record it: {{error}}',
          }),
        );
      }
    } finally {
      setResolvingBlockerKey(null);
      setReportReloadVersion((current) => current + 1);
    }
  }, [activeShift?.staff_id, bridge, runWithPrivilegedConfirmation, staff, t, unsavedConfirmation]);

  // A cancelled order's held corrections can never be reopened and saved
  // (Tomikro #00055, 28/10/2026): a manager closes them here without
  // recording money. Native re-proves non-application before the approval
  // and again under its lock; nothing is charged, returned or voided.
  const handleCloseHeldEdit = useCallback(async (blocker: UnsettledPaymentBlocker) => {
    setResolvingBlockerKey(heldEditClosingKey(blocker.orderId));
    setSubmitResult(null);
    try {
      const result: any = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: () =>
          bridge.orders.applyEditSettlement({
            orderId: blocker.orderId,
            items: [],
            action: { type: 'none' },
            reconcile: {
              decision: 'close_without_money',
              scope: 'order',
              reason: String(t('modals.zReport.heldEditCloseReason', {
                defaultValue: 'Order cancelled; correction closed from the Z checks by a manager without recording money',
              })),
            },
          } as any),
        title: t('modals.zReport.heldEditApprovalTitle', {
          defaultValue: 'Close the correction without money',
        }),
        subtitle: t('modals.zReport.heldEditApprovalSubtitle', {
          defaultValue:
            'Check the bank POS and the drawer first. A staff member with the right to void payments enters their own PIN. Nothing is charged or returned.',
        }),
      });
      if (result?.success !== true || result?.state !== 'reconciled') {
        throw new Error('EDIT_RECONCILIATION_NOT_PROVEN');
      }
      setSubmitResult(
        t('modals.zReport.heldEditClosed', {
          defaultValue: 'The correction was closed. No money was recorded.',
        }),
      );
    } catch (e: unknown) {
      const privilegedError = extractPrivilegedActionError(e, 'cash_drawer_control');
      if (
        privilegedError?.code === 'UNAUTHORIZED'
        && /shift/i.test(privilegedError.reason ?? '')
      ) {
        setSubmitResult(
          t('modals.zReport.setAsideShiftRequired', {
            defaultValue:
              'A cashier or manager has to be checked in on this terminal to confirm it.',
          }),
        );
      } else if (e instanceof Error && e.message === 'Privileged action confirmation cancelled') {
        // The operator closed the PIN prompt: nothing was recorded.
      } else {
        setSubmitResult(
          t('modals.zReport.heldEditCloseFailed', {
            defaultValue: 'The correction could not be closed. It stays held; nothing was recorded.',
          }),
        );
      }
    } finally {
      setResolvingBlockerKey(null);
      setReportReloadVersion((current) => current + 1);
    }
  }, [bridge, runWithPrivilegedConfirmation, t]);

  const closeTwintReturn = useCallback(() => {
    setTwintReturn(null);
    setTwintReturnReference('');
    setTwintReturnPin('');
    setTwintReturnError(null);
  }, []);

  // "Returned via TWINT outside the POS" for a TWINT receipt that can never be
  // saved: a manager's own PIN and a reference, also while a cashier is still
  // on shift (an order it left unpaid holds that checkout). Nothing is charged
  // or refunded here; the audit is written before the receipt goes, and it
  // counts nowhere.
  const handleConfirmTwintReturned = useCallback(async () => {
    const blocker = twintReturn;
    const idempotencyKey = blocker?.unsavedPayment?.idempotencyKey;
    if (!blocker || !idempotencyKey) {
      closeTwintReturn();
      return;
    }
    const reference = twintReturnReference.trim();
    if (reference.length < 3 || reference.length > 200) {
      setTwintReturnError(t('twintPayment.returned.referenceRequired', {
        defaultValue: 'Enter the TWINT refund reference or a note (3 to 200 characters).',
      }));
      return;
    }
    const managerPin = twintReturnPin.trim();
    if (managerPin.length < 4) {
      setTwintReturnError(t('twintPayment.returned.pinRequired', {
        defaultValue: 'A manager enters their own PIN to confirm it.',
      }));
      return;
    }
    closeTwintReturn();
    setResolvingBlockerKey(unsavedResolvingKey(idempotencyKey));
    setSubmitResult(null);
    try {
      const resolvedBy =
        (staff as { databaseStaffId?: string } | null | undefined)?.databaseStaffId
        || activeShift?.staff_id
        || null;
      const result = await runWithPrivilegedConfirmation({
        scope: 'cash_drawer_control',
        action: () => resolveReturnedTwintReceipt({ idempotencyKey, reference, resolvedBy, managerPin }),
        title: t('twintPayment.returned.title', { defaultValue: 'TWINT receipt returned outside the POS' }),
      });
      setSubmitResult(
        result?.result === 'saved'
          ? t('modals.zReport.unsavedSavedAfterAll', {
            defaultValue: 'This payment was saved after all: there is nothing to give back.',
          })
          : t('twintPayment.returned.success', {
            defaultValue: 'Recorded as returned through TWINT outside the POS. It stays out of sales and drawer cash.',
          }),
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === 'Privileged action confirmation cancelled') {
        // The manager closed the PIN prompt: nothing was recorded.
      } else if (message.includes('TWINT_RETURN_MANAGER_APPROVAL_REQUIRED') || /Invalid PIN/i.test(message)) {
        setSubmitResult(t('twintPayment.returned.wrongPin', {
          defaultValue: "That PIN can't confirm it. A manager with the right to approve it enters their own PIN. Nothing was recorded.",
        }));
      } else if (message.includes('TWINT_RECEIPT_SAVE_STILL_POSSIBLE')) {
        setSubmitResult(t('twintPayment.returned.saveFirst', {
          defaultValue: 'This TWINT receipt can still be saved. Save the original receipt first.',
        }));
      } else if (message.includes('TWINT_RETURN_REFERENCE_REQUIRED')) {
        setSubmitResult(t('twintPayment.returned.referenceRequired', {
          defaultValue: 'Enter the TWINT refund reference or a note (3 to 200 characters).',
        }));
      } else {
        setSubmitResult(
          t('modals.zReport.unsavedResolveFailed', {
            error: extractErrorMessage(e, t('modals.zReport.unknownError'), t),
            defaultValue: 'Could not record it: {{error}}',
          }),
        );
      }
    } finally {
      setResolvingBlockerKey(null);
      setReportReloadVersion((current) => current + 1);
    }
  }, [activeShift?.staff_id, closeTwintReturn, runWithPrivilegedConfirmation, staff, t, twintReturn, twintReturnPin, twintReturnReference]);

  const title = useMemo(() => t('modals.zReport.title', { date: selectedDate }), [selectedDate, t]);
  const submitButtonLabel = t('modals.zReport.commitZReport');
  const resolvedBusinessDate = zReport?.date || selectedDate;
  const resolvedPeriod = useMemo(() => resolveZReportPeriod(zReport), [zReport]);
  useEffect(() => {
    if (!isOpen) return undefined;
    let current = true;
    const applyNetworkStatus = (payload: unknown) => {
      if (!current || !payload || typeof payload !== 'object') return;
      const isOnline = (payload as { isOnline?: unknown }).isOnline;
      if (typeof isOnline === 'boolean') setServerReachable(isOnline);
    };
    onEvent<unknown>('network:status', applyNetworkStatus);
    const probe = bridge.sync?.getNetworkStatus?.();
    if (probe && typeof probe.then === 'function') {
      // Unknown stays unknown: the checklist keeps its report-based line.
      void probe.then(applyNetworkStatus).catch(() => undefined);
    }
    return () => {
      current = false;
      offEvent<unknown>('network:status', applyNetworkStatus);
    };
  }, [bridge, isOpen, reportReloadVersion]);
  // TWINT receipts a manager recorded as returned outside the POS during this
  // Z's window: shown for what they are, never in sales, TWINT or drawer cash.
  useEffect(() => {
    let current = true;
    setTwintReturned([]);
    if (!isOpen || !resolvedPeriod.start) return () => { current = false; };
    void listTwintReturnedOutsidePos(resolvedPeriod.start)
      .then((rows) => { if (current) setTwintReturned(rows); })
      .catch(() => { /* Informational only: an unreadable list shows nothing. */ });
    return () => { current = false; };
  }, [isOpen, resolvedPeriod.start, reportReloadVersion]);
  const twintReturnedCents = useMemo(
    () => twintReturned.reduce((sum, row) => sum + (Number.isSafeInteger(row.amountCents) ? row.amountCents : 0), 0),
    [twintReturned],
  );
  // Gift card close (native gift_close_report_v1) is read from the frozen report only; nothing here
  // recomputes a drawer. Pending, missing or unreadable proof keeps the day not final.
  const giftCloseBlocksFinal = !giftClose.allowsFinal;
  const giftCloseDrawer = giftClose.drawer;
  // Final print reprints the stored z_reports row by id; a live preview has no id and cannot print.
  const persistedZReportId = resolvePersistedZReportId(zReport);
  const canPrintFinalReport = Boolean(persistedZReportId) && !giftCloseBlocksFinal;
  // Phones always hand over to the Main (founder rule 13/10/2026): the Z
  // cannot run while a phone shift of the unit is open. Read from the server
  // for the window this till is about to close (the live day or the pending
  // local submit: every report without a stored id, since native dates those
  // by their POS day whatever date is picked): on open, every 30 s and on
  // `shift-updated`. Never for a stored Z the date field shows, never on a
  // till that cannot run the Z. The latest read decides: a failed read is
  // "unavailable", never "no phone shifts".
  const phoneShiftsSince = readinessSinceFromPeriodStart(zReport?.periodStart);
  const phoneShiftsKey = isOpen
    && canExecuteZReport
    && Boolean(zReport)
    && !persistedZReportId
    ? `${branchId}|${phoneShiftsSince ?? ''}`
    : null;
  useEffect(() => {
    if (!phoneShiftsKey) return undefined;
    let active = true;
    const read = async () => {
      const seq = ++phoneShiftsSeqRef.current;
      setPhoneShiftsReading(true);
      // A good read is remembered on this device: the offline cashier close
      // and a quiet store without phones rely on it (review 14/10/2026).
      const { result, lastGood } = await readUnitShiftReadinessRemembered(bridge.shifts, null, phoneShiftsSince);
      if (!active || seq !== phoneShiftsSeqRef.current) return;
      setPhoneShiftsRead({ key: phoneShiftsKey, result, lastGood });
      setPhoneShiftsReading(false);
    };
    void read();
    const intervalId = setInterval(() => { void read(); }, 30000);
    const handleShiftUpdated = () => { void read(); };
    onEvent('shift-updated', handleShiftUpdated);
    return () => {
      active = false;
      clearInterval(intervalId);
      offEvent('shift-updated', handleShiftUpdated);
    };
  }, [bridge, phoneShiftsKey, phoneShiftsReadVersion, phoneShiftsSince, reportReloadVersion]);
  const retryPhoneShifts = useCallback(() => {
    setPhoneShiftsReadVersion((current) => current + 1);
  }, []);
  type GiftCloseTextKey = Exclude<keyof typeof GIFT_CLOSE_LABELS, 'recovery' | 'errors'>;
  const giftCloseText = (key: GiftCloseTextKey): string =>
    t(`modals.zReport.giftClose.${key}`, { defaultValue: GIFT_CLOSE_LABELS[key] });
  const formatGiftMoney = (cents: number, currency?: string | null) =>
    formatCurrency(cents / 100, currency || null);
  const giftCloseRecoveryMessage = (blocker: ZReportGiftCloseBlocker | null): string => {
    if (!blocker) {
      return t('modals.zReport.giftClose.recovery.unreadable', {
        defaultValue: GIFT_CLOSE_LABELS.recovery.unreadable,
      });
    }
    const key = giftCloseRecoveryKey(blocker.code);
    return t(`modals.zReport.giftClose.recovery.${key}`, {
      staff: giftCloseStaffLabel(blocker),
      defaultValue: GIFT_CLOSE_LABELS.recovery[key],
    });
  };
  const giftCloseNotices: string[] = giftClose.state === 'unreadable'
    ? [giftCloseRecoveryMessage(null)]
    : giftClose.blockers.length > 0
      ? giftClose.blockers.map((blocker) => giftCloseRecoveryMessage(blocker))
      : giftCloseBlocksFinal
        ? [giftCloseRecoveryMessage({ code: 'unknown' })]
        : [];
  const giftCloseStatusLabel = giftClose.state === 'final'
    ? giftCloseText('proofFinal')
    : giftClose.state === 'unreadable'
      ? giftCloseText('proofUnreadable')
      : giftCloseText('proofNotFinal');
  const printUnavailableHint = !zReport
    ? undefined
    : giftCloseBlocksFinal
      ? giftCloseText('blocked')
      : !persistedZReportId
        ? t('modals.zReport.finalPrintUnavailable', { defaultValue: GIFT_CLOSE_LABELS.finalPrintUnavailable })
        : undefined;
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
        return 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80';
      case 'cashier':
      case 'manager':
        return 'border-amber-500/30 bg-amber-500/15 text-amber-800 dark:border-amber-300/30 dark:text-amber-100';
      case 'server':
      case 'waiter':
        return 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80';
      default:
        return 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80';
    }
  };

  const getShiftStatusBadgeClasses = (status?: string) => {
    switch (String(status || '').toLowerCase()) {
      case 'active':
        return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-800 dark:border-emerald-300/30 dark:text-emerald-100';
      case 'closed':
        return 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80';
      default:
        return 'border-amber-500/30 bg-amber-500/15 text-amber-800 dark:border-amber-300/30 dark:text-amber-100';
    }
  };

  const getHandoverBadgeClasses = (handover: ZReportPhoneShiftHandover | null) => {
    switch (handover) {
      case 'received':
        return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-800 dark:border-emerald-300/30 dark:text-emerald-100';
      case 'pending':
      case 'not_counted':
        return 'border-amber-500/30 bg-amber-500/15 text-amber-800 dark:border-amber-300/30 dark:text-amber-100';
      default:
        return 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80';
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
        className: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-800 dark:border-emerald-300/30 dark:text-emerald-100',
      };
    }
    if (!drawer?.closedAt) {
      return {
        label: t('common.status.active', { defaultValue: 'Active' }),
        className: 'border-slate-900/[0.14] bg-slate-900/5 text-slate-700 dark:border-white/16 dark:bg-white/8 dark:text-white/80',
      };
    }
    return {
      label: t('modals.zReport.needsAttention'),
      className: 'border-amber-500/30 bg-amber-500/15 text-amber-800 dark:border-amber-300/30 dark:text-amber-100',
    };
  };

  const orderTypeFilterOptions = [
    { value: 'all' as const, label: t('modals.zReport.filters.allTypes') },
    ...(reportSections.delivery ? [{ value: 'delivery' as const, label: t('modals.zReport.filters.delivery') }] : []),
    { value: 'dine-in' as const, label: t('modals.zReport.filters.dineIn') },
    { value: 'pickup' as const, label: t('modals.zReport.filters.pickup') },
  ];

  const paymentMethodFilterOptions = [
    { value: 'all' as const, label: t('modals.zReport.filters.allPayments') },
    { value: 'cash' as const, label: t('modals.zReport.filters.cash') },
    { value: 'card' as const, label: t('modals.zReport.filters.card') },
    ...(reportSections.twint ? [{ value: 'twint' as const, label: 'TWINT' }] : []),
    { value: 'platform' as const, label: t('modals.zReport.filters.platform') },
  ];

  const handleRefreshReport = useCallback(() => {
    setSubmitResult(null);
    setError(null);
    setReportReloadVersion((current) => current + 1);
  }, []);

  // Both exports open the picker of stored Zs (founder, 14/10/2026: the Z export is based on
  // the Z's real data). The open day's live preview is offered there only as a provisional file.
  const handleExportReport = useCallback(() => {
    setExportDialogIntent('report');
  }, []);

  const handleExportOrdersReport = useCallback(() => {
    setExportDialogIntent('orders');
  }, []);

  const handlePrintReport = useCallback(async () => {
    // Final print only reprints the persisted z_reports row (native verifies it exists). There is no
    // renderer snapshot print: a preview without a stored id, or with unconfirmed gift proof, cannot print.
    if (!zReport || !persistedZReportId || giftCloseBlocksFinal) return;
    const statusScope = statusScopeRef.current;
    setPrinting(true);
    try {
      const result = await bridge.reports.printZReport({
        zReportId: persistedZReportId,
        terminalName: typeof zReport.terminalName === 'string' ? zReport.terminalName : undefined,
      });
      if (result?.success === false) {
        throw new Error(result?.error || t('modals.zReport.printFailed', 'Failed to queue print'));
      }
      if (statusScopeRef.current !== statusScope) return;
      setSubmitResult(t('modals.zReport.printQueued', 'Z-Report print queued'));
    } catch (err) {
      console.error('[ZReportModal] Z-Report print error:', err);
      if (statusScopeRef.current !== statusScope) return;
      setSubmitResult(
        t('modals.zReport.printFailed', {
          defaultValue: `Print failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          error: err instanceof Error ? err.message : 'unknown error',
        }),
      );
    } finally {
      if (statusScopeRef.current === statusScope) setPrinting(false);
    }
  }, [bridge, giftCloseBlocksFinal, persistedZReportId, t, zReport]);

  // A phone, named for the cashier: a deactivated or removed phone says so.
  const describePhone = useCallback((shift: Pick<UnitShift, 'terminal_name' | 'terminal_id' | 'terminal_active'>) => {
    const phoneState = unitShiftPhoneState(shift);
    if (phoneState === 'active') return unitShiftPhoneLabel(shift);
    const marker = phoneState === 'deactivated'
      ? t('phoneShifts.phoneDeactivated', { defaultValue: 'phone deactivated' })
      : t('phoneShifts.phoneRemoved', { defaultValue: 'phone removed' });
    return `${unitShiftPhoneLabel(shift)} (${marker})`;
  }, [t]);
  // An open phone shift: staff · role · phone · check-in time.
  const describeOpenPhoneShift = useCallback((shift: UnitShift) => [
    unitShiftStaffLabel(shift),
    shift.role_type ? translateRoleName(t, shift.role_type) : null,
    describePhone(shift),
    shift.check_in_time
      ? t('phoneShifts.checkedInAt', {
        time: formatTime(shift.check_in_time, { hour: '2-digit', minute: '2-digit' }),
        defaultValue: 'checked in {{time}}',
      })
      : null,
  ].filter(Boolean).join(' · '), [describePhone, t]);

  // The native Z stage refused over phone shifts (founder rule 13/10/2026):
  // name them in the store's language, never the server's English text, hold
  // the commit on the named list at once, and read the report and the phone
  // shifts again (a fresh preview also moves a live window's end to now).
  const applyUnitShiftsRefusal = useCallback((refusal: UnitShiftsZRefusal) => {
    if (refusal.kind === 'open') {
      setSubmitResult(refusal.openShifts.length > 0
        ? t('modals.zReport.phoneShifts.refusedOpen', {
          shifts: refusal.openShifts.map(describeOpenPhoneShift).join('; '),
          defaultValue:
            'The day was not closed: phone shifts are still open: {{shifts}}. Close each one on the phone, or from Staff on this register.',
        })
        : t('modals.zReport.phoneShifts.refusedOpenUnnamed', {
          defaultValue:
            'The day was not closed: a phone shift is still open. Close it on the phone, or from Staff on this register.',
        }));
    } else {
      setSubmitResult(t('modals.zReport.phoneShifts.refusedUnavailable', {
        defaultValue:
          'The day was not closed: the phone shifts could not be checked. Check the connection and try again.',
      }));
    }
    const key = phoneShiftsKey;
    if (key && (refusal.kind === 'unavailable' || refusal.openShifts.length > 0)) {
      setPhoneShiftsRead((current) => {
        if (refusal.kind === 'unavailable') {
          return {
            key,
            result: { kind: 'unavailable', status: null, code: 'Z_REPORT_UNIT_SHIFTS_UNAVAILABLE', error: refusal.error ?? 'unavailable' },
          };
        }
        const base = current?.key === key && current.result.kind === 'ready' ? current.result.readiness : null;
        return {
          key,
          result: {
            kind: 'ready',
            readiness: {
              mainTerminalId: base?.mainTerminalId ?? null,
              checkedAt: base?.checkedAt ?? null,
              since: base?.since ?? null,
              openShifts: refusal.openShifts,
              closedShifts: base?.closedShifts ?? [],
              pendingReturns: base?.pendingReturns ?? [],
              terminals: base?.terminals ?? [],
            },
          },
        };
      });
    }
    setReportReloadVersion((current) => current + 1);
  }, [describeOpenPhoneShift, phoneShiftsKey, t]);

  const handleSubmitReport = useCallback(async () => {
    // Unconfirmed gift card proof keeps the day open; native refuses it too, so never bypass that.
    if (giftCloseBlocksFinal) return;
    const statusScope = statusScopeRef.current;
    setSubmitResult(null);
    setPaymentBlockers([]);
    setSubmitting(true);
    try {
      console.log('[ZReportModal] Starting Z-Report submission...', { branchId, date: selectedDate });
      const res: LocalCloseAwareSubmitResponse = await bridge.reports.submitZReport({ branchId, date: selectedDate });
      const isInitiatingScope = statusScopeRef.current === statusScope;

      // The fiscal close-day guard refuses with a code + parameters; the
      // operator reads it in the store's language, never the native English
      // fallback (29/09/2026). The reload shows the queued receipts.
      const fiscalCloseMessage = formatFiscalCloseBlockedError(res, t, formatFiscalBusinessDay);
      if (fiscalCloseMessage) {
        console.warn('[ZReportModal] Z-Report held by queued fiscal receipts:', res);
        setSubmitResult(fiscalCloseMessage);
        setReportReloadVersion((current) => current + 1);
        return;
      }

      const unitShiftsRefusal = extractUnitShiftsZRefusal(res);
      if (unitShiftsRefusal) {
        console.warn('[ZReportModal] Z-Report held by phone shifts:', res);
        if (isInitiatingScope) applyUnitShiftsRefusal(unitShiftsRefusal);
        return;
      }

      if (res?.success === false) {
        if (!isInitiatingScope) return;
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(res);
        setPaymentBlockers(paymentIntegrityPayload?.blockers || []);
        const giftCloseError = classifyGiftCloseFinalizationError(res);
        const errorMessage = giftCloseError
          ? t(`modals.zReport.giftClose.errors.${giftCloseError}`, {
            defaultValue: GIFT_CLOSE_LABELS.errors[giftCloseError],
          })
          : formatOperatorFacingError(
            res,
            res?.error || res?.message || t('modals.zReport.unknownError'),
            t,
          );
        console.error('[ZReportModal] IPC error response:', { error: errorMessage, fullResponse: res });
        setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
        return;
      }

      if (res?.success && res?.localDayClosed) {
        if (isInitiatingScope) setPaymentBlockers([]);
        console.log('[ZReportModal] Z-Report submitted successfully:', {
          id: res?.zReportId,
          cleanup: res?.cleanup,
          syncState: res?.syncState,
        });

        // Offline week (founder 21/10/2026): without a connection the day
        // closes on this till and its Z is sent once the server is back.
        const closedLocally = res?.localClose === true;
        const successMessage = closedLocally
          ? t('zReportOffline.localCloseDone', {
            date: res?.reportDate || selectedDate,
            defaultValue:
              'The day of {{date}} is closed on this till without a connection. Its Z is sent to the server once the connection is back; nothing is lost. You can start the next day.',
          })
          : res?.syncState === 'applied'
            ? t('modals.zReport.submitSuccessSynced')
            : isPendingLocalSubmit
              ? t('modals.zReport.pendingLocalSubmitQueued')
              : t('modals.zReport.submitSuccessQueued');
        // The day is closed either way; only the visible message stays bound to the initiating report.
        if (isInitiatingScope) setSubmitResult(successMessage);

        try { await bridge.auth.logout(); } catch { }
        try { clearBusinessDayStorage(); } catch { }
        try { clearShift(); } catch { }

        // A local close gets time to be read before the day restarts.
        setTimeout(() => { window.location.reload(); }, closedLocally ? LOCAL_CLOSE_RELOAD_DELAY_MS : 900);
      } else {
        if (!isInitiatingScope) return;
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
      if (statusScopeRef.current !== statusScope) return;
      const fiscalCloseMessage = formatFiscalCloseBlockedError(e, t, formatFiscalBusinessDay);
      if (fiscalCloseMessage) {
        setSubmitResult(fiscalCloseMessage);
        setReportReloadVersion((current) => current + 1);
        return;
      }
      const unitShiftsRefusal = extractUnitShiftsZRefusal(e);
      if (unitShiftsRefusal) {
        applyUnitShiftsRefusal(unitShiftsRefusal);
        return;
      }
      const paymentIntegrityPayload = extractPaymentIntegrityPayload(e);
      setPaymentBlockers(paymentIntegrityPayload?.blockers || []);
      const giftCloseError = classifyGiftCloseFinalizationError(e);
      const errorMessage = giftCloseError
        ? t(`modals.zReport.giftClose.errors.${giftCloseError}`, {
          defaultValue: GIFT_CLOSE_LABELS.errors[giftCloseError],
        })
        : extractErrorMessage(
          e,
          t('modals.zReport.submissionFailed'),
          t,
        );
      setSubmitResult(t('modals.zReport.submitFailed', { error: errorMessage }));
    } finally {
      if (statusScopeRef.current === statusScope) setSubmitting(false);
    }
  }, [applyUnitShiftsRefusal, branchId, bridge, clearShift, giftCloseBlocksFinal, isPendingLocalSubmit, selectedDate, t]);

  // "Send the fiscal receipts again": reset the queued fiscal rows' backoff
  // and run the queue now, then re-read the report. Scheduling a retry is not
  // proof of anything: the row stays listed until a fresh read shows it gone.
  const handleRetryFiscalQueue = useCallback(async () => {
    setRetryingFiscalQueue(true);
    setSubmitResult(null);
    try {
      const syncQueue = getSyncQueueBridge();
      await syncQueue.retryModule('fiscal');
      try {
        await syncQueue.processQueue();
      } catch (processError) {
        // The background sync keeps trying; the re-read below reports what is left.
        console.warn('[ZReportModal] Fiscal queue run after retry failed:', processError);
      }
      setSubmitResult(
        t('modals.zReport.fiscalQueue.retryRequested', {
          defaultValue: 'Sending the fiscal submissions again. The list updates once they are accepted.',
        }),
      );
    } catch (e: unknown) {
      setSubmitResult(
        t('modals.zReport.fiscalQueue.retryFailed', {
          error: extractErrorMessage(e, t('modals.zReport.unknownError'), t),
          defaultValue: 'Could not send the fiscal submissions again: {{error}}',
        }),
      );
    } finally {
      setRetryingFiscalQueue(false);
      setReportReloadVersion((current) => current + 1);
    }
  }, [t]);

  // Reconciliation from the report itself (1.4.114+). Until now the modal only
  // learned about payment-integrity breaks when a SUBMIT was rejected, so a
  // preview of a broken day looked perfectly healthy — the founder's Z showed
  // order-level €1.636,16 against payment-level €1.105,73 with a green check
  // list. The builder now ships its findings with the report, so the break is
  // visible before anyone presses «Κλείσιμο».
  const integrity = zReport?.integrity;
  const integrityFindings = useMemo(
    () => (Array.isArray(integrity?.findings) ? integrity.findings : []),
    [integrity],
  );
  // Submit-time rejections and preview findings describe the same orders;
  // merge on orderId + reasonCode (+ the set-aside payment, one blocker each)
  // so a rejected submit does not double-list.
  const effectivePaymentBlockers = useMemo(() => {
    const merged = new Map<string, UnsettledPaymentBlocker>();
    for (const blocker of [...integrityFindings, ...paymentBlockers]) {
      if (!blocker?.orderId) continue;
      merged.set(paymentBlockerKey(blocker), blocker);
    }
    return [...merged.values()];
  }, [integrityFindings, paymentBlockers]);
  const blockingPaymentIssues = useMemo(
    () => effectivePaymentBlockers.filter((blocker) => blocker.severity !== 'warning'),
    [effectivePaymentBlockers],
  );

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
  // Fiscal receipts of this window still queued under an active (or unknown)
  // plugin hold the Z, exactly as the native guard will at submit. A branch
  // the server reports as fiscally inactive is never held (29/09/2026).
  const fiscalQueue = resolveFiscalQueue(zReport);
  const fiscalQueueBlocking = Boolean(fiscalQueue?.blocking) && (fiscalQueue?.count ?? 0) > 0;
  const fiscalQueueCount = fiscalQueueBlocking ? fiscalQueue?.count ?? 0 : 0;
  const fiscalQueueDate = fiscalQueue?.reportDate ? formatFiscalBusinessDay(fiscalQueue.reportDate) : '';
  // Phone shifts (founder rule 13/10/2026). Not read yet for this window:
  // pending, never ready. Unavailable: blocking, never "none open". A frozen
  // (issued) Z window counts only the phone shifts that checked in by its
  // cutoff, as the native Z stage does; a live window counts every one.
  // Unsupported (old server, not a Main): no check, as natively.
  const phoneShiftsResult = phoneShiftsKey && phoneShiftsRead?.key === phoneShiftsKey
    ? phoneShiftsRead.result
    : null;
  const phoneShiftsReadiness = phoneShiftsResult?.kind === 'ready' ? phoneShiftsResult.readiness : null;
  const phoneShiftsCutoffMs = frozenZCutoffMs({
    lockDate,
    periodEnd: resolvedPeriod.end,
    receivedAt: zReportReceivedAt,
  });
  const openPhoneShifts = (phoneShiftsReadiness?.openShifts ?? [])
    .filter((shift) => unitShiftHoldsZ(shift, phoneShiftsCutoffMs));
  const pendingPhoneReturns = phoneShiftsReadiness?.pendingReturns ?? [];
  // Phone staff for the Staff tab: the live window lists the phone shifts
  // that closed OR were received in it (re-review 15/10/2026), a stored Z
  // the ones it reported.
  const phoneShiftsWindowStartMs = phoneShiftsSince ? Date.parse(phoneShiftsSince) : Number.NaN;
  const phoneShiftStaffRows: PhoneShiftStaffRow[] = phoneShiftsKey
    ? (phoneShiftsReadiness?.closedShifts ?? [])
      .filter((shift) => closedShiftInZWindow(
        shift,
        Number.isFinite(phoneShiftsWindowStartMs) ? phoneShiftsWindowStartMs : null,
        phoneShiftsCutoffMs,
      ))
      .map(phoneShiftRowFromReadiness)
    : (zReport?.phoneShifts ?? []).map(phoneShiftRowFromStoredZ);
  const phoneShiftsChecking = Boolean(phoneShiftsKey) && !phoneShiftsResult;
  // A unit without phones (a kiosk is not one) and nothing open or pending
  // shows no phone row at all (review 14/10/2026). When the read fails, the
  // last good read decides that; the native Z stage still checks at commit.
  const phoneShiftsLastGood = phoneShiftsKey && phoneShiftsRead?.key === phoneShiftsKey
    ? phoneShiftsRead.lastGood?.readiness ?? null
    : null;
  const phoneShiftsQuietWithoutPhones = Boolean(phoneShiftsLastGood)
    && !unitHasPhones(phoneShiftsLastGood!)
    && unitIsQuiet(phoneShiftsLastGood!);
  const phoneShiftsUnavailable = phoneShiftsResult?.kind === 'unavailable' && !phoneShiftsQuietWithoutPhones;
  const phoneShiftsBlockCloseout = phoneShiftsUnavailable || openPhoneShifts.length > 0;
  const closeoutIssueCount =
    blockingPaymentIssues.length +
    (fiscalQueueBlocking ? 1 : 0) +
    (phoneShiftsBlockCloseout ? 1 : 0) +
    (pendingPhoneReturns.length > 0 ? 1 : 0) +
    (hasActiveStaffShifts ? 1 : 0) +
    (cashDrawerBlocksCloseout ? closeoutUnreconciledDrawers : 0) +
    closeoutPendingExpenses +
    closeoutUnsettledDrivers +
    (cashDrawerBlocksCloseout && closeoutHasVariance ? 1 : 0) +
    (showMainTerminalWarning ? 1 : 0) +
    (giftCloseBlocksFinal ? 1 : 0) +
    (error ? 1 : 0);
  const closeoutReady = Boolean(zReport) && !loading && !phoneShiftsChecking && closeoutIssueCount === 0;
  const closeoutHasHardSubmitBlocker =
    !Boolean(zReport) ||
    lockedTerminal ||
    loading ||
    Boolean(error) ||
    fiscalQueueBlocking ||
    giftCloseBlocksFinal ||
    phoneShiftsChecking ||
    phoneShiftsBlockCloseout ||
    hasActiveStaffShifts ||
    blockingPaymentIssues.length > 0;
  const closeoutNeedsCashierCheckout =
    !loading &&
    !closeoutReady &&
    cashDrawerBlocksCloseout &&
    !closeoutHasVariance &&
    blockingPaymentIssues.length === 0 &&
    !fiscalQueueBlocking &&
    !phoneShiftsChecking &&
    !phoneShiftsBlockCloseout &&
    pendingPhoneReturns.length === 0 &&
    closeoutPendingExpenses === 0 &&
    closeoutUnsettledDrivers === 0 &&
    !showMainTerminalWarning &&
    !giftCloseBlocksFinal &&
    !error;
  const closeoutNeedsStaffCheckout =
    !loading &&
    !closeoutReady &&
    hasActiveStaffShifts &&
    blockingPaymentIssues.length === 0 &&
    !fiscalQueueBlocking &&
    !phoneShiftsChecking &&
    !phoneShiftsBlockCloseout &&
    pendingPhoneReturns.length === 0 &&
    closeoutPendingExpenses === 0 &&
    closeoutUnsettledDrivers === 0 &&
    !showMainTerminalWarning &&
    !giftCloseBlocksFinal &&
    !error;
  const closeoutStatusLabel = loading
    ? t('modals.zReport.closeoutLoading')
    : serverReachable === false
      ? t('zReportOffline.status', { defaultValue: 'No connection: the day closes once it is back' })
    : closeoutReady
      ? t('modals.zReport.readyToClose')
      // Nothing else to fix while the phone shifts are still being read.
      : phoneShiftsChecking && closeoutIssueCount === 0
        ? t('modals.zReport.closeoutLoading')
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
    /** One line per thing the row names (an open phone shift, a till to receive). */
    details?: string[];
  }> = [
    {
      key: 'sync',
      label: t('modals.zReport.adminSync'),
      description: loading
        ? t('modals.zReport.syncChecking')
        : serverReachable === false
          ? t('zReportOffline.checklist', {
            defaultValue: 'No connection to the server. Keep selling; close the day once the connection is back.',
          })
          : error
            ? t('modals.zReport.syncNeedsRetry')
            : t('modals.zReport.syncReady'),
      state: loading ? 'pending' : serverReachable === false || error ? 'error' : 'ready',
    },
    {
      key: 'payments',
      label: t('modals.zReport.paymentsCaptured'),
      description: blockingPaymentIssues.length > 0
        ? t('modals.zReport.paymentsNeedAction', { count: blockingPaymentIssues.length })
        : t('modals.zReport.paymentsReady'),
      state: blockingPaymentIssues.length > 0 ? 'error' : 'ready',
    },
    // Only when receipts are actually waiting: a store without a fiscal
    // plugin never sees a fiscal row in its checklist.
    ...(fiscalQueueBlocking
      ? [
        {
          key: 'fiscal',
          label: t('modals.zReport.fiscalQueue.label', { defaultValue: 'Fiscal submissions' }),
          description: fiscalQueueDate
            ? t('modals.zReport.fiscalQueue.pending', {
              count: fiscalQueueCount,
              date: fiscalQueueDate,
              defaultValue:
                '{{count}} fiscal submission(s) of {{date}} have not reached the fiscal service yet. You can keep selling; the day closes once they are sent.',
            })
            : t('modals.zReport.fiscalQueue.pendingNoDate', {
              count: fiscalQueueCount,
              defaultValue:
                '{{count}} fiscal submission(s) have not reached the fiscal service yet. You can keep selling; the day closes once they are sent.',
            }),
          state: 'error' as CloseoutChecklistState,
          actionLabel: t('modals.zReport.fiscalQueue.retryAction', { defaultValue: 'Send again' }),
        },
      ]
      : []),
    ...(giftClose.state === 'none'
      ? []
      : [{
        key: 'gift-close',
        label: giftCloseText('title'),
        // Unconfirmed or unreadable gift card proof is a hard blocker with a concrete next step.
        description: giftCloseBlocksFinal
          ? [...giftCloseNotices.slice(0, 1), giftCloseText('blocked')].join(' ')
          : t('modals.zReport.giftClose.checklistFinal', {
            amount: formatGiftMoney(giftCloseDrawer?.giftLiabilityCashCents ?? 0, giftClose.currency),
            defaultValue: GIFT_CLOSE_LABELS.checklistFinal,
          }),
        state: (giftCloseBlocksFinal ? 'error' : 'ready') as CloseoutChecklistState,
      }]),
    // Phones hand over to the Main (founder rule 13/10/2026): every open
    // phone shift is named and holds the Z. No row where the check does not
    // apply (a stored or past day, an old server, a till that is not a Main).
    ...(phoneShiftsKey && phoneShiftsResult?.kind !== 'unsupported' && !phoneShiftsQuietWithoutPhones
      ? [{
        key: 'phone-shifts',
        label: t('phoneShifts.title', { defaultValue: 'Phone shifts' }),
        description: phoneShiftsChecking
          ? t('modals.zReport.phoneShifts.checking', { defaultValue: 'Checking the phone shifts…' })
          : phoneShiftsUnavailable
            ? t('phoneShifts.unavailable', {
              defaultValue: 'Phone shifts could not be checked. Check the connection and try again.',
            })
            : openPhoneShifts.length > 0
              ? t('modals.zReport.phoneShifts.openDescription', {
                count: openPhoneShifts.length,
                defaultValue: '{{count}} phone shift(s) still open. The day cannot close until each one is closed.',
              })
              : t('modals.zReport.phoneShifts.noneOpen', { defaultValue: 'No phone shift is open.' }),
        state: (phoneShiftsChecking
          ? 'pending'
          : phoneShiftsBlockCloseout ? 'error' : 'ready') as CloseoutChecklistState,
        actionLabel: openPhoneShifts.length > 0
          ? t('modals.zReport.phoneShifts.closeAction', {
            defaultValue: 'Close it on the phone, or from Staff on this register',
          })
          : undefined,
        details: openPhoneShifts.map(describeOpenPhoneShift),
      }]
      : []),
    // Closed phone tills whose cash this register has not taken yet: a
    // warning, never a blocker. The server keeps listing them (31 days).
    ...(pendingPhoneReturns.length > 0
      ? [{
        key: 'phone-returns',
        label: t('modals.zReport.phoneShifts.pendingReturnsTitle', { defaultValue: 'Phone cash to receive' }),
        description: t('modals.zReport.phoneShifts.pendingReturnsDescription', {
          defaultValue:
            'Closed phone tills whose cash this register has not received yet. Receive it here; until then it stays listed, also the next day.',
        }),
        state: 'warning' as CloseoutChecklistState,
        details: pendingPhoneReturns.map((entry) => t('modals.zReport.phoneShifts.returnLine', {
          staff: unitShiftStaffLabel(entry),
          phone: describePhone(entry),
          amount: formatCurrency(unitShiftCashToReceive(entry), phoneShiftCurrency(entry.currency, reportCurrency)),
          defaultValue: '{{staff}} · {{phone}} · to receive {{amount}}',
        })),
      }]
      : []),
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
    !closeoutHasHardSubmitBlocker &&
    !submitting &&
    !Boolean(resolvingBlockerKey);
  // Short, localized status word for each Check-tab row (icon + label + status).
  const closeoutStateLabel = (state: CloseoutChecklistState): string => {
    if (state === 'ready') return t('modals.zReport.clarity.statusReady', { defaultValue: 'Ready' });
    if (state === 'error') return t('modals.zReport.clarity.statusAction', { defaultValue: 'Action needed' });
    if (state === 'pending') return t('modals.zReport.clarity.statusChecking', { defaultValue: 'Checking…' });
    return t('modals.zReport.clarity.statusAttention', { defaultValue: 'Needs attention' });
  };

  const visibleStaffReports = staffReportsSorted.filter(staff => staff.role !== 'driver' || reportSections.drivers);
  const totalOrders = summarySales.totalOrders ?? 0;
  const cashCollected = summarySales.cashSales ?? 0;
  const cardCollected = summarySales.cardSales ?? 0;
  const twintCollected = resolveZReportTwintTotal(zReport);
  // THE-437: money the delivery platform is holding for us (prepaid online
  // orders, and COD its own riders collected). Revenue, but never drawer cash.
  const platformOnlineCollected = summarySales.platformOnlineSales ?? 0;
  const platformCodCollected = summarySales.platformCodSales ?? 0;
  const totalSales = summarySales.totalSales ?? 0;
  // Founder (06/09/2026): «θέλω να δείχνει όλα τα κέρδη — και αυτά πραγματικά έσοδα
  // είναι». The headline is the whole day's revenue — store AND platform orders —
  // never the staff shifts' collected subset: on the 05/09 close the staff sum read
  // 428.54 / 56 orders while the day was 629.49 / 72 (16 efood orders the platform
  // settles). Cash-only money is shown separately as «money in the till» below.
  const platformCollected = platformOnlineCollected + platformCodCollected;
  // Payment-level figures from the same Z summary as the tiles: cash + card +
  // platform online + platform COD + other tender (daySummary.total). An
  // order-level total (sales.totalSales = gross − discounts) would disagree
  // with the tiles as soon as an order is still uncollected or a payment was
  // refunded, so the headline and its split read the money actually collected.
  const otherTenderCollected = zReport?.paymentsBreakdown?.other?.total ?? 0;
  const collectedTotal = zReport?.daySummary?.total
    ?? (cashCollected + cardCollected + twintCollected + platformCollected + otherTenderCollected);
  const expensesTotal = summaryExpenses.total ?? 0;
  const drawerOpening = summaryCashDrawer.openingTotal ?? 0;
  const drawerDrops = summaryCashDrawer.totalCashDrops ?? 0;
  const staffPaymentsTotal = summaryExpenses.staffPaymentsTotal ?? 0;
  const driverCashGiven = summaryCashDrawer.driverCashGiven ?? 0;
  const driverCashReturned = summaryCashDrawer.driverCashReturned ?? 0;
  // Branch revenue already includes waiter receipts. Adding their handover to
  // that revenue counts the same cash twice. Native owns the drawer expectation;
  // retain the flow fallback only for older reports without a drawer snapshot.
  const recordedDrawerExpected = typeof summaryCashDrawer.expected_cents === 'number'
    && Number.isSafeInteger(summaryCashDrawer.expected_cents)
    ? summaryCashDrawer.expected_cents / 100
    : typeof summaryCashDrawer.expected === 'number' && Number.isFinite(summaryCashDrawer.expected)
      ? summaryCashDrawer.expected : null;
  const drawerCashNet = typeof summaryCashDrawer.cashSales === 'number'
    && Number.isFinite(summaryCashDrawer.cashSales)
    && typeof summaryCashDrawer.totalRefunds === 'number' && Number.isFinite(summaryCashDrawer.totalRefunds)
    ? summaryCashDrawer.cashSales - summaryCashDrawer.totalRefunds : cashCollected;
  const expectedCash = giftCloseDrawer
    ? giftCloseDrawer.expectedCents / 100
    : recordedDrawerExpected ?? (drawerOpening +
      drawerCashNet -
      expensesTotal -
      staffPaymentsTotal -
      drawerDrops -
      driverCashGiven +
      driverCashReturned);
  const otherCollected = otherTenderCollected;
  // Cash + Card + Platforms (+ Other tender) = the headline, by construction.
  const revenueSplitTiles = [
    { key: 'cash', label: t('modals.zReport.cashInTill'), value: formatMoney(cashCollected) },
    { key: 'card', label: t('modals.zReport.cardTotalLabel'), value: formatMoney(cardCollected) },
    ...(reportSections.twint ? [{ key: 'twint', label: 'TWINT', value: formatMoney(twintCollected) }] : []),
    ...(platformCollected !== 0 ? [{ key: 'platforms', label: t('modals.zReport.platformsTotal'), value: formatMoney(platformCollected) }] : []),
    ...(otherCollected >= 0.005
      ? [{ key: 'other', label: t('modals.zReport.otherTender'), value: formatMoney(otherCollected) }]
      : []),
  ];
  const totalCashOut = expensesTotal + staffPaymentsTotal + drawerDrops + driverCashGiven;
  const totalCashInAdjustments = driverCashReturned;
  const netAfterExpenses = collectedTotal - expensesTotal - staffPaymentsTotal;
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
      value: formatMoney(collectedTotal),
      tone: 'text-emerald-600 dark:text-emerald-300',
      helper: `${t('modals.zReport.orders', { defaultValue: 'Orders' })}: ${totalOrders} · ${t('modals.zReport.staff', { defaultValue: 'Staff' })}: ${totalShiftCount}`,
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
      helper: reportSections.expenses ? t('modals.zReport.totalExpenses', { defaultValue: 'Total Expenses' }) + `: ${formatMoney(expensesTotal + staffPaymentsTotal)}` : '',
    },
  ];
  const moneyFlowRows = [
    { key: 'start', label: t('modals.zReport.opening'), value: formatMoney(drawerOpening), tone: strongTextClass },
    { key: 'cash', label: t('modals.zReport.cashSales'), value: `+${formatMoney(drawerCashNet)}`, tone: 'text-emerald-600 dark:text-emerald-300' },
    { key: 'card', label: t('modals.zReport.cardSales'), value: formatMoney(cardCollected), tone: strongTextClass },
    ...(reportSections.twint ? [{ key: 'twint', label: 'TWINT', value: formatMoney(twintCollected), tone: strongTextClass }] : []),
    ...(platformOnlineCollected > 0
      ? [{ key: 'platformOnline', label: t('modals.zReport.platformOnlineSales'), value: formatMoney(platformOnlineCollected), tone: strongTextClass }]
      : []),
    ...(platformCodCollected > 0
      ? [{ key: 'platformCod', label: t('modals.zReport.platformCodSales'), value: formatMoney(platformCodCollected), tone: strongTextClass }]
      : []),
    ...(otherCollected >= 0.005
      ? [{ key: 'other', label: t('modals.zReport.otherTender'), value: formatMoney(otherCollected), tone: strongTextClass }]
      : []),
    ...(reportSections.expenses || totalCashOut !== 0 ? [{ key: 'out', label: t('modals.zReport.totalExpenses'), value: totalCashOut > 0 ? `-${formatMoney(totalCashOut)}` : formatMoney(0), tone: 'text-rose-600 dark:text-rose-300' },] : []),
    ...(totalCashInAdjustments > 0
      ? [{ key: 'returned', label: t('modals.zReport.driverCashReturned'), value: `+${formatMoney(totalCashInAdjustments)}`, tone: 'text-emerald-600 dark:text-emerald-300' }]
      : []),
    // Gift card cash is a drawer liability: in the canonical expectation once, never a sale.
    ...(giftCloseDrawer
      ? [
        ...(giftCloseDrawer.ordinaryAdjustmentCents !== 0
          ? [{ key: 'giftOrdinaryAdjustment', label: giftCloseText('ordinaryAdjustment'), value: formatGiftMoney(giftCloseDrawer.ordinaryAdjustmentCents, giftClose.currency), tone: strongTextClass }]
          : []),
        { key: 'giftLiabilityCash', label: giftCloseText('giftLiabilityCash'), value: `+${formatGiftMoney(giftCloseDrawer.giftLiabilityCashCents, giftClose.currency)}`, tone: strongTextClass },
        { key: 'giftExpected', label: giftCloseText('expected'), value: formatMoney(expectedCash), tone: strongTextClass },
      ]
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
    { key: 'orders', label: t('modals.zReport.orders'), icon: Receipt, badge: dayOrderDetailCount },
  ];
  const filteredOrderDetails = filterOrders(dayOrderDetails);
  const dashboardPanelClass = isDarkTheme
    ? 'border-yellow-400/20 bg-black/35 text-white shadow-2xl shadow-black/25 backdrop-blur-2xl'
    : 'border-yellow-500/25 bg-white/75 text-slate-950 shadow-2xl shadow-slate-950/15 backdrop-blur-2xl';
  const dashboardInsetClass = `${modalInsetClassName} ${strongTextClass}`;
  const dashboardTileClass = isDarkTheme
    ? 'border-white/12 bg-white/8 text-white shadow-lg shadow-black/10 backdrop-blur-xl'
    : 'border-slate-900/12 bg-white/80 text-slate-950 shadow-lg shadow-slate-950/10 backdrop-blur-xl';

  const renderChecklistIcon = (state: CloseoutChecklistState) => {
    if (state === 'ready') {
      return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    }
    if (state === 'error') {
      return <XCircle className="h-4 w-4 text-rose-500" />;
    }
    if (state === 'pending') {
      return <RefreshCw className={`h-4 w-4 ${softTextClass}`} />;
    }
    return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  };

  // Every dialog the Z window opens (the set-aside, unsaved and TWINT-return confirms, Record
  // cash/card, the manager PIN, the export picker) renders beside it, outside its glass modal.
  // The recovery context puts them on the Z window's layer: without it they sat at the default
  // modal layer, under the Z window, wherever it is opened outside GlobalCashierGate.
  return (
    <CashierRecovery>
    <LiquidGlassModal
      recoveryAccess
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      className={modalShellClassName}
      header={(
        <header
          data-z-report-command-header
          className={`flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 backdrop-blur-xl ${
            isDarkTheme
              ? 'border-yellow-400/15 bg-black/25 text-white'
              : 'border-yellow-500/20 bg-white/70 text-slate-950'
          }`}
        >
          {/* Round 322: a calm, human identity block -- "Close day" + the working day as a FRIENDLY
              localized date (e.g. "Wednesday, 25 June 2026"), never a raw ISO string. A small chip says
              whether it is today's live day or a past day. The verdict ("ready"/"needs attention") lives
              ONLY in the status card below, so the header no longer repeats it. */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-yellow-500/20 bg-white/65 backdrop-blur-xl dark:border-yellow-400/20 dark:bg-white/8">
              <FileText className={`h-5 w-5 ${softTextClass}`} />
            </div>
            <div className="min-w-0">
              <h2 className={`text-2xl font-black tracking-tight ${strongTextClass}`}>
                {t('modals.zReport.clarity.assistantTitle', { defaultValue: 'Close day' })}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`wrap-break-word text-sm font-bold ${softTextClass}`}>{friendlyBusinessDate}</span>
                <span
                  data-z-report-day-chip
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-black ${isLiveDay ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : 'border-slate-900/[0.14] bg-slate-900/4 text-slate-600 dark:border-white/18 dark:bg-white/8 dark:text-white/70'}`}
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
            className={`flex h-11 w-11 min-h-touch min-w-touch shrink-0 items-center justify-center rounded-xl border transition ${glassControlClass}`}
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
              - submittable                          -> the green submit, using the native hard-blocker gate,
              - needs review                         -> amber verdict + the same submit action when no hard blocker exists.
            Money / staff / order ledgers live behind the secondary detail tabs below. Handlers +
            aria-labels unchanged. === */}
        <div data-z-report-close-assistant className="flex shrink-0 flex-col gap-2.5">
          <div
            data-z-report-decision-panel
            className={`rounded-3xl border p-4 sm:p-5 ${
              lockedTerminal
                ? 'border-yellow-500/25 bg-white/55 dark:border-yellow-400/20 dark:bg-black/25'
                : closeoutReady
                  ? 'border-emerald-400/40 bg-emerald-500/8'
                  : 'border-amber-400/45 bg-amber-400/10'
            }`}
          >
            {/* The verdict ("Can I close now?") + the single Commit Z report action. */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                {loading ? (
                  <RefreshCw className={`mt-1 h-7 w-7 shrink-0 animate-spin ${softTextClass}`} />
                ) : lockedTerminal ? (
                  <Lock className={`mt-1 h-7 w-7 shrink-0 ${softTextClass}`} />
                ) : closeoutReady ? (
                  <CheckCircle className="mt-1 h-8 w-8 shrink-0 text-emerald-400" />
                ) : (
                  <AlertTriangle className="mt-1 h-8 w-8 shrink-0 text-amber-500" />
                )}
                <div className="min-w-0">
                  <div className={`wrap-break-word text-2xl font-black leading-tight ${strongTextClass}`}>{closeoutStatusLabel}</div>
                  <div className={`mt-1 max-w-3xl wrap-break-word text-sm font-semibold leading-5 ${mutedTextClass}`}>
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
                      : 'cursor-not-allowed border-slate-900/[0.14] bg-slate-900/5 text-slate-500 opacity-70 dark:border-white/[0.14] dark:bg-white/8 dark:text-white/55'
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
              <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 rounded-xl border px-3 text-xs font-black ${dashboardInsetClass} [&::-webkit-details-marker]:hidden`}>
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
                    className={`min-h-touch flex-1 rounded-xl border px-3 py-2 text-center text-sm font-black outline-hidden sm:flex-none ${glassControlClass}`}
                    aria-label={t('modals.zReport.selectBusinessDay')}
                    disabled={lockDate}
                  />
                </div>
                <div className={`wrap-break-word text-[11px] font-semibold ${softTextClass}`}>
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
            <div className="flex shrink-0 flex-col gap-2 border-b border-slate-900/10 p-3 dark:border-white/10 lg:flex-row lg:items-center">
              <div className="grid flex-1 rounded-xl border border-slate-900/12 bg-white/55 p-1 backdrop-blur-xl dark:border-white/12 dark:bg-black/10 sm:grid-cols-4">
                {reportTabs.map((tab) => {
                  const TabIcon = tab.icon;
                  return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`inline-flex min-h-touch items-center justify-center gap-2 rounded-lg px-3 text-sm font-black transition-transform duration-150 active:scale-[0.98] ${
                      activeTab === tab.key
                        ? 'bg-yellow-400 text-black shadow-lg shadow-yellow-500/20'
                        : isDarkTheme
                          ? 'text-white/70'
                          : 'text-slate-600'
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
                className="flex items-center justify-end gap-1 rounded-xl border border-slate-900/10 bg-white/55 p-1 backdrop-blur-xl dark:border-white/10 dark:bg-white/4"
              >
                {[
                  { key: 'refresh', label: t('modals.zReport.refresh'), icon: RefreshCw, onClick: handleRefreshReport, disabled: loading },
                  { key: 'print', label: t('modals.zReport.print'), icon: Printer, onClick: handlePrintReport, disabled: printing || !canPrintFinalReport, hint: printUnavailableHint },
                  // Stored Zs export even while the live preview cannot load.
                  { key: 'export', label: t('modals.zReport.exportCSV'), icon: UploadCloud, onClick: handleExportReport, disabled: false },
                ].map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.key}
                      type="button"
                      onClick={action.onClick}
                      disabled={action.disabled}
                      className={`inline-flex h-9 min-h-touch items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold ${softTextClass} transition active:bg-white/12 ${action.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                      aria-label={action.label}
                      title={action.hint}
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
                      <div className="mt-0.5 wrap-break-word text-lg font-black text-emerald-600 dark:text-emerald-300">{formatMoney(totalSales)}</div>
                    </div>
                    <div className={`rounded-2xl border p-3 ${dashboardTileClass}`}>
                      <div className={`flex items-center gap-1.5 text-[11px] font-bold ${softTextClass}`}><ShieldCheck className="h-3.5 w-3.5" />{t('modals.zReport.clarity.expectedCash', { defaultValue: 'Expected cash' })}</div>
                      <div className={`mt-0.5 wrap-break-word text-lg font-black ${strongTextClass}`}>{formatMoney(expectedCash)}</div>
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
                        {reportSections.expenses && <>
                          <div className={`hidden md:block ${softTextClass}`}>-</div>
                          <div><div className={softTextClass}>{t('modals.zReport.totalExpenses')}</div><div>{formatMoney(expensesTotal + staffPaymentsTotal)}</div></div>
                        </>}
                        {giftCloseDrawer && (
                          <>
                            <div className={`hidden md:block ${softTextClass}`}>+</div>
                            <div data-z-report-gift-close-term><div className={softTextClass}>{giftCloseText('giftLiabilityCash')}</div><div>{formatGiftMoney(giftCloseDrawer.giftLiabilityCashCents, giftClose.currency)}</div></div>
                          </>
                        )}
                        <div className={`hidden md:block ${softTextClass}`}>=</div>
                        <div><div className={softTextClass}>{t('modals.zReport.expected')}</div><div className="text-emerald-600 dark:text-emerald-300">{formatMoney(expectedCash)}</div></div>
                      </div>
                    </div>
                  </section>
                  {giftClose.state !== 'none' && (
                    <section
                      data-z-report-gift-close
                      data-gift-close-state={giftClose.state}
                      className={`space-y-3 rounded-2xl border p-4 ${giftCloseBlocksFinal ? 'border-rose-400/40 bg-rose-500/10' : dashboardInsetClass}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className={`text-lg font-black ${strongTextClass}`}>{giftCloseText('title')}</h3>
                          <div className={`mt-1 wrap-break-word text-xs font-semibold leading-5 ${mutedTextClass}`}>{giftCloseText('outsideSales')}</div>
                        </div>
                        <span
                          data-z-report-gift-close-status
                          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-black ${giftCloseBlocksFinal
                            ? 'border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-200'
                            : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-800 dark:text-emerald-100'}`}
                        >
                          {giftCloseStatusLabel}
                        </span>
                      </div>
                      {/* One row per gift-bound drawer, in its own currency, exactly as the confirmed proof froze it. */}
                      {giftClose.originals.map((original) => (
                        <article
                          key={`${original.shiftId}:${original.drawerId}`}
                          data-z-report-gift-close-original
                          className={`rounded-xl border p-3 ${dashboardTileClass}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={`truncate text-sm font-black ${strongTextClass}`}>{giftCloseStaffLabel(original)}</span>
                            <span data-z-report-gift-close-currency className={`text-[11px] font-black ${softTextClass}`}>
                              {giftCloseText('currency')}: {original.currency}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
                            {[
                              { key: 'ordinaryExpected', label: giftCloseText('ordinaryExpected'), cents: original.ordinaryExpected_cents },
                              { key: 'giftLiabilityCash', label: giftCloseText('giftLiabilityCash'), cents: original.giftLiabilityCash_cents },
                              { key: 'expected', label: giftCloseText('expected'), cents: original.expected_cents },
                              { key: 'counted', label: giftCloseText('counted'), cents: original.counted_cents },
                              { key: 'variance', label: giftCloseText('variance'), cents: original.variance_cents },
                            ].map((row) => (
                              <div key={row.key} className="min-w-0">
                                <div className={`truncate text-[11px] font-bold ${softTextClass}`}>{row.label}</div>
                                <div className={`mt-0.5 truncate text-sm font-black ${strongTextClass}`}>{formatGiftMoney(row.cents, original.currency)}</div>
                              </div>
                            ))}
                          </div>
                          <div className={`mt-2 wrap-break-word text-[11px] font-semibold ${softTextClass}`}>
                            {giftCloseText('confirmedAt')}: {formatWindowDateTime(original.provenance.confirmedAt)}
                          </div>
                        </article>
                      ))}
                      {giftCloseBlocksFinal && (
                        <div data-z-report-gift-close-blocked className="space-y-1 text-xs font-bold leading-5 text-rose-700 dark:text-rose-200">
                          {giftCloseNotices.map((notice, index) => (
                            <div key={index}>{notice}</div>
                          ))}
                          <div>{giftCloseText('blocked')}</div>
                        </div>
                      )}
                    </section>
                  )}
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
                              { key: 'returned', label: t('modals.zReport.driverCashReturned'), value: drawer.driverCashReturned, tone: mutedTextClass },
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

                                <div className="mt-4 rounded-2xl border border-slate-900/10 bg-white/45 p-4 dark:border-white/12 dark:bg-black/10">
                                  <div className={`text-[11px] font-black uppercase tracking-[0.12em] ${softTextClass}`}>{t('modals.zReport.expected')}</div>
                                  <div className="mt-2 text-3xl font-black text-emerald-600 dark:text-emerald-300">{formatMoney(expected)}</div>
                                </div>

                                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                                  {stats.map((row) => (
                                    <div key={row.key} className="min-w-0 rounded-2xl border border-slate-900/10 bg-white/45 p-3 dark:border-white/12 dark:bg-black/10">
                                      <div className={`wrap-break-word text-xs font-black leading-4 ${softTextClass}`}>{row.label}</div>
                                      <div className={`mt-1 wrap-break-word text-base font-black ${row.tone}`}>{formatMoney(row.value)}</div>
                                    </div>
                                  ))}
                                </div>
                              </article>
                            );
                          }) : (
                            <div className="rounded-2xl border border-dashed border-slate-900/[0.14] bg-slate-900/3 p-6 text-center text-sm font-semibold text-slate-600 dark:border-white/16 dark:bg-white/4 dark:text-white/65">{t('modals.zReport.noDrawers')}</div>
                          )}
                        </div>
                      </div>

                      {reportSections.expenses && (
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
                            <div className="rounded-2xl border border-dashed border-slate-900/[0.14] bg-slate-900/3 p-6 text-center text-sm font-semibold text-slate-600 dark:border-white/16 dark:bg-white/4 dark:text-white/65">{t('modals.zReport.noExpenseDetails')}</div>
                          )}
                        </div>
                      </div>
                      )}
                    </section>
                  )}

                  {activeTab === 'staff' && (
                    <section className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                      <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.staffPerformance')}</h3>
                      <div className="mt-4">
                        {visibleStaffReports.length > 0 ? (
                          /* Round 321: only go two-column when there is more than one staff report -- a lone
                             staff card then uses the full content width instead of rendering as a half-width
                             column with an empty second track and a hard vertical split. */
                          <div className={`grid gap-3 ${visibleStaffReports.length > 1 ? 'xl:grid-cols-2' : 'grid-cols-1'}`}>
                            {visibleStaffReports.map((staff) => {
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
                                ...(staff.orders?.twintAmount ? [{ key: 'twint', label: 'TWINT', value: formatMoney(staff.orders.twintAmount), tone: strongTextClass }] : []),
                                { key: 'return', label: t('modals.zReport.cashToReturn'), value: formatMoney(resolveStaffReturnAmount(staff)), tone: mutedTextClass },
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
                                      <div key={row.key} className="min-w-0 rounded-2xl border border-slate-900/10 bg-white/45 p-3 dark:border-white/12 dark:bg-black/10">
                                        <div className={`wrap-break-word text-xs font-black leading-4 ${softTextClass}`}>{row.label}</div>
                                        <div className={`mt-1 wrap-break-word text-base font-black ${row.tone}`}>{row.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-dashed border-slate-900/[0.14] bg-slate-900/3 p-6 text-center text-sm font-semibold text-slate-600 dark:border-white/16 dark:bg-white/4 dark:text-white/65">{t('modals.zReport.noStaffReports')}</div>
                        )}
                      </div>
                      {/* Phone staff after the local staff (founder rule 13/10/2026): what each phone
                          shift sold and how its till was handed over. Never part of the totals above. */}
                      {(phoneShiftStaffRows.length > 0 || (phoneShiftsKey && phoneShiftsUnavailable)) && (
                        <div data-z-report-phone-shifts-staff className="mt-5">
                          <h4 className={`text-base font-black ${strongTextClass}`}>{t('phoneShifts.title', { defaultValue: 'Phone shifts' })}</h4>
                          {phoneShiftStaffRows.length === 0 ? (
                            <div className={`mt-2 wrap-break-word text-xs font-semibold leading-5 ${mutedTextClass}`}>
                              {t('phoneShifts.unavailable', {
                                defaultValue: 'Phone shifts could not be checked. Check the connection and try again.',
                              })}
                            </div>
                          ) : (
                            <div className={`mt-3 grid gap-3 ${phoneShiftStaffRows.length > 1 ? 'xl:grid-cols-2' : 'grid-cols-1'}`}>
                              {phoneShiftStaffRows.map((row) => {
                                const rowCurrency = phoneShiftCurrency(row.currency, reportCurrency);
                                const money = (value: number | null) => (value === null ? '—' : formatCurrency(value, rowCurrency));
                                const phoneMarker = row.phoneState === 'deactivated'
                                  ? t('phoneShifts.phoneDeactivated', { defaultValue: 'phone deactivated' })
                                  : row.phoneState === 'removed'
                                    ? t('phoneShifts.phoneRemoved', { defaultValue: 'phone removed' })
                                    : null;
                                const statRows = [
                                  { key: 'orders', label: t('modals.zReport.orders'), value: row.ordersCount === null ? '—' : String(row.ordersCount), tone: strongTextClass },
                                  { key: 'sales', label: t('modals.zReport.sales'), value: money(row.salesTotal), tone: 'text-emerald-600 dark:text-emerald-300' },
                                  { key: 'cash', label: t('modals.zReport.cash'), value: money(row.cashSales), tone: 'text-amber-600 dark:text-amber-300' },
                                  { key: 'card', label: t('modals.zReport.card'), value: money(row.cardSales), tone: 'text-amber-600 dark:text-amber-300' },
                                  { key: 'counted', label: t('modals.zReport.phoneShifts.countedCash', { defaultValue: 'Counted cash' }), value: money(row.countedCash), tone: mutedTextClass },
                                  // The till's count against what it should hold: "+" over, "-" short.
                                  {
                                    key: 'variance',
                                    label: t('modals.zReport.variance'),
                                    value: row.cashVariance === null
                                      ? '—'
                                      : Math.abs(row.cashVariance) < 0.005
                                        ? formatCurrency(0, rowCurrency)
                                        : `${row.cashVariance > 0 ? '+' : '-'}${formatCurrency(Math.abs(row.cashVariance), rowCurrency)}`,
                                    tone: row.cashVariance !== null && Math.abs(row.cashVariance) >= 0.005
                                      ? 'text-amber-600 dark:text-amber-300'
                                      : mutedTextClass,
                                  },
                                ];
                                return (
                                  <article key={row.id} data-z-report-phone-shift={row.id} className={`rounded-xl border p-4 ${dashboardTileClass}`}>
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className={`truncate text-base font-black ${strongTextClass}`}>{row.staffName}</div>
                                        <div className={`mt-1 wrap-break-word text-xs font-semibold ${softTextClass}`}>
                                          {phoneMarker ? `${row.phoneName} (${phoneMarker})` : row.phoneName} · {formatWindowDateTime(row.checkIn)} - {formatWindowDateTime(row.checkOut)}
                                        </div>
                                      </div>
                                      <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                        {row.role && (
                                          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getRoleBadgeClasses(row.role)}`}>{translateRoleName(t, row.role)}</span>
                                        )}
                                        <span data-z-report-phone-shift-handover={row.handover ?? 'unknown'} className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getHandoverBadgeClasses(row.handover)}`}>
                                          {row.handover
                                            ? t(`phoneShifts.handover.${row.handover}`, { defaultValue: PHONE_SHIFT_HANDOVER_LABELS[row.handover] })
                                            : '—'}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                      {statRows.map((stat) => (
                                        <div key={stat.key} className="min-w-0 rounded-2xl border border-slate-900/10 bg-white/45 p-3 dark:border-white/12 dark:bg-black/10">
                                          <div className={`wrap-break-word text-xs font-black leading-4 ${softTextClass}`}>{stat.label}</div>
                                          <div className={`mt-1 wrap-break-word text-base font-black ${stat.tone}`}>{stat.value}</div>
                                        </div>
                                      ))}
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Tips that went to a stylist of the order (salon, 21/10/2026): one row per
                          staff member, shown only when there is one. Stylists without a shift show here only. */}
                      {staffTipRows.length > 0 && (
                        <div data-z-report-staff-tips className="mt-5">
                          <h4 className={`text-base font-black ${strongTextClass}`}>{t('salonStaff.tipsByStaff', { defaultValue: 'Tips by staff' })}</h4>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {staffTipRows.map((tip) => (
                              <div key={tip.staffId || tip.staffName} data-z-report-staff-tip={tip.staffId} className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-slate-900/10 bg-white/45 p-3 dark:border-white/12 dark:bg-black/10">
                                <span className={`truncate text-sm font-black ${strongTextClass}`}>{tip.staffName || tip.staffId}</span>
                                <span className="shrink-0 text-base font-black text-emerald-600 dark:text-emerald-300">{formatMoney(tip.amount)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {activeTab === 'orders' && (
                    <section data-z-report-orders-list className={`rounded-xl border p-4 ${dashboardInsetClass}`}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className={`text-lg font-black ${strongTextClass}`}>{t('modals.zReport.orderDetails')}</h3>
                          <span className={`rounded-full border border-slate-900/12 px-2 py-0.5 text-xs font-black ${softTextClass} dark:border-white/[0.14]`}>{dayOrderDetailCount}</span>
                          <button
                            type="button"
                            onClick={handleExportOrdersReport}
                            className="min-h-[36px] rounded-lg border border-slate-900/12 px-3 text-xs font-black text-slate-700 transition active:bg-slate-900/6 disabled:opacity-50 dark:border-white/[0.14] dark:text-white/80 dark:active:bg-white/10"
                          >
                            {t('modals.zReport.exportOrdersCSV')}
                          </button>
                          {zReport?.dayOrdersTruncated ? (
                            <span className={`text-xs font-semibold ${softTextClass}`}>{t('modals.zReport.ordersListTruncated')}</span>
                          ) : null}
                        </div>
                        <div className="flex flex-col gap-2 xl:items-end">
                          <div className="flex flex-wrap gap-1 rounded-xl border border-slate-900/10 bg-white/45 p-1 backdrop-blur-xl dark:border-white/12 dark:bg-black/10">
                            {orderTypeFilterOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setOrderTypeFilter(option.value)}
                                className={`min-h-[36px] rounded-lg px-3 text-xs font-black transition ${
                                  orderTypeFilter === option.value
                                    ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20'
                                    : 'text-slate-600 active:bg-slate-900/6 dark:text-white/70 dark:active:bg-white/10'
                                }`}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1 rounded-xl border border-slate-900/10 bg-white/45 p-1 backdrop-blur-xl dark:border-white/12 dark:bg-black/10">
                            {paymentMethodFilterOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setPaymentMethodFilter(option.value)}
                                className={`min-h-[36px] rounded-lg px-3 text-xs font-black transition ${
                                  paymentMethodFilter === option.value
                                    ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                                    : 'text-slate-600 active:bg-slate-900/6 dark:text-white/70 dark:active:bg-white/10'
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
                              <div className={`mt-1 text-xs font-semibold ${softTextClass}`}>
                                {formatTime(order.createdAt)} · {[
                                  order.staffName,
                                  order.platform
                                    ? t('modals.zReport.platformOrderSource', { platform: order.platform })
                                    : null,
                                ].filter(Boolean).join(' · ') || '—'}
                              </div>
                            </div>
                            <div className={`text-xs font-semibold ${softTextClass}`}>{localizeZReportOrderType(order.orderType, t)} · {localizeZReportPaymentLabel(order.paymentMethod, t)}</div>
                            <div className="text-right text-sm font-black text-emerald-600 dark:text-emerald-300">{formatMoney(order.amount)}</div>
                          </div>
                        )) : (
                          <div className="rounded-2xl border border-dashed border-slate-900/[0.14] bg-slate-900/3 p-6 text-center text-sm font-semibold text-slate-600 dark:border-white/16 dark:bg-white/4 dark:text-white/65">{t('modals.zReport.noOrdersMatchFilter')}</div>
                        )}
                      </div>
                    </section>
                  )}

                  {activeTab === 'review' && (
                    <div className="space-y-3">
                      <section data-z-report-review-money-overview className={`rounded-2xl border p-4 ${dashboardInsetClass}`}>
                        <div className="flex flex-col gap-4 xl:flex-row xl:items-stretch">
                          <div className="min-w-0 flex-1 rounded-2xl border border-yellow-400/25 bg-yellow-400/8 p-4">
                            <div className={`text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                              {t('modals.zReport.tabs.overview', { defaultValue: 'Overview' })}
                            </div>
                            <div className="mt-2">
                              <div className="min-w-0">
                                <div className={`wrap-break-word text-sm font-bold ${mutedTextClass}`}>
                                  {t('modals.zReport.actualEarned')}
                                </div>
                                <div className="mt-1 wrap-break-word text-4xl font-black leading-none text-yellow-300 sm:text-5xl">
                                  {formatMoney(collectedTotal)}
                                </div>
                                <div data-z-report-earned-source className={`mt-2 wrap-break-word text-xs font-black uppercase tracking-[0.08em] ${softTextClass}`}>
                                  {t('modals.zReport.orders', { defaultValue: 'Orders' })}: {totalOrders} · {t('modals.zReport.liveCurrentWindow')} · {t('modals.zReport.totalShifts')}: {totalShiftCount} · {t('common.status.active', { defaultValue: 'Active' })}: {activeShiftCount} · {t('common.status.closed', { defaultValue: 'Closed' })}: {closedShiftCount}
                                </div>
                                <div data-z-report-revenue-split className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                  {revenueSplitTiles.map((tile) => (
                                    <div key={tile.key} className={`min-w-0 rounded-xl border p-2 ${dashboardTileClass}`}>
                                      <div className={`truncate text-[11px] font-bold ${softTextClass}`}>{tile.key === 'twint' ? <img src={twintLogo} alt="TWINT" className="h-5 mx-auto rounded-sm" /> : tile.label}</div>
                                      <div className={`mt-0.5 truncate text-base font-black ${strongTextClass}`}>{tile.value}</div>
                                    </div>
                                  ))}
                                </div>
                                <div className={`mt-1 wrap-break-word text-[11px] font-semibold ${softTextClass}`}>
                                  {t('modals.zReport.revenueSplitHint')}
                                </div>
                              </div>
                            </div>
                            <div className={`mt-3 wrap-break-word text-sm font-semibold leading-6 ${mutedTextClass}`}>
                              {moneyOverviewMessage}
                            </div>
                          </div>

                          <div className="grid min-w-0 flex-[1.35] grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {moneyOverviewCards.map((item) => (
                              <div key={item.key} className={`rounded-2xl border p-3 ${dashboardTileClass}`}>
                                <div className={`wrap-break-word text-[11px] font-black uppercase tracking-[0.08em] ${softTextClass}`}>
                                  {item.label}
                                </div>
                                <div className={`mt-1 wrap-break-word text-xl font-black ${item.tone}`}>{item.value}</div>
                                <div className={`mt-1 wrap-break-word text-[11px] font-semibold leading-4 ${softTextClass}`}>
                                  {item.helper}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="mt-3 rounded-2xl border border-slate-900/10 bg-white/45 p-3 dark:border-white/12 dark:bg-black/10">
                          <div className={`mb-2 text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                            {t('modals.zReport.cashFlow', { defaultValue: 'Cash Flow' })}
                          </div>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
                            {moneyFlowRows.map((row) => (
                              <div key={row.key} className="min-w-0 rounded-xl border border-slate-900/10 bg-white/55 p-2.5 dark:border-white/10 dark:bg-white/4">
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
                            <div className={`wrap-break-word text-sm font-black ${strongTextClass}`}>{item.label}</div>
                            <div className={`mt-0.5 wrap-break-word text-xs font-semibold leading-5 ${mutedTextClass}`}>{item.description}</div>
                            {item.details && item.details.length > 0 && (
                              <ul data-z-report-checklist-details={item.key} className="mt-1.5 space-y-0.5">
                                {item.details.map((line, index) => (
                                  <li key={`${item.key}-${index}`} className={`wrap-break-word text-xs font-black leading-5 ${strongTextClass}`}>
                                    {line}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          {item.key === 'phone-shifts' && phoneShiftsUnavailable ? (
                            <button
                              type="button"
                              data-z-report-phone-shifts-retry
                              onClick={retryPhoneShifts}
                              disabled={phoneShiftsReading}
                              aria-busy={phoneShiftsReading}
                              className={`inline-flex min-h-touch shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition ${glassControlClass} ${phoneShiftsReading ? 'cursor-not-allowed opacity-60' : ''}`}
                            >
                              <RefreshCw className={`h-4 w-4 ${phoneShiftsReading ? 'animate-spin' : ''}`} />
                              {t('phoneShifts.retry', { defaultValue: 'Retry' })}
                            </button>
                          ) : item.key === 'fiscal' ? (
                            <button
                              type="button"
                              data-z-report-fiscal-retry
                              onClick={handleRetryFiscalQueue}
                              disabled={retryingFiscalQueue}
                              aria-busy={retryingFiscalQueue}
                              className={`inline-flex min-h-touch shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-black transition ${glassControlClass} ${retryingFiscalQueue ? 'cursor-not-allowed opacity-60' : ''}`}
                            >
                              <RefreshCw className={`h-4 w-4 ${retryingFiscalQueue ? 'animate-spin' : ''}`} />
                              {item.actionLabel}
                            </button>
                          ) : (
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
                          )}
                        </div>
                      ))}

                      {/* The queued fiscal receipts behind the fiscal blocker:
                          order and receipt number, attempts, last error. What
                          support needs, without the payload (29/09/2026). */}
                      {fiscalQueueBlocking && fiscalQueue && fiscalQueue.rows.length > 0 && (
                        <section
                          data-z-report-fiscal-queue
                          className="rounded-2xl border border-rose-400/40 bg-rose-500/10 p-4"
                        >
                          <div className={`mb-2 text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                            {t('modals.zReport.fiscalQueue.listTitle', {
                              count: fiscalQueueCount,
                              defaultValue: 'Fiscal submissions waiting ({{count}})',
                            })}
                          </div>
                          <div className="space-y-1">
                            {fiscalQueue.rows.map((row) => (
                              <div
                                key={row.queueItemId}
                                className={`flex flex-wrap items-center justify-between gap-2 text-xs font-semibold ${mutedTextClass}`}
                              >
                                <span className="min-w-0 truncate">
                                  {row.receiptNumber || row.orderId}
                                </span>
                                <span className="shrink-0 tabular-nums">
                                  {t('modals.zReport.fiscalQueue.attempts', {
                                    attempts: row.attempts,
                                    max: row.maxRetries,
                                    defaultValue: 'Attempts {{attempts}}/{{max}}',
                                  })}
                                </span>
                                {row.lastError && (
                                  <span className={`w-full wrap-break-word text-[11px] ${softTextClass}`}>
                                    {row.lastError}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}

                      {/* Reconciliation: the order side of the day next to the
                          payment side, and the money between them. The two are
                          never added together -- platform turnover already
                          lives inside both. Shown whenever they disagree or a
                          closed day's orders were held back, so a EUR 531 gap
                          can never again be invisible on a green checklist. */}
                      {integrity && (integrity.blockingFindings > 0
                        || Math.abs(integrity.unexplainedDifference ?? integrity.difference ?? 0) >= 0.01
                        || (integrity.refundedOrders?.orders ?? 0) > 0
                        || (integrity.carriedOverFromClosedDays?.orders ?? 0) > 0
                        || (integrity.unclassifiedPlatforms?.length ?? 0) > 0) && (
                        <section className={`rounded-2xl border p-4 ${integrity.reconciled
                          ? dashboardInsetClass
                          : 'border-rose-400/40 bg-rose-500/10'}`}>
                          <div className={`mb-2 text-xs font-black uppercase tracking-[0.12em] ${softTextClass}`}>
                            {t('modals.zReport.reconciliationTitle', { defaultValue: 'Reconciliation' })}
                          </div>
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            <div className="min-w-0 rounded-xl border border-slate-900/10 bg-white/55 p-2.5 dark:border-white/10 dark:bg-white/4">
                              <div className={`truncate text-[11px] font-bold ${softTextClass}`}>
                                {t('modals.zReport.orderTurnover', { defaultValue: 'Order turnover' })}
                              </div>
                              <div className={`mt-1 truncate text-sm font-black ${strongTextClass}`}>
                                {formatMoney(integrity.orderTurnover ?? 0)}
                              </div>
                            </div>
                            <div className="min-w-0 rounded-xl border border-slate-900/10 bg-white/55 p-2.5 dark:border-white/10 dark:bg-white/4">
                              <div className={`truncate text-[11px] font-bold ${softTextClass}`}>
                                {t('modals.zReport.paymentCoverage', { defaultValue: 'Payment coverage' })}
                              </div>
                              <div className={`mt-1 truncate text-sm font-black ${strongTextClass}`}>
                                {formatMoney(integrity.paymentCoverage ?? 0)}
                              </div>
                            </div>
                            <div className="min-w-0 rounded-xl border border-slate-900/10 bg-white/55 p-2.5 dark:border-white/10 dark:bg-white/4">
                              <div className={`truncate text-[11px] font-bold ${softTextClass}`}>
                                {t('modals.zReport.reconciliationDifference', { defaultValue: 'Difference' })}
                              </div>
                              {/* Colour on what is UNEXPLAINED, not on raw
                                  arithmetic: a normal refund leaves a real
                                  difference and must not read as a gap. */}
                              <div className={`mt-1 truncate text-sm font-black ${Math.abs(integrity.unexplainedDifference ?? integrity.difference ?? 0) >= 0.01
                                ? 'text-rose-600 dark:text-rose-300'
                                : 'text-emerald-600 dark:text-emerald-300'}`}>
                                {formatMoney(integrity.difference ?? 0)}
                              </div>
                              {(integrity.refundedOrders?.orders ?? 0) > 0 && (
                                <div className={`mt-0.5 truncate text-[11px] font-semibold ${mutedTextClass}`}>
                                  {t('modals.zReport.reconciliationExplainedByRefunds', {
                                    amount: formatMoney(integrity.explainedDifference ?? 0),
                                    defaultValue: '{{amount}} explained by refunds',
                                  })}
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 rounded-xl border border-slate-900/10 bg-white/55 p-2.5 dark:border-white/10 dark:bg-white/4">
                              <div className={`truncate text-[11px] font-bold ${softTextClass}`}>
                                {t('modals.zReport.reconciliationOrdersAffected', { defaultValue: 'Orders affected' })}
                              </div>
                              <div className={`mt-1 truncate text-sm font-black ${strongTextClass}`}>
                                {integrity.blockingFindings ?? 0}
                              </div>
                            </div>
                          </div>
                          {Array.isArray(integrity.findingsByReason) && integrity.findingsByReason.length > 0 && (
                            <div className="mt-3 space-y-1">
                              {integrity.findingsByReason.map((reason) => (
                                <div key={reason.reasonCode} className={`flex items-center justify-between text-xs font-semibold ${mutedTextClass}`}>
                                  <span className="truncate">
                                    {t(`modals.zReport.reconciliationReason.${reason.reasonCode}`, {
                                      defaultValue: reason.reasonCode.replace(/_/g, ' '),
                                    })}
                                  </span>
                                  <span className="shrink-0 tabular-nums">
                                    {reason.orders} · {formatMoney(reason.difference)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          {(integrity.carriedOverFromClosedDays?.orders ?? 0) > 0 && (
                            <div className={`mt-3 text-xs font-semibold leading-5 ${mutedTextClass}`}>
                              {t('modals.zReport.reconciliationCarriedOver', {
                                count: integrity.carriedOverFromClosedDays?.orders ?? 0,
                                amount: formatMoney(integrity.carriedOverFromClosedDays?.amount ?? 0),
                                defaultValue:
                                  '{{count}} order(s) worth {{amount}} belong to a day an earlier Z already closed and are excluded from these totals.',
                              })}
                            </div>
                          )}
                          {/* Sources we could not name. Their money IS in the
                              totals above -- only the platform attribution is
                              withheld, because `plugin` shares its namespace
                              with payment/analytics/e-commerce integrations and
                              guessing one into ΠΛΑΤΦΟΡΜΕΣ would be a
                              fabrication. Named here so it can be classified. */}
                          {(integrity.unclassifiedPlatforms?.length ?? 0) > 0 && (
                            <div className={`mt-3 text-xs font-semibold leading-5 ${mutedTextClass}`}>
                              <div>
                                {t('modals.zReport.reconciliationUnclassifiedSources', {
                                  defaultValue:
                                    'Order sources not recognised as a platform. Their money is included in the totals above; only the platform attribution is withheld.',
                                })}
                              </div>
                              {(integrity.unclassifiedPlatforms ?? []).map((entry) => (
                                <div key={entry.source} className="mt-1 flex items-center justify-between">
                                  <span className="truncate">{entry.source}</span>
                                  <span className="shrink-0 tabular-nums">
                                    ×{entry.orders} · {formatMoney(entry.amount)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </section>
                      )}

                      {effectivePaymentBlockers.length > 0 && (
                        <UnsettledPaymentBlockersPanel
                          blockers={effectivePaymentBlockers}
                          title={t('modals.zReport.paymentIntegrityTitle', {
                            defaultValue: 'Orders Blocking Z-Report Closeout',
                          })}
                          helperText={t('modals.zReport.paymentIntegrityResolveHelper', {
                            defaultValue:
                              'Resolve the missing balance here. The fix is recorded against the original business-day drawer before you retry the Z-report.',
                          })}
                          onResolveBlocker={handleResolveBlocker}
                          onResolveSetAsidePayment={setSetAsideConfirmation}
                          onSaveUnsavedPayment={(blocker) => { void handleSaveUnsavedAgain(blocker); }}
                          onResolveUnsavedPayment={setUnsavedConfirmation}
                          onCloseHeldEdit={(blocker) => { void handleCloseHeldEdit(blocker); }}
                          onResolveTwintReturned={(blocker) => { setTwintReturnReference(''); setTwintReturnPin(''); setTwintReturnError(null); setTwintReturn(blocker); }}
                          resolvingKey={resolvingBlockerKey}
                        />
                      )}

                      {twintReturned.length > 0 && (
                        <div
                          data-testid="z-twint-returned-outside-pos"
                          className={`rounded-2xl border px-4 py-3 text-sm ${modalInsetClassName}`}
                        >
                          <div className={`flex items-center justify-between gap-3 font-bold ${strongTextClass}`}>
                            <span>{t('twintPayment.returned.zLine', { defaultValue: 'TWINT receipts returned outside the POS' })}</span>
                            <span className="tabular-nums">
                              {twintReturned.length} · {formatCurrency(twintReturnedCents / 100, 'CHF')}
                            </span>
                          </div>
                          <p className={`mt-1 text-xs ${softTextClass}`}>
                            {t('twintPayment.returned.zNote', { defaultValue: 'Not counted in sales or drawer cash.' })}
                          </p>
                        </div>
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
    {setAsideConfirmation && (
    <ConfirmDialog
      isOpen
      onClose={() => setSetAsideConfirmation(null)}
      onConfirm={() => { void handleConfirmSetAsideReturned(); }}
      variant="warning"
      title={t('modals.zReport.setAsideConfirmTitle', { defaultValue: 'Money given back?' })}
      message={t('modals.zReport.setAsideConfirmMessage', {
        amount: formatMoney(setAsideConfirmation?.reviewPayment?.amount ?? 0),
        method: getLocalizedPaymentMethod(setAsideConfirmation?.reviewPayment?.method ?? '', t),
        order: setAsideConfirmation?.orderNumber ?? '',
        defaultValue:
          'Confirm that {{amount}} ({{method}}) for order {{order}} was given back to the customer. It stays out of the totals.',
      })}
      confirmText={t('modals.zReport.setAsideConfirmAction', { defaultValue: 'Confirm' })}
      cancelText={t('common.actions.cancel', { defaultValue: 'Cancel' })}
    />
    )}
    {unsavedConfirmation && (
    <ConfirmDialog
      isOpen
      onClose={() => setUnsavedConfirmation(null)}
      onConfirm={() => { void handleConfirmUnsavedReturned(); }}
      variant="warning"
      title={t('modals.zReport.unsavedConfirmTitle', { defaultValue: 'Money given back?' })}
      message={isNewOrderCheckoutBlocker(unsavedConfirmation)
        ? t('modals.zReport.unsavedConfirmMessageNewOrder', {
          amount: formatMoney(unsavedConfirmation?.unsavedPayment?.amount ?? 0),
          defaultValue:
            'Confirm that the {{amount}} charged for a new order this till never saved was given back to the customer. The order and its payment will not be saved.',
        })
        : t('modals.zReport.unsavedConfirmMessage', {
          amount: formatMoney(unsavedConfirmation?.unsavedPayment?.amount ?? 0),
          order: unsavedConfirmation?.orderNumber ?? '',
          defaultValue:
            'Confirm that the {{amount}} charged for order {{order}} was given back to the customer. The payment will not be saved, and the order stays as it is.',
        })}
      confirmText={t('modals.zReport.unsavedConfirmAction', { defaultValue: 'Confirm' })}
      cancelText={t('common.actions.cancel', { defaultValue: 'Cancel' })}
    />
    )}
    {twintReturn && (
    <ConfirmDialog
      isOpen
      onClose={closeTwintReturn}
      onConfirm={() => { void handleConfirmTwintReturned(); }}
      variant="warning"
      title={t('twintPayment.returned.title', { defaultValue: 'TWINT receipt returned outside the POS' })}
      message={t('twintPayment.returned.body', {
        amount: formatCurrency((twintReturn.unsavedPayment?.amountCents ?? 0) / 100, twintReturn.unsavedPayment?.currency || 'CHF'),
        defaultValue:
          'Only if the customer got the {{amount}} back through TWINT outside the POS. Nothing is charged or refunded here. A manager confirms it and it is kept out of sales and drawer cash.',
      })}
      details={(
        <div className="space-y-3">
          <label className="block space-y-2">
            <span className="block font-semibold">
              {t('twintPayment.returned.referenceLabel', { defaultValue: 'Reference (required)' })}
            </span>
            <input
              type="text"
              value={twintReturnReference}
              maxLength={200}
              autoComplete="off"
              data-testid="twint-return-reference"
              onChange={(event) => { setTwintReturnReference(event.target.value); setTwintReturnError(null); }}
              placeholder={t('twintPayment.returned.referencePlaceholder', { defaultValue: 'TWINT refund reference or note' })}
              className="liquid-glass-modal-input w-full rounded-lg px-3 py-2"
            />
          </label>
          <label className="block space-y-2">
            <span className="block font-semibold">
              {t('twintPayment.returned.managerPin', { defaultValue: 'Manager PIN' })}
            </span>
            <input
              type="password"
              inputMode="numeric"
              value={twintReturnPin}
              maxLength={8}
              autoComplete="off"
              data-testid="twint-return-manager-pin"
              onChange={(event) => { setTwintReturnPin(event.target.value.replace(/\D/g, '')); setTwintReturnError(null); }}
              className="liquid-glass-modal-input w-full rounded-lg px-3 py-2"
            />
          </label>
          {twintReturnError && <span role="alert" className="block text-red-600 dark:text-red-300">{twintReturnError}</span>}
        </div>
      )}
      confirmText={t('twintPayment.returned.confirm', { defaultValue: 'Confirm return' })}
      cancelText={t('common.actions.cancel', { defaultValue: 'Cancel' })}
    />
    )}
    {isOpen && exportDialogIntent && (
    <ZReportExportDialog
      isOpen
      onClose={() => setExportDialogIntent(null)}
      shownReport={zReport}
      intent={exportDialogIntent}
    />
    )}
    {recordBlocker.confirmDialog}
    {confirmationModal}
    </CashierRecovery>
  );

};

export default ZReportModal;
