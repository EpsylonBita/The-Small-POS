import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X, Clock, Euro, FileText, Plus, AlertCircle, User, ChevronRight, AlertTriangle, CheckCircle, XCircle, Banknote, CreditCard, Star, Check, Trash2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense, StaffPayment } from '../../types';
import useTerminalSettings from '../../hooks/useTerminalSettings';
import { liquidGlassModalCard } from '../../styles/designSystem';
import { LiquidGlassModal, POSGlassBadge, POSGlassCard } from '../ui/pos-glass-components';
import { POSGlassTooltip } from '../ui/POSGlassTooltip';
import { VarianceBadge } from '../ui/VarianceBadge';
import { formatTime, formatCurrency } from '../../utils/format';
import { formatMoneyInputWithCents, parseMoneyInputValue } from '../../utils/moneyInput';
import { toLocalDateString } from '../../utils/date';
import { ProgressStepper, Step, StepStatus } from '../ui/ProgressStepper';
import { ConfirmDialog, ConfirmVariant } from '../ui/ConfirmDialog';
import { ErrorAlert } from '../ui/ErrorAlert';
import { UnsettledPaymentBlockersPanel } from '../ui/UnsettledPaymentBlockersPanel';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { StaffShiftCheckoutFooterActions } from './StaffShiftCheckoutFooterActions';
import {
  buildShiftCheckoutPrintSnapshot,
  canPrintShiftCheckoutSnapshot,
  queueShiftCheckoutPrint,
} from '../../utils/staffShiftCheckoutPrint';
import { getBridge } from '../../../lib';
import type {
  PaymentIntegrityErrorPayload,
  UnsettledPaymentBlocker,
} from '../../../lib/ipc-contracts';
import {
  formatPaymentIntegrityError,
  extractPaymentIntegrityPayload,
} from '../../../lib/payment-integrity';

// IPC result shapes from bridge calls
interface SettingsResult {
  [key: string]: unknown;
  terminal?: { branch_id?: string; terminal_id?: string };
}

interface ShiftIpcResult extends PaymentIntegrityErrorPayload {
  success: boolean;
  shiftId?: string;
  variance?: number;
  error?: string;
  data?: { shiftId?: string; id?: string; variance?: number };
}

interface ShiftPrintCheckoutResult extends ShiftIpcResult {
  skipped?: boolean;
  queued?: boolean;
}

interface ShiftCheckInEligibility {
  requiresCashierFirst: boolean;
  hasCashierForBusinessDay?: boolean;
  businessDayStartAt?: string | null;
}

interface StaffShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'checkin' | 'checkout';
  /** Hide cash drawer fields for mobile waiter terminals */
  hideCashDrawer?: boolean;
  /** Indicates if this is a mobile waiter terminal */
  isMobileWaiter?: boolean;
}

interface StaffRole {
  role_id: string;
  role_name: string;
  role_display_name: string;
  role_color: string;
  is_primary: boolean;
}

interface StaffMember {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  role_id: string;
  role_name: string;
  role_display_name: string;
  roles: StaffRole[]; // All roles for this staff member
  can_login_pos: boolean;
  is_active: boolean;
  has_pin?: boolean;
  pin_hash?: string | null;
  hourly_rate?: number;
}

interface StaffAuthCachePayload {
  version: number;
  branch_id: string;
  synced_at: string;
  staff: StaffMember[];
}

const STAFF_AUTH_CACHE_CATEGORY = 'staff_auth_cache';
const STAFF_AUTH_CACHE_VERSION = 1;

type CheckInStep = 'select-staff' | 'enter-pin' | 'select-role' | 'enter-cash';
type StaffShiftRole = 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
type MotionDirection = 1 | -1;

interface RolePresentation {
  badgeFilled: string;
  badgeOutline: string;
  iconSurface: string;
  iconColor: string;
  accentText: string;
  accentSurface: string;
  accentBorder: string;
  buttonSurface: string;
}

const FALLBACK_ROLE_PRESENTATION: RolePresentation = {
  badgeFilled: 'border-slate-400/40 bg-slate-500/12 text-slate-700 dark:border-slate-400/30 dark:bg-slate-500/14 dark:text-slate-200',
  badgeOutline: 'border-slate-400/40 bg-transparent text-slate-600 dark:border-white/10 dark:bg-transparent dark:text-slate-300',
  iconSurface: 'border-slate-200/90 bg-slate-100/90 dark:border-white/10 dark:bg-white/[0.05]',
  iconColor: 'text-slate-600 dark:text-slate-200',
  accentText: 'text-slate-700 dark:text-slate-100',
  accentSurface: 'bg-slate-100/90 dark:bg-white/[0.05]',
  accentBorder: 'border-slate-200/90 dark:border-white/10',
  buttonSurface: 'border-slate-200/90 bg-white/90 text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08]',
};

const ROLE_PRESENTATIONS: Record<StaffShiftRole, RolePresentation> = {
  cashier: {
    badgeFilled: 'border-amber-400/45 bg-amber-500/12 text-amber-700 dark:border-amber-400/35 dark:bg-amber-500/14 dark:text-amber-200',
    badgeOutline: 'border-amber-400/45 bg-transparent text-amber-700 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-200',
    iconSurface: 'border-amber-200 bg-amber-50/90 dark:border-amber-400/30 dark:bg-amber-500/10',
    iconColor: 'text-amber-600 dark:text-amber-200',
    accentText: 'text-amber-700 dark:text-amber-200',
    accentSurface: 'bg-amber-50/90 dark:bg-amber-500/10',
    accentBorder: 'border-amber-200/90 dark:border-amber-400/30',
    buttonSurface: 'border-amber-200 bg-white text-amber-700 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/16',
  },
  driver: {
    badgeFilled: 'border-cyan-400/45 bg-cyan-500/12 text-cyan-700 dark:border-cyan-400/35 dark:bg-cyan-500/14 dark:text-cyan-200',
    badgeOutline: 'border-cyan-400/45 bg-transparent text-cyan-700 dark:border-cyan-400/30 dark:bg-transparent dark:text-cyan-200',
    iconSurface: 'border-cyan-200 bg-cyan-50/90 dark:border-cyan-400/30 dark:bg-cyan-500/10',
    iconColor: 'text-cyan-600 dark:text-cyan-200',
    accentText: 'text-cyan-700 dark:text-cyan-200',
    accentSurface: 'bg-cyan-50/90 dark:bg-cyan-500/10',
    accentBorder: 'border-cyan-200/90 dark:border-cyan-400/30',
    buttonSurface: 'border-cyan-200 bg-white text-cyan-700 hover:border-cyan-300 hover:bg-cyan-50 dark:border-cyan-400/30 dark:bg-cyan-500/10 dark:text-cyan-100 dark:hover:bg-cyan-500/16',
  },
  kitchen: {
    badgeFilled: 'border-rose-400/45 bg-rose-500/12 text-rose-700 dark:border-rose-400/35 dark:bg-rose-500/14 dark:text-rose-200',
    badgeOutline: 'border-rose-400/45 bg-transparent text-rose-700 dark:border-rose-400/30 dark:bg-transparent dark:text-rose-200',
    iconSurface: 'border-rose-200 bg-rose-50/90 dark:border-rose-400/30 dark:bg-rose-500/10',
    iconColor: 'text-rose-600 dark:text-rose-200',
    accentText: 'text-rose-700 dark:text-rose-200',
    accentSurface: 'bg-rose-50/90 dark:bg-rose-500/10',
    accentBorder: 'border-rose-200/90 dark:border-rose-400/30',
    buttonSurface: 'border-rose-200 bg-white text-rose-700 hover:border-rose-300 hover:bg-rose-50 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100 dark:hover:bg-rose-500/16',
  },
  server: {
    badgeFilled: 'border-indigo-400/45 bg-indigo-500/12 text-indigo-700 dark:border-indigo-400/35 dark:bg-indigo-500/14 dark:text-indigo-200',
    badgeOutline: 'border-indigo-400/45 bg-transparent text-indigo-700 dark:border-indigo-400/30 dark:bg-transparent dark:text-indigo-200',
    iconSurface: 'border-indigo-200 bg-indigo-50/90 dark:border-indigo-400/30 dark:bg-indigo-500/10',
    iconColor: 'text-indigo-600 dark:text-indigo-200',
    accentText: 'text-indigo-700 dark:text-indigo-200',
    accentSurface: 'bg-indigo-50/90 dark:bg-indigo-500/10',
    accentBorder: 'border-indigo-200/90 dark:border-indigo-400/30',
    buttonSurface: 'border-indigo-200 bg-white text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-100 dark:hover:bg-indigo-500/16',
  },
  manager: {
    badgeFilled: 'border-emerald-400/45 bg-emerald-500/12 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-500/14 dark:text-emerald-200',
    badgeOutline: 'border-emerald-400/45 bg-transparent text-emerald-700 dark:border-emerald-400/30 dark:bg-transparent dark:text-emerald-200',
    iconSurface: 'border-emerald-200 bg-emerald-50/90 dark:border-emerald-400/30 dark:bg-emerald-500/10',
    iconColor: 'text-emerald-600 dark:text-emerald-200',
    accentText: 'text-emerald-700 dark:text-emerald-200',
    accentSurface: 'bg-emerald-50/90 dark:bg-emerald-500/10',
    accentBorder: 'border-emerald-200/90 dark:border-emerald-400/30',
    buttonSurface: 'border-emerald-200 bg-white text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100 dark:hover:bg-emerald-500/16',
  },
};

const CHECKIN_STEP_ORDER: Record<CheckInStep, number> = {
  'select-staff': 0,
  'enter-pin': 1,
  'select-role': 2,
  'enter-cash': 3,
};

const CHECKIN_MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const CHECKIN_MOTION = {
  fast: 0.16,
  base: 0.22,
  slow: 0.28,
  press: {
    type: 'spring' as const,
    stiffness: 520,
    damping: 34,
    mass: 0.52,
  },
};

const INVALID_CONTEXT_VALUES = new Set([
  '',
  'default-organization',
  'default-org',
  'default-branch',
  'default-terminal',
]);

function normalizeContextId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (INVALID_CONTEXT_VALUES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  const paymentIntegrityMessage = formatPaymentIntegrityError(error, '');
  if (paymentIntegrityMessage.trim()) {
    return paymentIntegrityMessage.trim();
  }

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

function isUuidValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function buildStaffAuthCacheKey(branchId: string): string {
  return `branch_${branchId.trim()}`;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  return fallback;
}

function hasOwnKey(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function includesStaffAuthMetadata(members: unknown[]): boolean {
  return members.some((member) =>
    hasOwnKey(member, 'pin_hash') ||
    hasOwnKey(member, 'has_pin') ||
    hasOwnKey(member, 'can_login_pos'),
  );
}

function normalizeLegacyProbeError(error: string): string {
  return error.trim().toLowerCase();
}

function mapScheduledStaffToMember(member: any): StaffMember {
  // Map all roles from the API's roles array (new multi-role response)
  const apiRoles: StaffRole[] = Array.isArray(member?.roles)
    ? member.roles
        .map((r: any) => ({
          role_id: String(r?.id ?? r?.role_id ?? ''),
          role_name: String(r?.name ?? r?.role_name ?? 'staff'),
          role_display_name: String(
            r?.displayName ?? r?.display_name ?? r?.role_display_name ?? 'Staff',
          ),
          role_color: String(r?.color ?? r?.role_color ?? '#6B7280'),
          is_primary: Boolean(r?.isPrimary ?? r?.is_primary ?? false),
        }))
        .filter((r: StaffRole) => r.role_id)
    : [];

  // Fallback: if no roles array, use legacy single role field
  if (apiRoles.length === 0) {
    const roleRecord = member?.role || null;
    if (roleRecord) {
      apiRoles.push({
        role_id: String(roleRecord.id ?? roleRecord.role_id ?? member?.role_id ?? ''),
        role_name: String(roleRecord.name ?? roleRecord.role_name ?? member?.role_name ?? 'staff'),
        role_display_name: String(
          roleRecord.displayName ??
            roleRecord.display_name ??
            member?.role_display_name ??
            'Staff',
        ),
        role_color: String(roleRecord.color ?? roleRecord.role_color ?? member?.role_color ?? '#6B7280'),
        is_primary: true,
      });
    }
  }

  const primaryRole = apiRoles.find((r) => r.is_primary) || apiRoles[0];

  return {
    id: String(member?.id ?? '').trim(),
    name:
      String(member?.name ?? '').trim() ||
      `${member?.firstName ?? member?.first_name ?? ''} ${member?.lastName ?? member?.last_name ?? ''}`.trim() ||
      'Staff',
    first_name: String(member?.firstName ?? member?.first_name ?? ''),
    last_name: String(member?.lastName ?? member?.last_name ?? ''),
    email: String(member?.email ?? ''),
    role_id: primaryRole?.role_id ?? '',
    role_name: primaryRole?.role_name ?? 'staff',
    role_display_name: primaryRole?.role_display_name ?? 'Staff',
    roles: apiRoles,
    can_login_pos: parseBoolean(member?.can_login_pos, true),
    is_active: parseBoolean(member?.is_active, true),
    has_pin: typeof member?.has_pin === 'boolean' ? member.has_pin : undefined,
    pin_hash: typeof member?.pin_hash === 'string' ? member.pin_hash : null,
    hourly_rate: member?.hourly_rate,
  };
}

export function StaffShiftModal({ isOpen, onClose, mode, hideCashDrawer = false, isMobileWaiter = false }: StaffShiftModalProps) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift, setStaff, setActiveShiftImmediate } = useShift();

  // Helper function to translate role names
  const translateRoleName = (roleName: string): string => {
    const key = `common.roleNames.${roleName.toLowerCase()}`;
    const translated = t(key);
    // If translation not found, return original name
    return translated === key ? roleName : translated;
  };

  const getRolePresentation = (roleName?: string | null): RolePresentation => {
    const normalized = (roleName || '').trim().toLowerCase() as StaffShiftRole;
    return ROLE_PRESENTATIONS[normalized] ?? FALLBACK_ROLE_PRESENTATION;
  };

  const getStaffRoles = (member?: StaffMember | null): StaffRole[] => {
    if (!member) {
      return [];
    }

    if (member.roles?.length) {
      return [...member.roles].sort(
        (a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)),
      );
    }

    return [
      {
        role_id: member.role_id || member.role_name || 'role',
        role_name: member.role_name || 'staff',
        role_display_name: member.role_display_name || member.role_name || 'Staff',
        role_color: '#6B7280',
        is_primary: true,
      },
    ];
  };

  const getCheckInRoleHelper = (roleName: string): string => {
    switch ((roleName || '').trim().toLowerCase()) {
      case 'cashier':
        return t('modals.staffShift.cashierRoleHelper');
      case 'driver':
        return t('modals.staffShift.driverRoleHelper');
      case 'server':
        return t('modals.staffShift.serverRoleHelper');
      case 'kitchen':
        return t('modals.staffShift.kitchenRoleHelper');
      case 'manager':
        return t('modals.staffShift.managerRoleHelper');
      default:
        return t('modals.staffShift.roleStepLabel', 'Role');
    }
  };

  const isNonFinancialShiftRole = (role?: string | null): role is StaffShiftRole =>
    (role || '').trim().toLowerCase() === 'kitchen';

  const { getSetting } = useTerminalSettings();

  // Check-in multi-step state
  const [checkInStep, setCheckInStep] = useState<CheckInStep>('select-staff');
  const [availableStaff, setAvailableStaff] = useState<StaffMember[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [roleType, setRoleType] = useState<StaffShiftRole>('cashier');
  const [staffAuthMetadataStatus, setStaffAuthMetadataStatus] = useState<'available' | 'missing'>('available');

  // PIN Input reference for focus management
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Force focus on PIN input when entering the step
  useEffect(() => {
    if (checkInStep === 'enter-pin' && pinInputRef.current) {
      // Small timeout to ensure render is complete and animation has started
      setTimeout(() => {
        pinInputRef.current?.focus();
      }, 100);
    }
  }, [checkInStep]);
  const [openingCash, setOpeningCash] = useState(''); // For cashiers: drawer count
  const [driverStartingAmount, setDriverStartingAmount] = useState(''); // For drivers: amount taken from cashier
  const [activeCashierExists, setActiveCashierExists] = useState<boolean>(true); // Default to true, updated on driver role select
  const [checkInEligibility, setCheckInEligibility] = useState<ShiftCheckInEligibility | null>(null);
  const [showZeroCashConfirm, setShowZeroCashConfirm] = useState(false); // Confirmation dialog for cashier zero opening cash

  // Check-out state
  const [closingCash, setClosingCash] = useState('');
  const [driverActualCash, setDriverActualCash] = useState('');
  const [staffPayment, setStaffPayment] = useState('');
  const [isPrintCheckoutLoading, setIsPrintCheckoutLoading] = useState(false);


  // Track active shifts per staff
  const [staffActiveShifts, setStaffActiveShifts] = useState<Map<string, any>>(new Map());

  // Variance result state
  const [lastShiftResult, setLastShiftResult] = useState<{
    variance: number;
    breakdown?: {
      calculationVersion: number;
      opening: number;
      sales: number;
      cashRefunds: number;
      expenses: number;
      cashDrops: number;
      driverGiven: number;
      driverReturned: number;
      inheritedDriverExpectedReturns: number;
      recordedStaffPayments: number;
      deductedStaffPayments: number;
      expected: number;
      actual: number;
    };
  } | null>(null);
  const [checkoutPaymentBlockers, setCheckoutPaymentBlockers] = useState<
    UnsettledPaymentBlocker[]
  >([]);

  // Expense state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseType, setExpenseType] = useState<'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other'>('supplies');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseReceipt, setExpenseReceipt] = useState('');
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);
  const [deletingExpenseId, setDeletingExpenseId] = useState<string | null>(null);

  // Staff payment recording state (for cashiers)
  const [staffPaymentsList, setStaffPaymentsList] = useState<StaffPayment[]>([]);
  const [showStaffPaymentForm, setShowStaffPaymentForm] = useState(false);
  const [editingStaffPaymentId, setEditingStaffPaymentId] = useState<string | null>(null);
  const [deletingStaffPaymentId, setDeletingStaffPaymentId] = useState<string | null>(null);
  const [selectedStaffForPayment, setSelectedStaffForPayment] = useState<{ id: string; name: string; role: string } | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentType, setPaymentType] = useState('wage');
  const [paymentNotes, setPaymentNotes] = useState('');
  const editingStaffPayment = staffPaymentsList.find((payment) => payment.id === editingStaffPaymentId) ?? null;

  // Enhanced payment state
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [dailyPaymentTotal, setDailyPaymentTotal] = useState(0);
  const [expectedPayment, setExpectedPayment] = useState<number | null>(null);
  const [showPaymentConfirm, setShowPaymentConfirm] = useState(false);

  // Keyboard shortcuts for large payment confirmation
  useEffect(() => {
    if (showPaymentConfirm) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCancelLargePayment();
          e.stopPropagation();
        }
        if (e.key === 'Enter') {
          handleConfirmLargePayment();
          e.stopPropagation();
        }
      };
      window.addEventListener('keydown', handleKeyDown, true); // Capture phase to prevent other handlers
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [showPaymentConfirm]);

  const [pendingPaymentAmount, setPendingPaymentAmount] = useState(0);
  const LARGE_PAYMENT_THRESHOLD = 200;

  // Confirm Dialog State
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    variant: ConfirmVariant;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    requireCheckbox?: string;
    typeToConfirm?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    variant: 'info',
    onConfirm: () => { },
  });

  const openConfirm = (config: Partial<typeof confirmDialog> & { onConfirm: () => void, title: string, message: string }) => {
    setConfirmDialog(prev => ({ ...prev, isOpen: true, variant: 'info', ...config }));
  };

  const closeConfirm = () => setConfirmDialog(prev => ({ ...prev, isOpen: false }));

  const getInheritedStaffExpectedReturns = (summary: any) => {
    const inheritedDrivers = Array.isArray(summary?.transferredDrivers) ? summary.transferredDrivers : [];
    const inheritedWaiters = Array.isArray(summary?.transferredWaiters) ? summary.transferredWaiters : [];

    const totalDrivers = inheritedDrivers.reduce((sum: number, item: any) => sum + Number(item?.net_cash_amount || 0), 0);
    const totalWaiters = inheritedWaiters.reduce((sum: number, item: any) => sum + Number(item?.net_cash_amount || 0), 0);

    return totalDrivers + totalWaiters;
  };

  const getEffectiveOpeningAmount = (shift: any, summary?: any) =>
    Number(shift?.opening_cash_amount ?? summary?.shift?.opening_cash_amount ?? 0);

  const parseOptionalAmount = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    return parseMoneyInputValue(trimmed);
  };

  const hasManualCashInput = (value: string) => value.trim().length > 0;

  const getCurrentCashierIssuedFloat = (summary: any) => {
    const recordedGiven = Number(summary?.cashDrawer?.driver_cash_given || 0);
    if (recordedGiven > 0) return recordedGiven;

    const checkoutRows = Array.isArray(summary?.driverDeliveries) ? summary.driverDeliveries : [];
    const inheritedDrivers = Array.isArray(summary?.transferredDrivers) ? summary.transferredDrivers : [];
    const inheritedWaiters = Array.isArray(summary?.transferredWaiters) ? summary.transferredWaiters : [];

    const allStartingAmounts = checkoutRows.reduce(
      (sum: number, row: any) => sum + Number(row?.starting_amount || 0),
      0
    );
    const inheritedStartingAmounts =
      inheritedDrivers.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0) +
      inheritedWaiters.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0);

    return Math.max(0, allStartingAmounts - inheritedStartingAmounts);
  };

  const getCashierExpectedBreakdown = (
    summary: any,
    shift: any,
    opening: number,
    expensesTotal?: number,
  ) => {
    const calculationVersion = Number(shift?.calculation_version ?? 1);
    const sales = Number(summary?.breakdown?.instore?.cashTotal || 0);
    const cashRefunds = Number(summary?.cashRefunds || 0);
    const expenses = expensesTotal ?? Number(summary?.totalExpenses || 0);
    const cashDrops = Number(summary?.cashDrawer?.cash_drops || 0);
    const driverGiven = getCurrentCashierIssuedFloat(summary);
    const driverReturned = Number(summary?.cashDrawer?.driver_cash_returned || 0);
    const inheritedDriverExpectedReturns = getInheritedStaffExpectedReturns(summary);
    const staffPayments = Array.isArray(summary?.staffPayments) ? summary.staffPayments : [];
    const recordedStaffPayments = staffPayments.length > 0
      ? staffPayments.reduce((sum: number, payment: any) => sum + Number(payment?.amount || 0), 0)
      : Number(summary?.cashDrawer?.total_staff_payments || 0);
    const deductedStaffPayments = recordedStaffPayments;
    const expected =
      opening +
      sales -
      cashRefunds -
      expenses -
      deductedStaffPayments -
      cashDrops -
      driverGiven +
      driverReturned +
      inheritedDriverExpectedReturns;

    return {
      calculationVersion,
      opening,
      sales,
      cashRefunds,
      expenses,
      cashDrops,
      driverGiven,
      driverReturned,
      inheritedDriverExpectedReturns,
      recordedStaffPayments,
      deductedStaffPayments,
      expected,
    };
  };

  const getShiftHeaderMetrics = (summary: any, shift: any) => {
    const fallback = {
      totalAmount: Number(summary?.breakdown?.overall?.totalAmount ?? shift?.total_sales_amount ?? 0),
      totalCount: Number(summary?.breakdown?.overall?.totalCount ?? shift?.total_orders_count ?? 0),
    };

    if (!shift) {
      return fallback;
    }

    if (shift.role_type === 'driver') {
      const deliveries = Array.isArray(summary?.driverDeliveries) ? summary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((delivery: any) => {
        const status = String(delivery?.status || delivery?.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });

      return {
        totalAmount: completedDeliveries.reduce((sum: number, delivery: any) => sum + Number(delivery?.total_amount || 0), 0),
        totalCount: completedDeliveries.length,
      };
    }

    if (shift.role_type === 'server') {
      const tables = Array.isArray(summary?.waiterTables) ? summary.waiterTables : [];
      return {
        totalAmount: tables.reduce((sum: number, table: any) => sum + Number(table?.total_amount || 0), 0),
        totalCount: tables.reduce((sum: number, table: any) => sum + Number(table?.order_count || 0), 0),
      };
    }

    return fallback;
  };

  // UI state
  const [loading, setLoading] = useState(false);
  // Local override to switch to checkout when selecting a staff with active shift
  const [localMode, setLocalMode] = useState<'checkin' | 'checkout' | null>(null);
  const [checkoutShift, setCheckoutShift] = useState<any | null>(null);
  const effectiveMode = (localMode ?? mode);
  const effectiveShift = (checkoutShift ?? activeShift);
  const isNonFinancialCheckoutRole = isNonFinancialShiftRole(effectiveShift?.role_type);
  const isCashierCheckoutRole = effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager';
  const canRecordInlineExpenses =
    effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager';
  const isDriverRole = effectiveShift?.role_type === 'driver';
  const isCheckoutAmountMissing = effectiveMode === 'checkout' && (
    (isCashierCheckoutRole && !hasManualCashInput(closingCash)) ||
    (effectiveShift?.role_type === 'driver' && !hasManualCashInput(driverActualCash)) ||
    (effectiveShift?.role_type === 'server' && !hasManualCashInput(closingCash))
  );
  const prefersReducedMotion = useReducedMotion();
  const [contentDirection, setContentDirection] = useState<MotionDirection>(1);
  const [supportsHoverMotion, setSupportsHoverMotion] = useState(false);
  const isModalCloseBlocked = loading || showPaymentConfirm || confirmDialog.isOpen;
  const handleModalClose = () => {
    if (isModalCloseBlocked) {
      return;
    }
    onClose();
  };

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const updateHoverSupport = () => setSupportsHoverMotion(mediaQuery.matches);
    updateHoverSupport();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateHoverSupport);
      return () => mediaQuery.removeEventListener('change', updateHoverSupport);
    }

    mediaQuery.addListener(updateHoverSupport);
    return () => mediaQuery.removeListener(updateHoverSupport);
  }, []);

  // Progress Steps
  const progressSteps: Step[] = [
    {
      id: 'staff',
      label: t('common.actions.select'),
      status: (checkInStep === 'select-staff' ? 'active' : selectedStaff ? 'complete' : 'pending') as StepStatus
    },
    {
      id: 'pin',
      label: 'PIN',
      status: (checkInStep === 'enter-pin' ? 'active' : (selectedStaff && checkInStep !== 'select-staff') ? 'complete' : 'pending') as StepStatus
    },
    // Optional role step
    ...(checkInStep === 'select-role' || (selectedStaff && checkInStep === 'enter-cash' && effectiveMode === 'checkin')
      ? [{
        id: 'role',
        label: t('modals.staffShift.roleStepLabel', 'Role'),
        status: (checkInStep === 'select-role' ? 'active' : 'complete') as StepStatus
      }]
      : []),
    {
      id: 'action',
      label: effectiveMode === 'checkin' ? t('modals.staffShift.checkIn') : t('modals.staffShift.checkOut'),
      status: (checkInStep === 'enter-cash' || effectiveMode === 'checkout' ? 'active' : 'pending') as StepStatus
    }
  ];



  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showDetailedView, setShowDetailedView] = useState(false);
  const [showOrderDetailsTable, setShowOrderDetailsTable] = useState(true);

  // Checkout UI state
  const [showTableDetailsTable, setShowTableDetailsTable] = useState(false);
  const [showDetailedTableView, setShowDetailedTableView] = useState(false);
  const sortedAvailableStaff = React.useMemo(() => {
    return [...availableStaff].sort((a, b) => {
      const aName = (a?.name || `${a?.first_name ?? ''} ${a?.last_name ?? ''}` || 'Staff').trim();
      const bName = (b?.name || `${b?.first_name ?? ''} ${b?.last_name ?? ''}` || 'Staff').trim();
      return aName.localeCompare(bName);
    });
  }, [availableStaff]);
  const activeCheckInStaff = React.useMemo(
    () => sortedAvailableStaff.filter((member) => staffActiveShifts.has(member.id)),
    [sortedAvailableStaff, staffActiveShifts],
  );
  const readyCheckInStaff = React.useMemo(
    () => sortedAvailableStaff.filter((member) => !staffActiveShifts.has(member.id)),
    [sortedAvailableStaff, staffActiveShifts],
  );
  const selectedStaffRoles = React.useMemo(() => getStaffRoles(selectedStaff), [selectedStaff]);
  const selectedPrimaryRole = selectedStaffRoles[0];
  const cashierFirstGateActive = Boolean(checkInEligibility?.requiresCashierFirst);
  const selectedStaffHasCashierRole = React.useMemo(
    () =>
      selectedStaffRoles.some(
        (role) => (role.role_name || '').trim().toLowerCase() === 'cashier',
      ),
    [selectedStaffRoles],
  );
  const contentPaneKey =
    effectiveMode === 'checkin'
      ? `checkin-${checkInStep}`
      : `checkout-${effectiveShift?.id ?? localMode ?? mode}`;
  const checkInPaneVariants = {
    enter: (direction: MotionDirection) =>
      prefersReducedMotion
        ? {
            opacity: 0,
            transition: { duration: CHECKIN_MOTION.fast, ease: CHECKIN_MOTION_EASE },
          }
        : {
            opacity: 0,
            x: direction > 0 ? 26 : -26,
            scale: 0.994,
            transition: { duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE },
          },
    center: {
      opacity: 1,
      x: 0,
      scale: 1,
      transition: { duration: CHECKIN_MOTION.slow, ease: CHECKIN_MOTION_EASE },
    },
    exit: (direction: MotionDirection) =>
      prefersReducedMotion
        ? {
            opacity: 0,
            transition: { duration: CHECKIN_MOTION.fast, ease: CHECKIN_MOTION_EASE },
          }
        : {
            opacity: 0,
            x: direction > 0 ? -16 : 16,
            scale: 0.996,
            transition: { duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE },
          },
  };

  const navigateCheckInStep = React.useCallback(
    (nextStep: CheckInStep) => {
      setContentDirection(
        CHECKIN_STEP_ORDER[nextStep] >= CHECKIN_STEP_ORDER[checkInStep] ? 1 : -1,
      );
      setCheckInStep(nextStep);
    },
    [checkInStep],
  );

  const getInteractiveMotion = React.useCallback(
    (kind: 'card' | 'button' | 'primary' = 'card', disabled = false) => {
      if (disabled) {
        return {};
      }

      const whileHover =
        !prefersReducedMotion && supportsHoverMotion
          ? kind === 'card'
            ? {
                y: -3,
                scale: 1.004,
                transition: { duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE },
              }
            : kind === 'primary'
              ? {
                  y: -1.5,
                  scale: 1.008,
                  transition: { duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE },
                }
              : {
                  y: -1,
                  scale: 1.004,
                  transition: { duration: CHECKIN_MOTION.fast, ease: CHECKIN_MOTION_EASE },
                }
          : undefined;

      const whileTap = prefersReducedMotion
        ? {
            opacity: 0.96,
            transition: { duration: CHECKIN_MOTION.fast, ease: CHECKIN_MOTION_EASE },
          }
        : {
            scale: 0.985,
            transition: CHECKIN_MOTION.press,
          };

      return { whileHover, whileTap };
    },
    [prefersReducedMotion, supportsHoverMotion],
  );

  useEffect(() => {
    if (checkInStep === 'select-role' && selectedStaff) {
      console.log('[StaffShiftModal] Reached role selection step');
      console.log('[StaffShiftModal] selectedStaff:', selectedStaff);
      console.log('[StaffShiftModal] selectedStaff.roles:', selectedStaff.roles);
      console.log('[StaffShiftModal] selectedStaff.roles.length:', selectedStaff.roles?.length);
    }
  }, [checkInStep, selectedStaff]);
  const [shiftSummary, setShiftSummary] = useState<any | null>(null);
  const canPrintCheckoutSnapshot = React.useMemo(
    () =>
      effectiveMode === 'checkout' &&
      canPrintShiftCheckoutSnapshot({
        shift: effectiveShift,
        shiftSummary,
        closingCash,
        driverActualCash,
        isNonFinancialCheckoutRole,
      }),
    [
      effectiveMode,
      effectiveShift,
      shiftSummary,
      closingCash,
      driverActualCash,
      isNonFinancialCheckoutRole,
    ],
  );


  // Load staff when modal opens in checkin mode
  useEffect(() => {
    console.log('[StaffShiftModal] useEffect triggered:', { isOpen, mode });
    if (isOpen && mode === 'checkin') {
      console.log('[StaffShiftModal] Calling loadStaff()...');
      loadStaff();
      setContentDirection(1);
      setCheckInStep('select-staff');
      setSelectedStaff(null);
      setEnteredPin('');
      setRoleType('cashier');
      setOpeningCash('');
      setDriverStartingAmount(''); // Reset driver starting amount
      setCheckInEligibility(null);
      setShowZeroCashConfirm(false); // Reset zero cash confirmation
      // Reset any previous checkout override/session
      setLocalMode(null);
      setCheckoutShift(null);
      setShowExpenseForm(false);
      setClosingCash('');
      setStaffPayment('');
      setError('');
      setSuccess('');
    }
  }, [isOpen, mode]);

  // Load expenses and staff payments when in checkout mode (prop or local override)
  useEffect(() => {
    if (isOpen && effectiveMode === 'checkout' && effectiveShift) {
      loadExpenses(effectiveShift.id);
      // Load staff payments for cashiers
      if (effectiveShift.role_type === 'cashier') {
        loadStaffPayments(effectiveShift.id);
      }
      (async () => {
        try {
          // Skip driver earnings backfill on initial load - it's not critical for display
          // Backfill will run during actual checkout if needed
          const result = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: true });
          // shifts.getSummary returns the summary directly (with breakdown, shift, cash_drawer)
          const summary = result?.data || result;
          setShiftSummary(summary);
        } catch (e) {
          console.warn('Failed to load shift summary:', e);
          setShiftSummary(null);
        }
      })();
    } else {
      setShiftSummary(null);
      setStaffPaymentsList([]);
      setEditingStaffPaymentId(null);
      setDeletingStaffPaymentId(null);
    }
  }, [isOpen, effectiveMode, effectiveShift]);

  useEffect(() => {
    if (!canRecordInlineExpenses) {
      setShowExpenseForm(false);
    }
  }, [canRecordInlineExpenses]);

  // Load active shifts for each staff member to show status and sort
  const loadActiveShiftsForStaff = async (staffList: StaffMember[]) => {
    console.log('[loadActiveShiftsForStaff] Starting for', staffList.length, 'staff members');
    const map = new Map<string, any>();
    for (const s of staffList) {
      try {
        const result = await bridge.shifts.getActive(s.id);
        // IPC handlers wrap response in { success: true, data: ... }
        // So we need to check result.data, not just result
        const shift = result?.data || result;
        const hasActiveShift = shift && typeof shift === 'object' && shift.status === 'active';
        console.log('[loadActiveShiftsForStaff] Staff:', s.name, 'ID:', s.id, 'Result:', result, 'Shift:', hasActiveShift ? 'ACTIVE' : 'null');
        if (hasActiveShift) map.set(s.id, shift);
      } catch (e) {
        console.warn('[loadActiveShiftsForStaff] Failed to fetch active shift for', s.id, e);
      }
    }
    console.log('[loadActiveShiftsForStaff] Final map size:', map.size, 'Active staff IDs:', Array.from(map.keys()));
    setStaffActiveShifts(map);
  };

  const persistStaffAuthCache = async (branchId: string, staffList: StaffMember[]) => {
    const payload: StaffAuthCachePayload = {
      version: STAFF_AUTH_CACHE_VERSION,
      branch_id: branchId,
      synced_at: new Date().toISOString(),
      staff: staffList.map((member) => ({
        ...member,
        roles: member.roles ?? [],
        has_pin: typeof member.has_pin === 'boolean' ? member.has_pin : !!member.pin_hash,
        pin_hash: member.pin_hash ?? null,
      })),
    };

    await bridge.settings.updateLocal({
      category: STAFF_AUTH_CACHE_CATEGORY,
      settings: {
        [buildStaffAuthCacheKey(branchId)]: JSON.stringify(payload),
      },
    });
  };

  const loadCachedStaffAuth = async (branchId: string): Promise<StaffMember[]> => {
    const rawValue = await bridge.settings.get({
      category: STAFF_AUTH_CACHE_CATEGORY,
      key: buildStaffAuthCacheKey(branchId),
      defaultValue: '',
    });

    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as Partial<StaffAuthCachePayload> & { staff?: unknown[] };
      const cachedBranchId = typeof parsed.branch_id === 'string' ? parsed.branch_id.trim() : '';
      if (cachedBranchId && cachedBranchId !== branchId.trim()) {
        return [];
      }

      return (Array.isArray(parsed.staff) ? parsed.staff : [])
        .map(mapScheduledStaffToMember)
        .filter((member) => !!member.id);
    } catch (error) {
      console.warn('[StaffShiftModal] Failed to parse cached staff auth directory:', error);
      return [];
    }
  };

  const loadStaff = async () => {
    setLoading(true);
    setError('');
    setStaffAuthMetadataStatus('available');
    let branchId: string | undefined;
    try {
      // Determine branch for this terminal; prefer settings hook, then IPC
      // 1) Try hook-provided settings (fast path)
      branchId = getSetting?.('terminal', 'branch_id') as string | undefined;

      // 2) Try terminal config getter for a specific setting (existing, stable handler)
      if (!branchId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'branch_id');
          if (val) branchId = val as string;
        } catch (e) {
          console.warn('[StaffShiftModal] terminalConfig.getSetting fallback failed:', e);
        }
      }

      // 2b) Try local settings store (legacy SettingsService)
      if (!branchId) {
        try {
          const local = (await bridge.settings.get()) as unknown as SettingsResult;
          const flat = local?.['terminal.branch_id'] ?? local?.terminal?.branch_id;
          if (flat) branchId = flat as string;
        } catch (e) {
          console.warn('[StaffShiftModal] local get-settings fallback failed:', e);
        }
      }

      // 3) Try direct branch id getter
      if (!branchId) {
        try {
          const bid = await bridge.terminalConfig.getBranchId();
          if (bid) branchId = bid as string;
        } catch (e) {
          console.warn('[StaffShiftModal] terminalConfig.getBranchId failed (non-fatal):', e);
        }
      }

      // Require branch scoping: if missing, abort with clear message
      if (!branchId) {
        console.warn('[StaffShiftModal] No branchId available; aborting staff fetch');
        throw new Error('This POS is not assigned to a branch. Configure terminal → branch in Admin or POS settings.');
      }

      console.log('[loadStaff] Using branchId:', branchId);

      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      const result = await bridge.staffSchedule.list({
        start_date: dateStr,
        end_date: dateStr,
        branch_id: branchId,
      });

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to fetch staff schedule');
      }

      const payload = (result.data ?? {}) as {
        success?: boolean;
        staff?: any[];
        error?: string;
      };

      if (payload.success === false) {
        throw new Error(payload.error || 'Failed to fetch staff schedule');
      }

      const rawStaffList = Array.isArray(payload.staff) ? payload.staff : [];
      const authMetadataAvailable = includesStaffAuthMetadata(rawStaffList);

      let cachedStaffAuthById = new Map<string, StaffMember>();
      if (!authMetadataAvailable) {
        setStaffAuthMetadataStatus('missing');
        try {
          const cachedStaff = await loadCachedStaffAuth(branchId);
          cachedStaffAuthById = new Map(cachedStaff.map((member) => [member.id, member]));
        } catch (cacheError) {
          console.warn('[StaffShiftModal] Failed to load cached staff auth directory for merge:', cacheError);
        }
      }

      const normalizedStaffList: StaffMember[] = rawStaffList
        .map(mapScheduledStaffToMember)
        .map((member) => {
          if (authMetadataAvailable) {
            return member;
          }

          const cachedMember = cachedStaffAuthById.get(member.id);
          if (!cachedMember) {
            return member;
          }

          return {
            ...member,
            can_login_pos: cachedMember.can_login_pos,
            has_pin: typeof cachedMember.has_pin === 'boolean' ? cachedMember.has_pin : member.has_pin,
            pin_hash: cachedMember.pin_hash ?? member.pin_hash,
          };
        })
        .filter((staff) => !!staff.id);

      if (authMetadataAvailable) {
        try {
          await persistStaffAuthCache(branchId, normalizedStaffList);
        } catch (cacheError) {
          console.warn('[StaffShiftModal] Failed to persist staff auth cache:', cacheError);
        }
      } else {
        console.warn('[StaffShiftModal] Admin staff-schedule response is missing POS auth metadata; preserving existing local auth cache');
      }
      console.log('[loadStaff] Final staff list:', normalizedStaffList.map(s => ({ name: s.name, rolesCount: s.roles?.length })));

      // Create a new array reference to trigger React re-render
      setAvailableStaff([...normalizedStaffList]);
      try {
        await loadActiveShiftsForStaff(normalizedStaffList);
      } catch (e) {
        console.warn('Active shifts load failed', e);
      }
    } catch (err) {
      console.error('Failed to load staff:', err);
      if (branchId) {
        try {
          const cachedStaff = await loadCachedStaffAuth(branchId);
          if (cachedStaff.length > 0) {
            console.log('[StaffShiftModal] Loaded cached staff auth directory for offline check-in');
            setAvailableStaff([...cachedStaff]);
            setError('');
            try {
              await loadActiveShiftsForStaff(cachedStaff);
            } catch (activeShiftError) {
              console.warn('Active shifts load from cache failed', activeShiftError);
            }
            return;
          }
        } catch (cacheError) {
          console.warn('[StaffShiftModal] Failed to load cached staff auth directory:', cacheError);
        }
      }
      setError(err instanceof Error ? err.message : t('modals.staffShift.failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  const loadExpenses = async (shiftId?: string) => {
    const sid = shiftId ?? effectiveShift?.id;
    if (!sid) return;
    try {
      const result = await bridge.shifts.getExpenses(sid);
      const shiftExpenses = Array.isArray(result) ? result : [];
      setExpenses(shiftExpenses);
    } catch (err) {
      console.error('Failed to load expenses:', err);
      setExpenses([]);
    }
  };

  // Load staff payments recorded by this cashier shift
  const loadStaffPayments = async (shiftId?: string) => {
    const sid = shiftId ?? effectiveShift?.id;
    if (!sid) return;
    try {
      const payments = await bridge.shifts.getStaffPayments(sid);
      setStaffPaymentsList(payments || []);
    } catch (err) {
      console.error('Failed to load staff payments:', err);
      setStaffPaymentsList([]);
    }
  };

  const clearStaffPaymentDraft = () => {
    setEditingStaffPaymentId(null);
    setPaymentAmount('');
    setPaymentType('wage');
    setPaymentNotes('');
    setShowPaymentConfirm(false);
    setPendingPaymentAmount(0);
  };

  const refreshStaffPaymentStateAfterMutation = async (shiftId: string) => {
    await loadStaffPayments(shiftId);

    const shiftDate = effectiveShift?.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    if (selectedStaffForPayment?.id) {
      await loadPaymentHistoryForStaff(selectedStaffForPayment.id, shiftDate);
      const activeShiftForSelected = staffActiveShifts.get(selectedStaffForPayment.id);
      const selectedStaffMeta = availableStaff.find((member) => member.id === selectedStaffForPayment.id);
      await calculateExpectedPayment(activeShiftForSelected, selectedStaffMeta?.hourly_rate);
    }

    await refreshShiftSummaryAfterExpenseMutation(shiftId);
  };

  const beginEditStaffPayment = async (payment: StaffPayment) => {
    setShowStaffPaymentForm(true);
    setEditingStaffPaymentId(payment.id);
    setPaymentAmount(Number(payment.amount || 0).toFixed(2).replace('.', ','));
    setPaymentType(payment.payment_type);
    setPaymentNotes(payment.notes || '');

    const selectedMember = availableStaff.find((member) => member.id === payment.paid_to_staff_id);
    const selectedStaffId = payment.paid_to_staff_id || selectedMember?.id;
    if (!selectedStaffId) {
      return;
    }

    const selectedName = selectedMember?.name || payment.staff_name || t('common.unknown', 'Unknown');
    const selectedRole =
      selectedMember?.roles?.[0]?.role_name ||
      selectedMember?.role_name ||
      payment.role_type ||
      'staff';

    setSelectedStaffForPayment({
      id: selectedStaffId,
      name: selectedName,
      role: selectedRole,
    });

    const shiftDate = effectiveShift?.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    await loadPaymentHistoryForStaff(selectedStaffId, shiftDate);
    const activeShiftForSelected = staffActiveShifts.get(selectedStaffId);
    const hourlyRate = selectedMember?.hourly_rate;
    await calculateExpectedPayment(activeShiftForSelected, hourlyRate);
  };

  /**
   * Load payment history for the staff member being paid
   */
  /**
   * Load payment history for the staff member being paid.
   * Scoped to a specific date (defaults to today). 
   * @param staffId - ID of the staff member
   * @param dateStr - Date string (YYYY-MM-DD). If provided, this date is used. Otherwise defaults to today.
   */
  const loadPaymentHistoryForStaff = async (staffId: string, dateStr?: string) => {
    try {
      const targetDate = dateStr || toLocalDateString();
      const payments = await bridge.shifts.getStaffPaymentsByStaff({
        staffId,
        dateFrom: targetDate,
        dateTo: targetDate
      });
      setPaymentHistory(payments || []);

      // Calculate daily total
      const total = await bridge.shifts.getStaffPaymentTotalForDate(staffId, targetDate);
      setDailyPaymentTotal(total || 0);
    } catch (error) {
      console.error('Failed to load payment history:', error);
      setPaymentHistory([]);
      setDailyPaymentTotal(0);
    }
  };

  /**
   * Calculate expected payment based on staff hourly rate and active shift hours
   */
  /**
   * Calculate expected payment based on staff hourly rate and specified shift context.
   * Checks out time uses shift.check_out_time if available, otherwise current time.
   */
  const calculateExpectedPayment = async (shift: any, hourlyRate?: number) => {
    if (!hourlyRate || !shift) {
      setExpectedPayment(null);
      return;
    }

    try {
      if (shift && shift.check_in_time) {
        const checkInTime = new Date(shift.check_in_time);
        const checkOutTime = shift.check_out_time ? new Date(shift.check_out_time) : new Date(); // Use shift checkout or current time
        const hoursWorked = (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);

        const expected = hourlyRate * hoursWorked;
        setExpectedPayment(Math.round(expected * 100) / 100); // Round to 2 decimals
      } else {
        setExpectedPayment(null);
      }
    } catch (e) {
      console.warn('Failed to calculate expected payment:', e);
      setExpectedPayment(null);
    }
  };

  // Handle recording a staff payment
  // Perform the actual IPC call to record payment
  const performRecordStaffPayment = async () => {
    if (!effectiveShift || !selectedStaffForPayment) return;

    setLoading(true);
    setError('');

    try {
      const amount = parseMoneyInputValue(paymentAmount);
      const result = editingStaffPaymentId
        ? await bridge.shifts.updateStaffPayment({
            paymentId: editingStaffPaymentId,
            cashierShiftId: effectiveShift.id,
            paidToStaffId: selectedStaffForPayment.id,
            amount,
            paymentType,
            notes: paymentNotes || undefined,
          })
        : await bridge.shifts.recordStaffPayment({
            cashierShiftId: effectiveShift.id,
            paidToStaffId: selectedStaffForPayment.id,
            amount,
            paymentType,
            notes: paymentNotes || undefined,
          });

      if (result.success) {
        clearStaffPaymentDraft();
        await refreshStaffPaymentStateAfterMutation(effectiveShift.id);

        setSuccess(
          t(
            editingStaffPaymentId ? 'modals.staffShift.paymentUpdated' : 'modals.staffShift.paymentRecorded',
            editingStaffPaymentId ? 'Payment updated successfully' : 'Payment recorded successfully',
          ),
        );
        setTimeout(() => setSuccess(''), 3000);
      } else {
        setError(
          result.error ||
            t(
              editingStaffPaymentId ? 'modals.staffShift.paymentUpdateFailed' : 'modals.staffShift.paymentFailed',
              editingStaffPaymentId ? 'Failed to update payment' : 'Failed to record payment',
            ),
        );
        setShowPaymentConfirm(false); // Reset confirmation state on error
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              editingStaffPaymentId ? 'modals.staffShift.paymentUpdateFailed' : 'modals.staffShift.paymentFailed',
              editingStaffPaymentId ? 'Failed to update payment' : 'Failed to record payment',
            ),
      );
      setShowPaymentConfirm(false); // Reset confirmation state on error
    } finally {
      setLoading(false);
    }
  };

  // Handle recording a staff payment - Validator and Initiator
  const handleRecordStaffPayment = async () => {
    if (!effectiveShift || !staff || !selectedStaffForPayment) {
      setError(t('modals.staffShift.noStaffSelected'));
      return;
    }

    const amount = parseMoneyInputValue(paymentAmount);
    if (amount <= 0) {
      setError(t('modals.staffShift.invalidStaffPayment'));
      return;
    }

    // Check for large payment threshold
    if (amount > LARGE_PAYMENT_THRESHOLD && !showPaymentConfirm) {
      setPendingPaymentAmount(amount);
      setShowPaymentConfirm(true);
      return;
    }

    // If we're here, either it's a small payment or confirmed check is handled elsewhere (logic refactored)
    // Actually, confirm handler calls perform, so here we just call perform if not large.
    await performRecordStaffPayment();
  };

  const handleConfirmLargePayment = () => {
    setShowPaymentConfirm(false);
    performRecordStaffPayment();
  };

  const handleCancelLargePayment = () => {
    setShowPaymentConfirm(false);
    setPendingPaymentAmount(0);
  };

  const resetStaffPaymentForm = () => {
    setShowStaffPaymentForm(false);
    setEditingStaffPaymentId(null);
    setSelectedStaffForPayment(null);
    setPaymentAmount('');
    setPaymentType('wage');
    setPaymentNotes('');
    setPaymentHistory([]);
    setDailyPaymentTotal(0);
    setExpectedPayment(null);
  };

  const openStaffPaymentForm = async () => {
    setShowStaffPaymentForm(true);
    setEditingStaffPaymentId(null);

    if (!isCashierCheckoutRole || !effectiveShift) {
      return;
    }

    const currentCashierStaffId =
      effectiveShift.staff_id ||
      staff?.databaseStaffId ||
      staff?.staffId;
    const currentCashier = availableStaff.find((member) => member.id === currentCashierStaffId);

    if (!currentCashier) {
      return;
    }

    setSelectedStaffForPayment({
      id: currentCashier.id,
      name: currentCashier.name,
      role: currentCashier.roles?.[0]?.role_name || currentCashier.role_name || effectiveShift.role_type,
    });

    const shiftDate = effectiveShift.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    await loadPaymentHistoryForStaff(currentCashier.id, shiftDate);
    const activeShiftForSelected = staffActiveShifts.get(currentCashier.id);
    await calculateExpectedPayment(activeShiftForSelected, currentCashier.hourly_rate);
  };

  const handleDeleteStaffPayment = async (payment: StaffPayment) => {
    if (!effectiveShift) {
      return;
    }

    setDeletingStaffPaymentId(payment.id);
    setError('');

    try {
      const result = await bridge.shifts.deleteStaffPayment({
        paymentId: payment.id,
        cashierShiftId: effectiveShift.id,
      });

      if (!result.success) {
        throw new Error(
          result.error ||
            t('modals.staffShift.paymentDeleteFailed', 'Failed to delete payment'),
        );
      }

      if (editingStaffPaymentId === payment.id) {
        clearStaffPaymentDraft();
      }

      await refreshStaffPaymentStateAfterMutation(effectiveShift.id);
      setSuccess(
        t(
          'modals.staffShift.paymentDeleted',
          'Payment deleted and checkout totals recalculated',
        ),
      );
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('modals.staffShift.paymentDeleteFailed', 'Failed to delete payment');
      if (message === 'Staff payment not found') {
        if (editingStaffPaymentId === payment.id) {
          clearStaffPaymentDraft();
        }
        await refreshStaffPaymentStateAfterMutation(effectiveShift.id);
      } else {
        setError(message);
      }
    } finally {
      setDeletingStaffPaymentId(null);
      closeConfirm();
    }
  };

  const handleStaffSelect = async (staffMember: StaffMember) => {
    setSelectedStaff(staffMember);
    setEnteredPin('');
    setError('');
    setCheckInEligibility(null);

    // If this staff already has an active shift, jump to checkout view for that shift
    const existingShift = staffActiveShifts.get(staffMember.id);
    if (existingShift) {
      setContentDirection(1);
      setLocalMode('checkout');
      setCheckoutShift(existingShift);
      setShowExpenseForm(false);
      setClosingCash('');
      await loadExpenses(existingShift.id);
      return;
    }

    // Otherwise continue the normal check-in flow
    navigateCheckInStep('enter-pin');
  };

  const getCheckInPinErrorMessage = (
    result: { reasonCode?: unknown; error?: unknown } | undefined,
  ): string => {
    const reasonCode = typeof result?.reasonCode === 'string' ? result.reasonCode : '';
    switch (reasonCode) {
      case 'invalid_pin':
        return t('modals.staffShift.invalidPIN');
      case 'pin_not_configured':
        return t(
          'modals.staffShift.pinNotConfigured',
          'No POS PIN is configured for this staff member. Please set it in Admin first.',
        );
      case 'pos_login_disabled':
        return t(
          'modals.staffShift.posLoginDisabled',
          'This staff member is not allowed to log in on POS.',
        );
      case 'staff_auth_unavailable':
      case 'staff_not_available_offline':
        return t(
          'modals.staffShift.staffAuthUnavailable',
          'Staff auth data is not available offline yet. Open the staff list while online first.',
        );
      default:
        return String(result?.error || t('modals.staffShift.verifyPinFailed'));
    }
  };

  const verifyLegacyAdminStaffPinOnline = async (
    staffId: string,
    pin: string,
  ): Promise<{ success: boolean; reasonCode?: string; error?: string }> => {
    try {
      const statusResult = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/staff-schedule/clock?staff_id=${encodeURIComponent(staffId)}`,
      );

      if (!statusResult?.success) {
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: String(statusResult?.error || 'Failed to read legacy staff clock status'),
        };
      }

      const statusPayload = statusResult.data as {
        success?: boolean;
        clockStatus?: { isClockedIn?: boolean | null } | null;
      } | undefined;

      if (statusPayload?.success === false) {
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: 'Failed to read legacy staff clock status',
        };
      }

      const isClockedIn = statusPayload?.clockStatus?.isClockedIn === true;
      const probeAction: 'clock_in' | 'clock_out' = isClockedIn ? 'clock_in' : 'clock_out';

      const probeResult = await bridge.staffSchedule.clock({
        staff_id: staffId,
        action: probeAction,
        pin,
        notes: 'legacy_auth_probe',
      });

      if (probeResult?.success) {
        console.warn('[StaffShiftModal] Legacy staff PIN probe unexpectedly succeeded with side effects', {
          staffId,
          probeAction,
        });
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: 'Legacy Admin PIN verification mutated remote shift state unexpectedly.',
        };
      }

      const errorText = typeof probeResult?.error === 'string' ? probeResult.error : '';
      const normalizedError = normalizeLegacyProbeError(errorText);

      if (
        (!isClockedIn && normalizedError.includes('no active shift found to clock out')) ||
        (isClockedIn && normalizedError.includes('already clocked in'))
      ) {
        return { success: true };
      }

      if (normalizedError.includes('invalid pin') || normalizedError.includes('pin is required')) {
        return {
          success: false,
          reasonCode: 'invalid_pin',
          error: errorText || 'Invalid PIN',
        };
      }

      if (normalizedError.includes('staff member not found')) {
        return {
          success: false,
          reasonCode: 'staff_not_available_offline',
          error: errorText || 'Staff member not found',
        };
      }

      return {
        success: false,
        reasonCode: 'staff_auth_unavailable',
        error: errorText || 'Legacy Admin PIN verification failed',
      };
    } catch (error) {
      return {
        success: false,
        reasonCode: 'staff_auth_unavailable',
        error: extractErrorMessage(error, 'Legacy Admin PIN verification failed'),
      };
    }
  };

  const loadCheckInEligibility = async (
    branchId?: string,
    terminalId?: string,
  ): Promise<ShiftCheckInEligibility | null> => {
    if (!branchId || !terminalId) {
      return null;
    }

    try {
      return await bridge.shifts.getCheckInEligibility(branchId, terminalId);
    } catch (eligibilityError) {
      console.warn('[StaffShiftModal] Failed to load check-in eligibility:', eligibilityError);
      return null;
    }
  };

  const finishPinVerification = async (
    branchId: string,
    terminalId: string | undefined,
    staffRole: StaffShiftRole,
  ) => {
    const eligibility = await loadCheckInEligibility(branchId, terminalId);
    setCheckInEligibility(eligibility);
    setRoleType(staffRole);
    navigateCheckInStep('select-role');
    setError('');
  };

  const handlePinSubmit = async () => {
    if (!selectedStaff) return;

    setLoading(true);
    setError('');

    try {
      // Resolve terminal/branch from settings or bridge
      let branchId: string | undefined = getSetting?.('terminal', 'branch_id') as string | undefined;
      let terminalId: string | undefined = getSetting?.('terminal', 'terminal_id') as string | undefined;
      if (!branchId || !terminalId) {
        try {
          const local = (await bridge.settings.get()) as unknown as SettingsResult;
          branchId = branchId || ((local?.['terminal.branch_id'] as string | undefined) ?? local?.terminal?.branch_id);
          terminalId = terminalId || ((local?.['terminal.terminal_id'] as string | undefined) ?? local?.terminal?.terminal_id);
        } catch { }
      }
      if (!branchId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'branch_id');
          if (val) branchId = val as string;
        } catch { }
      }
      // Extra fallback: dedicated branch id getter
      if (!branchId) {
        try {
          const bid = await bridge.terminalConfig.getBranchId();
          if (bid) branchId = bid as string;
        } catch { }
      }
      if (!terminalId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'terminal_id');
          if (val) terminalId = val as string;
        } catch { }
      }

      // Validate branchId before attempting check-in
      if (!branchId || (typeof branchId === 'string' && branchId.trim() === '')) {
        console.error('[StaffShiftModal] Cannot check in: branchId is not configured');
        setError(t('modals.staffShift.errors.noBranchConfigured', 'Branch not configured. Please contact admin.'));
        setEnteredPin('');
        return;
      }

      if (staffAuthMetadataStatus === 'missing' && !selectedStaff.pin_hash) {
        const legacyProbe = await verifyLegacyAdminStaffPinOnline(
          selectedStaff.id,
          enteredPin.trim(),
        );

        if (legacyProbe.success) {
          const staffRole = selectedStaff.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
          await finishPinVerification(branchId, terminalId, staffRole);
          return;
        }

        const errorMessage =
          legacyProbe.reasonCode === 'staff_auth_unavailable'
            ? t(
                'modals.staffShift.staffAuthServerUpgradeRequired',
                'This POS is connected to an older Admin deployment that does not send staff PIN auth data yet. Deploy the latest Admin and reopen POS.',
              )
            : getCheckInPinErrorMessage(legacyProbe);

        setError(errorMessage);
        setEnteredPin('');
        return;
      }

      try {
        console.log('[StaffShiftModal] PIN submit - IPC call with', { staffId: selectedStaff?.id, branchId, terminalId });
        const authRes = await bridge.staffAuth.verifyCheckInPin({
          staffId: selectedStaff.id,
          branchId,
          pin: enteredPin.trim(),
        });
        const normalizedAuth = authRes;
        const authSucceeded = normalizedAuth?.success === true;

        console.log('[StaffShiftModal] PIN IPC normalized auth', {
          authSucceeded,
          reasonCode: normalizedAuth?.reasonCode,
          error: normalizedAuth?.error
        });

        if (authSucceeded) {
          const staffRole = selectedStaff.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
          await finishPinVerification(branchId, terminalId, staffRole);
          return; // done
        }

        if (normalizedAuth && normalizedAuth.success === false) {
          setError(getCheckInPinErrorMessage(normalizedAuth));
          setEnteredPin('');
          return;
        }

        console.log('IPC PIN auth returned unexpected payload:', authRes);
        setError(t('modals.staffShift.verifyPinFailed'));
        setEnteredPin('');
        return;
      } catch (e) {
        const errorMessage = extractErrorMessage(e, t('modals.staffShift.verifyPinFailed'));
        console.warn('IPC PIN auth error:', errorMessage);
        if (errorMessage.toLowerCase().includes('invalid pin') || errorMessage.toLowerCase().includes('pin is required')) {
          setError(t('modals.staffShift.invalidPIN'));
        } else {
          setError(errorMessage);
        }
        setEnteredPin('');
        return;
      }
    } catch (err) {
      console.error('PIN verification error:', err);
      setError(t('modals.staffShift.verifyPinFailed'));
      setEnteredPin('');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleSelect = async (role: StaffShiftRole) => {
    if (cashierFirstGateActive && role !== 'cashier') {
      setError(
        t(
          'modals.staffShift.cashierFirstCheckInRequired',
          'The first check-in for this business day must be a cashier.',
        ),
      );
      return;
    }

    setRoleType(role);
    setError('');
    setSuccess('');
    setShowZeroCashConfirm(false);

    // For staff that return cash, pre-check if there's an active cashier.
    if (role === 'driver' || role === 'server') {
      try {
        const branchId = getSetting?.('terminal', 'branch_id') as string | undefined;
        const terminalId = getSetting?.('terminal', 'terminal_id') as string | undefined;
        if (branchId && terminalId) {
          const cashier = await bridge.shifts.getActiveCashierByTerminal(branchId, terminalId);
          setActiveCashierExists(!!cashier);
        }
      } catch (e) {
        console.warn('Failed to check active cashier:', e);
        setActiveCashierExists(true); // Default to true on error
      }
    }

    if (role === 'cashier' || role === 'driver' || role === 'server') {
      navigateCheckInStep('enter-cash');
    } else {
      // For other roles, proceed directly to check-in
      void handleCheckIn(false, role);
    }
  };

  const handleCheckIn = async (bypassZeroConfirm = false, roleOverride?: StaffShiftRole) => {
    if (!selectedStaff || !staff) {
      setError(t('modals.staffShift.noStaffSelected'));
      return;
    }

    const selectedRoleType = roleOverride ?? roleType;

    // Driver-specific validation: cannot take starting cash without active cashier
    const driverAmount = parseMoneyInputValue(driverStartingAmount);
    if (selectedRoleType === 'driver' && driverAmount > 0 && !activeCashierExists) {
      setError(t('modals.staffShift.noCashierForDriverCash', 'No active cashier. You cannot take starting cash without a cashier present.'));
      return;
    }

    // Soft guard: cashiers starting with zero opening cash need confirmation
    if (selectedRoleType === 'cashier' && !bypassZeroConfirm) {
      const trimmedOpening = openingCash.trim();
      const parsedOpening = parseMoneyInputValue(trimmedOpening);
      if (!isNaN(parsedOpening) && parsedOpening === 0) {
        setShowZeroCashConfirm(true);
        return;
      }
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Resolve terminal + branch from TerminalConfig first (avoid stale 'local-branch')
      let resolvedTerminalId = staff.terminalId;
      let resolvedBranchId = staff.branchId;
      let resolvedOrganizationId = normalizeContextId(staff.organizationId);
      try { resolvedTerminalId = (await bridge.terminalConfig.getTerminalId()) || resolvedTerminalId; } catch { }
      try { resolvedBranchId = (await bridge.terminalConfig.getBranchId()) || resolvedBranchId; } catch { }
      try {
        resolvedOrganizationId = normalizeContextId(await bridge.terminalConfig.getOrganizationId()) || resolvedOrganizationId;
      } catch { }
      if (!resolvedOrganizationId) {
        try {
          resolvedOrganizationId =
            normalizeContextId(await bridge.terminalConfig.getSetting('terminal', 'organization_id')) ||
            resolvedOrganizationId;
        } catch { }
      }
      if (!resolvedOrganizationId) {
        resolvedOrganizationId = normalizeContextId(getSetting?.('terminal', 'organization_id'));
      }

      // Cashiers must manually count and enter opening amount - no automatic comparison with previous day
      // Validate that cashiers have entered a valid opening cash amount
      if (selectedRoleType === 'cashier') {
        const trimmedOpening = openingCash.trim();
        const parsedOpening = parseMoneyInputValue(trimmedOpening);

        // Validation: must not be empty and must be a valid number >= 0
        // Allow explicit "0" as valid (differentiate from empty string)
        if (trimmedOpening === '' || isNaN(parsedOpening) || parsedOpening < 0) {
          setError(t('modals.staffShift.invalidOpeningCash'));
          setLoading(false);
          return;
        }
      }

      // For staff that return cash, validate starting amount if provided (optional, can be 0 or empty)
      if (selectedRoleType === 'driver' || selectedRoleType === 'server') {
        const trimmedStarting = driverStartingAmount.trim();
        if (trimmedStarting !== '') {
          const parsedStarting = parseMoneyInputValue(trimmedStarting);
          if (isNaN(parsedStarting) || parsedStarting < 0) {
            setError(t('modals.staffShift.invalidStartingAmount', 'Invalid starting amount'));
            setLoading(false);
            return;
          }
        }
      }

      // Determine the opening/starting amount based on role type
      // Cashiers: openingCash represents drawer count
      // Drivers: startingAmount represents cash taken from cashier (separate field for clarity)
      // Other roles: no cash amount needed
      let usedOpeningCash = 0;
      let usedStartingAmount: number | undefined;

      if (selectedRoleType === 'cashier') {
        usedOpeningCash = parseMoneyInputValue(openingCash);
      } else if (selectedRoleType === 'driver' || selectedRoleType === 'server') {
        // Use dedicated startingAmount field for drivers
        usedStartingAmount = parseMoneyInputValue(driverStartingAmount);
      }
      // Other roles: both remain undefined

      const result = await bridge.shifts.open({
        staffId: selectedStaff.id,
        staffName: selectedStaff.name,
        branchId: resolvedBranchId,
        terminalId: resolvedTerminalId,
        roleType: selectedRoleType,
        // Send only the relevant cash field per role so the Rust or_else
        // chain doesn't short-circuit on openingCash:0 for drivers.
        ...(selectedRoleType === 'driver' || selectedRoleType === 'server'
          ? { startingAmount: usedStartingAmount }
          : { openingCash: usedOpeningCash }),
      }) as unknown as ShiftIpcResult;

      if (result.success) {
        const shiftId = result?.shiftId || result?.data?.shiftId || result?.data?.id;
        setSuccess(t('modals.staffShift.shiftStarted'));
        // Update the global shift context to the checked-in staff so guards lift
        setStaff({
          staffId: selectedStaff.id,
          name: selectedStaff.name,
          role: selectedRoleType,
          branchId: resolvedBranchId,
          terminalId: resolvedTerminalId,
          organizationId: resolvedOrganizationId,
        });
        // Optimistically mark shift active immediately with a minimal stub, so UI unlocks at once
        try {
          if (shiftId) {
            // opening_cash_amount: for cashiers this is the drawer count, for drivers this is their starting amount
            const effectiveOpeningAmount = selectedRoleType === 'driver' || selectedRoleType === 'server'
              ? (usedStartingAmount ?? 0)
              : usedOpeningCash;
            setActiveShiftImmediate({
              id: String(shiftId),
              staff_id: selectedStaff.id,
              branch_id: resolvedBranchId,
              terminal_id: resolvedTerminalId,
              role_type: selectedRoleType,
              check_in_time: new Date().toISOString(),
              opening_cash_amount: effectiveOpeningAmount,
              status: 'active',
              total_orders_count: 0,
              total_sales_amount: 0,
              total_cash_sales: 0,
              total_card_sales: 0,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
        } catch { }
        // Also fetch from DB to sync full shift details
        try {
          await refreshActiveShift(selectedStaff.id);
        } catch (e) {
          console.warn('[StaffShiftModal] refreshActiveShift failed:', e);
        }
        setTimeout(() => {
          onClose();
        }, 300);
      } else {
        setError(result.error || t('modals.staffShift.openShiftFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.staffShift.openShiftFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async (bypassZeroConfirm = false) => {
    console.log('🔴 handleCheckOut called');
    console.log('effectiveShift:', effectiveShift);
    console.log('staff:', staff);
    console.log('closingCash:', closingCash);
    console.log('staffPayment:', staffPayment);

    if (!effectiveShift || !staff) {
      console.log('❌ No active shift or staff found');
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    let closingAmount = 0;

    // For drivers: use calculated amount to return
    if (effectiveShift?.role_type === 'driver') {
      // Driver payments are now centralized at cashier checkout
      // Driver checkout simply returns all cash without payment deduction
      const driverPayment = 0;
      console.log('driverPayment (centralized at cashier):', driverPayment);

      // For driver checkout, refresh summary WITH backfill to ensure all earnings are recorded
      // This is critical for accurate variance calculation
      let freshSummary = shiftSummary;
      try {
        const summaryResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: false });
        freshSummary = summaryResult?.data || summaryResult;
        setShiftSummary(freshSummary);
      } catch (e) {
        console.warn('Failed to refresh shift summary with backfill:', e);
        // Continue with existing summary if refresh fails
      }

      // Calculate cash to return using the specified formula:
      // cashToReturn = openingCash + totalCashCollected - totalExpenses - driverPayment
      // Filter out canceled orders before calculating
      const openingCash = getEffectiveOpeningAmount(effectiveShift, freshSummary);
      const deliveries = freshSummary?.driverDeliveries || [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const totalCashCollected = completedDeliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;
      const expectedReturn = openingCash + totalCashCollected - totalExpenses - driverPayment;

      if (!hasManualCashInput(driverActualCash)) {
        setError(t('modals.staffShift.actualCashReturnedRequired', {
          defaultValue: 'Enter the actual cash returned before checkout.',
        }));
        return;
      }

      const actual = parseMoneyInputValue(driverActualCash);
      if (actual < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
      closingAmount = actual;

      console.log('Driver closingAmount:', {
        totalDeliveries: deliveries.length,
        completedDeliveries: completedDeliveries.length,
        canceledDeliveries: deliveries.length - completedDeliveries.length,
        openingCash,
        totalCashCollected,
        totalExpenses,
        driverPayment,
        expectedReturn,
        actualEntered: driverActualCash,
        closingAmount,
        variance: closingAmount - expectedReturn,
      });
    }
    // Cashier checkout
    else if (effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager') {
      // Cashier: Calculate Expected but use Actual from input
      const openingCash = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const expectedAmount = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        openingCash,
        shiftSummary?.totalExpenses || 0
      ).expected;

      if (!hasManualCashInput(closingCash)) {
        setError(t('modals.staffShift.countedCashRequired', {
          defaultValue: 'Enter the counted cash before checkout.',
        }));
        return;
      }

      const actualAmount = parseMoneyInputValue(closingCash);

      if (actualAmount < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }

      closingAmount = actualAmount;
      console.log('Cashier Checkout:', { expected: expectedAmount, actual: closingAmount, variance: closingAmount - expectedAmount });
    }
    // Comment 1: Waiter Checkout Logic
    // Waiter payments are now centralized at cashier checkout
    else if (effectiveShift?.role_type === 'server') {
      // Waiter payments are handled at cashier checkout
      // Waiter checkout simply returns all cash without payment deduction
      const waiterPayment = 0;

      // Refresh summary to ensure latest data
      let freshSummary = shiftSummary;
      try {
        const sResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: true });
        const s = sResult?.data || sResult;
        if (s) {
          freshSummary = s;
          setShiftSummary(s);
        }
      } catch (e) { console.warn('Refresh failed', e); }

      const openingCash = getEffectiveOpeningAmount(effectiveShift, freshSummary);
      const waiterTables = freshSummary?.waiterTables || [];
      const cashCollected = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;

      // Formula: Cash to Return = Starting Amount + Cash Collected - Expenses - Payments
      const expectedReturn = openingCash + cashCollected - totalExpenses - waiterPayment;

      if (!hasManualCashInput(closingCash)) {
        setError(t('modals.staffShift.actualCashReturnedRequired', {
          defaultValue: 'Enter the actual cash returned before checkout.',
        }));
        return;
      }

      const actual = parseMoneyInputValue(closingCash);
      if (actual < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
      closingAmount = actual;

      console.log('Server closingAmount calculated:', {
        expectedReturn,
        actualEntered: closingCash,
        closingAmount,
        variance: closingAmount - expectedReturn,
      });
    }
    else if (isNonFinancialCheckoutRole) {
      closingAmount = 0;
      console.log('Non-financial role closingAmount (no cash drawer):', closingAmount);
    }
    // Other roles (fallback): use manually entered closing cash
    else {
      closingAmount = parseMoneyInputValue(closingCash);
      console.log('closingAmount:', closingAmount);
      if (closingAmount < 0) {
        console.log('❌ Invalid closing amount');
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
    }

    // Zero Amount Confirmation
    if (closingAmount === 0 && !bypassZeroConfirm && !isNonFinancialCheckoutRole) {
      openConfirm({
        title: t('modals.staffShift.confirmZeroTitle', 'Confirm Zero Closing Cash'),
        message: t('modals.staffShift.confirmZeroMessage', 'Are you sure you want to close the shift with $0.00 closing cash?'),
        variant: 'warning',
        onConfirm: () => { closeConfirm(); handleCheckOut(true); }
      });
      return;
    }

    console.log('✅ All checks passed, calling closeShift via bridge...');
    setLoading(true);
    setError('');
    setSuccess('');
    setCheckoutPaymentBlockers([]);

    try {
      // For drivers, include the payment amount in the closeShift call
      const isDriver = effectiveShift.role_type === 'driver';
      const driverPaymentAmount = isDriver ? parseMoneyInputValue(staffPayment) : undefined;
      const closedBy =
        staff.databaseStaffId ||
        (isUuidValue(staff.staffId) ? staff.staffId.trim() : undefined);

      const result = await bridge.shifts.close({
        shiftId: effectiveShift.id,
        closingCash: closingAmount,
        closedBy,
        paymentAmount: isDriver ? driverPaymentAmount : undefined
      }) as unknown as ShiftIpcResult;
      console.log('closeShift result:', result);

      if (result.success) {
        setCheckoutPaymentBlockers([]);
        const variance = result?.variance ?? result?.data?.variance ?? 0;
        const varianceText = variance >= 0
          ? `Overage: €${variance.toFixed(2)}`
          : `Shortage: €${Math.abs(variance).toFixed(2)}`;
        // Check for cashier logic to populate items
        const isCashier = effectiveShift.role_type === 'cashier';
        if (isCashier) {
          const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
          const breakdown = getCashierExpectedBreakdown(
            shiftSummary,
            effectiveShift,
            opening,
            shiftSummary?.totalExpenses || 0
          );
          const actual = closingAmount;

          setLastShiftResult({
            variance, // Use backend variance directly
            breakdown: {
              calculationVersion: breakdown.calculationVersion,
              opening: breakdown.opening,
              sales: breakdown.sales,
              cashRefunds: breakdown.cashRefunds,
              expenses: breakdown.expenses,
              cashDrops: breakdown.cashDrops,
              driverGiven: breakdown.driverGiven,
              driverReturned: breakdown.driverReturned,
              inheritedDriverExpectedReturns: breakdown.inheritedDriverExpectedReturns,
              recordedStaffPayments: breakdown.recordedStaffPayments,
              deductedStaffPayments: breakdown.deductedStaffPayments,
              expected: breakdown.expected,
              actual
            }
          });
        } else {
          setLastShiftResult({ variance, breakdown: undefined });
        }

        setSuccess(t('modals.staffShift.shiftClosedSuccess', 'Shift closed successfully!'));

        // Print staff check-out receipt (role-specific)
        try {
          console.log('[StaffShiftModal] Printing checkout for shift:', effectiveShift.id, 'role:', effectiveShift.role_type);
          const printResult = await queueShiftCheckoutPrint({
            bridge,
            shiftId: effectiveShift.id,
            roleType: effectiveShift.role_type,
          }) as ShiftPrintCheckoutResult;
          console.log('[StaffShiftModal] Print checkout result:', printResult);
          if (!printResult?.success) {
            console.warn('[StaffShiftModal] Checkout print failed:', printResult?.error);
          }
        } catch (printErr) {
          console.error('[StaffShiftModal] Staff checkout print error:', printErr);
        }

        await refreshActiveShift();
        setTimeout(() => {
          onClose();
        }, 2000);
      } else {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(result);
        setCheckoutPaymentBlockers(paymentIntegrityPayload?.blockers || []);
        setError(result.error || t('modals.staffShift.closeShiftFailed'));
      }
    } catch (err) {
      const paymentIntegrityPayload = extractPaymentIntegrityPayload(err);
      setCheckoutPaymentBlockers(paymentIntegrityPayload?.blockers || []);
      setError(err instanceof Error ? err.message : t('modals.staffShift.closeShiftFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handlePrintCheckout = async () => {
    if (!effectiveShift) {
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: effectiveShift,
      shiftSummary,
      closingCash,
      driverActualCash,
      isNonFinancialCheckoutRole,
      snapshotCheckOutTime: new Date().toISOString(),
    });

    if (!snapshot) {
      setError(
        t('modals.staffShift.checkoutPrintUnavailable', {
          defaultValue: 'Complete the checkout inputs before printing.',
        }),
      );
      return;
    }

    setIsPrintCheckoutLoading(true);
    setError('');
    setSuccess('');

    try {
      const printResult = await queueShiftCheckoutPrint({
        bridge,
        shiftId: effectiveShift.id,
        roleType: effectiveShift.role_type,
        snapshot,
      }) as ShiftPrintCheckoutResult;

      if (printResult?.success) {
        setSuccess(
          printResult?.skipped
            ? t('modals.staffShift.checkoutPrintSkipped', {
                defaultValue: 'Checkout printing is disabled for this terminal.',
              })
            : t('modals.staffShift.checkoutPrintQueued', {
                defaultValue: 'Checkout print queued.',
              }),
        );
      } else {
        setError(
          printResult?.error ||
            t('modals.staffShift.checkoutPrintFailed', {
              defaultValue: 'Failed to print checkout summary.',
            }),
        );
      }
    } catch (err) {
      setError(
        extractErrorMessage(
          err,
          t('modals.staffShift.checkoutPrintFailed', {
            defaultValue: 'Failed to print checkout summary.',
          }),
        ),
      );
    } finally {
      setIsPrintCheckoutLoading(false);
    }
  };

  const handleRecordExpense = async () => {
    if (!effectiveShift || !staff) {
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    if (!canRecordInlineExpenses) {
      setError(
        t('modals.staffShift.cashierExpenseOnly', {
          defaultValue: 'Expenses can only be recorded from cashier checkout',
        }),
      );
      return;
    }

    const amount = parseMoneyInputValue(expenseAmount);
    if (amount <= 0) {
      setError(t('modals.expense.invalidAmount'));
      return;
    }

    if (!expenseDescription.trim()) {
      setError(
        t('modals.expense.justificationRequired', {
          defaultValue: 'A clear justification is required before saving.',
        }),
      );
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await bridge.shifts.recordExpense({
        shiftId: effectiveShift.id,
        expenseType,
        amount,
        description: expenseDescription,
        receiptNumber: expenseReceipt || undefined
      });

      if (result.success) {
        setSuccess(
          t('modals.expense.expenseRecorded', {
            defaultValue: 'Expense charged to the active cashier drawer',
          }),
        );
        setExpenseAmount('');
        setExpenseDescription('');
        setExpenseReceipt('');
        setShowExpenseForm(false);
        await loadExpenses();
        await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
        setTimeout(() => setSuccess(''), 2000);
      } else {
        setError(result.error || t('modals.staffShift.recordExpenseFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.staffShift.recordExpenseFailed'));
    } finally {
      setLoading(false);
    }
  };

  const refreshShiftSummaryAfterExpenseMutation = async (shiftId: string) => {
    try {
      const summaryResult = await bridge.shifts.getSummary(shiftId, { skipBackfill: true });
      setShiftSummary(summaryResult?.data || summaryResult);
    } catch (error) {
      console.warn('Failed to refresh shift summary after expense mutation:', error);
    }
  };

  const handleDeleteExpense = async (expense: ShiftExpense) => {
    if (!effectiveShift?.id) {
      closeConfirm();
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    setLoading(true);
    setDeletingExpenseId(expense.id);
    setError('');

    try {
      const result = await bridge.shifts.deleteExpense({
        expenseId: expense.id,
        shiftId: effectiveShift.id,
      });

      if (!result?.success) {
        throw new Error(
          result?.error ||
            t('modals.expense.expenseDeleteFailed', {
              defaultValue: 'Failed to delete expense',
            }),
        );
      }

      await loadExpenses(effectiveShift.id);
      await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
      setSuccess(
        t('modals.expense.expenseDeleted', {
          defaultValue: 'Expense deleted',
        }),
      );
      setTimeout(() => setSuccess(''), 2000);
      closeConfirm();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('modals.expense.expenseDeleteFailed', {
              defaultValue: 'Failed to delete expense',
            });

      if (message === 'Expense not found') {
        await loadExpenses(effectiveShift.id);
        await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
        closeConfirm();
      } else {
        setError(message);
        closeConfirm();
      }
    } finally {
      setDeletingExpenseId(null);
      setLoading(false);
    }
  };

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const expenseDescriptionPlaceholder = t('modals.expense.justificationPlaceholder', {
    defaultValue: 'Explain what left the drawer and why it was needed.',
  });
  const expenseReceiptPlaceholder = t('modals.expense.receiptPlaceholder', {
    defaultValue: 'Invoice, receipt, or reference number',
  });
  const recordExpenseLabel = t('modals.expense.recordExpense', {
    defaultValue: 'Record expense',
  });
  const noExpensesLabel = t('modals.expense.noExpenses', {
    defaultValue: 'No expenses recorded yet',
  });
  const deleteExpenseLabel = t('modals.expense.deleteExpense', {
    defaultValue: 'Delete expense',
  });
  const getExpenseTypeLabel = (type: ShiftExpense['expense_type'] | string | null | undefined) => {
    const normalizedType =
      typeof type === 'string' && ['supplies', 'maintenance', 'petty_cash', 'refund', 'other'].includes(type)
        ? type
        : 'other';
    return t(`modals.expense.expenseTypes.${normalizedType}`, {
      defaultValue: t(`expense.categories.${normalizedType}`, {
        defaultValue: normalizedType,
      }),
    });
  };
  const getExpenseStatusLabel = (status: ShiftExpense['status']) =>
    t(`expense.status.${status}`, {
      defaultValue: status,
    });

  const getStatusSymbol = (delivery: any): React.ReactNode => {
    const rawStatus = delivery.status || delivery.order_status || '';
    const normalizedStatus = rawStatus.toLowerCase();
    const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' || normalizedStatus === 'refunded';
    return isCanceled
      ? <XCircle className="w-4 h-4 text-red-400" />
      : <CheckCircle className="w-4 h-4 text-green-400" />;
  };

  const getPaymentSymbol = (paymentMethod: string): React.ReactNode => {
    const method = (paymentMethod || '').toLowerCase();
    if (method === 'cash') return <Banknote className="w-4 h-4 text-green-400" />;
    if (method === 'card') return <CreditCard className="w-4 h-4 text-blue-400" />;
    if (method === 'mixed' || method === 'split') {
      return (
        <span className="inline-flex items-center gap-1">
          <Banknote className="w-4 h-4 text-green-400" />
          <CreditCard className="w-4 h-4 text-blue-400" />
        </span>
      );
    }
    return <CreditCard className="w-4 h-4 text-gray-400" />; // fallback
  };

  const formatShiftWindow = (shift: any) => {
    if (!shift?.check_in_time) {
      return t('common.unknown', 'Unknown');
    }

    const start = formatTime(shift.check_in_time);
    const end = shift.check_out_time
      ? formatTime(shift.check_out_time)
      : t('shift.labels.active', 'Active');

    return `${start} - ${end}`;
  };

  const translateAuditOrderType = (orderType?: string | null) => {
    const normalized = (orderType || '')
      .trim()
      .toLowerCase()
      .replace(/^ordertype[.:_\s-]*/, '')
      .replace(/^order_type[.:_\s-]*/, '')
      .replace(/^type[.:_\s-]*/, '');

    switch (normalized) {
      case 'delivery':
        return t('modals.staffShift.auditOrderTypes.delivery');
      case 'pickup':
        return t('modals.staffShift.auditOrderTypes.pickup');
      case 'takeaway':
      case 'take_away':
        return t('modals.staffShift.auditOrderTypes.takeaway');
      case 'dine-in':
      case 'dinein':
      case 'dine_in':
      case 'in_store':
      case 'instore':
        return t('modals.staffShift.auditOrderTypes.dineIn');
      default:
        return t('modals.staffShift.auditOrderTypes.unknown');
    }
  };

  const translateAuditPaymentMethod = (paymentMethod?: string | null) => {
    switch ((paymentMethod || '').trim().toLowerCase()) {
      case 'cash':
      case 'cod':
        return t('modals.staffShift.cash');
      case 'card':
      case 'credit_card':
      case 'credit-card':
      case 'creditcard':
      case 'debit_card':
      case 'debit-card':
      case 'debitcard':
      case 'online':
      case 'digital':
        return t('modals.staffShift.card');
      case 'mixed':
      case 'split':
        return t('modals.staffShift.mixed');
      default:
        return paymentMethod || t('common.unknown', 'Unknown');
    }
  };

  const translateAuditStatus = (status?: string | null) => {
    switch ((status || '').trim().toLowerCase()) {
      case 'completed':
      case 'delivered':
        return t('modals.staffShift.orderStatuses.completed');
      case 'cancelled':
      case 'canceled':
        return t('modals.staffShift.orderStatuses.cancelled');
      case 'refunded':
        return t('modals.staffShift.orderStatuses.refunded');
      case 'closed':
        return t('modals.staffShift.orderStatuses.closed');
      case 'active':
        return t('modals.staffShift.orderStatuses.active');
      case 'pending':
        return t('modals.staffShift.orderStatuses.pending');
      default:
        return status || t('common.unknown', 'Unknown');
    }
  };

  const getAuditStatusBadgeClass = (status?: string | null) => {
    switch ((status || '').trim().toLowerCase()) {
      case 'completed':
      case 'delivered':
      case 'closed':
        return 'border-emerald-200/90 bg-emerald-50/90 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200';
      case 'cancelled':
      case 'canceled':
      case 'refunded':
        return 'border-rose-200/90 bg-rose-50/90 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200';
      case 'active':
      case 'pending':
        return 'border-amber-200/90 bg-amber-50/90 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200';
      default:
        return 'border-slate-200/90 bg-slate-50/90 text-slate-700 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200';
    }
  };

  const checkoutHeaderData = (() => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    const headerMetrics = getShiftHeaderMetrics(shiftSummary, effectiveShift);
    const openingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const roleLabel = translateRoleName(effectiveShift.role_type);
    const shiftWindow = formatShiftWindow(effectiveShift);

    let primaryLabel = t('modals.staffShift.totalSalesLabel', 'Total Sales');
    let primaryAmount = headerMetrics.totalAmount;
    let helper = t('modals.staffShift.reviewAndConfirm', 'Review and confirm');
    let variant: 'info' | 'warning' | 'success' | 'error' = 'info';
    let minimal = false;

    if (isCashierCheckoutRole && shiftSummary) {
      const breakdown = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        openingAmount,
        shiftSummary.totalExpenses || 0
      );
      primaryLabel = t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' });
      primaryAmount = breakdown.expected;
      helper = t('modals.staffShift.expectedInDrawerHelper', {
        defaultValue: 'Count the drawer and confirm the actual cash before closing.'
      });
      variant = 'warning';
    } else if (effectiveShift.role_type === 'driver' && shiftSummary) {
      const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const cashCollected = completedDeliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0);
      const amountToReturn = openingAmount + cashCollected - (shiftSummary.totalExpenses || 0);
      primaryLabel = t('modals.staffShift.amountToReturn', { defaultValue: 'Amount To Return' });
      primaryAmount = Math.abs(amountToReturn);
      helper = t('modals.staffShift.driverPaymentNote', {
        defaultValue: 'Driver payment will be recorded when you return cash to the cashier'
      });
      variant = amountToReturn >= 0 ? 'info' : 'error';
    } else if (effectiveShift.role_type === 'server' && shiftSummary?.waiterTables) {
      const cashFromTables = shiftSummary.waiterTables.reduce((sum: number, table: any) => sum + (table.cash_amount || 0), 0);
      const calculationVersion = effectiveShift.calculation_version || 1;
      const paymentAmount = effectiveShift.payment_amount || 0;
      const cashToReturn = calculationVersion >= 2
        ? openingAmount + cashFromTables - (shiftSummary.totalExpenses || 0)
        : openingAmount + cashFromTables - (shiftSummary.totalExpenses || 0) - paymentAmount;

      primaryLabel = t('modals.staffShift.cashToReturn', { defaultValue: 'Cash To Return' });
      primaryAmount = Math.abs(cashToReturn);
      helper = calculationVersion >= 2
        ? t('modals.staffShift.waiterPaymentNote', {
          defaultValue: 'Payment will be recorded when you return cash to the cashier'
        })
        : t('modals.staffShift.paymentDeductedNote', {
          defaultValue: 'Payment already deducted from amount to return'
        });
      variant = cashToReturn >= 0 ? 'info' : 'error';
    } else if (isNonFinancialCheckoutRole) {
      primaryLabel = t('modals.staffShift.reviewAndConfirm', 'Review and confirm');
      primaryAmount = 0;
      helper = t('modals.staffShift.nonFinancialCheckoutHelper', {
        defaultValue: 'This role does not require cash reconciliation. Closing the shift will only record the checkout time.',
      });
      variant = 'success';
      minimal = true;
    }

    return {
      headerMetrics,
      openingAmount,
      roleLabel,
      shiftWindow,
      primaryLabel,
      primaryAmount,
      helper,
      variant,
      minimal,
    };
  })();

  const checkoutFooterData = (() => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    if (isNonFinancialCheckoutRole) {
      return {
        label: t('modals.staffShift.readyToClose', { defaultValue: 'Ready To Close' }),
        amount: 0,
        note: t('modals.staffShift.nonFinancialFooterNote', {
          defaultValue: 'No sales, expenses, refunds, or cash amounts will be recorded for this role during checkout.',
        }),
        accentClass: 'text-emerald-300',
        minimal: true,
      };
    }

    if (isCashierCheckoutRole && shiftSummary) {
      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const breakdown = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        opening,
        shiftSummary.totalExpenses || 0
      );
      const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
      const variance = actual === null ? null : actual - breakdown.expected;

      return {
        label: t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' }),
        amount: breakdown.expected,
        note: closingCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Counted {{counted}} · Variance {{variance}}',
            counted: formatCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.countedCashPrompt', {
            defaultValue: 'Enter counted cash to confirm the final drawer amount.'
          }),
        accentClass: 'text-amber-300',
        minimal: false,
      };
    }

    if (effectiveShift.role_type === 'driver' && shiftSummary) {
      const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const expected = getEffectiveOpeningAmount(effectiveShift, shiftSummary)
        + completedDeliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0)
        - (shiftSummary.totalExpenses || 0);
      const actual = driverActualCash.trim() ? parseMoneyInputValue(driverActualCash) : null;
      const variance = actual === null ? null : actual - expected;

      return {
        label: t('modals.staffShift.amountToReturn', { defaultValue: 'Amount To Return' }),
        amount: Math.abs(expected),
        note: driverActualCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Returned {{counted}} · Variance {{variance}}',
            counted: formatCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the actual cash returned before checkout.',
          }),
        accentClass: expected >= 0 ? 'text-cyan-300' : 'text-red-300',
        minimal: false,
      };
    }

    if (effectiveShift.role_type === 'server' && shiftSummary?.waiterTables) {
      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const cashFromTables = shiftSummary.waiterTables.reduce((sum: number, table: any) => sum + (table.cash_amount || 0), 0);
      const expensesTotal = shiftSummary.totalExpenses || 0;
      const calculationVersion = effectiveShift.calculation_version || 1;
      const paymentAmount = effectiveShift.payment_amount || 0;
      const expected = calculationVersion >= 2
        ? opening + cashFromTables - expensesTotal
        : opening + cashFromTables - expensesTotal - paymentAmount;
      const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
      const variance = actual === null ? null : actual - expected;

      return {
        label: t('modals.staffShift.cashToReturn', { defaultValue: 'Cash To Return' }),
        amount: Math.abs(expected),
        note: closingCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Returned {{counted}} · Variance {{variance}}',
            counted: formatCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the actual cash returned before checkout.',
          }),
        accentClass: expected >= 0 ? 'text-cyan-300' : 'text-red-300',
        minimal: false,
      };
    }

    return {
      label: t('modals.staffShift.reviewAndConfirm', { defaultValue: 'Review and confirm' }),
      amount: 0,
      note: t('modals.staffShift.closeShiftHelper', {
        defaultValue: 'Confirm the checkout details and close the shift.',
      }),
      accentClass: 'text-emerald-300',
      minimal: true,
    };
  })();

  const checkoutSurfaceClass = 'rounded-[28px] border border-slate-200/80 bg-white/90 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_18px_40px_rgba(2,6,23,0.28)]';
  const checkoutInsetSurfaceClass = 'rounded-[24px] border border-slate-200/80 bg-slate-50/90 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] dark:border-white/10 dark:bg-black/25 dark:shadow-none';
  const checkoutActionButtonClass = 'inline-grid min-h-[70px] w-full shrink-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(37,99,235,0.28)] transition-all hover:bg-blue-700 sm:w-[176px]';
  const checkoutMutedTextClass = 'text-sm text-slate-600 dark:text-slate-300/80';
  const checkInSurfaceClass = 'rounded-[28px] border border-slate-200/80 bg-white/92 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_18px_40px_rgba(2,6,23,0.28)]';
  const checkInInsetSurfaceClass = 'rounded-[24px] border border-slate-200/80 bg-slate-50/88 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)] dark:border-white/10 dark:bg-black/25 dark:shadow-none';
  const checkInFooterClass = 'sticky bottom-0 z-10 mt-6 border-t border-slate-200/80 bg-white/88 px-1 pt-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#071018]/88';
  const checkInEyebrowClass = 'text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400';
  const checkInMutedTextClass = 'text-sm text-slate-600 dark:text-slate-300/80';

  const renderAuditSection = (content: React.ReactNode) => (
    <details className={`${checkoutSurfaceClass} group`}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
            {t('modals.staffShift.auditDetails', 'Audit Details')}
          </div>
          <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
            {t('modals.staffShift.auditDetails', 'Audit Details')}
          </h3>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
            {t('modals.staffShift.auditDetailsHelper', 'Expand for order, transfer, and payment history.')}
          </p>
        </div>
        <div className="rounded-full border border-slate-200/80 bg-white/90 p-3 text-slate-500 transition-transform group-open:rotate-90 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
          <ChevronRight className="h-5 w-5" />
        </div>
      </summary>
      <div className="mt-5 space-y-5 border-t border-slate-200/70 pt-5 dark:border-white/10">
        {content}
      </div>
    </details>
  );

  const renderAuditEmptyState = (message: string) => (
    <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
      {message}
    </div>
  );

  const renderExpensesPanel = () => (
    <div className={checkoutSurfaceClass}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            {t('modals.staffShift.expenses')}
          </div>
          <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
            {t('modals.staffShift.expenses')}
          </h3>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
            {canRecordInlineExpenses
              ? t('modals.staffShift.reviewAndConfirm')
              : t('modals.staffShift.expensesReadOnly', {
                defaultValue:
                  'Expenses are recorded from cashier checkout. Existing shift expenses are shown here for reference.',
              })}
          </p>
        </div>

        <div className="w-full sm:w-auto sm:text-right">
          <div className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
            {t('modals.staffShift.totalExpenses')}
          </div>
          <div className="mt-1 text-2xl font-black text-rose-500 dark:text-rose-300">
            {formatCurrency(totalExpenses)}
          </div>
          {canRecordInlineExpenses && (
            <button
              onClick={() => setShowExpenseForm(!showExpenseForm)}
              className={`mt-3 ${checkoutActionButtonClass}`}
            >
              <Plus className="h-4 w-4 justify-self-center" />
              <span className="min-w-0 text-center leading-tight whitespace-normal">
                {t('modals.staffShift.addExpense')}
              </span>
            </button>
          )}
        </div>
      </div>

      {canRecordInlineExpenses && showExpenseForm && (
        <div className={`mt-5 space-y-3 ${checkoutInsetSurfaceClass}`}>
          <select
            value={expenseType}
            onChange={(e) => setExpenseType(e.target.value as 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other')}
            className="liquid-glass-modal-input text-sm"
          >
            <option value="supplies">{getExpenseTypeLabel('supplies')}</option>
            <option value="maintenance">{getExpenseTypeLabel('maintenance')}</option>
            <option value="petty_cash">{getExpenseTypeLabel('petty_cash')}</option>
            <option value="refund">{getExpenseTypeLabel('refund')}</option>
            <option value="other">{getExpenseTypeLabel('other')}</option>
          </select>

          <input
            type="text"
            inputMode="decimal"
            value={expenseAmount}
            onChange={(e) => setExpenseAmount(formatMoneyInputWithCents(e.target.value))}
            onFocus={(e) => e.target.select()}
            placeholder="0,00"
            className="liquid-glass-modal-input text-lg font-bold"
          />

          <input
            type="text"
            value={expenseDescription}
            onChange={(e) => setExpenseDescription(e.target.value)}
            placeholder={expenseDescriptionPlaceholder}
            className="liquid-glass-modal-input text-sm"
          />

          <input
            type="text"
            value={expenseReceipt}
            onChange={(e) => setExpenseReceipt(e.target.value)}
            placeholder={expenseReceiptPlaceholder}
            className="liquid-glass-modal-input text-sm"
          />

          <button
            onClick={handleRecordExpense}
            disabled={loading}
            className="w-full rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(16,185,129,0.26)] transition-all hover:bg-green-700 disabled:opacity-50"
          >
            {recordExpenseLabel}
          </button>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {expenses.length > 0 ? (
          expenses.map((expense) => {
            const expenseTitle =
              expense.description ||
              t('modals.expense.untitledExpense', {
                defaultValue: 'Untitled expense',
              });
            const expenseMeta = [getExpenseTypeLabel(expense.expense_type), expense.receipt_number?.trim() || '']
              .filter(Boolean)
              .join(' · ');

            return (
              <div
                key={expense.id}
                className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 dark:border-white/10 dark:bg-black/20"
              >
                <div className="min-w-0">
                  <div className="font-semibold liquid-glass-modal-text">{expenseTitle}</div>
                  {expenseMeta && (
                    <div className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                      {expenseMeta}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="text-right font-black text-rose-500 dark:text-rose-300">
                    -{formatCurrency(expense.amount)}
                  </div>
                  <button
                    type="button"
                    disabled={deletingExpenseId === expense.id}
                    onClick={() =>
                      openConfirm({
                        title: t('modals.expense.deleteExpenseConfirmTitle', {
                          defaultValue: 'Delete expense',
                        }),
                        message: t(
                          'modals.expense.deleteExpenseConfirmMessage',
                          'Delete "{{description}}"? This will immediately remove it from the drawer totals.',
                          {
                            description: expenseTitle,
                          },
                        ),
                        variant: 'error',
                        confirmText: deleteExpenseLabel,
                        cancelText: t('common.actions.cancel', {
                          defaultValue: 'Cancel',
                        }),
                        onConfirm: () => {
                          void handleDeleteExpense(expense);
                        },
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleteExpenseLabel}
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
            {t('modals.staffShift.noExpensesRecorded')}
          </div>
        )}
      </div>
    </div>
  );

  const renderStaffPaymentsPanel = () => {
    if (!isCashierCheckoutRole) {
      return null;
    }

    const sessionPaymentTotal = staffPaymentsList.reduce((sum, payment) => sum + payment.amount, 0);
    const allowCurrentCashierSelection = isCashierCheckoutRole;

    return (
      <div className={checkoutSurfaceClass}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
              {t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}
            </div>
            <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
              {t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
              {t(
                'modals.staffShift.staffPaymentsReturnedViaCheckouts',
                'Recorded staff payouts are deducted from this cashier checkout immediately.',
              )}
            </p>
          </div>

          <button
            onClick={() => {
              if (showStaffPaymentForm) {
                resetStaffPaymentForm();
              } else {
                void openStaffPaymentForm();
              }
            }}
            className={checkoutActionButtonClass}
          >
            <Plus className="h-4 w-4 justify-self-center" />
            <span className="min-w-0 text-center leading-tight whitespace-normal">
              {t('modals.staffShift.addPayment', 'Add Payment')}
            </span>
          </button>
        </div>

        {showStaffPaymentForm && (
          <div className={`mt-5 space-y-3 ${checkoutInsetSurfaceClass}`}>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.selectStaff', 'Select Staff')}
              </label>
              <select
                value={selectedStaffForPayment?.id || ''}
                onChange={async (e) => {
                  const staffId = e.target.value;
                  if (staffId) {
                    const selected = availableStaff.find(s => s.id === staffId);
                    if (selected) {
                      setSelectedStaffForPayment({
                        id: selected.id,
                        name: selected.name,
                        role: selected.roles?.[0]?.role_name || 'staff'
                      });
                      const shiftDate = effectiveShift?.check_in_time
                        ? toLocalDateString(effectiveShift.check_in_time)
                        : undefined;
                      await loadPaymentHistoryForStaff(selected.id, shiftDate);
                      const activeShiftForSelected = staffActiveShifts.get(selected.id);
                      await calculateExpectedPayment(activeShiftForSelected, selected.hourly_rate);
                    }
                  } else {
                    setSelectedStaffForPayment(null);
                    setPaymentHistory([]);
                    setDailyPaymentTotal(0);
                    setExpectedPayment(null);
                  }
                }}
                className="liquid-glass-modal-input w-full"
              >
                <option value="">{t('modals.staffShift.selectStaffPlaceholder', '-- Select Staff --')}</option>
                {editingStaffPayment && selectedStaffForPayment?.id && !availableStaff.some((member) => member.id === (selectedStaffForPayment?.id ?? '')) && (
                  <option value={selectedStaffForPayment?.id ?? ''}>{selectedStaffForPayment?.name ?? t('common.unknown', 'Unknown')}</option>
                )}
                {availableStaff
                  .filter((member) => allowCurrentCashierSelection || member.id !== staff?.staffId)
                  .map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.paymentType', 'Payment Type')}
                </label>
                <select
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value)}
                  className="liquid-glass-modal-input w-full"
                >
                  <option value="wage">{t('modals.staffShift.paymentTypes.wage', 'Wage')}</option>
                  <option value="tip">{t('modals.staffShift.paymentTypes.tip', 'Tip')}</option>
                  <option value="bonus">{t('modals.staffShift.paymentTypes.bonus', 'Bonus')}</option>
                  <option value="advance">{t('modals.staffShift.paymentTypes.advance', 'Advance')}</option>
                  <option value="other">{t('modals.staffShift.paymentTypes.other', 'Other')}</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.amountLabel', 'Amount')}
                  {expectedPayment !== null && (
                    <span className="ml-2 normal-case tracking-normal text-blue-500">
                      ({t('modals.staffShift.expected', 'Expected')}: {formatCurrency(expectedPayment)})
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(formatMoneyInputWithCents(e.target.value))}
                  onFocus={(e) => e.target.select()}
                  placeholder={expectedPayment ? formatCurrency(expectedPayment) : '0,00'}
                  className="liquid-glass-modal-input w-full text-lg font-bold"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.notesOptional', 'Notes (optional)')}
              </label>
              <input
                type="text"
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                placeholder={t('modals.staffShift.paymentNotesPlaceholder', 'Add notes (optional)')}
                className="liquid-glass-modal-input w-full"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                onClick={resetStaffPaymentForm}
                className="rounded-xl border border-slate-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-100 dark:border-white/10 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/15"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleRecordStaffPayment}
                disabled={loading || !selectedStaffForPayment || !paymentAmount}
                className="rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(16,185,129,0.26)] transition-all hover:bg-green-700 disabled:opacity-50"
              >
                {loading
                  ? t('common.saving', 'Saving...')
                  : t(
                      editingStaffPaymentId ? 'modals.staffShift.savePaymentChanges' : 'modals.staffShift.recordPayment',
                      editingStaffPaymentId ? 'Save Changes' : 'Record Payment',
                    )}
              </button>
            </div>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {staffPaymentsList.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.recordedThisSession', 'Recorded This Session')}
                </div>
                <div className="text-sm font-bold text-rose-500 dark:text-rose-300">
                  -{formatCurrency(sessionPaymentTotal)}
                </div>
              </div>
              {staffPaymentsList.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3 dark:border-white/10 dark:bg-black/20"
                >
                  <div>
                    <div className="font-semibold liquid-glass-modal-text">
                      {payment.staff_name || t('common.unknown', 'Unknown')}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {t(`modals.staffShift.paymentTypes.${payment.payment_type}`, payment.payment_type)}
                      {payment.notes ? ` · ${payment.notes}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => { void beginEditStaffPayment(payment); }}
                      className="inline-flex items-center gap-1 rounded-xl border border-amber-200/80 bg-amber-50/90 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/15"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t('modals.staffShift.editPayment', 'Edit')}
                    </button>
                    <button
                      type="button"
                      disabled={deletingStaffPaymentId === payment.id}
                      onClick={() =>
                        openConfirm({
                          title: t('modals.staffShift.deleteStaffPaymentConfirmTitle', 'Delete staff payment'),
                          message: t(
                            'modals.staffShift.deleteStaffPaymentConfirmMessage',
                            'Delete the payment for "{{name}}"? Cashier checkout totals will be recalculated immediately.',
                            { name: payment.staff_name || t('common.unknown', 'Unknown') },
                          ),
                          variant: 'error',
                          confirmText: t('modals.staffShift.deletePayment', 'Delete Payment'),
                          onConfirm: () => { void handleDeleteStaffPayment(payment); },
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('modals.staffShift.deletePayment', 'Delete')}
                    </button>
                    <div className="font-bold text-rose-500 dark:text-rose-300">
                      -{formatCurrency(payment.amount)}
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
              {t('modals.staffShift.staffPaymentsMade')}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCheckoutBackButton = () => {
    if (localMode !== 'checkout') {
      return null;
    }

    return (
      <motion.button
        onClick={() => {
          setContentDirection(-1);
          setLocalMode(null);
          setCheckoutShift(null);
          setCheckInStep('select-staff');
          setSelectedStaff(null);
          setError('');
        }}
        className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition-all hover:bg-slate-100 dark:border-white/10 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-white/15"
        {...getInteractiveMotion('button')}
      >
        <ChevronRight className="h-4 w-4 rotate-180" />
        {t('modals.staffShift.backToStaffSelection')}
      </motion.button>
    );
  };

  const renderCashierCheckoutView = () => {
    if (!effectiveShift || !shiftSummary) {
      return null;
    }

    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const breakdown = getCashierExpectedBreakdown(
      shiftSummary,
      effectiveShift,
      opening,
      shiftSummary.totalExpenses || 0,
    );
    const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
    const variance = actual === null ? null : actual - breakdown.expected;
    const transferredDrivers = Array.isArray(shiftSummary.transferredDrivers) ? shiftSummary.transferredDrivers : [];
    const transferredWaiters = Array.isArray(shiftSummary.transferredWaiters) ? shiftSummary.transferredWaiters : [];
    const transferredStaff = [...transferredDrivers, ...transferredWaiters];
    const currentPeriodReturns = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
    const cashierOrders = Array.isArray(shiftSummary.cashierOrders) ? shiftSummary.cashierOrders : [];
    const headerMetrics = checkoutHeaderData?.headerMetrics ?? getShiftHeaderMetrics(shiftSummary, effectiveShift);
    const historicalStaffPayments = Array.isArray(shiftSummary.staffPayments) ? shiftSummary.staffPayments : [];
    const totalCashOrderCount =
      Number(shiftSummary?.breakdown?.instore?.cashCount ?? 0) +
      Number(shiftSummary?.breakdown?.delivery?.cashCount ?? 0);
    const hasAuditActivity =
      cashierOrders.length > 0 ||
      currentPeriodReturns.length > 0 ||
      transferredStaff.length > 0 ||
      historicalStaffPayments.length > 0;

    return (
      <div className="space-y-6" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(380px,0.95fr)]">
          <div className="space-y-6">
            <div className={checkoutSurfaceClass}>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)]">
                <div>
                  <div className="text-xs uppercase tracking-[0.22em] text-amber-600 dark:text-amber-300/90">
                    {t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' })}
                  </div>
                  <div className="mt-3 text-4xl font-black tracking-tight text-slate-900 dark:text-white">
                    {formatCurrency(breakdown.expected)}
                  </div>
                  <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                    {t('modals.staffShift.expectedInDrawerHelper', {
                      defaultValue: 'Count the drawer and confirm the actual cash before closing.',
                    })}
                  </p>
                </div>

                <div className={checkoutInsetSurfaceClass}>
                  <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.closingCashLabel')}
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={closingCash}
                    onChange={(e) => setClosingCash(formatMoneyInputWithCents(e.target.value))}
                    onFocus={(e) => e.target.select()}
                    placeholder="0,00"
                    className="liquid-glass-modal-input mt-3 w-full text-3xl font-black text-center"
                    autoFocus
                  />
                  <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                    {t('modals.staffShift.closingCashHelper')}
                  </p>
                  {variance === null ? (
                    <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                      {t('modals.staffShift.countedCashPrompt', {
                        defaultValue: 'Enter counted cash to confirm the final drawer amount.',
                      })}
                    </p>
                  ) : (
                    <div className="mt-4 flex justify-center">
                      <VarianceBadge variance={variance} size="lg" showIcon />
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}
                  </div>
                  <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                    {t('modals.staffShift.varianceBreakdown', 'Cash Breakdown')}
                  </h3>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.actualLabel', 'Actual')}
                  </div>
                  <div className="mt-1 text-2xl font-black text-slate-900 dark:text-white">
                    {actual === null
                      ? t('common.notEntered', { defaultValue: 'Not entered' })
                      : formatCurrency(actual)}
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.openingCashLabel'), amount: breakdown.opening, tone: 'text-blue-600 dark:text-blue-300', prefix: '+' },
                  { label: t('modals.staffShift.cashOrdersLabel'), amount: breakdown.sales, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.cashRefundsLabel', 'Cash Refunds'), amount: breakdown.cashRefunds, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.expensesLabel'), amount: breakdown.expenses, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.cashDropsLabel', 'Cash Drops'), amount: breakdown.cashDrops, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.driverCashGivenLabel', 'Driver Cash Given'), amount: breakdown.driverGiven, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.driverCashReturnedLabel', 'Driver Cash Returned'), amount: breakdown.driverReturned, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns'), amount: breakdown.inheritedDriverExpectedReturns, tone: 'text-cyan-600 dark:text-cyan-300', prefix: '+' },
                  { label: t('modals.staffShift.staffPaymentsDeductedLabel', 'Staff Payouts'), amount: breakdown.deductedStaffPayments, tone: 'text-amber-600 dark:text-amber-300', prefix: '-' },
                ]
                  .filter((row) => row.amount > 0 || row.label === t('modals.staffShift.openingCashLabel') || row.label === t('modals.staffShift.cashOrdersLabel'))
                  .map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-slate-50/85 px-4 py-3 dark:border-white/10 dark:bg-black/20"
                    >
                      <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{row.label}</span>
                      <span className={`text-lg font-black ${row.tone}`}>
                        {row.prefix}{formatCurrency(row.amount)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {renderExpensesPanel()}
            {renderStaffPaymentsPanel()}
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.totalOrders')}
                </div>
                <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{headerMetrics.totalCount}</div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                </div>
                <div className="mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300">
                  {formatCurrency(headerMetrics.totalAmount)}
                </div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.totalCashOrders')}
                </div>
                <div className="mt-2 text-2xl font-black text-cyan-600 dark:text-cyan-300">
                  {totalCashOrderCount}
                </div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.totalCashAmount', 'Total Cash Amount')}
                </div>
                <div className="mt-2 text-2xl font-black liquid-glass-modal-text">
                  {formatCurrency(breakdown.sales)}
                </div>
              </div>
            </div>

            {!hasAuditActivity && (
              <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                {t('modals.staffShift.auditNoActivity')}
              </div>
            )}

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.auditOrderHistoryTitle')}
                  </div>
                  <h4 className="mt-1 text-lg font-black liquid-glass-modal-text">
                    {t('modals.staffShift.auditOrderHistoryTitle')}
                  </h4>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
                    {t('modals.staffShift.auditOrderHistoryHelper')}
                  </p>
                </div>
                <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                  {cashierOrders.length}
                </span>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {cashierOrders.length > 0 ? (
                  cashierOrders.map((order: any) => (
                    <div
                      key={order.order_id}
                      className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-base font-black liquid-glass-modal-text">
                              #{order.order_number || order.order_id}
                            </div>
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getAuditStatusBadgeClass(order.status)}`}>
                              {translateAuditStatus(order.status)}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                            <span>{formatTime(order.created_at)}</span>
                            <span>•</span>
                            <span>{translateAuditOrderType(order.order_type)}</span>
                            {order.table_number && (
                              <>
                                <span>•</span>
                                <span>{t('modals.staffShift.tableNumber')} {order.table_number}</span>
                              </>
                            )}
                            </div>
                            <div className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
                              {(typeof order.customer_name === 'string' && order.customer_name.trim()) || t('modals.staffShift.noCustomerName')}
                            </div>
                          </div>

                        <div className="text-right">
                          <div className="text-xl font-black liquid-glass-modal-text">
                            {formatCurrency(Number(order.total_amount || 0))}
                          </div>
                          <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-slate-50/90 px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-white/10 dark:bg-black/20 dark:text-slate-200">
                            {getPaymentSymbol(String(order.payment_method || 'cash'))}
                            <span>{translateAuditPaymentMethod(order.payment_method)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                            {t('modals.staffShift.cash')}
                          </div>
                          <div className="mt-1 text-lg font-black text-emerald-600 dark:text-emerald-300">
                            {formatCurrency(Number(order.cash_amount || 0))}
                          </div>
                        </div>
                        <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                            {t('modals.staffShift.card')}
                          </div>
                          <div className="mt-1 text-lg font-black text-blue-600 dark:text-blue-300">
                            {formatCurrency(Number(order.card_amount || 0))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="xl:col-span-2">
                    {renderAuditEmptyState(t('modals.staffShift.noAuditOrderHistory'))}
                  </div>
                )}
              </div>
            </div>

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.auditStaffReturnsTitle')}
                  </div>
                  <h4 className="mt-1 text-lg font-black liquid-glass-modal-text">
                    {t('modals.staffShift.auditStaffReturnsTitle')}
                  </h4>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
                    {t('modals.staffShift.auditStaffReturnsHelper')}
                  </p>
                </div>
                <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                  {currentPeriodReturns.length + transferredStaff.length}
                </span>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                      {t('modals.staffShift.currentPeriodReturnsLabel')}
                    </div>
                    <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                      {currentPeriodReturns.length}
                    </span>
                  </div>

                  {currentPeriodReturns.length > 0 ? (
                    currentPeriodReturns.map((item: any) => {
                      const amountToReturn = Number(item.amount_to_return || 0);
                      const isPositive = amountToReturn >= 0;

                      return (
                        <div
                          key={item.shift_id || item.driver_id || item.order_id}
                          className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-semibold liquid-glass-modal-text">
                                {item.driver_name || item.staff_name || '—'}
                              </div>
                              <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                                {translateRoleName(item.role_type || 'driver')}
                              </div>
                              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                                {formatShiftWindow({
                                  check_in_time: item.check_in_time,
                                  check_out_time: item.check_out_time,
                                })}
                                {' · '}
                                {t('modals.staffShift.ordersCountValue', { count: Number(item.order_count || 0) })}
                              </div>
                            </div>

                            <div className={`text-right text-lg font-black ${isPositive ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}`}>
                              {isPositive ? '+' : '-'}{formatCurrency(Math.abs(amountToReturn))}
                              <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                                {isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.driverStarting')}
                              </div>
                              <div className="mt-1 text-sm font-black text-blue-600 dark:text-blue-300">
                                {formatCurrency(Number(item.starting_amount || 0))}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.cashCollected', 'Cash Collected')}
                              </div>
                              <div className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-300">
                                {formatCurrency(Number(item.cash_collected || 0))}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text">
                                {formatCurrency(Number(item.total_amount || 0))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    renderAuditEmptyState(t('modals.staffShift.noCurrentPeriodReturns'))
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                      {t('modals.staffShift.inheritedReturnsLabel')}
                    </div>
                    <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                      {transferredStaff.length}
                    </span>
                  </div>

                  {transferredStaff.length > 0 ? (
                    transferredStaff.map((item: any) => {
                      const inheritedReturn = Number(item.net_cash_amount || item.cash_to_return || item.starting_amount || 0);

                      return (
                        <div
                          key={item.shift_id || item.driver_id || item.waiter_id}
                          className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-semibold liquid-glass-modal-text">
                                {item.driver_name || item.waiter_name || item.staff_name || '—'}
                              </div>
                              <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                                {translateRoleName(item.role_type || 'driver')}
                              </div>
                              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                                {formatShiftWindow({ check_in_time: item.check_in_time })}
                              </div>
                            </div>

                            <div className="text-right text-lg font-black text-cyan-600 dark:text-cyan-300">
                              +{formatCurrency(Math.abs(inheritedReturn))}
                              <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.driverReturns')}
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.driverStarting')}
                              </div>
                              <div className="mt-1 text-sm font-black text-blue-600 dark:text-blue-300">
                                {formatCurrency(Number(item.starting_amount || 0))}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.cashCollected', 'Cash Collected')}
                              </div>
                              <div className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-300">
                                {formatCurrency(Number(item.cash_collected || 0))}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-slate-50/90 px-3 py-3 dark:border-white/10 dark:bg-black/20">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                                {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text">
                                {formatCurrency(Number(item.total_amount || 0))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    renderAuditEmptyState(t('modals.staffShift.noInheritedReturns'))
                  )}
                </div>
              </div>
            </div>

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.staffPaymentsTitle')}
                  </div>
                  <h4 className="mt-1 text-lg font-black liquid-glass-modal-text">
                    {t('modals.staffShift.totalStaffPayments')}
                  </h4>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/75">
                    {t('modals.staffShift.auditStaffPaymentsHelper')}
                  </p>
                </div>
                <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                  {historicalStaffPayments.length}
                </span>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {historicalStaffPayments.length > 0 ? (
                  historicalStaffPayments.map((payment: any) => (
                    <div
                      key={payment.id}
                      className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="font-semibold liquid-glass-modal-text">
                            {payment.staff_name || '—'}
                          </div>
                          <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                            {payment.role_type ? translateRoleName(payment.role_type) : '—'}
                          </div>
                          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                            {payment.created_at ? formatTime(payment.created_at) : t('common.unknown', 'Unknown')}
                          </div>
                        </div>

                        <div className="text-right font-black text-rose-600 dark:text-rose-300">
                          -{formatCurrency(Number(payment.amount || 0))}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="xl:col-span-2">
                    {renderAuditEmptyState(t('modals.staffShift.noHistoricalStaffPayments'))}
                  </div>
                )}
              </div>
            </div>
          </div>,
        )}
      </div>
    );
  };

  const renderDriverCheckoutView = () => {
    if (!effectiveShift || !shiftSummary) {
      return null;
    }

    const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
    const completedDeliveries = deliveries.filter((delivery: any) => {
      const status = (delivery.status || delivery.order_status || '').toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
    });
    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const cashCollected = completedDeliveries.reduce((sum: number, delivery: any) => sum + Number(delivery.cash_collected || 0), 0);
    const amountToReturn = opening + cashCollected - (shiftSummary.totalExpenses || 0);
    const actualReturned = driverActualCash.trim() ? parseMoneyInputValue(driverActualCash) : null;
    const variance = actualReturned === null ? null : actualReturned - amountToReturn;

    return (
      <div className="space-y-6" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.95fr)]">
          <div className="space-y-6">
            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.22em] text-cyan-600 dark:text-cyan-300/90">
                {t('modals.staffShift.amountToReturn', { defaultValue: 'Amount To Return' })}
              </div>
              <div className="mt-3 text-4xl font-black tracking-tight text-slate-900 dark:text-white">
                {formatCurrency(Math.abs(amountToReturn))}
              </div>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                {t('modals.staffShift.driverPaymentNote', {
                  defaultValue: 'Driver payment will be recorded when you return cash to the cashier',
                })}
              </p>

              <div className={`mt-5 ${checkoutInsetSurfaceClass}`}>
                <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.actualCashReturned', { defaultValue: 'Actual Cash Returned' })}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={driverActualCash}
                  onChange={(e) => setDriverActualCash(formatMoneyInputWithCents(e.target.value))}
                  onFocus={(e) => e.target.select()}
                  placeholder="0,00"
                  className="liquid-glass-modal-input mt-3 w-full text-3xl font-black text-center"
                  autoFocus
                />
                {variance === null ? (
                  <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.actualCashReturnedRequired', {
                      defaultValue: 'Enter the actual cash returned before checkout.',
                    })}
                  </p>
                ) : (
                  <div className="mt-4 flex justify-center">
                    <VarianceBadge variance={variance} size="lg" showIcon />
                  </div>
                )}
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('receipt.formula.label')}
              </h3>
              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.startingAmount', 'Starting Amount'), amount: opening, tone: 'text-blue-600 dark:text-blue-300', prefix: '+' },
                  { label: t('modals.staffShift.cashCollected', 'Cash Collected'), amount: cashCollected, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.expenses', 'Expenses'), amount: shiftSummary.totalExpenses || 0, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-slate-50/85 px-4 py-3 dark:border-white/10 dark:bg-black/20"
                  >
                    <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{row.label}</span>
                    <span className={`text-lg font-black ${row.tone}`}>
                      {row.prefix}{formatCurrency(row.amount)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-2xl border border-cyan-200/90 bg-cyan-50/80 px-4 py-3 dark:border-cyan-400/30 dark:bg-cyan-500/10">
                  <span className="text-sm font-semibold text-cyan-700 dark:text-cyan-200">
                    {t('modals.staffShift.amountToReturn', { defaultValue: 'Amount To Return' })}
                  </span>
                  <span className={`text-xl font-black ${amountToReturn >= 0 ? 'text-cyan-700 dark:text-cyan-200' : 'text-rose-600 dark:text-rose-300'}`}>
                    {formatCurrency(Math.abs(amountToReturn))}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {renderExpensesPanel()}

            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.informationOnlyTitle', 'Information Only')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.reviewAndConfirm')}
              </h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.totalOrders')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{completedDeliveries.length}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.cashCollected', 'Cash Collected')}
                  </div>
                  <div className="mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300">
                    {formatCurrency(cashCollected)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-3">
            {deliveries.length > 0 ? (
              deliveries.map((delivery: any) => (
                <div
                  key={delivery.id}
                  className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-4 dark:border-white/10 dark:bg-black/20"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold liquid-glass-modal-text">#{delivery.order_number || delivery.id}</div>
                      <div className="mt-1 text-sm text-slate-600 dark:text-slate-300/75">
                        {delivery.customer_name || '—'}
                      </div>
                      {delivery.delivery_address && (
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{delivery.delivery_address}</div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-black liquid-glass-modal-text">{formatCurrency(Number(delivery.total_amount || 0))}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                        {(delivery.payment_method || 'card').toUpperCase()}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                {t('modals.staffShift.noOrdersYet')}
              </div>
            )}
          </div>,
        )}
      </div>
    );
  };

  const renderServerCheckoutView = () => {
    if (!effectiveShift || !shiftSummary?.waiterTables) {
      return null;
    }

    const waiterTables = Array.isArray(shiftSummary.waiterTables) ? shiftSummary.waiterTables : [];
    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const cashFromTables = waiterTables.reduce((sum: number, table: any) => sum + Number(table.cash_amount || 0), 0);
    const cardTotal = waiterTables.reduce((sum: number, table: any) => sum + Number(table.card_amount || 0), 0);
    const totalOrders = waiterTables.reduce((sum: number, table: any) => sum + Number(table.order_count || 0), 0);
    const expensesTotal = shiftSummary.totalExpenses || 0;
    const calculationVersion = effectiveShift.calculation_version || 1;
    const paymentAmount = effectiveShift.payment_amount || 0;
    const cashToReturn = calculationVersion >= 2
      ? opening + cashFromTables - expensesTotal
      : opening + cashFromTables - expensesTotal - paymentAmount;
    const actualReturned = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
    const variance = actualReturned === null ? null : actualReturned - cashToReturn;

    return (
      <div className="space-y-6" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.95fr)]">
          <div className="space-y-6">
            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.22em] text-cyan-600 dark:text-cyan-300/90">
                {t('modals.staffShift.cashToReturn', { defaultValue: 'Cash To Return' })}
              </div>
              <div className="mt-3 text-4xl font-black tracking-tight text-slate-900 dark:text-white">
                {formatCurrency(Math.abs(cashToReturn))}
              </div>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                {calculationVersion >= 2
                  ? t('modals.staffShift.waiterPaymentNote', {
                    defaultValue: 'Payment will be recorded when you return cash to the cashier',
                  })
                  : t('modals.staffShift.paymentDeductedNote', {
                    defaultValue: 'Payment already deducted from amount to return',
                  })}
              </p>

              <div className={`mt-5 ${checkoutInsetSurfaceClass}`}>
                <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                  {t('modals.staffShift.actualCashReturned', { defaultValue: 'Actual Cash Returned' })}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={closingCash}
                  onChange={(e) => setClosingCash(formatMoneyInputWithCents(e.target.value))}
                  onFocus={(e) => e.target.select()}
                  placeholder="0,00"
                  className="liquid-glass-modal-input mt-3 w-full text-3xl font-black text-center"
                  autoFocus
                />
                {variance === null ? (
                  <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.actualCashReturnedRequired', {
                      defaultValue: 'Enter the actual cash returned before checkout.',
                    })}
                  </p>
                ) : (
                  <div className="mt-4 flex justify-center">
                    <VarianceBadge variance={variance} size="lg" showIcon />
                  </div>
                )}
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('receipt.formula.label')}
              </h3>
              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.startingAmount', 'Starting Amount'), amount: opening, tone: 'text-blue-600 dark:text-blue-300', prefix: '+' },
                  { label: t('modals.staffShift.cashCollected', 'Cash Collected'), amount: cashFromTables, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.expenses', 'Expenses'), amount: expensesTotal, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  ...(calculationVersion < 2 && paymentAmount > 0
                    ? [{ label: t('modals.staffShift.payment', 'Payment'), amount: paymentAmount, tone: 'text-amber-600 dark:text-amber-300', prefix: '-' }]
                    : []),
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-slate-50/85 px-4 py-3 dark:border-white/10 dark:bg-black/20"
                  >
                    <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{row.label}</span>
                    <span className={`text-lg font-black ${row.tone}`}>
                      {row.prefix}{formatCurrency(row.amount)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-2xl border border-cyan-200/90 bg-cyan-50/80 px-4 py-3 dark:border-cyan-400/30 dark:bg-cyan-500/10">
                  <span className="text-sm font-semibold text-cyan-700 dark:text-cyan-200">
                    {t('modals.staffShift.cashToReturn', { defaultValue: 'Cash To Return' })}
                  </span>
                  <span className={`text-xl font-black ${cashToReturn >= 0 ? 'text-cyan-700 dark:text-cyan-200' : 'text-rose-600 dark:text-rose-300'}`}>
                    {formatCurrency(Math.abs(cashToReturn))}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {renderExpensesPanel()}

            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.informationOnlyTitle', 'Information Only')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.orderSummary', 'Order Summary')}
              </h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.tablesServed', 'Tables Served')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{waiterTables.length}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.ordersCount', 'Orders')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{totalOrders}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.cashOrders', 'Cash Orders')}
                  </div>
                  <div className="mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300">
                    {formatCurrency(cashFromTables)}
                  </div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.cardOrders', 'Card Orders')}
                  </div>
                  <div className="mt-2 text-2xl font-black text-blue-600 dark:text-blue-300">
                    {formatCurrency(cardTotal)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-3">
            {waiterTables.length > 0 ? (
              waiterTables.map((table: any) => (
                <div
                  key={table.table_number}
                  className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-4 dark:border-white/10 dark:bg-black/20"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold liquid-glass-modal-text">
                        {t('modals.staffShift.tableNumber', 'Table')} {table.table_number}
                      </div>
                      <div className="mt-1 text-sm text-slate-600 dark:text-slate-300/75">
                        {t('modals.staffShift.ordersCountValue', { count: table.order_count || 0 })}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-black liquid-glass-modal-text">{formatCurrency(Number(table.total_amount || 0))}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                        {(table.payment_method || 'mixed').toUpperCase()}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200/90 bg-slate-50/70 px-4 py-5 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                {t('modals.staffShift.noOrdersYet')}
              </div>
            )}
          </div>,
        )}
      </div>
    );
  };

  const renderNonFinancialCheckoutView = () => {
    if (!effectiveShift) {
      return null;
    }

    return (
      <div className="space-y-6" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <div className="space-y-6">
            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.22em] text-emerald-600 dark:text-emerald-300/90">
                {t('modals.staffShift.shiftSummary', 'Shift Summary')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.nonFinancialRoleTitle', {
                  defaultValue: 'Operational shift only',
                })}
              </h3>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                {t('modals.staffShift.nonFinancialRoleNote', {
                  defaultValue: 'This role does not handle drawer cash, sales reconciliation, refunds, or expenses at checkout.',
                })}
              </p>

              <div className={`mt-5 grid gap-3 sm:grid-cols-2 ${checkoutInsetSurfaceClass}`}>
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.staffMember', 'Staff')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {effectiveShift.staff_name || t('common.unknown', 'Unknown')}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.roleStepLabel', 'Role')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {translateRoleName(effectiveShift.role_type)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.checkIn')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {formatTime(effectiveShift.check_in_time)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    {t('modals.staffShift.checkOut')}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-emerald-600 dark:text-emerald-300">
                    {t('modals.staffShift.checkoutTimeRecordedOnClose', {
                      defaultValue: 'Recorded automatically when you close the shift',
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className={checkoutSurfaceClass}>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {t('modals.staffShift.reviewAndConfirm')}
              </div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.readyToClose', { defaultValue: 'Ready To Close' })}
              </h3>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/75">
                {t('modals.staffShift.nonFinancialCheckoutHelper', {
                  defaultValue: 'Closing this shift only records the staff member, role, and checkout time.',
                })}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderCheckoutContent = () => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    if (isCashierCheckoutRole) {
      return renderCashierCheckoutView();
    }

    if (effectiveShift.role_type === 'driver') {
      return renderDriverCheckoutView();
    }

    if (effectiveShift.role_type === 'server') {
      return renderServerCheckoutView();
    }

    return renderNonFinancialCheckoutView();
  };

  const renderRoleBadge = (
    role: StaffRole,
    options: { emphasized?: boolean; highlighted?: boolean } = {},
  ) => {
    const presentation = getRolePresentation(role.role_name);
    const emphasized = options.emphasized || options.highlighted;

    return (
      <span
        key={role.role_id}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
          emphasized ? presentation.badgeFilled : presentation.badgeOutline
        }`}
      >
        {(options.highlighted || role.is_primary) && <Star className="h-3.5 w-3.5" />}
        <span>{translateRoleName(role.role_name)}</span>
      </span>
    );
  };

  const renderCheckInBackButton = (targetStep: CheckInStep) => (
    <motion.button
      onClick={() => {
        setError('');
        navigateCheckInStep(targetStep);
      }}
      className="inline-flex items-center gap-2 rounded-xl border border-slate-200/90 bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-100 dark:hover:bg-white/[0.08]"
      {...getInteractiveMotion('button')}
    >
      <ChevronRight className="h-4 w-4 rotate-180" />
      {t('common.actions.back')}
    </motion.button>
  );

  const renderSelectedStaffSummary = ({
    helper,
    statusLabel,
    statusClass,
    highlightedRoleName,
  }: {
    helper: string;
    statusLabel: string;
    statusClass: string;
    highlightedRoleName?: string;
  }) => {
    if (!selectedStaff) {
      return null;
    }

    const summaryRoleName = highlightedRoleName || selectedPrimaryRole?.role_name || selectedStaff.role_name;
    const summaryPresentation = getRolePresentation(summaryRoleName);

    return (
      <motion.div layout className={checkInSurfaceClass}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className={checkInEyebrowClass}>{t('modals.staffShift.selectedStaffLabel')}</div>
            <h3 className="mt-2 truncate text-2xl font-black tracking-tight liquid-glass-modal-text">
              {selectedStaff.name}
            </h3>
            <p className={`mt-2 ${checkInMutedTextClass}`}>{helper}</p>
          </div>

          <span className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs font-semibold ${statusClass}`}>
            {statusLabel}
          </span>
        </div>

        <div
          className={`mt-5 rounded-[24px] border p-4 ${summaryPresentation.accentBorder} ${summaryPresentation.accentSurface}`}
        >
          <div className="flex items-center gap-4">
            <div
              className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border ${summaryPresentation.iconSurface}`}
            >
              <User className={`h-8 w-8 ${summaryPresentation.iconColor}`} strokeWidth={1.8} />
            </div>

            <div className="min-w-0">
              <div className={checkInEyebrowClass}>{t('modals.staffShift.currentRoleLabel')}</div>
              <div className={`mt-2 text-lg font-black ${summaryPresentation.accentText}`}>
                {translateRoleName(summaryRoleName)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className={checkInEyebrowClass}>{t('modals.staffShift.availableRolesLabel')}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedStaffRoles.map((role) =>
              renderRoleBadge(role, {
                emphasized: !highlightedRoleName && role.is_primary,
                highlighted: role.role_name === highlightedRoleName,
              }),
            )}
          </div>
        </div>
      </motion.div>
    );
  };

  const renderCheckInContent = () => {
    const cashEntryRole = roleType === 'cashier' || roleType === 'driver' || roleType === 'server';
    const selectedRolePresentation = getRolePresentation(roleType);

    if (checkInStep === 'select-staff') {
      return (
        <div className="space-y-6" data-testid="staff-select-section">
          <div>
            <div className={checkInEyebrowClass}>{t('modals.staffShift.checkInTitle')}</div>
            <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
              {t('modals.staffShift.selectStaff')}
            </h3>
            <p className={`mt-2 max-w-3xl ${checkInMutedTextClass}`}>
              {t('modals.staffShift.selectStaffStepHelper')}
            </p>
          </div>

          {loading ? (
            <div className={`${checkInSurfaceClass} py-14 text-center`}>
              <div className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-blue-600 dark:border-slate-600 dark:border-t-cyan-300" />
              <p className={`mt-4 ${checkInMutedTextClass}`}>{t('modals.staffShift.loadingStaff')}</p>
            </div>
          ) : availableStaff.length === 0 ? (
            <div className={`${checkInSurfaceClass} py-14 text-center`}>
              <User className="mx-auto mb-4 h-16 w-16 text-slate-400 dark:text-slate-500" />
              <p className="text-base font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.noStaffAvailable')}
              </p>
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-2">
              <section className={checkInSurfaceClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className={checkInEyebrowClass}>{t('modals.staffShift.checkedInNow')}</div>
                    <h4 className="mt-2 text-xl font-black tracking-tight liquid-glass-modal-text">
                      {t('modals.staffShift.activeShift')}
                    </h4>
                    <p className={`mt-2 ${checkInMutedTextClass}`}>
                      {t('modals.staffShift.checkedInNowHelper')}
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-emerald-200/90 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                    {activeCheckInStaff.length}
                  </span>
                </div>

                <div className="mt-5 space-y-3">
                  {activeCheckInStaff.length > 0 ? (
                    activeCheckInStaff.map((staffMember) => {
                      const activeShiftForMember = staffActiveShifts.get(staffMember.id);
                      const activeRoleName = activeShiftForMember?.role_type || staffMember.role_name;
                      const activePresentation = getRolePresentation(activeRoleName);

                      return (
                        <motion.button
                          layout
                          key={staffMember.id}
                          onClick={() => {
                            void handleStaffSelect(staffMember);
                          }}
                          className={`group w-full rounded-[24px] border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_32px_rgba(15,23,42,0.10)] dark:hover:shadow-[0_16px_32px_rgba(2,6,23,0.28)] ${activePresentation.accentBorder} ${activePresentation.accentSurface}`}
                          {...getInteractiveMotion('card')}
                        >
                          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                            <div className="flex min-w-0 items-start gap-4">
                              <div
                                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border ${activePresentation.iconSurface}`}
                              >
                                <User className={`h-8 w-8 ${activePresentation.iconColor}`} strokeWidth={1.8} />
                              </div>

                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-lg font-black liquid-glass-modal-text">
                                    {staffMember.name}
                                  </span>
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold ${activePresentation.badgeFilled}`}
                                  >
                                    <CheckCircle className="h-3.5 w-3.5" />
                                    {translateRoleName(activeRoleName)}
                                  </span>
                                </div>

                                <div className={`mt-3 flex flex-wrap items-center gap-3 text-sm ${checkInMutedTextClass}`}>
                                  <span className="inline-flex items-center gap-1.5">
                                    <Clock className="h-4 w-4" />
                                    {t('modals.staffShift.activeSince', {
                                      time: activeShiftForMember?.check_in_time
                                        ? formatTime(activeShiftForMember.check_in_time)
                                        : t('shift.labels.active', 'Active'),
                                    })}
                                  </span>
                                  <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-300">
                                    <CheckCircle className="h-4 w-4" />
                                    {t('shift.labels.active', 'Active')}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <span
                              className={`inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-all group-hover:translate-x-0.5 ${activePresentation.buttonSurface}`}
                            >
                              {t('modals.staffShift.manageActiveShift')}
                              <ChevronRight className="h-4 w-4" />
                            </span>
                          </div>
                        </motion.button>
                      );
                    })
                  ) : (
                    <div className="rounded-[24px] border border-dashed border-slate-200/90 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                      {t('modals.staffShift.noCheckedInStaff')}
                    </div>
                  )}
                </div>
              </section>

              <section className={checkInSurfaceClass}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className={checkInEyebrowClass}>{t('modals.staffShift.readyToStart')}</div>
                    <h4 className="mt-2 text-xl font-black tracking-tight liquid-glass-modal-text">
                      {t('modals.staffShift.selectStaff')}
                    </h4>
                    <p className={`mt-2 ${checkInMutedTextClass}`}>
                      {t('modals.staffShift.readyToStartHelper')}
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-slate-200/90 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200">
                    {readyCheckInStaff.length}
                  </span>
                </div>

                <div className="mt-5 space-y-3">
                  {readyCheckInStaff.length > 0 ? (
                    readyCheckInStaff.map((staffMember) => {
                      const roles = getStaffRoles(staffMember);
                      const primaryRole = roles[0];
                      const primaryPresentation = getRolePresentation(primaryRole?.role_name);

                      return (
                        <motion.button
                          layout
                          key={staffMember.id}
                          onClick={() => {
                            void handleStaffSelect(staffMember);
                          }}
                          className="group w-full rounded-[24px] border border-slate-200/90 bg-white/95 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_16px_32px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.05] dark:hover:shadow-[0_16px_32px_rgba(2,6,23,0.28)]"
                          {...getInteractiveMotion('card')}
                        >
                          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                            <div className="flex min-w-0 items-start gap-4">
                              <div
                                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border ${primaryPresentation.iconSurface}`}
                              >
                                <User className={`h-8 w-8 ${primaryPresentation.iconColor}`} strokeWidth={1.8} />
                              </div>

                              <div className="min-w-0">
                                <div className="truncate text-lg font-black liquid-glass-modal-text">
                                  {staffMember.name}
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                  {roles.map((role) =>
                                    renderRoleBadge(role, {
                                      emphasized: role.is_primary,
                                    }),
                                  )}
                                </div>
                              </div>
                            </div>

                            <span
                              className={`inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-all group-hover:translate-x-0.5 ${primaryPresentation.buttonSurface}`}
                            >
                              {t('modals.staffShift.enterPinAction')}
                              <ChevronRight className="h-4 w-4" />
                            </span>
                          </div>
                        </motion.button>
                      );
                    })
                  ) : (
                    <div className="rounded-[24px] border border-dashed border-slate-200/90 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400">
                      {t('modals.staffShift.noReadyStaff')}
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      );
    }

    if (checkInStep === 'enter-pin' && selectedStaff) {
      return (
        <div className="space-y-6" data-testid="staff-pin-section">
          <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            {renderSelectedStaffSummary({
              helper: t('modals.staffShift.enterPinHelper'),
              statusLabel: t('modals.staffShift.readyToStart'),
              statusClass:
                'border-cyan-200/90 bg-cyan-50 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-500/10 dark:text-cyan-200',
            })}

            <div className={checkInSurfaceClass}>
              <div className={checkInEyebrowClass}>{t('modals.staffShift.enterPIN')}</div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.enterPIN')}
              </h3>
              <p className={`mt-2 ${checkInMutedTextClass}`}>{t('modals.staffShift.enterPinHelper')}</p>

              <div className={`mt-6 ${checkInInsetSurfaceClass}`}>
                <label className={`block ${checkInEyebrowClass}`}>{t('modals.staffShift.enterPIN')}</label>

                <div
                  className="relative mt-4 overflow-hidden rounded-[22px] border border-slate-200/90 bg-white/92 p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)] transition-all focus-within:border-cyan-300 focus-within:shadow-[0_12px_28px_rgba(6,182,212,0.12)] dark:border-white/10 dark:bg-black/20 dark:shadow-none dark:focus-within:border-cyan-400/40"
                  onClick={() => pinInputRef.current?.focus()}
                >
                  <input
                    ref={pinInputRef}
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={4}
                    value={enteredPin}
                    onChange={(e) => setEnteredPin(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => e.key === 'Enter' && enteredPin.length === 4 && handlePinSubmit()}
                    className="w-full bg-transparent py-5 text-center text-4xl font-black tracking-[0.9em] text-slate-900 outline-none dark:text-white"
                    autoFocus
                    autoComplete="off"
                    style={{ paddingLeft: '0.9em' }}
                  />

                  {enteredPin.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-4 opacity-35">
                      <div className="h-3 w-3 rounded-full bg-slate-500 dark:bg-slate-300" />
                      <div className="h-3 w-3 rounded-full bg-slate-500 dark:bg-slate-300" />
                      <div className="h-3 w-3 rounded-full bg-slate-500 dark:bg-slate-300" />
                      <div className="h-3 w-3 rounded-full bg-slate-500 dark:bg-slate-300" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className={checkInFooterClass}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {renderCheckInBackButton('select-staff')}

              <motion.button
                onClick={() => {
                  void handlePinSubmit();
                }}
                disabled={loading || enteredPin.length !== 4}
                className="inline-flex items-center justify-center gap-3 rounded-xl bg-blue-600 px-6 py-3.5 text-base font-bold text-white shadow-[0_12px_28px_rgba(37,99,235,0.28)] transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:min-w-[220px]"
                {...getInteractiveMotion('primary', loading || enteredPin.length !== 4)}
              >
                {loading ? (
                  <>
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t('modals.staffShift.authenticating')}
                  </>
                ) : (
                  <>
                    {t('modals.staffShift.continue')}
                    <ChevronRight className="h-4 w-4" />
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      );
    }

    if (checkInStep === 'select-role' && selectedStaff) {
      return (
        <div className="space-y-6" data-testid="staff-role-section">
          <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            {renderSelectedStaffSummary({
              helper: t('modals.staffShift.roleSelectionHelper'),
              statusLabel: t('modals.staffShift.selectRole'),
              statusClass:
                'border-indigo-200/90 bg-indigo-50 text-indigo-700 dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-200',
            })}

            <div className={checkInSurfaceClass}>
              <div className={checkInEyebrowClass}>{t('modals.staffShift.roleStepLabel', 'Role')}</div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {t('modals.staffShift.selectRoleForShift')}
              </h3>
              <p className={`mt-2 ${checkInMutedTextClass}`}>{t('modals.staffShift.roleSelectionHelper')}</p>

              {cashierFirstGateActive && (
                <div className="mt-6 rounded-[22px] border border-amber-300/70 bg-amber-50/90 p-4 text-sm text-amber-900 shadow-[0_12px_24px_rgba(245,158,11,0.12)] dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-200" />
                    <div className="space-y-1">
                      <p className="font-semibold">
                        {t(
                          'modals.staffShift.cashierFirstCheckInRequired',
                          'The first check-in for this business day must be a cashier.',
                        )}
                      </p>
                      <p className="text-amber-800/90 dark:text-amber-100/80">
                        {selectedStaffHasCashierRole
                          ? t(
                              'modals.staffShift.cashierFirstCheckInHelper',
                              'Start a cashier shift first. The other roles unlock after the cashier checks in.',
                            )
                          : t(
                              'modals.staffShift.cashierFirstCheckInBlocked',
                              'This staff member does not have a cashier role. Go back and choose a cashier first.',
                            )}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-6 space-y-3">
                {selectedStaffRoles.map((role) => {
                  const rolePresentation = getRolePresentation(role.role_name);
                  const isRoleLockedByCashierFirstGate =
                    cashierFirstGateActive &&
                    (role.role_name || '').trim().toLowerCase() !== 'cashier';
                  const roleHelper = isRoleLockedByCashierFirstGate
                    ? t(
                        'modals.staffShift.cashierFirstRoleLockedHelper',
                        'Cashier must start the current business day before this role can check in.',
                      )
                    : getCheckInRoleHelper(role.role_name);

                  return (
                    <motion.button
                      layout
                      key={role.role_id}
                      disabled={isRoleLockedByCashierFirstGate}
                      onClick={() => {
                        void handleRoleSelect(
                          role.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server',
                        );
                      }}
                      className={`group w-full rounded-[24px] border p-4 text-left transition-all ${
                        isRoleLockedByCashierFirstGate
                          ? 'cursor-not-allowed border-slate-200/70 bg-slate-100/80 opacity-65 dark:border-white/10 dark:bg-white/[0.03]'
                          : 'border-slate-200/90 bg-white/95 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_16px_32px_rgba(15,23,42,0.10)] dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/[0.05] dark:hover:shadow-[0_16px_32px_rgba(2,6,23,0.28)]'
                      }`}
                      {...getInteractiveMotion('card')}
                    >
                      <div className="flex items-start gap-4">
                        <div
                          className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border ${rolePresentation.iconSurface}`}
                        >
                          <User className={`h-8 w-8 ${rolePresentation.iconColor}`} strokeWidth={1.8} />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-lg font-black liquid-glass-modal-text">
                              {translateRoleName(role.role_name)}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${
                                role.is_primary
                                  ? rolePresentation.badgeFilled
                                  : rolePresentation.badgeOutline
                              }`}
                            >
                              {role.is_primary
                                ? t('modals.staffShift.primaryRole')
                                : t('modals.staffShift.secondaryRole')}
                            </span>
                            {isRoleLockedByCashierFirstGate && (
                              <span className="inline-flex items-center rounded-full border border-amber-300/80 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
                                {t('modals.staffShift.roleLockedUntilCashier', 'Locked until cashier starts')}
                              </span>
                            )}
                          </div>

                          <p className={`mt-2 ${checkInMutedTextClass}`}>{roleHelper}</p>
                        </div>

                        <ChevronRight className={`mt-1 h-5 w-5 shrink-0 ${rolePresentation.iconColor}`} />
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={checkInFooterClass}>
            {renderCheckInBackButton('enter-pin')}
          </div>
        </div>
      );
    }

    if (checkInStep === 'enter-cash' && selectedStaff) {
      const isStartingCashRole = roleType === 'driver' || roleType === 'server';
      const cashTitle = isStartingCashRole
        ? roleType === 'server'
          ? t('modals.staffShift.serverStartingCashTitle')
          : t('modals.staffShift.driverStartingCashTitle')
        : t('modals.staffShift.cashierOpeningCashTitle');
      const cashHelper = isStartingCashRole
        ? roleType === 'server'
          ? t('modals.staffShift.serverStartingCashHelper')
          : t('modals.staffShift.driverStartingCashHelper')
        : t('modals.staffShift.cashierOpeningCashHelper');
      const cashValue = isStartingCashRole
        ? (!activeCashierExists ? '0,00' : driverStartingAmount)
        : openingCash;

      return (
        <div className="space-y-6" data-testid="staff-cash-section">
          <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            {renderSelectedStaffSummary({
              helper: cashHelper,
              statusLabel: translateRoleName(roleType),
              statusClass: `${selectedRolePresentation.accentBorder} ${selectedRolePresentation.accentSurface} ${selectedRolePresentation.accentText}`,
              highlightedRoleName: roleType,
            })}

            <div className={checkInSurfaceClass}>
              <div className={checkInEyebrowClass}>{t('modals.staffShift.checkInSummaryLabel')}</div>
              <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                {cashTitle}
              </h3>
              <p className={`mt-2 ${checkInMutedTextClass}`}>{cashHelper}</p>

              {(roleType === 'driver' || roleType === 'server') && !activeCashierExists && (
                <div className="mt-5 rounded-[22px] border border-amber-200/90 bg-amber-50/90 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-200" />
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-100">
                      {t('modals.staffShift.noCashierWarning')}
                    </p>
                  </div>
                </div>
              )}

              <div className={`mt-5 ${checkInInsetSurfaceClass}`}>
                <label className={`block ${checkInEyebrowClass}`}>{cashTitle}</label>

                <div className="mt-4 flex items-center gap-4">
                  <div
                    className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[20px] border ${selectedRolePresentation.iconSurface}`}
                  >
                    <Euro className={`h-8 w-8 ${selectedRolePresentation.iconColor}`} />
                  </div>

                  <input
                    type="text"
                    inputMode="decimal"
                    value={cashValue}
                    onChange={(e) => {
                      const val = formatMoneyInputWithCents(e.target.value);
                      if (isStartingCashRole) {
                        setDriverStartingAmount(val);
                      } else {
                        setOpeningCash(val);
                      }
                    }}
                    onFocus={(e) => e.target.select()}
                    placeholder="0,00"
                    className="liquid-glass-modal-input flex-1 text-3xl font-black text-center"
                    readOnly={isStartingCashRole && !activeCashierExists}
                    autoFocus
                  />
                </div>
              </div>

              {showZeroCashConfirm && roleType === 'cashier' && (
                <div className="mt-5 rounded-[22px] border border-amber-200/90 bg-amber-50/90 p-4 dark:border-amber-400/30 dark:bg-amber-500/10">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-200" />
                    <div>
                      <h4 className="font-semibold text-amber-800 dark:text-amber-100">
                        {t('modals.staffShift.zeroCashConfirmTitle')}
                      </h4>
                      <p className="mt-1 text-sm text-amber-700 dark:text-amber-100/90">
                        {t('modals.staffShift.zeroCashConfirmMessage')}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <motion.button
                      onClick={() => setShowZeroCashConfirm(false)}
                      className="inline-flex items-center justify-center rounded-xl border border-slate-200/90 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                      {...getInteractiveMotion('button')}
                    >
                      {t('common.actions.cancel')}
                    </motion.button>
                    <motion.button
                      onClick={() => {
                        setShowZeroCashConfirm(false);
                        void handleCheckIn(true);
                      }}
                      disabled={loading}
                      className="inline-flex items-center justify-center rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition-all hover:bg-amber-700 disabled:opacity-50"
                      {...getInteractiveMotion('primary', loading)}
                    >
                      {t('modals.staffShift.confirmZeroCash')}
                    </motion.button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={checkInFooterClass}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {renderCheckInBackButton('select-role')}

              <div className="flex flex-col gap-3 sm:flex-row">
                {isStartingCashRole && (
                  <motion.button
                    onClick={() => {
                      setDriverStartingAmount('0,00');
                      setError('');
                      void handleCheckIn();
                    }}
                    disabled={loading}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200/90 bg-white/90 px-5 py-3 text-sm font-semibold text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.08]"
                    {...getInteractiveMotion('button', loading)}
                  >
                    {t('modals.staffShift.skipCash')}
                  </motion.button>
                )}

                <motion.button
                  onClick={() => {
                    setError('');
                    void handleCheckIn();
                  }}
                  disabled={
                    loading ||
                      (cashEntryRole &&
                      (roleType === 'driver' || roleType === 'server') &&
                      !activeCashierExists &&
                      parseMoneyInputValue(driverStartingAmount || '0') > 0)
                  }
                  className="inline-flex items-center justify-center gap-3 rounded-xl bg-emerald-600 px-6 py-3.5 text-base font-bold text-white shadow-[0_12px_28px_rgba(5,150,105,0.25)] transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none sm:min-w-[220px]"
                  {...getInteractiveMotion(
                    'primary',
                    loading ||
                      (cashEntryRole &&
                        (roleType === 'driver' || roleType === 'server') &&
                        !activeCashierExists &&
                        parseMoneyInputValue(driverStartingAmount || '0') > 0),
                  )}
                >
                  {loading ? (
                    <>
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      {t('modals.staffShift.openingShift')}
                    </>
                  ) : (
                    <>
                      {t('modals.staffShift.startShift')}
                      <Check className="h-4 w-4" />
                    </>
                  )}
                </motion.button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  // Debug logging
  console.log('🔍 StaffShiftModal render:', {
    isOpen,
    mode,
    localMode,
    effectiveMode,
    activeShift,
    checkoutShift,
    effectiveShift,
    staff
  });

  // Keyboard Shortcuts
  useKeyboardShortcut('ctrl+s', (e) => {
    if (confirmDialog.isOpen && confirmDialog.onConfirm) {
      confirmDialog.onConfirm();
      return;
    }

    // Check constraints to avoid premature submission
    if (loading) return;

    if (effectiveMode === 'checkin') {
      if (checkInStep === 'enter-cash') handleCheckIn();
      else if (checkInStep === 'enter-pin' && enteredPin.length === 4) handlePinSubmit();
    } else if (effectiveMode === 'checkout') {
      handleCheckOut();
    }
  });

  return (
    <>
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={handleModalClose}
        title={effectiveMode === 'checkin' ? t('modals.staffShift.checkIn') : t('modals.staffShift.checkOut')}
        size="xl"
        className={
          effectiveMode === 'checkout'
            ? '!max-w-5xl !w-[92vw] !max-h-[90vh]'
            : '!max-w-4xl !w-[92vw] !max-h-[90vh]'
        }
        closeOnBackdrop={false}
        closeOnEscape={!isModalCloseBlocked}
      >
        {/* Content with Scroll - max height to ensure scrollability */}
        <div className={`flex ${effectiveMode === 'checkout' ? 'max-h-[84vh]' : 'max-h-[84vh]'} flex-col`}>
          <div className="flex-1 space-y-6 overflow-y-auto pr-2 custom-scrollbar">
          {/* Progress Stepper used during Check In/Out */}
          {effectiveMode === 'checkin' && (
            <motion.div
              className="mb-4"
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE }}
            >
              <ProgressStepper steps={progressSteps} />
            </motion.div>
          )}

          {/* Error/Success Messages */}
          {error && <ErrorAlert title={t('common.status.error', 'Error')} message={error} onClose={() => setError('')} className="mb-4" />}
          {success && <ErrorAlert title={t('common.status.success', 'Success')} message={success} severity="success" onClose={() => setSuccess('')} className="mb-4" />}
          {checkoutPaymentBlockers.length > 0 && (
            <UnsettledPaymentBlockersPanel
              blockers={checkoutPaymentBlockers}
              title={t('modals.staffShift.paymentIntegrityTitle', {
                defaultValue: 'Orders Blocking Shift Checkout',
              })}
              helperText={t('modals.staffShift.paymentIntegrityHelper', {
                defaultValue:
                  'These orders belong to the current business day and must be repaired before the cashier can check out.',
              })}
              className="mb-4"
            />
          )}



          {lastShiftResult && effectiveShift?.role_type === 'cashier' && lastShiftResult.breakdown && (
            <div className="space-y-4">
              <div className="flex flex-col items-center justify-center py-4 bg-white/5 dark:bg-gray-800/20 rounded-2xl border liquid-glass-modal-border">
                <span className="text-sm text-gray-400 mb-2">{t('modals.staffShift.varianceLabel', 'Cash Variance')}</span>
                <VarianceBadge variance={lastShiftResult.variance} size="lg" showIcon />
                <p className="text-xs text-gray-500 mt-2 max-w-xs text-center">
                  {lastShiftResult.variance === 0
                    ? t('modals.staffShift.varianceBalanced', 'Perfect! The drawer is balanced.')
                    : lastShiftResult.variance > 0
                      ? t('modals.staffShift.variancePositive', 'Surplus money in drawer.')
                      : t('modals.staffShift.varianceNegative', 'Missing money from drawer.')
                  }
                </p>
              </div>

              {/* Detailed Breakdown Card */}
              <div className={liquidGlassModalCard()}>
                <h4 className="text-sm font-bold liquid-glass-modal-text mb-3 uppercase tracking-wider">{t('modals.staffShift.varianceBreakdown', 'Cash Breakdown')}</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                    <span className="text-gray-400">{t('modals.staffShift.openingCashLabel')}</span>
                    <span className="font-medium text-blue-300">+{(lastShiftResult.breakdown.opening || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                    <span className="text-gray-400">{t('modals.staffShift.cashOrdersLabel')}</span>
                    <span className="font-medium text-green-300">+{(lastShiftResult.breakdown.sales || 0).toFixed(2)}</span>
                  </div>
                  {(lastShiftResult.breakdown.cashRefunds || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.cashRefundsLabel', 'Cash Refunds')}</span>
                      <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.cashRefunds || 0).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                    <span className="text-gray-400">{t('modals.staffShift.expensesLabel')}</span>
                    <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.expenses || 0).toFixed(2)}</span>
                  </div>
                  {(lastShiftResult.breakdown.cashDrops || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.cashDropsLabel', 'Cash Drops')}</span>
                      <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.cashDrops || 0).toFixed(2)}</span>
                    </div>
                  )}
                  {(lastShiftResult.breakdown.driverGiven || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.driverCashGivenLabel', 'Driver Cash Given')}</span>
                      <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.driverGiven || 0).toFixed(2)}</span>
                    </div>
                  )}
                  {(lastShiftResult.breakdown.driverReturned || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.driverCashReturnedLabel', 'Driver Cash Returned')}</span>
                      <span className="font-medium text-green-300">+{(lastShiftResult.breakdown.driverReturned || 0).toFixed(2)}</span>
                    </div>
                  )}
                  {(lastShiftResult.breakdown.inheritedDriverExpectedReturns || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns')}</span>
                      <span className="font-medium text-green-300">+{(lastShiftResult.breakdown.inheritedDriverExpectedReturns || 0).toFixed(2)}</span>
                    </div>
                  )}
                  {(lastShiftResult.breakdown.deductedStaffPayments || 0) > 0 && (
                    <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                      <span className="text-gray-400">{t('modals.staffShift.staffPaymentsDeductedLabel', 'Staff Payouts')}</span>
                      <span className="font-medium text-red-300">-{formatCurrency(lastShiftResult.breakdown.deductedStaffPayments || 0)}</span>
                    </div>
                  )}
                  <div className="h-px bg-white/10 my-1"></div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-medium">
                    <span className="text-gray-300">{t('modals.staffShift.expectedAmountLabel')}</span>
                    <span className="text-blue-300">{formatCurrency(lastShiftResult.breakdown.expected || 0)}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-bold">
                    <span className="text-white">
                      {t('modals.staffShift.closingCashLabel')} ({t('modals.staffShift.actualLabel', 'Actual')})
                    </span>
                    <span className="text-white">{formatCurrency(lastShiftResult.breakdown.actual || 0)}</span>
                  </div>
                  {(lastShiftResult.breakdown.recordedStaffPayments || 0) > 0 && (
                    <>
                      <div className="h-px bg-white/10 my-1"></div>
                      <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                        <span className="text-gray-400">{t('modals.staffShift.totalStaffPayments')}</span>
                        <span className="font-medium text-yellow-300">{formatCurrency(lastShiftResult.breakdown.recordedStaffPayments || 0)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Fallback for other roles or missing breakdown */}
          {lastShiftResult && !lastShiftResult.breakdown && (
            <div className="flex justify-center">
              <VarianceBadge variance={lastShiftResult.variance} size="md" />
            </div>
          )}

          <AnimatePresence mode="wait" initial={false} custom={contentDirection}>
            <motion.div
              key={contentPaneKey}
              custom={contentDirection}
              variants={checkInPaneVariants}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {effectiveMode === 'checkin' ? renderCheckInContent() : renderCheckoutContent()}
            </motion.div>
          </AnimatePresence>

          {false && effectiveMode === 'checkout' && (
            // Check-out Form - SIMPLIFIED
            <div className="space-y-4" data-testid="staff-checkout-section">
              {/* Shift Summary */}
              {localMode === 'checkout' && (
                <button
                  onClick={() => {
                    setLocalMode(null);
                    setCheckoutShift(null);
                    setCheckInStep('select-staff');
                    setSelectedStaff(null);
                    setError('');
                  }}
                  className="px-4 py-2 bg-white/10 dark:bg-gray-800/20 rounded-lg shadow-[0_2px_8px_0_rgba(59,130,246,0.2)] hover:shadow-[0_4px_12px_0_rgba(59,130,246,0.35)] text-sm flex items-center gap-2 hover:gap-3 transition-all duration-300 liquid-glass-modal-text"
                >
                  <ChevronRight className="w-4 h-4 rotate-180" />
                  {t('modals.staffShift.backToStaffSelection')}
                </button>
              )}

              {checkoutHeaderData && (
                checkoutHeaderData!.minimal ? (
                  <POSGlassCard
                    variant={checkoutHeaderData!.variant}
                    size="large"
                    className="overflow-hidden border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-emerald-50/70 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/15 dark:bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] dark:shadow-[0_18px_40px_rgba(2,6,23,0.34)]"
                  >
                    <div className="space-y-4">
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">
                          {checkoutHeaderData!.roleLabel}
                        </div>
                        <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                          {effectiveShift?.staff_name || checkoutHeaderData!.roleLabel}
                        </h3>
                        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
                          {checkoutHeaderData!.shiftWindow}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)] md:p-5 dark:border-white/10 dark:bg-black/20 dark:shadow-none">
                        <div className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                          {checkoutHeaderData!.primaryLabel}
                        </div>
                        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/80">
                          {checkoutHeaderData!.helper}
                        </p>
                      </div>
                    </div>
                  </POSGlassCard>
                ) : (
                  <POSGlassCard
                    variant={checkoutHeaderData!.variant}
                    size="large"
                    className="overflow-hidden border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-blue-50/70 shadow-[0_18px_40px_rgba(15,23,42,0.08)] dark:border-white/15 dark:bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] dark:shadow-[0_18px_40px_rgba(2,6,23,0.34)]"
                  >
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-xs uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">
                            {checkoutHeaderData!.roleLabel}
                          </div>
                          <h3 className="mt-2 text-2xl font-black tracking-tight liquid-glass-modal-text">
                            {effectiveShift?.staff_name || checkoutHeaderData!.roleLabel}
                          </h3>
                          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300/80">
                            {checkoutHeaderData!.shiftWindow}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-slate-200/80 bg-white/85 px-4 py-3 text-right shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-black/15 dark:shadow-none">
                          <div className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                            {t('modals.staffShift.ordersCount', 'Orders')}
                          </div>
                          <div className="mt-1 text-3xl font-black text-slate-950 dark:text-white">
                            {checkoutHeaderData!.headerMetrics.totalCount}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-[1.4fr,1fr]">
                        <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)] md:p-5 dark:border-white/10 dark:bg-black/20 dark:shadow-none">
                          <div className="text-xs uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
                            {checkoutHeaderData!.primaryLabel}
                          </div>
                          <div className="mt-2 text-4xl font-black tracking-tight text-slate-950 dark:text-white">
                            {formatCurrency(checkoutHeaderData!.primaryAmount)}
                          </div>
                          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300/80">
                            {checkoutHeaderData!.helper}
                          </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
                          <div className="rounded-2xl border border-slate-200/80 bg-slate-50/90 p-4 dark:border-white/10 dark:bg-white/5">
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                            </div>
                            <div className="mt-1 text-2xl font-bold text-emerald-300">
                              {formatCurrency(checkoutHeaderData!.headerMetrics.totalAmount)}
                            </div>
                          </div>
                          <div className="rounded-2xl border border-slate-200/80 bg-slate-50/90 p-4 dark:border-white/10 dark:bg-white/5">
                            <div className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                              {effectiveShift?.role_type === 'cashier'
                                ? t('modals.staffShift.openingCashLabel')
                                : t('modals.staffShift.startingAmount', 'Starting Amount')}
                            </div>
                            <div className="mt-1 text-2xl font-bold text-cyan-300">
                              {formatCurrency(checkoutHeaderData!.openingAmount)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </POSGlassCard>
                )
              )}

              {/* CASH RECONCILIATION - Only for Cashier */}
              {shiftSummary && effectiveShift?.role_type === 'cashier' && (
                (() => {
                  const openingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                  const cashierBreakdown = getCashierExpectedBreakdown(
                    shiftSummary,
                    effectiveShift,
                    openingAmount,
                    shiftSummary.totalExpenses || 0
                  );

                  return (
                  <div className="space-y-3">
                  {/* Header */}
                  <div className="bg-gradient-to-r from-yellow-500/20 to-amber-500/20 rounded-xl p-4 border border-yellow-500/30">
                    <h3 className="text-lg font-bold text-yellow-300 mb-1">{t('modals.staffShift.cashReconciliation')}</h3>
                    <p className="text-xs text-yellow-200/70">{t('modals.staffShift.reviewAndConfirm')}</p>
                  </div>

                  {/* Main Calculation Flow */}
                  <div className="space-y-2">
                    {/* Opening */}
                    <div className="flex justify-between items-center p-3 bg-blue-900/30 rounded-lg border border-blue-600/40">
                      <span className="text-sm text-blue-200">{t('modals.staffShift.openingCashLabel')}</span>
                      <span className="font-bold text-blue-300">{formatCurrency(openingAmount)}</span>
                    </div>

                    {/* Plus Cash Orders */}
                    <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                      <span className="text-sm text-green-200">{t('modals.staffShift.cashOrdersLabel')}</span>
                      <span className="font-bold text-green-300">{formatCurrency(cashierBreakdown.sales)}</span>
                    </div>

                    {/* Minus Canceled */}
                    {shiftSummary.canceledOrders?.cashTotal > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.canceledOrdersLabel')}</span>
                        <span className="font-bold text-red-300">{formatCurrency(shiftSummary.canceledOrders?.cashTotal || 0)}</span>
                      </div>
                    )}

                    {/* Minus Expenses */}
                    {shiftSummary.totalExpenses > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.expensesLabel')}</span>
                        <span className="font-bold text-red-300">{formatCurrency(shiftSummary.totalExpenses || 0)}</span>
                      </div>
                    )}

                    {/* Minus Cash Drops */}
                    {(shiftSummary.cashDrawer?.cash_drops || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.cashDropsLabel')}</span>
                        <span className="font-bold text-red-300">-{formatCurrency(shiftSummary.cashDrawer?.cash_drops || 0)}</span>
                      </div>
                    )}

                    {/* Minus Cash Refunds */}
                    {(shiftSummary.cashRefunds || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.cashRefundsLabel')}</span>
                        <span className="font-bold text-red-300">-{formatCurrency(shiftSummary.cashRefunds || 0)}</span>
                      </div>
                    )}

                    {/* Minus Driver Cash Given */}
                    {(cashierBreakdown.driverGiven || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.driverCashGivenLabel', 'Starting Cash Given To Drivers/Waiters')}</span>
                        <span className="font-bold text-red-300">-{formatCurrency(cashierBreakdown.driverGiven || 0)}</span>
                      </div>
                    )}

                    {/* Plus Driver Cash Returned */}
                    {(shiftSummary.cashDrawer?.driver_cash_returned || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                        <span className="text-sm text-green-200">{t('modals.staffShift.driverCashReturnedLabel')}</span>
                        <span className="font-bold text-green-300">+{formatCurrency(shiftSummary.cashDrawer?.driver_cash_returned || 0)}</span>
                      </div>
                    )}

                    {(cashierBreakdown.deductedStaffPayments || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.staffPaymentsDeductedLabel', 'Staff Payouts')}</span>
                        <span className="font-bold text-red-300">-{formatCurrency(cashierBreakdown.deductedStaffPayments || 0)}</span>
                      </div>
                    )}

                    {/* Individual Driver/Waiter Breakdown Cards */}
                    {shiftSummary.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (
                      <details className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/10 dark:bg-white/5">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-slate-700 transition-colors hover:text-slate-950 dark:text-slate-200 dark:hover:text-white [&::-webkit-details-marker]:hidden">
                          <span>{t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns')}</span>
                          <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-slate-500 dark:border-white/10 dark:bg-white/10 dark:text-slate-300">
                            {shiftSummary.driverDeliveries.length}
                          </span>
                        </summary>
                        <div className="mt-4 space-y-2">
                          {(() => {
                          // Aggregate by driver_id to show one card per driver
                          const driverMap = new Map<string, { name: string; role: string; starting: number; earnings: number; expenses: number }>();
                          for (const d of shiftSummary.driverDeliveries) {
                            const id = d.driver_id || d.shift_id;
                            if (!driverMap.has(id)) {
                              driverMap.set(id, {
                                name: d.driver_name || 'Driver',
                                role: d.role_type || t('modals.staffShift.driverRole'),
                                starting: d.starting_amount || 0,
                                earnings: 0,
                                expenses: d.expenses || 0
                              });
                            }
                            // Sum up earnings (cash_collected) for each driver
                            const driver = driverMap.get(id)!;
                            driver.earnings += (d.cash_collected || 0);
                          }

                          return Array.from(driverMap.entries()).map(([id, driver]) => {
                            const returns = driver.starting + driver.earnings - driver.expenses;
                            const isPositive = returns >= 0;

                            return (
                              <div key={id} className={`p-3 rounded-xl border ${isPositive
                                ? 'bg-gradient-to-r from-amber-50 to-emerald-50 border-amber-300/60 dark:from-red-900/20 dark:to-green-900/20 dark:border-amber-600/40'
                                : 'bg-red-50 border-red-300/60 dark:bg-red-900/30 dark:border-red-600/40'}`}>
                                <div className="flex justify-between items-start mb-2">
                                  <div>
                                    <span className="text-xs uppercase text-slate-500 dark:text-gray-400">{driver.role}</span>
                                    <div className="font-semibold text-slate-900 dark:text-white">{driver.name}</div>
                                  </div>
                                </div>
                                <div className="space-y-1 text-sm">
                                  <div className="flex justify-between text-red-300">
                                    <span>{t('modals.staffShift.driverStarting')}</span>
                                    <span>-€{driver.starting.toFixed(2)}</span>
                                  </div>
                                  <div className="flex justify-between text-green-300">
                                    <span>+ {t('modals.staffShift.driverEarnings')}</span>
                                    <span>+€{driver.earnings.toFixed(2)}</span>
                                  </div>
                                  {driver.expenses > 0 && (
                                    <div className="flex justify-between text-red-300">
                                      <span>- {t('modals.staffShift.expenses')}</span>
                                      <span>-€{driver.expenses.toFixed(2)}</span>
                                    </div>
                                  )}
                                  <div className={`flex justify-between border-t border-slate-200/80 pt-1 font-bold dark:border-white/20 ${isPositive ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                                    <span>= {isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}</span>
                                    <span>{isPositive ? '+' : '-'}€{Math.abs(returns).toFixed(2)}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                        </div>
                      </details>
                    )}

                    {/* Plus transferred staff returns */}
                    {(() => {
                      const inheritedDrivers = shiftSummary?.transferredDrivers || [];
                      const inheritedWaiters = shiftSummary?.transferredWaiters || [];
                      const inheritedDriverExpectedReturns = getInheritedStaffExpectedReturns(shiftSummary);
                      if (inheritedDriverExpectedReturns <= 0) return null;
                      return (
                        <div className="flex justify-between items-center p-3 bg-purple-900/30 rounded-lg border border-purple-600/40">
                          <div className="flex flex-col">
                            <span className="text-sm text-purple-200">{t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns')}</span>
                            <span className="text-xs text-purple-300/70">
                              {inheritedDrivers.length + inheritedWaiters.length} {t('modals.staffShift.transferredDriversCount', 'staff transferred to this cashier')}
                            </span>
                          </div>
                          <span className="font-bold text-purple-300">+{formatCurrency(inheritedDriverExpectedReturns)}</span>
                        </div>
                      );
                    })()}

                    {/* Expected Amount */}
                    {(() => {
                      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                      const breakdown = getCashierExpectedBreakdown(
                        shiftSummary,
                        effectiveShift,
                        opening,
                        shiftSummary.totalExpenses || 0
                      );
                      const expected = breakdown.expected;
                      return (
                        <>
                          <div className="flex justify-between items-center p-3 bg-cyan-900/30 rounded-lg border-2 border-cyan-500/50 font-semibold">
                            <span className="text-sm text-cyan-200">{t('modals.staffShift.expectedAmountLabel')}</span>
                            <span className="text-lg text-cyan-300">{formatCurrency(expected)}</span>
                          </div>
                          {/* Formula Explanation */}
                          <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600/30 mt-2">
                            <p className="text-xs text-slate-400 text-center">
                              <span className="font-semibold text-slate-300">{t('receipt.formula.label')}</span>{' '}
                              {t('receipt.formula.cashier')}
                            </p>
                            <p className="text-xs text-slate-500 text-center mt-1">
                              {t('receipt.formula.note.staffPayments')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
                  );
                })()
              )}

              {/* Expenses Section */}
              {!isNonFinancialCheckoutRole && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.expenses')}</h3>
                    {canRecordInlineExpenses && (
                      <button
                        onClick={() => setShowExpenseForm(!showExpenseForm)}
                        className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-[0_2px_8px_0_rgba(59,130,246,0.4)] transition-all duration-300"
                      >
                        <Plus className="w-4 h-4" />
                        {t('modals.staffShift.addExpense')}
                      </button>
                    )}
                  </div>

                  {!canRecordInlineExpenses && (
                    <p className="text-xs text-gray-400 mb-4">
                      {t('modals.staffShift.expensesReadOnly', {
                        defaultValue:
                          'Expenses are recorded from cashier checkout. Existing shift expenses are shown here for reference.',
                      })}
                    </p>
                  )}

                  {canRecordInlineExpenses && showExpenseForm && (
                    <div className={liquidGlassModalCard() + ' space-y-3 mb-4'}>
                      <select
                        value={expenseType}
                        onChange={(e) => setExpenseType(e.target.value as 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other')}
                        className="liquid-glass-modal-input text-sm"
                      >
                        <option value="supplies">{getExpenseTypeLabel('supplies')}</option>
                        <option value="maintenance">{getExpenseTypeLabel('maintenance')}</option>
                        <option value="petty_cash">{getExpenseTypeLabel('petty_cash')}</option>
                        <option value="refund">{getExpenseTypeLabel('refund')}</option>
                        <option value="other">{getExpenseTypeLabel('other')}</option>
                      </select>

                      <input
                        type="text"
                        inputMode="decimal"
                        value={expenseAmount}
                        onChange={(e) => {
                          const val = e.target.value.replace(/[^0-9.]/g, '');
                          setExpenseAmount(val);
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder="0,00"
                        className="liquid-glass-modal-input text-sm"
                      />

                      <input
                        type="text"
                        value={expenseDescription}
                        onChange={(e) => setExpenseDescription(e.target.value)}
                        placeholder={expenseDescriptionPlaceholder}
                        className="liquid-glass-modal-input text-sm"
                      />

                      <input
                        type="text"
                        value={expenseReceipt}
                        onChange={(e) => setExpenseReceipt(e.target.value)}
                        placeholder={expenseReceiptPlaceholder}
                        className="liquid-glass-modal-input text-sm"
                      />

                      <button
                        onClick={handleRecordExpense}
                        disabled={loading}
                        className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg text-sm shadow-[0_4px_16px_0_rgba(16,185,129,0.5)] hover:shadow-[0_6px_20px_0_rgba(16,185,129,0.6)] transition-all duration-300"
                      >
                        {recordExpenseLabel}
                      </button>
                    </div>
                  )}

                  {expenses.length > 0 ? (
                    <div className="space-y-2">
                      {expenses.map((expense) => (
                        <div key={expense.id} className="flex items-center justify-between p-3 bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border rounded-xl text-sm">
                          <div className="flex-1">
                            <div className="font-medium liquid-glass-modal-text">{expense.description}</div>
                            <div className="liquid-glass-modal-text-muted capitalize text-xs">{getExpenseTypeLabel(expense.expense_type)}</div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                            <div className="font-semibold liquid-glass-modal-text">{formatCurrency(expense.amount)}</div>
                            <div className={`text-xs ${expense.status === 'approved' ? 'text-green-400' :
                              expense.status === 'rejected' ? 'text-red-400' :
                                'text-yellow-400'
                              }`}>
                              {getExpenseStatusLabel(expense.status)}
                            </div>
                            <button
                              type="button"
                              disabled={deletingExpenseId === expense.id}
                              onClick={() =>
                                openConfirm({
                                  title: t('modals.expense.deleteExpenseConfirmTitle', {
                                    defaultValue: 'Delete expense',
                                  }),
                                  message: t(
                                    'modals.expense.deleteExpenseConfirmMessage',
                                    'Delete "{{description}}"? This will immediately remove it from the drawer totals.',
                                    {
                                      description:
                                        expense.description ||
                                        t('modals.expense.untitledExpense', {
                                          defaultValue: 'Untitled expense',
                                        }),
                                    },
                                  ),
                                  variant: 'error',
                                  confirmText: deleteExpenseLabel,
                                  cancelText: t('common.actions.cancel', {
                                    defaultValue: 'Cancel',
                                  }),
                                  onConfirm: () => {
                                    void handleDeleteExpense(expense);
                                  },
                                })
                              }
                              className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {deleteExpenseLabel}
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-3 border-t liquid-glass-modal-border">
                        <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalExpenses')}:</span>
                        <span className="font-bold text-red-400 text-lg">{formatCurrency(totalExpenses)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{noExpensesLabel}</p>
                  )}
                </div>
              )}

              {/* Driver Deliveries Section */}
              {effectiveShift?.role_type === 'driver' && shiftSummary?.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (() => {
                const deliveries = shiftSummary.driverDeliveries;
                const totalOrders = deliveries.length;

                const cashOrders = deliveries.filter((d: any) => (d.payment_method || '').toLowerCase() === 'cash');
                const cashTotal = cashOrders.reduce((sum: number, d: any) => sum + (d.total_amount || 0), 0);
                const cashCount = cashOrders.length;

                const cardOrders = deliveries.filter((d: any) => (d.payment_method || '').toLowerCase() === 'card');
                const cardTotal = cardOrders.reduce((sum: number, d: any) => sum + (d.total_amount || 0), 0);
                const cardCount = cardOrders.length;

                const canceledOrders = deliveries.filter((d: any) => {
                  const s = (d.status || d.order_status || '').toLowerCase();
                  return s === 'cancelled' || s === 'canceled' || s === 'refunded';
                });
                const canceledCount = canceledOrders.length;

                return (
                  <div className="space-y-4">
                    {/* 1. Summary Statistics */}
                    <div className={liquidGlassModalCard() + " p-4"}>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderSummary', 'Order Summary')}</h3>
                        <div className="flex gap-2">
                          <POSGlassBadge variant="info">{totalOrders} {t('modals.staffShift.totalOrders', 'Total')}</POSGlassBadge>
                          {canceledCount > 0 && (
                            <POSGlassBadge variant="error">
                              <span className="inline-flex items-center gap-1">
                                <XCircle className="w-3 h-3" />
                                {canceledCount} {t('modals.staffShift.canceledOrders', 'Canceled')}
                              </span>
                            </POSGlassBadge>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-green-200">{t('modals.staffShift.cashOrders', 'Cash Orders')}</span>
                            <span className="font-bold text-green-400 text-lg">{cashCount}</span>
                          </div>
                          <div className="text-right">
                            <Banknote className="w-5 h-5 text-green-300 ml-auto" />
                            <div className="font-bold text-green-300">{formatCurrency(cashTotal)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 text-blue-300 ml-auto" />
                            <div className="font-bold text-blue-300">{formatCurrency(cardTotal)}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 2. Compact Order Details Table */}
                    <div className={liquidGlassModalCard()}>
                      <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => setShowOrderDetailsTable(!showOrderDetailsTable)}>
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderDetails', 'Order Details')}</h3>
                        <button
                          className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                          aria-label={showOrderDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                          aria-expanded={showOrderDetailsTable}
                        >
                          {showOrderDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                        </button>
                      </div>

                      {showOrderDetailsTable && (
                        <div className="overflow-x-auto max-h-64 overflow-y-auto scrollbar-hide rounded-lg border border-white/5 animate-in fade-in slide-in-from-top-2 duration-200">
                          <table className="w-full text-sm text-left" role="table">
                            <thead className="text-xs uppercase bg-white/5 text-gray-400 sticky top-0 backdrop-blur-md">
                              <tr role="row">
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.orderNoHeader', 'No.')}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.orderAddressHeader', 'Address')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-right">{t('modals.staffShift.orderAmountHeader', 'Amount')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-center">{t('modals.staffShift.orderStatusHeader', 'Status')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5" role="rowgroup">
                              {deliveries.map((delivery: any, index: number) => {
                                const orderLabel = delivery.order_number ? `#${delivery.order_number}` : `#${index + 1}`;
                                return (
                                  <tr key={delivery.id} className="hover:bg-white/5 transition-colors" role="row">
                                    <td className="px-3 py-2 font-medium liquid-glass-modal-text" role="cell">{orderLabel}</td>
                                    <td className="px-3 py-2 text-gray-300 truncate max-w-[150px]" title={delivery.delivery_address} role="cell">
                                      {delivery.delivery_address ? (delivery.delivery_address.length > 25 ? delivery.delivery_address.substring(0, 25) + '...' : delivery.delivery_address) : '-'}
                                    </td>
                                    <td className="px-3 py-2 text-right font-medium text-gray-200" role="cell">{formatCurrency(delivery.total_amount)}</td>
                                    <td className="px-3 py-2 text-center" role="cell">
                                      <span className="inline-flex gap-1 items-center justify-center bg-black/20 px-1.5 py-0.5 rounded text-xs">
                                        <span>{getStatusSymbol(delivery)}</span>
                                        <span>{getPaymentSymbol(delivery.payment_method)}</span>
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* 3. Detailed Delivery Cards (Existing) */}
                    <div className={liquidGlassModalCard()}>
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold liquid-glass-modal-text">Driver Deliveries</h3>
                          <POSGlassBadge variant="success">{deliveries.length - canceledCount} {t('modals.staffShift.completedOrdersLabel', 'Completed')}</POSGlassBadge>
                        </div>
                        <button
                          onClick={() => setShowDetailedView(!showDetailedView)}
                          className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all duration-300 border border-white/10"
                          aria-label={showDetailedView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                          aria-expanded={showDetailedView}
                        >
                          {showDetailedView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                        </button>
                      </div>

                      {showDetailedView && (
                        <div className="space-y-3 max-h-96 overflow-y-auto scrollbar-hide animate-in fade-in slide-in-from-top-4 duration-300">
                          {deliveries.map((delivery: any) => (
                            <div key={delivery.id} className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-4 border liquid-glass-modal-border mb-3">
                              {/* Order Header */}
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <div className="font-semibold liquid-glass-modal-text">Order #{delivery.order_number}</div>
                                  <div className="liquid-glass-modal-text-muted text-sm">{formatCurrency(delivery.total_amount)}</div>
                                </div>
                                <div className={`text-xs px-2 py-1 rounded ${delivery.payment_method === 'cash' ? 'bg-green-900/50 text-green-400' :
                                  delivery.payment_method === 'card' ? 'bg-blue-900/50 text-blue-400' :
                                    'bg-purple-900/50 text-purple-400'
                                  }`}>
                                  {delivery.payment_method.toUpperCase()}
                                </div>
                              </div>

                              {/* Customer Info */}
                              <div className="space-y-2 mb-3 pb-3 border-b liquid-glass-modal-border">
                                <div className="text-sm">
                                  <span className="liquid-glass-modal-text-muted">Customer: </span>
                                  <span className="liquid-glass-modal-text">{delivery.customer_name}</span>
                                </div>
                                {delivery.customer_phone && (
                                  <div className="text-sm">
                                    <span className="liquid-glass-modal-text-muted">Phone: </span>
                                    <span className="liquid-glass-modal-text">{delivery.customer_phone}</span>
                                  </div>
                                )}
                                {delivery.customer_email && (
                                  <div className="text-sm">
                                    <span className="liquid-glass-modal-text-muted">Email: </span>
                                    <span className="liquid-glass-modal-text text-xs break-all">{delivery.customer_email}</span>
                                  </div>
                                )}
                              </div>

                              {/* Delivery Address */}
                              {delivery.delivery_address && (
                                <div className="mb-3 pb-3 border-b liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted text-xs mb-1">Delivery Address</div>
                                  <div className="liquid-glass-modal-text text-sm break-words">{delivery.delivery_address}</div>
                                </div>
                              )}

                              {/* Earnings Breakdown */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Delivery Fee</div>
                                  <div className="font-semibold text-green-400">{formatCurrency(delivery.delivery_fee)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Tip</div>
                                  <div className="font-semibold text-green-400">{formatCurrency(delivery.tip_amount)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash Collected</div>
                                  <div className="font-semibold liquid-glass-modal-text">{formatCurrency(delivery.cash_collected)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash to Return</div>
                                  <div className="font-semibold text-yellow-400">{formatCurrency(delivery.cash_to_return)}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Waiter Checkout Section */}
              {effectiveShift?.role_type === 'server' && shiftSummary?.waiterTables && (() => {
                const waiterTables = shiftSummary.waiterTables;
                const totalTables = waiterTables.length;
                const totalOrders = waiterTables.reduce((sum: number, t: any) => sum + t.order_count, 0);

                const cashTotal = waiterTables.reduce((sum: number, t: any) => sum + t.cash_amount, 0);
                const cardTotal = waiterTables.reduce((sum: number, t: any) => sum + t.card_amount, 0);

                // Calculate counts based on orders within tables for accurate summary
                let cashCount = 0;
                let cardCount = 0;
                let canceledCount = 0;

                waiterTables.forEach((t: any) => {
                  const safeOrders = Array.isArray(t.orders) ? t.orders : [];
                  safeOrders.forEach((o: any) => {
                    const status = (o.status || '').toLowerCase();
                    if (status === 'cancelled' || status === 'canceled') {
                      canceledCount++;
                    }
                    const pm = (o.payment_method || '').toLowerCase();
                    if (pm === 'cash') cashCount++;
                    else if (pm === 'card') cardCount++;
                  });
                });

                return (
                  <div className="space-y-4">
                    {/* 1. Summary Statistics */}
                    <div className={liquidGlassModalCard() + " p-4"}>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderSummary', 'Order Summary')}</h3>
                        <div className="flex gap-2">
                          <POSGlassBadge variant="info">{totalTables} {t('modals.staffShift.tablesServed', 'Tables Served')}</POSGlassBadge>
                          <POSGlassBadge variant="info">{totalOrders} {t('modals.staffShift.ordersCount', 'Orders')}</POSGlassBadge>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-green-900/20 border border-green-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-green-200">{t('modals.staffShift.cashOrders', 'Cash Orders')}</span>
                            <span className="font-bold text-green-400 text-lg">{cashCount}</span>
                          </div>
                          <div className="text-right">
                            <Banknote className="w-5 h-5 text-green-300 ml-auto" />
                            <div className="font-bold text-green-300">{formatCurrency(cashTotal)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 text-blue-300 ml-auto" />
                            <div className="font-bold text-blue-300">{formatCurrency(cardTotal)}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 2. Compact Table Details Table */}
                    <div className={liquidGlassModalCard()}>
                      <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => setShowTableDetailsTable(!showTableDetailsTable)}>
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.tableDetails', 'Table Details')}</h3>
                        <button
                          className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                          aria-label={showTableDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                          aria-expanded={showTableDetailsTable}
                        >
                          {showTableDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                        </button>
                      </div>

                      {showTableDetailsTable && (
                        <div className="overflow-x-auto max-h-64 overflow-y-auto scrollbar-hide rounded-lg border border-white/5 animate-in fade-in slide-in-from-top-2 duration-200">
                          <table className="w-full text-sm text-left" role="table">
                            <thead className="text-xs uppercase bg-white/5 text-gray-400 sticky top-0 backdrop-blur-md">
                              <tr role="row">
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.tableNumber', 'Table')}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.ordersCount', 'Orders')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-right">{t('modals.staffShift.orderAmountHeader', 'Amount')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-center">{t('modals.staffShift.orderStatusHeader', 'Status')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5" role="rowgroup">
                              {waiterTables.map((table: any) => {
                                const safeOrders = Array.isArray(table.orders) ? table.orders : [];
                                // Determine status symbol for table (if any active order checkmark, else X)
                                const hasActive = safeOrders.some((o: any) => {
                                  const s = (o.status || '').toLowerCase();
                                  return s !== 'cancelled' && s !== 'canceled';
                                });

                                return (
                                  <tr key={table.table_number} className="hover:bg-white/5 transition-colors" role="row">
                                    <td className="px-3 py-2 font-medium liquid-glass-modal-text" role="cell">{table.table_number}</td>
                                    <td className="px-3 py-2 text-gray-300" role="cell">{table.order_count}</td>
                                    <td className="px-3 py-2 text-right font-medium text-gray-200" role="cell">{formatCurrency(table.total_amount)}</td>
                                    <td className="px-3 py-2 text-center" role="cell">
                                      <span className="inline-flex gap-1 items-center justify-center bg-black/20 px-1.5 py-0.5 rounded text-xs">
                                        {hasActive ? (
                                          <CheckCircle className="w-3 h-3 text-green-400" />
                                        ) : (
                                          <XCircle className="w-3 h-3 text-red-400" />
                                        )}
                                        <span className="inline-flex">{getPaymentSymbol(table.payment_method)}</span>
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* 3. Detailed Table Consumption Cards */}
                    <div className={liquidGlassModalCard()}>
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold liquid-glass-modal-text">{t('modals.staffShift.tableConsumption', 'Table Consumption')}</h3>
                          <POSGlassBadge variant="success">{totalTables} {t('modals.staffShift.tablesServed', 'Tables')}</POSGlassBadge>
                        </div>
                        <button
                          onClick={() => setShowDetailedTableView(!showDetailedTableView)}
                          className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all duration-300 border border-white/10"
                          aria-label={showDetailedTableView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                          aria-expanded={showDetailedTableView}
                        >
                          {showDetailedTableView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                        </button>
                      </div>

                      {showDetailedTableView && (
                        <div className="space-y-3 max-h-96 overflow-y-auto scrollbar-hide animate-in fade-in slide-in-from-top-4 duration-300">
                          {waiterTables.map((table: any) => (
                            <div key={table.table_number} className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-4 border liquid-glass-modal-border mb-3">
                              {/* Table Header */}
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <div className="font-semibold liquid-glass-modal-text">
                                    {t('modals.staffShift.tableNumber')} {table.table_number}
                                  </div>
                                  <div className="liquid-glass-modal-text-muted text-sm">
                                    {t('modals.staffShift.ordersCountValue', { count: table.order_count })}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="font-bold text-green-400">{formatCurrency(table.total_amount)}</div>
                                  <div className={`text-xs px-2 py-1 rounded inline-block mt-1 ${table.payment_method === 'cash' ? 'bg-green-900/50 text-green-400' :
                                    table.payment_method === 'card' ? 'bg-blue-900/50 text-blue-400' :
                                      'bg-purple-900/50 text-purple-400'
                                    }`}>
                                    {table.payment_method.toUpperCase()}
                                  </div>
                                </div>
                              </div>

                              {/* Order List */}
                              <div className="space-y-1 mb-3 pb-3 border-b liquid-glass-modal-border">
                                {table.orders && Array.isArray(table.orders) ? table.orders.map((order: any) => (
                                  <div key={order.order_id} className="flex justify-between text-xs">
                                    <span className="liquid-glass-modal-text-muted">#{order.order_number}</span>
                                    <span className="liquid-glass-modal-text">{formatCurrency(order.total_amount)} ({order.payment_method})</span>
                                  </div>
                                )) : null}
                              </div>

                              {/* Breakdown */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash</div>
                                  <div className="font-semibold text-green-400">{formatCurrency(table.cash_amount)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Card</div>
                                  <div className="font-semibold text-blue-400">{formatCurrency(table.card_amount)}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Comment 2: UI indication of cash to return */}
                    {
                      (() => {
                        const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                        const expensesTotal = shiftSummary.totalExpenses || 0;
                        // Calculate totals from waiterTables array
                        const cashFromTables = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);

                        // Read calculation_version from shift (default to 1 for legacy shifts)
                        const calculationVersion = effectiveShift.calculation_version || 1;
                        const paymentAmount = effectiveShift.payment_amount || 0;

                        // Version-aware formula:
                        // v1 (legacy): cashToReturn = starting + collected - expenses - payment
                        // v2 (current): cashToReturn = starting + collected - expenses (payment handled at cashier checkout)
                        const cashToReturn = calculationVersion >= 2
                          ? opening + cashFromTables - expensesTotal
                          : opening + cashFromTables - expensesTotal - paymentAmount;

                        const label = cashToReturn >= 0 ? t('modals.staffShift.amountToReturn', { defaultValue: 'Amount to collect from drawer' }) : t('modals.staffShift.shortage', 'Shortage');
                        const colorClass = cashToReturn >= 0 ? 'text-cyan-300' : 'text-red-400';

                        return (
                          <div className={liquidGlassModalCard() + " p-4 mt-2"}>
                            <h3 className="text-md font-bold liquid-glass-modal-text mb-3">{t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}</h3>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.startingAmount', 'Starting Amount')}</span>
                                <span className="text-green-400">+{formatCurrency(opening)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.cashCollected', 'Cash Collected')}</span>
                                <span className="text-green-400">+{formatCurrency(cashFromTables)}</span>
                              </div>
                              <div className={`flex justify-between ${calculationVersion >= 2 ? 'border-b liquid-glass-modal-border pb-2' : ''}`}>
                                <span className="text-gray-400">{t('modals.staffShift.expenses', 'Expenses')}</span>
                                <span className="text-red-400">-{formatCurrency(expensesTotal)}</span>
                              </div>
                              {/* v1: Show payment as deduction in the breakdown */}
                              {calculationVersion < 2 && paymentAmount > 0 && (
                                <div className="flex justify-between border-b liquid-glass-modal-border pb-2">
                                  <span className="text-gray-400">{t('modals.staffShift.payment', 'Payment')}</span>
                                  <span className="text-red-400">-{formatCurrency(paymentAmount)}</span>
                                </div>
                              )}
                              {/* v1: Add border after expenses if no payment */}
                              {calculationVersion < 2 && paymentAmount === 0 && (
                                <div className="border-b liquid-glass-modal-border"></div>
                              )}
                              <div className="flex justify-between pt-1 font-bold text-lg">
                                <span className="text-gray-200">{label}</span>
                                <span className={colorClass}>{formatCurrency(Math.abs(cashToReturn))}</span>
                              </div>
                              {/* Formula Explanation */}
                              <div className="mt-3 pt-2 border-t liquid-glass-modal-border">
                                <p className="text-xs text-gray-500 text-center">
                                  <span className="font-semibold text-gray-400">{t('receipt.formula.label')}</span>{' '}
                                  {calculationVersion >= 2 ? t('receipt.formula.waiter') : t('receipt.formula.waiterV1', 'Starting + Collected - Expenses - Payment')}
                                </p>
                              </div>
                              {/* Note: Waiter payments are handled at cashier checkout (v2 only) */}
                              {calculationVersion >= 2 && (
                                <div className="bg-blue-900/20 rounded-lg p-2 border border-blue-500/30 mt-2">
                                  <p className="text-xs text-blue-300 text-center">
                                    {t('modals.staffShift.waiterPaymentNote', 'Payment will be recorded when you return cash to the cashier')}
                                  </p>
                                </div>
                              )}
                              {/* Note: Payment already deducted (v1 only) */}
                              {calculationVersion < 2 && paymentAmount > 0 && (
                                <div className="bg-amber-900/20 rounded-lg p-2 border border-amber-500/30 mt-2">
                                  <p className="text-xs text-amber-300 text-center">
                                    {t('modals.staffShift.paymentDeductedNote', 'Payment already deducted from amount to return')}
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()
                    }

                  </div>
                );
              })()}


              {/* Detailed Shift Breakdown */}
              {effectiveShift?.role_type === 'cashier' && shiftSummary && (() => {
                const instore = shiftSummary.breakdown?.instore || { cashTotal: 0, cardTotal: 0, cashCount: 0, cardCount: 0 };
                const delivery = shiftSummary.breakdown?.delivery || { cashTotal: 0, cardTotal: 0, cashCount: 0, cardCount: 0 };
                const overall = shiftSummary.breakdown?.overall || { cashTotal: 0, cardTotal: 0, totalCount: 0, totalAmount: 0 };
                const totalPickupOrders = (instore.cashCount || 0) + (instore.cardCount || 0);
                const totalDeliveryOrders = (delivery.cashCount || 0) + (delivery.cardCount || 0);
                const totalCashOrdersCount = (instore.cashCount || 0) + (delivery.cashCount || 0);

                return (
                  <div className={liquidGlassModalCard() + ' space-y-4'}>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-4">{t('modals.staffShift.shiftBreakdown')}</h3>

                    {/* Totals */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="text-lg font-bold text-slate-800 dark:text-white">{overall.totalCount}</div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalSales')}</div>
                        <div className="text-xl font-bold text-green-500">{formatCurrency(overall.totalAmount)}</div>
                      </div>
                    </div>

                    {/* Pickup / Delivery by method */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.pickupCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{t('modals.staffShift.ordersCountValue', { count: instore.cashCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(instore.cashTotal)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.pickupCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{t('modals.staffShift.ordersCountValue', { count: instore.cardCount })}</span>
                          <span className="font-bold text-slate-800 dark:text-white">{formatCurrency(instore.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.deliveryCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{t('modals.staffShift.ordersCountValue', { count: delivery.cashCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(delivery.cashTotal)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.deliveryCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{t('modals.staffShift.ordersCountValue', { count: delivery.cardCount })}</span>
                          <span className="font-bold text-slate-800 dark:text-white">{formatCurrency(delivery.cardTotal)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Totals by channel with cash amount */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalPickupOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalPickupOrders })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(instore.cashTotal + instore.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalDeliveryOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalDeliveryOrders })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(delivery.cashTotal + delivery.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{t('modals.staffShift.ordersCountValue', { count: overall.totalCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(overall.totalAmount)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalCashOrders')}</div>


                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalCashOrdersCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(overall.cashTotal)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* DRIVER SUMMARY - For Cashier Checkout */}
              {effectiveShift?.role_type === 'cashier' && shiftSummary?.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (() => {
                const drivers = shiftSummary.driverDeliveries;

                return (
                  <div className={liquidGlassModalCard() + ' space-y-3'}>
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-3">
                      {t('modals.staffShift.driversCheckout', 'Staff Cash Returns')}
                    </h3>
                    <div className="space-y-2">
                      {drivers.map((driver: any) => {
                        const startingAmount = driver.starting_amount || 0;
                        const earnings = driver.cash_collected || 0;
                        const expenses = driver.expenses || 0;
                        const returns = driver.amount_to_return ?? (startingAmount + earnings - expenses);
                        const isPositive = returns >= 0;
                        const roleType = driver.role_type === 'server'
                          ? t('modals.staffShift.serverRole', 'Waiter')
                          : (driver.role_type || t('modals.staffShift.driverRole'));

                        return (
                          <div key={driver.shift_id || driver.driver_id} className={`p-3 rounded-xl border ${isPositive
                            ? 'bg-green-900/20 border-green-600/40'
                            : 'bg-red-900/20 border-red-600/40'
                            }`}>
                            {/* Role and Name */}
                            <div className="mb-2">
                              <span className="text-xs text-gray-400 uppercase">{roleType}</span>
                              <div className="font-semibold liquid-glass-modal-text">{driver.driver_name}</div>
                            </div>
                            {/* Grid: Starting, Earnings, Returns */}
                            <div className="grid grid-cols-3 gap-2 text-sm">
                              <div>
                                <div className="text-xs text-gray-400">{t('modals.staffShift.driverStarting', 'Starting Amount')}</div>
                                <div className="font-medium liquid-glass-modal-text">€{startingAmount.toFixed(2)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-gray-400">{t('modals.staffShift.driverEarnings')}</div>
                                <div className="font-medium liquid-glass-modal-text">€{earnings.toFixed(2)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-gray-400">{isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}</div>
                                <div className={`font-bold ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                                  €{Math.abs(returns).toFixed(2)}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Record Staff Payments Section - For Cashiers */}
              {effectiveShift?.role_type === 'cashier' && (
                <div className={liquidGlassModalCard() + ' space-y-3'}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-800 dark:text-white">{t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}</h3>
                    <button
                      onClick={() => {
                        if (showStaffPaymentForm) {
                          resetStaffPaymentForm();
                        } else {
                          void openStaffPaymentForm();
                        }
                      }}
                      className="text-sm font-semibold text-blue-500 hover:text-blue-400 flex items-center gap-1"
                    >
                      <Plus className="w-4 h-4" /> {t('modals.staffShift.addPayment', 'Add Payment')}
                    </button>
                  </div>

                  {/* Payment Form */}
                  {showStaffPaymentForm && (
                    <div className="p-4 bg-white/5 rounded-xl space-y-3 animate-in fade-in slide-in-from-top-2 border border-white/10">
                      {/* Staff Selection */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1">{t('modals.staffShift.selectStaff', 'Select Staff')}</label>
                        <select
                          value={selectedStaffForPayment?.id || ''}
                          onChange={async (e) => {
                            const staffId = e.target.value;
                            if (staffId) {
                              const selected = availableStaff.find(s => s.id === staffId);
                              if (selected) {
                                setSelectedStaffForPayment({
                                  id: selected.id,
                                  name: selected.name,
                                role: selected.roles?.[0]?.role_name || 'staff'
                              });
                                // Load history for this staff, using effective shift date context
                                const shiftDate = effectiveShift?.check_in_time
                                  ? toLocalDateString(effectiveShift.check_in_time)
                                  : undefined;
                                await loadPaymentHistoryForStaff(selected.id, shiftDate);

                                // Calculate expected payment based on their hourly rate and active shift
                                const activeShift = staffActiveShifts.get(selected.id);
                                // Or if they don't have an active shift but we're paying them, maybe we shouldn't calc expected?
                                // But logic says: "Use shift.check_in_time from the provided shift"
                                // We need to look up their active shift from the map or context.
                                // Assuming staffActiveShifts map has the shift info.
                                await calculateExpectedPayment(activeShift, selected.hourly_rate);
                              }
                            } else {
                              setSelectedStaffForPayment(null);
                              setPaymentHistory([]); // Clear history
                              setDailyPaymentTotal(0); // Clear summary
                              setExpectedPayment(null);
                            }
                          }}
                          className="liquid-glass-modal-input w-full"
                        >
                          <option value="">{t('modals.staffShift.selectStaffPlaceholder', '-- Select Staff --')}</option>
                          {editingStaffPayment && selectedStaffForPayment?.id && !availableStaff.some((member) => member.id === (selectedStaffForPayment?.id ?? '')) && (
                            <option value={selectedStaffForPayment?.id ?? ''}>{selectedStaffForPayment?.name ?? t('common.unknown', 'Unknown')}</option>
                          )}
                          {availableStaff
                            .filter(s => s.id !== staff?.staffId) // Exclude current cashier
                            .map(s => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                      </div>

                      {/* Payment History Section */}
                      {paymentHistory.length > 0 && (
                        <div className="mb-6">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold text-sm text-gray-300">
                              {t('modals.staffShift.paymentHistoryToday', "Today's Payments")}
                            </h4>
                            <POSGlassBadge variant="info" size="sm">
                              {t('modals.staffShift.todayTotal', { amount: dailyPaymentTotal.toFixed(2) })}
                            </POSGlassBadge>
                          </div>

                          <div className="space-y-2 max-h-48 overflow-y-auto mb-4 custom-scrollbar">
                            {paymentHistory.map((payment) => (
                              <div
                                key={payment.id}
                                className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10"
                              >
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-white">
                                      €{payment.amount.toFixed(2)}
                                    </span>
                                    <POSGlassBadge variant="info" size="sm">
                                      {t(`modals.staffShift.paymentTypes.${payment.payment_type}`, payment.payment_type) as string}
                                    </POSGlassBadge>
                                  </div>
                                  {payment.notes && (
                                    <div className="text-xs text-gray-400 mt-1">
                                      {payment.notes}
                                    </div>
                                  )}
                                  <div className="text-xs text-gray-500 mt-1">
                                    {t('modals.staffShift.paidBy', {
                                      name: payment.cashier_name || t('common.unknown', 'Unknown'),
                                      time: formatTime(payment.created_at)
                                    })}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Payment Type */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1">{t('modals.staffShift.paymentType', 'Payment Type')}</label>
                        <select
                          value={paymentType}
                          onChange={(e) => setPaymentType(e.target.value)}
                          className="liquid-glass-modal-input w-full"
                        >
                          <option value="wage">{t('modals.staffShift.paymentTypes.wage', 'Wage')}</option>
                          <option value="tip">{t('modals.staffShift.paymentTypes.tip', 'Tip')}</option>
                          <option value="bonus">{t('modals.staffShift.paymentTypes.bonus', 'Bonus')}</option>
                          <option value="advance">{t('modals.staffShift.paymentTypes.advance', 'Advance')}</option>
                          <option value="other">{t('modals.staffShift.paymentTypes.other', 'Other')}</option>
                        </select>
                      </div>

                      {/* Amount */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1">
                          {t('modals.staffShift.amountLabel', 'Amount')}
                          {expectedPayment !== null && (
                            <span className="ml-2 text-xs text-blue-400">
                              ({t('modals.staffShift.expected', 'Expected')}: €{(expectedPayment ?? 0).toFixed(2)})
                            </span>
                          )}
                        </label>
                        <div className="relative">
                          <Euro className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input
                            type="text"
                            inputMode="decimal"
                            value={paymentAmount}
                            onChange={(e) => {
                              setPaymentAmount(formatMoneyInputWithCents(e.target.value));
                            }}
                            onFocus={(e) => e.target.select()}
                            placeholder={expectedPayment ? `€${(expectedPayment ?? 0).toFixed(2)}` : '0,00'}
                            className="liquid-glass-modal-input w-full pl-9"
                          />
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1">{t('modals.staffShift.notesOptional', 'Notes (optional)')}</label>
                        <input
                          type="text"
                          value={paymentNotes}
                          onChange={(e) => setPaymentNotes(e.target.value)}
                          placeholder={t('modals.staffShift.paymentNotesPlaceholder', 'Add notes (optional)')}
                          className="liquid-glass-modal-input w-full"
                        />
                      </div>

                      {/* Buttons */}
                      <div className="flex justify-end gap-2 pt-2">
                        <button
                          onClick={() => {
                            setShowStaffPaymentForm(false);
                            setSelectedStaffForPayment(null);
                            setPaymentAmount('');
                            setPaymentType('wage');
                            setPaymentNotes('');
                            setPaymentHistory([]);
                            setDailyPaymentTotal(0);
                          }}
                          className="px-4 py-2 bg-white/10 dark:bg-gray-800/20 rounded-lg liquid-glass-modal-text hover:bg-white/20"
                        >
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button
                          onClick={handleRecordStaffPayment}
                          disabled={loading || !selectedStaffForPayment || !paymentAmount}
                          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_2px_8px_0_rgba(34,197,94,0.4)]"
                        >
                          {loading
                            ? t('common.saving', 'Saving...')
                            : t(
                                editingStaffPaymentId ? 'modals.staffShift.savePaymentChanges' : 'modals.staffShift.recordPayment',
                                editingStaffPaymentId ? 'Save Changes' : 'Record Payment',
                              )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* List of Recorded Payments from current session */}
                  {staffPaymentsList.length > 0 && (
                    <div className="space-y-2 max-h-48 overflow-auto pr-1 scrollbar-hide">
                      <div className="text-xs text-gray-400 uppercase tracking-wide mb-2">{t('modals.staffShift.recordedThisSession', 'Recorded This Session')}</div>
                      {staffPaymentsList.map((p) => (
                        <div key={p.id} className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10 text-sm">
                          <div className="flex-1">
                            <div className="font-semibold liquid-glass-modal-text">{p.staff_name || t('common.unknown', 'Unknown')}</div>
                            <div className="liquid-glass-modal-text-muted text-xs capitalize">
                              {t(`modals.staffShift.paymentTypes.${p.payment_type}`, p.payment_type)}
                              {p.notes ? ` • ${p.notes}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => { void beginEditStaffPayment(p); }}
                              className="inline-flex items-center gap-1 rounded-xl border border-amber-200/80 bg-amber-50/90 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/15"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {t('modals.staffShift.editPayment', 'Edit')}
                            </button>
                            <button
                              type="button"
                              disabled={deletingStaffPaymentId === p.id}
                              onClick={() =>
                                openConfirm({
                                  title: t('modals.staffShift.deleteStaffPaymentConfirmTitle', 'Delete staff payment'),
                                  message: t(
                                    'modals.staffShift.deleteStaffPaymentConfirmMessage',
                                    'Delete the payment for "{{name}}"? Cashier checkout totals will be recalculated immediately.',
                                    { name: p.staff_name || t('common.unknown', 'Unknown') },
                                  ),
                                  variant: 'error',
                                  confirmText: t('modals.staffShift.deletePayment', 'Delete Payment'),
                                  onConfirm: () => { void handleDeleteStaffPayment(p); },
                                })
                              }
                              className="inline-flex items-center gap-1 rounded-xl border border-rose-200/80 bg-rose-50/90 px-3 py-1.5 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('modals.staffShift.deletePayment', 'Delete')}
                            </button>
                            <div className="font-bold text-red-400">-{formatCurrency(p.amount)}</div>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-2 border-t border-white/10">
                        <span className="text-sm font-semibold liquid-glass-modal-text">{t('modals.staffShift.sessionTotal', 'Session Total')}</span>
                        <span className="font-bold text-red-400">
                          -{formatCurrency(staffPaymentsList.reduce((s, p) => s + p.amount, 0))}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Staff Payments (details) - Historical from summary */}
              {effectiveShift?.role_type === 'cashier' && Array.isArray(shiftSummary?.staffPayments) && shiftSummary.staffPayments.length > 0 && (
                <details className={liquidGlassModalCard() + ' space-y-3'}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xl font-bold liquid-glass-modal-text [&::-webkit-details-marker]:hidden">
                    <span>{t('modals.staffShift.staffPaymentsTitle')}</span>
                    <POSGlassBadge variant="info" size="sm">
                      {shiftSummary.staffPayments.length}
                    </POSGlassBadge>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="space-y-2 max-h-52 overflow-auto pr-1">
                      {shiftSummary.staffPayments.map((p: any) => {
                        const name = p.staff_name || '—';
                        const role = p.role_type || '—';
                        const amt = Number(p.amount || 0);
                        let hours = 0;
                        try {
                          const start = p.check_in_time ? new Date(p.check_in_time) : null;
                          const end = p.check_out_time ? new Date(p.check_out_time) : null;
                          const endEff = end || new Date();
                          if (start) {
                            const ms = Math.max(0, endEff.getTime() - start.getTime());
                            hours = ms / 3600000;
                          }
                        } catch { }
                        return (
                          <div key={p.id} className="flex items-center justify-between rounded-xl border border-slate-200/80 bg-slate-50/90 p-3 text-sm dark:border-white/10 dark:bg-gray-800/20">
                            <div className="flex-1">
                              <div className="font-semibold liquid-glass-modal-text">{name}</div>
                              <div className="liquid-glass-modal-text-muted text-xs">{role} • {hours.toFixed(2)} h</div>
                            </div>
                            <div className="font-bold text-red-400">-{formatCurrency(amt)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between items-center pt-2 border-t liquid-glass-modal-border">
                      <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalStaffPayments')}</span>
                      <span className="font-bold text-red-400">
                        -{formatCurrency(shiftSummary.staffPayments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0))}
                      </span>
                    </div>
                  </div>
                </details>
              )}

              {/* CASHIER INPUT FIELDS - Redesigned */}
              {effectiveShift?.role_type === 'cashier' && (
                <div className="space-y-3">
                  {/* Cashier Payment */}
                  <div className="rounded-lg border border-slate-200/80 bg-white/85 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-white/5 dark:shadow-none">
                    <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 uppercase tracking-wide flex items-center gap-2">
                      <Euro className="w-4 h-4 text-green-500" />
                      {t('modals.staffShift.cashierPaymentLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={staffPayment}
                        onChange={(e) => {
                          setStaffPayment(formatMoneyInputWithCents(e.target.value));
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder="0,00"
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                      />
                    </div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-2">{t('modals.staffShift.cashierPaymentHelper')}</p>
                  </div>

                  {/* Closing Cash */}
                  <div className="rounded-lg border border-slate-200/80 bg-white/85 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.06)] dark:border-white/10 dark:bg-white/5 dark:shadow-none">
                    <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-2 uppercase tracking-wide flex items-center gap-2">
                      <Euro className="w-4 h-4 text-green-500" />
                      {t('modals.staffShift.closingCashLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={closingCash}
                        onChange={(e) => {
                          setClosingCash(formatMoneyInputWithCents(e.target.value));
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder="0,00"
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                        autoFocus
                      />
                    </div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-2">{t('modals.staffShift.closingCashHelper')}</p>
                  </div>

                  {/* Live Variance Calculation */}
                  {(() => {
                    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                    const expensesTotal = expenses.reduce((sum, exp) => sum + exp.amount, 0);
                    const breakdown = getCashierExpectedBreakdown(
                      shiftSummary,
                      effectiveShift,
                      opening,
                      expensesTotal
                    );
                    const expected = breakdown.expected;

                    const actual = parseMoneyInputValue(closingCash);
                    const variance = actual - expected;

                    // Only show if user has started typing actual cash (optional, but good UX)
                    if (!closingCash) return null;

                    return (
                      <div className="flex flex-col items-center gap-2 mt-4 animate-in fade-in slide-in-from-top-2">
                        <POSGlassTooltip content={t('modals.staffShift.varianceExplanation', 'Difference between counted cash and expected cash')}>
                          <VarianceBadge variance={variance} size="lg" showIcon />
                        </POSGlassTooltip>
                      </div>
                    );
                  })()}
                </div>
              )}
              {/* DRIVER CHECKOUT - Earnings Calculation */}
              {effectiveShift?.role_type === 'driver' && shiftSummary && (() => {
                const startingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);

                // Filter out canceled orders and get actual cash collected from deliveries
                const deliveries = shiftSummary?.driverDeliveries || [];
                const completedDeliveries = deliveries.filter((d: any) => {
                  const status = (d.status || d.order_status || '').toLowerCase();
                  return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
                });

                // Calculate cash collected from completed deliveries only
                const cashCollected = completedDeliveries.reduce((sum: number, d: any) =>
                  sum + (d.cash_collected || 0), 0);

                // Get total expenses
                const totalExpenses = shiftSummary?.totalExpenses || 0;

                // Calculate amount to return to cashier
                // Formula: Starting Amount + Cash Collected - Expenses
                // Payment is not deducted here - it's handled at cashier checkout
                const amountToReturn = startingAmount + cashCollected - totalExpenses;

                return (
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="rounded-xl border border-indigo-200/80 bg-gradient-to-r from-indigo-50 via-blue-50 to-white p-4 dark:border-indigo-500/30 dark:from-indigo-500/20 dark:to-purple-500/20 dark:bg-none">
                      <h3 className="mb-1 text-lg font-bold text-indigo-700 dark:text-indigo-300">{t('modals.staffShift.driverCheckout')}</h3>
                      <p className="text-xs text-indigo-600/80 dark:text-indigo-200/70">{t('modals.staffShift.driverEarnings')}</p>
                    </div>

                    {/* Earnings Summary */}
                    <div className="space-y-2">
                      {/* Starting Amount (cash taken from cashier) */}
                      <div className="flex justify-between items-center p-3 bg-blue-900/30 rounded-lg border border-blue-600/40">
                        <span className="text-sm text-blue-200">{t('modals.staffShift.startingAmount')}</span>
                        <span className="font-bold text-blue-300">+{formatCurrency(startingAmount)}</span>
                      </div>

                      {/* Cash Collected (from deliveries) */}
                      <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                        <span className="text-sm text-green-200">
                          {t('modals.staffShift.cashCollected')} ({completedDeliveries.length} {t('modals.staffShift.completedOrdersLabel')})
                        </span>
                        <span className="font-bold text-green-300">+{formatCurrency(cashCollected)}</span>
                      </div>

                      {/* Expenses (if any) */}
                      {totalExpenses > 0 && (
                        <div className="flex justify-between items-center p-3 bg-orange-900/30 rounded-lg border border-orange-600/40">
                          <span className="text-sm text-orange-200">{t('modals.staffShift.totalExpenses')}</span>
                          <span className="font-bold text-orange-300">-{formatCurrency(totalExpenses)}</span>
                        </div>
                      )}

                      {/* Separator */}
                      <div className="border-t border-white/20 my-2"></div>

                      {/* Amount to Return to Cashier */}
                      <div className={`flex justify-between items-center p-4 rounded-lg border-2 font-semibold ${amountToReturn >= 0
                        ? 'bg-yellow-900/30 border-yellow-500/50'
                        : 'bg-red-900/30 border-red-500/50'
                        }`}>
                        <span className={`text-base ${amountToReturn >= 0 ? 'text-yellow-200' : 'text-red-200'}`}>
                          {t('modals.staffShift.amountToReturn', { defaultValue: 'Amount to collect from drawer' })}
                        </span>
                        <span className={amountToReturn >= 0 ? 'text-xl text-yellow-300' : 'text-xl text-red-300'}>
                          {formatCurrency(amountToReturn)}
                        </span>
                      </div>

                      {/* Actual Cash Returned Input */}
                      <div className="mt-3 p-4 bg-slate-800/60 rounded-xl border border-slate-600/40">
                        <label className="block text-sm font-semibold text-slate-200 mb-2">
                          {t('modals.staffShift.actualCashReturned', 'Actual Cash Returned')}
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={driverActualCash}
                          onChange={(e) => {
                            setDriverActualCash(formatMoneyInputWithCents(e.target.value));
                          }}
                          onFocus={(e) => e.target.select()}
                          placeholder={formatCurrency(amountToReturn)}
                          className="liquid-glass-modal-input w-full text-2xl font-bold text-center"
                        />
                      </div>

                      {/* Variance Display */}
                      {driverActualCash !== '' && (() => {
                        const actual = parseMoneyInputValue(driverActualCash);
                        const variance = actual - amountToReturn;
                        const isOver = variance >= 0;
                        return (
                          <div className={`flex justify-between items-center p-3 rounded-lg border ${isOver
                            ? 'bg-green-900/30 border-green-500/40'
                            : 'bg-red-900/30 border-red-500/40'
                          }`}>
                            <span className={`text-sm font-medium ${isOver ? 'text-green-200' : 'text-red-200'}`}>
                              {isOver
                                ? t('modals.staffShift.driverOverage', 'Overage')
                                : t('modals.staffShift.driverShortage', 'Shortage')}
                            </span>
                            <span className={`text-lg font-bold ${isOver ? 'text-green-300' : 'text-red-300'}`}>
                              {isOver ? '+' : '-'}{formatCurrency(Math.abs(variance))}
                            </span>
                          </div>
                        );
                      })()}

                      {/* Formula Explanation */}
                      <div className="mt-2 rounded-lg border border-slate-200/80 bg-slate-50/90 p-3 dark:border-slate-600/30 dark:bg-slate-800/50">
                        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-semibold text-slate-700 dark:text-slate-300">{t('receipt.formula.label')}</span>{' '}
                          {t('receipt.formula.driver')}
                        </p>
                      </div>

                      {/* Note: Driver payments are handled at cashier checkout */}
                      <div className="mt-2 rounded-lg border border-blue-200/70 bg-blue-50/90 p-3 dark:border-blue-500/30 dark:bg-blue-900/20">
                        <p className="text-center text-xs text-blue-600 dark:text-blue-300">
                          {t('modals.staffShift.driverPaymentNote', 'Driver payment will be recorded when you return cash to the cashier')}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )
          }
          </div>

          {effectiveMode === 'checkout' && checkoutFooterData && (
            <div className="mt-4 border-t border-slate-200/70 bg-white/65 pt-4 backdrop-blur-xl dark:border-white/10 dark:bg-black/10">
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-[0_14px_36px_rgba(15,23,42,0.08)] sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-black/20 dark:shadow-[0_14px_36px_rgba(2,6,23,0.32)]">
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    {checkoutFooterData.label}
                  </div>
                  {!checkoutFooterData.minimal && (
                    <div className={`mt-1 text-2xl font-black ${checkoutFooterData.accentClass}`}>
                      {formatCurrency(checkoutFooterData.amount)}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {checkoutFooterData.note}
                  </p>
                </div>

                <StaffShiftCheckoutFooterActions
                  onPrint={() => {
                    void handlePrintCheckout();
                  }}
                  onCheckout={() => {
                    console.log('🔴 BUTTON CLICKED!');
                    handleCheckOut();
                  }}
                  printLabel={t('common.actions.print', 'Print')}
                  checkoutLabel={
                    loading
                      ? t('modals.staffShift.closingShift')
                      : t('modals.staffShift.checkOut')
                  }
                  isPrinting={isPrintCheckoutLoading}
                  isPrintDisabled={loading || isPrintCheckoutLoading || !canPrintCheckoutSnapshot}
                  isCheckoutLoading={loading}
                  isCheckoutDisabled={loading || isCheckoutAmountMissing}
                />
              </div>
            </div>
          )}
        </div>
        {/* Large Payment Confirmation - Inline Replacement */}
        {(showPaymentConfirm) ? (
          <div
            className="absolute inset-0 z-50 bg-gray-900/95 flex flex-col items-center justify-center p-6 animate-in fade-in duration-200"
            role="alertdialog"
            aria-labelledby="confirm-large-payment-title"
            aria-describedby="confirm-large-payment-desc"
          >
            <div className="w-full max-w-md space-y-6 text-center">
              <div className="w-20 h-20 rounded-full bg-amber-500/20 flex items-center justify-center mx-auto ring-4 ring-amber-500/10">
                <AlertTriangle className="w-10 h-10 text-amber-500" />
              </div>

              <div className="space-y-2">
                <h3 id="confirm-large-payment-title" className="text-2xl font-bold text-white">
                  {t('modals.staffShift.confirmLargePayment', 'Confirm Large Payment')}
                </h3>
                <p id="confirm-large-payment-desc" className="text-gray-300">
                  {t('modals.staffShift.largePaymentWarning', {
                    amount: `€${pendingPaymentAmount.toFixed(2)}`,
                    threshold: `€${LARGE_PAYMENT_THRESHOLD}`
                  })}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4">
                <button
                  onClick={handleCancelLargePayment}
                  className="px-6 py-3 rounded-xl font-medium transition-all duration-200 bg-white/10 hover:bg-white/20 text-white border border-white/10 hover:border-white/20"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleConfirmLargePayment}
                  className="px-6 py-3 rounded-xl font-bold transition-all duration-200 bg-amber-600 hover:bg-amber-700 text-white shadow-lg shadow-amber-900/20"
                  autoFocus
                >
                  {t('modals.staffShift.confirmPayment', 'Confirm Payment')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </LiquidGlassModal >

      <ConfirmDialog
        {...confirmDialog}
        onClose={closeConfirm}
        isLoading={loading}
      />
    </>
  );
}
