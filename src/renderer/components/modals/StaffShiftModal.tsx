import React, { useState, useEffect, useRef } from 'react';
import { X, Clock, Euro, FileText, Plus, AlertCircle, User, ChevronRight, AlertTriangle, CheckCircle, XCircle, Banknote, CreditCard, Star, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense } from '../../types';
import useTerminalSettings from '../../hooks/useTerminalSettings';
import { sectionTitle, sectionSubtle, inputBase, liquidGlassModalCard, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal, POSGlassBadge, POSGlassCard } from '../ui/pos-glass-components';
import { POSGlassTooltip } from '../ui/POSGlassTooltip';
import { VarianceBadge } from '../ui/VarianceBadge';
import { formatTime } from '../../utils/format';
import { ProgressStepper, Step, StepStatus } from '../ui/ProgressStepper';
import { ConfirmDialog, ConfirmVariant } from '../ui/ConfirmDialog';
import { ErrorAlert } from '../ui/ErrorAlert';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { SUPABASE_CONFIG } from '../../../shared/supabase-config';
import { getBridge } from '../../../lib';

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
  hourly_rate?: number;
}

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

type CheckInStep = 'select-staff' | 'enter-pin' | 'select-role' | 'enter-cash';

export function StaffShiftModal({ isOpen, onClose, mode, hideCashDrawer = false, isMobileWaiter = false }: StaffShiftModalProps) {
  const bridge = getBridge();
  console.log('🔄 StaffShiftModal loaded - VERSION 2.0 with SUPABASE_CONFIG');
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift, setStaff, setActiveShiftImmediate } = useShift();

  // Helper function to translate role names
  const translateRoleName = (roleName: string): string => {
    const key = `common.roleNames.${roleName.toLowerCase()}`;
    const translated = t(key);
    // If translation not found, return original name
    return translated === key ? roleName : translated;
  };

  const { getSetting } = useTerminalSettings();

  // Check-in multi-step state
  const [checkInStep, setCheckInStep] = useState<CheckInStep>('select-staff');
  const [availableStaff, setAvailableStaff] = useState<StaffMember[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [roleType, setRoleType] = useState<'cashier' | 'manager' | 'driver' | 'kitchen' | 'server'>('cashier');

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
  const [showZeroCashConfirm, setShowZeroCashConfirm] = useState(false); // Confirmation dialog for cashier zero opening cash

  // Check-out state
  const [closingCash, setClosingCash] = useState('');
  const [staffPayment, setStaffPayment] = useState('');


  // Track active shifts per staff
  const [staffActiveShifts, setStaffActiveShifts] = useState<Map<string, any>>(new Map());

  // Variance result state
  const [lastShiftResult, setLastShiftResult] = useState<{
    variance: number;
    breakdown?: {
      opening: number;
      sales: number;
      cashRefunds: number;
      expenses: number;
      cashDrops: number;
      driverGiven: number;
      driverReturned: number;
      inheritedDriverExpectedReturns: number;
      staffPayments: number; // Informational only, not deducted from expected
      expected: number;
      actual: number;
    };
  } | null>(null);

  // Expense state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseType, setExpenseType] = useState<'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other'>('supplies');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseReceipt, setExpenseReceipt] = useState('');
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);

  // Staff payment recording state (for cashiers)
  const [staffPaymentsList, setStaffPaymentsList] = useState<Array<{
    id: string;
    staff_id: string;
    staff_name: string;
    amount: number;
    payment_type: string;
    notes?: string;
  }>>([]);
  const [showStaffPaymentForm, setShowStaffPaymentForm] = useState(false);
  const [selectedStaffForPayment, setSelectedStaffForPayment] = useState<{ id: string; name: string; role: string } | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentType, setPaymentType] = useState('wage');
  const [paymentNotes, setPaymentNotes] = useState('');

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


  // UI state
  const [loading, setLoading] = useState(false);
  // Local override to switch to checkout when selecting a staff with active shift
  const [localMode, setLocalMode] = useState<'checkin' | 'checkout' | null>(null);
  const [checkoutShift, setCheckoutShift] = useState<any | null>(null);
  const effectiveMode = (localMode ?? mode);
  const effectiveShift = (checkoutShift ?? activeShift);
  const isKitchenRole = effectiveShift?.role_type === 'kitchen';
  const isDriverRole = effectiveShift?.role_type === 'driver';

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
    ...(checkInStep === 'select-role' || (selectedStaff && checkInStep === 'enter-cash' && effectiveMode === 'checkin') ? [{ id: 'role', label: 'Role', status: (checkInStep === 'select-role' ? 'active' : 'complete') as StepStatus }] : []),
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

  useEffect(() => {
    if (checkInStep === 'select-role' && selectedStaff) {
      console.log('[StaffShiftModal] Reached role selection step');
      console.log('[StaffShiftModal] selectedStaff:', selectedStaff);
      console.log('[StaffShiftModal] selectedStaff.roles:', selectedStaff.roles);
      console.log('[StaffShiftModal] selectedStaff.roles.length:', selectedStaff.roles?.length);
    }
  }, [checkInStep, selectedStaff]);
  const [shiftSummary, setShiftSummary] = useState<any | null>(null);


  // Load staff when modal opens in checkin mode
  useEffect(() => {
    console.log('[StaffShiftModal] useEffect triggered:', { isOpen, mode });
    if (isOpen && mode === 'checkin') {
      console.log('[StaffShiftModal] Calling loadStaff()...');
      loadStaff();
      setCheckInStep('select-staff');
      setSelectedStaff(null);
      setEnteredPin('');
      setRoleType('cashier');
      setOpeningCash('');
      setDriverStartingAmount(''); // Reset driver starting amount
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
    }
  }, [isOpen, effectiveMode, effectiveShift]);

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

  const loadStaff = async () => {
    setLoading(true);
    setError('');
    try {
      // Determine branch for this terminal; prefer settings hook, then IPC
      let branchId: string | undefined;

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
          const local = (await bridge.settings.get()) as any;
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

      // Use IPC to fetch staff from main process (where Supabase config is available)
      let staffList: StaffMember[] = [];

      // Try bridge handler first
      try {
        console.log('[loadStaff] Trying bridge handler shift:list-staff-for-checkin...');
        const result = await bridge.invoke('shift:list-staff-for-checkin', branchId);

        // Handle IPC response format
        const data = result?.data || result;
        if (Array.isArray(data)) {
          staffList = data;
          console.log('[loadStaff] bridge returned', staffList.length, 'staff members');
        } else if (result?.error) {
          throw new Error(result.error);
        } else {
          throw new Error('Invalid staff list response');
        }
      } catch (ipcError: any) {
        console.warn('[loadStaff] bridge handler failed, falling back to direct fetch:', ipcError?.message || ipcError);
        // Fall back to direct fetch if bridge fails (for backward compatibility)
        staffList = await loadStaffDirectFetch(branchId);
      }

      // Load roles for staff members via IPC
      if (staffList.length > 0) {
        const staffIds = staffList.map(s => s.id);
        try {
          console.log('[loadStaff] Loading roles via bridge for', staffIds.length, 'staff members');
          const rolesResult = await bridge.invoke('shift:get-staff-roles', staffIds);
          const rolesByStaff = rolesResult?.data || rolesResult || {};

          // Assign roles to staff members
          staffList.forEach(staff => {
            const roleCandidates = [
              ...(Array.isArray(staff.roles) ? staff.roles : []),
              ...(Array.isArray(rolesByStaff[staff.id]) ? rolesByStaff[staff.id] : [])
            ];

            if (roleCandidates.length === 0 && staff.role_id) {
              roleCandidates.push({
                role_id: staff.role_id,
                role_name: staff.role_name || 'staff',
                role_display_name: staff.role_display_name || 'Staff',
                role_color: '#6B7280',
                is_primary: true
              });
            }

            const seenRoleIds = new Set<string>();
            const dedupedRoles: StaffRole[] = [];
            roleCandidates.forEach((role: any) => {
              const roleId = (role?.role_id || '').toString();
              if (!roleId || seenRoleIds.has(roleId)) {
                return;
              }
              seenRoleIds.add(roleId);
              dedupedRoles.push({
                role_id: roleId,
                role_name: role?.role_name || 'staff',
                role_display_name: role?.role_display_name || 'Staff',
                role_color: role?.role_color || '#6B7280',
                is_primary: !!role?.is_primary,
              });
            });

            if (dedupedRoles.length > 0) {
              const hasPrimary = dedupedRoles.some((role) => role.is_primary);
              if (!hasPrimary) {
                dedupedRoles[0].is_primary = true;
              }
              staff.roles = dedupedRoles;
            }
          });
        } catch (rolesError) {
          console.warn('[loadStaff] Failed to load roles via IPC:', rolesError);
          // Fallback: use primary role from staff data
          staffList.forEach(staff => {
            if (staff.role_id && (!staff.roles || staff.roles.length === 0)) {
              staff.roles = [{
                role_id: staff.role_id,
                role_name: staff.role_name || 'staff',
                role_display_name: staff.role_display_name || 'Staff',
                role_color: '#6B7280',
                is_primary: true
              }];
            }
          });
        }
      }

      const normalizedStaffList: StaffMember[] = (staffList || [])
        .map((staff: any) => {
          const fullName = `${staff?.first_name ?? ''} ${staff?.last_name ?? ''}`.trim();
          const name = (staff?.name || fullName || 'Staff').toString().trim() || 'Staff';
          return {
            ...staff,
            id: String(staff?.id ?? '').trim(),
            name,
            first_name: String(staff?.first_name ?? ''),
            last_name: String(staff?.last_name ?? ''),
            email: String(staff?.email ?? ''),
            role_id: String(staff?.role_id ?? ''),
            role_name: String(staff?.role_name ?? 'staff'),
            role_display_name: String(staff?.role_display_name ?? 'Staff'),
            roles: Array.isArray(staff?.roles) ? staff.roles : [],
            can_login_pos: staff?.can_login_pos ?? true,
            is_active: staff?.is_active ?? true,
          };
        })
        .filter((staff) => !!staff.id);

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
      setError(err instanceof Error ? err.message : t('modals.staffShift.failedToLoad'));
    } finally {
      setLoading(false);
    }
  };

  // Fallback direct fetch for backward compatibility with older builds
  const loadStaffDirectFetch = async (branchId: string): Promise<StaffMember[]> => {
    const supabaseUrl = SUPABASE_CONFIG.url;
    const supabaseKey = SUPABASE_CONFIG.anonKey;

    console.log('[loadStaffDirectFetch] Supabase config:', {
      url: supabaseUrl?.substring(0, 30) + '...',
      hasKey: !!supabaseKey
    });

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase configuration missing');
    }

    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_list_staff_for_checkin`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_branch_id: branchId })
    });

    if (!rpcRes.ok) {
      const txt = await rpcRes.text();
      throw new Error(`Failed to fetch staff via RPC: ${rpcRes.status} ${rpcRes.statusText} - ${txt}`);
    }

    const data = await rpcRes.json();
    console.log('[loadStaffDirectFetch] Fetched staff data:', data?.length || 0, 'members');

    return (data || []).map((s: any) => ({
      id: s.id,
      name: (s.name || `${s.first_name ?? ''} ${s.last_name ?? ''}` || 'Staff').trim(),
      first_name: s.first_name,
      last_name: s.last_name,
      email: s.email,
      role_id: s.role_id,
      role_name: s.role_name || s.roles?.name || 'staff',
      role_display_name: s.role_display_name || s.roles?.display_name || 'Staff',
      roles: [],
      can_login_pos: (s.can_login_pos ?? true),
      is_active: (s.is_active ?? true),
      hourly_rate: s.hourly_rate
    }));
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
      const targetDate = dateStr || new Date().toISOString().split('T')[0];
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
      const amount = parseFloat(paymentAmount);
      const result = await bridge.invoke('shift:record-staff-payment', {
        cashierShiftId: effectiveShift.id,
        paidToStaffId: selectedStaffForPayment.id,
        amount,
        paymentType,
        notes: paymentNotes || undefined
      });

      if (result.success) {
        setPaymentAmount('');
        setPaymentType('wage');
        setPaymentNotes('');
        setShowPaymentConfirm(false);

        await loadStaffPayments(effectiveShift.id);
        // Use effectiveShift date context if possible
        const shiftDate = effectiveShift.check_in_time ? new Date(effectiveShift.check_in_time).toISOString().split('T')[0] : undefined;
        await loadPaymentHistoryForStaff(selectedStaffForPayment.id, shiftDate);

        const summaryResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: true });
        setShiftSummary(summaryResult?.data || summaryResult);

        setSuccess(t('modals.staffShift.paymentRecorded', 'Payment recorded successfully'));
        setTimeout(() => setSuccess(''), 3000);
      } else {
        setError(result.error || t('modals.staffShift.paymentFailed', 'Failed to record payment'));
        setShowPaymentConfirm(false); // Reset confirmation state on error
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.staffShift.paymentFailed', 'Failed to record payment'));
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

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
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

  const handleStaffSelect = async (staffMember: StaffMember) => {
    setSelectedStaff(staffMember);
    setEnteredPin('');
    setError('');

    // If this staff already has an active shift, jump to checkout view for that shift
    const existingShift = staffActiveShifts.get(staffMember.id);
    if (existingShift) {
      setLocalMode('checkout');
      setCheckoutShift(existingShift);
      setShowExpenseForm(false);
      setClosingCash('');
      await loadExpenses(existingShift.id);
      return;
    }

    // Otherwise continue the normal check-in flow
    setCheckInStep('enter-pin');
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
          const local = (await bridge.settings.get()) as any;
          branchId = branchId || (local?.['terminal.branch_id'] ?? local?.terminal?.branch_id);
          terminalId = terminalId || (local?.['terminal.terminal_id'] ?? local?.terminal?.terminal_id);
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

      // Resolve organization_id
      let organizationId: string | undefined = getSetting?.('terminal', 'organization_id') as string | undefined;
      if (!organizationId) {
        try {
          const oid = await bridge.terminalConfig.getOrganizationId();
          if (oid) organizationId = oid as string;
        } catch { }
      }
      if (!organizationId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'organization_id');
          if (val) organizationId = val as string;
        } catch { }
      }
      organizationId = normalizeContextId(organizationId);

      // Validate branchId before attempting check-in
      if (!branchId || (typeof branchId === 'string' && branchId.trim() === '')) {
        console.error('[StaffShiftModal] Cannot check in: branchId is not configured');
        setError(t('modals.staffShift.errors.noBranchConfigured', 'Branch not configured. Please contact admin.'));
        setEnteredPin('');
        return;
      }

      try {
        console.log('[StaffShiftModal] PIN submit - IPC call with', { staffId: selectedStaff?.id, branchId, terminalId });
        const authRes = await bridge.invoke(
          'staff-auth:authenticate-pin',
          enteredPin.trim(),
          selectedStaff?.id,
          terminalId,
          branchId
        );
        // Main-process handlers may return either raw service payload
        // or wrapped IPC response: { success, data }.
        const normalizedAuth = authRes?.data && typeof authRes.data === 'object' ? authRes.data : authRes;
        const authSucceeded = normalizedAuth?.success === true;
        const returnedStaffId = normalizedAuth?.staffId ?? normalizedAuth?.staff_id ?? normalizedAuth?.staff?.id;
        const selectedStaffId = selectedStaff?.id;
        console.log('[StaffShiftModal] PIN IPC normalized auth', {
          wrapped: !!authRes?.data,
          authSucceeded,
          returnedStaffId,
          selectedStaffId,
          error: normalizedAuth?.error
        });
        const staffMatches =
          !returnedStaffId ||
          !selectedStaffId ||
          String(returnedStaffId).trim().toLowerCase() === String(selectedStaffId).trim().toLowerCase();

        if (authSucceeded && staffMatches) {
          const staffRole = selectedStaff.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
          setRoleType(staffRole);
          setCheckInStep('select-role');
          setError('');
          return; // done
        }

        if (authSucceeded && !staffMatches) {
          console.warn('[StaffShiftModal] PIN auth staff mismatch', {
            selectedStaffId,
            returnedStaffId,
          });
          setError(t('modals.staffShift.invalidPIN'));
          setEnteredPin('');
          return;
        }

        // If main-process auth returned an explicit failure, trust it and
        // avoid renderer direct-RPC fallback that depends on renderer env config.
        if (normalizedAuth && normalizedAuth.success === false) {
          const errorText = String(normalizedAuth.error || '').toLowerCase();
          if (errorText.includes('invalid pin') || errorText.includes('not found') || errorText.includes('access denied')) {
            setError(t('modals.staffShift.invalidPIN'));
          } else {
            setError(t('modals.staffShift.verifyPinFailed'));
          }
          setEnteredPin('');
          return;
        }

        console.log('IPC PIN auth returned unexpected payload (will try direct RPC next):', authRes);
        // Do not return here; fall through to direct RPC
      } catch (e) {
        console.warn('IPC PIN auth error, falling back to direct Supabase RPC:', e);
      }

      // Fallback: Use the same server-side RPC to verify PIN and create a session
      const supabaseUrl = SUPABASE_CONFIG.url;
      const supabaseKey = SUPABASE_CONFIG.anonKey;

      if (!supabaseUrl || !supabaseKey) {
        throw new Error('Supabase configuration missing');
      }

      console.log('[StaffShiftModal] PIN submit - direct RPC with', { staffId: selectedStaff.id, branchId, organizationId, terminalId });
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/pos_checkin_staff`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_staff_id: selectedStaff.id,
          p_staff_pin: enteredPin.trim(),
          // Sanitize UUIDs: empty strings cannot be cast to UUID by PostgreSQL
          p_branch_id: branchId && branchId.trim() ? branchId : null,
          p_organization_id: organizationId && organizationId.trim() ? organizationId : null,
          p_terminal_id: terminalId || null,
          p_session_hours: 8
        })
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`PIN verification failed (${response.status}): ${errorBody || response.statusText}`);
      }

      const results = await response.json();

      // Debug logging
      console.log('pos_checkin_staff Response:', results);
      console.log('Selected Staff ID:', selectedStaff.id);

      // PostgREST returns an array for TABLE-returning functions
      const result = Array.isArray(results) && results.length > 0 ? results[0] : null;

      console.log('Parsed Result:', result);

      if (!result || !result.success || result.staff_id !== selectedStaff.id) {
        console.log('pos_checkin_staff failed:', {
          hasResult: !!result,
          success: result?.success,
          staffIdMatch: result?.staff_id === selectedStaff.id,
          resultStaffId: result?.staff_id,
          selectedStaffId: selectedStaff.id
        });
        setError(t('modals.staffShift.invalidPIN'));
        setEnteredPin('');
        return;
      }

      // Success
      const staffRole = selectedStaff.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
      setRoleType(staffRole);
      setCheckInStep('select-role');
      setError('');
    } catch (err) {
      console.error('PIN verification error:', err);
      setError(t('modals.staffShift.verifyPinFailed'));
      setEnteredPin('');
    } finally {
      setLoading(false);
    }
  };

  const handleRoleSelect = async (role: 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server') => {
    setRoleType(role);

    // For driver role, pre-check if there's an active cashier
    if (role === 'driver') {
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

    if (role === 'cashier' || role === 'driver') {
      setCheckInStep('enter-cash');
    } else {
      // For other roles, proceed directly to check-in
      handleCheckIn();
    }
  };

  const handleCheckIn = async (bypassZeroConfirm = false) => {
    if (!selectedStaff || !staff) {
      setError(t('modals.staffShift.noStaffSelected'));
      return;
    }

    // Driver-specific validation: cannot take starting cash without active cashier
    const driverAmount = parseFloat(driverStartingAmount) || 0;
    if (roleType === 'driver' && driverAmount > 0 && !activeCashierExists) {
      setError(t('modals.staffShift.noCashierForDriverCash', 'No active cashier. You cannot take starting cash without a cashier present.'));
      return;
    }

    // Soft guard: cashiers starting with zero opening cash need confirmation
    if (roleType === 'cashier' && !bypassZeroConfirm) {
      const trimmedOpening = openingCash.trim();
      const parsedOpening = parseFloat(trimmedOpening);
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
      if (roleType === 'cashier') {
        const trimmedOpening = openingCash.trim();
        const parsedOpening = parseFloat(trimmedOpening);

        // Validation: must not be empty and must be a valid number >= 0
        // Allow explicit "0" as valid (differentiate from empty string)
        if (trimmedOpening === '' || isNaN(parsedOpening) || parsedOpening < 0) {
          setError(t('modals.staffShift.invalidOpeningCash'));
          setLoading(false);
          return;
        }
      }

      // For drivers, validate starting amount if provided (optional, can be 0 or empty)
      if (roleType === 'driver') {
        const trimmedStarting = driverStartingAmount.trim();
        if (trimmedStarting !== '') {
          const parsedStarting = parseFloat(trimmedStarting);
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

      if (roleType === 'cashier') {
        usedOpeningCash = parseFloat(openingCash) || 0;
      } else if (roleType === 'driver') {
        // Use dedicated startingAmount field for drivers
        usedStartingAmount = parseFloat(driverStartingAmount) || 0;
      }
      // Other roles: both remain undefined

      const result = await bridge.shifts.open({
        staffId: selectedStaff.id,
        branchId: resolvedBranchId,
        terminalId: resolvedTerminalId,
        roleType,
        openingCash: usedOpeningCash,
        startingAmount: usedStartingAmount
      }) as any;

      if (result.success) {
        const shiftId = result?.shiftId || result?.data?.shiftId || result?.data?.id;
        setSuccess(t('modals.staffShift.shiftStarted'));
        // Update the global shift context to the checked-in staff so guards lift
        setStaff({
          staffId: selectedStaff.id,
          name: selectedStaff.name,
          role: roleType,
          branchId: resolvedBranchId,
          terminalId: resolvedTerminalId,
          organizationId: resolvedOrganizationId,
        });
        // Optimistically mark shift active immediately with a minimal stub, so UI unlocks at once
        try {
          if (shiftId) {
            // opening_cash_amount: for cashiers this is the drawer count, for drivers this is their starting amount
            const effectiveOpeningAmount = roleType === 'driver'
              ? (usedStartingAmount ?? 0)
              : usedOpeningCash;
            setActiveShiftImmediate({
              id: String(shiftId),
              staff_id: selectedStaff.id,
              branch_id: resolvedBranchId,
              terminal_id: resolvedTerminalId,
              role_type: roleType,
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
      const openingCash = effectiveShift.opening_cash_amount || 0;
      const deliveries = freshSummary?.driverDeliveries || [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const totalCashCollected = completedDeliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;
      closingAmount = openingCash + totalCashCollected - totalExpenses - driverPayment;
      console.log('Driver closingAmount (formula: openingCash + totalCashCollected - totalExpenses - driverPayment):', {
        totalDeliveries: deliveries.length,
        completedDeliveries: completedDeliveries.length,
        canceledDeliveries: deliveries.length - completedDeliveries.length,
        openingCash,
        totalCashCollected,
        totalExpenses,
        driverPayment,
        closingAmount
      });
    }
    // For kitchen roles and cashiers
    else if (isKitchenRole || effectiveShift?.role_type === 'cashier') {
      const payout = staffPayment?.toString().trim() === '' ? 0 : parseFloat(staffPayment as string);
      console.log('staffPayment:', payout);
      if (isNaN(payout) || payout < 0) {
        console.log('❌ Invalid staff payment amount');
        setError(t('modals.staffShift.invalidStaffPayment'));
        return;
      }

      if (effectiveShift?.role_type === 'cashier') {
        // Cashier: Calculate Expected but use Actual from input
        const openingCash = effectiveShift.opening_cash_amount || 0;
        // Use instore only (pickup/dine-in) - delivery cash is tracked via driver returns
        const totalCashOrders = shiftSummary?.breakdown?.instore?.cashTotal || 0;
        const cashRefunds = shiftSummary?.cashRefunds || 0;
        const totalExpenses = shiftSummary?.totalExpenses || 0;
        const cashDrops = shiftSummary?.cashDrawer?.cash_drops || 0;
        const driverGiven = shiftSummary?.cashDrawer?.driver_cash_given || 0;
        const driverReturned = shiftSummary?.cashDrawer?.driver_cash_returned || 0;
        // Get inherited driver expected returns (drivers transferred TO this cashier)
        const inheritedDrivers = shiftSummary?.transferredDrivers || [];
        const inheritedDriverExpectedReturns = inheritedDrivers.reduce((sum: number, d: any) => sum + (d.net_cash_amount || 0), 0);
        // V2 Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned + inheritedDrivers
        // Note: Staff payments are informational only and NOT deducted from expected amount
        const expectedAmount = openingCash + totalCashOrders - cashRefunds - totalExpenses - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns;

        // Use manually entered closing cash for actual
        const actualAmount = closingCash === '' ? expectedAmount : parseFloat(closingCash);

        if (isNaN(actualAmount) || actualAmount < 0) {
          setError(t('modals.staffShift.invalidClosingCash'));
          return;
        }

        closingAmount = actualAmount;
        console.log('Cashier Checkout (v2):', { openingCash, totalCashOrders, cashRefunds, totalExpenses, cashDrops, driverGiven, driverReturned, inheritedDriverExpectedReturns, expected: expectedAmount, actual: closingAmount, variance: closingAmount - expectedAmount });
      } else {
        // Kitchen roles: no cash drawer, just record staff payment and close with 0
        closingAmount = 0;
        console.log('Kitchen closingAmount (no cash drawer):', closingAmount);
      }
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

      const openingCash = effectiveShift.opening_cash_amount || 0;
      const waiterTables = freshSummary?.waiterTables || [];
      const cashCollected = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;

      // Formula: Cash to Return = Starting Amount + Cash Collected - Expenses - Payments
      closingAmount = openingCash + cashCollected - totalExpenses - waiterPayment;
      console.log('Server closingAmount calculated:', closingAmount);
    }
    // Other roles (fallback): use manually entered closing cash
    else {
      closingAmount = parseFloat(closingCash);
      console.log('closingAmount:', closingAmount);
      if (isNaN(closingAmount) || closingAmount < 0) {
        console.log('❌ Invalid closing amount');
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
    }

    // Zero Amount Confirmation
    if (closingAmount === 0 && !bypassZeroConfirm && !isKitchenRole) {
      openConfirm({
        title: t('modals.staffShift.confirmZeroTitle', 'Confirm Zero Closing Cash'),
        message: t('modals.staffShift.confirmZeroMessage', 'Are you sure you want to close the shift with $0.00 closing cash?'),
        variant: 'warning',
        onConfirm: () => handleCheckOut(true)
      });
      return;
    }

    console.log('✅ All checks passed, calling closeShift via bridge...');
    setLoading(true);
    setError('');
    setSuccess('');

    // If kitchen or cashier, record staff payout using recordStaffPayment() before closing (if provided)
    // This uses the dedicated staff_payments table instead of shift_expenses
    if (isKitchenRole || effectiveShift?.role_type === 'cashier') {
      try {
        const payoutForRecord = staffPayment?.toString().trim() === '' ? 0 : parseFloat(staffPayment as string);
        console.log('[Checkout] Staff payment to record:', { staffPayment, payoutForRecord, isKitchenRole, roleType: effectiveShift?.role_type });
        if (!isNaN(payoutForRecord) && payoutForRecord > 0) {
          // Get the active cashier's shift ID (for kitchen staff, we need to find it)
          let cashierShiftId = effectiveShift.id;
          if (isKitchenRole && effectiveShift.role_type !== 'cashier') {
            // Kitchen staff: find the active cashier shift for this terminal
            const cashierShift = await bridge.shifts.getActiveCashierByTerminal(
              staff.branchId,
              staff.terminalId
            );
            if (cashierShift?.id) {
              cashierShiftId = cashierShift.id;
            } else {
              console.warn('No active cashier shift found for kitchen staff payout');
            }
          }

          // Use effectiveShift.staff_id (real UUID from check-in) instead of staff.staffId (can be "no-pin-user")
          const paidToStaffId = effectiveShift.staff_id || staff.staffId;
          console.log('[Checkout] Recording staff payment:', { cashierShiftId, paidToStaffId, amount: payoutForRecord });
          // Use recordStaffPayment() instead of recordExpense() to avoid creating shift_expenses rows
          const paymentResult = await bridge.invoke('shift:record-staff-payment', {
            cashierShiftId,
            paidToStaffId, // The staff being paid (kitchen or the cashier themselves) - use real UUID from shift
            amount: payoutForRecord,
            paymentType: 'wage',
            notes: t('expense.messages.staffPayoutDescription'),
          });
          console.log('[Checkout] Staff payment result:', paymentResult);
        } else {
          console.log('[Checkout] Skipping staff payment record (no valid amount)');
        }
      } catch (err) {
        console.error('[Checkout] Failed to record staff payment:', err);
      }
    }

    try {
      // For drivers, include the payment amount in the closeShift call
      const isDriver = effectiveShift.role_type === 'driver';
      const driverPaymentAmount = isDriver ? parseFloat(staffPayment || '0') : undefined;

      const result = await bridge.shifts.close({
        shiftId: effectiveShift.id,
        closingCash: closingAmount,
        closedBy: staff.staffId,
        paymentAmount: driverPaymentAmount
      }) as any;
      console.log('closeShift result:', result);

      if (result.success) {
        const variance = result?.variance ?? result?.data?.variance ?? 0;
        const varianceText = variance >= 0
          ? `Overage: $${variance.toFixed(2)}`
          : `Shortage: $${Math.abs(variance).toFixed(2)}`;
        // Check for cashier logic to populate items
        const isCashier = effectiveShift.role_type === 'cashier';
        if (isCashier) {
          // Use backend variance directly - backend closeShift() returns correct v2 variance
          // V2 Formula: expected = opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns
          // Staff payments are informational only and NOT deducted from expected
          const opening = effectiveShift.opening_cash_amount || 0;
          // Use instore only (pickup/dine-in) - delivery cash is tracked via driver returns
          const sales = shiftSummary?.breakdown?.instore?.cashTotal || 0;
          const cashRefunds = shiftSummary?.cashRefunds || 0;
          const expenses = shiftSummary?.totalExpenses || 0;
          const cashDrops = shiftSummary?.cashDrawer?.cash_drops || 0;
          const driverGiven = shiftSummary?.cashDrawer?.driver_cash_given || 0;
          const driverReturned = shiftSummary?.cashDrawer?.driver_cash_returned || 0;
          const inheritedDrivers = shiftSummary?.transferredDrivers || [];
          const inheritedDriverExpectedReturns = inheritedDrivers.reduce((sum: number, d: any) => sum + (d.net_cash_amount || 0), 0);
          // Staff payments are informational only (not deducted from expected)
          const staffPayments = (shiftSummary?.cashDrawer?.total_staff_payments || 0) +
            (staffPayment ? parseFloat(staffPayment) : 0);
          // V2 expected matches backend formula
          const expected = opening + sales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns;
          const actual = closingAmount;

          setLastShiftResult({
            variance, // Use backend variance directly
            breakdown: {
              opening,
              sales,
              cashRefunds,
              expenses,
              cashDrops,
              driverGiven,
              driverReturned,
              inheritedDriverExpectedReturns,
              staffPayments, // Informational only
              expected,
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
          const terminalName = await bridge.terminalConfig.getSetting('terminal', 'name');
          const printResult = await bridge.invoke('shift:print-checkout', {
            shiftId: effectiveShift.id,
            roleType: effectiveShift.role_type,
            terminalName: terminalName || undefined
          });
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
        setError(result.error || t('modals.staffShift.closeShiftFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.staffShift.closeShiftFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleRecordExpense = async () => {
    if (!effectiveShift || !staff) {
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    const amount = parseFloat(expenseAmount);
    if (isNaN(amount) || amount <= 0) {
      setError(t('modals.expense.invalidAmount'));
      return;
    }

    if (!expenseDescription.trim()) {
      setError(t('modals.expense.descriptionRequired'));
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
        setSuccess(t('modals.expense.recordSuccess'));
        setExpenseAmount('');
        setExpenseDescription('');
        setExpenseReceipt('');
        setShowExpenseForm(false);
        await loadExpenses();
        // Refresh shiftSummary to update totalExpenses for expected amount calculation
        try {
          const summaryResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: true });
          setShiftSummary(summaryResult?.data || summaryResult);
        } catch (e) {
          console.warn('Failed to refresh shift summary after expense:', e);
        }
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

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

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
    if (method === 'mixed') {
      return (
        <span className="inline-flex items-center gap-1">
          <Banknote className="w-4 h-4 text-green-400" />
          <CreditCard className="w-4 h-4 text-blue-400" />
        </span>
      );
    }
    return <CreditCard className="w-4 h-4 text-gray-400" />; // fallback
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
        onClose={onClose}
        title={mode === 'checkin' ? t('modals.staffShift.checkIn') : t('modals.staffShift.checkOut')}
        size="md"
        className="!max-w-lg"
        closeOnBackdrop={false}
        closeOnEscape={true}
      >
        {/* Content with Scroll - max height to ensure scrollability */}
        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2 custom-scrollbar">
          {/* Progress Stepper used during Check In/Out */}
          {(effectiveMode === 'checkin' || effectiveMode === 'checkout') && (
            <div className="mb-4">
              <ProgressStepper steps={progressSteps} />
            </div>
          )}

          {/* Error/Success Messages */}
          {error && <ErrorAlert title={t('common.status.error', 'Error')} message={error} onClose={() => setError('')} className="mb-4" />}
          {success && <ErrorAlert title={t('common.status.success', 'Success')} message={success} severity="success" onClose={() => setSuccess('')} className="mb-4" />}



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
                      <span className="text-gray-400">{t('modals.staffShift.inheritedDriverReturnsLabel', 'Inherited Driver Returns')}</span>
                      <span className="font-medium text-green-300">+{(lastShiftResult.breakdown.inheritedDriverExpectedReturns || 0).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="h-px bg-white/10 my-1"></div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-medium">
                    <span className="text-gray-300">{t('modals.staffShift.expectedAmountLabel')}</span>
                    <span className="text-blue-300">${(lastShiftResult.breakdown.expected || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-bold">
                    <span className="text-white">{t('modals.staffShift.closingCashLabel')} (Actual)</span>
                    <span className="text-white">${(lastShiftResult.breakdown.actual || 0).toFixed(2)}</span>
                  </div>
                  {/* Staff Payments - Informational only, NOT deducted from expected */}
                  {(lastShiftResult.breakdown.staffPayments || 0) > 0 && (
                    <>
                      <div className="h-px bg-white/10 my-1"></div>
                      <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                        <span className="text-gray-400">{t('modals.staffShift.staffPaymentsLabel')}</span>
                        <span className="font-medium text-yellow-300">${(lastShiftResult.breakdown.staffPayments || 0).toFixed(2)}</span>
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



          {effectiveMode === 'checkin' && (
            // Multi-step Check-in Form with Glassmorphism
            <div className="space-y-4">
              {/* Step 1: Select Staff */}
              {checkInStep === 'select-staff' && (
                <div className="space-y-4" data-testid="staff-select-section">
                  <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.selectStaff')}</h3>
                  {loading ? (
                    <div className="text-center py-12">
                      <div className="inline-block w-12 h-12 border-4 border-gray-600 border-t-blue-500 rounded-full animate-spin shadow-[0_4px_12px_0_rgba(59,130,246,0.4)]"></div>
                      <p className="mt-4 liquid-glass-modal-text-muted">{t('modals.staffShift.loadingStaff')}</p>
                    </div>
                  ) : availableStaff.length === 0 ? (
                    <div className="text-center py-12 bg-white/10 dark:bg-gray-800/20 rounded-xl shadow-[0_4px_16px_0_rgba(59,130,246,0.2)]">
                      <User className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                      <p className="liquid-glass-modal-text-muted">{t('modals.staffShift.noStaffAvailable')}</p>
                    </div>
                  ) : (
                    <div className="grid gap-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar p-1">
                      {[...availableStaff]
                        .sort((a, b) => {
                          const aActive = staffActiveShifts.has(a.id);
                          const bActive = staffActiveShifts.has(b.id);
                          if (aActive && !bActive) return -1;
                          if (!aActive && bActive) return 1;
                          const aName = (a?.name || `${a?.first_name ?? ''} ${a?.last_name ?? ''}` || 'Staff').trim();
                          const bName = (b?.name || `${b?.first_name ?? ''} ${b?.last_name ?? ''}` || 'Staff').trim();
                          return aName.localeCompare(bName);
                        })
                        .map((staffMember) => {
                          const isActive = staffActiveShifts.has(staffMember.id);
                          return (
                            <button
                              key={staffMember.id}
                              onClick={() => handleStaffSelect(staffMember)}
                              className="group relative w-full overflow-hidden rounded-2xl border-2 text-left transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] shadow-lg hover:shadow-2xl bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10 p-5"
                            >
                              <div className="relative flex items-center gap-4">
                                {/* Avatar */}
                                <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-xl transition-all duration-300 ${isActive
                                  ? 'bg-gradient-to-br from-green-500/30 to-emerald-500/20 ring-2 ring-green-400/50 shadow-[0_0_20px_rgba(34,197,94,0.3)]'
                                  : 'bg-gradient-to-br from-gray-600/30 to-gray-700/20 ring-2 ring-white/10 group-hover:ring-white/30'
                                  }`}>
                                  <User className={`h-10 w-10 transition-all duration-300 ${isActive ? 'text-green-300' : 'text-gray-400 group-hover:text-white group-hover:scale-110'}`} strokeWidth={1.5} />
                                </div>

                                {/* Info */}
                                <div className="flex flex-1 flex-col justify-center min-w-0">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="truncate text-xl font-bold liquid-glass-modal-text transition-colors group-hover:text-white">
                                      {staffMember.name}
                                    </span>
                                    {isActive && (
                                      <span className="inline-flex items-center rounded-full bg-green-500/20 px-3 py-1 text-xs font-bold text-green-400 ring-2 ring-green-400/40 shadow-[0_0_15px_rgba(34,197,94,0.3)] animate-pulse">
                                        {t('shift.labels.active')}
                                      </span>
                                    )}
                                  </div>

                                  {/* Role Badges */}
                                  <div className="flex flex-wrap gap-2">
                                    {staffMember.roles && staffMember.roles.length > 0 ? (
                                      staffMember.roles
                                        .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0))
                                        .map((role, idx) => {
                                          const isCashier = role.role_name === 'cashier';
                                          const isDriver = role.role_name === 'driver';
                                          const isKitchen = role.role_name === 'kitchen';

                                          let badgeStyle = "bg-transparent text-gray-300 border-gray-400";
                                          if (isCashier || role.is_primary) badgeStyle = "bg-transparent text-orange-400 border-orange-400";
                                          else if (isDriver) badgeStyle = "bg-transparent text-cyan-400 border-cyan-400";
                                          else if (isKitchen) badgeStyle = "bg-transparent text-rose-400 border-rose-400";

                                          return (
                                            <span
                                              key={idx}
                                              className={`inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 text-sm font-bold transition-all ${badgeStyle}`}
                                            >
                                              {(role.is_primary || isCashier) && (
                                                <Star className="w-4 h-4 text-orange-400" />
                                              )}
                                              {translateRoleName(role.role_name)}
                                            </span>
                                          );
                                        })
                                    ) : (
                                      <span className="text-sm text-gray-500">{translateRoleName(staffMember.role_name)}</span>
                                    )}
                                  </div>
                                </div>

                                {/* Chevron */}
                                <div className="text-gray-400 transition-all duration-300 group-hover:translate-x-2 group-hover:text-white group-hover:scale-125">
                                  <ChevronRight className="h-7 w-7" strokeWidth={2} />
                                </div>
                              </div>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Enter PIN */}
              {checkInStep === 'enter-pin' && selectedStaff && (
                <div className="space-y-8 px-4">
                  {/* Back Button - Aligned to start, subtle */}
                  <div className="flex justify-start">
                    <button
                      onClick={() => setCheckInStep('select-staff')}
                      className="group flex items-center gap-2 rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 transition-all hover:bg-white/10 hover:text-white"
                    >
                      <ChevronRight className="h-4 w-4 rotate-180 transition-transform group-hover:-translate-x-1" />
                      {t('common.actions.back')}
                    </button>
                  </div>

                  {/* Staff Info Card - Centered & Premium */}
                  <div className="flex flex-col items-center justify-center space-y-4 rounded-3xl bg-white/5 p-8 text-center shadow-2xl backdrop-blur-xl border border-white/10">
                    <div className="relative">
                      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-blue-500/20 to-cyan-500/20 shadow-[0_0_30px_rgba(59,130,246,0.2)] ring-1 ring-white/20 backdrop-blur-md">
                        <User className="h-10 w-10 text-blue-400" />
                      </div>
                      {/* Active Status Dot */}
                      <div className="absolute bottom-1 right-1 h-5 w-5 rounded-full bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)] ring-4 ring-[#2a2d3e]"></div>
                    </div>

                    <div className="space-y-1">
                      <h3 className="text-2xl font-bold text-white tracking-tight">{selectedStaff.name}</h3>
                      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                        {selectedStaff.roles && selectedStaff.roles.length > 0 ? (
                          selectedStaff.roles
                            .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0))
                            .map((role, idx) => (
                              <span
                                key={`${role.role_id}-${idx}`}
                                className="inline-flex items-center gap-1.5 rounded-full border-2 border-orange-400 px-3 py-1 text-sm font-bold text-orange-400"
                              >
                                {(role.is_primary || role.role_name === 'cashier') && (
                                  <Star className="w-4 h-4 text-orange-400" />
                                )}
                                {translateRoleName(role.role_name)}
                              </span>
                            ))
                        ) : (
                          <p className="text-base font-medium text-blue-300/80">{translateRoleName(selectedStaff.role_name)}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* PIN Input Section - Modern & Clean */}
                  <div className="mx-auto w-full max-w-md space-y-4">
                    <label className="block text-center text-sm font-semibold uppercase tracking-wider text-gray-400">
                      {t('modals.staffShift.enterPIN')}
                    </label>

                    <div
                      className="relative overflow-hidden rounded-xl bg-white/5 p-1 ring-1 ring-white/10 transition-all focus-within:bg-white/10 focus-within:ring-2 focus-within:ring-blue-500/50"
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
                        placeholder=""
                        className="w-full bg-transparent py-4 text-center text-4xl font-bold tracking-[1em] text-white placeholder-gray-600 outline-none"
                        autoFocus
                        autoComplete="off"
                        style={{ textIndent: '1em' }} // Center visual adjustment for tracking
                      />

                      {/* Custom Placeholder Dots (Only if empty) */}
                      {enteredPin.length === 0 && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-4 opacity-30">
                          <div className="h-3 w-3 rounded-full bg-white"></div>
                          <div className="h-3 w-3 rounded-full bg-white"></div>
                          <div className="h-3 w-3 rounded-full bg-white"></div>
                          <div className="h-3 w-3 rounded-full bg-white"></div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action Button */}
                  <button
                    onClick={handlePinSubmit}
                    disabled={enteredPin.length !== 4}
                    className="w-full rounded-xl bg-blue-600 py-4 text-lg font-bold text-white shadow-lg shadow-blue-500/30 transition-all hover:bg-blue-500 hover:shadow-blue-500/40 hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none active:scale-[0.98]"
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"></div>
                        <span>Authenticating...</span>
                      </div>
                    ) : (
                      t('modals.staffShift.continue')
                    )}
                  </button>
                </div>
              )}

              {/* Step 3: Select Role */}
              {/* Step 3: Select Role */}
              {checkInStep === 'select-role' && selectedStaff && (
                <div className="space-y-8 px-4">
                  {/* Back Button - Aligned to start, subtle */}
                  <div className="flex justify-start">
                    <button
                      onClick={() => setCheckInStep('enter-pin')}
                      className="group flex items-center gap-2 rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 transition-all hover:bg-white/10 hover:text-white"
                    >
                      <ChevronRight className="h-4 w-4 rotate-180 transition-transform group-hover:-translate-x-1" />
                      {t('common.actions.back')}
                    </button>
                  </div>

                  {/* Header Title */}
                  <h3 className="text-xl font-bold text-slate-800 dark:text-white/90">
                    {t('modals.staffShift.selectRoleForShift')}
                  </h3>

                  <div className="grid gap-4">
                    {/* Show all staff member's assigned roles */}
                    {selectedStaff.roles && selectedStaff.roles.length > 0 ? (
                      selectedStaff.roles
                        .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)) // Primary first
                        .map((role, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleRoleSelect(role.role_name as any)}
                            className={`group relative w-full overflow-hidden rounded-2xl border p-4 text-left shadow-lg transition-all duration-300 hover:scale-[1.01] active:scale-[0.99] ${role.is_primary
                              ? 'border-blue-500/30 bg-gradient-to-r from-blue-600/20 to-slate-600/20 shadow-blue-500/5'
                              : 'border-white/10 bg-white/5 hover:bg-white/10'
                              }`}
                          >
                            <div className="flex items-center gap-5">
                              {/* Icon Container */}
                              <div
                                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border backdrop-blur-sm transition-transform duration-300 group-hover:scale-105 ${role.is_primary
                                  ? 'border-blue-400/30 bg-white/10 shadow-inner'
                                  : 'border-white/10 bg-white/5'
                                  }`}
                              >
                                <User className={`h-8 w-8 ${role.is_primary ? 'text-blue-200' : 'text-cyan-400'}`} />
                              </div>

                              {/* Content */}
                              <div className="flex flex-1 flex-col justify-center">
                                <div className="flex items-center gap-2">
                                  <span className="text-lg font-bold text-white">
                                    {translateRoleName(role.role_name)}
                                  </span>
                                  {role.is_primary && (
                                    <Star className="w-4 h-4 text-orange-400 shadow-orange-500/20 drop-shadow-sm" />
                                  )}
                                </div>
                                <span className={`text-sm ${role.is_primary ? 'text-blue-200/60' : 'text-gray-400'}`}>
                                  {role.is_primary ? t('modals.staffShift.primaryRole') : t('modals.staffShift.secondaryRole')}
                                </span>
                              </div>

                              {/* Chevron */}
                              <ChevronRight className={`h-6 w-6 transition-transform duration-300 group-hover:translate-x-1 ${role.is_primary ? 'text-blue-300/50' : 'text-cyan-500/50'}`} />
                            </div>
                          </button>

                        ))
                    ) : (
                      // Fallback to single role if roles array is empty
                      <button
                        onClick={() => handleRoleSelect(selectedStaff.role_name as any)}
                        className="group relative w-full overflow-hidden rounded-2xl border border-blue-500/30 bg-gradient-to-r from-blue-600/20 to-slate-600/20 p-4 text-left shadow-lg shadow-blue-500/5 transition-all duration-300 hover:scale-[1.01] active:scale-[0.99]"
                      >
                        <div className="flex items-center gap-5">
                          {/* Icon Container */}
                          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-blue-400/30 bg-white/10 shadow-inner backdrop-blur-sm transition-transform duration-300 group-hover:scale-105">
                            <User className="h-8 w-8 text-blue-200" />
                          </div>

                          {/* Content */}
                          <div className="flex flex-1 flex-col justify-center">
                            <span className="text-lg font-bold text-white">
                              {translateRoleName(selectedStaff.role_name)}
                            </span>
                            <span className="text-sm text-blue-200/60">
                              {t('modals.staffShift.yourAssignedRole')}
                            </span>
                          </div>

                          {/* Chevron */}
                          <ChevronRight className="h-6 w-6 text-blue-300/50 transition-transform duration-300 group-hover:translate-x-1" />
                        </div>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Step 4: Enter Opening Cash */}
              {checkInStep === 'enter-cash' && (
                <div className="space-y-6">
                  <button
                    onClick={() => setCheckInStep(selectedStaff?.roles && selectedStaff.roles.length > 1 ? 'select-role' : 'enter-pin')}
                    className="px-4 py-2 bg-white/10 dark:bg-gray-800/20 rounded-lg shadow-[0_2px_8px_0_rgba(59,130,246,0.2)] hover:shadow-[0_4px_12px_0_rgba(59,130,246,0.35)] text-sm flex items-center gap-2 hover:gap-3 transition-all duration-300 liquid-glass-modal-text"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                    {t('modals.staffShift.back')}
                  </button>

                  {/* Dynamic heading and helper text based on role */}
                  <div className="text-center">
                    <h3 className="text-xl font-bold liquid-glass-modal-text">
                      {roleType === 'driver'
                        ? t('modals.staffShift.startingCashOptional', 'Starting Cash (Optional)')
                        : t('modals.staffShift.openingCashAmount')}
                    </h3>
                    <p className="text-sm liquid-glass-modal-text-muted mt-1">
                      {roleType === 'driver'
                        ? t('modals.staffShift.driverCashHelper', 'Optional: Amount from cashier drawer. Enter 0 to skip.')
                        : t('modals.staffShift.cashierCashHelper', 'Enter amount in drawer')}
                    </p>
                  </div>

                  {/* Warning banner for driver without active cashier */}
                  {roleType === 'driver' && !activeCashierExists && (
                    <div className="p-3 bg-yellow-500/20 border border-yellow-500/50 rounded-lg text-yellow-100 text-sm flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-yellow-400" />
                      <span>{t('modals.staffShift.noCashierWarning', 'No active cashier. Can only proceed with $0.')}</span>
                    </div>
                  )}

                  {/* Cash Input Card */}
                  <div className={liquidGlassModalCard()}>
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 rounded-xl bg-white/10 dark:bg-gray-800/20 shadow-[0_4px_12px_0_rgba(16,185,129,0.4)] flex items-center justify-center">
                        <Euro className="w-8 h-8 text-green-400" />
                      </div>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={roleType === 'driver'
                          ? (!activeCashierExists ? '0' : driverStartingAmount)
                          : openingCash}
                        onChange={(e) => {
                          const val = e.target.value.replace(/[^0-9.]/g, '');
                          if (roleType === 'driver') {
                            setDriverStartingAmount(val);
                          } else {
                            setOpeningCash(val);
                          }
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder={roleType === 'driver' ? '0.00 (optional)' : t('forms.placeholders.amount')}
                        className="liquid-glass-modal-input flex-1 text-3xl font-bold text-center"
                        readOnly={roleType === 'driver' && !activeCashierExists}
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-3">
                    {/* Skip Button - Only for drivers */}
                    {roleType === 'driver' && (
                      <button
                        onClick={() => {
                          setDriverStartingAmount('0');
                          setError('');
                          handleCheckIn();
                        }}
                        disabled={loading}
                        className="flex-1 px-6 py-3 bg-white/10 dark:bg-gray-800/20 hover:bg-white/20 dark:hover:bg-gray-800/30 text-white rounded-xl font-semibold shadow-[0_2px_8px_0_rgba(59,130,246,0.3)] hover:shadow-[0_4px_12px_0_rgba(59,130,246,0.4)] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 border border-white/20"
                      >
                        {t('modals.staffShift.skipCash', 'Skip ($0)')}
                      </button>
                    )}

                    {/* Start Shift Button */}
                    <button
                      onClick={() => {
                        setError('');
                        handleCheckIn();
                      }}
                      disabled={
                        loading ||
                        (roleType === 'driver' && !activeCashierExists && parseFloat(driverStartingAmount || '0') > 0)
                      }
                      className={`${roleType === 'driver' ? 'flex-1' : 'w-full'} px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-semibold shadow-[0_4px_16px_0_rgba(16,185,129,0.5)] hover:shadow-[0_6px_20px_0_rgba(16,185,129,0.6)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all duration-300`}
                    >
                      {loading ? (
                        <div className="flex items-center justify-center gap-3">
                          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                          {t('modals.staffShift.openingShift')}
                        </div>
                      ) : (
                        t('modals.staffShift.startShift', 'Start Shift')
                      )}
                    </button>
                  </div>

                  {/* Zero Cash Confirmation Dialog for Cashiers */}
                  {showZeroCashConfirm && roleType === 'cashier' && (
                    <div className="p-4 bg-yellow-500/20 border border-yellow-500/50 rounded-xl space-y-4">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="w-6 h-6 shrink-0 text-yellow-400" />
                        <div>
                          <h4 className="font-semibold text-yellow-200">
                            {t('modals.staffShift.zeroCashConfirmTitle', 'Confirm Zero Opening Cash')}
                          </h4>
                          <p className="text-sm text-yellow-100/80 mt-1">
                            {t('modals.staffShift.zeroCashConfirmMessage', 'You are starting your shift with $0 in the cash drawer. Are you sure you want to continue?')}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowZeroCashConfirm(false)}
                          className="flex-1 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg font-medium transition-all duration-200"
                        >
                          {t('common.actions.cancel')}
                        </button>
                        <button
                          onClick={() => {
                            setShowZeroCashConfirm(false);
                            handleCheckIn(true); // Bypass the confirmation
                          }}
                          disabled={loading}
                          className="flex-1 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-semibold transition-all duration-200 disabled:opacity-50"
                        >
                          {t('modals.staffShift.confirmZeroCash', 'Yes, Start with $0')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {effectiveMode === 'checkout' && (
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

              {isKitchenRole && effectiveShift && (
                <div className={liquidGlassModalCard()}>
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-white/10 dark:bg-gray-800/20 shadow-[0_4px_12px_0_rgba(16,185,129,0.4)] flex items-center justify-center">
                      <Clock className="w-6 h-6 text-green-400" />
                    </div>
                    <div>
                      <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.checkIn')}</div>
                      <div className="text-lg font-semibold liquid-glass-modal-text">
                        {new Date(effectiveShift.check_in_time).toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SIMPLIFIED SHIFT HEADER */}
              {effectiveShift && (
                <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 rounded-xl p-4 border border-blue-500/20">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-bold liquid-glass-modal-text text-lg">
                        {effectiveShift.staff_name || <span className="capitalize">{effectiveShift.role_type}</span>}
                      </h3>
                      <p className="text-xs text-gray-400 mt-1">
                        <span className="capitalize">{effectiveShift.role_type}</span> · Total Sales: <span className="text-green-400 font-semibold">${(shiftSummary?.breakdown?.overall?.totalAmount ?? effectiveShift.total_sales_amount ?? 0).toFixed(2)}</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-blue-300">{shiftSummary?.breakdown?.overall?.totalCount ?? effectiveShift.total_orders_count ?? 0}</div>
                      <p className="text-xs text-gray-400">Orders</p>
                    </div>
                  </div>
                </div>
              )}

              {/* CASH RECONCILIATION - Only for Cashier */}
              {shiftSummary && effectiveShift?.role_type === 'cashier' && (
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
                      <span className="font-bold text-blue-300">${(effectiveShift.opening_cash_amount || 0).toFixed(2)}</span>
                    </div>

                    {/* Plus Cash Orders */}
                    <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                      <span className="text-sm text-green-200">{t('modals.staffShift.cashOrdersLabel')}</span>
                      <span className="font-bold text-green-300">${(shiftSummary.breakdown?.overall?.cashTotal || 0).toFixed(2)}</span>
                    </div>

                    {/* Minus Canceled */}
                    {shiftSummary.canceledOrders?.cashTotal > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.canceledOrdersLabel')}</span>
                        <span className="font-bold text-red-300">${(shiftSummary.canceledOrders?.cashTotal || 0).toFixed(2)}</span>
                      </div>
                    )}

                    {/* Minus Expenses */}
                    {shiftSummary.totalExpenses > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.expensesLabel')}</span>
                        <span className="font-bold text-red-300">${(shiftSummary.totalExpenses || 0).toFixed(2)}</span>
                      </div>
                    )}

                    {/* Minus Cash Drops */}
                    {(shiftSummary.cashDrawer?.cash_drops || 0) > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.cashDropsLabel')}</span>
                        <span className="font-bold text-red-300">-${(shiftSummary.cashDrawer?.cash_drops || 0).toFixed(2)}</span>
                      </div>
                    )}

                    {/* Individual Driver/Waiter Breakdown Cards */}
                    {shiftSummary.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (
                      <div className="space-y-2">
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
                                ? 'bg-gradient-to-r from-red-900/20 to-green-900/20 border-amber-600/40'
                                : 'bg-red-900/30 border-red-600/40'}`}>
                                <div className="flex justify-between items-start mb-2">
                                  <div>
                                    <span className="text-xs text-gray-400 uppercase">{driver.role}</span>
                                    <div className="font-semibold text-white">{driver.name}</div>
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
                                  <div className={`flex justify-between font-bold pt-1 border-t border-white/20 ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                                    <span>= {isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}</span>
                                    <span>{isPositive ? '+' : '-'}€{Math.abs(returns).toFixed(2)}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}

                    {/* Plus Inherited Driver Returns */}
                    {(() => {
                      const inheritedDrivers = shiftSummary?.transferredDrivers || [];
                      const inheritedDriverExpectedReturns = inheritedDrivers.reduce((sum: number, d: any) => sum + (d.net_cash_amount || 0), 0);
                      if (inheritedDriverExpectedReturns <= 0) return null;
                      return (
                        <div className="flex justify-between items-center p-3 bg-purple-900/30 rounded-lg border border-purple-600/40">
                          <div className="flex flex-col">
                            <span className="text-sm text-purple-200">{t('modals.staffShift.inheritedDriverReturnsLabel')}</span>
                            <span className="text-xs text-purple-300/70">{inheritedDrivers.length} {t('modals.staffShift.transferredDriversCount', 'drivers transferred')}</span>
                          </div>
                          <span className="font-bold text-purple-300">+${inheritedDriverExpectedReturns.toFixed(2)}</span>
                        </div>
                      );
                    })()}

                    {/* Expected Amount */}
                    {(() => {
                      const opening = effectiveShift.opening_cash_amount || 0;
                      // Use instore only (pickup/dine-in) - delivery cash is tracked via driver returns
                      const cashTotal = shiftSummary.breakdown?.instore?.cashTotal || 0;
                      const cashRefunds = shiftSummary.cashRefunds || 0;
                      const expensesTotal = shiftSummary.totalExpenses || 0;
                      const cashDrops = shiftSummary.cashDrawer?.cash_drops || 0;
                      const driverGiven = shiftSummary.cashDrawer?.driver_cash_given || 0;
                      const driverReturned = shiftSummary.cashDrawer?.driver_cash_returned || 0;
                      // Get inherited driver expected returns (drivers transferred TO this cashier)
                      const inheritedDrivers = shiftSummary?.transferredDrivers || [];
                      const inheritedDriverExpectedReturns = inheritedDrivers.reduce((sum: number, d: any) => sum + (d.net_cash_amount || 0), 0);
                      // V2 Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns
                      // Note: staffPayments is informational only and NOT deducted from expected amount
                      const expected = opening + cashTotal - cashRefunds - expensesTotal - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns;
                      return (
                        <>
                          <div className="flex justify-between items-center p-3 bg-cyan-900/30 rounded-lg border-2 border-cyan-500/50 font-semibold">
                            <span className="text-sm text-cyan-200">{t('modals.staffShift.expectedAmountLabel')}</span>
                            <span className="text-lg text-cyan-300">${expected.toFixed(2)}</span>
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
              )}

              {/* Expenses Section */}
              {!isKitchenRole && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.expenses')}</h3>
                    <button
                      onClick={() => setShowExpenseForm(!showExpenseForm)}
                      className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-[0_2px_8px_0_rgba(59,130,246,0.4)] transition-all duration-300"
                    >
                      <Plus className="w-4 h-4" />
                      {t('modals.staffShift.addExpense')}
                    </button>
                  </div>

                  {showExpenseForm && (
                    <div className={liquidGlassModalCard() + ' space-y-3 mb-4'}>
                      <select
                        value={expenseType}
                        onChange={(e) => setExpenseType(e.target.value as any)}
                        className="liquid-glass-modal-input text-sm"
                      >
                        <option value="supplies">{t('expense.categories.supplies')}</option>
                        <option value="maintenance">{t('expense.categories.maintenance')}</option>
                        <option value="petty_cash">{t('expense.categories.petty_cash')}</option>
                        <option value="refund">{t('expense.categories.refund')}</option>
                        <option value="other">{t('expense.categories.other')}</option>
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
                        placeholder={t('modals.expense.amountPlaceholder')}
                        className="liquid-glass-modal-input text-sm"
                      />

                      <input
                        type="text"
                        value={expenseDescription}
                        onChange={(e) => setExpenseDescription(e.target.value)}
                        placeholder={t('modals.expense.descriptionPlaceholder')}
                        className="liquid-glass-modal-input text-sm"
                      />

                      <input
                        type="text"
                        value={expenseReceipt}
                        onChange={(e) => setExpenseReceipt(e.target.value)}
                        placeholder={t('modals.expense.receiptPlaceholder')}
                        className="liquid-glass-modal-input text-sm"
                      />

                      <button
                        onClick={handleRecordExpense}
                        disabled={loading}
                        className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg text-sm shadow-[0_4px_16px_0_rgba(16,185,129,0.5)] hover:shadow-[0_6px_20px_0_rgba(16,185,129,0.6)] transition-all duration-300"
                      >
                        {t('modals.expense.recordButton')}
                      </button>
                    </div>
                  )}

                  {expenses.length > 0 ? (
                    <div className="space-y-2">
                      {expenses.map((expense) => (
                        <div key={expense.id} className="flex items-center justify-between p-3 bg-gray-50/50 dark:bg-gray-800/60 border liquid-glass-modal-border rounded-xl text-sm">
                          <div className="flex-1">
                            <div className="font-medium liquid-glass-modal-text">{expense.description}</div>
                            <div className="liquid-glass-modal-text-muted capitalize text-xs">{expense.expense_type}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold liquid-glass-modal-text">${expense.amount.toFixed(2)}</div>
                            <div className={`text-xs ${expense.status === 'approved' ? 'text-green-400' :
                              expense.status === 'rejected' ? 'text-red-400' :
                                'text-yellow-400'
                              }`}>
                              {t('expense.status.' + expense.status)}
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-3 border-t liquid-glass-modal-border">
                        <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalExpenses')}:</span>
                        <span className="font-bold text-red-400 text-lg">${totalExpenses.toFixed(2)}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">{t('modals.expense.noExpenses')}</p>
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
                            <div className="font-bold text-green-300">${cashTotal.toFixed(2)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 text-blue-300 ml-auto" />
                            <div className="font-bold text-blue-300">${cardTotal.toFixed(2)}</div>
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
                                    <td className="px-3 py-2 text-right font-medium text-gray-200" role="cell">${delivery.total_amount.toFixed(2)}</td>
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
                                  <div className="liquid-glass-modal-text-muted text-sm">${delivery.total_amount.toFixed(2)}</div>
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
                                  <div className="font-semibold text-green-400">${delivery.delivery_fee.toFixed(2)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Tip</div>
                                  <div className="font-semibold text-green-400">${delivery.tip_amount.toFixed(2)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash Collected</div>
                                  <div className="font-semibold liquid-glass-modal-text">${delivery.cash_collected.toFixed(2)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash to Return</div>
                                  <div className="font-semibold text-yellow-400">${delivery.cash_to_return.toFixed(2)}</div>
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
                            <div className="font-bold text-green-300">${cashTotal.toFixed(2)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 text-blue-300 ml-auto" />
                            <div className="font-bold text-blue-300">${cardTotal.toFixed(2)}</div>
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
                                    <td className="px-3 py-2 text-right font-medium text-gray-200" role="cell">${table.total_amount.toFixed(2)}</td>
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
                                  <div className="font-semibold liquid-glass-modal-text">Table {table.table_number}</div>
                                  <div className="liquid-glass-modal-text-muted text-sm">{table.order_count} Orders</div>
                                </div>
                                <div className="text-right">
                                  <div className="font-bold text-green-400">${table.total_amount.toFixed(2)}</div>
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
                                    <span className="liquid-glass-modal-text">${order.total_amount.toFixed(2)} ({order.payment_method})</span>
                                  </div>
                                )) : null}
                              </div>

                              {/* Breakdown */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Cash</div>
                                  <div className="font-semibold text-green-400">${table.cash_amount.toFixed(2)}</div>
                                </div>
                                <div className="bg-white/10 dark:bg-gray-800/20 rounded p-2 border liquid-glass-modal-border">
                                  <div className="liquid-glass-modal-text-muted">Card</div>
                                  <div className="font-semibold text-blue-400">${table.card_amount.toFixed(2)}</div>
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
                        const opening = effectiveShift.opening_cash_amount || 0;
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
                                <span className="text-green-400">+${opening.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.cashCollected', 'Cash Collected')}</span>
                                <span className="text-green-400">+${cashFromTables.toFixed(2)}</span>
                              </div>
                              <div className={`flex justify-between ${calculationVersion >= 2 ? 'border-b liquid-glass-modal-border pb-2' : ''}`}>
                                <span className="text-gray-400">{t('modals.staffShift.expenses', 'Expenses')}</span>
                                <span className="text-red-400">-${expensesTotal.toFixed(2)}</span>
                              </div>
                              {/* v1: Show payment as deduction in the breakdown */}
                              {calculationVersion < 2 && paymentAmount > 0 && (
                                <div className="flex justify-between border-b liquid-glass-modal-border pb-2">
                                  <span className="text-gray-400">{t('modals.staffShift.payment', 'Payment')}</span>
                                  <span className="text-red-400">-${paymentAmount.toFixed(2)}</span>
                                </div>
                              )}
                              {/* v1: Add border after expenses if no payment */}
                              {calculationVersion < 2 && paymentAmount === 0 && (
                                <div className="border-b liquid-glass-modal-border"></div>
                              )}
                              <div className="flex justify-between pt-1 font-bold text-lg">
                                <span className="text-gray-200">{label}</span>
                                <span className={colorClass}>${Math.abs(cashToReturn).toFixed(2)}</span>
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
                        <div className="text-xl font-bold text-green-500">${overall.totalAmount.toFixed(2)}</div>
                      </div>
                    </div>

                    {/* Pickup / Delivery by method */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.pickupCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{instore.cashCount} orders</span>
                          <span className="font-bold text-green-500">${instore.cashTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.pickupCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{instore.cardCount} orders</span>
                          <span className="font-bold text-slate-800 dark:text-white">${instore.cardTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.deliveryCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{delivery.cashCount} orders</span>
                          <span className="font-bold text-green-500">${delivery.cashTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.deliveryCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200">{delivery.cardCount} orders</span>
                          <span className="font-bold text-slate-800 dark:text-white">${delivery.cardTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Totals by channel with cash amount */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalPickupOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{totalPickupOrders} orders</span>
                          <span className="font-bold text-green-500">${(instore.cashTotal + instore.cardTotal).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalDeliveryOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{totalDeliveryOrders} orders</span>
                          <span className="font-bold text-green-500">${(delivery.cashTotal + delivery.cardTotal).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{overall.totalCount} orders</span>
                          <span className="font-bold text-green-500">${overall.totalAmount.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('modals.staffShift.totalCashOrders')}</div>


                        <div className="flex justify-between text-sm">
                          <span className="text-slate-700 dark:text-slate-200 font-semibold">{totalCashOrdersCount} orders</span>
                          <span className="font-bold text-green-500">${overall.cashTotal.toFixed(2)}</span>
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
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-3">{t('modals.staffShift.driversCheckout')}</h3>
                    <div className="space-y-2">
                      {drivers.map((driver: any) => {
                        const startingAmount = driver.starting_amount || 0;
                        const earnings = driver.cash_collected || driver.driver_payment || 0;
                        const expenses = driver.expenses || 0;
                        // Calculate what driver returns to drawer
                        const returns = startingAmount + earnings - expenses;
                        const isPositive = returns >= 0;
                        const roleType = driver.role_type || t('modals.staffShift.driverRole');

                        return (
                          <div key={driver.driver_id} className={`p-3 rounded-xl border ${isPositive
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
                                <div className="text-xs text-gray-400">{t('modals.staffShift.driverStarting')}</div>
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
                      onClick={() => setShowStaffPaymentForm(!showStaffPaymentForm)}
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
                                const shiftDate = effectiveShift?.check_in_time ? new Date(effectiveShift.check_in_time).toISOString().split('T')[0] : undefined;
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
                              {t('modals.staffShift.paymentHistory', "Today's Payments")}
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
                          {t('modals.staffShift.amount', 'Amount')}
                          {expectedPayment !== null && (
                            <span className="ml-2 text-xs text-blue-400">
                              ({t('modals.staffShift.expected', 'Expected')}: €{expectedPayment.toFixed(2)})
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
                              const val = e.target.value.replace(/[^0-9.]/g, '');
                              setPaymentAmount(val);
                            }}
                            onFocus={(e) => e.target.select()}
                            placeholder={expectedPayment ? `€${expectedPayment.toFixed(2)}` : "0.00"}
                            className="liquid-glass-modal-input w-full pl-9"
                          />
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-300 mb-1">{t('modals.staffShift.notes', 'Notes (optional)')}</label>
                        <input
                          type="text"
                          value={paymentNotes}
                          onChange={(e) => setPaymentNotes(e.target.value)}
                          placeholder={t('modals.staffShift.paymentNotesPlaceholder', 'e.g., End of shift payment')}
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
                          {loading ? t('common.saving', 'Saving...') : t('modals.staffShift.recordPayment', 'Record Payment')}
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
                            <div className="font-semibold liquid-glass-modal-text">{p.staff_name || 'Unknown'}</div>
                            <div className="liquid-glass-modal-text-muted text-xs capitalize">{p.payment_type}{p.notes ? ` • ${p.notes}` : ''}</div>
                          </div>
                          <div className="font-bold text-red-400">-${p.amount.toFixed(2)}</div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-2 border-t border-white/10">
                        <span className="text-sm font-semibold liquid-glass-modal-text">{t('modals.staffShift.sessionTotal', 'Session Total')}</span>
                        <span className="font-bold text-red-400">
                          -${staffPaymentsList.reduce((s, p) => s + p.amount, 0).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Staff Payments (details) - Historical from summary */}
              {effectiveShift?.role_type === 'cashier' && Array.isArray(shiftSummary?.staffPayments) && shiftSummary.staffPayments.length > 0 && (
                <div className={liquidGlassModalCard() + ' space-y-3'}>
                  <h3 className="text-xl font-bold liquid-glass-modal-text mb-2">{t('modals.staffShift.staffPaymentsTitle')}</h3>
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
                        <div key={p.id} className="flex items-center justify-between p-3 bg-white/10 dark:bg-gray-800/20 rounded-xl border liquid-glass-modal-border text-sm">
                          <div className="flex-1">
                            <div className="font-semibold liquid-glass-modal-text">{name}</div>
                            <div className="liquid-glass-modal-text-muted text-xs">{role} • {hours.toFixed(2)} h</div>
                          </div>
                          <div className="font-bold text-red-400">-${amt.toFixed(2)}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t liquid-glass-modal-border">
                    <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalStaffPayments')}</span>
                    <span className="font-bold text-red-400">
                      -${(shiftSummary.staffPayments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0)).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {/* CASHIER INPUT FIELDS - Redesigned */}
              {effectiveShift?.role_type === 'cashier' && (
                <div className="space-y-3">
                  {/* Cashier Payment */}
                  <div className="bg-white/5 rounded-lg p-4 border border-white/10">
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
                          const val = e.target.value.replace(/[^0-9.]/g, '');
                          setStaffPayment(val);
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder={t('forms.placeholders.amount')}
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                      />
                    </div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-2">{t('modals.staffShift.cashierPaymentHelper')}</p>
                  </div>

                  {/* Closing Cash */}
                  <div className="bg-white/5 rounded-lg p-4 border border-white/10">
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
                          // Only allow numbers and decimal point
                          const val = e.target.value.replace(/[^0-9.]/g, '');
                          setClosingCash(val);
                        }}
                        onFocus={(e) => e.target.select()}
                        placeholder={t('forms.placeholders.amount')}
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                        autoFocus
                      />
                    </div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-2">{t('modals.staffShift.closingCashHelper')}</p>
                  </div>

                  {/* Live Variance Calculation */}
                  {(() => {
                    const opening = effectiveShift.opening_cash_amount || 0;
                    // Use instore only (pickup/dine-in) - delivery cash is tracked via driver returns
                    const totalCashOrders = shiftSummary?.breakdown?.instore?.cashTotal || 0;
                    const cashRefunds = shiftSummary?.cashRefunds || 0;
                    // Use local expenses state (which shows in UI) instead of shiftSummary.totalExpenses
                    const expensesTotal = expenses.reduce((sum, exp) => sum + exp.amount, 0);
                    const cashDrops = shiftSummary?.cashDrawer?.cash_drops || 0;
                    const driverGiven = shiftSummary?.cashDrawer?.driver_cash_given || 0;
                    const driverReturned = shiftSummary?.cashDrawer?.driver_cash_returned || 0;
                    // Get inherited driver expected returns (drivers transferred TO this cashier)
                    const inheritedDrivers = shiftSummary?.transferredDrivers || [];
                    const inheritedDriverExpectedReturns = inheritedDrivers.reduce((sum: number, d: any) => sum + (d.net_cash_amount || 0), 0);
                    // V2 Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned + inheritedDrivers
                    // Note: Staff payments are informational only and NOT deducted from expected amount
                    const expected = opening + totalCashOrders - cashRefunds - expensesTotal - cashDrops - driverGiven + driverReturned + inheritedDriverExpectedReturns;

                    // Debug logging - check shift ID and all values
                    console.log('[LiveVariance] Values (v2):', {
                      opening, totalCashOrders, cashRefunds, expensesTotal, cashDrops,
                      driverGiven, driverReturned, inheritedDriverExpectedReturns, expected
                    });

                    const actual = parseFloat(closingCash || '0') || 0;
                    const variance = actual - expected;

                    // Only show if user has started typing actual cash (optional, but good UX)
                    if (!closingCash) return null;

                    return (
                      <div className="flex flex-col items-center gap-2 mt-4 animate-in fade-in slide-in-from-top-2">
                        {/* Debug: show calculation breakdown */}
                        <div className="text-xs text-gray-400">
                          Expected: {opening} + {totalCashOrders} - {cashRefunds} - {expensesTotal} - {cashDrops} - {driverGiven} + {driverReturned} + {inheritedDriverExpectedReturns} = {expected.toFixed(2)} | Actual: {actual}
                        </div>
                        <POSGlassTooltip content={t('modals.staffShift.varianceExplanation', 'Difference between counted cash and expected cash')}>
                          <VarianceBadge variance={variance} size="lg" showIcon />
                        </POSGlassTooltip>
                      </div>
                    );
                  })()}
                </div>
              )}



              {/* Staff Payment Input (for kitchen) or Driver Payment (for driver) */}
              {isKitchenRole && (
                <div className={liquidGlassModalCard()}>
                  <label className="block liquid-glass-modal-text text-sm font-medium mb-3">
                    Staff Payment (from drawer)
                  </label>
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-xl bg-white/10 dark:bg-gray-800/20 shadow-[0_4px_12px_0_rgba(16,185,129,0.4)] flex items-center justify-center">
                      <Euro className="w-8 h-8 text-green-400" />
                    </div>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={staffPayment}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^0-9.]/g, '');
                        setStaffPayment(val);
                      }}
                      onFocus={(e) => e.target.select()}
                      placeholder={t('forms.placeholders.amount')}
                      className="liquid-glass-modal-input flex-1 text-3xl font-bold text-center"
                      autoFocus
                    />
                  </div>
                  {/* Note: Payments are recorded by cashier */}
                  <div className="bg-blue-900/20 rounded-lg p-2 border border-blue-500/30 mt-3">
                    <p className="text-xs text-blue-300 text-center">
                      {t('modals.staffShift.kitchenPaymentNote', 'Payment will be recorded by the cashier when you check out')}
                    </p>
                  </div>
                </div>
              )}

              {/* DRIVER CHECKOUT - Earnings Calculation */}
              {effectiveShift?.role_type === 'driver' && shiftSummary && (() => {
                const startingAmount = effectiveShift.opening_cash_amount || 0;

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

                // Driver payments are now handled at cashier checkout (centralized)
                // So we use 0 for driver payment in the calculation
                const driverPayment = 0;

                // Calculate amount to return to cashier
                // Formula: Starting Amount + Cash Collected - Expenses
                // Payment is not deducted here - it's handled at cashier checkout
                const amountToReturn = startingAmount + cashCollected - totalExpenses;

                return (
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="bg-gradient-to-r from-indigo-500/20 to-purple-500/20 rounded-xl p-4 border border-indigo-500/30">
                      <h3 className="text-lg font-bold text-indigo-300 mb-1">{t('modals.staffShift.driverCheckout')}</h3>
                      <p className="text-xs text-indigo-200/70">{t('modals.staffShift.driverEarnings')}</p>
                    </div>

                    {/* Earnings Summary */}
                    <div className="space-y-2">
                      {/* Starting Amount (cash taken from cashier) */}
                      <div className="flex justify-between items-center p-3 bg-blue-900/30 rounded-lg border border-blue-600/40">
                        <span className="text-sm text-blue-200">{t('modals.staffShift.startingAmount')}</span>
                        <span className="font-bold text-blue-300">+${startingAmount.toFixed(2)}</span>
                      </div>

                      {/* Cash Collected (from deliveries) */}
                      <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                        <span className="text-sm text-green-200">
                          {t('modals.staffShift.cashCollected')} ({completedDeliveries.length} {t('modals.staffShift.completedOrdersLabel')})
                        </span>
                        <span className="font-bold text-green-300">+${cashCollected.toFixed(2)}</span>
                      </div>

                      {/* Expenses (if any) */}
                      {totalExpenses > 0 && (
                        <div className="flex justify-between items-center p-3 bg-orange-900/30 rounded-lg border border-orange-600/40">
                          <span className="text-sm text-orange-200">{t('modals.staffShift.totalExpenses')}</span>
                          <span className="font-bold text-orange-300">-${totalExpenses.toFixed(2)}</span>
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
                          ${amountToReturn.toFixed(2)}
                        </span>
                      </div>

                      {/* Formula Explanation */}
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-600/30 mt-2">
                        <p className="text-xs text-slate-400 text-center">
                          <span className="font-semibold text-slate-300">{t('receipt.formula.label')}</span>{' '}
                          {t('receipt.formula.driver')}
                        </p>
                      </div>

                      {/* Note: Driver payments are handled at cashier checkout */}
                      <div className="bg-blue-900/20 rounded-lg p-3 border border-blue-500/30 mt-2">
                        <p className="text-xs text-blue-300 text-center">
                          {t('modals.staffShift.driverPaymentNote', 'Driver payment will be recorded when you return cash to the cashier')}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <button
                onClick={() => {
                  console.log('🔴 BUTTON CLICKED!');
                  handleCheckOut();
                }}
                disabled={loading}
                className="w-full px-6 py-4 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-xl font-bold text-lg shadow-[0_4px_16px_0_rgba(239,68,68,0.5)] hover:shadow-[0_6px_24px_0_rgba(239,68,68,0.7)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all duration-300 flex items-center justify-center gap-3"
              >
                {loading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                    {t('modals.staffShift.closingShift')}
                  </>
                ) : (
                  <>
                    <Check className="w-5 h-5" />
                    {t('modals.staffShift.checkOut')}
                  </>
                )}
              </button>
            </div>
          )
          }
        </div >
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
