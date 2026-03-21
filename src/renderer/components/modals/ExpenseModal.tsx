import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeDollarSign,
  ClipboardList,
  Clock3,
  Euro,
  FileText,
  Receipt,
  RefreshCw,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { LiquidGlassModal, POSGlassBadge, POSGlassButton } from '../ui/pos-glass-components';
import { useShift } from '../../contexts/shift-context';
import type {
  RecordStaffPaymentParams,
  ShiftExpense,
  StaffPayment,
  StaffShift,
} from '../../types';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getBridge } from '../../../lib';

interface ExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ExpenseTab = 'expenses' | 'staffPayments' | 'activity';
type ExpenseType = ShiftExpense['expense_type'];
type StaffPaymentType = RecordStaffPaymentParams['paymentType'];

interface StaffOption {
  id: string;
  name: string;
  role: string;
}

interface ResolvedCashierContext {
  branchId: string;
  terminalId: string;
  cashierShift: StaffShift | null;
}

interface StaffSchedulePayload {
  success?: boolean;
  staff?: unknown[];
  error?: string;
}

interface ActivityItem {
  id: string;
  kind: 'expense' | 'staffPayment';
  title: string;
  subtitle: string;
  amount: number;
  createdAt: string;
}

const EXPENSE_TYPES: ExpenseType[] = ['supplies', 'maintenance', 'petty_cash', 'refund', 'other'];
const STAFF_PAYMENT_TYPES: StaffPaymentType[] = ['wage', 'tip', 'bonus', 'advance', 'other'];
const INVALID_CONTEXT_VALUES = new Set([
  '',
  'default-organization',
  'default-org',
  'default-branch',
  'default-terminal',
]);

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return fallback;
}

function unwrapData<T>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
    return ((value as { data?: T }).data ?? null) as T | null;
  }
  return value as T;
}

function unwrapArray<T>(value: unknown): T[] {
  const raw = unwrapData<unknown>(value);
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function normalizeContextValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (INVALID_CONTEXT_VALUES.has(trimmed.toLowerCase())) {
    return '';
  }
  return trimmed;
}

function isDrawerOwnerRole(role: string | null | undefined): boolean {
  return role === 'cashier' || role === 'manager';
}

function normalizeStaffOption(value: unknown): StaffOption | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id ?? '').trim();
  if (!id) return null;

  const roles = Array.isArray(record.roles)
    ? record.roles
        .map((role) => {
          if (!role || typeof role !== 'object') return null;
          const roleRecord = role as Record<string, unknown>;
          return {
            name: String(roleRecord.name ?? roleRecord.role_name ?? 'staff').trim(),
            displayName: String(
              roleRecord.displayName ??
                roleRecord.display_name ??
                roleRecord.role_display_name ??
                roleRecord.name ??
                roleRecord.role_name ??
                'Staff',
            ).trim(),
            isPrimary: Boolean(roleRecord.isPrimary ?? roleRecord.is_primary ?? false),
          };
        })
        .filter((role): role is { name: string; displayName: string; isPrimary: boolean } => Boolean(role))
    : [];

  const primaryRole = roles.find((role) => role.isPrimary) ?? roles[0];
  const fullName = `${String(record.firstName ?? record.first_name ?? '').trim()} ${String(record.lastName ?? record.last_name ?? '').trim()}`
    .trim();

  return {
    id,
    name: String(record.name ?? '').trim() || fullName || 'Staff',
    role:
      primaryRole?.displayName ||
      String(
        (record.role as Record<string, unknown> | undefined)?.displayName ??
          (record.role as Record<string, unknown> | undefined)?.display_name ??
          (record.role as Record<string, unknown> | undefined)?.name ??
          record.role_display_name ??
          record.role_name ??
          'Staff',
      ).trim(),
  };
}

export function ExpenseModal({ isOpen, onClose }: ExpenseModalProps) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { staff, activeShift } = useShift();

  const [activeTab, setActiveTab] = useState<ExpenseTab>('expenses');
  const [cashierContext, setCashierContext] = useState<ResolvedCashierContext>({
    branchId: '',
    terminalId: '',
    cashierShift: null,
  });
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);
  const [staffPayments, setStaffPayments] = useState<StaffPayment[]>([]);
  const [resolving, setResolving] = useState(false);
  const [submittingExpense, setSubmittingExpense] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [cashierWarning, setCashierWarning] = useState('');
  const [staffDirectoryWarning, setStaffDirectoryWarning] = useState('');
  const [expenseDraft, setExpenseDraft] = useState({
    expenseType: 'other' as ExpenseType,
    amount: '',
    description: '',
    receiptNumber: '',
  });
  const [paymentDraft, setPaymentDraft] = useState({
    paidToStaffId: '',
    amount: '',
    paymentType: 'wage' as StaffPaymentType,
    notes: '',
  });

  const cashierShift = cashierContext.cashierShift;
  const canRecord = Boolean(cashierShift?.id) && !resolving;
  const currentCashierStaffId = cashierShift?.staff_id || staff?.databaseStaffId || staff?.staffId || '';
  const cashierShiftSyncStatus = String(cashierShift?.sync_status ?? '').trim().toLowerCase();
  const isCashierShiftSyncBlocked = Boolean(
    cashierShift?.id && cashierShiftSyncStatus && cashierShiftSyncStatus !== 'synced',
  );
  const cashierShiftSyncWarning = isCashierShiftSyncBlocked
    ? cashierShiftSyncStatus === 'failed'
      ? t('modals.expense.cashierShiftSyncFailedWarning', {
          defaultValue:
            'This cashier shift is saved locally, but its sync needs attention. New expenses and staff payments will stay local until the cashier shift sync succeeds.',
        })
      : t('modals.expense.cashierShiftSyncPendingWarning', {
          defaultValue:
            'This cashier shift is still waiting to sync. New expenses and staff payments are saved locally now and will sync after the cashier shift reaches the server.',
        })
    : '';

  const totalExpenses = useMemo(
    () => expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    [expenses],
  );
  const totalStaffPayments = useMemo(
    () => staffPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    [staffPayments],
  );
  const combinedOutflow = totalExpenses + totalStaffPayments;

  const recentExpenses = useMemo(
    () =>
      [...expenses]
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
        .slice(0, 5),
    [expenses],
  );
  const recentPayments = useMemo(
    () =>
      [...staffPayments]
        .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
        .slice(0, 5),
    [staffPayments],
  );
  const activityItems = useMemo<ActivityItem[]>(
    () =>
      [
        ...expenses.map((expense) => ({
          id: `expense-${expense.id}`,
          kind: 'expense' as const,
          title: expense.description || t('modals.expense.untitledExpense', 'Untitled expense'),
          subtitle: t(`modals.expense.expenseTypes.${expense.expense_type}`, expense.expense_type),
          amount: Number(expense.amount || 0),
          createdAt: expense.created_at,
        })),
        ...staffPayments.map((payment) => ({
          id: `payment-${payment.id}`,
          kind: 'staffPayment' as const,
          title: payment.staff_name || t('common.unknown', 'Unknown'),
          subtitle: `${t(`modals.expense.paymentTypes.${payment.payment_type}`, payment.payment_type)}${payment.notes ? ` • ${payment.notes}` : ''}`,
          amount: Number(payment.amount || 0),
          createdAt: payment.created_at,
        })),
      ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [expenses, staffPayments, t],
  );

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab('expenses');
    setExpenseDraft({ expenseType: 'other', amount: '', description: '', receiptNumber: '' });
    setPaymentDraft({ paidToStaffId: '', amount: '', paymentType: 'wage', notes: '' });
    void refreshModalData();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !currentCashierStaffId) return;
    if (!staffOptions.some((option) => option.id === currentCashierStaffId)) return;
    setPaymentDraft((current) =>
      current.paidToStaffId ? current : { ...current, paidToStaffId: currentCashierStaffId },
    );
  }, [isOpen, currentCashierStaffId, staffOptions]);

  const resolveActiveCashierContext = async (): Promise<ResolvedCashierContext> => {
    const cached = getCachedTerminalCredentials();
    let refreshed: Partial<{ branchId: string; terminalId: string }> = {};
    try {
      refreshed = await refreshTerminalCredentialCache();
    } catch (error) {
      console.warn('[ExpenseModal] Failed to refresh terminal credential cache:', error);
    }

    const branchId =
      normalizeContextValue(refreshed.branchId) ||
      normalizeContextValue(cached.branchId) ||
      normalizeContextValue(activeShift?.branch_id) ||
      normalizeContextValue(staff?.branchId);
    const terminalId =
      normalizeContextValue(refreshed.terminalId) ||
      normalizeContextValue(cached.terminalId) ||
      normalizeContextValue(activeShift?.terminal_id) ||
      normalizeContextValue(staff?.terminalId);

    let resolvedShift: StaffShift | null = null;
    const linkedCashierShiftId = normalizeContextValue(activeShift?.transferred_to_cashier_shift_id);
    if (branchId && terminalId) {
      try {
        resolvedShift = unwrapData<StaffShift>(
          await bridge.shifts.getActiveCashierByTerminal(branchId, terminalId),
        );
      } catch (error) {
        console.warn('[ExpenseModal] Active cashier lookup failed:', error);
      }
    }
    if (!resolvedShift && branchId && terminalId) {
      try {
        const byTerminal = unwrapData<StaffShift>(await bridge.shifts.getActiveByTerminal(branchId, terminalId));
        if (byTerminal?.id && isDrawerOwnerRole(byTerminal.role_type)) {
          resolvedShift = byTerminal;
        }
      } catch (error) {
        console.warn('[ExpenseModal] Active shift by terminal lookup failed:', error);
      }
    }
    if (!resolvedShift && linkedCashierShiftId) {
      try {
        const linkedShift = unwrapData<StaffShift>(await bridge.shifts.getById(linkedCashierShiftId));
        if (linkedShift?.id && linkedShift.status === 'active' && isDrawerOwnerRole(linkedShift.role_type)) {
          resolvedShift = linkedShift;
        }
      } catch (error) {
        console.warn('[ExpenseModal] Linked cashier shift lookup failed:', error);
      }
    }
    if (!resolvedShift && terminalId) {
      try {
        resolvedShift = unwrapData<StaffShift>(
          await bridge.shifts.getActiveCashierByTerminalLoose(terminalId),
        );
      } catch (error) {
        console.warn('[ExpenseModal] Loose terminal cashier lookup failed:', error);
      }
    }
    if (!resolvedShift && terminalId) {
      try {
        const looseShift = unwrapData<StaffShift>(await bridge.shifts.getActiveByTerminalLoose(terminalId));
        if (looseShift?.id && isDrawerOwnerRole(looseShift.role_type)) {
          resolvedShift = looseShift;
        }
      } catch (error) {
        console.warn('[ExpenseModal] Loose terminal shift lookup failed:', error);
      }
    }
    if (
      !resolvedShift &&
      activeShift?.id &&
      isDrawerOwnerRole(activeShift.role_type) &&
      (!terminalId || normalizeContextValue(activeShift.terminal_id) === terminalId)
    ) {
      resolvedShift = activeShift;
    }

    return { branchId, terminalId, cashierShift: resolvedShift };
  };

  const loadStaffDirectory = async (branchId: string, cashier: StaffShift | null): Promise<StaffOption[]> => {
    const fallback = cashier?.staff_id
      ? [
          {
            id: cashier.staff_id,
            name: cashier.staff_name || staff?.name || t('common.roleNames.cashier', 'Cashier'),
            role: t('common.roleNames.cashier', 'Cashier'),
          },
        ]
      : [];

    if (!branchId) return fallback;

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const result = await bridge.staffSchedule.list({
      start_date: dateStr,
      end_date: dateStr,
      branch_id: branchId,
    });
    if (!result?.success) {
      throw new Error(result?.error || t('modals.expense.staffDirectoryFailed', 'Failed to load staff directory'));
    }

    const payload = (result.data ?? {}) as StaffSchedulePayload;
    if (payload.success === false) {
      throw new Error(payload.error || t('modals.expense.staffDirectoryFailed', 'Failed to load staff directory'));
    }

    const byId = new Map<string, StaffOption>();
    [...fallback, ...(Array.isArray(payload.staff) ? payload.staff.map(normalizeStaffOption).filter((item): item is StaffOption => Boolean(item)) : [])].forEach((option) => {
      byId.set(option.id, option);
    });
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  };

  const loadShiftActivity = async (cashier: StaffShift | null) => {
    if (!cashier?.id) {
      setExpenses([]);
      setStaffPayments([]);
      return;
    }
    const [loadedExpenses, loadedPayments] = await Promise.all([
      bridge.shifts.getExpenses(cashier.id),
      bridge.shifts.getStaffPayments(cashier.id),
    ]);
    setExpenses(unwrapArray<ShiftExpense>(loadedExpenses));
    setStaffPayments(unwrapArray<StaffPayment>(loadedPayments));
  };

  const refreshModalData = async () => {
    setResolving(true);
    setCashierWarning('');
    setStaffDirectoryWarning('');
    try {
      const resolved = await resolveActiveCashierContext();
      setCashierContext(resolved);
      if (!resolved.cashierShift?.id) {
        setExpenses([]);
        setStaffPayments([]);
        setStaffOptions([]);
        setCashierWarning(
          t('modals.expense.noActiveCashierDetail', 'Start a cashier shift on this terminal before recording drawer outflows.'),
        );
        return;
      }

      await loadShiftActivity(resolved.cashierShift);
      try {
        setStaffOptions(await loadStaffDirectory(resolved.branchId, resolved.cashierShift));
      } catch (error) {
        setStaffOptions(
          resolved.cashierShift?.staff_id
            ? [{
                id: resolved.cashierShift.staff_id,
                name: resolved.cashierShift.staff_name || staff?.name || t('common.roleNames.cashier', 'Cashier'),
                role: t('common.roleNames.cashier', 'Cashier'),
              }]
            : [],
        );
        setStaffDirectoryWarning(
          extractMessage(
            error,
            t('modals.expense.staffDirectoryFallback', 'Staff directory is unavailable. Only the cashier can be selected right now.'),
          ),
        );
      }
    } catch (error) {
      setCashierWarning(extractMessage(error, t('modals.expense.recordFailed', 'Failed to load drawer activity')));
      setExpenses([]);
      setStaffPayments([]);
      setStaffOptions([]);
    } finally {
      setResolving(false);
    }
  };

  const handleRecordExpense = async () => {
    if (!cashierShift?.id) {
      toast.error(t('modals.expense.noActiveCashier', 'No active cashier drawer found'));
      return;
    }
    const amount = parseMoneyInputValue(expenseDraft.amount);
    if (amount <= 0) {
      toast.error(t('modals.expense.invalidAmount', 'Please enter a valid amount'));
      return;
    }
    if (!expenseDraft.description.trim()) {
      toast.error(t('modals.expense.justificationRequired', 'Please add a justification before recording this expense'));
      return;
    }

    setSubmittingExpense(true);
    try {
      const result = await bridge.shifts.recordExpense({
        shiftId: cashierShift.id,
        expenseType: expenseDraft.expenseType,
        amount,
        description: expenseDraft.description.trim(),
        receiptNumber: expenseDraft.receiptNumber.trim() || undefined,
      });
      if (!result.success) {
        throw new Error(result.error || t('modals.expense.recordFailed', 'Failed to record expense'));
      }
      toast.success(t('modals.expense.expenseRecorded', 'Expense charged to the active cashier drawer'));
      setExpenseDraft({ expenseType: 'other', amount: '', description: '', receiptNumber: '' });
      await loadShiftActivity(cashierShift);
      setActiveTab('activity');
    } catch (error) {
      toast.error(extractMessage(error, t('modals.expense.recordFailed', 'Failed to record expense')));
    } finally {
      setSubmittingExpense(false);
    }
  };

  const handleRecordStaffPayment = async () => {
    if (!cashierShift?.id) {
      toast.error(t('modals.expense.noActiveCashier', 'No active cashier drawer found'));
      return;
    }
    if (!paymentDraft.paidToStaffId) {
      toast.error(t('modals.expense.noStaffSelected', 'Select a staff member to continue'));
      return;
    }
    const amount = parseMoneyInputValue(paymentDraft.amount);
    if (amount <= 0) {
      toast.error(t('modals.expense.invalidAmount', 'Please enter a valid amount'));
      return;
    }

    setSubmittingPayment(true);
    try {
      const result = await bridge.shifts.recordStaffPayment({
        cashierShiftId: cashierShift.id,
        paidToStaffId: paymentDraft.paidToStaffId,
        amount,
        paymentType: paymentDraft.paymentType,
        notes: paymentDraft.notes.trim() || undefined,
      });
      if (!result.success) {
        throw new Error(result.error || t('modals.expense.paymentFailed', 'Failed to record staff payment'));
      }
      toast.success(t('modals.expense.paymentRecorded', 'Staff payment charged to the active cashier drawer'));
      setPaymentDraft((current) => ({ ...current, amount: '', paymentType: 'wage', notes: '' }));
      await loadShiftActivity(cashierShift);
      setActiveTab('activity');
    } catch (error) {
      toast.error(extractMessage(error, t('modals.expense.paymentFailed', 'Failed to record staff payment')));
    } finally {
      setSubmittingPayment(false);
    }
  };

  const renderSummaryCard = (
    label: string,
    value: string,
    helper: string,
    accentClass: string,
  ) => (
    <div className="rounded-3xl border border-slate-200/70 bg-white/70 p-4 shadow-[0_12px_36px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/65 dark:shadow-[0_18px_48px_rgba(2,6,23,0.38)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <div className={`mt-3 text-2xl font-black ${accentClass}`}>{value}</div>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{helper}</p>
    </div>
  );

  const renderEmptyState = (icon: React.ReactNode, title: string, description: string) => (
    <div className="rounded-3xl border border-dashed border-slate-300/90 bg-slate-50/90 px-6 py-10 text-center dark:border-white/12 dark:bg-slate-950/35">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-slate-400 shadow-[0_10px_25px_rgba(15,23,42,0.09)] dark:bg-slate-900/70 dark:text-slate-500">
        {icon}
      </div>
      <h4 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">{title}</h4>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );

  const renderActivityItem = (item: ActivityItem) => {
    const isExpense = item.kind === 'expense';
    return (
      <div
        key={item.id}
        className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200/70 bg-white/75 px-4 py-3 shadow-[0_10px_26px_rgba(15,23,42,0.07)] dark:border-white/10 dark:bg-slate-900/55"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <POSGlassBadge variant={isExpense ? 'error' : 'warning'} size="sm" className="!px-2.5 !py-1">
              {isExpense
                ? t('modals.expense.tabs.expenses', 'Expenses')
                : t('modals.expense.tabs.staffPayments', 'Staff Payments')}
            </POSGlassBadge>
            <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">{item.title}</span>
          </div>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{item.subtitle}</p>
          <div className="mt-2 text-xs uppercase tracking-[0.16em] text-slate-400 dark:text-slate-500">
            {formatDateTime(item.createdAt, {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        </div>
        <div className={`shrink-0 text-lg font-black ${isExpense ? 'text-rose-500 dark:text-rose-300' : 'text-amber-500 dark:text-amber-300'}`}>
          -{formatCurrency(item.amount)}
        </div>
      </div>
    );
  };

  if (!isOpen) {
    return null;
  }

  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('modals.expense.title', 'Drawer Outflows')}
      size="lg"
      className="!max-w-4xl !w-[90vw] !max-h-[90vh]"
      contentClassName="space-y-6"
      ariaLabel={t('modals.expense.title', 'Drawer Outflows')}
    >
      <div className="rounded-[28px] border border-slate-200/70 bg-white/75 p-5 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/70 dark:shadow-[0_24px_80px_rgba(2,6,23,0.42)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t('modals.expense.subtitle', 'Charge expenses and staff payments to the active cashier drawer.')}
            </p>
            <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
              {t('modals.expense.drawerImpactNote', 'Both tabs below reduce the active cashier drawer for this terminal.')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <POSGlassBadge variant={cashierShift ? 'success' : 'warning'}>
              {cashierShift
                ? t('modals.expense.activeCashier', 'Active cashier drawer')
                : t('modals.expense.noActiveCashier', 'No active cashier drawer')}
            </POSGlassBadge>
            {cashierContext.terminalId && (
              <POSGlassBadge variant="info">
                {t('modals.expense.terminalLabel', 'Terminal')}: {cashierContext.terminalId}
              </POSGlassBadge>
            )}
            <POSGlassButton
              type="button"
              variant="secondary"
              icon={<RefreshCw className="h-4 w-4" />}
              disabled={resolving}
              onClick={() => {
                void refreshModalData();
              }}
            >
              {t('common.refresh', 'Refresh')}
            </POSGlassButton>
          </div>
        </div>

        {cashierShift ? (
          <>
            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/85 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-300">
                  <UserRound className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    {t('modals.expense.cashierLabel', 'Cashier')}
                  </span>
                </div>
                <div className="mt-3 text-lg font-black text-slate-900 dark:text-white">
                  {cashierShift.staff_name || staff?.name || t('common.roleNames.cashier', 'Cashier')}
                </div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {t('common.roleNames.cashier', 'Cashier')}
                </p>
              </div>

              <div className="rounded-2xl border border-sky-200/70 bg-sky-50/85 p-4 dark:border-sky-500/20 dark:bg-sky-500/10">
                <div className="flex items-center gap-2 text-sky-600 dark:text-sky-300">
                  <Wallet className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    {t('modals.expense.branchLabel', 'Branch')}
                  </span>
                </div>
                <div className="mt-3 break-all text-base font-bold text-slate-900 dark:text-white">
                  {cashierContext.branchId || '-'}
                </div>
              </div>

              <div className="rounded-2xl border border-violet-200/70 bg-violet-50/85 p-4 dark:border-violet-500/20 dark:bg-violet-500/10">
                <div className="flex items-center gap-2 text-violet-600 dark:text-violet-300">
                  <Clock3 className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    {t('modals.expense.shiftStartedLabel', 'Shift started')}
                  </span>
                </div>
                <div className="mt-3 text-base font-bold text-slate-900 dark:text-white">
                  {formatDateTime(cashierShift.check_in_time, {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </div>

            {isCashierShiftSyncBlocked && (
              <div className="mt-5 rounded-3xl border border-amber-300/70 bg-amber-50/90 p-5 dark:border-amber-500/20 dark:bg-amber-500/10">
                <div className="flex items-start gap-3">
                  <div className="rounded-2xl bg-amber-100/90 p-3 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                      {t('modals.expense.waitingForCashierShiftSync', {
                        defaultValue: 'Waiting for cashier shift sync',
                      })}
                    </h3>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      {cashierShiftSyncWarning}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-amber-800 dark:text-amber-100">
                      <span className="rounded-lg border border-amber-300/70 bg-white/60 px-3 py-1.5 dark:border-amber-500/20 dark:bg-black/10">
                        {t('modals.expense.cashierShiftIdLabel', {
                          defaultValue: 'Cashier shift',
                        })}
                        : {cashierShift.id}
                      </span>
                      <span className="rounded-lg border border-amber-300/70 bg-white/60 px-3 py-1.5 dark:border-amber-500/20 dark:bg-black/10">
                        {t('modals.expense.cashierShiftSyncStatusLabel', {
                          defaultValue: 'Local sync status',
                        })}
                        : {cashierShiftSyncStatus.replace(/_/g, ' ')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="mt-5 rounded-3xl border border-amber-300/70 bg-amber-50/90 p-5 dark:border-amber-500/20 dark:bg-amber-500/10">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-amber-100/90 p-3 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  {t('modals.expense.noActiveCashier', 'No active cashier drawer')}
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                  {cashierWarning ||
                    t(
                      'modals.expense.noActiveCashierDetail',
                      'Start a cashier shift on this terminal before recording drawer outflows.',
                    )}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          { key: 'expenses', label: t('modals.expense.tabs.expenses', 'Expenses'), icon: <Receipt className="h-4 w-4" /> },
          { key: 'staffPayments', label: t('modals.expense.tabs.staffPayments', 'Staff Payments'), icon: <Users className="h-4 w-4" /> },
          { key: 'activity', label: t('modals.expense.tabs.activity', 'Activity'), icon: <ClipboardList className="h-4 w-4" /> },
        ] as Array<{ key: ExpenseTab; label: string; icon: React.ReactNode }>).map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition-all ${
                active
                  ? 'border-blue-500/60 bg-blue-600 text-white shadow-[0_14px_34px_rgba(37,99,235,0.28)]'
                  : 'border-slate-200/70 bg-white/75 text-slate-700 hover:border-blue-300 hover:text-blue-700 dark:border-white/10 dark:bg-slate-900/55 dark:text-slate-200 dark:hover:border-blue-500/30 dark:hover:text-blue-300'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'expenses' && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_360px]">
          <section className="rounded-[28px] border border-slate-200/70 bg-white/78 p-6 shadow-[0_18px_50px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-slate-900/65">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.expenseFormTitle', 'Record expense')}
                </p>
                <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">
                  {t('modals.expense.expenseFormHeading', 'Operational expense')}
                </h3>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {t('modals.expense.chargedToDrawer', 'This outflow is charged directly to the active cashier drawer.')}
                </p>
              </div>
              <POSGlassBadge variant="error">{formatCurrency(totalExpenses)}</POSGlassBadge>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.expenseType', 'Expense type')}
                </label>
                <select
                  value={expenseDraft.expenseType}
                  onChange={(event) => setExpenseDraft((current) => ({ ...current, expenseType: event.target.value as ExpenseType }))}
                  disabled={!canRecord}
                  className="liquid-glass-modal-input w-full"
                >
                  {EXPENSE_TYPES.map((expenseType) => (
                    <option key={expenseType} value={expenseType}>
                      {t(`modals.expense.expenseTypes.${expenseType}`, expenseType)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.amountLabel', 'Amount')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={expenseDraft.amount}
                    onChange={(event) => setExpenseDraft((current) => ({ ...current, amount: formatMoneyInputWithCents(event.target.value) }))}
                    placeholder="0,00"
                    disabled={!canRecord}
                    className="liquid-glass-modal-input w-full !pl-10 text-lg font-bold"
                  />
                  <Euro className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.expense.justification', 'Justification')}
              </label>
              <textarea
                rows={5}
                value={expenseDraft.description}
                onChange={(event) => setExpenseDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder={t('modals.expense.justificationPlaceholder', 'Explain what left the drawer and why it was needed.')}
                disabled={!canRecord}
                className="liquid-glass-modal-input min-h-[150px] w-full resize-none"
              />
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.expense.receiptReference', 'Receipt or reference')}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={expenseDraft.receiptNumber}
                  onChange={(event) => setExpenseDraft((current) => ({ ...current, receiptNumber: event.target.value }))}
                  placeholder={t('modals.expense.receiptPlaceholder', 'Invoice, receipt, or reference number')}
                  disabled={!canRecord}
                  className="liquid-glass-modal-input w-full !pl-10"
                />
                <FileText className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <POSGlassButton
                type="button"
                variant="success"
                loading={submittingExpense}
                disabled={!canRecord || parseMoneyInputValue(expenseDraft.amount) <= 0 || !expenseDraft.description.trim()}
                onClick={() => { void handleRecordExpense(); }}
                icon={<Receipt className="h-4 w-4" />}
              >
                {t('modals.expense.recordExpense', 'Record expense')}
              </POSGlassButton>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('modals.expense.justificationRequired', 'A clear justification is required before saving.')}
              </p>
            </div>
          </section>

          <aside className="space-y-4">
            {renderSummaryCard(
              t('modals.expense.totalExpenses', 'Total expenses'),
              formatCurrency(totalExpenses),
              t('modals.expense.sessionExpenseCount', '{{count}} expense entries this shift', { count: expenses.length }),
              'text-rose-500 dark:text-rose-300',
            )}
            {renderSummaryCard(
              t('modals.expense.combinedOutflow', 'Combined drawer outflow'),
              formatCurrency(combinedOutflow),
              t('modals.expense.combinedOutflowHelper', 'Expenses and staff payments currently charged to this cashier'),
              'text-emerald-500 dark:text-emerald-300',
            )}

            <div className="rounded-[28px] border border-slate-200/70 bg-white/78 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] dark:border-white/10 dark:bg-slate-900/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.expense.recentExpenses', 'Recent expenses')}
                  </p>
                  <h4 className="mt-2 text-lg font-bold text-slate-900 dark:text-white">
                    {t('modals.expense.latestEntries', 'Latest entries')}
                  </h4>
                </div>
                <Receipt className="h-5 w-5 text-rose-500 dark:text-rose-300" />
              </div>

              <div className="mt-4 space-y-3">
                {recentExpenses.length > 0 ? recentExpenses.map((expense) => (
                  <div key={expense.id} className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-slate-950/35">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-slate-900 dark:text-white">{expense.description}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{t(`modals.expense.expenseTypes.${expense.expense_type}`, expense.expense_type)}</span>
                          <span>•</span>
                          <span>{formatDateTime(expense.created_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-base font-black text-rose-500 dark:text-rose-300">
                        -{formatCurrency(expense.amount)}
                      </div>
                    </div>
                  </div>
                )) : renderEmptyState(
                  <Receipt className="h-6 w-6" />,
                  t('modals.expense.noExpenses', 'No expenses recorded yet'),
                  t('modals.expense.noExpensesDetail', 'Recorded expenses will appear here immediately after saving.'),
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'staffPayments' && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_360px]">
          <section className="rounded-[28px] border border-slate-200/70 bg-white/78 p-6 shadow-[0_18px_50px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-slate-900/65">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.staffPaymentFormTitle', 'Record staff payment')}
                </p>
                <h3 className="mt-2 text-2xl font-black text-slate-900 dark:text-white">
                  {t('modals.expense.staffPaymentFormHeading', 'Staff payout from drawer')}
                </h3>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {t('modals.expense.staffPaymentDrawerNote', 'Every payment here is deducted from the active cashier drawer.')}
                </p>
              </div>
              <POSGlassBadge variant="warning">{formatCurrency(totalStaffPayments)}</POSGlassBadge>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.selectStaff', 'Pay to staff')}
                </label>
                <select
                  value={paymentDraft.paidToStaffId}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, paidToStaffId: event.target.value }))}
                  disabled={!canRecord}
                  className="liquid-glass-modal-input w-full"
                >
                  <option value="">{t('modals.expense.staffPlaceholder', 'Select a staff member')}</option>
                  {staffOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} - {option.role}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.paymentType', 'Payment type')}
                </label>
                <select
                  value={paymentDraft.paymentType}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, paymentType: event.target.value as StaffPaymentType }))}
                  disabled={!canRecord}
                  className="liquid-glass-modal-input w-full"
                >
                  {STAFF_PAYMENT_TYPES.map((paymentType) => (
                    <option key={paymentType} value={paymentType}>
                      {t(`modals.expense.paymentTypes.${paymentType}`, paymentType)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.expense.amountLabel', 'Amount')}
              </label>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={paymentDraft.amount}
                  onChange={(event) => setPaymentDraft((current) => ({ ...current, amount: formatMoneyInputWithCents(event.target.value) }))}
                  placeholder="0,00"
                  disabled={!canRecord}
                  className="liquid-glass-modal-input w-full !pl-10 text-lg font-bold"
                />
                <Euro className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.expense.notes', 'Notes')}
              </label>
              <textarea
                rows={5}
                value={paymentDraft.notes}
                onChange={(event) => setPaymentDraft((current) => ({ ...current, notes: event.target.value }))}
                placeholder={t('modals.expense.notesPlaceholder', 'Optional note for payroll, tip settlement, advance, or bonus.')}
                disabled={!canRecord}
                className="liquid-glass-modal-input min-h-[150px] w-full resize-none"
              />
            </div>

            {staffDirectoryWarning && (
              <div className="mt-4 rounded-2xl border border-amber-300/70 bg-amber-50/85 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                {staffDirectoryWarning}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <POSGlassButton
                type="button"
                variant="warning"
                loading={submittingPayment}
                disabled={!canRecord || !paymentDraft.paidToStaffId || parseMoneyInputValue(paymentDraft.amount) <= 0}
                onClick={() => { void handleRecordStaffPayment(); }}
                icon={<BadgeDollarSign className="h-4 w-4" />}
              >
                {t('modals.expense.recordStaffPayment', 'Record staff payment')}
              </POSGlassButton>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('modals.expense.staffPaymentHelper', 'Use this for cashier self-payments or payments to other staff from the drawer.')}
              </p>
            </div>
          </section>

          <aside className="space-y-4">
            {renderSummaryCard(
              t('modals.expense.totalStaffPayments', 'Total staff payments'),
              formatCurrency(totalStaffPayments),
              t('modals.expense.sessionPaymentCount', '{{count}} payments recorded this shift', { count: staffPayments.length }),
              'text-amber-500 dark:text-amber-300',
            )}
            {renderSummaryCard(
              t('modals.expense.combinedOutflow', 'Combined drawer outflow'),
              formatCurrency(combinedOutflow),
              t('modals.expense.combinedOutflowHelper', 'Expenses and staff payments currently charged to this cashier'),
              'text-emerald-500 dark:text-emerald-300',
            )}

            <div className="rounded-[28px] border border-slate-200/70 bg-white/78 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] dark:border-white/10 dark:bg-slate-900/60">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.expense.recentStaffPayments', 'Recent staff payments')}
                  </p>
                  <h4 className="mt-2 text-lg font-bold text-slate-900 dark:text-white">
                    {t('modals.expense.latestEntries', 'Latest entries')}
                  </h4>
                </div>
                <Users className="h-5 w-5 text-amber-500 dark:text-amber-300" />
              </div>

              <div className="mt-4 space-y-3">
                {recentPayments.length > 0 ? recentPayments.map((payment) => (
                  <div key={payment.id} className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-slate-950/35">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-slate-900 dark:text-white">
                          {payment.staff_name || t('common.unknown', 'Unknown')}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span>{t(`modals.expense.paymentTypes.${payment.payment_type}`, payment.payment_type)}</span>
                          {payment.role_type && <><span>•</span><span>{payment.role_type}</span></>}
                          <span>•</span>
                          <span>{formatDateTime(payment.created_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {payment.notes && <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{payment.notes}</p>}
                      </div>
                      <div className="shrink-0 text-base font-black text-amber-500 dark:text-amber-300">
                        -{formatCurrency(payment.amount)}
                      </div>
                    </div>
                  </div>
                )) : renderEmptyState(
                  <Users className="h-6 w-6" />,
                  t('modals.expense.noStaffPayments', 'No staff payments recorded yet'),
                  t('modals.expense.noStaffPaymentsDetail', 'Payments recorded here will appear in the cashier drawer activity immediately.'),
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-3">
            {renderSummaryCard(
              t('modals.expense.totalExpenses', 'Total expenses'),
              formatCurrency(totalExpenses),
              t('modals.expense.sessionExpenseCount', '{{count}} expense entries this shift', { count: expenses.length }),
              'text-rose-500 dark:text-rose-300',
            )}
            {renderSummaryCard(
              t('modals.expense.totalStaffPayments', 'Total staff payments'),
              formatCurrency(totalStaffPayments),
              t('modals.expense.sessionPaymentCount', '{{count}} payments recorded this shift', { count: staffPayments.length }),
              'text-amber-500 dark:text-amber-300',
            )}
            {renderSummaryCard(
              t('modals.expense.combinedOutflow', 'Combined drawer outflow'),
              formatCurrency(combinedOutflow),
              t('modals.expense.activityHelper', 'Live combined outflow for the resolved cashier shift'),
              'text-emerald-500 dark:text-emerald-300',
            )}
          </div>

          <div className="rounded-[28px] border border-slate-200/70 bg-white/78 p-5 shadow-[0_16px_42px_rgba(15,23,42,0.07)] dark:border-white/10 dark:bg-slate-900/60">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.expense.activityTitle', 'Drawer activity')}
                </p>
                <h4 className="mt-2 text-lg font-bold text-slate-900 dark:text-white">
                  {t('modals.expense.activitySubtitle', 'Expenses and staff payments recorded on this cashier shift')}
                </h4>
              </div>
              <ClipboardList className="h-5 w-5 text-blue-500 dark:text-blue-300" />
            </div>

            <div className="mt-4 space-y-3">
              {activityItems.length > 0
                ? activityItems.map(renderActivityItem)
                : renderEmptyState(
                    <ClipboardList className="h-6 w-6" />,
                    t('modals.expense.noActivity', 'No drawer activity yet'),
                    t('modals.expense.noActivityDetail', 'Expenses and staff payments will appear together here in chronological order.'),
                  )}
            </div>
          </div>
        </div>
      )}
    </LiquidGlassModal>
  );
}
