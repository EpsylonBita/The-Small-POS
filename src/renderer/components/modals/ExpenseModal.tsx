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
  Trash2,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { LiquidGlassModal, POSGlassBadge, POSGlassButton } from '../ui/pos-glass-components';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useShift } from '../../contexts/shift-context';
import type {
  RecordStaffPaymentParams,
  ShiftExpense,
  ShiftSyncState,
  StaffPayment,
  StaffShift,
} from '../../types';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../services/terminal-credentials';
import { getBridge, offEvent, onEvent } from '../../../lib';

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
  branchName: string;
  terminalId: string;
  terminalName: string;
  cashierShift: StaffShift | null;
  cashierShiftSyncState: ShiftSyncState | null;
  terminalConfigured: boolean | null;
  networkOnline: boolean | null;
}

interface StaffSchedulePayload {
  success?: boolean;
  staff?: unknown[];
  error?: string;
}

interface ActivityItem {
  id: string;
  sourceId: string;
  kind: 'expense' | 'staffPayment';
  title: string;
  subtitle: string;
  amount: number;
  createdAt: string;
}

interface DeleteExpenseTarget {
  id: string;
  description: string;
}

const EXPENSE_TYPES: ExpenseType[] = ['supplies', 'maintenance', 'petty_cash', 'refund', 'other'];
const STAFF_PAYMENT_TYPES: StaffPaymentType[] = ['wage', 'tip', 'bonus', 'advance', 'other'];
const SHIFT_SYNC_WARNING_GRACE_MS = 2 * 60 * 1000;
const SHIFT_SYNC_PENDING_STATUSES = new Set(['pending', 'in_progress', 'queued_remote']);
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

function isMissingExpenseError(message: string): boolean {
  return message.trim() === 'Expense not found';
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

function normalizeExpenseType(value: unknown): ExpenseType {
  if (typeof value !== 'string') {
    return 'other';
  }
  const normalized = value.trim().toLowerCase();
  return EXPENSE_TYPES.includes(normalized as ExpenseType)
    ? (normalized as ExpenseType)
    : 'other';
}

function getExpenseTypeLabel(
  translate: TFunction,
  expenseType: unknown,
): string {
  return translate(`modals.expense.expenseTypes.${normalizeExpenseType(expenseType)}`, 'Other');
}

function formatOptionalActivityDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const formatted = formatDateTime(value, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatted === '-' ? '' : formatted;
}

function normalizeSyncStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function getSettingsText(
  settings: Record<string, unknown> | null | undefined,
  category: string,
  key: string,
): string {
  if (!settings) {
    return '';
  }

  const categoryValue = settings[category];
  if (categoryValue && typeof categoryValue === 'object' && !Array.isArray(categoryValue)) {
    const nested = (categoryValue as Record<string, unknown>)[key];
    if (typeof nested === 'string' && nested.trim()) {
      return nested.trim();
    }
  }

  const flat = settings[`${category}.${key}`];
  return typeof flat === 'string' && flat.trim() ? flat.trim() : '';
}

function getFirstSettingsText(
  settings: Record<string, unknown> | null | undefined,
  candidates: Array<[category: string, key: string]>,
): string {
  for (const [category, key] of candidates) {
    const resolved = getSettingsText(settings, category, key);
    if (resolved) {
      return resolved;
    }
  }
  return '';
}

function readStoredDisplayIdentity(): { branchName: string; terminalName: string } {
  if (typeof window === 'undefined') {
    return { branchName: '', terminalName: '' };
  }

  const candidates = ['staff', 'pos-user'];
  let branchName = '';
  let terminalName = '';

  for (const storageKey of candidates) {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) continue;
      const record = JSON.parse(raw) as Record<string, unknown>;

      if (!branchName) {
        branchName =
          normalizeContextValue(
            record.branchName ??
              record.branch_name ??
              record.branchDisplayName ??
              record.branch_display_name,
          ) || '';
      }

      if (!terminalName) {
        terminalName =
          normalizeContextValue(
            record.terminalName ??
              record.terminal_name ??
              record.terminalDisplayName ??
              record.terminal_display_name ??
              record.location,
          ) || '';
      }
    } catch {
      // Ignore malformed local storage entries and keep resolving other fallbacks.
    }
  }

  return { branchName, terminalName };
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
    branchName: '',
    terminalId: '',
    terminalName: '',
    cashierShift: null,
    cashierShiftSyncState: null,
    terminalConfigured: null,
    networkOnline: null,
  });
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);
  const [staffPayments, setStaffPayments] = useState<StaffPayment[]>([]);
  const [resolving, setResolving] = useState(false);
  const [submittingExpense, setSubmittingExpense] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [cashierWarning, setCashierWarning] = useState('');
  const [staffDirectoryWarning, setStaffDirectoryWarning] = useState('');
  const [expenseToDelete, setExpenseToDelete] = useState<DeleteExpenseTarget | null>(null);
  const [deletingExpenseId, setDeletingExpenseId] = useState<string | null>(null);
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
  const cashierShiftSyncState = cashierContext.cashierShiftSyncState;
  const displayBranchName = cashierContext.branchName || cashierContext.branchId || '-';
  const displayTerminalName = cashierContext.terminalName || cashierContext.terminalId;
  const canRecord = Boolean(cashierShift?.id) && !resolving;
  const currentCashierStaffId = cashierShift?.staff_id || staff?.databaseStaffId || staff?.staffId || '';
  const cashierShiftSyncStatus = normalizeSyncStatus(
    cashierShiftSyncState?.shiftSyncStatus ?? cashierShift?.sync_status,
  );
  const cashierShiftQueueStatus = normalizeSyncStatus(cashierShiftSyncState?.queueStatus);
  const cashierShiftDisplaySyncStatus = cashierShiftQueueStatus || cashierShiftSyncStatus;
  const cashierShiftQueueAgeMs = useMemo(() => {
    const timestamp =
      parseTimestamp(cashierShiftSyncState?.queueUpdatedAt) ??
      parseTimestamp(cashierShiftSyncState?.queueCreatedAt);
    return timestamp === null ? null : Math.max(0, Date.now() - timestamp);
  }, [cashierShiftSyncState?.queueCreatedAt, cashierShiftSyncState?.queueUpdatedAt]);

  const resolveCashierShiftSyncMessage = (variant: 'delayed' | 'failed') => {
    const lastError = cashierShiftSyncState?.lastError?.trim();
    if (lastError) {
      return lastError;
    }
    if (cashierContext.networkOnline === false && cashierContext.terminalConfigured !== false) {
      return t('modals.expense.cashierShiftSyncOfflineReason', {
        defaultValue: 'The terminal is offline or cannot reach the admin server right now.',
      });
    }
    if (cashierContext.terminalConfigured === false) {
      return t('modals.expense.cashierShiftSyncNotConfiguredReason', {
        defaultValue: 'This terminal is not fully configured for sync yet.',
      });
    }
    if (cashierShiftSyncState?.nextRetryAt) {
      return t('modals.expense.cashierShiftSyncRetryReason', {
        defaultValue: 'Next retry scheduled for {{time}}.',
        time: formatDateTime(cashierShiftSyncState.nextRetryAt, {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }),
      });
    }
    if (variant === 'delayed') {
      return t('modals.expense.cashierShiftSyncDelayedWarning', {
        defaultValue:
          'This cashier shift is still syncing. New expenses and staff payments stay local until the shift reaches the server.',
      });
    }
    return t('modals.expense.cashierShiftSyncUnknownReason', {
      defaultValue: 'This cashier shift is saved locally, but its sync needs attention.',
    });
  };

  const cashierShiftSyncBanner = useMemo(() => {
    if (!cashierShift?.id || !cashierShiftSyncStatus || cashierShiftSyncStatus === 'synced') {
      return null;
    }

    if (cashierShiftSyncStatus === 'failed' || cashierShiftQueueStatus === 'failed') {
      return {
        variant: 'failed' as const,
        title: t('modals.expense.cashierShiftSyncFailedTitle', {
          defaultValue: 'Cashier shift sync needs attention',
        }),
        message: resolveCashierShiftSyncMessage('failed'),
      };
    }

    if (
      SHIFT_SYNC_PENDING_STATUSES.has(cashierShiftDisplaySyncStatus) &&
      cashierShiftQueueAgeMs !== null &&
      cashierShiftQueueAgeMs <= SHIFT_SYNC_WARNING_GRACE_MS
    ) {
      return null;
    }

    if (
      SHIFT_SYNC_PENDING_STATUSES.has(cashierShiftDisplaySyncStatus) ||
      cashierShiftSyncStatus !== 'synced'
    ) {
      return {
        variant: 'delayed' as const,
        title: t('modals.expense.cashierShiftSyncDelayedTitle', {
          defaultValue: 'Cashier shift sync delayed',
        }),
        message: resolveCashierShiftSyncMessage('delayed'),
      };
    }

    return null;
  }, [
    cashierShift?.id,
    cashierShiftDisplaySyncStatus,
    cashierShiftQueueAgeMs,
    cashierShiftQueueStatus,
    cashierShiftSyncStatus,
    resolveCashierShiftSyncMessage,
    t,
  ]);

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
          sourceId: expense.id,
          kind: 'expense' as const,
          title: expense.description || t('modals.expense.untitledExpense', 'Untitled expense'),
          subtitle: getExpenseTypeLabel(t, expense.expense_type),
          amount: Number(expense.amount || 0),
          createdAt: expense.created_at,
        })),
        ...staffPayments.map((payment) => ({
          id: `payment-${payment.id}`,
          sourceId: payment.id,
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
    setExpenseToDelete(null);
    setDeletingExpenseId(null);
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
    const storedDisplayIdentity = readStoredDisplayIdentity();
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

    let terminalSettings: Record<string, unknown> | null = null;
    try {
      const resolvedSettings = await bridge.terminalConfig.getSettings();
      terminalSettings =
        resolvedSettings && typeof resolvedSettings === 'object'
          ? (resolvedSettings as Record<string, unknown>)
          : null;
    } catch (error) {
      console.warn('[ExpenseModal] Failed to load terminal settings for display labels:', error);
    }

    let branchName =
      getFirstSettingsText(terminalSettings, [
        ['restaurant', 'name'],
        ['restaurant', 'display_name'],
        ['restaurant', 'subtitle'],
        ['terminal', 'store_name'],
      ]) || storedDisplayIdentity.branchName;
    let terminalName =
      getFirstSettingsText(terminalSettings, [
        ['terminal', 'name'],
        ['terminal', 'display_name'],
        ['terminal', 'terminal_name'],
        ['terminal', 'location'],
      ]) || storedDisplayIdentity.terminalName;

    if ((!branchName || !terminalName) && terminalId) {
      try {
        await bridge.terminalConfig.syncFromAdmin();
        const refreshedSettings = await bridge.terminalConfig.getSettings();
        terminalSettings =
          refreshedSettings && typeof refreshedSettings === 'object'
            ? (refreshedSettings as Record<string, unknown>)
            : terminalSettings;
        branchName =
          branchName ||
          getFirstSettingsText(terminalSettings, [
            ['restaurant', 'name'],
            ['restaurant', 'display_name'],
            ['restaurant', 'subtitle'],
            ['terminal', 'store_name'],
          ]);
        terminalName =
          terminalName ||
          getFirstSettingsText(terminalSettings, [
            ['terminal', 'name'],
            ['terminal', 'display_name'],
            ['terminal', 'terminal_name'],
            ['terminal', 'location'],
          ]);
      } catch (error) {
        console.warn('[ExpenseModal] Failed to sync terminal settings for display labels:', error);
      }
    }

    let resolvedShift: StaffShift | null = null;
    let cashierShiftSyncState: ShiftSyncState | null = null;
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
      try {
        const refreshedActiveShift = unwrapData<StaffShift>(await bridge.shifts.getById(activeShift.id));
        if (
          refreshedActiveShift?.id &&
          refreshedActiveShift.status === 'active' &&
          isDrawerOwnerRole(refreshedActiveShift.role_type)
        ) {
          resolvedShift = refreshedActiveShift;
        }
      } catch (error) {
        console.warn('[ExpenseModal] Active shift refresh by id failed:', error);
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

    if (resolvedShift?.id) {
      try {
        cashierShiftSyncState = await bridge.shifts.getSyncState(resolvedShift.id);
      } catch (error) {
        console.warn('[ExpenseModal] Failed to load cashier shift sync state:', error);
      }
    }

    const [configuredResult, networkResult] = await Promise.allSettled([
      bridge.settings.isConfigured(),
      bridge.sync.getNetworkStatus(),
    ]);
    const terminalConfigured =
      configuredResult.status === 'fulfilled'
        ? Boolean(configuredResult.value?.configured)
        : null;
    const networkOnline =
      networkResult.status === 'fulfilled' &&
      typeof networkResult.value?.isOnline === 'boolean'
        ? networkResult.value.isOnline
        : null;

    return {
      branchId,
      branchName,
      terminalId,
      terminalName,
      cashierShift: resolvedShift,
      cashierShiftSyncState,
      terminalConfigured,
      networkOnline,
    };
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

  const refreshCashierShiftContext = async () => {
    const resolved = await resolveActiveCashierContext();
    setCashierContext(resolved);
    if (!resolved.cashierShift?.id) {
      setCashierWarning(
        t(
          'modals.expense.noActiveCashierDetail',
          'Start a cashier shift on this terminal before recording drawer outflows.',
        ),
      );
    } else {
      setCashierWarning('');
    }
    return resolved;
  };

  const refreshModalData = async () => {
    setResolving(true);
    setCashierWarning('');
    setStaffDirectoryWarning('');
    try {
      const resolved = await refreshCashierShiftContext();
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

  useEffect(() => {
    if (!isOpen) return;

    const refreshShiftStateIfNeeded = () => {
      const currentStatus = normalizeSyncStatus(
        cashierContext.cashierShiftSyncState?.shiftSyncStatus ??
          cashierContext.cashierShift?.sync_status,
      );
      if (!cashierContext.cashierShift?.id || currentStatus === 'synced') {
        return;
      }
      void refreshCashierShiftContext();
    };

    onEvent('sync:complete', refreshShiftStateIfNeeded);
    onEvent('sync:status', refreshShiftStateIfNeeded);
    return () => {
      offEvent('sync:complete', refreshShiftStateIfNeeded);
      offEvent('sync:status', refreshShiftStateIfNeeded);
    };
  }, [
    cashierContext.cashierShift?.id,
    cashierContext.cashierShift?.sync_status,
    cashierContext.cashierShiftSyncState?.shiftSyncStatus,
    isOpen,
  ]);

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

  const requestDeleteExpense = (expense: DeleteExpenseTarget) => {
    setExpenseToDelete(expense);
  };

  const handleConfirmDeleteExpense = async () => {
    if (!expenseToDelete || !cashierShift?.id) {
      setExpenseToDelete(null);
      return;
    }

    setDeletingExpenseId(expenseToDelete.id);
    try {
      const result = await bridge.shifts.deleteExpense({
        expenseId: expenseToDelete.id,
        shiftId: cashierShift.id,
      });
      if (!result?.success) {
        throw new Error(result?.error || t('modals.expense.expenseDeleteFailed', 'Failed to delete expense'));
      }

      await loadShiftActivity(cashierShift);
      toast.success(t('modals.expense.expenseDeleted', 'Expense deleted'));
      setExpenseToDelete(null);
    } catch (error) {
      const message = extractMessage(
        error,
        t('modals.expense.expenseDeleteFailed', 'Failed to delete expense'),
      );

      if (isMissingExpenseError(message)) {
        await loadShiftActivity(cashierShift);
        setExpenseToDelete(null);
        return;
      }

      toast.error(message);
    } finally {
      setDeletingExpenseId(null);
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
    const isDeleting = isExpense && deletingExpenseId === item.sourceId;
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
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className={`text-lg font-black ${isExpense ? 'text-rose-500 dark:text-rose-300' : 'text-amber-500 dark:text-amber-300'}`}>
            -{formatCurrency(item.amount)}
          </div>
          {isExpense && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={() =>
                requestDeleteExpense({
                  id: item.sourceId,
                  description: item.title,
                })
              }
              className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('modals.expense.deleteExpense', 'Delete expense')}
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!isOpen) {
    return null;
  }

  return (
    <>
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

          <div className="w-full max-w-md space-y-2 lg:w-[360px]">
            <div
              className={`text-sm font-semibold lg:text-right ${
                cashierShift
                  ? 'text-emerald-600 dark:text-emerald-300'
                  : 'text-amber-600 dark:text-amber-300'
              }`}
            >
              {cashierShift
                ? t('modals.expense.activeCashier', 'Active cashier drawer')
                : t('modals.expense.noActiveCashier', 'No active cashier drawer')}
            </div>
            <div className={`grid gap-2 ${displayTerminalName ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {displayTerminalName && (
                <div className="flex h-14 items-center rounded-2xl border border-sky-200/80 bg-sky-50/85 px-4 text-sm font-semibold text-sky-700 shadow-[0_12px_34px_rgba(14,116,144,0.12)] dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-200">
                  <span className="truncate">
                    {t('modals.expense.terminalLabel', 'Terminal')}: {displayTerminalName}
                  </span>
                </div>
              )}
              <POSGlassButton
                type="button"
                variant="secondary"
                icon={<RefreshCw className="h-4 w-4" />}
                disabled={resolving}
                className={`!h-14 !justify-center !rounded-2xl !px-4 ${
                  displayTerminalName ? '!w-full' : '!w-full'
                }`}
                onClick={() => {
                  void refreshModalData();
                }}
              >
                {t('common.refresh', 'Refresh')}
              </POSGlassButton>
            </div>
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
                  {displayBranchName}
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

            {cashierShiftSyncBanner && (
              <div
                className={`mt-5 rounded-3xl border p-5 ${
                  cashierShiftSyncBanner.variant === 'failed'
                    ? 'border-amber-300/70 bg-amber-50/90 dark:border-amber-500/20 dark:bg-amber-500/10'
                    : 'border-sky-200/80 bg-sky-50/90 dark:border-sky-500/20 dark:bg-sky-500/10'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`rounded-2xl p-3 ${
                      cashierShiftSyncBanner.variant === 'failed'
                        ? 'bg-amber-100/90 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300'
                        : 'bg-sky-100/90 text-sky-600 dark:bg-sky-500/20 dark:text-sky-300'
                    }`}
                  >
                    {cashierShiftSyncBanner.variant === 'failed' ? (
                      <AlertTriangle className="h-5 w-5" />
                    ) : (
                      <RefreshCw className="h-5 w-5" />
                    )}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                      {cashierShiftSyncBanner.title}
                    </h3>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      {cashierShiftSyncBanner.message}
                    </p>
                    <div
                      className={`mt-3 flex flex-wrap gap-2 text-xs font-semibold ${
                        cashierShiftSyncBanner.variant === 'failed'
                          ? 'text-amber-800 dark:text-amber-100'
                          : 'text-sky-800 dark:text-sky-100'
                      }`}
                    >
                      <span
                        className={`rounded-lg border bg-white/60 px-3 py-1.5 dark:bg-black/10 ${
                          cashierShiftSyncBanner.variant === 'failed'
                            ? 'border-amber-300/70 dark:border-amber-500/20'
                            : 'border-sky-300/70 dark:border-sky-500/20'
                        }`}
                      >
                        {t('modals.expense.cashierShiftIdLabel', {
                          defaultValue: 'Cashier shift',
                        })}
                        : {cashierShift.id}
                      </span>
                      <span
                        className={`rounded-lg border bg-white/60 px-3 py-1.5 dark:bg-black/10 ${
                          cashierShiftSyncBanner.variant === 'failed'
                            ? 'border-amber-300/70 dark:border-amber-500/20'
                            : 'border-sky-300/70 dark:border-sky-500/20'
                        }`}
                      >
                        {t('modals.expense.cashierShiftSyncStatusLabel', {
                          defaultValue: 'Local sync status',
                        })}
                        : {cashierShiftDisplaySyncStatus.replace(/_/g, ' ')}
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
                {recentExpenses.length > 0 ? recentExpenses.map((expense) => {
                  const expenseTitle =
                    expense.description || t('modals.expense.untitledExpense', 'Untitled expense');
                  const metadata = [
                    getExpenseTypeLabel(t, expense.expense_type),
                    formatOptionalActivityDateTime(expense.created_at),
                  ].filter(Boolean);

                  return (
                    <div key={expense.id} className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 dark:border-white/10 dark:bg-slate-950/35">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-slate-900 dark:text-white">{expenseTitle}</div>
                          {metadata.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                              {metadata.map((part, index) => (
                                <React.Fragment key={`${expense.id}-meta-${index}`}>
                                  {index > 0 && <span aria-hidden="true">•</span>}
                                  <span>{part}</span>
                                </React.Fragment>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <div className="text-base font-black text-rose-500 dark:text-rose-300">
                            -{formatCurrency(expense.amount)}
                          </div>
                          <button
                            type="button"
                            disabled={deletingExpenseId === expense.id}
                            onClick={() =>
                              requestDeleteExpense({
                                id: expense.id,
                                description: expenseTitle,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('modals.expense.deleteExpense', 'Delete expense')}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }) : renderEmptyState(
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

      <ConfirmDialog
        isOpen={Boolean(expenseToDelete)}
        onClose={() => {
          if (!deletingExpenseId) {
            setExpenseToDelete(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmDeleteExpense();
        }}
        title={t('modals.expense.deleteExpenseConfirmTitle', 'Delete expense')}
        message={t(
          'modals.expense.deleteExpenseConfirmMessage',
          'Delete "{{description}}"? This will immediately remove it from the drawer totals.',
          {
            description:
              expenseToDelete?.description ||
              t('modals.expense.untitledExpense', 'Untitled expense'),
          },
        )}
        confirmText={t('modals.expense.deleteExpense', 'Delete expense')}
        cancelText={t('common.actions.cancel', 'Cancel')}
        variant="error"
        isLoading={Boolean(deletingExpenseId)}
      />
    </>
  );
}
