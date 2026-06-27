/**
 * AppointmentsView - POS Today's Appointments
 * 
 * Real-time appointment management for salon POS.
 * Supports check-in functionality and quick status updates.
 * 
 * Task 17.2: Create POS appointments interface
 */

import React, { memo, useState, useMemo, useEffect, useCallback, useId, useRef } from 'react';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useAppointments } from '../../../hooks/useAppointments';
import { formatDate, formatTime } from '../../../utils/format';
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
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

type ViewMode = 'timeline' | 'list';
type QuickFilter = 'today' | 'tomorrow' | 'week';

const statusConfig: Record<AppointmentStatus, { label: string; border: string; chip: string }> = {
  scheduled: {
    label: 'Scheduled',
    border: 'border-l-amber-400',
    chip: 'border border-amber-500/30 bg-amber-500/10 text-amber-500',
  },
  confirmed: {
    label: 'Confirmed',
    border: 'border-l-emerald-500',
    chip: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  },
  in_progress: {
    label: 'In Progress',
    border: 'border-l-yellow-400',
    chip: 'border border-yellow-500/30 bg-yellow-500/10 text-yellow-500',
  },
  completed: {
    label: 'Completed',
    border: 'border-l-zinc-400',
    chip: 'border border-zinc-500/30 bg-zinc-500/10 text-zinc-500',
  },
  cancelled: {
    label: 'Cancelled',
    border: 'border-l-red-500',
    chip: 'border border-red-500/30 bg-red-500/10 text-red-500',
  },
  no_show: {
    label: 'No Show',
    border: 'border-l-red-500',
    chip: 'border border-red-500/30 bg-red-500/10 text-red-500',
  },
};

interface AppointmentsViewProps {
  /** Rendered inside the Orders hub: hides the internal FAB (the hub owns New Order). */
  embedded?: boolean;
  /** Bump to open the Create Appointment modal from the hub New Order -> Services flow. */
  openCreateSignal?: number;
}

export const AppointmentsView: React.FC<AppointmentsViewProps> = memo(({
  embedded = false,
  openCreateSignal = 0,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  
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
  const [staffList, setStaffList] = useState<{ id: string; name: string }[]>([]);
  const [servicesList, setServicesList] = useState<{ id: string; name: string; duration: number }[]>([]);
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
  }, [bridge, branchId, effectiveOrgId, formData.date, t]);

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
    const baseFilters: AppointmentFilters = {};

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
    complete,
  } = useAppointments({
    branchId: branchId || '',
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
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

      // Build start and end times
      const [hours, minutes] = formData.startTime.split(':').map(Number);
      const startDate = new Date(formData.date);
      startDate.setHours(hours, minutes, 0, 0);

      const endDate = new Date(startDate);
      endDate.setMinutes(endDate.getMinutes() + duration);

      const availabilityResult = isBrowser()
        ? await posApiGet<{
            success?: boolean;
            available?: Array<{ staffId?: string; isAvailable?: boolean }>;
            unavailable?: Array<{ staffId?: string; reason?: string }>;
            error?: string;
          }>(
            `/api/pos/staff-schedule/check?start_time=${encodeURIComponent(startDate.toISOString())}&end_time=${encodeURIComponent(endDate.toISOString())}&staff_id=${encodeURIComponent(formData.staffId)}&service_id=${encodeURIComponent(formData.serviceId)}`,
          )
        : await bridge.staffSchedule.checkAvailability({
            start_time: startDate.toISOString(),
            end_time: endDate.toISOString(),
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
        toast.error(unavailableReason);
        return;
      }

      await createAppointment({
        customerId: formData.customerId || undefined,
        customerName: formData.customerName || undefined,
        customerPhone: formData.customerPhone || undefined,
        staffId: formData.staffId,
        serviceId: formData.serviceId,
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString(),
        notes: formData.notes || undefined,
      });

      // Reset form and close modal
      setFormData({
        customerId: '',
        customerName: '',
        customerPhone: '',
        customerEmail: '',
        staffId: '',
        serviceId: '',
        date: toLocalDateStr(new Date()),
        startTime: '',
        notes: '',
      });
      setSelectedCustomer(null);
      setShowCreateModal(false);

      // Refresh to show new appointment
      refetch();
    } catch (err) {
      console.error('[AppointmentsView] Failed to create appointment:', err);
    } finally {
      setIsSubmitting(false);
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

    if (appointment.status === 'scheduled' || appointment.status === 'confirmed') {
      actions.push({
        label: t('appointments.actions.checkIn', 'Check In'),
        action: () => checkIn(appointment.id),
        variant: 'primary',
        icon: Play,
      });
    }
    if (appointment.status === 'in_progress') {
      actions.push({
        label: t('appointments.actions.complete', 'Complete'),
        action: () => complete(appointment.id),
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
      const hour = new Date(apt.startTime).getHours();
      if (grouped[hour]) {
        grouped[hour].push(apt);
      }
    });
    
    return grouped;
  }, [appointments, timeSlots]);

  if (!branchId || !effectiveOrgId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'bg-black text-zinc-400' : 'bg-[#fdfaf5] text-gray-500'}`}>
        {t('appointments.selectBranch', 'Please select a branch to view appointments')}
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col p-4 ${isDark ? 'bg-black text-zinc-100' : 'bg-[#fdfaf5] text-gray-900'}`}>
      <motion.section
        variants={pageMotionItem}
        data-vertical-hero="appointments"
        className={`mb-4 rounded-3xl border p-4 backdrop-blur-xl ${isDark ? 'border-white/10 bg-zinc-950/72 shadow-[0_18px_46px_rgba(0,0,0,0.35)]' : 'border-yellow-200/80 bg-white/74 shadow-[0_18px_44px_rgba(15,23,42,0.10)]'}`}
      >
        <div className="mb-4 min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight">
            {t('navigation.menu.appointments', { defaultValue: 'Appointments' })}
          </h1>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <motion.div variants={pageMotionContainer} className="flex flex-wrap gap-3">
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border ${isDark ? 'bg-zinc-950/80 border-zinc-800' : 'bg-white/86 border-gray-200 shadow-sm'}`}>
              <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('appointments.stats.total', 'Total')}</div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.total}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border border-t-2 ${isDark ? 'bg-zinc-950/80 border-zinc-800 border-t-emerald-400' : 'bg-white/86 border-gray-200 border-t-emerald-500 shadow-sm'}`}>
              <div className="text-sm text-green-500">{t('appointments.stats.confirmed', 'Confirmed')}</div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.confirmed}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border border-t-2 ${isDark ? 'bg-zinc-950/80 border-zinc-800 border-t-amber-400' : 'bg-white/86 border-gray-200 border-t-amber-500 shadow-sm'}`}>
              <div className="text-sm text-yellow-500">{t('appointments.stats.inProgress', 'In Progress')}</div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.inProgress}</div>
            </motion.div>
            <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl border ${isDark ? 'bg-zinc-950/80 border-zinc-800' : 'bg-white/86 border-gray-200 shadow-sm'}`}>
              <div className="text-sm text-gray-500">{t('appointments.stats.completed', 'Completed')}</div>
              <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.completed}</div>
            </motion.div>
          </motion.div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => refetch()}
              aria-label={t('common.refresh', 'Refresh')}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition active:scale-95 ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-300 active:bg-zinc-800' : 'bg-gray-100 border-gray-300 text-gray-700 active:bg-gray-200'}`}
            >
              <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <div className="relative">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t('appointments.searchPlaceholder', 'Search...')}
                className={`pl-10 pr-4 py-2 rounded-xl border ${isDark ? 'bg-zinc-900 text-zinc-100 border-zinc-700' : 'bg-white text-gray-900 border-gray-200'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
              />
            </div>
          </div>
        </div>
      </motion.section>

      {/* Filters Row */}
      <motion.div variants={pageMotionItem} className="flex items-center justify-between mb-4">
        <motion.div variants={pageMotionContainer} className="flex gap-2">
          {(['today', 'tomorrow', 'week'] as QuickFilter[]).map(filter => (
            <motion.button
              variants={pageMotionItem}
              key={filter}
              onClick={() => handleQuickFilter(filter)}
              className={`px-3 py-1.5 rounded-xl text-sm ${
                quickFilter === filter
                  ? 'bg-yellow-400 text-black border border-yellow-400'
                  : isDark ? 'bg-gray-800 text-gray-300 active:bg-gray-700' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
              }`}
            >
              {t(`appointments.filters.${filter}`, filter.charAt(0).toUpperCase() + filter.slice(1))}
            </motion.button>
          ))}
        </motion.div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => navigateDate('prev')} aria-label={t('appointments.previousDay', 'Previous day')} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition active:scale-95 ${isDark ? 'active:bg-gray-800' : 'active:bg-gray-100'}`}>
            <ChevronLeft className="w-5 h-5" />
          </button>
          <input
            type="date"
            value={toLocalDateStr(selectedDate)}
            onChange={(e) => {
              // Parse date string as local date (not UTC)
              const [year, month, day] = e.target.value.split('-').map(Number);
              const newDate = new Date(year, month - 1, day);
              console.log('[AppointmentsView] Date changed to:', newDate, 'from value:', e.target.value);
              setSelectedDate(newDate);
              // Reset quick filter when manually selecting date
              setQuickFilter('today');
            }}
            className={`px-3 py-2 rounded-xl ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          />
          <button type="button" onClick={() => navigateDate('next')} aria-label={t('appointments.nextDay', 'Next day')} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition active:scale-95 ${isDark ? 'active:bg-gray-800' : 'active:bg-gray-100'}`}>
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2">
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            className={`px-3 py-2 rounded-xl ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          >
            <option value="all">{t('appointments.filters.allStaff', 'All Staff')}</option>
            {filterStaffOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className={`flex rounded-xl overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
            {(['timeline', 'list'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-2 text-sm ${viewMode === mode ? 'bg-yellow-400 text-black border border-yellow-400' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
              >
                {t(`appointments.view.${mode}`, mode.charAt(0).toUpperCase() + mode.slice(1))}
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Loading State */}
      {isLoading && appointments.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('appointments.loading', 'Loading appointments...')}
        </motion.div>
      )}

      {/* Content */}
      {!isLoading && (
        <motion.div variants={pageMotionItem} className="flex-1 overflow-hidden">
          {viewMode === 'timeline' ? (
            <motion.div variants={pageMotionContainer} className="h-full overflow-y-auto scrollbar-hide">
              <div className="grid grid-cols-[60px_1fr] gap-2">
                {timeSlots.map(hour => {
                  const hourAppointments = appointmentsByHour[hour] || [];
                  return (
                    <React.Fragment key={hour}>
                      <div className={`text-sm font-medium py-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {hour}:00
                      </div>
                      <div className={`min-h-[60px] p-2 rounded-2xl ${isDark ? 'bg-gray-800/50' : 'bg-gray-50'}`}>
                        <div className="flex flex-wrap gap-2">
                          {hourAppointments.map(apt => (
                            <motion.div
                              variants={pageMotionItem}
                              key={apt.id}
                              className={`px-3 py-2 rounded-2xl border-l-4 ${statusConfig[apt.status].border} ${
                                isDark ? 'bg-gray-700' : 'bg-white shadow-sm'
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
                              <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
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
                                        action.variant === 'success' ? 'bg-green-600 text-white' :
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
                    isDark ? 'bg-gray-800' : 'bg-white shadow-sm'
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
                          {formatTime(apt.startTime, { hour: '2-digit', minute: '2-digit' })}
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
                              action.variant === 'success' ? 'bg-green-600 text-white active:bg-green-700' :
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
            <motion.div variants={pageMotionItem} className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">{t('appointments.noAppointments', { defaultValue: 'No appointments found' })}</p>
              <p className="text-sm">{t('appointments.noAppointmentsHint', { defaultValue: 'Try selecting a different date or adjusting your filters' })}</p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* Floating Action Button - hidden when embedded in the Orders hub (the hub owns New Order). */}
      {!embedded && !showCreateModal && !showCustomerSearch && (
        <FloatingActionButton
          onClick={() => setShowCreateModal(true)}
          aria-label={t('appointments.newAppointment', { defaultValue: 'New Appointment' })}
          className="!bottom-20 sm:!bottom-6"
        />
      )}

      {/* Create Appointment Modal */}
      {showCreateModal && (
        <CreateAppointmentModalContent
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
              date: toLocalDateStr(new Date()),
              startTime: '',
              notes: '',
            });
          }}
          branchId={branchId || ''}
          organizationId={effectiveOrgId}
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
        className={`flex w-full items-center gap-2 min-h-[44px] px-3.5 py-2.5 rounded-xl border text-sm text-left transition active:scale-[0.99] focus:outline-none ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100 active:bg-zinc-900 focus:ring-2 focus:ring-zinc-600' : 'bg-white border-gray-300 text-gray-900 active:bg-gray-50 focus:ring-2 focus:ring-gray-300'}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? '' : (isDark ? 'text-zinc-500' : 'text-gray-400')}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''} ${isDark ? 'text-zinc-400' : 'text-gray-500'}`} />
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
                  className={`flex w-full items-center gap-2 min-h-[44px] rounded-xl px-3 py-2 text-sm text-left transition ${
                    isSelected
                      ? 'bg-yellow-400 text-black'
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
  const [existingAppointments, setExistingAppointments] = useState<{ staffId: string; startTime: string; endTime: string; status: string }[]>([]);
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

  // Fetch appointments for selected day
  useEffect(() => {
    const fetchDayAppointments = async () => {
      if (!selectedDay || !branchId) return;
      setLoadingSlots(true);
      try {
        const yyyy = selectedDay.getFullYear();
        const mm = String(selectedDay.getMonth() + 1).padStart(2, '0');
        const dd = String(selectedDay.getDate()).padStart(2, '0');
        const date = `${yyyy}-${mm}-${dd}`;

        const result = isBrowser()
          ? await posApiGet<{ success?: boolean; appointments?: any[]; error?: string }>(
              `/api/pos/appointments?date=${encodeURIComponent(date)}${formData.staffId ? `&staff_id=${encodeURIComponent(formData.staffId)}` : ''}`,
            )
          : await bridge.appointments.list({
              date,
              staff_id: formData.staffId || undefined,
            });

        if (!result.success) {
          throw new Error(result.error || 'Failed to fetch appointments for selected day');
        }

        const payload = (result.data ?? {}) as {
          success?: boolean;
          appointments?: Array<{
            staff_id: string;
            start_time: string;
            end_time: string;
            status: string;
          }>;
          error?: string;
        };

        if (payload.success === false) {
          throw new Error(payload.error || 'Failed to fetch appointments for selected day');
        }

        const rows = Array.isArray(payload.appointments) ? payload.appointments : [];
        setExistingAppointments(
          rows
            .filter((appointment) => !['cancelled', 'no_show'].includes(appointment.status))
            .map((appointment) => ({
              staffId: appointment.staff_id,
              startTime: appointment.start_time,
              endTime: appointment.end_time,
              status: appointment.status,
            })),
        );
      } catch (err) {
        console.error('Failed to fetch day appointments:', err);
      } finally {
        setLoadingSlots(false);
      }
    };
    fetchDayAppointments();
  }, [selectedDay, branchId, bridge, formData.staffId]);

  // Check if time slot is booked
  const isTimeSlotBooked = (time: string): boolean => {
    if (!selectedDay || !formData.staffId) return false;
    const service = servicesList.find(s => s.id === formData.serviceId);
    const duration = service?.duration || 30;
    
    const [h, m] = time.split(':').map(Number);
    const slotStart = new Date(selectedDay);
    slotStart.setHours(h, m, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
    
    return existingAppointments.some(apt => {
      if (apt.staffId !== formData.staffId) return false;
      const aptStart = new Date(apt.startTime);
      const aptEnd = new Date(apt.endTime);
      return slotStart < aptEnd && slotEnd > aptStart;
    });
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

  return renderModalPortal(
    <div className={`fixed inset-0 z-[1000] flex items-center justify-center backdrop-blur-xl p-3 sm:p-6 ${isDark ? 'bg-black/55' : 'bg-black/22'}`}>
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        className={`w-full max-w-6xl rounded-3xl border ring-1 shadow-[0_30px_90px_rgba(0,0,0,0.55)] max-h-[calc(100%-1.5rem)] sm:max-h-[calc(100%-3rem)] flex flex-col overflow-hidden ${isDark ? 'bg-zinc-950/55 backdrop-blur-2xl border-white/10 ring-white/10' : 'bg-white/18 backdrop-blur-2xl border-white/70 ring-white/45'}`}
      >
        {/* Header */}
        <div className={`flex items-start justify-between px-4 sm:px-6 py-4 border-b shrink-0 ${isDark ? 'border-white/10 bg-zinc-950/25' : 'border-white/40 bg-white/12'}`}>
          <div>
            <h2 id={titleId} className={`text-lg sm:text-xl font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
              {t('appointments.modal.title', 'New Appointment')}
            </h2>
            <p className={`text-xs sm:text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
              {selectedDay && formData.startTime
                ? `${formatDate(selectedDay)} - ${formData.startTime}`
                : t('appointments.modal.phoneSearchLabel', 'Search Customer by Phone')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.actions.close', 'Close')}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition active:scale-95 ${isDark ? 'bg-zinc-900/70 border-white/10 text-zinc-300 active:bg-zinc-800' : 'bg-white/25 border-white/65 text-gray-800 active:bg-white/45'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — min-h-0 lets this flex child shrink and scroll so the sticky footer always keeps
            its reserved space and nothing (availability guidance / time slots) is clipped at short
            viewport heights (e.g. 1282x802). */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 min-h-0 scrollbar-hide">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 sm:gap-5">
            <div className="xl:col-span-5 space-y-3">
              <p className={`text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-gray-600'}`}>
                {t('appointments.modal.sections.guestService', 'Customer & Service')}
              </p>
          {/* Customer Selection */}
          <div className={`rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/35 backdrop-blur-xl border-white/10' : 'bg-white/14 backdrop-blur-xl border-white/50'}`}>
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
              <User className="w-4 h-4 inline mr-1" /> {t('appointments.modal.customer', 'Customer')}
            </label>

            {selectedCustomer ? (
              /* Selected customer card */
              <div className={`p-3 rounded-xl border ${selectedCustomer.is_banned ? (isDark ? 'bg-red-500/10 border-red-500/30' : 'bg-red-50 border-red-200') : (isDark ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200')}`}>
                {selectedCustomer.is_banned && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <Ban className="w-4 h-4 text-red-500" />
                    <span className="text-xs font-semibold text-red-500 uppercase">{t('appointments.modal.bannedCustomer', 'Banned Customer')}</span>
                    {selectedCustomer.ban_reason && <span className="text-xs text-red-400">— {selectedCustomer.ban_reason}</span>}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <p className={`font-semibold ${selectedCustomer.is_banned ? 'text-red-400' : (isDark ? 'text-emerald-300' : 'text-emerald-700')}`}>{selectedCustomer.name}</p>
                    <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>{selectedCustomer.phone}</p>
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
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={onSearchCustomer}
                  className={`w-full px-4 py-2.5 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 active:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 active:bg-gray-100'}`}
                >
                  <Search className="w-4 h-4" />
                  {t('appointments.modal.searchCustomer', 'Search Customer')}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={formData.customerName}
                    onChange={(e) => setFormData(prev => ({ ...prev, customerName: e.target.value }))}
                    placeholder={t('appointments.modal.walkInName', 'Walk-in name')}
                    className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
                  />
                  <input
                    type="tel"
                    value={formData.customerPhone}
                    onChange={(e) => setFormData(prev => ({ ...prev, customerPhone: e.target.value }))}
                    placeholder={t('appointments.modal.walkInPhone', 'Phone')}
                    className={`px-3 py-2 rounded-xl border text-sm ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Staff & Service — Round 308: native <select> replaced with the touch-first GlassSelect
              listbox so the dropdown stays inside the glass modal (no OS/WebView grey strip).
              Round 333: this card's backdrop-blur makes it its own stacking context, and the Notes card
              below (also backdrop-blur) was painting OVER an open listbox. Lift this card (relative z-20)
              above Notes (z-10) and keep overflow visible so the open dropdown overlays the panels below. */}
          <div data-appointment-staff-service className={`relative z-20 overflow-visible grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/35 backdrop-blur-xl border-white/10' : 'bg-white/14 backdrop-blur-xl border-white/50'}`}>
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

          {/* Notes — moved to the left column (Round 279) so it is not clipped by the sticky footer
              under the overloaded Date/Time column; the left column had spare vertical space. Round 333:
              kept at a LOWER stacking level (relative z-10) than the Staff & Service card (z-20) so an open
              GlassSelect listbox overlays Notes instead of rendering behind it. */}
          <div className={`relative z-10 rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/35 backdrop-blur-xl border-white/10' : 'bg-white/14 backdrop-blur-xl border-white/50'}`}>
            <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
              {t('appointments.modal.notesLabel', 'Notes')}
            </label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder={t('appointments.modal.notesPlaceholder', 'Optional notes...')}
              rows={3}
              className={`w-full px-3.5 py-2.5 rounded-xl border text-sm resize-none ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
            />
          </div>

            </div>
            <div className="xl:col-span-7 space-y-3">
              <p className={`text-xs font-semibold ${isDark ? 'text-zinc-300' : 'text-gray-600'}`}>
                {t('appointments.modal.sections.dateTime', 'Date & Time')}
              </p>
          {/* Date & Time grid — Calendar | Time Slots sit side-by-side on xl/desktop so the first
              time-slot row is visible in the first viewport (not pushed below the calendar/footer).
              Stacked on mobile/tablet. */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {/* Calendar */}
          <div className={`p-3 rounded-2xl border ${isDark ? 'bg-zinc-900/35 backdrop-blur-xl border-white/10' : 'bg-white/14 backdrop-blur-xl border-white/50'}`}>
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1))}
                aria-label={t('appointments.modal.previousMonth', 'Previous month')}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition active:scale-95 ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 active:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 active:bg-gray-100'}`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className={`font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{formatDate(calendarDate, { month: 'long', year: 'numeric' })}</span>
              <button
                type="button"
                onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1))}
                aria-label={t('appointments.modal.nextMonth', 'Next month')}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl border transition active:scale-95 ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 active:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 active:bg-gray-100'}`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-1.5">
              {weekDays.map((d, i) => <div key={i} className={`text-center text-xs py-1 ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map((day, idx) => {
                const isCurrentMonth = day.getMonth() === calendarDate.getMonth();
                const isSelected = selectedDay?.toDateString() === day.toDateString();
                const isToday = day.toDateString() === new Date().toDateString();
                const isPast = day < new Date(new Date().setHours(0, 0, 0, 0));
                return (
                  <button
                    key={idx}
                    type="button"
                    disabled={isPast}
                    onClick={() => handleDateSelect(day)}
                    className={`h-9 rounded-xl text-sm transition-all border
                      ${!isCurrentMonth ? (isDark ? 'text-zinc-600' : 'text-gray-400') : ''}
                      ${isPast
                        ? (isDark ? 'text-zinc-700 border-zinc-800 bg-zinc-900/40 cursor-not-allowed' : 'text-gray-300 border-gray-200 bg-gray-100 cursor-not-allowed')
                        : (isDark ? 'border-zinc-800 active:bg-zinc-800/80' : 'border-gray-200 active:bg-gray-100')}
                      ${isSelected ? 'bg-yellow-400 text-black border-yellow-400' : ''}
                      ${isToday && !isSelected ? (isDark ? 'ring-1 ring-zinc-500' : 'ring-1 ring-gray-400') : ''}
                    `}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time Slots — Round 307: before BOTH staff and service are chosen we show a friendly warm-glass
              empty state with a Staff/Service checklist (NOT a grid of disabled times, which read like broken
              availability). Once both exist, the real period buttons + available/booked slots render. */}
          {!hasStaffAndService ? (
            <div
              data-appointment-slots-empty
              className={`flex flex-col items-center justify-center gap-3 p-6 text-center rounded-2xl border ${isDark ? 'bg-amber-500/[0.06] backdrop-blur-md border-amber-400/20' : 'bg-amber-50/60 backdrop-blur-xl border-amber-200/70'}`}
            >
              <div className={`flex h-12 w-12 items-center justify-center rounded-2xl border ${isDark ? 'bg-amber-500/15 border-amber-400/30 text-amber-300' : 'bg-amber-100/80 border-amber-200 text-amber-600'}`}>
                <Clock className="h-6 w-6" />
              </div>
              <div>
                <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
                  {t('appointments.modal.slotsEmpty.title', 'Pick staff and service first')}
                </p>
                <p className={`mt-1 text-xs leading-5 ${isDark ? 'text-zinc-400' : 'text-gray-600'}`}>
                  {t('appointments.modal.slotsEmpty.help', 'Choose a staff member and a service first, then the real available times show up here.')}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {([
                  { key: 'staff', done: Boolean(formData.staffId), label: t('appointments.modal.slotsEmpty.staffStep', 'Staff'), Icon: User },
                  { key: 'service', done: Boolean(formData.serviceId), label: t('appointments.modal.slotsEmpty.serviceStep', 'Service'), Icon: Scissors },
                ] as const).map(step => {
                  const StepIcon = step.Icon;
                  return (
                    <span
                      key={step.key}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                        step.done
                          ? (isDark ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-700')
                          : (isDark ? 'bg-white/[0.04] border-white/15 text-zinc-400' : 'bg-white/50 border-gray-200 text-gray-500')
                      }`}
                    >
                      {step.done ? <CheckCircle className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                      {step.label}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : selectedDay ? (
            <div className={`p-3 rounded-2xl border space-y-2.5 ${isDark ? 'bg-zinc-900/35 backdrop-blur-xl border-white/10' : 'bg-white/14 backdrop-blur-xl border-white/50'}`}>
              <div className="grid grid-cols-3 gap-2">
                {(['morning', 'afternoon', 'evening'] as const).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTimePeriod(p)}
                    className={`py-2 text-xs sm:text-sm rounded-xl border font-medium transition-all ${
                      timePeriod === p
                        ? 'bg-yellow-400 text-black border-yellow-400'
                        : (isDark ? 'bg-zinc-950 text-zinc-300 border-zinc-700 active:bg-zinc-800' : 'bg-white text-gray-700 border-gray-300 active:bg-gray-100')
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

              {loadingSlots && <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{t('appointments.modal.loadingSlots', 'Loading...')}</p>}

              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 xl:grid-cols-5 gap-2 max-h-56 overflow-y-auto pr-1 scrollbar-hide">
                {timeSlots.map(slot => {
                  const booked = isTimeSlotBooked(slot);
                  const selected = formData.startTime === slot;
                  return (
                    <button
                      key={slot}
                      type="button"
                      disabled={booked}
                      onClick={() => handleTimeSelect(slot)}
                      className={`flex items-center justify-center min-h-[44px] py-2 px-2 text-xs sm:text-sm rounded-xl border relative transition-all
                        ${selected
                          ? 'bg-yellow-400 text-black border-yellow-400'
                          : booked
                            ? (isDark ? 'bg-red-500/10 border-red-500/30 text-red-300 line-through cursor-not-allowed' : 'bg-red-50 border-red-200 text-red-500 line-through cursor-not-allowed')
                            : (isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 active:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 active:bg-gray-100')}
                      `}
                    >
                      {slot}
                      {booked && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
                    </button>
                  );
                })}
              </div>

              <div className={`flex gap-4 text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>
                <span className="flex items-center gap-1"><span className={`w-3 h-3 rounded border ${isDark ? 'bg-zinc-800 border-zinc-600' : 'bg-white border-gray-300'}`} /> {t('appointments.modal.availability.available', 'Available')}</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-red-100 border border-red-200 rounded" /> {t('appointments.modal.availability.booked', 'Booked')}</span>
              </div>
            </div>
          ) : null}
          </div>

          {/* Summary */}
          {formData.startTime && selectedService && selectedDay && (
            <div className={`p-4 rounded-2xl border backdrop-blur-md ${isDark ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-emerald-50/70 border-emerald-200'}`}>
              <div className="flex items-center justify-between text-sm">
                <span className={isDark ? 'text-zinc-300' : 'text-gray-600'}>{formatDate(selectedDay)}</span>
                <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{formData.startTime}</span>
                <span className={isDark ? 'text-zinc-500' : 'text-gray-400'}>→</span>
                <span className={`font-semibold ${isDark ? 'text-zinc-200' : 'text-gray-800'}`}>
                  {(() => {
                    const [h, m] = formData.startTime.split(':').map(Number);
                    const end = new Date(selectedDay);
                    end.setHours(h, m + selectedService.duration, 0, 0);
                    return formatTime(end, { hour: '2-digit', minute: '2-digit' });
                  })()}
                </span>
                <span className={isDark ? 'text-zinc-500' : 'text-gray-500'}>({selectedService.duration}{t('common.minutes', 'min')})</span>
              </div>
            </div>
          )}
            </div>
          </div>
        </div>

        {/* Footer — sticky glass bar; reserved by the flex column so it never overlaps the body. */}
        <div className={`px-4 sm:px-6 py-4 border-t shrink-0 backdrop-blur-xl ${isDark ? 'border-white/10 bg-zinc-950/55' : 'border-white/40 bg-white/14'}`}>
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
          {/* Cancel = soft destructive red */}
          <button onClick={onClose} className={`px-5 py-2.5 rounded-xl font-medium border transition-transform duration-150 active:scale-95 ${isDark ? 'border-red-500/40 bg-red-500/10 text-red-300 active:bg-red-500/20' : 'border-red-300 bg-red-50 text-red-700 active:bg-red-100'}`}>
            {t('appointments.modal.cancel', 'Cancel')}
          </button>
          {/* Create = green primary, with a clear disabled state */}
          <button
            onClick={handleCreateAppointment}
            disabled={isSubmitting || !formData.staffId || !formData.serviceId || !formData.startTime}
            className="px-5 py-2.5 rounded-xl font-semibold bg-emerald-600 text-white border border-emerald-500 shadow-sm shadow-emerald-600/30 transition-transform duration-150 active:scale-95 active:bg-emerald-700 disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
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
