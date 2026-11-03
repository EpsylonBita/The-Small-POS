import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeDollarSign,
  ChevronDown,
  ClipboardList,
  FileText,
  Pencil,
  Receipt,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { LiquidGlassModal } from '../ui/pos-glass-components';
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
import { parseMoneyInputValue } from '../../utils/moneyInput';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';
import { CashHandIcon } from '../icons/PaymentMethodIcons';
import { translateRoleName } from '../../utils/role-labels';
import { loadFiscalOrderReportingEntitlement } from '../../utils/fiscal-integration-entitlement';
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
  // Stable role slug (e.g. "cashier") used to localize the visible label via
  // common.roleNames.*; `role` stays the readable display/custom name fallback.
  roleSlug?: string;
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

interface DeletePaymentTarget {
  id: string;
  description: string;
}

type DrawerDropdownKey = 'expenseType' | 'staffMember' | 'paymentType';

interface DrawerDropdownOption {
  value: string;
  label: string;
}

type ShiftExpenseBridgeRow = Partial<ShiftExpense> & {
  shiftId?: string;
  staffId?: string;
  branchId?: string;
  expenseType?: unknown;
  receiptNumber?: unknown;
  approvedBy?: unknown;
  approvedAt?: unknown;
  rejectionReason?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

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

function isMissingPaymentError(message: string): boolean {
  return message.trim() === 'Staff payment not found';
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

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStatus(value: unknown): ShiftExpense['status'] {
  return value === 'approved' || value === 'rejected' || value === 'pending' ? value : 'pending';
}

function normalizeShiftExpenseRow(value: unknown): ShiftExpense | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const row = value as ShiftExpenseBridgeRow;
  const id = normalizeOptionalText(row.id);
  if (!id) {
    return null;
  }

  const amount = Number(row.amount ?? 0);

  return {
    id,
    shift_id: normalizeOptionalText(row.shift_id ?? row.shiftId) ?? '',
    staff_id: normalizeOptionalText(row.staff_id ?? row.staffId) ?? '',
    branch_id: normalizeOptionalText(row.branch_id ?? row.branchId) ?? '',
    expense_type: normalizeExpenseType(row.expense_type ?? row.expenseType),
    amount: Number.isFinite(amount) ? amount : 0,
    description: normalizeOptionalText(row.description) ?? '',
    receipt_number: normalizeOptionalText(row.receipt_number ?? row.receiptNumber),
    status: normalizeStatus(row.status),
    approved_by: normalizeOptionalText(row.approved_by ?? row.approvedBy),
    approved_at: normalizeOptionalText(row.approved_at ?? row.approvedAt),
    rejection_reason: normalizeOptionalText(row.rejection_reason ?? row.rejectionReason),
    created_at: normalizeOptionalText(row.created_at ?? row.createdAt) ?? '',
    updated_at: normalizeOptionalText(row.updated_at ?? row.updatedAt) ?? '',
  };
}

function normalizeShiftExpenses(value: unknown): ShiftExpense[] {
  return unwrapArray<unknown>(value).map(normalizeShiftExpenseRow).filter((expense): expense is ShiftExpense => Boolean(expense));
}

function formatExpenseReference(value: string | null | undefined): string {
  return value?.trim() ?? '';
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
    roleSlug:
      primaryRole?.name ||
      String(
        (record.role as Record<string, unknown> | undefined)?.name ??
          record.role_name ??
          '',
      ).trim() ||
      undefined,
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
  const [paymentToDelete, setPaymentToDelete] = useState<DeletePaymentTarget | null>(null);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<DrawerDropdownKey | null>(null);
  const [canUseExpenseReceiptReference, setCanUseExpenseReceiptReference] = useState(false);
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
  const canRecord = Boolean(cashierShift?.id) && !resolving;
  const currentCashierStaffId = cashierShift?.staff_id || staff?.databaseStaffId || staff?.staffId || '';
  const editingPayment = useMemo(
    () => staffPayments.find((payment) => payment.id === editingPaymentId) ?? null,
    [editingPaymentId, staffPayments],
  );
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
  const showCashierAttention = !cashierShift || cashierShiftSyncBanner?.variant === 'failed';

  const totalExpenses = useMemo(
    () => expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    [expenses],
  );
  const totalStaffPayments = useMemo(
    () => staffPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    [staffPayments],
  );
  const combinedOutflow = totalExpenses + totalStaffPayments;

  // Validation state for the expense form. The hint must match the save button's
  // enabled/disabled state: when the form is valid (button enabled) no "required"
  // message is shown, otherwise it explains exactly what is still missing.
  const expenseAmountValue = parseMoneyInputValue(expenseDraft.amount);
  const hasExpenseDescription = Boolean(expenseDraft.description.trim());
  const canSubmitExpense = canRecord && expenseAmountValue > 0 && hasExpenseDescription;
  const expenseValidationHint = !canRecord
    ? ''
    : expenseAmountValue <= 0
      ? t('modals.expense.invalidAmount', 'Please enter a valid amount')
      : !hasExpenseDescription
        ? t('modals.expense.justificationRequired', 'A clear justification is required before saving.')
        : '';

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
          subtitle: [
            getExpenseTypeLabel(t, expense.expense_type),
            canUseExpenseReceiptReference ? formatExpenseReference(expense.receipt_number) : '',
          ].filter(Boolean).join(' | '),
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
    [canUseExpenseReceiptReference, expenses, staffPayments, t],
  );

  const expenseTypeOptions = useMemo<DrawerDropdownOption[]>(
    () =>
      EXPENSE_TYPES.map((expenseType) => ({
        value: expenseType,
        label: t(`modals.expense.expenseTypes.${expenseType}`, expenseType),
      })),
    [t],
  );

  const staffDropdownOptions = useMemo<DrawerDropdownOption[]>(() => {
    const options: DrawerDropdownOption[] = [
      {
        value: '',
        label: t('modals.expense.staffPlaceholder', 'Select a staff member'),
      },
    ];

    if (
      editingPayment &&
      paymentDraft.paidToStaffId &&
      !staffOptions.some((option) => option.id === paymentDraft.paidToStaffId)
    ) {
      options.push({
        value: paymentDraft.paidToStaffId,
        label: editingPayment.staff_name || t('common.unknown', 'Unknown'),
      });
    }

    options.push(
      ...staffOptions.map((option) => ({
        value: option.id,
        label: `${option.name} - ${translateRoleName(t, option.roleSlug || option.role, option.role)}`,
      })),
    );

    return options;
  }, [editingPayment, paymentDraft.paidToStaffId, staffOptions, t]);

  const staffPaymentTypeOptions = useMemo<DrawerDropdownOption[]>(
    () =>
      STAFF_PAYMENT_TYPES.map((paymentType) => ({
        value: paymentType,
        label: t(`modals.expense.paymentTypes.${paymentType}`, paymentType),
      })),
    [t],
  );

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab('expenses');
    setExpenseToDelete(null);
    setDeletingExpenseId(null);
    setPaymentToDelete(null);
    setDeletingPaymentId(null);
    setEditingPaymentId(null);
    setOpenDropdown(null);
    setCanUseExpenseReceiptReference(false);
    setExpenseDraft({ expenseType: 'other', amount: '', description: '', receiptNumber: '' });
    setPaymentDraft({ paidToStaffId: '', amount: '', paymentType: 'wage', notes: '' });
    void refreshModalData();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const refreshFiscalEntitlement = async () => {
      const hasFiscalEntitlement = await loadFiscalOrderReportingEntitlement().catch(() => false);
      if (cancelled) {
        return;
      }

      setCanUseExpenseReceiptReference(hasFiscalEntitlement);
      if (!hasFiscalEntitlement) {
        setExpenseDraft((current) =>
          current.receiptNumber ? { ...current, receiptNumber: '' } : current,
        );
      }
    };

    void refreshFiscalEntitlement();

    return () => {
      cancelled = true;
    };
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
    setExpenses(normalizeShiftExpenses(loadedExpenses));
    setStaffPayments(unwrapArray<StaffPayment>(loadedPayments));
  };

  const resetPaymentForm = () => {
    setEditingPaymentId(null);
    setPaymentDraft({
      paidToStaffId: currentCashierStaffId || '',
      amount: '',
      paymentType: 'wage',
      notes: '',
    });
  };

  const beginEditStaffPayment = (payment: StaffPayment) => {
    setEditingPaymentId(payment.id);
    setActiveTab('staffPayments');
    setPaymentDraft({
      paidToStaffId: payment.paid_to_staff_id || '',
      amount: Number(payment.amount || 0).toFixed(2),
      paymentType: payment.payment_type,
      notes: payment.notes || '',
    });
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
        receiptNumber: canUseExpenseReceiptReference
          ? expenseDraft.receiptNumber.trim() || undefined
          : undefined,
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
      const result = editingPaymentId
        ? await bridge.shifts.updateStaffPayment({
            paymentId: editingPaymentId,
            cashierShiftId: cashierShift.id,
            paidToStaffId: paymentDraft.paidToStaffId,
            amount,
            paymentType: paymentDraft.paymentType,
            notes: paymentDraft.notes.trim() || undefined,
          })
        : await bridge.shifts.recordStaffPayment({
            cashierShiftId: cashierShift.id,
            paidToStaffId: paymentDraft.paidToStaffId,
            amount,
            paymentType: paymentDraft.paymentType,
            notes: paymentDraft.notes.trim() || undefined,
          });
      if (!result.success) {
        throw new Error(
          result.error ||
            t(
              editingPaymentId ? 'modals.expense.paymentUpdateFailed' : 'modals.expense.paymentFailed',
              editingPaymentId ? 'Failed to update staff payment' : 'Failed to record staff payment',
            ),
        );
      }
      toast.success(
        t(
          editingPaymentId ? 'modals.expense.paymentUpdated' : 'modals.expense.paymentRecorded',
          editingPaymentId
            ? 'Staff payment updated and drawer totals recalculated'
            : 'Staff payment charged to the active cashier drawer',
        ),
      );
      resetPaymentForm();
      await loadShiftActivity(cashierShift);
      if (!editingPaymentId) {
        setActiveTab('activity');
      }
    } catch (error) {
      toast.error(
        extractMessage(
          error,
          t(
            editingPaymentId ? 'modals.expense.paymentUpdateFailed' : 'modals.expense.paymentFailed',
            editingPaymentId ? 'Failed to update staff payment' : 'Failed to record staff payment',
          ),
        ),
      );
    } finally {
      setSubmittingPayment(false);
    }
  };

  const requestDeleteExpense = (expense: DeleteExpenseTarget) => {
    setExpenseToDelete(expense);
  };

  const requestDeletePayment = (payment: DeletePaymentTarget) => {
    setPaymentToDelete(payment);
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

  const handleConfirmDeletePayment = async () => {
    if (!paymentToDelete || !cashierShift?.id) {
      setPaymentToDelete(null);
      return;
    }

    setDeletingPaymentId(paymentToDelete.id);
    try {
      const result = await bridge.shifts.deleteStaffPayment({
        paymentId: paymentToDelete.id,
        cashierShiftId: cashierShift.id,
      });
      if (!result?.success) {
        throw new Error(
          result?.error ||
            t('modals.expense.paymentDeleteFailed', 'Failed to delete staff payment'),
        );
      }

      if (editingPaymentId === paymentToDelete.id) {
        resetPaymentForm();
      }

      await loadShiftActivity(cashierShift);
      toast.success(
        t(
          'modals.expense.paymentDeleted',
          'Staff payment deleted and drawer totals recalculated',
        ),
      );
      setPaymentToDelete(null);
    } catch (error) {
      const message = extractMessage(
        error,
        t('modals.expense.paymentDeleteFailed', 'Failed to delete staff payment'),
      );

      if (isMissingPaymentError(message)) {
        if (editingPaymentId === paymentToDelete.id) {
          resetPaymentForm();
        }
        await loadShiftActivity(cashierShift);
        setPaymentToDelete(null);
        return;
      }

      toast.error(message);
    } finally {
      setDeletingPaymentId(null);
    }
  };

  // Founder 01/11 (this window, «στο ίδιο στυλ» as the shift check-out forms; «γυαλί όπως τα υπόλοιπα»): kit cards
  // that frost on the shared glass shell, sentence-case labels, kit fields, one yellow primary per form. Every
  // amount keeps its colour.
  const drawerSummaryCardClass = 'pos-card p-4';
  const drawerPanelClass = 'pos-card flex flex-col p-5';
  const drawerSidePanelClass = 'pos-card p-4';
  const drawerListItemClass = 'pos-frost rounded-xl border px-4 py-3';
  const drawerActivityItemClass = 'pos-frost flex items-start justify-between gap-4 rounded-xl border px-4 py-3';
  const drawerEmptyStateClass = 'rounded-xl border border-dashed border-zinc-400 px-6 py-5 text-center dark:border-zinc-600';
  const drawerEmptyIconClass = 'mx-auto flex h-11 w-11 items-center justify-center text-(--pos-s-muted)';
  const drawerLabelClass = 'mb-1 block text-sm font-semibold text-(--pos-s-fg)';
  const drawerInputClass = 'min-h-[48px] w-full rounded-xl border border-(--pos-s-control) bg-(--pos-s-surface) px-3 py-2.5 text-(--pos-s-fg) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:border-(--pos-s-yellow) disabled:cursor-not-allowed disabled:opacity-60';
  const drawerSubmitClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--primary';
  // The action bar sits at the card's foot (the card stretches to the summary column). It has no fill or blur of
  // its own: inside the glass shell either one drew a lighter band over the card (founder 01/11, «βλέπεις τα λάθη;»).
  const drawerFooterClass = '-mx-5 -mb-5 flex flex-wrap items-center gap-3 border-t border-(--modal-glass-line) px-5 py-4';
  const drawerRowActionClass = 'pos-solid-btn pos-solid-btn--sm';
  const drawerSpinner = <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
  // The open list is the kit dropdown list (the same look as every dropdown in the till): a solid rounded panel, 44 px
  // rows, the chosen row in the kit selection yellow.
  const drawerDropdownMenuClass = 'absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[min(60vh,420px)] overflow-y-auto rounded-[14px] border border-(--pos-s-border) bg-(--pos-s-surface) p-1.5 text-(--pos-s-fg) shadow-xl';
  const drawerDropdownOptionClass = 'flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[15px] font-medium text-(--pos-s-fg) transition-colors active:bg-(--pos-s-surface-2) focus-visible:outline-2 focus-visible:outline-(--pos-s-fg)';

  const renderDrawerDropdown = ({
    dropdownKey,
    value,
    options,
    disabled,
    onChange,
  }: {
    dropdownKey: DrawerDropdownKey;
    value: string;
    options: DrawerDropdownOption[];
    disabled?: boolean;
    onChange: (value: string) => void;
  }) => {
    const isOpenDropdown = openDropdown === dropdownKey;
    const selectedOption = options.find((option) => option.value === value) || options[0];

    return (
      <div
        className="relative"
        onBlur={(event) => {
          const nextFocus = event.relatedTarget;
          if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
            setOpenDropdown(null);
          }
        }}
      >
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpenDropdown}
          onClick={() => setOpenDropdown((current) => (current === dropdownKey ? null : dropdownKey))}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpenDropdown(null);
            }
          }}
          className={`${drawerInputClass} flex items-center justify-between gap-3 text-left ${
            isOpenDropdown ? 'border-(--pos-s-yellow)' : ''
          }`}
        >
          <span className={selectedOption?.value ? 'truncate' : 'truncate text-(--pos-s-muted)'}>
            {selectedOption?.label}
          </span>
          <ChevronDown
            className={`h-5 w-5 shrink-0 text-(--pos-s-muted) transition-transform ${isOpenDropdown ? 'rotate-180' : ''}`}
          />
        </button>

        {isOpenDropdown && (
          <div className={drawerDropdownMenuClass} role="listbox">
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <button
                  key={`${dropdownKey}-${option.value || 'empty'}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option.value);
                    setOpenDropdown(null);
                  }}
                  className={`${drawerDropdownOptionClass} ${selected ? 'bg-(--pos-s-sel-bg)! font-semibold text-(--pos-s-sel-fg)!' : ''}`}
                >
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderSummaryCard = (
    label: string,
    value: string,
    helper: string,
    accentClass: string,
  ) => (
    <div className={drawerSummaryCardClass}>
      <p className="text-sm font-semibold text-(--pos-s-muted)">{label}</p>
      <div className={`mt-1 text-xl font-black ${accentClass}`}>{value}</div>
      <p className="mt-1 text-sm text-(--pos-s-muted)">{helper}</p>
    </div>
  );

  const renderEmptyState = (
    icon: React.ReactNode,
    title: string,
    description: string,
    options?: { wrapIcon?: boolean },
  ) => (
    <div className={drawerEmptyStateClass}>
      {options?.wrapIcon === false ? icon : (
        <div className={drawerEmptyIconClass}>
          {icon}
        </div>
      )}
      <h4 className="mt-2 text-base font-semibold text-(--pos-s-fg)">{title}</h4>
      <p className="mt-1 text-sm text-(--pos-s-muted)">{description}</p>
    </div>
  );

  const renderActivityItem = (item: ActivityItem) => {
    const isExpense = item.kind === 'expense';
    const isDeleting = isExpense && deletingExpenseId === item.sourceId;
    const isDeletingPayment = !isExpense && deletingPaymentId === item.sourceId;
    return (
      <div
        key={item.id}
        className={drawerActivityItemClass}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`shrink-0 text-sm font-semibold ${isExpense ? 'text-rose-600 dark:text-rose-300' : 'text-amber-600 dark:text-amber-300'}`}>
              {isExpense
                ? t('modals.expense.tabs.expenses', 'Expenses')
                : t('modals.expense.tabs.staffPayments', 'Staff Payments')}
            </span>
            <span className="truncate text-sm font-semibold text-(--pos-s-fg)">{item.title}</span>
          </div>
          <p className="mt-1 text-sm text-(--pos-s-muted)">{item.subtitle}</p>
          <div className="mt-1 text-sm text-(--pos-s-muted)">
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
          {isExpense ? (
            <button
              type="button"
              disabled={isDeleting}
              onClick={() =>
                requestDeleteExpense({
                  id: item.sourceId,
                  description: item.title,
                })
              }
              className={`${drawerRowActionClass} pos-solid-btn--danger`}
            >
              <Trash2 className="h-4 w-4" />
              {t('modals.expense.deleteExpense', 'Delete expense')}
            </button>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={submittingPayment}
                onClick={() => {
                  const payment = staffPayments.find((entry) => entry.id === item.sourceId);
                  if (payment) {
                    beginEditStaffPayment(payment);
                  }
                }}
                className={drawerRowActionClass}
              >
                <Pencil className="h-4 w-4" />
                {t('modals.expense.editStaffPayment', 'Edit payment')}
              </button>
              <button
                type="button"
                disabled={isDeletingPayment}
                onClick={() =>
                  requestDeletePayment({
                    id: item.sourceId,
                    description: item.title,
                  })
                }
                className={`${drawerRowActionClass} pos-solid-btn--danger`}
              >
                <Trash2 className="h-4 w-4" />
                {t('modals.expense.deleteStaffPayment', 'Delete payment')}
              </button>
            </div>
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
        className="max-w-4xl! w-[90vw]! max-h-[95vh]!"
        contentClassName="flex min-h-0 flex-col gap-4"
        ariaLabel={t('modals.expense.title', 'Drawer Outflows')}
      >
      {showCashierAttention && (
        <div
          className={`pos-notice shrink-0 ${
            !cashierShift || cashierShiftSyncBanner?.variant === 'failed' ? 'pos-notice--warn' : ''
          }`}
        >
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 shrink-0">
                {!cashierShift || cashierShiftSyncBanner?.variant === 'failed' ? (
                  <AlertTriangle className="h-5 w-5 text-(--pos-s-warn)" />
                ) : (
                  <RefreshCw className="h-5 w-5 text-(--pos-s-muted)" />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold">
                  {!cashierShift
                    ? t('modals.expense.noActiveCashier', 'No active cashier drawer')
                    : cashierShiftSyncBanner?.title}
                </div>
                <div className="mt-1 text-sm">
                  {!cashierShift
                    ? cashierWarning ||
                      t(
                        'modals.expense.noActiveCashierDetail',
                        'Start a cashier shift on this terminal before recording drawer outflows.',
                      )
                    : cashierShiftSyncBanner?.message}
                </div>
                {cashierShiftSyncBanner && cashierShiftDisplaySyncStatus && (
                  <div className="mt-1 text-sm text-(--pos-s-muted)">
                    {t('modals.expense.cashierShiftSyncStatusLabel', {
                      defaultValue: 'Local sync status',
                    })}
                    : {cashierShiftDisplaySyncStatus.replace(/_/g, ' ')}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={resolving}
              className="pos-solid-btn pos-solid-btn--sm shrink-0"
              onClick={() => {
                void refreshModalData();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>
      )}

      <div className="shrink-0 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
              aria-pressed={active}
              className={`pos-choice${active ? ' is-selected' : ''}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
        </div>
        {cashierShift && !showCashierAttention && (
          <button
            type="button"
            disabled={resolving}
            className="pos-solid-btn pos-solid-btn--sm shrink-0"
            onClick={() => {
              void refreshModalData();
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t('common.refresh', 'Refresh')}
          </button>
        )}
      </div>

      <div className="pos-scroll-room min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-4">
      {activeTab === 'expenses' && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.18fr)_360px]">
          <section className={drawerPanelClass}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-(--pos-s-fg)">
                  {t('modals.expense.expenseFormHeading', 'Operational expense')}
                </h3>
                <p className="mt-1 text-sm text-(--pos-s-muted)">
                  {t('modals.expense.chargedToDrawer', 'This outflow is charged directly to the active cashier drawer.')}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className={drawerLabelClass}>
                  {t('modals.expense.expenseType', 'Expense type')}
                </label>
                {renderDrawerDropdown({
                  dropdownKey: 'expenseType',
                  value: expenseDraft.expenseType,
                  options: expenseTypeOptions,
                  disabled: !canRecord,
                  onChange: (value) =>
                    setExpenseDraft((current) => ({ ...current, expenseType: value as ExpenseType })),
                })}
              </div>

              <div>
                <label className={drawerLabelClass}>
                  {t('modals.expense.amountLabel', 'Amount')}
                </label>
                <div className="relative">
                  <CentsMoneyInput
                    aria-label={t('modals.expense.amountLabel', 'Amount')}
                    value={expenseDraft.amount}
                    onValueChange={(amount) => setExpenseDraft((current) => ({ ...current, amount }))}
                    placeholder="0,00"
                    disabled={!canRecord}
                    className={`${drawerInputClass} pl-10! text-lg font-bold`}
                  />
                  <CashHandIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-(--pos-s-muted)" />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label className={drawerLabelClass}>
                {t('modals.expense.justification', 'Justification')}
              </label>
              <textarea
                rows={5}
                value={expenseDraft.description}
                onChange={(event) => setExpenseDraft((current) => ({ ...current, description: event.target.value }))}
                placeholder={t('modals.expense.justificationPlaceholder', 'Explain what left the drawer and why it was needed.')}
                disabled={!canRecord}
                className={`${drawerInputClass} min-h-[92px] resize-none`}
              />
            </div>

            {canUseExpenseReceiptReference && (
              <div className="mt-4">
                <label className={drawerLabelClass}>
                  {t('modals.expense.receiptReference', 'Receipt or reference')}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={expenseDraft.receiptNumber}
                    onChange={(event) => setExpenseDraft((current) => ({ ...current, receiptNumber: event.target.value }))}
                    placeholder={t('modals.expense.receiptPlaceholder', 'Invoice, receipt, or reference number')}
                    disabled={!canRecord}
                    className={`${drawerInputClass} pl-10!`}
                  />
                  <FileText className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--pos-s-muted)" />
                </div>
              </div>
            )}

            <div aria-hidden="true" className="min-h-4 flex-1" />
            <div className={drawerFooterClass}>
              <button
                type="button"
                disabled={!canSubmitExpense || submittingExpense}
                aria-busy={submittingExpense || undefined}
                onClick={() => { void handleRecordExpense(); }}
                className={drawerSubmitClass}
              >
                {submittingExpense ? drawerSpinner : <Receipt className="h-4 w-4" />}
                {t('modals.expense.recordExpense', 'Record expense')}
              </button>
              {expenseValidationHint && (
                <p className="text-sm text-(--pos-s-muted)">
                  {expenseValidationHint}
                </p>
              )}
            </div>
          </section>

          <aside className="flex flex-col gap-3">
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

            <div className={drawerSidePanelClass}>
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-base font-semibold text-(--pos-s-fg)">
                  {t('modals.expense.recentExpenses', 'Recent expenses')}
                </h4>
              </div>

              <div className="mt-3 flex flex-col gap-2.5">
                {recentExpenses.length > 0 ? recentExpenses.map((expense) => {
                  const expenseTitle =
                    expense.description || t('modals.expense.untitledExpense', 'Untitled expense');
                  const metadata = [
                    getExpenseTypeLabel(t, expense.expense_type),
                    canUseExpenseReceiptReference ? formatExpenseReference(expense.receipt_number) : '',
                    formatOptionalActivityDateTime(expense.created_at),
                  ].filter(Boolean);

                  return (
                    <div key={expense.id} className={drawerListItemClass}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-(--pos-s-fg)">{expenseTitle}</div>
                          {metadata.length > 0 && (
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-(--pos-s-muted)">
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
                            className={`${drawerRowActionClass} pos-solid-btn--danger`}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('modals.expense.deleteExpense', 'Delete expense')}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }) : renderEmptyState(
                  // Founder 01/11: the founder's cash glyph (as in the payment window), its inner fill the card's.
                  <span className="mx-auto block w-fit" style={{ '--pay-icon-fill': 'var(--pos-s-surface)' } as React.CSSProperties}>
                    <CashHandIcon className="h-11 w-11 payment-option-cash-icon" />
                  </span>,
                  t('modals.expense.noExpenses', 'No expenses recorded yet'),
                  t('modals.expense.noExpensesDetail', 'Recorded expenses will appear here immediately after saving.'),
                  { wrapIcon: false },
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'staffPayments' && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.18fr)_360px]">
          <section className={drawerPanelClass}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-(--pos-s-fg)">
                  {t(
                    editingPaymentId ? 'modals.expense.editStaffPaymentTitle' : 'modals.expense.staffPaymentFormHeading',
                    editingPaymentId ? 'Edit staff payment' : 'Staff payout from drawer',
                  )}
                </h3>
                <p className="mt-1 text-sm text-(--pos-s-muted)">
                  {t(
                    'modals.expense.staffPaymentDrawerNote',
                    'Every payment here is deducted from the active cashier drawer.',
                  )}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className={drawerLabelClass}>
                  {t('modals.expense.selectStaff', 'Pay to staff')}
                </label>
                {renderDrawerDropdown({
                  dropdownKey: 'staffMember',
                  value: paymentDraft.paidToStaffId,
                  options: staffDropdownOptions,
                  disabled: !canRecord,
                  onChange: (value) =>
                    setPaymentDraft((current) => ({ ...current, paidToStaffId: value })),
                })}
              </div>

              <div>
                <label className={drawerLabelClass}>
                  {t('modals.expense.paymentType', 'Payment type')}
                </label>
                {renderDrawerDropdown({
                  dropdownKey: 'paymentType',
                  value: paymentDraft.paymentType,
                  options: staffPaymentTypeOptions,
                  disabled: !canRecord,
                  onChange: (value) =>
                    setPaymentDraft((current) => ({ ...current, paymentType: value as StaffPaymentType })),
                })}
              </div>
            </div>

            <div className="mt-4">
              <label className={drawerLabelClass}>
                {t('modals.expense.amountLabel', 'Amount')}
              </label>
              <div className="relative">
                <CentsMoneyInput
                  aria-label={t('modals.expense.amountLabel', 'Amount')}
                  value={paymentDraft.amount}
                  onValueChange={(amount) => setPaymentDraft((current) => ({ ...current, amount }))}
                  placeholder="0,00"
                  disabled={!canRecord}
                  className={`${drawerInputClass} pl-10! text-lg font-bold`}
                />
                <CashHandIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-(--pos-s-muted)" />
              </div>
            </div>

            <div className="mt-4">
              <label className={drawerLabelClass}>
                {t('modals.expense.notes', 'Notes')}
              </label>
              <textarea
                rows={5}
                value={paymentDraft.notes}
                onChange={(event) => setPaymentDraft((current) => ({ ...current, notes: event.target.value }))}
                placeholder={t('modals.expense.notesPlaceholder', 'Optional note for payroll, tip settlement, advance, or bonus.')}
                disabled={!canRecord}
                className={`${drawerInputClass} min-h-[92px] resize-none`}
              />
            </div>

            {staffDirectoryWarning && (
              <div className="pos-notice pos-notice--warn mt-4 text-sm">
                {staffDirectoryWarning}
              </div>
            )}

            <p className="mt-4 text-sm text-(--pos-s-muted)">
              {t(
                'modals.expense.staffPaymentHelper',
                'Use this for cashier self-payments or payments to other staff from the drawer. Drawer totals update immediately after corrections.',
              )}
            </p>

            <div aria-hidden="true" className="min-h-4 flex-1" />
            <div className={drawerFooterClass}>
              {editingPaymentId && (
                <button type="button" className="pos-solid-btn pos-solid-btn--md" onClick={resetPaymentForm}>
                  {t('modals.expense.cancelEditStaffPayment', 'Cancel edit')}
                </button>
              )}
              <button
                type="button"
                disabled={!canRecord || !paymentDraft.paidToStaffId || parseMoneyInputValue(paymentDraft.amount) <= 0 || submittingPayment}
                aria-busy={submittingPayment || undefined}
                onClick={() => { void handleRecordStaffPayment(); }}
                className={drawerSubmitClass}
              >
                {submittingPayment ? drawerSpinner : <BadgeDollarSign className="h-4 w-4" />}
                {t(
                  editingPaymentId ? 'modals.expense.saveStaffPaymentChanges' : 'modals.expense.recordStaffPayment',
                  editingPaymentId ? 'Save changes' : 'Record staff payment',
                )}
              </button>
            </div>
          </section>

          <aside className="flex flex-col gap-3">
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

            <div className={drawerSidePanelClass}>
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-base font-semibold text-(--pos-s-fg)">
                  {t('modals.expense.recentStaffPayments', 'Recent staff payments')}
                </h4>
                <Users className="h-5 w-5 text-(--pos-s-muted)" />
              </div>

              <div className="mt-3 flex flex-col gap-2.5">
                {recentPayments.length > 0 ? recentPayments.map((payment) => (
                  <div key={payment.id} className={drawerListItemClass}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-(--pos-s-fg)">
                          {payment.staff_name || t('common.unknown', 'Unknown')}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-(--pos-s-muted)">
                          <span>{t(`modals.expense.paymentTypes.${payment.payment_type}`, payment.payment_type)}</span>
                          {payment.role_type && <><span>•</span><span>{translateRoleName(t, payment.role_type)}</span></>}
                          <span>•</span>
                          <span>{formatDateTime(payment.created_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {payment.notes && <p className="mt-1 text-sm text-(--pos-s-muted)">{payment.notes}</p>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <div className="text-base font-black text-amber-500 dark:text-amber-300">
                          -{formatCurrency(payment.amount)}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            disabled={submittingPayment}
                            onClick={() => beginEditStaffPayment(payment)}
                            className={drawerRowActionClass}
                          >
                            <Pencil className="h-4 w-4" />
                            {t('modals.expense.editStaffPayment', 'Edit payment')}
                          </button>
                          <button
                            type="button"
                            disabled={deletingPaymentId === payment.id}
                            onClick={() =>
                              requestDeletePayment({
                                id: payment.id,
                                description: payment.staff_name || t('common.unknown', 'Unknown'),
                              })
                            }
                            className={`${drawerRowActionClass} pos-solid-btn--danger`}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t('modals.expense.deleteStaffPayment', 'Delete payment')}
                          </button>
                        </div>
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
        <div className="flex flex-col gap-4">
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

          <div className={drawerSidePanelClass}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-base font-semibold text-(--pos-s-fg)">
                  {t('modals.expense.activityTitle', 'Drawer activity')}
                </h4>
                <p className="mt-1 text-sm text-(--pos-s-muted)">
                  {t('modals.expense.activitySubtitle', 'Expenses and staff payments recorded on this cashier shift')}
                </p>
              </div>
              <ClipboardList className="h-5 w-5 text-(--pos-s-muted)" />
            </div>

            <div className="mt-4 flex flex-col gap-3">
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
      </div>
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
      <ConfirmDialog
        isOpen={Boolean(paymentToDelete)}
        onClose={() => {
          if (!deletingPaymentId) {
            setPaymentToDelete(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmDeletePayment();
        }}
        title={t('modals.expense.deleteStaffPaymentConfirmTitle', 'Delete staff payment')}
        message={t(
          'modals.expense.deleteStaffPaymentConfirmMessage',
          'Delete the payment for "{{description}}"? The cashier checkout totals will be recalculated immediately.',
          {
            description:
              paymentToDelete?.description ||
              t('common.unknown', 'Unknown'),
          },
        )}
        confirmText={t('modals.expense.deleteStaffPayment', 'Delete payment')}
        cancelText={t('common.actions.cancel', 'Cancel')}
        variant="error"
        isLoading={Boolean(deletingPaymentId)}
      />
    </>
  );
}
