/**
 * AppointmentsView - POS Today's Appointments
 * 
 * Real-time appointment management for salon POS.
 * Supports check-in functionality and quick status updates.
 * 
 * Task 17.2: Create POS appointments interface
 */

import React, { memo, useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useAppointments } from '../../../hooks/useAppointments';
import { formatDate, formatTime } from '../../../utils/format';
import { Calendar, Clock, User, Scissors, Search, ChevronLeft, ChevronRight, RefreshCw, CheckCircle, Play, XCircle, X, Plus, Ban } from 'lucide-react';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
import { CustomerSearchModal } from '../../../components/modals/CustomerSearchModal';
import { supabase } from '../../../lib/supabase';
import type { Appointment, AppointmentStatus, AppointmentFilters } from '../../../services/AppointmentsService';

type ViewMode = 'timeline' | 'list';
type QuickFilter = 'today' | 'tomorrow' | 'week';

const statusConfig: Record<AppointmentStatus, { color: string; label: string }> = {
  scheduled: { color: 'blue', label: 'Scheduled' },
  confirmed: { color: 'green', label: 'Confirmed' },
  in_progress: { color: 'yellow', label: 'In Progress' },
  completed: { color: 'gray', label: 'Completed' },
  cancelled: { color: 'red', label: 'Cancelled' },
  no_show: { color: 'red', label: 'No Show' },
};

export const AppointmentsView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  
  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  // Load config from multiple sources (same pattern as RoomsView)
  useEffect(() => {
    const loadConfig = async () => {
      let bid = localStorage.getItem('branch_id');
      let oid = localStorage.getItem('organization_id');
      
      if ((!bid || !oid) && window.electron?.ipcRenderer) {
        try {
          // Try direct IPC calls first
          if (!bid) {
            const branchResult = await window.electron.ipcRenderer.invoke('terminal-config:get-branch-id');
            if (branchResult) {
              bid = branchResult;
              localStorage.setItem('branch_id', bid as string);
            }
          }
          if (!oid) {
            const orgResult = await window.electron.ipcRenderer.invoke('terminal-config:get-organization-id');
            if (orgResult) {
              oid = orgResult;
              localStorage.setItem('organization_id', oid as string);
            }
          }
          // Fallback to full settings object
          if (!bid || !oid) {
            const settings = await window.electron.ipcRenderer.invoke('terminal-config:get-settings');
            if (!bid) {
              bid = settings?.['terminal.branch_id'] || settings?.terminal?.branch_id || null;
              if (bid) localStorage.setItem('branch_id', bid);
            }
            if (!oid) {
              oid = settings?.['terminal.organization_id'] || settings?.terminal?.organization_id || null;
              if (oid) localStorage.setItem('organization_id', oid);
            }
          }
        } catch (err) {
          console.warn('[AppointmentsView] Failed to get terminal config:', err);
        }
      }
      
      console.log('[AppointmentsView] Loaded config - branchId:', bid, 'orgId:', oid);
      setBranchId(bid);
      setLocalOrgId(oid);
    };
    
    loadConfig();
    
    // Listen for config updates
    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
      console.log('[AppointmentsView] Config updated:', data);
      if (data.branch_id) {
        setBranchId(data.branch_id);
        localStorage.setItem('branch_id', data.branch_id);
      }
      if (data.organization_id) {
        setLocalOrgId(data.organization_id);
        localStorage.setItem('organization_id', data.organization_id);
      }
    };
    
    window.electron?.ipcRenderer?.on('terminal-config-updated', handleConfigUpdate);
    return () => {
      window.electron?.ipcRenderer?.removeListener('terminal-config-updated', handleConfigUpdate);
    };
  }, []);

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('timeline');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('today');
  const [staffFilter, setStaffFilter] = useState<string>('all');
  
  // Create appointment modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
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
    startTime: '09:00',
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
        let resolvedStaff: { id: string; name: string }[] = [];
        let resolvedServices: { id: string; name: string; duration: number }[] = [];

        const invoke =
          (window as any)?.electronAPI?.invoke ||
          (window as any)?.electronAPI?.ipcRenderer?.invoke ||
          (window as any)?.electron?.ipcRenderer?.invoke ||
          null;

        // Prefer terminal-authenticated admin APIs in Electron.
        if (invoke) {
          let staffRows: any[] = [];

          // Primary: existing IPC handler used by shift check-in (very stable path).
          if (branchId) {
            const staffRpc = await invoke('shift:list-staff-for-checkin', branchId);
            const rpcPayload = staffRpc?.data ?? staffRpc;
            const rpcRows = Array.isArray(rpcPayload?.data)
              ? rpcPayload.data
              : Array.isArray(rpcPayload)
                ? rpcPayload
                : [];
            if (staffRpc?.success !== false) {
              staffRows = rpcRows;
            } else {
              console.warn('[AppointmentsView] shift:list-staff-for-checkin failed:', staffRpc?.error || staffRpc);
            }
          }

          // Secondary: POS sync API (requires admin route whitelist).
          if (!staffRows.length) {
            const staffResp = await invoke('api:fetch-from-admin', '/api/pos/sync/staff?limit=1000');
            const payload = staffResp?.data ?? staffResp;
            const payloadSuccess = payload?.success !== false;
            if (staffResp?.success !== false && payloadSuccess) {
              staffRows = Array.isArray(payload?.data) ? payload.data : [];
            } else {
              console.warn('[AppointmentsView] Staff sync API failed:', staffResp?.error || payload?.error || staffResp);
            }
          }

          resolvedStaff = (staffRows || [])
            .filter((s: any) => {
              const active = s?.is_active ?? s?.isActive ?? s?.active;
              const canPos = s?.can_login_pos ?? s?.canLoginPos ?? true;
              return active !== false && canPos !== false;
            })
            .map((s: any) => {
              const fullName =
                `${s?.first_name ?? s?.firstName ?? ''} ${s?.last_name ?? s?.lastName ?? ''}`.trim() ||
                s?.name ||
                s?.full_name ||
                s?.fullName ||
                s?.display_name ||
                '';
              return {
                id: String(s?.id ?? ''),
                name: fullName || 'Staff',
              };
            })
            .filter((s: { id: string; name: string }) => !!s.id);

          if (resolvedStaff.length) {
            setStaffList(resolvedStaff);
          }

          let serviceRows: any[] = [];
          const servicesResp = await invoke('api:fetch-from-admin', '/api/pos/services?is_active=true');
          if (servicesResp?.success && servicesResp?.data?.success !== false) {
            serviceRows = Array.isArray(servicesResp?.data?.services) ? servicesResp.data.services : [];
          } else {
            const fallback = await invoke('api:fetch-from-admin', '/api/pos/sync/services?limit=1000');
            if (fallback?.success && fallback?.data?.success !== false) {
              serviceRows = Array.isArray(fallback?.data?.data) ? fallback.data.data : [];
            } else {
              console.warn('[AppointmentsView] Services API failed:', fallback?.error || fallback?.data?.error || fallback);
            }
          }

          resolvedServices = (serviceRows || [])
            .filter((s: any) => {
              const active = s?.is_active ?? s?.isActive ?? s?.active;
              const status = s?.status;
              const rowBranch = s?.branch_id ?? s?.branchId ?? null;
              return active !== false && status !== 'inactive' && (!rowBranch || !branchId || rowBranch === branchId);
            })
            .map((s: any) => ({
              id: String(s?.id ?? ''),
              name: s?.name || s?.title || 'Service',
              duration: Number(s?.duration_minutes ?? s?.duration ?? s?.durationMinutes ?? 30) || 30,
            }))
            .filter((s: { id: string; name: string; duration: number }) => !!s.id);

          if (resolvedServices.length) {
            setServicesList(resolvedServices);
          }

          // If both loaded, we're done.
          if (resolvedStaff.length > 0 && resolvedServices.length > 0) {
            return;
          }
        }

        // Fallback path (or fill missing lists) via direct Supabase.
        const { data: staffData, error: staffError } = await (supabase as any)
          .from('staff')
          .select('id, first_name, last_name, is_active, can_login_pos')
          .eq('organization_id', effectiveOrgId);

        console.log('[AppointmentsView] Staff query result:', { count: staffData?.length || 0, staffError });

        if (resolvedStaff.length === 0) {
          const fallbackStaff = (staffData || [])
            .filter((s: any) => (s?.is_active ?? true) !== false && (s?.can_login_pos ?? true) !== false)
            .map((s: any) => ({
              id: String(s?.id ?? ''),
              name: `${s?.first_name || ''} ${s?.last_name || ''}`.trim() || 'Staff',
            }))
            .filter((s: { id: string; name: string }) => !!s.id);
          if (fallbackStaff.length) {
            setStaffList(fallbackStaff);
            resolvedStaff = fallbackStaff;
          }
        }

        const { data: servicesData, error: servicesError } = await (supabase as any)
          .from('services')
          .select('id, name, duration_minutes, is_active, status, branch_id')
          .eq('organization_id', effectiveOrgId);

        console.log('[AppointmentsView] Services query result:', { count: servicesData?.length || 0, servicesError });

        if (resolvedServices.length === 0) {
          const fallbackServices = (servicesData || [])
            .filter((s: any) => {
              const active = s?.is_active ?? true;
              const rowBranch = s?.branch_id ?? null;
              return active !== false && s?.status !== 'inactive' && (!rowBranch || !branchId || rowBranch === branchId);
            })
            .map((s: any) => ({
              id: String(s?.id ?? ''),
              name: s?.name || 'Service',
              duration: Number(s?.duration_minutes ?? 30) || 30,
            }))
            .filter((s: { id: string; name: string; duration: number }) => !!s.id);
          if (fallbackServices.length) {
            setServicesList(fallbackServices);
            resolvedServices = fallbackServices;
          }
        }

        // Final fallback for staff from staff already discovered in loaded appointments.
        if (resolvedStaff.length === 0 && staff.length > 0) {
          setStaffList(staff);
          resolvedStaff = staff;
        }
      } catch (err) {
        console.error('[AppointmentsView] Failed to load dropdown data:', err);
      }
    };
    
    if (showCreateModal) {
      loadDropdownData();
    }
  }, [branchId, effectiveOrgId, showCreateModal]);

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
      toast.error('Please select staff and service');
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
        startTime: '09:00',
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
      <div className={`h-full flex items-center justify-center ${isDark ? 'bg-black text-zinc-400' : 'bg-gray-50 text-gray-500'}`}>
        {t('appointments.selectBranch', 'Please select a branch to view appointments')}
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col p-4 ${isDark ? 'bg-black text-zinc-100' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('appointments.stats.total', 'Total')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.total}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-emerald-400' : 'bg-white border-gray-200 border-t-emerald-500 shadow-sm'}`}>
            <div className="text-sm text-green-500">{t('appointments.stats.confirmed', 'Confirmed')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.confirmed}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl border border-t-2 ${isDark ? 'bg-zinc-950 border-zinc-800 border-t-amber-400' : 'bg-white border-gray-200 border-t-amber-500 shadow-sm'}`}>
            <div className="text-sm text-yellow-500">{t('appointments.stats.inProgress', 'In Progress')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.inProgress}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200 shadow-sm'}`}>
            <div className="text-sm text-gray-500">{t('appointments.stats.completed', 'Completed')}</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.completed}</div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className={`p-2 rounded-lg border ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'bg-gray-100 border-gray-300 text-gray-700 hover:bg-gray-200'}`}
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
              className={`pl-10 pr-4 py-2 rounded-lg border ${isDark ? 'bg-zinc-900 text-zinc-100 border-zinc-700' : 'bg-white text-gray-900 border-gray-200'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
            />
          </div>
        </div>
      </div>

      {/* Filters Row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {(['today', 'tomorrow', 'week'] as QuickFilter[]).map(filter => (
            <button
              key={filter}
              onClick={() => handleQuickFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                quickFilter === filter
                  ? 'bg-zinc-100 text-black border border-zinc-300'
                  : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t(`appointments.filters.${filter}`, filter.charAt(0).toUpperCase() + filter.slice(1))}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => navigateDate('prev')} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
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
            className={`px-3 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          />
          <button onClick={() => navigateDate('next')} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2">
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            className={`px-3 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          >
            <option value="all">{t('appointments.filters.allStaff', 'All Staff')}</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className={`flex rounded-lg overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
            {(['timeline', 'list'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-2 text-sm ${viewMode === mode ? 'bg-zinc-100 text-black border border-zinc-300' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
              >
                {t(`appointments.view.${mode}`, mode.charAt(0).toUpperCase() + mode.slice(1))}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && appointments.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('appointments.loading', 'Loading appointments...')}
        </div>
      )}

      {/* Content */}
      {!isLoading && (
        <div className="flex-1 overflow-hidden">
          {viewMode === 'timeline' ? (
            <div className="h-full overflow-y-auto">
              <div className="grid grid-cols-[60px_1fr] gap-2">
                {timeSlots.map(hour => {
                  const hourAppointments = appointmentsByHour[hour] || [];
                  return (
                    <React.Fragment key={hour}>
                      <div className={`text-sm font-medium py-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {hour}:00
                      </div>
                      <div className={`min-h-[60px] p-2 rounded-lg ${isDark ? 'bg-gray-800/50' : 'bg-gray-50'}`}>
                        <div className="flex flex-wrap gap-2">
                          {hourAppointments.map(apt => (
                            <div
                              key={apt.id}
                              className={`px-3 py-2 rounded-lg border-l-4 border-${statusConfig[apt.status].color}-500 ${
                                isDark ? 'bg-gray-700' : 'bg-white shadow-sm'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                  {apt.customerName || 'Walk-in'}
                                </span>
                                <span className={`text-xs px-2 py-0.5 rounded bg-${statusConfig[apt.status].color}-500/10 text-${statusConfig[apt.status].color}-500`}>
                                  {statusConfig[apt.status].label}
                                </span>
                              </div>
                              <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                {apt.serviceName || 'Service'} • {apt.staffName || 'Staff'} • {apt.duration}min
                              </div>
                              <div className="flex gap-1 mt-2">
                                {getQuickActions(apt).slice(0, 2).map((action, idx) => {
                                  const Icon = action.icon;
                                  return (
                                    <button
                                      key={idx}
                                      onClick={action.action}
                                      className={`px-2 py-1 rounded text-xs font-medium flex items-center gap-1 ${
                                        action.variant === 'primary' ? 'bg-zinc-100 text-black border border-zinc-300' :
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
                            </div>
                          ))}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto space-y-2">
              {appointments.map(apt => (
                <div
                  key={apt.id}
                  className={`p-4 rounded-xl border-l-4 border-${statusConfig[apt.status].color}-500 ${
                    isDark ? 'bg-gray-800' : 'bg-white shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {apt.customerName || 'Walk-in'}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(apt.startTime, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Scissors className="w-3 h-3" />
                          {apt.serviceName || 'Service'}
                        </span>
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {apt.staffName || 'Staff'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-3 py-1 rounded-full text-sm bg-${statusConfig[apt.status].color}-500/10 text-${statusConfig[apt.status].color}-500`}>
                        {statusConfig[apt.status].label}
                      </span>
                      {getQuickActions(apt).map((action, idx) => {
                        const Icon = action.icon;
                        return (
                          <button
                            key={idx}
                            onClick={action.action}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1 ${
                              action.variant === 'primary' ? 'bg-zinc-100 text-black border border-zinc-300 hover:bg-white' :
                              action.variant === 'success' ? 'bg-green-600 text-white hover:bg-green-700' :
                              action.variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' :
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
                </div>
              ))}
            </div>
          )}

          {appointments.length === 0 && !isLoading && (
            <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">No appointments found</p>
              <p className="text-sm">Try selecting a different date or adjusting your filters</p>
            </div>
          )}
        </div>
      )}

      {/* Floating Action Button */}
      <FloatingActionButton
        onClick={() => setShowCreateModal(true)}
        aria-label="New Appointment"
        className="!bottom-20 sm:!bottom-6"
      />

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
              startTime: '09:00',
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
    </div>
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
  const { t } = useTranslation();
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [timePeriod, setTimePeriod] = useState<'morning' | 'afternoon' | 'evening'>('morning');
  const [existingAppointments, setExistingAppointments] = useState<{ staffId: string; startTime: string; endTime: string; status: string }[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const weekDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

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
        // Build local day boundaries to avoid timezone shift via .toISOString()
        const yyyy = selectedDay.getFullYear();
        const mm = String(selectedDay.getMonth() + 1).padStart(2, '0');
        const dd = String(selectedDay.getDate()).padStart(2, '0');
        const dayStartLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
        const dayEndLocal = new Date(`${yyyy}-${mm}-${dd}T23:59:59.999`);

        const { data } = await (supabase as any)
          .from('appointments')
          .select('staff_id, start_time, end_time, status')
          .eq('branch_id', branchId)
          .gte('start_time', dayStartLocal.toISOString())
          .lte('start_time', dayEndLocal.toISOString())
          .neq('status', 'cancelled')
          .neq('status', 'no_show');
        
        if (data) {
          setExistingAppointments(data.map((a: { staff_id: string; start_time: string; end_time: string; status: string }) => ({
            staffId: a.staff_id,
            startTime: a.start_time,
            endTime: a.end_time,
            status: a.status,
          })));
        }
      } catch (err) {
        console.error('Failed to fetch day appointments:', err);
      } finally {
        setLoadingSlots(false);
      }
    };
    fetchDayAppointments();
  }, [selectedDay, branchId]);

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
    if (isTimeSlotBooked(time)) return;
    setFormData((prev: AppointmentFormData) => ({ ...prev, startTime: time }));
  };

  const selectedService = servicesList.find(s => s.id === formData.serviceId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6">
      <div className={`w-full max-w-6xl rounded-3xl border shadow-[0_30px_90px_rgba(0,0,0,0.55)] max-h-[94vh] flex flex-col overflow-hidden ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-white border-gray-200'}`}>
        {/* Header */}
        <div className={`flex items-start justify-between px-4 sm:px-6 py-4 border-b shrink-0 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
          <div>
            <h2 className={`text-lg sm:text-xl font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>
              {t('appointments.modal.title', 'New Appointment')}
            </h2>
            <p className={`text-xs sm:text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-gray-500'}`}>
              {selectedDay && formData.startTime
                ? `${formatDate(selectedDay)} • ${formData.startTime}`
                : t('appointments.modal.phoneSearchLabel', 'Search Customer by Phone')}
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-2 rounded-xl border ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 sm:gap-5">
            <div className="xl:col-span-5 space-y-4">
          {/* Customer Selection */}
          <div className={`rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
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
                      className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-zinc-700' : 'hover:bg-gray-200'}`}
                      title={t('appointments.modal.clearCustomer', 'Clear')}
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
                  className={`w-full px-4 py-2.5 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}
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

          {/* Staff & Service */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                {t('appointments.modal.staffLabel', 'Staff *')}
              </label>
              <select
                value={formData.staffId}
                onChange={(e) => setFormData(prev => ({ ...prev, staffId: e.target.value }))}
                className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
              >
                <option value="">{t('appointments.modal.selectPlaceholder', 'Select...')}</option>
                {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-zinc-200' : 'text-gray-700'}`}>
                {t('appointments.modal.serviceLabel', 'Service *')}
              </label>
              <select
                value={formData.serviceId}
                onChange={(e) => setFormData(prev => ({ ...prev, serviceId: e.target.value }))}
                className={`w-full px-3.5 py-2.5 rounded-xl border text-sm ${isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-100' : 'bg-white border-gray-300 text-gray-900'} focus:outline-none ${isDark ? 'focus:ring-2 focus:ring-zinc-600' : 'focus:ring-2 focus:ring-gray-300'}`}
              >
                <option value="">{t('appointments.modal.selectPlaceholder', 'Select...')}</option>
                {servicesList.map(s => <option key={s.id} value={s.id}>{s.name} ({s.duration}{t('common.minutes', 'min')})</option>)}
              </select>
            </div>
          </div>

            </div>
            <div className="xl:col-span-7 space-y-4">
          {/* Calendar */}
          <div className={`p-4 rounded-2xl border ${isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center justify-between mb-3">
              <button
                type="button"
                onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1))}
                className={`p-2 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className={`font-semibold ${isDark ? 'text-zinc-100' : 'text-gray-900'}`}>{formatDate(calendarDate, { month: 'long', year: 'numeric' })}</span>
              <button
                type="button"
                onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1))}
                className={`p-2 rounded-xl border ${isDark ? 'bg-zinc-950 border-zinc-700 hover:bg-zinc-800' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1.5 mb-2">
              {weekDays.map((d, i) => <div key={i} className={`text-center text-xs py-1 ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
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
                    className={`h-10 rounded-xl text-sm transition-all border
                      ${!isCurrentMonth ? (isDark ? 'text-zinc-600' : 'text-gray-400') : ''}
                      ${isPast
                        ? (isDark ? 'text-zinc-700 border-zinc-800 bg-zinc-900/40 cursor-not-allowed' : 'text-gray-300 border-gray-200 bg-gray-100 cursor-not-allowed')
                        : (isDark ? 'border-zinc-800 hover:bg-zinc-800/80' : 'border-gray-200 hover:bg-gray-100')}
                      ${isSelected ? (isDark ? 'bg-zinc-100 text-black border-zinc-200' : 'bg-black text-white border-black') : ''}
                      ${isToday && !isSelected ? (isDark ? 'ring-1 ring-zinc-500' : 'ring-1 ring-gray-400') : ''}
                    `}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time Slots */}
          {selectedDay && (
            <div className={`p-4 rounded-2xl border space-y-3 ${isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
              <div className="grid grid-cols-3 gap-2">
                {(['morning', 'afternoon', 'evening'] as const).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTimePeriod(p)}
                    className={`py-2 text-xs sm:text-sm rounded-xl border font-medium transition-all ${
                      timePeriod === p
                        ? (isDark ? 'bg-zinc-100 text-black border-zinc-200' : 'bg-black text-white border-black')
                        : (isDark ? 'bg-zinc-950 text-zinc-300 border-zinc-700 hover:bg-zinc-800' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100')
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
              
              {!formData.staffId && <p className="text-xs text-amber-500">{t('appointments.modal.selectStaffAvailability', 'Select staff to see availability')}</p>}
              {loadingSlots && <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-gray-500'}`}>{t('appointments.modal.loadingSlots', 'Loading...')}</p>}
              
              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 xl:grid-cols-5 gap-2 max-h-56 overflow-y-auto pr-1">
                {timeSlots.map(slot => {
                  const booked = isTimeSlotBooked(slot);
                  const selected = formData.startTime === slot;
                  return (
                    <button
                      key={slot}
                      type="button"
                      disabled={booked}
                      onClick={() => handleTimeSelect(slot)}
                      className={`py-2 px-2 text-xs sm:text-sm rounded-xl border relative transition-all
                        ${selected
                          ? (isDark ? 'bg-zinc-100 text-black border-zinc-200' : 'bg-black text-white border-black')
                          : booked
                            ? (isDark ? 'bg-red-500/10 border-red-500/30 text-red-300 line-through cursor-not-allowed' : 'bg-red-50 border-red-200 text-red-500 line-through cursor-not-allowed')
                            : (isDark ? 'bg-zinc-950 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100')}
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
          )}

          {/* Summary */}
          {formData.startTime && selectedService && selectedDay && (
            <div className={`p-4 rounded-2xl border ${isDark ? 'bg-zinc-900 border-zinc-700' : 'bg-white border-gray-200'}`}>
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

          {/* Notes */}
          <div className={`rounded-2xl border p-4 ${isDark ? 'bg-zinc-900/70 border-zinc-800' : 'bg-gray-50 border-gray-200'}`}>
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
          </div>
        </div>

        {/* Footer */}
        <div className={`px-4 sm:px-6 py-4 border-t shrink-0 ${isDark ? 'border-zinc-800 bg-zinc-950/90' : 'border-gray-200 bg-white/90'}`}>
          <div className="flex flex-col-reverse sm:flex-row gap-3 sm:justify-end">
          <button onClick={onClose} className={`px-5 py-2.5 rounded-xl font-medium border ${isDark ? 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800' : 'bg-gray-100 border-gray-300 text-gray-700 hover:bg-gray-200'}`}>
            {t('appointments.modal.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleCreateAppointment}
            disabled={isSubmitting || !formData.staffId || !formData.serviceId || !formData.startTime}
            className="px-5 py-2.5 rounded-xl font-semibold bg-zinc-100 text-black border border-zinc-300 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? t('appointments.modal.creating', 'Creating...') : t('appointments.modal.create', 'Create')}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AppointmentsView;
