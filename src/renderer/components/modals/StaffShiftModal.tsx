import React, { useState, useEffect, useRef } from 'react';
import { X, Clock, DollarSign, FileText, Plus, AlertCircle, User, ChevronRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense } from '../../types';
import useTerminalSettings from '../../hooks/useTerminalSettings';
import { sectionTitle, sectionSubtle, inputBase, liquidGlassModalCard, liquidGlassModalButton } from '../../styles/designSystem';
import { LiquidGlassModal, POSGlassBadge, POSGlassCard } from '../ui/pos-glass-components';
import { POSGlassTooltip } from '../ui/POSGlassTooltip';
import { VarianceBadge } from '../ui/VarianceBadge';
import { ProgressStepper, Step, StepStatus } from '../ui/ProgressStepper';
import { ConfirmDialog, ConfirmVariant } from '../ui/ConfirmDialog';
import { ErrorAlert } from '../ui/ErrorAlert';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { SUPABASE_CONFIG } from '../../../shared/supabase-config';

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

type CheckInStep = 'select-staff' | 'enter-pin' | 'select-role' | 'enter-cash';

export function StaffShiftModal({ isOpen, onClose, mode, hideCashDrawer = false, isMobileWaiter = false }: StaffShiftModalProps) {
  console.log('🔄 StaffShiftModal loaded - VERSION 2.0 with SUPABASE_CONFIG');
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift, setStaff, setActiveShiftImmediate } = useShift();

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
      expenses: number;
      payments: number;
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
          const result = await (window as any).electronAPI.getShiftSummary(effectiveShift.id, { skipBackfill: true });
          // IPC handlers wrap response in { success: true, data: ... }
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
        const result = await (window as any).electronAPI?.getActiveShift?.(s.id);
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
      // Fetch staff from Supabase via Electron API
      const supabaseUrl = SUPABASE_CONFIG.url;
      const supabaseKey = SUPABASE_CONFIG.anonKey;

      console.log('[loadStaff] Supabase config:', {
        url: supabaseUrl?.substring(0, 30) + '...',
        hasKey: !!supabaseKey
      });

      if (!supabaseUrl || !supabaseKey) {
        throw new Error('Supabase configuration missing');
      }

      // Use PostgREST syntax for joining with roles table
      // Note: We don't fetch pin_hash for security reasons - PIN verification is done server-side
      // Determine branch for this terminal; prefer settings hook, then IPC
      let branchId: string | undefined;

      // 1) Try hook-provided settings (fast path)
      branchId = getSetting?.('terminal', 'branch_id') as string | undefined;

      // 2) Try IPC getter for a specific setting (existing, stable handler)
      if (!branchId && (window as any).electronAPI?.getTerminalSetting) {
        try {
          const val = await (window as any).electronAPI.getTerminalSetting('terminal', 'branch_id');
          if (val) branchId = val as string;
        } catch (e) {
          console.warn('[StaffShiftModal] getTerminalSetting fallback failed:', e);
        }
      }

      // 2b) Try local settings store (legacy SettingsService)
      if (!branchId) {
        try {
          const local = await (window as any).electronAPI?.invoke?.('get-settings');
          const flat = local?.['terminal.branch_id'] ?? local?.terminal?.branch_id;
          if (flat) branchId = flat as string;
        } catch (e) {
          console.warn('[StaffShiftModal] local get-settings fallback failed:', e);
        }
      }

      // 3) Skipped: branch-id IPC to avoid console noise when handler not registered in older builds

      // Resolve terminalId candidates for further fallbacks
      let terminalId = getSetting?.('terminal', 'terminal_id') as string | undefined;
      if (!terminalId && (window as any).electronAPI?.getTerminalSetting) {
        try {
          const tid = await (window as any).electronAPI.getTerminalSetting('terminal', 'terminal_id');
          if (tid) terminalId = tid as string;
        } catch (e) {
          console.warn('[StaffShiftModal] getTerminalSetting terminal_id failed:', e);
        }
      }
      if (!terminalId) {
        try {
          const local = await (window as any).electronAPI?.invoke?.('get-settings');
          const flatTid = local?.['terminal.terminal_id'] ?? local?.terminal?.terminal_id;
          if (flatTid) terminalId = flatTid as string;
          // Also consider local branch_id if still missing
          if (!branchId) {
            const flatBid = local?.['terminal.branch_id'] ?? local?.terminal?.branch_id;
            if (flatBid) branchId = flatBid as string;
          }
        } catch (e) {
          console.warn('[StaffShiftModal] local settings terminal_id fallback failed:', e);
        }
      }

      // 3b) Renderer fallback: derive branch via pos_configurations using terminal_id
      if (!branchId && terminalId) {
        try {
          const cfgUrl = `${supabaseUrl}/rest/v1/pos_configurations?select=branch_id&terminal_id=eq.${encodeURIComponent(terminalId)}&is_active=eq.true&order=updated_at.desc&limit=1`;
          const cfgRes = await fetch(cfgUrl, {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            }
          });
          if (cfgRes.ok) {
            const arr = await cfgRes.json();
            if (Array.isArray(arr) && arr.length > 0 && arr[0]?.branch_id) {
              branchId = arr[0].branch_id as string;
            }
          } else {
            const txt = await cfgRes.text();
            console.warn('[StaffShiftModal] pos_configurations fetch failed:', cfgRes.status, txt);
          }
        } catch (e) {
          console.warn('[StaffShiftModal] Renderer fallback to pos_configurations failed:', e);
        }
      }

      // 3c) Final fallback: pos_terminals lookup (anon SELECT allowed by RLS)
      if (!branchId && terminalId) {
        try {
          const termUrl = `${supabaseUrl}/rest/v1/pos_terminals?select=branch_id,terminal_id&terminal_id=eq.${encodeURIComponent(terminalId)}&limit=1`;
          const termRes = await fetch(termUrl, {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            }
          });
          if (termRes.ok) {
            const arr = await termRes.json();
            if (Array.isArray(arr) && arr.length > 0 && arr[0]?.branch_id) {
              branchId = arr[0].branch_id as string;
            }
          } else {
            const txt = await termRes.text();
            console.warn('[StaffShiftModal] pos_terminals fetch failed:', termRes.status, txt);
          }
        } catch (e) {
          console.warn('[StaffShiftModal] Renderer fallback to pos_terminals failed:', e);
        }
      }

      // 3d) Best-effort IPC for branchId (safe, wrapped)
      if (!branchId && (window as any).electronAPI?.getTerminalBranchId) {
        try {
          const bid = await (window as any).electronAPI.getTerminalBranchId();
          if (bid) branchId = bid as string;
        } catch (e) {
          console.warn('[StaffShiftModal] getTerminalBranchId IPC failed (non-fatal):', e);
        }
      }

      // Require branch scoping: if missing, abort with clear message
      if (!branchId) {
        console.warn('[StaffShiftModal] No branchId available; aborting staff fetch');
        throw new Error('This POS is not assigned to a branch. Configure terminal → branch in Admin or POS settings.');
      }

      // Helper function to load all roles for staff members
      const loadStaffRoles = async (staffList: StaffMember[]) => {
        console.log('[loadStaffRoles] Starting to load roles for staff list:', staffList.length, 'members');
        try {
          // supabaseUrl and supabaseKey are already available in parent scope
          if (!supabaseUrl || !supabaseKey) {
            console.warn('[loadStaffRoles] Supabase credentials not available for loading staff roles');
            return;
          }

          // First, fetch all roles to have a lookup map (this avoids RLS issues with embedded joins)
          const rolesLookupUrl = `${supabaseUrl}/rest/v1/roles?select=id,name,display_name,color&is_active=eq.true`;
          console.log('[loadStaffRoles] Fetching all roles for lookup...');
          const rolesLookupRes = await fetch(rolesLookupUrl, {
            method: 'GET',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            }
          });

          const rolesMap = new Map<string, { name: string; display_name: string; color: string }>();
          if (rolesLookupRes.ok) {
            const allRoles = await rolesLookupRes.json();
            console.log('[loadStaffRoles] Fetched', allRoles.length, 'roles for lookup');
            allRoles.forEach((r: any) => {
              rolesMap.set(r.id, {
                name: r.name || 'staff',
                display_name: r.display_name || 'Staff',
                color: r.color || '#6B7280'
              });
            });
          } else {
            console.warn('[loadStaffRoles] Failed to fetch roles lookup:', rolesLookupRes.status);
          }

          // Fetch all staff roles for the staff members
          const staffIds = staffList.map(s => s.id);
          console.log('[loadStaffRoles] Staff IDs to fetch roles for:', staffIds);

          // Fetch staff_roles without embedded join (simpler, avoids RLS issues)
          const fetchUrl = `${supabaseUrl}/rest/v1/staff_roles?staff_id=in.(${staffIds.join(',')})&select=staff_id,role_id,is_primary`;
          console.log('[loadStaffRoles] Fetching staff_roles from URL:', fetchUrl);

          const rolesRes = await fetch(fetchUrl, {
            method: 'GET',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': 'application/json',
            }
          });

          console.log('[loadStaffRoles] Fetch response status:', rolesRes.status, rolesRes.statusText);
          if (rolesRes.ok) {
            const rolesData = await rolesRes.json();
            console.log('[loadStaffRoles] Fetched staff_roles data:', rolesData.length, 'records');

            // Group roles by staff_id, using the rolesMap lookup for role details
            const rolesByStaff = new Map<string, StaffRole[]>();
            rolesData.forEach((sr: any) => {
              if (!rolesByStaff.has(sr.staff_id)) {
                rolesByStaff.set(sr.staff_id, []);
              }
              // Look up role details from our pre-fetched rolesMap
              const roleDetails = rolesMap.get(sr.role_id);
              console.log('[loadStaffRoles] Role lookup for role_id', sr.role_id, ':', roleDetails);

              rolesByStaff.get(sr.staff_id)!.push({
                role_id: sr.role_id,
                role_name: roleDetails?.name || 'staff',
                role_display_name: roleDetails?.display_name || 'Staff',
                role_color: roleDetails?.color || '#6B7280',
                is_primary: sr.is_primary || false
              });
            });

            console.log('[loadStaffRoles] Grouped roles by staff:', rolesByStaff);

            // Assign roles to staff members
            staffList.forEach(staff => {
              const staffRoles = rolesByStaff.get(staff.id) || [];

              console.log(`[loadStaffRoles] Staff ${staff.name} (${staff.id}):`, staffRoles.length, 'roles from staff_roles table');

              // If no roles in staff_roles table, use primary role from staff table with rolesMap lookup
              if (staffRoles.length === 0 && staff.role_id) {
                // Look up role details from rolesMap
                const roleDetails = rolesMap.get(staff.role_id);
                staff.roles = [{
                  role_id: staff.role_id,
                  role_name: roleDetails?.name || staff.role_name || 'staff',
                  role_display_name: roleDetails?.display_name || staff.role_display_name || 'Staff',
                  role_color: roleDetails?.color || '#6B7280',
                  is_primary: true
                }];
                console.log(`[loadStaffRoles] No roles in staff_roles, using primary role for ${staff.name}:`, staff.roles[0].role_display_name);
              } else {
                staff.roles = staffRoles;
                console.log(`[loadStaffRoles] Assigned ${staffRoles.length} roles to ${staff.name}:`, staffRoles.map(r => r.role_display_name).join(', '));
              }
            });
          } else {
            console.error('[loadStaffRoles] Failed to fetch staff_roles, status:', rolesRes.status);
            const errorText = await rolesRes.text();
            console.error('[loadStaffRoles] Error response:', errorText);
            // Fallback: use rolesMap with primary role_id from staff table
            staffList.forEach(staff => {
              if (staff.role_id) {
                const roleDetails = rolesMap.get(staff.role_id);
                staff.roles = [{
                  role_id: staff.role_id,
                  role_name: roleDetails?.name || staff.role_name || 'staff',
                  role_display_name: roleDetails?.display_name || staff.role_display_name || 'Staff',
                  role_color: roleDetails?.color || '#6B7280',
                  is_primary: true
                }];
              }
            });
          }
        } catch (error) {
          console.error('[loadStaffRoles] Exception loading staff roles:', error);
          // Fallback: use primary role from staff table (already set from RPC)
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
      };

      // RPC-only fetch for POS-eligible staff in this branch
      let data: any[] = [];
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
      data = await rpcRes.json();

      console.log('Fetched staff data:', data);


      const staffList: StaffMember[] = (data || []).map((s: any) => ({
        id: s.id,
        name: (s.name || `${s.first_name ?? ''} ${s.last_name ?? ''}` || 'Staff').trim(),
        first_name: s.first_name,
        last_name: s.last_name,
        email: s.email,
        role_id: s.role_id,
        role_name: s.role_name || s.roles?.name || 'staff',
        role_display_name: s.role_display_name || s.roles?.display_name || 'Staff',
        roles: [], // Will be loaded separately
        can_login_pos: (s.can_login_pos ?? true),
        is_active: (s.is_active ?? true),
        hourly_rate: s.hourly_rate
      }));

      // Load all roles for each staff member
      console.log('[loadStaff] About to call loadStaffRoles for', staffList.length, 'staff members');
      await loadStaffRoles(staffList);
      console.log('[loadStaff] After loadStaffRoles, staff roles:', staffList.map(s => ({ name: s.name, rolesCount: s.roles?.length })));

      // Create a new array reference to trigger React re-render
      setAvailableStaff([...staffList]);
      try {
        await loadActiveShiftsForStaff(staffList);
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

  const loadExpenses = async (shiftId?: string) => {
    const sid = shiftId ?? effectiveShift?.id;
    if (!sid) return;
    try {
      const result = await (window as any).electronAPI.getShiftExpenses(sid);
      // Handle various response shapes - ensure we always set an array
      const shiftExpenses = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : [];
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
      const payments = await (window as any).electronAPI.getStaffPayments(sid);
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
      const payments = await (window.electronAPI as any).invoke('shift:get-staff-payments-by-staff', {
        staffId,
        dateFrom: targetDate,
        dateTo: targetDate
      });
      setPaymentHistory(payments || []);

      // Calculate daily total
      const total = await (window.electronAPI as any).invoke('shift:get-staff-payment-total-for-date', staffId, targetDate);
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
      const result = await (window as any).electronAPI.recordStaffPayment({
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

        const summaryResult = await (window as any).electronAPI.getShiftSummary(effectiveShift.id, { skipBackfill: true });
        // IPC handlers wrap response in { success: true, data: ... }
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
      // Resolve terminal/branch from settings or IPC
      let branchId: string | undefined = getSetting?.('terminal', 'branch_id') as string | undefined;
      let terminalId: string | undefined = getSetting?.('terminal', 'terminal_id') as string | undefined;
      if (!branchId || !terminalId) {
        try {
          const local = await (window as any).electronAPI?.invoke?.('get-settings');
          branchId = branchId || (local?.['terminal.branch_id'] ?? local?.terminal?.branch_id);
          terminalId = terminalId || (local?.['terminal.terminal_id'] ?? local?.terminal?.terminal_id);
        } catch { }
      }
      if (!branchId && (window as any).electronAPI?.getTerminalSetting) {
        try {
          const val = await (window as any).electronAPI.getTerminalSetting('terminal', 'branch_id');
          if (val) branchId = val as string;
        } catch { }
      }
      // Extra fallback: dedicated branch id getter
      if (!branchId && (window as any).electronAPI?.getTerminalBranchId) {
        try {
          const bid = await (window as any).electronAPI.getTerminalBranchId();
          if (bid) branchId = bid as string;
        } catch { }
      }
      if (!terminalId && (window as any).electronAPI?.getTerminalSetting) {
        try {
          const val = await (window as any).electronAPI.getTerminalSetting('terminal', 'terminal_id');
          if (val) terminalId = val as string;
        } catch { }
      }

      // Resolve organization_id
      let organizationId: string | undefined = getSetting?.('terminal', 'organization_id') as string | undefined;
      if (!organizationId && (window as any).electronAPI?.getTerminalOrganizationId) {
        try {
          const oid = await (window as any).electronAPI.getTerminalOrganizationId();
          if (oid) organizationId = oid as string;
        } catch { }
      }
      if (!organizationId && (window as any).electronAPI?.getTerminalSetting) {
        try {
          const val = await (window as any).electronAPI.getTerminalSetting('terminal', 'organization_id');
          if (val) organizationId = val as string;
        } catch { }
      }

      // Prefer Electron IPC (main process handles Supabase + session) when available
      const hasElectron = typeof (window as any).electronAPI?.invoke === 'function';
      if (hasElectron) {
        try {
          console.log('[StaffShiftModal] PIN submit - IPC call with', { staffId: selectedStaff?.id, branchId, terminalId });
          const authRes = await (window as any).electronAPI.invoke('staff-auth:authenticate-pin', enteredPin.trim(), selectedStaff?.id, terminalId, branchId);
          if (authRes?.success && authRes.staffId === selectedStaff.id) {
            const staffRole = selectedStaff.role_name as 'cashier' | 'manager' | 'driver' | 'kitchen' | 'server';
            setRoleType(staffRole);
            setCheckInStep('select-role');
            setError('');
            return; // done
          } else {
            console.log('IPC PIN auth failed or mismatched staff (will try direct RPC next):', authRes);
            // Do not return here; fall through to direct RPC
          }
        } catch (e) {
          console.warn('IPC PIN auth error, falling back to direct Supabase RPC:', e);
        }
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
          p_branch_id: branchId ?? null,
          p_organization_id: organizationId ?? null,
          p_terminal_id: terminalId ?? null,
          p_session_hours: 8
        })
      });

      if (!response.ok) {
        throw new Error('PIN verification failed');
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
          const cashier = await (window as any).electronAPI?.getActiveCashierByTerminal?.(branchId, terminalId);
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

    // Check if Electron API is available
    if (!(window as any).electronAPI?.openShift) {
      setError(t('modals.staffShift.electronRequired'));
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
      try { resolvedTerminalId = (await (window as any).electronAPI?.getTerminalId?.()) || resolvedTerminalId; } catch { }
      try { resolvedBranchId = (await (window as any).electronAPI?.getTerminalBranchId?.()) || resolvedBranchId; } catch { }

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
      let usedOpeningCash: number | undefined;
      let usedStartingAmount: number | undefined;

      if (roleType === 'cashier') {
        usedOpeningCash = parseFloat(openingCash) || 0;
      } else if (roleType === 'driver') {
        // Use dedicated startingAmount field for drivers
        usedStartingAmount = parseFloat(driverStartingAmount) || 0;
      }
      // Other roles: both remain undefined

      const result = await (window as any).electronAPI.openShift({
        staffId: selectedStaff.id,
        staffName: selectedStaff.name,
        branchId: resolvedBranchId,
        terminalId: resolvedTerminalId,
        roleType,
        openingCash: usedOpeningCash,
        startingAmount: usedStartingAmount
      });

      if (result.success) {
        setSuccess(t('modals.staffShift.shiftStarted'));
        // Update the global shift context to the checked-in staff so guards lift
        setStaff({
          staffId: selectedStaff.id,
          name: selectedStaff.name,
          role: roleType,
          branchId: resolvedBranchId,
          terminalId: resolvedTerminalId,
        });
        // Optimistically mark shift active immediately with a minimal stub, so UI unlocks at once
        try {
          // opening_cash_amount: for cashiers this is the drawer count, for drivers this is their starting amount
          const effectiveOpeningAmount = roleType === 'driver'
            ? (usedStartingAmount ?? 0)
            : (usedOpeningCash ?? 0);
          setActiveShiftImmediate({
            id: result.shiftId,
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
      const driverPayment = parseFloat(staffPayment || '0');
      console.log('driverPayment:', driverPayment);
      if (isNaN(driverPayment) || driverPayment < 0) {
        console.log('❌ Invalid driver payment amount');
        setError(t('modals.staffShift.invalidStaffPayment'));
        return;
      }

      // For driver checkout, refresh summary WITH backfill to ensure all earnings are recorded
      // This is critical for accurate variance calculation
      let freshSummary = shiftSummary;
      try {
        const summaryResult = await (window as any).electronAPI.getShiftSummary(effectiveShift.id, { skipBackfill: false });
        // IPC handlers wrap response in { success: true, data: ... }
        freshSummary = summaryResult?.data || summaryResult;
        setShiftSummary(freshSummary);
      } catch (e) {
        console.warn('Failed to refresh shift summary with backfill:', e);
        // Continue with existing summary if refresh fails
      }

      // Calculate cash to return using the specified formula:
      // cashToReturn = totalCashCollected - openingCash - totalExpenses - driverPayment
      const openingCash = effectiveShift.opening_cash_amount || 0;
      const totalCashCollected = freshSummary?.driverDeliveries?.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0) || 0;
      const totalExpenses = freshSummary?.totalExpenses || 0;
      closingAmount = totalCashCollected - openingCash - totalExpenses - driverPayment;
      console.log('Driver closingAmount (formula: totalCashCollected - openingCash - totalExpenses - driverPayment):', {
        totalCashCollected,
        openingCash,
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
        const totalCashOrders = shiftSummary?.breakdown?.overall?.cashTotal || 0;
        const cashRefunds = shiftSummary?.cashRefunds || 0;
        const totalExpenses = shiftSummary?.totalExpenses || 0;
        const cashDrops = shiftSummary?.cashDrawer?.cash_drops || 0;
        const totalStaffPayments = shiftSummary?.cashDrawer?.total_staff_payments || 0;
        const driverGiven = shiftSummary?.cashDrawer?.driver_cash_given || 0;
        const driverReturned = shiftSummary?.cashDrawer?.driver_cash_returned || 0;
        // recordedPaymentsToOthers: payments to other staff via "Add Payment" during this session
        const recordedPaymentsToOthers = Array.isArray(staffPaymentsList) ? staffPaymentsList.reduce((sum, p) => sum + (p.amount || 0), 0) : 0;
        // Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned - alreadyRecordedStaffPayments - recordedPaymentsToOthers - payout
        const expectedAmount = openingCash + totalCashOrders - cashRefunds - totalExpenses - cashDrops - driverGiven + driverReturned - totalStaffPayments - recordedPaymentsToOthers - payout;

        // Use manually entered closing cash for actual
        const actualAmount = closingCash === '' ? expectedAmount : parseFloat(closingCash);

        if (isNaN(actualAmount) || actualAmount < 0) {
          setError(t('modals.staffShift.invalidClosingCash'));
          return;
        }

        closingAmount = actualAmount;
        console.log('Cashier Checkout:', { openingCash, totalCashOrders, cashRefunds, totalExpenses, cashDrops, driverGiven, driverReturned, totalStaffPayments, recordedPaymentsToOthers, payout, expected: expectedAmount, actual: closingAmount, variance: closingAmount - expectedAmount });
      } else {
        // Kitchen roles: no cash drawer, just record staff payment and close with 0
        closingAmount = 0;
        console.log('Kitchen closingAmount (no cash drawer):', closingAmount);
      }
    }
    // Comment 1: Waiter Checkout Logic
    else if (effectiveShift?.role_type === 'server') {
      const waiterPayment = parseFloat(staffPayment || '0');
      if (isNaN(waiterPayment) || waiterPayment < 0) {
        setError(t('modals.staffShift.invalidStaffPayment'));
        return;
      }

      // Refresh summary to ensure latest data
      let freshSummary = shiftSummary;
      try {
        const sResult = await (window as any).electronAPI.getShiftSummary(effectiveShift.id, { skipBackfill: true });
        // IPC handlers wrap response in { success: true, data: ... }
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

      // Formula: Cash to Return = Cash Collected - Starting Amount - Expenses - Payments
      closingAmount = cashCollected - openingCash - totalExpenses - waiterPayment;
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

    // Check if Electron API is available
    if (!(window as any).electronAPI?.closeShift) {
      console.log('❌ Electron API not available');
      setError(t('modals.staffShift.electronRequired'));
      return;
    }

    console.log('✅ All checks passed, calling closeShift...');
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
            const cashierShift = await (window as any).electronAPI?.getActiveCashierByTerminal?.(
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
          const paymentResult = await (window as any).electronAPI.recordStaffPayment({
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

      const result = await (window as any).electronAPI.closeShift({
        shiftId: effectiveShift.id,
        closingCash: closingAmount,
        closedBy: staff.staffId,
        paymentAmount: driverPaymentAmount
      });
      console.log('closeShift result:', result);

      if (result.success) {
        const variance = result.variance || 0;
        const varianceText = variance >= 0
          ? `Overage: $${variance.toFixed(2)}`
          : `Shortage: $${Math.abs(variance).toFixed(2)}`;
        // Check for cashier logic to populate items
        const isCashier = effectiveShift.role_type === 'cashier';
        if (isCashier) {
          const opening = effectiveShift.opening_cash_amount || 0;
          const sales = shiftSummary?.breakdown?.overall?.cashTotal || 0;
          const expenses = shiftSummary?.totalExpenses || 0;
          const pmts = (shiftSummary?.cashDrawer?.total_staff_payments || 0) +
            (staffPayment ? parseFloat(staffPayment) : 0);
          const expected = opening + sales - expenses - pmts;
          const actual = closingAmount;
          const calcVariance = actual - expected;

          setLastShiftResult({
            variance: calcVariance,
            breakdown: {
              opening,
              sales,
              expenses,
              payments: pmts,
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
          const terminalName = await (window as any).electronAPI.getTerminalSetting('terminal', 'name');
          await (window as any).electronAPI.printCheckout(
            effectiveShift.id,
            effectiveShift.role_type,
            terminalName || undefined
          );
        } catch (printErr) {
          console.warn('Staff checkout print failed:', printErr);
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
      const result = await (window as any).electronAPI.recordExpense({
        shiftId: effectiveShift.id,
        staffId: staff.staffId,
        branchId: staff.branchId,
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
          const summaryResult = await (window as any).electronAPI.getShiftSummary(effectiveShift.id, { skipBackfill: true });
          // IPC handlers wrap response in { success: true, data: ... }
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

  const getStatusSymbol = (delivery: any): string => {
    const rawStatus = delivery.status || delivery.order_status || '';
    const normalizedStatus = rawStatus.toLowerCase();
    const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled';
    return isCanceled ? '✗' : '✓';
  };

  const getPaymentSymbol = (paymentMethod: string): string => {
    const method = (paymentMethod || '').toLowerCase();
    if (method === 'cash') return '💵';
    if (method === 'card') return '💳';
    if (method === 'mixed') return '💵+💳';
    return '💳'; // fallback
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
        size="lg"
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
          {error && <ErrorAlert title={t('common.status.error')} message={error} onClose={() => setError('')} className="mb-4" />}
          {success && <ErrorAlert title={t('common.status.success')} message={success} severity="success" onClose={() => setSuccess('')} className="mb-4" />}



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
                  <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                    <span className="text-gray-400">{t('modals.staffShift.expensesLabel')}</span>
                    <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.expenses || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 rounded hover:bg-white/5">
                    <span className="text-gray-400">{t('modals.staffShift.staffPaymentsLabel')}</span>
                    <span className="font-medium text-red-300">-{(lastShiftResult.breakdown.payments || 0).toFixed(2)}</span>
                  </div>
                  <div className="h-px bg-white/10 my-1"></div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-medium">
                    <span className="text-gray-300">{t('modals.staffShift.expectedAmountLabel')}</span>
                    <span className="text-blue-300">${(lastShiftResult.breakdown.expected || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-white/5 rounded font-bold">
                    <span className="text-white">{t('modals.staffShift.closingCashLabel')} (Actual)</span>
                    <span className="text-white">${(lastShiftResult.breakdown.actual || 0).toFixed(2)}</span>
                  </div>
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
                <div className="space-y-4">
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
                    <div className="grid gap-3 max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                      {[...availableStaff]
                        .sort((a, b) => {
                          const aActive = staffActiveShifts.has(a.id);
                          const bActive = staffActiveShifts.has(b.id);
                          if (aActive && !bActive) return -1;
                          if (!aActive && bActive) return 1;
                          return a.name.localeCompare(b.name);
                        })
                        .map((staffMember) => {
                          const isActive = staffActiveShifts.has(staffMember.id);
                          return (
                            <button
                              key={staffMember.id}
                              onClick={() => handleStaffSelect(staffMember)}
                              className="bg-white/10 dark:bg-gray-800/20 border liquid-glass-modal-border rounded-xl p-4 hover:bg-white/20 dark:hover:bg-gray-800/30 transition-all duration-300 text-left group shadow-[0_2px_8px_0_rgba(59,130,246,0.2)]"
                            >
                              <div className="flex items-center gap-4">
                                <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${isActive
                                  ? 'bg-green-500/20 shadow-[0_4px_12px_0_rgba(34,197,94,0.4)] group-hover:shadow-[0_6px_16px_0_rgba(34,197,94,0.6)]'
                                  : 'bg-white/10 dark:bg-gray-800/20 shadow-[0_4px_12px_0_rgba(59,130,246,0.3)] group-hover:shadow-[0_6px_16px_0_rgba(59,130,246,0.5)]'
                                  }`}>
                                  <User className={`w-6 h-6 ${isActive ? 'text-green-400' : 'text-blue-400'}`} />
                                </div>
                                <div className="flex-1">
                                  <div className="font-semibold liquid-glass-modal-text flex items-center gap-2 mb-1">
                                    {staffMember.name}
                                    {isActive && (
                                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/50 text-green-300 border border-green-700/50">{t('shift.labels.active')}</span>
                                    )}
                                  </div>
                                  {/* Display all roles as badges */}
                                  <div className="flex flex-wrap gap-1.5">
                                    {staffMember.roles && staffMember.roles.length > 0 ? (
                                      staffMember.roles
                                        .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)) // Primary first
                                        .map((role, idx) => (
                                          <span
                                            key={idx}
                                            className={`text-xs px-2 py-0.5 rounded-full border-2 flex items-center gap-1 font-medium ${role.is_primary
                                              ? 'border-orange-400 text-orange-400 bg-orange-400/10'
                                              : 'border-white/60 text-white/90 bg-white/5'
                                              }`}
                                          >
                                            {role.is_primary && (
                                              <span className="text-orange-400">★</span>
                                            )}
                                            {role.role_display_name}
                                          </span>
                                        ))
                                    ) : (
                                      <span className="liquid-glass-modal-text-muted text-sm">{staffMember.role_display_name}</span>
                                    )}
                                  </div>
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
                <div className="space-y-6">
                  <button
                    onClick={() => setCheckInStep('select-staff')}
                    className="px-4 py-2 bg-white/10 dark:bg-gray-800/20 rounded-lg shadow-[0_2px_8px_0_rgba(59,130,246,0.2)] hover:shadow-[0_4px_12px_0_rgba(59,130,246,0.35)] text-sm flex items-center gap-2 hover:gap-3 transition-all duration-300 liquid-glass-modal-text"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                    {t('common.actions.back')}
                  </button>


                  {/* Staff Info Card */}
                  <div className={liquidGlassModalCard()}>
                    <div className="w-20 h-20 rounded-full bg-white/10 dark:bg-gray-800/20 shadow-[0_8px_20px_0_rgba(59,130,246,0.4)] flex items-center justify-center mx-auto mb-4 ring-4 ring-blue-500/20">
                      <User className="w-10 h-10 text-blue-400" />
                    </div>
                    <h3 className="text-xl font-bold liquid-glass-modal-text">{selectedStaff.name}</h3>
                    <p className="liquid-glass-modal-text-muted text-sm mt-1 mb-6">{selectedStaff.role_display_name}</p>
                  </div>

                  {/* PIN Input */}
                  <div className="space-y-3" onClick={() => pinInputRef.current?.focus()}>
                    <label className="block text-sm font-medium liquid-glass-modal-text text-center">
                      {t('modals.staffShift.enterPIN')}
                    </label>
                    <input
                      ref={pinInputRef}
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={4}
                      value={enteredPin}
                      onChange={(e) => setEnteredPin(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={(e) => e.key === 'Enter' && enteredPin.length === 4 && handlePinSubmit()}
                      placeholder={t('forms.placeholders.pinDots')}
                      className="liquid-glass-modal-input text-center text-3xl tracking-[1em] font-bold cursor-text"
                      autoFocus
                      autoComplete="off"
                    />
                  </div>

                  <button
                    onClick={handlePinSubmit}
                    disabled={enteredPin.length !== 4}
                    className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold shadow-[0_4px_16px_0_rgba(59,130,246,0.5)] hover:shadow-[0_6px_20px_0_rgba(59,130,246,0.6)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all duration-300"
                  >
                    {t('modals.staffShift.continue')}
                  </button>
                </div>
              )}

              {/* Step 3: Select Role */}
              {checkInStep === 'select-role' && selectedStaff && (
                <div className="space-y-6">
                  <button
                    onClick={() => setCheckInStep('enter-pin')}
                    className="px-4 py-2 bg-white/10 dark:bg-gray-800/20 rounded-lg shadow-[0_2px_8px_0_rgba(59,130,246,0.2)] hover:shadow-[0_4px_12px_0_rgba(59,130,246,0.35)] text-sm flex items-center gap-2 hover:gap-3 transition-all duration-300 liquid-glass-modal-text"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                    {t('modals.staffShift.back')}
                  </button>

                  <h3 className="text-xl font-bold liquid-glass-modal-text">{t('modals.staffShift.selectRoleForShift')}</h3>

                  <div className="grid gap-3">
                    {/* Show all staff member's assigned roles */}
                    {selectedStaff.roles && selectedStaff.roles.length > 0 ? (
                      selectedStaff.roles
                        .sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0)) // Primary first
                        .map((role, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleRoleSelect(role.role_name as any)}
                            className={`bg-white/10 dark:bg-gray-800/20 rounded-xl flex items-center justify-between p-5 hover:bg-white/20 dark:hover:bg-gray-800/30 hover:shadow-[0_8px_24px_0_rgba(59,130,246,0.5)] transition-all duration-300 group shadow-[0_4px_16px_0_rgba(59,130,246,0.35)] ${role.is_primary ? 'border-2 border-blue-500' : 'border border-white/10 dark:border-gray-700/50'
                              }`}
                          >
                            <div className="text-left flex items-center gap-4">
                              <div
                                className="w-12 h-12 rounded-xl shadow-[0_4px_12px_0_rgba(59,130,246,0.4)] flex items-center justify-center"
                                style={{
                                  backgroundColor: `${role.role_color}20`,
                                  borderColor: `${role.role_color}40`,
                                  border: `1px solid`
                                }}
                              >
                                <User className="w-6 h-6" style={{ color: role.role_color }} />
                              </div>
                              <div>
                                <div className="font-bold liquid-glass-modal-text capitalize text-lg flex items-center gap-2">
                                  {role.role_display_name}
                                  {role.is_primary && (
                                    <span className="text-yellow-400 text-sm">★</span>
                                  )}
                                </div>
                                <div className="liquid-glass-modal-text-muted text-sm">
                                  {role.is_primary ? t('modals.staffShift.primaryRole') : t('modals.staffShift.secondaryRole')}
                                </div>
                              </div>
                            </div>
                            <ChevronRight className="w-6 h-6 group-hover:translate-x-1 transition-transform duration-300" style={{ color: role.role_color }} />
                          </button>

                        ))
                    ) : (
                      // Fallback to single role if roles array is empty
                      <button
                        onClick={() => handleRoleSelect(selectedStaff.role_name as any)}
                        className="bg-white/10 dark:bg-gray-800/20 border-2 border-blue-500 rounded-xl flex items-center justify-between p-5 hover:bg-white/20 dark:hover:bg-gray-800/30 hover:shadow-[0_8px_24px_0_rgba(59,130,246,0.5)] transition-all duration-300 group shadow-[0_4px_16px_0_rgba(59,130,246,0.35)]"
                      >
                        <div className="text-left flex items-center gap-4">
                          <div className="w-12 h-12 rounded-xl bg-white/10 dark:bg-gray-800/20 shadow-[0_4px_12px_0_rgba(59,130,246,0.4)] flex items-center justify-center">
                            <User className="w-6 h-6 text-blue-400" />
                          </div>
                          <div>
                            <div className="font-bold liquid-glass-modal-text capitalize text-lg">{selectedStaff.role_display_name}</div>
                            <div className="liquid-glass-modal-text-muted text-sm">{t('modals.staffShift.yourAssignedRole')}</div>
                          </div>
                        </div>
                        <ChevronRight className="w-6 h-6 text-blue-400 group-hover:translate-x-1 transition-transform duration-300" />
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
                        <DollarSign className="w-8 h-8 text-green-400" />
                      </div>
                      <input
                        type="number"
                        step="0.01"
                        value={roleType === 'driver'
                          ? (!activeCashierExists ? '0' : driverStartingAmount)
                          : openingCash}
                        onChange={(e) => {
                          if (roleType === 'driver') {
                            setDriverStartingAmount(e.target.value);
                          } else {
                            setOpeningCash(e.target.value);
                          }
                        }}
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
            <div className="space-y-4">
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
                      <h3 className="font-bold liquid-glass-modal-text text-lg capitalize">{effectiveShift.role_type}</h3>
                      <p className="text-xs text-gray-400 mt-1">Total Sales: <span className="text-green-400 font-semibold">${(effectiveShift.total_sales_amount || 0).toFixed(2)}</span></p>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-blue-300">{effectiveShift.total_orders_count || 0}</div>
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

                    {/* Minus Staff Payments */}
                    {shiftSummary.cashDrawer?.total_staff_payments > 0 && (
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.staffPaymentsLabel')}</span>
                        <span className="font-bold text-red-300">${(shiftSummary.cashDrawer?.total_staff_payments || 0).toFixed(2)}</span>
                      </div>
                    )}

                    {/* Expected Amount */}
                    {(() => {
                      const opening = effectiveShift.opening_cash_amount || 0;
                      const cashTotal = shiftSummary.breakdown?.overall?.cashTotal || 0;
                      const cashRefunds = shiftSummary.cashRefunds || 0;
                      const expensesTotal = shiftSummary.totalExpenses || 0;
                      const cashDrops = shiftSummary.cashDrawer?.cash_drops || 0;
                      const staffPayments = shiftSummary.cashDrawer?.total_staff_payments || 0;
                      const driverGiven = shiftSummary.cashDrawer?.driver_cash_given || 0;
                      const driverReturned = shiftSummary.cashDrawer?.driver_cash_returned || 0;
                      // Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned - staffPayments
                      const expected = opening + cashTotal - cashRefunds - expensesTotal - cashDrops - driverGiven + driverReturned - staffPayments;
                      return (
                        <div className="flex justify-between items-center p-3 bg-cyan-900/30 rounded-lg border-2 border-cyan-500/50 font-semibold">
                          <span className="text-sm text-cyan-200">{t('modals.staffShift.expectedAmountLabel')}</span>
                          <span className="text-lg text-cyan-300">${expected.toFixed(2)}</span>
                        </div>
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
                        type="number"
                        step="0.01"
                        value={expenseAmount}
                        onChange={(e) => setExpenseAmount(e.target.value)}
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
                  return s === 'cancelled' || s === 'canceled';
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
                            <POSGlassBadge variant="error">✗ {canceledCount} {t('modals.staffShift.canceledOrders', 'Canceled')}</POSGlassBadge>
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
                            <span className="text-xl">💵</span>
                            <div className="font-bold text-green-300">${cashTotal.toFixed(2)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xl">💳</span>
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
                        <div className="space-y-3 max-h-96 overflow-y-auto animate-in fade-in slide-in-from-top-4 duration-300">
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
                            <span className="text-xl">💵</span>
                            <div className="font-bold text-green-300">${cashTotal.toFixed(2)}</div>
                          </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-600/30 rounded-xl p-3 flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-blue-200">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold text-blue-400 text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xl">💳</span>
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
                                        <span>{hasActive ? '✓' : '✗'}</span>
                                        <span>{getPaymentSymbol(table.payment_method)}</span>
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
                        <div className="space-y-3 max-h-96 overflow-y-auto animate-in fade-in slide-in-from-top-4 duration-300">
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
                        const paymentAmount = 0; // Payment is not accessible in this scope easily, defaulting to 0 for display or needs to be passed down. 
                        // Actually, 'payment' state variable exists in this component?
                        // Let's check if 'payment' is defined in the component scope.
                        // Looking at line 2300+, there are payment related states.
                        // But 'payment' object might not exist. 
                        // There is 'paymentAmount' state (string) and 'paymentType' state.
                        // But wait, in the previous code I used 'payment.amount'. 'payment' variable seems to be missing.
                        // Checking previous context, maybe I assumed 'payment' was available.
                        // In the render function, there is no 'payment' variable in scope shown in snippets.
                        // I should use 0 or fetch it if possible. 
                        // But for now, to fix the build, I will use 0.
                        const waiterPayment = parseFloat(staffPayment || '0');
                        // Calculate totals from waiterTables array
                        const cashFromTables = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);

                        // Formula: Closing Amount = Cash Collected - Opening - Expenses - Payment
                        const cashToReturn = cashFromTables - opening - expensesTotal - waiterPayment;
                        const label = cashToReturn >= 0 ? t('modals.staffShift.amountToReturn', 'Cash to Return') : t('modals.staffShift.shortage', 'Shortage');
                        const colorClass = cashToReturn >= 0 ? 'text-cyan-300' : 'text-red-400';

                        return (
                          <div className={liquidGlassModalCard() + " p-4 mt-2"}>
                            <h3 className="text-md font-bold liquid-glass-modal-text mb-3">{t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}</h3>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.startingAmount', 'Starting Amount')}</span>
                                <span>-${opening.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.cashCollected', 'Cash Collected')}</span>
                                <span className="text-green-400">+${cashFromTables.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-gray-400">{t('modals.staffShift.expenses', 'Expenses')}</span>
                                <span className="text-red-400">-${expensesTotal.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between border-b liquid-glass-modal-border pb-2">
                                <span className="text-gray-400">{t('modals.staffShift.payment', 'Payment')}</span>
                                <span className="text-red-400">-${waiterPayment.toFixed(2)}</span>
                              </div>
                              <div className="flex justify-between pt-1 font-bold text-lg">
                                <span className="text-gray-200">{label}</span>
                                <span className={colorClass}>${Math.abs(cashToReturn).toFixed(2)}</span>
                              </div>
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
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.shiftBreakdown')}</h3>

                    {/* Totals */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="text-lg font-bold liquid-glass-modal-text">{overall.totalCount}</div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalSales')}</div>
                        <div className="text-xl font-bold text-green-400">${overall.totalAmount.toFixed(2)}</div>
                      </div>
                    </div>

                    {/* Pickup / Delivery by method */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.pickupCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{instore.cashCount} orders</span>
                          <span className="font-bold text-green-400">${instore.cashTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.pickupCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{instore.cardCount} orders</span>
                          <span className="font-bold liquid-glass-modal-text">${instore.cardTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.deliveryCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{delivery.cashCount} orders</span>
                          <span className="font-bold text-green-400">${delivery.cashTotal.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.deliveryCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{delivery.cardCount} orders</span>
                          <span className="font-bold liquid-glass-modal-text">${delivery.cardTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Totals by channel with cash amount */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalPickupOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{totalPickupOrders} orders</span>
                          <span className="font-bold text-green-400">${(instore.cashTotal + instore.cardTotal).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalDeliveryOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{totalDeliveryOrders} orders</span>
                          <span className="font-bold text-green-400">${(delivery.cashTotal + delivery.cardTotal).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{overall.totalCount} orders</span>
                          <span className="font-bold text-green-400">${overall.totalAmount.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="bg-white/10 dark:bg-gray-800/20 rounded-xl p-3 border liquid-glass-modal-border">
                        <div className="liquid-glass-modal-text-muted text-xs mb-1">{t('modals.staffShift.totalCashOrders')}</div>


                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{totalCashOrdersCount} orders</span>
                          <span className="font-bold text-green-400">${overall.cashTotal.toFixed(2)}</span>
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
                        const payment = driver.driver_payment || 0;
                        const expenses = driver.expenses || 0;
                        // Drawer relation: starting_amount - payment - expenses
                        // Positive = driver returns money to drawer
                        // Negative = driver takes money from drawer
                        const drawerRelation = startingAmount - payment - expenses;
                        const isPositive = drawerRelation >= 0;

                        return (
                          <div key={driver.driver_id} className={`flex items-center justify-between p-3 rounded-xl border ${isPositive
                            ? 'bg-green-900/20 border-green-600/40'
                            : 'bg-red-900/20 border-red-600/40'
                            }`}>
                            <div className="flex-1">
                              <div className="font-semibold liquid-glass-modal-text">{driver.driver_name}</div>
                              <div className="liquid-glass-modal-text-muted text-xs space-y-1">
                                <div>Starting: ${startingAmount.toFixed(2)} | Payment: ${payment.toFixed(2)} | Expenses: ${expenses.toFixed(2)}</div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className={`font-bold text-lg ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                                {isPositive ? '+' : '-'} ${Math.abs(drawerRelation).toFixed(2)}
                              </div>
                              <div className="liquid-glass-modal-text-muted text-xs">
                                {isPositive ? 'Returns' : 'Takes'}
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
                    <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}</h3>
                    <button
                      onClick={() => setShowStaffPaymentForm(!showStaffPaymentForm)}
                      className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1"
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
                                      time: new Date(payment.created_at).toLocaleTimeString()
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
                          <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={paymentAmount}
                            onChange={(e) => setPaymentAmount(e.target.value)}
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
                    <div className="space-y-2 max-h-48 overflow-auto pr-1">
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
                  <h3 className="text-xl font-bold liquid-glass-modal-text mb-2">Staff Payments</h3>
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
                    <span className="font-semibold liquid-glass-modal-text">Total Staff Payments</span>
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
                    <label className="block text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wide">
                      {t('modals.staffShift.cashierPaymentLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={staffPayment}
                        onChange={(e) => setStaffPayment(e.target.value)}
                        placeholder={t('forms.placeholders.amount')}
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-2">Amount you're taking from the drawer</p>
                  </div>

                  {/* Closing Cash */}
                  <div className="bg-white/5 rounded-lg p-4 border border-white/10">
                    <label className="block text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wide">
                      {t('modals.staffShift.closingCashLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={closingCash}
                        onChange={(e) => setClosingCash(e.target.value)}
                        placeholder={t('forms.placeholders.amount')}
                        className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                        autoFocus
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-2">Physical cash count in the drawer</p>
                  </div>

                  {/* Live Variance Calculation */}
                  {(() => {
                    const opening = effectiveShift.opening_cash_amount || 0;
                    const totalCashOrders = shiftSummary?.breakdown?.overall?.cashTotal || 0;
                    const cashRefunds = shiftSummary?.cashRefunds || 0;
                    // Use local expenses state (which shows in UI) instead of shiftSummary.totalExpenses
                    const expensesTotal = expenses.reduce((sum, exp) => sum + exp.amount, 0);
                    const cashDrops = shiftSummary?.cashDrawer?.cash_drops || 0;
                    const totalStaffPayments = shiftSummary?.cashDrawer?.total_staff_payments || 0;
                    const driverGiven = shiftSummary?.cashDrawer?.driver_cash_given || 0;
                    const driverReturned = shiftSummary?.cashDrawer?.driver_cash_returned || 0;
                    // staffPaymentsList contains payments recorded TO OTHER STAFF during this session
                    const recordedPaymentsToOthers = Array.isArray(staffPaymentsList) ? staffPaymentsList.reduce((sum, p) => sum + (p.amount || 0), 0) : 0;
                    const currentPayout = parseFloat(staffPayment || '0') || 0;
                    // Formula: opening + cashSales - cashRefunds - expenses - cashDrops - driverGiven + driverReturned - alreadyRecordedStaffPayments - recordedPaymentsToOthers - currentPayout
                    const expected = opening + totalCashOrders - cashRefunds - expensesTotal - cashDrops - driverGiven + driverReturned - totalStaffPayments - recordedPaymentsToOthers - currentPayout;

                    // Debug logging - check shift ID and all values
                    console.log('[LiveVariance] staffPayment state:', staffPayment);
                    console.log('[LiveVariance] staffPaymentsList:', staffPaymentsList);
                    console.log('[LiveVariance] Values:', {
                      opening, totalCashOrders, cashRefunds, totalExpenses, cashDrops,
                      totalStaffPayments, recordedPaymentsToOthers, driverGiven, driverReturned, currentPayout, expected
                    });

                    const actual = parseFloat(closingCash || '0') || 0;
                    const variance = actual - expected;

                    // Only show if user has started typing actual cash (optional, but good UX)
                    if (!closingCash) return null;

                    return (
                      <div className="flex flex-col items-center gap-2 mt-4 animate-in fade-in slide-in-from-top-2">
                        {/* Debug: show calculation breakdown */}
                        <div className="text-xs text-gray-400">
                          Expected: {opening} - {expensesTotal} - {currentPayout} = {expected} | Actual: {actual}
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
                      <DollarSign className="w-8 h-8 text-green-400" />
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={staffPayment}
                      onChange={(e) => setStaffPayment(e.target.value)}
                      placeholder={t('forms.placeholders.amount')}
                      className="liquid-glass-modal-input flex-1 text-3xl font-bold text-center"
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* DRIVER CHECKOUT - Earnings Calculation */}
              {effectiveShift?.role_type === 'driver' && shiftSummary && (() => {
                const startingAmount = effectiveShift.opening_cash_amount || 0;
                const cashEarned = shiftSummary.breakdown?.overall?.cashTotal || 0;
                const driverPaymentOwed = parseFloat(staffPayment || '0');
                const amountToTake = cashEarned - driverPaymentOwed;

                return (
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="bg-gradient-to-r from-indigo-500/20 to-purple-500/20 rounded-xl p-4 border border-indigo-500/30">
                      <h3 className="text-lg font-bold text-indigo-300 mb-1">{t('modals.staffShift.driverCheckout')}</h3>
                      <p className="text-xs text-indigo-200/70">{t('modals.staffShift.driverEarnings')}</p>
                    </div>

                    {/* Earnings Summary */}
                    <div className="space-y-2">
                      {/* Starting Amount */}
                      <div className="flex justify-between items-center p-3 bg-blue-900/30 rounded-lg border border-blue-600/40">
                        <span className="text-sm text-blue-200">{t('modals.staffShift.startingAmount')}</span>
                        <span className="font-bold text-blue-300">${startingAmount.toFixed(2)}</span>
                      </div>

                      {/* Cash Earned */}
                      <div className="flex justify-between items-center p-3 bg-green-900/30 rounded-lg border border-green-600/40">
                        <span className="text-sm text-green-200">{t('modals.staffShift.cashEarned')}</span>
                        <span className="font-bold text-green-300">${cashEarned.toFixed(2)}</span>
                      </div>

                      {/* Driver Payment Owed */}
                      <div className="flex justify-between items-center p-3 bg-red-900/30 rounded-lg border border-red-600/40">
                        <span className="text-sm text-red-200">{t('modals.staffShift.driverPaymentOwed')}</span>
                        <span className="font-bold text-red-300">-${driverPaymentOwed.toFixed(2)}</span>
                      </div>

                      {/* Amount to Take from Drawer */}
                      <div className={`flex justify-between items-center p-3 rounded-lg border-2 font-semibold ${amountToTake >= 0
                        ? 'bg-yellow-900/30 border-yellow-500/50'
                        : 'bg-red-900/30 border-red-500/50'
                        }`}>
                        <span className={`text-sm ${amountToTake >= 0 ? 'text-yellow-200' : 'text-red-200'}`}>
                          {t('modals.staffShift.amountToTakeFromDrawer')}
                        </span>
                        <span className={amountToTake >= 0 ? 'text-lg text-yellow-300' : 'text-lg text-red-300'}>
                          ${Math.abs(amountToTake).toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* Driver Payment Input */}
                    <div className="bg-white/5 rounded-lg p-4 border border-white/10">
                      <label className="block text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wide">
                        {t('modals.staffShift.driverPayment')}
                      </label>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={staffPayment}
                          onChange={(e) => setStaffPayment(e.target.value)}
                          placeholder={t('forms.placeholders.amount')}
                          className="liquid-glass-modal-input flex-1 text-2xl font-bold text-center"
                          autoFocus
                        />
                      </div>
                      <p className="text-xs text-gray-400 mt-2">Enter your payment amount</p>
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
                    ✓ {t('modals.staffShift.checkOut')}
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