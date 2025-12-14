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
import { Calendar, Clock, User, Scissors, Search, ChevronLeft, ChevronRight, RefreshCw, CheckCircle, Play, XCircle, X, Plus } from 'lucide-react';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
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
  const [isSearching, setIsSearching] = useState(false);
  const [customerFound, setCustomerFound] = useState<{ id: string; name: string; phone: string; email?: string } | null>(null);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [formData, setFormData] = useState({
    customerId: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    staffId: '',
    serviceId: '',
    date: new Date().toISOString().split('T')[0],
    startTime: '09:00',
    notes: '',
  });

  const isDark = resolvedTheme === 'dark';
  
  // Search customer by phone number
  const searchCustomerByPhone = async (phone: string) => {
    if (!phone || phone.length < 3) {
      setCustomerFound(null);
      setShowAddCustomer(false);
      return;
    }
    
    console.log('[AppointmentsView] Searching customer with phone:', phone, 'orgId:', effectiveOrgId);
    
    if (!effectiveOrgId) {
      console.error('[AppointmentsView] No organization ID available for customer search');
      toast.error('Organization not configured');
      return;
    }
    
    setIsSearching(true);
    try {
      // First try exact match, then partial match
      const { data, error } = await (supabase as any)
        .from('customers')
        .select('id, name, phone, email')
        .eq('organization_id', effectiveOrgId)
        .or(`phone.eq.${phone},phone.ilike.%${phone}%`)
        .limit(1);
      
      console.log('[AppointmentsView] Customer search result:', { data, error });
      
      if (data && data.length > 0 && !error) {
        const customer = data[0];
        setCustomerFound({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email
        });
        setFormData(prev => ({
          ...prev,
          customerId: customer.id,
          customerName: customer.name,
          customerEmail: customer.email || ''
        }));
        setShowAddCustomer(false);
      } else {
        console.log('[AppointmentsView] Customer not found, showing add form');
        setCustomerFound(null);
        setShowAddCustomer(true);
      }
    } catch (err) {
      console.error('[AppointmentsView] Customer search error:', err);
      setCustomerFound(null);
      setShowAddCustomer(true);
    } finally {
      setIsSearching(false);
    }
  };
  
  // Create new customer
  const createCustomer = async () => {
    if (!formData.customerName || !formData.customerPhone) {
      toast.error('Name and phone are required');
      return null;
    }
    
    try {
      const { data, error } = await (supabase as any)
        .from('customers')
        .insert({
          organization_id: effectiveOrgId,
          branch_id: branchId,
          name: formData.customerName,
          phone: formData.customerPhone,
          email: formData.customerEmail || null,
        })
        .select('id, name, phone, email')
        .single();
      
      if (error) {
        if (error.code === '23505') {
          toast.error('Customer with this phone already exists');
        } else {
          toast.error('Failed to create customer');
        }
        return null;
      }
      
      setCustomerFound({
        id: data.id,
        name: data.name,
        phone: data.phone,
        email: data.email
      });
      setFormData(prev => ({ ...prev, customerId: data.id }));
      setShowAddCustomer(false);
      toast.success('Customer created');
      return data.id;
    } catch (err) {
      console.error('[AppointmentsView] Create customer error:', err);
      toast.error('Failed to create customer');
      return null;
    }
  };
  
  // Load staff and services for the create modal
  useEffect(() => {
    const loadDropdownData = async () => {
      if (!branchId) {
        console.warn('[AppointmentsView] No branchId for loading dropdown data');
        return;
      }
      
      console.log('[AppointmentsView] Loading staff and services for branch:', branchId);
      
      try {
        // Load staff (cast to any to bypass limited type definitions)
        const { data: staffData, error: staffError } = await (supabase as any)
          .from('staff')
          .select('id, first_name, last_name')
          .eq('branch_id', branchId)
          .eq('is_active', true);
        
        console.log('[AppointmentsView] Staff query result:', { staffData, staffError });
        
        if (staffData) {
          setStaffList(staffData.map((s: { id: string; first_name: string; last_name: string }) => ({
            id: s.id,
            name: `${s.first_name} ${s.last_name}`.trim()
          })));
        }
        
        // Load services - don't filter by is_active to see all services
        const { data: servicesData, error: servicesError } = await (supabase as any)
          .from('services')
          .select('id, name, duration_minutes, is_active')
          .eq('branch_id', branchId);
        
        console.log('[AppointmentsView] Services query result:', { servicesData, servicesError });
        
        if (servicesData) {
          // Filter active services in JS to debug
          const activeServices = servicesData.filter((s: { is_active: boolean }) => s.is_active !== false);
          console.log('[AppointmentsView] Active services:', activeServices);
          setServicesList(activeServices.map((s: { id: string; name: string; duration_minutes: number | null }) => ({
            id: s.id,
            name: s.name,
            duration: s.duration_minutes || 30
          })));
        }
      } catch (err) {
        console.error('[AppointmentsView] Failed to load dropdown data:', err);
      }
    };
    
    if (showCreateModal) {
      loadDropdownData();
    }
  }, [branchId, showCreateModal]);

  // Build filters based on selected date
  const filters: AppointmentFilters = useMemo(() => {
    const baseFilters: AppointmentFilters = {};
    
    if (quickFilter === 'week') {
      const weekStart = new Date(selectedDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      baseFilters.dateFrom = weekStart.toISOString();
      baseFilters.dateTo = weekEnd.toISOString();
    } else {
      const dayStart = new Date(selectedDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(selectedDate);
      dayEnd.setHours(23, 59, 59, 999);
      baseFilters.dateFrom = dayStart.toISOString();
      baseFilters.dateTo = dayEnd.toISOString();
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

  // Use localOrgId as fallback for organizationId from context
  const effectiveOrgId = organizationId || localOrgId || '';
  
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
    
    // If adding new customer, create them first
    let customerId = formData.customerId;
    if (showAddCustomer && formData.customerName && formData.customerPhone) {
      const newCustomerId = await createCustomer();
      if (!newCustomerId) return; // Customer creation failed
      customerId = newCustomerId;
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
        customerId: customerId || undefined,
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
        date: new Date().toISOString().split('T')[0],
        startTime: '09:00',
        notes: '',
      });
      setCustomerFound(null);
      setShowAddCustomer(false);
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
        label: 'Check In',
        action: () => checkIn(appointment.id),
        variant: 'primary',
        icon: Play,
      });
    }
    if (appointment.status === 'in_progress') {
      actions.push({
        label: 'Complete',
        action: () => complete(appointment.id),
        variant: 'success',
        icon: CheckCircle,
      });
    }
    if (['scheduled', 'confirmed'].includes(appointment.status)) {
      actions.push({
        label: 'No Show',
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
      <div className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        Please select a branch to view appointments
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-4">
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Total</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.total}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className="text-sm text-green-500">Confirmed</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.confirmed}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className="text-sm text-yellow-500">In Progress</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.inProgress}</div>
          </div>
          <div className={`px-4 py-2 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className="text-sm text-gray-500">Completed</div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{stats.completed}</div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}
          >
            <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search..."
              className={`pl-10 pr-4 py-2 rounded-lg ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
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
                  ? 'bg-blue-600 text-white'
                  : isDark ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {filter.charAt(0).toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => navigateDate('prev')} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <ChevronLeft className="w-5 h-5" />
          </button>
          <input
            type="date"
            value={selectedDate.toISOString().split('T')[0]}
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
            <option value="all">All Staff</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className={`flex rounded-lg overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
            {(['timeline', 'list'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`px-3 py-2 text-sm ${viewMode === mode ? 'bg-blue-600 text-white' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && appointments.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          Loading appointments...
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
                                        action.variant === 'primary' ? 'bg-blue-600 text-white' :
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
                          {new Date(apt.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
                              action.variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700' :
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
          customerFound={customerFound}
          showAddCustomer={showAddCustomer}
          isSearching={isSearching}
          isSubmitting={isSubmitting}
          searchCustomerByPhone={searchCustomerByPhone}
          setShowAddCustomer={setShowAddCustomer}
          setCustomerFound={setCustomerFound}
          handleCreateAppointment={handleCreateAppointment}
          onClose={() => {
            setShowCreateModal(false);
            setCustomerFound(null);
            setShowAddCustomer(false);
            setFormData({
              customerId: '',
              customerName: '',
              customerPhone: '',
              customerEmail: '',
              staffId: '',
              serviceId: '',
              date: new Date().toISOString().split('T')[0],
              startTime: '09:00',
              notes: '',
            });
          }}
          branchId={branchId || ''}
          organizationId={effectiveOrgId}
        />
      )}
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
  customerFound: { id: string; name: string; phone: string; email?: string } | null;
  showAddCustomer: boolean;
  isSearching: boolean;
  isSubmitting: boolean;
  searchCustomerByPhone: (phone: string) => Promise<void>;
  setShowAddCustomer: (show: boolean) => void;
  setCustomerFound: (customer: { id: string; name: string; phone: string; email?: string } | null) => void;
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
  customerFound,
  showAddCustomer,
  isSearching,
  isSubmitting,
  searchCustomerByPhone,
  setShowAddCustomer,
  setCustomerFound,
  handleCreateAppointment,
  onClose,
  branchId,
  organizationId,
}) => {
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
        const dayStart = new Date(selectedDay);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(selectedDay);
        dayEnd.setHours(23, 59, 59, 999);
        
        const { data } = await (supabase as any)
          .from('appointments')
          .select('staff_id, start_time, end_time, status')
          .eq('branch_id', branchId)
          .gte('start_time', dayStart.toISOString())
          .lte('start_time', dayEnd.toISOString())
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className={`w-full max-w-lg mx-4 rounded-2xl shadow-xl max-h-[90vh] flex flex-col ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
        {/* Header */}
        <div className={`flex items-center justify-between p-4 border-b shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <h2 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>New Appointment</h2>
          <button onClick={onClose} className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Phone Search */}
          <div>
            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
              <Search className="w-4 h-4 inline mr-1" /> Search Customer by Phone
            </label>
            <div className="flex gap-2">
              <input
                type="tel"
                value={formData.customerPhone}
                onChange={(e) => setFormData(prev => ({ ...prev, customerPhone: e.target.value }))}
                placeholder="Enter phone number..."
                className={`flex-1 px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
              />
              <button
                type="button"
                onClick={() => searchCustomerByPhone(formData.customerPhone)}
                disabled={isSearching || !formData.customerPhone}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {isSearching ? '...' : 'Search'}
              </button>
            </div>
          </div>

          {/* Customer Found */}
          {customerFound && (
            <div className={`p-3 rounded-lg border ${isDark ? 'bg-green-900/20 border-green-700' : 'bg-green-50 border-green-200'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className={`font-medium ${isDark ? 'text-green-400' : 'text-green-700'}`}>{customerFound.name}</p>
                  <p className={`text-sm ${isDark ? 'text-green-300' : 'text-green-600'}`}>{customerFound.phone}</p>
                </div>
                <CheckCircle className="w-5 h-5 text-green-500" />
              </div>
            </div>
          )}

          {/* Add New Customer */}
          {showAddCustomer && !customerFound && (
            <div className={`p-3 rounded-lg border space-y-3 ${isDark ? 'bg-amber-900/20 border-amber-700' : 'bg-amber-50 border-amber-200'}`}>
              <p className={`text-sm ${isDark ? 'text-amber-400' : 'text-amber-700'}`}>Customer not found. Add new customer:</p>
              <input
                type="text"
                value={formData.customerName}
                onChange={(e) => setFormData(prev => ({ ...prev, customerName: e.target.value }))}
                placeholder="Customer Name *"
                className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
              />
              <input
                type="email"
                value={formData.customerEmail}
                onChange={(e) => setFormData(prev => ({ ...prev, customerEmail: e.target.value }))}
                placeholder="Email (optional)"
                className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
              />
            </div>
          )}

          {/* Staff & Service */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Staff *</label>
              <select
                value={formData.staffId}
                onChange={(e) => setFormData(prev => ({ ...prev, staffId: e.target.value }))}
                className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
              >
                <option value="">Select...</option>
                {staffList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Service *</label>
              <select
                value={formData.serviceId}
                onChange={(e) => setFormData(prev => ({ ...prev, serviceId: e.target.value }))}
                className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
              >
                <option value="">Select...</option>
                {servicesList.map(s => <option key={s.id} value={s.id}>{s.name} ({s.duration}min)</option>)}
              </select>
            </div>
          </div>

          {/* Calendar */}
          <div className={`p-3 rounded-lg border ${isDark ? 'bg-gray-700/50 border-gray-600' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex items-center justify-between mb-3">
              <button type="button" onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1))} className={`p-1 rounded ${isDark ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}>
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="font-medium">{calendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
              <button type="button" onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1))} className={`p-1 rounded ${isDark ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}>
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {weekDays.map((d, i) => <div key={i} className="text-center text-xs text-gray-500 py-1">{d}</div>)}
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
                    className={`p-2 text-sm rounded-lg transition-all
                      ${!isCurrentMonth ? 'text-gray-400' : ''}
                      ${isPast ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-blue-100 dark:hover:bg-blue-900/30'}
                      ${isSelected ? 'bg-blue-500 text-white' : ''}
                      ${isToday && !isSelected ? 'ring-2 ring-blue-500 ring-inset' : ''}
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
            <div className={`p-3 rounded-lg border space-y-3 ${isDark ? 'bg-gray-700/50 border-gray-600' : 'bg-gray-50 border-gray-200'}`}>
              <div className="flex gap-2">
                {(['morning', 'afternoon', 'evening'] as const).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTimePeriod(p)}
                    className={`flex-1 py-1.5 text-xs rounded-lg ${timePeriod === p ? 'bg-blue-500 text-white' : isDark ? 'bg-gray-600 hover:bg-gray-500' : 'bg-gray-200 hover:bg-gray-300'}`}
                  >
                    {p === 'morning' ? 'Morning' : p === 'afternoon' ? 'Afternoon' : 'Evening'}
                  </button>
                ))}
              </div>
              
              {!formData.staffId && <p className="text-xs text-amber-500">Select staff to see availability</p>}
              {loadingSlots && <p className="text-xs text-gray-500">Loading...</p>}
              
              <div className="grid grid-cols-4 gap-1.5 max-h-28 overflow-y-auto">
                {timeSlots.map(slot => {
                  const booked = isTimeSlotBooked(slot);
                  const selected = formData.startTime === slot;
                  return (
                    <button
                      key={slot}
                      type="button"
                      disabled={booked}
                      onClick={() => handleTimeSelect(slot)}
                      className={`py-1.5 px-2 text-sm rounded-lg relative
                        ${selected ? 'bg-green-500 text-white' : booked ? 'bg-red-100 dark:bg-red-900/30 text-red-400 line-through cursor-not-allowed' : isDark ? 'bg-gray-600 hover:bg-green-600' : 'bg-gray-200 hover:bg-green-100'}
                      `}
                    >
                      {slot}
                      {booked && <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />}
                    </button>
                  );
                })}
              </div>
              
              <div className="flex gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1"><span className={`w-3 h-3 rounded ${isDark ? 'bg-gray-600' : 'bg-gray-200'}`} /> Available</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-red-100 dark:bg-red-900/30 rounded" /> Booked</span>
              </div>
            </div>
          )}

          {/* Summary */}
          {formData.startTime && selectedService && selectedDay && (
            <div className={`p-3 rounded-lg ${isDark ? 'bg-gradient-to-r from-green-900/30 to-blue-900/30' : 'bg-gradient-to-r from-green-50 to-blue-50'}`}>
              <div className="flex items-center justify-between text-sm">
                <span>{selectedDay.toLocaleDateString()}</span>
                <span className="font-medium text-green-600">{formData.startTime}</span>
                <span>→</span>
                <span className="font-medium text-blue-600">
                  {(() => {
                    const [h, m] = formData.startTime.split(':').map(Number);
                    const end = new Date(selectedDay);
                    end.setHours(h, m + selectedService.duration, 0, 0);
                    return end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  })()}
                </span>
                <span className="text-gray-500">({selectedService.duration}min)</span>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Optional notes..."
              rows={2}
              className={`w-full px-3 py-2 rounded-lg border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
            />
          </div>
        </div>

        {/* Footer */}
        <div className={`flex gap-3 p-4 border-t shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          <button onClick={onClose} className={`flex-1 px-4 py-2 rounded-lg font-medium ${isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'}`}>
            Cancel
          </button>
          <button
            onClick={handleCreateAppointment}
            disabled={isSubmitting || !formData.staffId || !formData.serviceId || !formData.startTime}
            className="flex-1 px-4 py-2 rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppointmentsView;
