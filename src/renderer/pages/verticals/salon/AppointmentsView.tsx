import OrderFlow from '../../../components/OrderFlow';
import { servicesService } from '../../../services/ServicesService';
import { appointmentSale, appointmentWallTimes, branchWallClock, appointmentCanCheckIn, hasAppointmentTicket, serviceVatDefaults, type SalonSale } from './salon-sale';
import { useTerminalSettings } from '../../../hooks/useTerminalSettings';
/**
 * AppointmentsView - POS Today's Appointments
 * 
 * Real-time appointment management for salon POS.
 * Supports check-in functionality and quick status updates.
 * 
 * Task 17.2: Create POS appointments interface
 */

import React, { memo, useState, useMemo, useEffect, useLayoutEffect, useCallback, useId, useRef } from 'react';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useAppointments } from '../../../hooks/useAppointments';
import { formatDate } from '../../../utils/format';
import { parseLocalDateString } from '../../../utils/date';
import { Calendar, Clock, User, Scissors, Search, ChevronLeft, ChevronRight, ChevronDown, RefreshCw, CheckCircle, Check, Play, XCircle, X, Plus, Ban } from 'lucide-react';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
import { CustomerSearchModal } from '../../../components/modals/CustomerSearchModal';
import { getBridge, isBrowser, offEvent, onEvent } from '../../../../lib';
import type { Appointment, AppointmentStatus, AppointmentFilters } from '../../../services/AppointmentsService';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { posApiGet } from '../../../utils/api-helpers';
import { appointmentClaimRefusalMessage } from './appointment-claim-message';
import {
  APPOINTMENT_CLAIM_RENEW_MS,
  claimAllowsCheckout,
  claimAppointmentCheckout,
  forgetClaim,
  releaseAppointmentCheckout,
  type AppointmentClaimOutcome,
} from '../../../services/appointment-checkout-claims';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';
import { applyModalOrigin } from '../../../components/ui/modal-origin';
import { WorkspaceChips, WorkspaceHeader, WorkspaceIconButton, WorkspaceSearch, WorkspaceSelect } from '../../../components/tables/TableWorkspace';
import { KitDateField } from '../../../components/ui/KitDateField';

type ViewMode = 'timeline' | 'list';
type QuickFilter = 'today' | 'tomorrow' | 'week';

const statusConfig: Record<AppointmentStatus, { label: string; border: string; chip: string }> = {
  scheduled: {
    label: 'Scheduled',
    border: 'border-l-amber-400',
    chip: 'border border-(--pos-s-border) bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-300',
  },
  confirmed: {
    label: 'Confirmed',
    border: 'border-l-emerald-500',
    chip: 'border border-(--pos-s-border) bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-300',
  },
  in_progress: {
    label: 'In Progress',
    border: 'border-l-yellow-400',
    chip: 'border border-(--pos-s-border) bg-(--pos-s-surface-2) text-yellow-800 dark:text-yellow-300',
  },
  completed: {
    label: 'Completed',
    border: 'border-l-zinc-400',
    chip: 'border border-zinc-500/30 bg-zinc-500/10 text-zinc-500',
  },
  cancelled: {
    label: 'Cancelled',
    border: 'border-l-red-500',
    chip: 'border border-(--pos-s-border) bg-(--pos-s-surface-2) text-red-800 dark:text-red-300',
  },
  no_show: {
    label: 'No Show',
    border: 'border-l-red-500',
    chip: 'border border-(--pos-s-border) bg-(--pos-s-surface-2) text-red-800 dark:text-red-300',
  },
};

interface AppointmentsViewProps {
  /** Rendered inside the Orders hub: hides the internal FAB (the hub owns New Order). */
  embedded?: boolean;
  /** Bump to open the Create Appointment modal from the hub New Order -> Services flow. */
  openCreateSignal?: number;
  /**
   * The Create Appointment window asked for through `openCreateSignal` is on screen, or this
   * screen cannot show it (no time zone): the hub stops holding its backdrop.
   */
  onCreateRequestSettled?: () => void;
}

export const AppointmentsView: React.FC<AppointmentsViewProps> = memo(({
  embedded = false,
  openCreateSignal = 0,
  onCreateRequestSettled,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  const { getSetting } = useTerminalSettings();
  
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  useEffect(() => {
    let disposed = false;

    const hydrateTerminalIdentity = async () => {
      const cached = getCachedTerminalCredentials();
      if (!disposed) {
        setBranchId(cached.branchId || null);
        setLocalOrgId(cached.organizationId || null);
      }

      const refreshed = await refreshTerminalCredentialCache();
      if (!disposed) {
        setBranchId(refreshed.branchId || null);
        setLocalOrgId(refreshed.organizationId || null);
      }
    };

    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      if (disposed) return;
      if (typeof data?.branch_id === 'string' && data.branch_id.trim()) {
        setBranchId(data.branch_id.trim());
      }
      if (typeof data?.organization_id === 'string' && data.organization_id.trim()) {
        setLocalOrgId(data.organization_id.trim());
      }
    };

    hydrateTerminalIdentity();
    onEvent('terminal-config-updated', handleConfigUpdate);

    return () => {
      disposed = true;
      offEvent('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  const [zoneRefresh, setZoneRefresh] = useState(0);
  const [zoneError, setZoneError] = useState(false);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [sale, setSale] = useState<SalonSale | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('today');
  const [staffFilter, setStaffFilter] = useState<string>('all');
  
  // Create appointment modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Round 236: the Orders hub opens Create Appointment by bumping openCreateSignal. The
  // existing staff/service/day/time availability check inside handleCreateAppointment is
  // unchanged — this only opens the same modal.
  useEffect(() => {
    if (openCreateSignal && openCreateSignal > 0) {
      setShowCreateModal(true);
    }
  }, [openCreateSignal]);
  // The window itself reports when it is in the page (this screen first waits for the branch
  // time zone, so `showCreateModal` alone is too early). The hub drops the backdrop it held since
  // the press in that same frame, so the dim never doubles and the page never shows sharp.
  const onCreateRequestSettledRef = useRef(onCreateRequestSettled);
  onCreateRequestSettledRef.current = onCreateRequestSettled;
  const handleCreateModalShown = useCallback(() => {
    onCreateRequestSettledRef.current?.();
  }, []);
  // The time zone could not be read: this screen shows its own message and retry instead of the
  // window, so the hub must let the page go rather than hold a blurred backdrop over it.
  useEffect(() => {
    if (zoneError && showCreateModal) onCreateRequestSettledRef.current?.();
  }, [zoneError, showCreateModal]);
  const [staffList, setStaffList] = useState<{ id: string; name: string }[]>([]);
  const [servicesList, setServicesList] = useState<{ id: string; name: string; duration: number }[]>([]);
  const createRequestId = useRef<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; name: string; phone: string; email?: string; is_banned?: boolean; ban_reason?: string } | null>(null);
  const [formData, setFormData] = useState({
    customerId: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    staffId: '',
    serviceId: '',
    date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
    startTime: '',
    notes: '',
  });

  const isDark = resolvedTheme === 'dark';
  const effectiveOrgId = organizationId || localOrgId || '';

  useEffect(() => {
    if (!branchId || !effectiveOrgId) return;
    let disposed = false;
    setTimeZone(null);
    setZoneError(false);
    const date = new Date().toISOString().slice(0, 10);
    const { start, end } = appointmentWallTimes(date, '00:00', 1440);
    void posApiGet<{ timeZone?: string }>(`/api/pos/staff-schedule/check?${new URLSearchParams({ start_time: start, end_time: end })}`)
      .then(result => {
        const zone = result.success && result.data?.timeZone;
        if (disposed) return;
        if (!zone) { setZoneError(true); return; }
        const today = branchWallClock(new Date(), zone).slice(0, 10);
        setTimeZone(zone);
        setSelectedDate(parseLocalDateString(today));
        setFormData(previous => ({ ...previous, date: today }));
      }).catch(() => { if (!disposed) setZoneError(true); });
    return () => { disposed = true; };
  }, [branchId, effectiveOrgId, zoneRefresh]);

  // Handle customer selected from CustomerSearchModal
  const handleCustomerSelected = useCallback((customer: any) => {
    setSelectedCustomer({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      is_banned: customer.is_banned,
      ban_reason: customer.ban_reason,
    });
    setFormData(prev => ({
      ...prev,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone || '',
      customerEmail: customer.email || '',
    }));
    setShowCustomerSearch(false);
  }, []);

  // Load staff and services for the create modal
  useEffect(() => {
    const loadDropdownData = async () => {
      if (!timeZone) return;
      console.log('[AppointmentsView] Loading staff and services for branch:', branchId, 'org:', effectiveOrgId);

      try {
        const scheduleParams = {
          start_date: formData.date,
          end_date: formData.date,
        };

        const staffResult = isBrowser()
          ? await posApiGet<{ success?: boolean; staff?: any[]; error?: string }>(
              `/api/pos/staff-schedule?start_date=${encodeURIComponent(scheduleParams.start_date)}&end_date=${encodeURIComponent(scheduleParams.end_date)}`,
            )
          : await bridge.staffSchedule.list(scheduleParams);

        const staffPayload = (staffResult.data ?? {}) as {
          success?: boolean;
          staff?: any[];
          error?: string;
        };

        let resolvedStaff = Array.isArray(staffPayload.staff)
          ? staffPayload.staff
              .map((member: any) => ({
                id: String(member?.id ?? ''),
                name:
                  String(member?.name ?? '').trim() ||
                  `${member?.firstName ?? member?.first_name ?? ''} ${member?.lastName ?? member?.last_name ?? ''}`.trim() ||
                  t('appointments.staff', { defaultValue: 'Staff' }),
              }))
              .filter((member: { id: string; name: string }) => !!member.id)
          : [];

        if (resolvedStaff.length === 0 && staff.length > 0) {
          resolvedStaff = staff;
        }

        setStaffList(resolvedStaff);

        const servicesResult = isBrowser()
          ? await posApiGet<{ success?: boolean; services?: any[]; error?: string }>(
              '/api/pos/services?is_active=true',
            )
          : await bridge.services.list({ is_active: true });

        const servicesPayload = (servicesResult.data ?? {}) as {
          success?: boolean;
          services?: any[];
          error?: string;
        };

        const resolvedServices = Array.isArray(servicesPayload.services)
          ? servicesPayload.services
              .filter((service: any) => {
                const active = service?.is_active ?? service?.isActive ?? true;
                const status = service?.status;
                const rowBranch = service?.branch_id ?? service?.branchId ?? null;
                return (
                  active !== false &&
                  status !== 'inactive' &&
                  (!rowBranch || !branchId || rowBranch === branchId)
                );
              })
              .map((service: any) => ({
                id: String(service?.id ?? ''),
                name: service?.name || service?.title || t('appointments.service', { defaultValue: 'Service' }),
                duration:
                  Number(
                    service?.duration_minutes ??
                      service?.duration ??
                      service?.durationMinutes ??
                      30,
                  ) || 30,
              }))
              .filter((service: { id: string; name: string; duration: number }) => !!service.id)
          : [];

        setServicesList(resolvedServices);
      } catch (err) {
        console.error('[AppointmentsView] Failed to load dropdown data:', err);
      }
    };
    
    // Load branch staff (and services) for the whole page, not only when the create
    // modal is open, so the page-level staff filter has branch staff to choose from
    // even on days with no appointments.
    loadDropdownData();
  }, [bridge, branchId, effectiveOrgId, formData.date, t, timeZone]);

  // Helper: format a Date as YYYY-MM-DD using local timezone
  const toLocalDateStr = (d: Date): string => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  // Build filters based on selected date
  // IMPORTANT: Use local date strings (YYYY-MM-DD) to avoid timezone bugs
  // where .toISOString() shifts the date by UTC offset
  const filters: AppointmentFilters = useMemo(() => {
    const baseFilters: AppointmentFilters = { includeServices: true };

    if (quickFilter === 'week') {
      const weekStart = new Date(selectedDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      baseFilters.dateFrom = toLocalDateStr(weekStart);
      baseFilters.dateTo = toLocalDateStr(weekEnd);
    } else {
      baseFilters.dateFrom = toLocalDateStr(selectedDate);
      baseFilters.dateTo = toLocalDateStr(selectedDate);
    }

    if (staffFilter !== 'all') {
      baseFilters.staffFilter = staffFilter;
    }

    if (searchTerm) {
      baseFilters.searchTerm = searchTerm;
    }

    console.log('[AppointmentsView] Built filters:', baseFilters, 'selectedDate:', selectedDate);
    return baseFilters;
  }, [selectedDate, quickFilter, staffFilter, searchTerm]);

  const {
    appointments,
    stats,
    staff,
    isLoading,
    refetch,
    createAppointment,
    updateStatus,
    checkIn,
  } = useAppointments({
    branchId: timeZone ? branchId || '' : '',
    organizationId: effectiveOrgId,
    filters,
    enableRealtime: true,
  });

  // Page-level staff filter options: prefer the branch staff the create modal loads
  // (so staff are selectable even before any appointments exist), and fall back to the
  // appointment-derived staff only when the branch-staff source is unavailable.
  const filterStaffOptions = useMemo(
    () => (staffList.length > 0 ? staffList : staff),
    [staffList, staff],
  );

  // If the active staff filter is no longer among the loaded options, reset to "all"
  // so the filter can't get stuck on an invisible selection.
  useEffect(() => {
    if (
      staffFilter !== 'all' &&
      filterStaffOptions.length > 0 &&
      !filterStaffOptions.some((member) => member.id === staffFilter)
    ) {
      setStaffFilter('all');
    }
  }, [staffFilter, filterStaffOptions]);


  const handleQuickFilter = (filter: QuickFilter) => {
    setQuickFilter(filter);
    if (!timeZone) return;
    const today = parseLocalDateString(branchWallClock(new Date(), timeZone).slice(0, 10));
    
    if (filter === 'today') {
      setSelectedDate(today);
    } else if (filter === 'tomorrow') {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      setSelectedDate(tomorrow);
    }
  };

  // Handle create appointment
  const handleCreateAppointment = async () => {
    if (!formData.staffId || !formData.serviceId) {
      toast.error(t('appointments.selectStaffService', { defaultValue: 'Please select staff and service' }));
      return;
    }

    setIsSubmitting(true);
    try {
      const service = servicesList.find(s => s.id === formData.serviceId);
      const duration = service?.duration || 30;

      const { start: startTime, end: endTime } = appointmentWallTimes(formData.date, formData.startTime, duration);

      const availabilityResult = isBrowser()
        ? await posApiGet<{
            success?: boolean;
            available?: Array<{ staffId?: string; isAvailable?: boolean }>;
            unavailable?: Array<{ staffId?: string; reason?: string }>;
            error?: string;
          }>(
            `/api/pos/staff-schedule/check?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}&staff_id=${encodeURIComponent(formData.staffId)}&service_id=${encodeURIComponent(formData.serviceId)}`,
          )
        : await bridge.staffSchedule.checkAvailability({
            start_time: startTime,
            end_time: endTime,
            staff_id: formData.staffId,
            service_id: formData.serviceId,
          });

      if (!availabilityResult.success) {
        toast.error(availabilityResult.error || t('appointments.validation.availabilityFailed', { defaultValue: 'Failed to validate staff availability' }));
        return;
      }

      const availabilityPayload = (availabilityResult.data ?? {}) as {
        success?: boolean;
        available?: Array<{ staffId?: string; isAvailable?: boolean }>;
        unavailable?: Array<{ staffId?: string; reason?: string }>;
        error?: string;
      };

      if (availabilityPayload.success === false) {
        toast.error(availabilityPayload.error || t('appointments.validation.availabilityFailed', { defaultValue: 'Failed to validate staff availability' }));
        return;
      }

      const matchedAvailable = (availabilityPayload.available || []).find(
        (entry) => entry?.staffId === formData.staffId && entry?.isAvailable !== false,
      );
      if (!matchedAvailable) {
        const unavailableReason =
          (availabilityPayload.unavailable || []).find(
            (entry) => entry?.staffId === formData.staffId,
          )?.reason || 'Staff is not available for the selected slot';
        toast.error(unavailableReason === 'Not scheduled to work'
          ? t('appointments.workflow.notScheduled', 'No synced work shift covers this time. Add or adjust the staff schedule and wait for it to sync.')
          : unavailableReason === 'Time slot is in the past'
            ? t('appointments.workflow.pastSlot', 'Choose a future time.')
            : t('appointments.workflow.unavailable', 'Unavailable'));
        return;
      }

      createRequestId.current ??= `local-appointment-${crypto.randomUUID()}`;
      const created = await createAppointment({
        clientRequestId: createRequestId.current,
        customerId: formData.customerId || undefined,
        customerName: formData.customerName || undefined,
        customerPhone: formData.customerPhone || undefined,
        staffId: formData.staffId,
        serviceId: formData.serviceId,
        startTime: startTime,
        endTime: endTime,
        notes: formData.notes || undefined,
      });

      if (!created) return;

      // Reset form and close modal
      setFormData({
        customerId: '',
        customerName: '',
        customerPhone: '',
        customerEmail: '',
        staffId: '',
        serviceId: '',
        date: timeZone ? branchWallClock(new Date(), timeZone).slice(0, 10) : '',
        startTime: '',
        notes: '',
      });
      setSelectedCustomer(null);
      createRequestId.current = null;
      setShowCreateModal(false);

      // Refresh to show new appointment
      refetch();
    } catch (err) {
      console.error('[AppointmentsView] Failed to create appointment:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Claim before money (contract §1): an appointment's cart opens only while
  // this till holds the office's checkout claim, renewed every 5 minutes.
  const claimedCheckout = useRef<{ appointment: Appointment; timer: ReturnType<typeof setInterval> } | null>(null);
  const claimRefusal = (outcome: AppointmentClaimOutcome): string => appointmentClaimRefusalMessage(outcome, t, timeZone);
  const claimRefusalRef = useRef(claimRefusal);
  claimRefusalRef.current = claimRefusal;

  // The renewal only warns early: the cart's payment renews the claim again
  // right before money moves and refuses there (MenuModal, as on Android).
  const holdClaim = (appointment: Appointment) => {
    if (claimedCheckout.current) clearInterval(claimedCheckout.current.timer);
    const timer = setInterval(() => {
      void claimAppointmentCheckout(appointment.id, { renew: true }).then(outcome => {
        if (claimedCheckout.current?.appointment.id !== appointment.id) return;
        if (!claimAllowsCheckout(outcome)) toast.error(claimRefusalRef.current(outcome));
      });
    }, APPOINTMENT_CLAIM_RENEW_MS);
    claimedCheckout.current = { appointment, timer };
  };

  // The cart closed: an order for the appointment means the office consumes
  // the claim, so it is only forgotten here; no order releases it. When the
  // local orders cannot be read the claim is kept and its lease runs out.
  const finishClaimedCheckout = useCallback(async () => {
    const held = claimedCheckout.current;
    claimedCheckout.current = null;
    if (!held) return;
    clearInterval(held.timer);
    let ordered: boolean;
    try {
      ordered = hasAppointmentTicket(await bridge.orders.getAll(), held.appointment);
    } catch {
      return;
    }
    if (ordered) await forgetClaim(held.appointment.id);
    else await releaseAppointmentCheckout(held.appointment.id);
  }, [bridge]);
  const finishClaimedCheckoutRef = useRef(finishClaimedCheckout);
  finishClaimedCheckoutRef.current = finishClaimedCheckout;
  // Leaving the page mid-checkout closes the cart too.
  useEffect(() => () => { void finishClaimedCheckoutRef.current(); }, []);

  const startAppointmentCheckout = async (appointment: Appointment) => {
    try {
      if (hasAppointmentTicket(await bridge.orders.getAll(), appointment)) { toast.error(t('salonSale.existingTicket')); return; }
      servicesService.setContext(branchId || '', effectiveOrgId);
      const nextSale = appointmentSale(appointment, await servicesService.fetchServices(), serviceVatDefaults(getSetting));
      const outcome = await claimAppointmentCheckout(appointment.id);
      if (!claimAllowsCheckout(outcome)) { toast.error(claimRefusal(outcome)); return; }
      if (outcome.kind !== 'legacy') holdClaim(appointment);
      setSale(nextSale);
    } catch (error) {
      toast.error(t(error instanceof Error && error.message === 'SALON_APPOINTMENT_PENDING' ? 'salonSale.pendingSync' : 'salonSale.unavailable'));
    }
  };

  const navigateDate = (direction: 'prev' | 'next') => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + (direction === 'next' ? 1 : -1));
    setSelectedDate(newDate);
    setQuickFilter('today');
  };

  const getQuickActions = (appointment: Appointment) => {
    const actions: { label: string; action: () => void; variant: string; icon: typeof CheckCircle }[] = [];

    if (appointmentCanCheckIn(appointment.status)) {
      actions.push({
        label: t('appointments.actions.checkIn', 'Check In'),
        action: () => checkIn(appointment.id),
        variant: 'primary',
        icon: Play,
      });
    }
    if (['scheduled', 'confirmed', 'in_progress'].includes(appointment.status)) {
      actions.push({
        label: t('salonSale.checkout'),
        action: () => { void startAppointmentCheckout(appointment); },
        variant: 'success',
        icon: CheckCircle,
      });
    }
    if (['scheduled', 'confirmed'].includes(appointment.status)) {
      actions.push({
        label: t('appointments.actions.noShow', 'No Show'),
        action: () => updateStatus(appointment.id, 'no_show'),
        variant: 'danger',
        icon: XCircle,
      });
    }

    return actions;
  };

  const timeSlots = Array.from({ length: 15 }, (_, i) => 7 + i); // 7 AM to 9 PM

  const appointmentsByHour = useMemo(() => {
    const grouped: Record<number, Appointment[]> = {};
    timeSlots.forEach(hour => { grouped[hour] = []; });
    
    appointments.forEach(apt => {
      const hour = timeZone ? Number(branchWallClock(apt.startTime, timeZone).slice(11, 13)) : -1;
      if (grouped[hour]) {
        grouped[hour].push(apt);
      }
    });
    
    return grouped;
  }, [appointments, timeSlots, timeZone]);

  if (!branchId || !effectiveOrgId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'bg-black text-zinc-400' : 'bg-[#fdfaf5] text-gray-600'}`}>
        {t('appointments.selectBranch', 'Please select a branch to view appointments')}
      </motion.div>
    );
  }

  if (!timeZone) return <div role="status" className="p-8 text-slate-900 dark:text-white">
    {zoneError ? t('salonSale.unavailable') : t('common.loading')}
    {zoneError && <button type="button" className="ml-3 rounded-xl border p-2" onClick={() => setZoneRefresh(value => value + 1)}>{t('common.refresh', 'Refresh')}</button>}
  </div>;

  return (
    // Founder 31/10: the shared workspace -- title with plain figures, search and refresh on one row,
    // then the day chips, the date, the app's staff dropdown and the view switch.
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="table-workspace h-full" data-theme={isDark ? 'dark' : 'light'}>
      <div className="table-workspace-controls">
        <WorkspaceHeader
          data-vertical-hero="appointments"
          heading={embedded ? t('dashboard.tabs.services', { defaultValue: 'Services' }) : t('navigation.menu.appointments', { defaultValue: 'Appointments' })}
          stats={[
            { key: 'total', label: t('appointments.stats.total', 'Total'), value: stats.total },
            { key: 'confirmed', label: t('appointments.stats.confirmed', 'Confirmed'), value: stats.confirmed },
            { key: 'inProgress', label: t('appointments.stats.inProgress', 'In Progress'), value: stats.inProgress },
            { key: 'completed', label: t('appointments.stats.completed', 'Completed'), value: stats.completed },
          ]}
        >
          {/* A walk-in sale starts from the hub's «+»; this page alone has no «+» for it, so it keeps
              the button. Its SalonCatalogPicker asks for the stylist separately for each service. */}
          {!embedded && (
            <button type="button" data-testid="salon-new-walk-in-sale" className="table-workspace-primary"
              onClick={() => setSale({ items: [], customer: { id: '', name: '', phone: '' } })}>{t('salonSale.newSale')}</button>
          )}
          <WorkspaceSearch value={searchTerm} onChange={setSearchTerm} placeholder={t('appointments.searchPlaceholder', 'Search...')} />
          <WorkspaceIconButton label={t('common.refresh', 'Refresh')} onClick={() => refetch()}>
            <RefreshCw className={isLoading ? 'animate-spin' : undefined} />
          </WorkspaceIconButton>
        </WorkspaceHeader>

        <div className="table-workspace-toolbar">
          <WorkspaceChips<QuickFilter>
            label={t('appointments.filters.today', 'Today')}
            value={quickFilter}
            onChange={handleQuickFilter}
            items={(['today', 'tomorrow', 'week'] as QuickFilter[]).map((filter) => ({
              key: filter,
              label: t(`appointments.filters.${filter}`, filter.charAt(0).toUpperCase() + filter.slice(1)),
            }))}
          />
          <div className="table-workspace-date">
            <WorkspaceIconButton label={t('appointments.previousDay', 'Previous day')} onClick={() => navigateDate('prev')}>
              <ChevronLeft />
            </WorkspaceIconButton>
            <KitDateField
              type="date" required
              value={toLocalDateStr(selectedDate)}
              aria-label={t('appointments.filters.today', 'Today')}
              onChange={(e) => {
                // Parse date string as local date (not UTC)
                const [year, month, day] = e.target.value.split('-').map(Number);
                setSelectedDate(new Date(year, month - 1, day));
                // Reset quick filter when manually selecting date
                setQuickFilter('today');
              }}
            />
            <WorkspaceIconButton label={t('appointments.nextDay', 'Next day')} onClick={() => navigateDate('next')}>
              <ChevronRight />
            </WorkspaceIconButton>
          </div>
          <span className="table-workspace-spacer" aria-hidden="true" />
          <WorkspaceSelect
            label={t('appointments.filters.allStaff', 'All Staff')}
            value={staffFilter}
            onChange={setStaffFilter}
            options={[
              { value: 'all', label: t('appointments.filters.allStaff', 'All Staff') },
              ...filterStaffOptions.map((option) => ({ value: option.id, label: option.name })),
            ]}
          />
          <div className="table-workspace-view-mode">
            {(['timeline', 'list'] as ViewMode[]).map(mode => (
              <button key={mode} type="button" aria-pressed={viewMode === mode} onClick={() => setViewMode(mode)}>
                {t(`appointments.view.${mode}`, mode.charAt(0).toUpperCase() + mode.slice(1))}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && appointments.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('appointments.loading', 'Loading appointments...')}
        </motion.div>
      )}

      {/* Content */}
      {!isLoading && (
        <motion.div variants={pageMotionItem} className="relative mt-3 min-h-0 flex-1 overflow-hidden">
          {viewMode === 'timeline' ? (
            <motion.div variants={pageMotionContainer} className="h-full overflow-y-auto scrollbar-hide">
              <div className="grid grid-cols-[60px_1fr] gap-2">
                {timeSlots.map(hour => {
                  const hourAppointments = appointmentsByHour[hour] || [];
                  return (
                    <React.Fragment key={hour}>
                      <div className="table-workspace-hour-label">
                        {String(hour).padStart(2, '0')}:00
                      </div>
                      <div className="table-workspace-hour">
                        <div className="flex flex-wrap gap-2">
                          {hourAppointments.map(apt => (
                            <motion.div
                              variants={pageMotionItem}
                              key={apt.id}
                              className={`px-3 py-2 rounded-2xl border-l-4 ${statusConfig[apt.status].border} ${
                                isDark ? 'bg-gray-700' : 'bg-white shadow-xs'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                  {apt.customerName || t('appointments.walkIn', { defaultValue: 'Walk-in' })}
                                </span>
                                <span className={`text-xs px-2 py-0.5 rounded-full ${statusConfig[apt.status].chip}`}>
                                  {t(`appointments.status.${apt.status}`, { defaultValue: statusConfig[apt.status].label })}
                                </span>
                              </div>
                              <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                                {apt.serviceName || t('appointments.service', { defaultValue: 'Service' })} <span aria-hidden="true">&middot;</span> {apt.staffName || t('appointments.staff', { defaultValue: 'Staff' })} <span aria-hidden="true">&middot;</span> {apt.duration}{t('common.minutes', 'min')}
                              </div>
                              <div className="flex gap-1 mt-2">
                                {getQuickActions(apt).slice(0, 2).map((action, idx) => {
                                  const Icon = action.icon;
                                  return (
                                    <button
                                      key={idx}
                                      onClick={action.action}
                                      className={`px-2 py-1 rounded-xl text-xs font-medium flex items-center gap-1 ${
                                        action.variant === 'primary' ? 'bg-yellow-400 text-black border border-yellow-400' :
                                        action.variant === 'success' ? 'bg-(--pos-s-yellow) text-black' :
                                        action.variant === 'danger' ? 'bg-red-600 text-white' :
                                        isDark ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-800'
                                      }`}
                                    >
                                      <Icon className="w-3 h-3" />
                                      {action.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </motion.div>
                          ))}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </motion.div>
          ) : (
            <motion.div variants={pageMotionContainer} className="h-full overflow-y-auto space-y-2 scrollbar-hide">
              {appointments.map(apt => (
                <motion.div
                  variants={pageMotionItem}
                  key={apt.id}
                  className={`p-4 rounded-2xl border-l-4 ${statusConfig[apt.status].border} ${
                    isDark ? 'bg-gray-800' : 'bg-white shadow-xs'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {apt.customerName || t('appointments.walkIn', { defaultValue: 'Walk-in' })}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {timeZone ? branchWallClock(apt.startTime, timeZone).slice(11, 16) : '-'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Scissors className="w-3 h-3" />
                          {apt.serviceName || t('appointments.service', { defaultValue: 'Service' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {apt.staffName || t('appointments.staff', { defaultValue: 'Staff' })}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-3 py-1 rounded-full text-sm ${statusConfig[apt.status].chip}`}>
                        {t(`appointments.status.${apt.status}`, { defaultValue: statusConfig[apt.status].label })}
                      </span>
                      {getQuickActions(apt).map((action, idx) => {
                        const Icon = action.icon;
                        return (
                          <button
                            key={idx}
                            onClick={action.action}
                            className={`px-3 py-1.5 rounded-xl text-sm font-medium flex items-center gap-1 ${
                              action.variant === 'primary' ? 'bg-yellow-400 text-black border border-yellow-400 active:bg-yellow-300' :
                              action.variant === 'success' ? 'bg-(--pos-s-yellow) text-black active:bg-yellow-500' :
                              action.variant === 'danger' ? 'bg-red-600 text-white active:bg-red-700' :
                              isDark ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'
                            }`}
                          >
                            <Icon className="w-4 h-4" />
                            {action.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}

          {appointments.length === 0 && !isLoading && (
            <motion.div variants={pageMotionItem} data-appointments-empty className="table-workspace-empty">
              <Calendar aria-hidden="true" />
              <p className="table-workspace-empty-title">{t('appointments.noAppointments', { defaultValue: 'No appointments found' })}</p>
              <p>{embedded
                ? t('appointments.emptyPlusHint', { defaultValue: 'New appointment or service from the «+» button' })
                : t('appointments.noAppointmentsHint', { defaultValue: 'Try selecting a different date or adjusting your filters' })}</p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* Floating Action Button - hidden when embedded in the Orders hub (the hub owns New Order). */}
      {!embedded && !showCreateModal && !showCustomerSearch && (
        <FloatingActionButton
          onClick={() => setShowCreateModal(true)}
          aria-label={t('appointments.newAppointment', { defaultValue: 'New Appointment' })}
          className="bottom-20! sm:bottom-6!"
        />
      )}

      {sale && <OrderFlow salonSale={sale} showFab={false} restoreDraftOnMount={false} onSalonClose={() => { setSale(null); void finishClaimedCheckout(); void refetch(); }} />}

      {/* Create Appointment Modal */}
      {showCreateModal && (
        <CreateAppointmentModalContent
          timeZone={timeZone}
          isDark={isDark}
          formData={formData}
          setFormData={setFormData}
          staffList={staffList}
          servicesList={servicesList}
          selectedCustomer={selectedCustomer}
          isSubmitting={isSubmitting}
          onSearchCustomer={() => setShowCustomerSearch(true)}
          onClearCustomer={() => {
            setSelectedCustomer(null);
            setFormData(prev => ({ ...prev, customerId: '', customerName: '', customerPhone: '', customerEmail: '' }));
          }}
          handleCreateAppointment={handleCreateAppointment}
          onClose={() => {
            setShowCreateModal(false);
            setSelectedCustomer(null);
            setFormData({
              customerId: '',
              customerName: '',
              customerPhone: '',
              customerEmail: '',
              staffId: '',
              serviceId: '',
              date: timeZone ? branchWallClock(new Date(), timeZone).slice(0, 10) : '',
              startTime: '',
              notes: '',
            });
          }}
          branchId={branchId || ''}
          organizationId={effectiveOrgId}
          onShown={handleCreateModalShown}
        />
      )}

      {/* Customer Search Modal — reuses the full-featured search from the users module */}
      <CustomerSearchModal
        isOpen={showCustomerSearch}
        onClose={() => setShowCustomerSearch(false)}
        onCustomerSelected={handleCustomerSelected}
        onAddNewCustomer={(phone) => {
          // Pre-fill walk-in fields with the phone number
          setFormData(prev => ({ ...prev, customerPhone: phone, customerName: '' }));
          setShowCustomerSearch(false);
        }}
      />
    </motion.div>
  );
});

AppointmentsView.displayName = 'AppointmentsView';

// Separate modal component for better organization
interface AppointmentFormData {
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  staffId: string;
  serviceId: string;
  date: string;
  startTime: string;
  notes: string;
}

interface CreateAppointmentModalContentProps {
  timeZone: string | null;
  isDark: boolean;
  formData: AppointmentFormData;
  setFormData: React.Dispatch<React.SetStateAction<AppointmentFormData>>;
  staffList: { id: string; name: string }[];
  servicesList: { id: string; name: string; duration: number }[];
  selectedCustomer: { id: string; name: string; phone: string; email?: string; is_banned?: boolean; ban_reason?: string } | null;
  isSubmitting: boolean;
  onSearchCustomer: () => void;
  onClearCustomer: () => void;
  handleCreateAppointment: () => Promise<void>;
  onClose: () => void;
  branchId: string;
  organizationId: string;
  /** The window is in the page (called before its first paint). */
  onShown?: () => void;
}

// Round 308 (live QA, Greek/dark): the New Appointment staff + service fields used native <select>
// controls, whose OS/WebView dropdown rendered a harsh grey strip outside the glass surface and cramped
// the selected label under the arrow. GlassSelect is a touch-first, in-modal glass listbox replacement:
// a >=44px trigger whose selected value truncates (never overlaps the chevron), and a blurred, rounded
// popup rendered inside the modal DOM with role=listbox/option + aria-haspopup/expanded/controls. Escape
// closes the open dropdown via a capture-phase listener that stops propagation, so the modal's own
// document-level Escape handler does not also fire (a closed dropdown lets Escape close the modal).
interface GlassSelectOption {
  value: string;
  label: string;
}

interface GlassSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: GlassSelectOption[];
  placeholder: string;
  ariaLabel: string;
  isDark: boolean;
}

const GlassSelect: React.FC<GlassSelectProps> = ({ value, onChange, options, placeholder, ariaLabel, isDark }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    // Capture phase: an open dropdown swallows Escape (closing only itself) before the event can bubble
    // to the modal's document-level Escape handler, which would otherwise close the whole dialog.
    const handleEscapeCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscapeCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscapeCapture, true);
    };
  }, [open]);

  return (
    // Round 333: raise this select's OWN stacking context while open (z-50) so its absolutely-positioned
    // listbox paints above sibling fields/cards; closed it sits at a low z-10 so triggers don't fight.
    <div ref={containerRef} className={`relative ${open ? 'z-50' : 'z-10'}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        className="pos-glass-field flex w-full items-center gap-2 min-h-touch px-3.5 py-2.5 text-sm text-left transition active:scale-[0.99]"
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? '' : (isDark ? 'text-zinc-500' : 'text-gray-400')}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${isDark ? 'text-zinc-400' : 'text-gray-600'}`} />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 right-0 top-full z-50 mt-1.5 max-h-60 overflow-y-auto scrollbar-hide rounded-xl border p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)] ${isDark ? 'bg-zinc-900/90 backdrop-blur-2xl border-white/10' : 'bg-white/80 backdrop-blur-2xl border-white/60'}`}
        >
          {options.length === 0 ? (
            <div className={`px-3 py-2 text-sm ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{placeholder}</div>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => { onChange(option.value); setOpen(false); }}
                  className={`flex w-full items-center gap-2 min-h-touch rounded-xl px-3 py-2 text-sm text-left transition active:scale-95 focus-visible:outline-2 focus-visible:outline-yellow-400 ${
                    isSelected
                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                      : (isDark ? 'text-zinc-200 active:bg-white/10' : 'text-gray-800 active:bg-black/5')
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected && <Check className="h-4 w-4 shrink-0" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

const CreateAppointmentModalContent: React.FC<CreateAppointmentModalContentProps> = ({
  timeZone,
  isDark,
  formData,
  setFormData,
  staffList,
  servicesList,
  selectedCustomer,
  isSubmitting,
  onSearchCustomer,
  onClearCustomer,
  handleCreateAppointment,
  onClose,
  branchId,
  organizationId,
  onShown,
}) => {
  const { t, i18n } = useTranslation();
  const bridge = getBridge();
  // The modal remounts on each open, so seed its visible date state from the parent's
  // formData.date (the open-time default, today). This makes the calendar, the time-slot
  // grid (gated on selectedDay) and the summary visible with the default startTime ('09:00')
  // already selected, instead of leaving a hidden default time that enables Create while no
  // slot is shown. parseLocalDateString keeps local-calendar handling (no UTC drift).
  const resolveInitialModalDate = (): Date => {
    const parsed = parseLocalDateString(formData.date);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  };
  const [calendarDate, setCalendarDate] = useState<Date>(resolveInitialModalDate);
  const [selectedDay, setSelectedDay] = useState<Date | null>(resolveInitialModalDate);
  const [timePeriod, setTimePeriod] = useState<'morning' | 'afternoon' | 'evening'>('morning');
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [availabilityRefresh, setAvailabilityRefresh] = useState(0);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Ref + stable title id so the portaled modal declares labelled dialog semantics and
  // joins the topmost-[role="dialog"] Escape stack used across the POS modals.
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes the New Appointment modal, matching the Reservations/Rooms modals. The
  // component is mounted only while open, so no isOpen gate is needed. Only the frontmost
  // [role="dialog"] reacts, so a nested dialog above it (e.g. the customer search) closes
  // first. Routes through onClose (close-only) and never submits/creates an appointment.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== dialogRef.current) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Locale-aware narrow weekday initials, Sunday-first
  // to match the date grid. 2023-01-01 is a Sunday; format the 7 days from it through
  // the shared locale-aware date formatter so the row never leaks English S/M/T/W/F.
  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        formatDate(new Date(2023, 0, 1 + index), { weekday: 'narrow' }),
      ),
    [i18n.language],
  );

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: Date[] = [];
    
    const startPadding = firstDay.getDay();
    for (let i = startPadding - 1; i >= 0; i--) {
      days.push(new Date(year, month, -i));
    }
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }
    const endPadding = 42 - days.length;
    for (let i = 1; i <= endPadding; i++) {
      days.push(new Date(year, month + 1, i));
    }
    return days.slice(0, 42);
  }, [calendarDate]);

  // Generate time slots
  const timeSlots = useMemo(() => {
    const slots: string[] = [];
    let startHour: number, endHour: number;
    if (timePeriod === 'morning') { startHour = 7; endHour = 12; }
    else if (timePeriod === 'afternoon') { startHour = 12; endHour = 17; }
    else { startHour = 17; endHour = 21; }
    
    for (let h = startHour; h < endHour; h++) {
      slots.push(`${h.toString().padStart(2, '0')}:00`);
      slots.push(`${h.toString().padStart(2, '0')}:15`);
      slots.push(`${h.toString().padStart(2, '0')}:30`);
      slots.push(`${h.toString().padStart(2, '0')}:45`);
    }
    return slots;
  }, [timePeriod]);

  // One authoritative grid includes shifts, breaks, qualification, conflicts and past-time checks.
  useEffect(() => {
    let disposed = false;
    setAvailableSlots([]);
    setAvailabilityError(false);
    setFormData(prev => ({ ...prev, startTime: '' }));
    const service = servicesList.find(item => item.id === formData.serviceId);
    if (!selectedDay || !branchId || !formData.staffId || !service) {
      setLoadingSlots(false);
      return;
    }
    setLoadingSlots(true);
    const { start, end } = appointmentWallTimes(formData.date, '00:00', 1440);
    const query = new URLSearchParams({ start_time: start, end_time: end,
      staff_id: formData.staffId, service_id: service.id, slot_duration_minutes: String(service.duration) });
    void posApiGet<{ success?: boolean; availableSlots?: string[] }>(`/api/pos/staff-schedule/check?${query}`)
      .then(result => {
        if (disposed) return;
        if (!result.success || result.data?.success === false || !Array.isArray(result.data?.availableSlots)) throw new Error('Availability unavailable');
        if (!timeZone) throw new Error('Store timezone unavailable');
        setAvailableSlots(result.data.availableSlots.map(instant => branchWallClock(instant, timeZone)));
      })
      .catch(() => { if (!disposed) setAvailabilityError(true); })
      .finally(() => { if (!disposed) setLoadingSlots(false); });
    return () => { disposed = true; };
  }, [selectedDay, branchId, formData.staffId, formData.serviceId, servicesList, setFormData, availabilityRefresh, timeZone]);

  const isTimeSlotBooked = (time: string): boolean => {
    if (!selectedDay || !formData.staffId || loadingSlots || availabilityError) return true;
    return !timeZone || !availableSlots.includes(`${formData.date}T${time}`);
  };

  const handleDateSelect = (day: Date) => {
    setSelectedDay(day);
    const dateStr = `${day.getFullYear()}-${(day.getMonth() + 1).toString().padStart(2, '0')}-${day.getDate().toString().padStart(2, '0')}`;
    setFormData((prev: AppointmentFormData) => ({ ...prev, date: dateStr, startTime: '' }));
  };

  const handleTimeSelect = (time: string) => {
    // Round 285 follow-up: hard guard -- a slot can only be picked once staff + service exist (and it is
    // not booked), so the yellow selected state can never appear before there is real availability context.
    if (!formData.staffId || !formData.serviceId || isTimeSlotBooked(time)) return;
    setFormData((prev: AppointmentFormData) => ({ ...prev, startTime: time }));
  };

  const selectedService = servicesList.find(s => s.id === formData.serviceId);
  // Round 285: a time slot must not be selectable until BOTH staff and service are chosen -- otherwise
  // the slot grid implies availability was checked when it was not. The backend availability validation
  // in handleCreateAppointment is unchanged; this only gates the UI affordance + the guidance copy.
  const hasStaffAndService = Boolean(formData.staffId && formData.serviceId);

  // Progressive reveal is presentation only; availability, validation and submit stay authoritative.
  const reduceMotion = useReducedMotion();
  const showSummaryStage = Boolean(formData.startTime);
  const dateTimeStageRef = useRef<HTMLDivElement>(null);
  const summaryStageRef = useRef<HTMLDivElement>(null);
  const previousStages = useRef({ dateTime: hasStaffAndService, summary: showSummaryStage });
  // Grow out of the control that opened the window (founder 11/11/2026), like every glass window.
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useLayoutEffect(() => {
    if (dialogRef.current) applyModalOrigin(dialogRef.current);
    onShownRef.current?.();
  }, []);
  const slotsMayAnimate = useRef(false);
  useEffect(() => { slotsMayAnimate.current = true; }, []);
  useEffect(() => {
    const revealed = [
      hasStaffAndService && !previousStages.current.dateTime ? dateTimeStageRef.current : null,
      showSummaryStage && !previousStages.current.summary ? summaryStageRef.current : null,
    ].filter((element): element is HTMLDivElement => Boolean(element));
    previousStages.current = { dateTime: hasStaffAndService, summary: showSummaryStage };
    if (!revealed.length) return;
    const timer = window.setTimeout(() => revealed.forEach(element =>
      element.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'instant' : 'smooth' }),
    ), reduceMotion ? 0 : 240);
    return () => window.clearTimeout(timer);
  }, [hasStaffAndService, showSummaryStage, reduceMotion]);
  const revealMotion = {
    initial: reduceMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: reduceMotion ? 0 : 0.24, duration: 0 } },
  };

  return renderModalPortal(
    <div className={`fixed inset-0 z-1000 flex items-start justify-center backdrop-blur-xl px-3 pb-3 pt-[4vh] sm:px-6 sm:pb-6 ${isDark ? 'bg-black/55' : 'bg-black/22'}`}>
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
        style={{ transformOrigin: 'var(--modal-origin-x, 50%) var(--modal-origin-y, 50%)' }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1], opacity: { duration: reduceMotion ? 0 : 0.1 } }}
        className={`w-full max-w-3xl rounded-3xl border ring-1 shadow-[0_30px_90px_rgba(0,0,0,0.55)] max-h-full flex flex-col overflow-hidden ${isDark ? 'bg-zinc-950/55 backdrop-blur-2xl border-white/10 ring-white/10' : 'bg-white/18 backdrop-blur-2xl border-white/70 ring-white/45'}`}
      >
        {/* Header */}
        <div className={`flex items-start justify-between px-4 sm:px-6 pt-4 pb-1 shrink-0`}>
          <div>
            <h2 id={titleId} className={`text-lg sm:text-xl font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
              {t('appointments.modal.title', 'New Appointment')}
            </h2>
            <p className={`text-xs sm:text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
              {selectedDay && formData.startTime
                ? `${formatDate(selectedDay)} - ${formData.startTime}`
                : t('appointments.modal.phoneSearchLabel', 'Search Customer by Phone')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.actions.close', 'Close')}
            className="liquid-glass-modal-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* One scrolling column reserves the plain footer, with stage 1 outside animated wrappers. */}
        <div className="pos-progressive-form p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide">
          <div className="flex flex-col gap-4">
            {/* Customer Selection */}
            <div className="pos-glass-form-card">
              <label className="block text-xs font-semibold mb-3 liquid-glass-modal-text-muted">
                <User className="w-4 h-4 inline mr-1" /> {t('appointments.modal.customer', 'Customer')}
              </label>

              {selectedCustomer ? (
                /* Selected customer card */
                <div className={`p-3 rounded-xl border ${selectedCustomer.is_banned ? (isDark ? 'bg-(--pos-s-surface-2) border-(--pos-s-border)' : 'bg-(--pos-s-surface-2) border-(--pos-s-border)') : (isDark ? 'bg-(--pos-s-surface-2) border-(--pos-s-border)' : 'bg-(--pos-s-surface-2) border-(--pos-s-border)')}`}>
                  {selectedCustomer.is_banned && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <Ban className="w-4 h-4 text-red-500" />
                      <span className="text-xs font-semibold text-red-500 uppercase">{t('appointments.modal.bannedCustomer', 'Banned Customer')}</span>
                      {selectedCustomer.ban_reason && <span className="text-xs text-red-700 dark:text-red-400">— {selectedCustomer.ban_reason}</span>}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className={`font-semibold ${selectedCustomer.is_banned ? 'text-red-400' : (isDark ? 'text-emerald-300' : 'text-emerald-700')}`}>{selectedCustomer.name}</p>
                      <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>{selectedCustomer.phone}</p>
                      {selectedCustomer.email && <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-400'}`}>{selectedCustomer.email}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-green-500" />
                      <button
                        type="button"
                        onClick={onClearCustomer}
                        aria-label={t('appointments.modal.clearCustomer', 'Clear')}
                        className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition active:scale-95 ${isDark ? 'active:bg-zinc-700' : 'active:bg-gray-200'}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Search button + walk-in option */
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={onSearchCustomer}
                    className="pos-glass-field min-h-touch w-full px-4 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition active:scale-[0.99]"
                  >
                    <Search className="w-4 h-4" />
                    {t('appointments.modal.searchCustomer', 'Search Customer')}
                  </button>
                  <div className="contents">
                    <input
                      type="text"
                      value={formData.customerName}
                      onChange={(e) => setFormData(prev => ({ ...prev, customerName: e.target.value }))}
                      aria-label={t('appointments.modal.walkInName', 'Walk-in name')}
                      placeholder={t('appointments.modal.walkInName', 'Walk-in name')}
                      className="pos-glass-field min-h-touch min-w-0 px-3 py-2.5 text-sm"
                    />
                    <input
                      type="tel"
                      value={formData.customerPhone}
                      onChange={(e) => setFormData(prev => ({ ...prev, customerPhone: e.target.value }))}
                      aria-label={t('appointments.modal.walkInPhone', 'Phone')}
                      placeholder={t('appointments.modal.walkInPhone', 'Phone')}
                      className="pos-glass-field min-h-touch min-w-0 px-3 py-2.5 text-sm"
                    />
                  </div>
                </div>
              )}
            </div>

            <div data-appointment-staff-service className={`relative z-20 overflow-visible pos-glass-form-card grid grid-cols-1 sm:grid-cols-2 gap-3`}>
              <p className="sm:col-span-2 text-xs font-semibold liquid-glass-modal-text-muted">
                {t('appointments.modal.slotsEmpty.staffStep', 'Staff')} &amp; {t('appointments.modal.slotsEmpty.serviceStep', 'Service')}
              </p>
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                  {t('appointments.modal.staffLabel', 'Staff *')}
                </label>
                <GlassSelect
                  value={formData.staffId}
                  onChange={(value) => setFormData(prev => ({ ...prev, staffId: value, startTime: '' }))}
                  options={staffList.map(s => ({ value: s.id, label: s.name }))}
                  placeholder={t('appointments.modal.selectPlaceholder', 'Select...')}
                  ariaLabel={t('appointments.modal.staffLabel', 'Staff *')}
                  isDark={isDark}
                />
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                  {t('appointments.modal.serviceLabel', 'Service *')}
                </label>
                <GlassSelect
                  value={formData.serviceId}
                  onChange={(value) => setFormData(prev => ({ ...prev, serviceId: value, startTime: '' }))}
                  options={servicesList.map(s => ({ value: s.id, label: `${s.name} (${s.duration}${t('common.minutes', 'min')})` }))}
                  placeholder={t('appointments.modal.selectPlaceholder', 'Select...')}
                  ariaLabel={t('appointments.modal.serviceLabel', 'Service *')}
                  isDark={isDark}
                />
              </div>
            </div>

            {!hasStaffAndService && (
              <div
                data-appointment-slots-empty
                className="flex flex-wrap items-center gap-2 rounded-2xl text-xs liquid-glass-modal-text-muted"
              >
                <p className="text-xs leading-5 liquid-glass-modal-text-muted">
                  <span className="font-semibold">{t('appointments.modal.slotsEmpty.title', 'Pick staff and service first')}</span>{' '}
                  {t('appointments.modal.slotsEmpty.help', 'Choose a staff member and a service first, then the real available times show up here.')}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {([
                    { key: 'staff', done: Boolean(formData.staffId), label: t('appointments.modal.slotsEmpty.staffStep', 'Staff'), Icon: User },
                    { key: 'service', done: Boolean(formData.serviceId), label: t('appointments.modal.slotsEmpty.serviceStep', 'Service'), Icon: Scissors },
                  ] as const).map(step => {
                    const StepIcon = step.Icon;
                    return (
                      <span
                        key={step.key}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${step.done
                            ? (isDark ? 'bg-(--pos-s-surface-2) border-(--pos-s-border) text-emerald-800 dark:text-emerald-200' : 'bg-(--pos-s-surface-2) border-(--pos-s-border) text-emerald-700')
                            : 'bg-(--pos-s-surface-2) border-(--pos-s-border) text-(--pos-s-muted)'
                          }`}
                      >
                        {step.done ? <CheckCircle className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                        {step.label}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            <AnimatePresence initial={false}>
              {hasStaffAndService && (
                <motion.div key="date-time" ref={dateTimeStageRef} data-appointment-stage="2" {...revealMotion}>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(388px,1fr)_1fr]">
                    {/* Calendar */}
                    <div className="pos-glass-form-card min-w-0 overflow-x-auto scrollbar-hide">
                      <div className="flex items-center justify-between mb-2">
                        <button
                          type="button"
                          onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1))}
                          aria-label={t('appointments.modal.previousMonth', 'Previous month')}
                          className="pos-glass-field inline-flex h-11 w-11 items-center justify-center transition active:scale-95"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className={`font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{formatDate(calendarDate, { month: 'long', year: 'numeric' })}</span>
                        <button
                          type="button"
                          onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1))}
                          aria-label={t('appointments.modal.nextMonth', 'Next month')}
                          className="pos-glass-field inline-flex h-11 w-11 items-center justify-center transition active:scale-95"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="grid min-w-[356px] grid-cols-7 gap-2 mb-2">
                        {weekDays.map((d, i) => <div key={i} className={`text-center text-xs py-1 ${isDark ? 'text-zinc-500' : 'text-gray-600'}`}>{d}</div>)}
                      </div>
                      <div className="grid min-w-[356px] grid-cols-7 gap-2">
                        {calendarDays.map((day, idx) => {
                          const isCurrentMonth = day.getMonth() === calendarDate.getMonth();
                          const isSelected = selectedDay?.toDateString() === day.toDateString();
                          const today = timeZone ? parseLocalDateString(branchWallClock(new Date(), timeZone).slice(0, 10)) : null;
                          const isToday = today?.toDateString() === day.toDateString();
                          const isPast = !today || day < today;
                          return (
                            <button
                              key={idx}
                              type="button"
                              disabled={isPast}
                              onClick={() => handleDateSelect(day)}
                              aria-pressed={isSelected}
                              className={`h-11 min-w-11 rounded-xl text-sm font-medium transition-all border
                      ${isPast
                                  ? 'cursor-not-allowed border-transparent bg-transparent opacity-35 ' + (isDark ? 'text-zinc-400' : 'text-zinc-600')
                                  : (isSelected ? '' : 'pos-glass-field ') + 'active:scale-95 ' + (!isCurrentMonth && !isSelected ? 'opacity-60' : '')}
                      ${isSelected ? 'border-(--pos-s-sel-bg) bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg)' : ''}
                      ${isToday && !isSelected ? (isDark ? 'ring-1 ring-zinc-500' : 'ring-1 ring-gray-400') : ''}
                    `}
                            >
                              {day.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Times. On wide screens the card takes the calendar's height and the slots
                        scroll inside it, so nothing is left empty under the legend (founder 11/11). */}
                    <div className="pos-glass-form-card min-w-0 md:relative">
                      <div className="flex flex-col gap-3 md:absolute md:inset-4">
                      <div className="flex min-h-5 items-center justify-between gap-3">
                        <h3 className="text-xs font-semibold liquid-glass-modal-text-muted">
                          {t('appointments.modal.sections.dateTime', 'Date & Time')}
                        </h3>
                        {/* Always in the layout: the slots below never move while availability loads. */}
                        <span
                          aria-live="polite"
                          className={`text-xs liquid-glass-modal-text-muted ${loadingSlots ? '' : 'invisible'}`}
                        >
                          {t('appointments.modal.loadingSlots', 'Loading...')}
                        </span>
                      </div>
                      {!selectedDay && (
                        <p className="flex flex-1 items-center justify-center py-6 text-center text-sm liquid-glass-modal-text-muted">
                          {t('appointments.modal.pickDay', 'Pick a day to see the times')}
                        </p>
                      )}
                      {selectedDay && (
                        <div className="flex min-h-0 flex-1 flex-col gap-3">
                          <div className="grid grid-cols-3 gap-2">
                            {(['morning', 'afternoon', 'evening'] as const).map(p => (
                              <button
                                key={p}
                                type="button"
                                onClick={() => setTimePeriod(p)}
                                aria-pressed={timePeriod === p}
                                className={`min-h-touch active:scale-95 py-2 text-xs sm:text-sm rounded-xl border font-medium transition-all ${timePeriod === p
                                    ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                                    : 'pos-glass-field active:scale-95'
                                  }`}
                              >
                                {p === 'morning'
                                  ? t('appointments.modal.periods.morning', 'Morning')
                                  : p === 'afternoon'
                                    ? t('appointments.modal.periods.afternoon', 'Afternoon')
                                    : t('appointments.modal.periods.evening', 'Evening')}
                              </button>
                            ))}
                          </div>

                          {availabilityError && <div role="alert" className="text-sm text-red-600 dark:text-red-300"><p>{t('appointments.workflow.availabilityUnavailable', 'Availability could not be checked. Check the connection and try again.')}</p><button type="button" className="pos-glass-field mt-2 min-h-touch rounded-xl border px-3 active:scale-95" onClick={() => setAvailabilityRefresh(value => value + 1)}>{t('common.actions.retry', 'Try again')}</button></div>}
                          {!loadingSlots && !availabilityError && availableSlots.length === 0 && <p className="text-sm">{t('appointments.workflow.noSlots', 'No available times for this staff member and service. Check the synced schedule or choose another day.')}</p>}

                          <motion.div key={`${formData.date}-${timePeriod}`} initial={false} className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto p-1 scrollbar-hide max-md:max-h-64">
                            {timeSlots.map((slot, index) => {
                              const booked = isTimeSlotBooked(slot);
                              // While availability is being checked nothing is known yet: the slot waits,
                              // dimmed and not tappable, instead of flashing red as "booked".
                              const checking = loadingSlots;
                              const selected = formData.startTime === slot;
                              return (
                                <motion.button
                                  key={slot}
                                  initial={reduceMotion || !slotsMayAnimate.current ? false : { opacity: 0, y: 6 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ duration: reduceMotion ? 0 : 0.18, delay: reduceMotion || !slotsMayAnimate.current ? 0 : Math.min(index * 0.012, 0.24) }}
                                  aria-pressed={selected}
                                  type="button"
                                  disabled={booked}
                                  onClick={() => handleTimeSelect(slot)}
                                  className={`flex items-center justify-center min-h-touch py-2 px-2 text-xs sm:text-sm rounded-xl border relative transition-all active:scale-95
                        ${selected
                                      ? 'bg-(--pos-s-sel-bg) text-(--pos-s-sel-fg) border-(--pos-s-sel-bg)'
                                      : checking
                                        ? 'pos-glass-field cursor-wait opacity-45'
                                        : booked
                                          ? 'border-transparent bg-transparent text-red-700 dark:text-red-300 line-through cursor-not-allowed opacity-70'
                                          : 'pos-glass-field active:scale-95'}
                      `}
                                >
                                  {slot}
                                  {booked && !checking && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
                                </motion.button>
                              );
                            })}
                          </motion.div>

                          <div className="flex shrink-0 items-center gap-3 text-[11px] leading-none liquid-glass-modal-text-muted">
                            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-(--field-glass-border) bg-(--field-glass)" /> {t('appointments.modal.availability.available', 'Available')}</span>
                            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" /> {t('appointments.workflow.unavailable', 'Unavailable')}</span>
                          </div>
                        </div>
                      )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {showSummaryStage && (
                <motion.div key="summary-notes" ref={summaryStageRef} data-appointment-stage="3" {...revealMotion}>
                  <div className="space-y-4">
                    {/* Summary */}
                    {formData.startTime && selectedService && selectedDay && (
                      <div className="pos-glass-form-card">
                        <div className="flex flex-wrap gap-2 items-center justify-between text-sm">
                          <span className={isDark ? 'text-zinc-300' : 'text-gray-600'}>{formatDate(selectedDay)}</span>
                          <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formData.startTime}</span>
                          <span className={isDark ? 'text-zinc-500' : 'text-gray-400'}>→</span>
                          <span className={`font-semibold ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>
                            {(() => {
                              const [h, m] = formData.startTime.split(':').map(Number);
                              return appointmentWallTimes(formData.date, formData.startTime, selectedService.duration).end.slice(11, 16);
                            })()}
                          </span>
                          <span className={isDark ? 'text-zinc-500' : 'text-gray-600'}>({selectedService.duration}{t('common.minutes', 'min')})</span>
                        </div>
                      </div>
                    )}
                    <div className={`relative z-10 pos-glass-form-card`}>
                      <label className="block text-xs font-semibold mb-1.5 liquid-glass-modal-text-muted">
                        {t('appointments.modal.notesLabel', 'Notes')}
                      </label>
                      <textarea
                        aria-label={t('appointments.modal.notesLabel', 'Notes')}
                        value={formData.notes}
                        onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        placeholder={t('appointments.modal.notesPlaceholder', 'Optional notes...')}
                        rows={2}
                        className="pos-glass-field w-full px-3.5 py-2.5 text-sm resize-none"
                      />
                    </div>

                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Footer — sticky glass bar; reserved by the flex column so it never overlaps the body. */}
        <div className="pos-progressive-form px-4 sm:px-6 pb-5 pt-2 shrink-0">
          <div className="flex items-center justify-between gap-3">
            {/* Cancel = solid neutral */}
            <button onClick={onClose} className={`min-h-touch px-5 py-2.5 rounded-xl font-medium border transition-transform duration-150 active:scale-95 ${isDark ? 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-(--pos-s-fg) active:bg-(--pos-s-surface-2)' : 'border-(--pos-s-border) bg-(--pos-s-surface-2) text-(--pos-s-fg) active:bg-(--pos-s-surface-2)'}`}>
              {t('appointments.modal.cancel', 'Cancel')}
            </button>
            {/* Create = solid yellow primary, with a clear disabled state */}
            <button
              onClick={handleCreateAppointment}
              disabled={isSubmitting || !formData.staffId || !formData.serviceId || !formData.startTime}
              className="pos-raised pos-raised--yellow min-h-touch px-5 py-2.5 rounded-xl font-semibold bg-(--pos-s-yellow) text-black border border-(--pos-s-yellow) shadow-xs transition-transform duration-150 active:scale-95 active:bg-yellow-500 disabled:bg-(--pos-s-surface-2) disabled:text-(--pos-s-muted) disabled:border-(--pos-s-border) disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {isSubmitting ? t('appointments.modal.creating', 'Creating...') : t('appointments.modal.create', 'Create')}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default AppointmentsView;
