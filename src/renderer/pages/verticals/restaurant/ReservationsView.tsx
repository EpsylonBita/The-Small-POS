/**
 * ReservationsView - POS Reservations Management
 *
 * Real-time reservation management for restaurant POS.
 * Supports Tables and Rooms tabs with list and timeline views.
 */

import React, { memo, useState, useMemo, useCallback, useEffect, useRef, useId } from 'react';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { posApiGet } from '../../../utils/api-helpers';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useAcquiredModules } from '../../../hooks/useAcquiredModules';
import { useSystemClock } from '../../../hooks/useSystemClock';
import { useReservations } from '../../../hooks/useReservations';
import { useAppointments } from '../../../hooks/useAppointments';
import { useTables } from '../../../hooks/useTables';
import { useRooms } from '../../../hooks/useRooms';
import { formatTableDisplayNumber } from '../../../utils/table-display';
import { buildReservationTimelineSlots } from '../../../utils/reservationTimeline';
import { formatCurrency, formatDate, formatTime } from '../../../utils/format';
import { addLocalDays, parseLocalDateString, startOfLocalDay, toLocalDateString } from '../../../utils/date';
import {
  Calendar,
  Users,
  Phone,
  Clock,
  Search,
  ChevronLeft,
  ChevronRight,
  List,
  LayoutGrid,
  RefreshCw,
  AlertTriangle,
  BedDouble,
  Plus,
  Scissors,
  X,
} from 'lucide-react';
import TableOrderIcon from '../../../components/icons/TableOrderIcon';
import {
  reservationsService,
  type Reservation,
  type ReservationStatus,
  type ReservationFilters,
  type CreateReservationDto,
} from '../../../services/ReservationsService';
import type { Appointment, AppointmentStatus } from '../../../services/AppointmentsService';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { getBridge, isBrowser, offEvent, onEvent } from '../../../../lib';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

type QuickFilter = 'today' | 'tomorrow' | 'week' | 'custom';
type ViewMode = 'timeline' | 'list';
type ReservationTab = 'tables' | 'rooms' | 'services';

// Status colors and labels
const statusColors: Record<ReservationStatus, string> = {
  confirmed: 'yellow',
  pending: 'yellow',
  seated: 'green',
  completed: 'gray',
  no_show: 'red',
  cancelled: 'gray',
};

const appointmentStatusColors: Record<AppointmentStatus, string> = {
  scheduled: 'yellow',
  confirmed: 'green',
  in_progress: 'yellow',
  completed: 'gray',
  cancelled: 'red',
  no_show: 'red',
};

export const ReservationsView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
  const now = useSystemClock();
  const bridge = getBridge();
  const { hasTablesModule, hasRoomsModule, hasAppointmentsModule, hasServiceCatalogModule } = useAcquiredModules();
  const hasServiceReservations = hasAppointmentsModule && hasServiceCatalogModule;

  // Get branchId from terminal credential cache / IPC
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

  // Use module context organizationId if available, otherwise fall back to localStorage
  const effectiveOrgId = organizationId || localOrgId;

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => startOfLocalDay(new Date()));
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('today');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activeTab, setActiveTab] = useState<ReservationTab>(() => {
    // Default to tables if available, otherwise rooms
    return 'tables';
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [isDetailsLoading, setIsDetailsLoading] = useState(false);
  const [isAssigningTable, setIsAssigningTable] = useState(false);
  const [tableAssignmentId, setTableAssignmentId] = useState('');
  const [createForm, setCreateForm] = useState({
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    partySize: '2',
    reservationDate: '',
    reservationTime: '19:00',
    durationMinutes: '90',
    tableId: '',
    roomId: '',
    checkInDate: '',
    checkOutDate: '',
    specialRequests: '',
    notes: '',
  });

  // Service-booking (appointment) create modal — kept fully separate from the
  // table/room reservation modal/handler so that path (incl. table-label UUID hiding)
  // is untouched. Service reservations are created via useAppointments.createAppointment.
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [isCreatingService, setIsCreatingService] = useState(false);
  const [serviceStaffList, setServiceStaffList] = useState<{ id: string; name: string }[]>([]);
  const [serviceCatalog, setServiceCatalog] = useState<{ id: string; name: string; duration: number }[]>([]);
  const [serviceForm, setServiceForm] = useState({
    customerName: '',
    customerPhone: '',
    serviceId: '',
    staffId: '',
    date: '',
    time: '10:00',
    notes: '',
  });
  const serviceDialogRef = useRef<HTMLDivElement>(null);
  const serviceTitleId = useId();
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createTitleId = useId();

  const isDark = resolvedTheme === 'dark';
  // Shared class for the visible field labels in the create-reservation modal so
  // prefilled controls (party size, duration, date/time) are never left as a bare
  // value with only a placeholder for context.
  const fieldLabelClass = `text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-800'}`;
  // Shared input/select class for the create + service-booking modal controls.
  // Translucent neutral surface so fields stay readable on the blurry-glass modal shell.
  const modalInputClass = `px-3 py-2 rounded-xl border ${isDark ? 'bg-gray-950/55 text-white border-white/10' : 'bg-white/55 text-gray-950 border-white/60 shadow-sm shadow-black/5'}`;
  const modalPanelClass = `relative z-10 w-full max-w-2xl mx-4 rounded-[26px] backdrop-blur-2xl shadow-[0_30px_90px_rgba(0,0,0,0.5)] border ring-1 p-5 ${isDark ? 'bg-gray-950/55 border-white/10 ring-white/10' : 'bg-white/28 border-white/65 ring-white/35'}`;
  const modalScrimClass = `absolute inset-0 backdrop-blur-xl ${isDark ? 'bg-black/55' : 'bg-black/30'}`;
  const createPartySize = Number(createForm.partySize);
  const isCreateReservationReady =
    Boolean(createForm.customerName.trim()) &&
    Boolean(createForm.customerPhone.trim()) &&
    Boolean(createForm.reservationDate) &&
    Boolean(createForm.reservationTime) &&
    Number.isFinite(createPartySize) &&
    createPartySize > 0 &&
    (activeTab !== 'rooms' ||
      (Boolean(createForm.roomId.trim()) &&
        Boolean(createForm.checkInDate) &&
        Boolean(createForm.checkOutDate)));

  // Auto-select tab based on available modules
  useEffect(() => {
    const availableTabs: ReservationTab[] = [
      ...(hasTablesModule ? ['tables' as const] : []),
      ...(hasRoomsModule ? ['rooms' as const] : []),
      ...(hasServiceReservations ? ['services' as const] : []),
    ];
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [activeTab, hasTablesModule, hasRoomsModule, hasServiceReservations]);

  useEffect(() => {
    setCreateForm((prev) => ({
      ...prev,
      reservationDate: toLocalDateString(selectedDate),
      checkInDate: toLocalDateString(selectedDate),
      checkOutDate: prev.checkOutDate || toLocalDateString(addLocalDays(selectedDate, 1)),
    }));
  }, [selectedDate]);

  useEffect(() => {
    if (quickFilter === 'today') {
      const nextDate = startOfLocalDay(now);
      setSelectedDate((prev) => (prev.getTime() === nextDate.getTime() ? prev : nextDate));
      return;
    }

    if (quickFilter === 'tomorrow') {
      const nextDate = addLocalDays(now, 1);
      setSelectedDate((prev) => (prev.getTime() === nextDate.getTime() ? prev : nextDate));
    }
  }, [now, quickFilter]);

  useEffect(() => {
    setTableAssignmentId(selectedReservation?.tableId || '');
  }, [selectedReservation?.id, selectedReservation?.tableId]);

  // Build filters based on selected date and quick filter
  const filters: ReservationFilters = useMemo(() => {
    const baseFilters: ReservationFilters = {
      kind: activeTab === 'rooms' ? 'room' : 'table',
    };

    if (quickFilter === 'week') {
      const weekStart = new Date(selectedDate);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      baseFilters.dateFrom = toLocalDateString(weekStart);
      baseFilters.dateTo = toLocalDateString(weekEnd);
    } else {
      const dateStr = toLocalDateString(selectedDate);
      baseFilters.dateFrom = dateStr;
      baseFilters.dateTo = dateStr;
    }

    if (searchTerm) {
      baseFilters.searchTerm = searchTerm;
    }

    return baseFilters;
  }, [activeTab, selectedDate, quickFilter, searchTerm]);

  const availableReservationTabs = useMemo<ReservationTab[]>(() => [
    ...(hasTablesModule ? ['tables' as const] : []),
    ...(hasRoomsModule ? ['rooms' as const] : []),
    ...(hasServiceReservations ? ['services' as const] : []),
  ], [hasTablesModule, hasRoomsModule, hasServiceReservations]);

  // Use reservations hook
  const {
    reservations,
    isLoading,
    refetch,
    updateStatus,
    createReservation,
    assignTable,
  } = useReservations({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    filters,
    enableRealtime: true,
  });

  // Table cache (same authenticated source as the POS table grid) so reservation
  // surfaces can show the visible table label instead of leaking the raw UUID.
  const { tables } = useTables({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    enabled: hasTablesModule,
  });

  const tablesById = useMemo(
    () => new Map(tables.map((table) => [table.id, table])),
    [tables],
  );

  // Room inventory (same authenticated source as the Rooms grid) so the Δωμάτια create
  // form can offer a real room selector instead of a raw room-id text input. Gated on the
  // rooms module via branchId so table/service-only orgs never fetch room inventory.
  const { rooms } = useRooms({
    branchId: hasRoomsModule ? branchId || '' : '',
    organizationId: hasRoomsModule ? effectiveOrgId || '' : '',
    enableRealtime: false,
  });

  // Staff-facing room option label: room number/title plus the nightly rate when known
  // (locale-aware money), never the raw room id/UUID.
  const roomOptionLabel = useCallback(
    (room: { roomNumber?: string | number | null; ratePerNight?: number | null }): string => {
      const number = room.roomNumber == null ? '' : String(room.roomNumber).trim();
      const base = number
        ? `${t('reservationsView.room', { defaultValue: 'Room' })} ${number}`
        : t('reservationsView.room', { defaultValue: 'Room' });
      return room.ratePerNight != null
        ? `${base} · ${formatCurrency(Number(room.ratePerNight) || 0)}`
        : base;
    },
    [t],
  );

  // Resolve a reservation's table to the same display label used by the grid
  // (e.g. "#TP01"). Prefer the reservation's own number, then the table cache;
  // never fall back to the UUID. Unresolved tables show a neutral "#—" marker.
  const resolveTableLabel = useCallback(
    (tableId?: string | null, tableNumber?: number | string | null): string => {
      const fromReservation = tableNumber == null ? '' : String(tableNumber).trim();
      const number =
        fromReservation !== ''
          ? fromReservation
          : tablesById.get(tableId ?? '')?.tableNumber;
      return number != null && String(number).trim() !== ''
        ? formatTableDisplayNumber(number)
        : '#—';
    },
    [tablesById],
  );

  const appointmentFilters = useMemo(() => ({
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    includeServices: true,
  }), [filters.dateFrom, filters.dateTo]);

  const {
    appointments,
    isLoading: isAppointmentsLoading,
    refetch: refetchAppointments,
    updateStatus: updateAppointmentStatus,
    createAppointment,
  } = useAppointments({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    filters: appointmentFilters,
    enableRealtime: true,
  });

  // Filter reservations based on active tab
  // Tables tab shows reservations with table_id, Rooms tab shows reservations with room_id
  const filteredReservations = useMemo(() => {
    if (activeTab === 'tables') {
      return reservations.filter(r => !r.roomId);
    } else {
      // Room reservations have room_id set
      return reservations.filter(r => r.roomId);
    }
  }, [reservations, activeTab]);

  // Calculate stats for filtered reservations
  const filteredStats = useMemo(() => {
    const filtered = filteredReservations;
    return {
      total: filtered.length,
      pending: filtered.filter(r => r.status === 'pending').length,
      confirmed: filtered.filter(r => r.status === 'confirmed').length,
      seated: filtered.filter(r => r.status === 'seated').length,
      totalGuests: filtered.reduce((sum, r) => sum + r.partySize, 0),
    };
  }, [filteredReservations]);

  const visibleStats = useMemo(() => {
    if (activeTab !== 'services') {
      return filteredStats;
    }
    return {
      total: appointments.length,
      pending: appointments.filter((appointment) => appointment.status === 'scheduled').length,
      confirmed: appointments.filter((appointment) => appointment.status === 'confirmed').length,
      seated: appointments.filter((appointment) => appointment.status === 'in_progress').length,
      totalGuests: appointments.length,
    };
  }, [activeTab, appointments, filteredStats]);

  const isActiveLoading = activeTab === 'services' ? isAppointmentsLoading : isLoading;

  const statusLabels: Record<ReservationStatus, string> = {
    confirmed: t('reservationsView.status.confirmed', { defaultValue: 'Confirmed' }),
    pending: t('reservationsView.status.pending', { defaultValue: 'Pending' }),
    seated: t('reservationsView.status.seated', { defaultValue: 'Seated' }),
    completed: t('reservationsView.status.completed', { defaultValue: 'Completed' }),
    no_show: t('reservationsView.status.no_show', { defaultValue: 'No Show' }),
    cancelled: t('reservationsView.status.cancelled', { defaultValue: 'Cancelled' }),
  };

  const appointmentStatusLabels: Record<AppointmentStatus, string> = {
    scheduled: t('appointmentsView.status.scheduled', { defaultValue: 'Scheduled' }),
    confirmed: t('appointmentsView.status.confirmed', { defaultValue: 'Confirmed' }),
    in_progress: t('appointmentsView.status.in_progress', { defaultValue: 'In Progress' }),
    completed: t('appointmentsView.status.completed', { defaultValue: 'Completed' }),
    cancelled: t('appointmentsView.status.cancelled', { defaultValue: 'Cancelled' }),
    no_show: t('appointmentsView.status.no_show', { defaultValue: 'No Show' }),
  };

  const handleQuickFilter = useCallback((filter: QuickFilter) => {
    setQuickFilter(filter);
    const today = startOfLocalDay(now);

    if (filter === 'today') {
      setSelectedDate(today);
    } else if (filter === 'tomorrow') {
      const tomorrow = addLocalDays(today, 1);
      setSelectedDate(tomorrow);
    }
  }, [now]);

  const navigateDate = useCallback((direction: 'prev' | 'next') => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + (direction === 'next' ? 1 : -1));
    setSelectedDate(newDate);
    setQuickFilter('custom');
  }, [selectedDate]);

  const handleStatusChange = useCallback(async (reservationId: string, status: ReservationStatus) => {
    const updated = await updateStatus(reservationId, status);
    if (!updated) return;

    if (selectedReservation?.id === reservationId) {
      reservationsService.setContext(branchId || '', effectiveOrgId || '');
      const refreshed = await reservationsService.fetchReservationById(reservationId);
      if (refreshed) {
        setSelectedReservation(refreshed);
      }
    }
  }, [updateStatus, selectedReservation?.id, branchId, effectiveOrgId]);

  const openReservationDetails = useCallback(async (reservationId: string) => {
    setIsDetailsLoading(true);
    setSelectedReservation(null);
    reservationsService.setContext(branchId || '', effectiveOrgId || '');
    const reservation = await reservationsService.fetchReservationById(reservationId);
    setSelectedReservation(reservation);
    setIsDetailsLoading(false);
  }, [branchId, effectiveOrgId]);

  const handleCreateReservation = useCallback(async () => {
    const partySize = Number(createForm.partySize);
    const durationMinutes = Number(createForm.durationMinutes);

    if (!createForm.customerName.trim() || !createForm.customerPhone.trim()) {
      toast.error(t('reservationsView.validation.customerRequired', { defaultValue: 'Customer name and phone are required' }));
      return;
    }

    if (!createForm.reservationDate || !createForm.reservationTime || !Number.isFinite(partySize) || partySize <= 0) {
      toast.error(t('reservationsView.validation.invalidReservation', { defaultValue: 'Please provide a valid date, time and party size' }));
      return;
    }

    if (activeTab === 'rooms' && (!createForm.roomId.trim() || !createForm.checkInDate || !createForm.checkOutDate)) {
      toast.error(t('reservationsView.validation.roomRequired', { defaultValue: 'Room, check-in date and check-out date are required' }));
      return;
    }

    const payload: CreateReservationDto = {
      reservationType: activeTab === 'rooms' ? 'room' : 'table',
      customerName: createForm.customerName.trim(),
      customerPhone: createForm.customerPhone.trim(),
      customerEmail: createForm.customerEmail.trim() || undefined,
      partySize,
      reservationDate: activeTab === 'rooms' ? createForm.checkInDate : createForm.reservationDate,
      reservationTime: activeTab === 'rooms' ? '15:00' : createForm.reservationTime,
      durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 90,
      tableId: activeTab === 'tables' ? createForm.tableId.trim() || undefined : undefined,
      roomId: activeTab === 'rooms' ? createForm.roomId.trim() || undefined : undefined,
      checkInDate: activeTab === 'rooms' ? createForm.checkInDate : undefined,
      checkOutDate: activeTab === 'rooms' ? createForm.checkOutDate : undefined,
      specialRequests: createForm.specialRequests.trim() || undefined,
      notes: createForm.notes.trim() || undefined,
    };

    setIsCreating(true);
    const created = await createReservation(payload);
    setIsCreating(false);

    if (!created) {
      return;
    }

    setShowCreateModal(false);
    setCreateForm({
      customerName: '',
      customerPhone: '',
      customerEmail: '',
      partySize: '2',
      reservationDate: toLocalDateString(selectedDate),
      reservationTime: '19:00',
      durationMinutes: '90',
      tableId: '',
      roomId: '',
      checkInDate: toLocalDateString(selectedDate),
      checkOutDate: toLocalDateString(addLocalDays(selectedDate, 1)),
      specialRequests: '',
      notes: '',
    });
    await refetch();
    await openReservationDetails(created.id);
  }, [activeTab, createForm, createReservation, refetch, selectedDate, openReservationDetails, t]);

  // Close-only path for the service modal. Escape and the X/Cancel/backdrop all route
  // through it; it never submits, so dismissing can't create or cancel anything.
  const closeServiceModal = useCallback(() => {
    setShowServiceModal(false);
  }, []);

  // Close-only path for the table/room reservation create modal. Escape routes through it;
  // it only hides the modal (no createReservation), matching the existing backdrop/X/Cancel.
  const closeCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  // Open the service-booking modal with the date defaulted from the selected date.
  const openServiceModal = useCallback(() => {
    setServiceForm((prev) => ({ ...prev, date: toLocalDateString(selectedDate) }));
    setShowServiceModal(true);
  }, [selectedDate]);

  // Load staff + active services for the service modal (mirrors AppointmentsView's
  // dropdown fetch) only while the modal is open and a branch is resolved.
  useEffect(() => {
    if (!showServiceModal || !branchId) {
      return;
    }
    let disposed = false;
    const load = async () => {
      try {
        const dateStr = toLocalDateString(selectedDate);
        const staffResult = isBrowser()
          ? await posApiGet<{ success?: boolean; staff?: any[]; error?: string }>(
              `/api/pos/staff-schedule?start_date=${encodeURIComponent(dateStr)}&end_date=${encodeURIComponent(dateStr)}`,
            )
          : await bridge.staffSchedule.list({ start_date: dateStr, end_date: dateStr });
        const staffPayload = (staffResult.data ?? {}) as { staff?: any[] };
        const resolvedStaff = Array.isArray(staffPayload.staff)
          ? staffPayload.staff
              .map((member: any) => ({
                id: String(member?.id ?? ''),
                name:
                  String(member?.name ?? '').trim() ||
                  `${member?.firstName ?? member?.first_name ?? ''} ${member?.lastName ?? member?.last_name ?? ''}`.trim() ||
                  t('reservationsView.form.staff', { defaultValue: 'Staff' }),
              }))
              .filter((member: { id: string; name: string }) => !!member.id)
          : [];
        if (!disposed) setServiceStaffList(resolvedStaff);

        const servicesResult = isBrowser()
          ? await posApiGet<{ success?: boolean; services?: any[]; error?: string }>('/api/pos/services?is_active=true')
          : await bridge.services.list({ is_active: true });
        const servicesPayload = (servicesResult.data ?? {}) as { services?: any[] };
        const resolvedServices = Array.isArray(servicesPayload.services)
          ? servicesPayload.services
              .filter((service: any) => (service?.is_active ?? service?.isActive ?? true) !== false && service?.status !== 'inactive')
              .map((service: any) => ({
                id: String(service?.id ?? ''),
                name: service?.name || service?.title || t('reservationsView.service', { defaultValue: 'Service' }),
                duration: Number(service?.duration_minutes ?? service?.duration ?? service?.durationMinutes ?? 30) || 30,
              }))
              .filter((service: { id: string }) => !!service.id)
          : [];
        if (!disposed) setServiceCatalog(resolvedServices);
      } catch (err) {
        console.error('[ReservationsView] Failed to load service booking dropdowns:', err);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [showServiceModal, branchId, selectedDate, bridge, t]);

  // Escape closes only the service modal, using the topmost-[role="dialog"] gate so a
  // future nested dialog above it would close first. Routes through closeServiceModal,
  // never the create submit.
  useEffect(() => {
    if (!showServiceModal) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== serviceDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeServiceModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showServiceModal, closeServiceModal]);

  // Escape closes the table/room reservation create modal, matching the service modal. Only
  // the topmost [role="dialog"] reacts, so a nested dialog above it would close first.
  // Routes through closeCreateModal (close-only) — never createReservation.
  useEffect(() => {
    if (!showCreateModal) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== createDialogRef.current) {
        return;
      }
      event.preventDefault();
      closeCreateModal();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showCreateModal, closeCreateModal]);

  const handleCreateServiceBooking = useCallback(async () => {
    // Service bookings require an explicit service, staff and date/time before submit.
    if (!serviceForm.serviceId || !serviceForm.staffId || !serviceForm.date || !serviceForm.time) {
      toast.error(t('reservationsView.validation.serviceRequired', { defaultValue: 'Service, staff, date and time are required' }));
      return;
    }

    const base = parseLocalDateString(serviceForm.date);
    const [hours, minutes] = serviceForm.time.split(':').map(Number);
    if (Number.isNaN(base.getTime()) || !Number.isFinite(hours) || !Number.isFinite(minutes)) {
      toast.error(t('reservationsView.validation.serviceRequired', { defaultValue: 'Service, staff, date and time are required' }));
      return;
    }
    // Build the start/end from the LOCAL calendar date + time so the ISO sent to the API
    // is the correct instant (no UTC date drift from new Date('YYYY-MM-DD')).
    base.setHours(hours, minutes, 0, 0);
    const service = serviceCatalog.find((entry) => entry.id === serviceForm.serviceId);
    const duration = service?.duration && service.duration > 0 ? service.duration : 30;
    const startTime = base.toISOString();
    const endTime = new Date(base.getTime() + duration * 60 * 1000).toISOString();

    setIsCreatingService(true);
    const created = await createAppointment({
      customerName: serviceForm.customerName.trim() || undefined,
      customerPhone: serviceForm.customerPhone.trim() || undefined,
      staffId: serviceForm.staffId,
      serviceId: serviceForm.serviceId,
      startTime,
      endTime,
      notes: serviceForm.notes.trim() || undefined,
    });
    setIsCreatingService(false);

    if (!created) {
      return;
    }

    setShowServiceModal(false);
    setServiceForm({
      customerName: '',
      customerPhone: '',
      serviceId: '',
      staffId: '',
      date: toLocalDateString(selectedDate),
      time: '10:00',
      notes: '',
    });
    await refetchAppointments();
  }, [serviceForm, serviceCatalog, createAppointment, refetchAppointments, selectedDate, t]);

  const handleAssignTable = useCallback(async () => {
    if (!selectedReservation || !tableAssignmentId.trim()) return;

    setIsAssigningTable(true);
    const updated = await assignTable(selectedReservation.id, tableAssignmentId.trim());
    setIsAssigningTable(false);

    if (!updated) return;

    reservationsService.setContext(branchId || '', effectiveOrgId || '');
    const refreshed = await reservationsService.fetchReservationById(selectedReservation.id);
    if (refreshed) {
      setSelectedReservation(refreshed);
    }
    await refetch();
  }, [selectedReservation, tableAssignmentId, assignTable, branchId, effectiveOrgId, refetch]);

  // Timeline rows: keep the default business window but dynamically expand to the
  // earliest/latest reservation hour in the filtered data, so early (e.g. 09:00) or
  // late reservations are never hidden from the timeline.
  const timeSlots = useMemo(
    () =>
      buildReservationTimelineSlots(
        filteredReservations.map((res) => new Date(res.reservationDatetime).getHours()),
      ),
    [filteredReservations],
  );

  // Group filtered reservations by hour for timeline view. Buckets are created on
  // demand so a reservation hour is never silently dropped from the grouping.
  const reservationsByHour = useMemo(() => {
    const grouped: Record<number, Reservation[]> = {};
    timeSlots.forEach((hour) => { grouped[hour] = []; });

    filteredReservations.forEach((res) => {
      const hour = new Date(res.reservationDatetime).getHours();
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return;
      }
      if (!grouped[hour]) {
        grouped[hour] = [];
      }
      grouped[hour].push(res);
    });

    return grouped;
  }, [filteredReservations, timeSlots]);

  // Get quick actions for a reservation
  const getQuickActions = (reservation: Reservation) => {
    const actions: { label: string; status: ReservationStatus; variant: string }[] = [];

    if (reservation.status === 'pending') {
      actions.push({ label: t('reservationsView.actions.confirm', { defaultValue: 'Confirm' }), status: 'confirmed', variant: 'primary' });
    }
    if (reservation.status === 'confirmed') {
      actions.push({ label: t('reservationsView.actions.seat', { defaultValue: 'Seat' }), status: 'seated', variant: 'success' });
    }
    if (reservation.status === 'seated') {
      actions.push({ label: t('reservationsView.actions.complete', { defaultValue: 'Complete' }), status: 'completed', variant: 'primary' });
    }
    if (['pending', 'confirmed'].includes(reservation.status)) {
      actions.push({ label: t('reservationsView.actions.noShow', { defaultValue: 'No Show' }), status: 'no_show', variant: 'danger' });
    }

    return actions;
  };

  const getAppointmentQuickActions = (appointment: Appointment) => {
    const actions: { label: string; status: AppointmentStatus; variant: string }[] = [];

    if (appointment.status === 'scheduled') {
      actions.push({ label: t('reservationsView.actions.confirm', { defaultValue: 'Confirm' }), status: 'confirmed', variant: 'primary' });
    }
    if (appointment.status === 'confirmed') {
      actions.push({ label: t('reservationsView.actions.checkIn', { defaultValue: 'Check In' }), status: 'in_progress', variant: 'success' });
    }
    if (appointment.status === 'in_progress') {
      actions.push({ label: t('reservationsView.actions.complete', { defaultValue: 'Complete' }), status: 'completed', variant: 'primary' });
    }
    if (['scheduled', 'confirmed'].includes(appointment.status)) {
      actions.push({ label: t('reservationsView.actions.noShow', { defaultValue: 'No Show' }), status: 'no_show', variant: 'danger' });
    }

    return actions;
  };

  if (!branchId || !effectiveOrgId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        {t('reservationsView.noBranch', { defaultValue: 'Please select a branch to view reservations' })}
      </motion.div>
    );
  }

  // Show message if neither module is acquired
  if (availableReservationTabs.length === 0) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <Calendar className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-lg font-medium mb-2">
          {t('reservationsView.noModules', { defaultValue: 'No reservation modules available' })}
        </p>
        <p className="text-sm text-center max-w-md">
          {t('reservationsView.noModulesHint', { defaultValue: 'Please acquire Tables, Rooms, or Services to manage reservations.' })}
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-4">
      <motion.section
        variants={pageMotionItem}
        data-vertical-hero="reservations"
        className={`mb-4 rounded-3xl border p-4 backdrop-blur-xl ${isDark ? 'border-white/10 bg-zinc-950/70 shadow-[0_18px_46px_rgba(0,0,0,0.35)]' : 'border-yellow-200/80 bg-white/74 shadow-[0_18px_44px_rgba(15,23,42,0.10)]'}`}
      >
      <div className="mb-4 min-w-0">
        <h1 className={`truncate text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('navigation.menu.reservations', { defaultValue: 'Reservations' })}
        </h1>
      </div>

      {/* Tabs - only show if both modules are available */}
      {availableReservationTabs.length > 1 && (
        <motion.div variants={pageMotionContainer} className={`flex gap-1 mb-4 p-1 rounded-2xl ${isDark ? 'bg-gray-800/85' : 'bg-gray-100/90'}`}>
          {availableReservationTabs.map((tab) => {
            const Icon = tab === 'rooms' ? BedDouble : tab === 'services' ? Scissors : TableOrderIcon;
            // Selected tab = explicit yellow/black accent (survives the global blue/purple/pink→grey remap).
            const activeClass = 'bg-yellow-400 text-black shadow-lg';
            const count =
              tab === 'rooms'
                ? reservations.filter((r) => r.roomId).length
                : tab === 'services'
                  ? appointments.length
                  : reservations.filter((r) => !r.roomId).length;
            return (
              <motion.button
                variants={pageMotionItem}
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 inline-flex items-center justify-center text-center gap-2 px-4 py-3 rounded-xl font-medium transition-all active:scale-95 ${
                  activeTab === tab
                    ? activeClass
                    : isDark
                      ? 'text-gray-400'
                      : 'text-gray-600'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                {tab === 'rooms'
                  ? t('reservationsView.tabs.rooms', { defaultValue: 'Rooms' })
                  : tab === 'services'
                    ? t('reservationsView.tabs.services', { defaultValue: 'Services' })
                    : t('reservationsView.tabs.tables', { defaultValue: 'Tables' })}
                <span className={`ml-1 px-2 py-0.5 rounded-full text-xs ${
                  activeTab === tab ? 'bg-black/10 text-black' : isDark ? 'bg-gray-700' : 'bg-gray-200'
                }`}>
                  {count}
                </span>
              </motion.button>
            );
          })}
        </motion.div>
      )}

      {/* Single module header - show which type of reservations we're viewing */}
      {availableReservationTabs.length === 1 && (
        <motion.div variants={pageMotionItem} className={`flex items-center gap-2 mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {activeTab === 'tables' ? (
            <>
              <TableOrderIcon className={`w-6 h-6 shrink-0 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <h2 className="text-xl font-semibold">{t('reservationsView.headers.tables', { defaultValue: 'Table Reservations' })}</h2>
            </>
          ) : activeTab === 'rooms' ? (
            <>
              <BedDouble className={`w-6 h-6 shrink-0 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <h2 className="text-xl font-semibold">{t('reservationsView.headers.rooms', { defaultValue: 'Room Reservations' })}</h2>
            </>
          ) : (
            <>
              <Scissors className={`w-6 h-6 shrink-0 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <h2 className="text-xl font-semibold">{t('reservationsView.headers.services', { defaultValue: 'Service Reservations' })}</h2>
            </>
          )}
        </motion.div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <motion.div variants={pageMotionContainer} className="flex flex-wrap gap-3">
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {t('reservationsView.stats.total', { defaultValue: 'Total' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visibleStats.total}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-yellow-500`}>
              {t('reservationsView.stats.pending', { defaultValue: 'Pending' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visibleStats.pending}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {t('reservationsView.stats.confirmed', { defaultValue: 'Confirmed' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visibleStats.confirmed}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm text-green-500`}>
              {t('reservationsView.stats.seated', { defaultValue: 'Seated' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visibleStats.seated}</div>
          </motion.div>
          <motion.div variants={pageMotionItem} className={`px-4 py-2 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}>
            <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {t('reservationsView.stats.guests', { defaultValue: 'Guests' })}
            </div>
            <div className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{visibleStats.totalGuests}</div>
          </motion.div>
        </motion.div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => {
              if (activeTab === 'services') {
                openServiceModal();
                return;
              }
              setCreateForm((prev) => ({
                ...prev,
                reservationDate: toLocalDateString(selectedDate),
                checkInDate: toLocalDateString(selectedDate),
                checkOutDate: toLocalDateString(addLocalDays(selectedDate, 1)),
              }));
              setShowCreateModal(true);
            }}
            disabled={activeTab === 'services' && !hasServiceReservations}
            className={`inline-flex items-center justify-center text-center gap-2 min-h-[40px] px-3 py-2 rounded-xl transition-transform active:scale-95 ${
              activeTab === 'services' && !hasServiceReservations
                ? isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-500 cursor-not-allowed'
                : 'bg-yellow-400 text-black'
            }`}
            aria-label={activeTab === 'services' && !hasServiceReservations
              ? t('reservationsView.createServiceInAppointments', { defaultValue: 'Create service bookings from Appointments' })
              : activeTab === 'services'
                ? t('reservationsView.createServiceTitle', { defaultValue: 'Create Service Booking' })
                : t('reservationsView.createTitle', { defaultValue: 'Create Reservation' })}
          >
            <Plus className="w-4 h-4 shrink-0" />
            {t('reservationsView.create', { defaultValue: 'Create' })}
          </button>
          <button
            onClick={() => {
              if (activeTab === 'services') {
                void refetchAppointments();
              } else {
                void refetch();
              }
            }}
            className={`inline-flex items-center justify-center shrink-0 min-w-[40px] min-h-[40px] p-2 rounded-xl transition-transform active:scale-95 ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-gray-100 text-gray-700'}`}
            aria-label={t('reservationsView.refresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw className={`w-5 h-5 shrink-0 ${isActiveLoading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('reservationsView.searchPlaceholder', { defaultValue: 'Search...' })}
              className={`pl-10 pr-4 py-2 rounded-xl ${isDark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'} border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
            />
          </div>
        </div>
      </div>
      </motion.section>

      {/* Filters Row */}
      <motion.div variants={pageMotionItem} className="flex items-center justify-between mb-4">
        {/* Quick Filters */}
        <motion.div variants={pageMotionContainer} className="flex gap-2">
          {(['today', 'tomorrow', 'week'] as const).map(filter => (
            <motion.button
              variants={pageMotionItem}
              key={filter}
              onClick={() => handleQuickFilter(filter)}
              className={`inline-flex items-center justify-center text-center min-h-[36px] px-3 py-1.5 rounded-xl text-sm transition-transform active:scale-95 ${
                quickFilter === filter
                  ? 'bg-yellow-400 text-black'
                  : isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'
              }`}
            >
              {t(`reservationsView.filter.${filter}`, { defaultValue: filter.charAt(0).toUpperCase() + filter.slice(1) })}
            </motion.button>
          ))}
        </motion.div>

        {/* Date Navigation */}
        <div className="flex items-center gap-2">
          <button onClick={() => navigateDate('prev')} className={`inline-flex items-center justify-center shrink-0 min-w-[40px] min-h-[40px] p-2 rounded-xl transition-transform active:scale-95 ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-gray-100 text-gray-700'}`}>
            <ChevronLeft className="w-5 h-5 shrink-0" />
          </button>
          <input
            type="date"
            value={toLocalDateString(selectedDate)}
            onChange={(e) => {
              const parsed = parseLocalDateString(e.target.value);
              if (Number.isNaN(parsed.getTime())) return;
              setSelectedDate(parsed);
              setQuickFilter('custom');
            }}
            className={`px-3 py-2 rounded-xl ${isDark ? 'bg-gray-800 text-white border-gray-700' : 'bg-white text-gray-900 border-gray-200'} border`}
          />
          <button onClick={() => navigateDate('next')} className={`inline-flex items-center justify-center shrink-0 min-w-[40px] min-h-[40px] p-2 rounded-xl transition-transform active:scale-95 ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-gray-100 text-gray-700'}`}>
            <ChevronRight className="w-5 h-5 shrink-0" />
          </button>
        </div>

        {/* View Toggle */}
        <div className={`flex rounded-xl overflow-hidden ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
          <button
            onClick={() => setViewMode('list')}
            className={`px-3 py-2 inline-flex items-center justify-center text-center gap-1 transition-transform active:scale-95 ${viewMode === 'list' ? 'bg-yellow-400 text-black' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
          >
            <List className="w-4 h-4 shrink-0" />
            {t('reservationsView.view.list', { defaultValue: 'List' })}
          </button>
          <button
            onClick={() => setViewMode('timeline')}
            className={`px-3 py-2 inline-flex items-center justify-center text-center gap-1 transition-transform active:scale-95 ${viewMode === 'timeline' ? 'bg-yellow-400 text-black' : isDark ? 'text-gray-300' : 'text-gray-600'}`}
          >
            <LayoutGrid className="w-4 h-4 shrink-0" />
            {t('reservationsView.view.timeline', { defaultValue: 'Timeline' })}
          </button>
        </div>
      </motion.div>

      {/* Pending Alert */}
      {visibleStats.pending > 0 && (
        <motion.div variants={pageMotionItem} className={`mb-4 p-3 rounded-2xl flex items-center gap-2 ${isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'}`}>
          <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" />
          <span className="text-yellow-600 font-medium">
            {visibleStats.pending} {t('reservationsView.pendingAlert', { defaultValue: 'reservation(s) pending confirmation' })}
          </span>
        </motion.div>
      )}

      {/* Loading State */}
      {isActiveLoading && (activeTab === 'services' ? appointments.length === 0 : reservations.length === 0) && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('reservationsView.loading', { defaultValue: 'Loading reservations...' })}
        </motion.div>
      )}

      {/* Content */}
      {!isActiveLoading && (
        <motion.div variants={pageMotionItem} className="flex-1 overflow-y-auto">
          {activeTab === 'services' ? (
            <motion.div variants={pageMotionContainer} className="space-y-2">
              {appointments.map((appointment) => (
                <motion.div
                  variants={pageMotionItem}
                  key={appointment.id}
                  className={`p-4 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}
                  style={{ borderLeft: `4px solid var(--${appointmentStatusColors[appointment.status]}-500, #6b7280)` }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className={`font-medium text-lg ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {appointment.customerName || t('reservationsView.walkInCustomer', { defaultValue: 'Walk-in customer' })}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium bg-${appointmentStatusColors[appointment.status]}-500/10 text-${appointmentStatusColors[appointment.status]}-500`}>
                          {appointmentStatusLabels[appointment.status]}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 text-sm">
                        <span className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          {formatTime(appointment.startTime, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Scissors className="w-4 h-4" />
                          {appointment.serviceName || appointment.services?.[0]?.serviceName || t('reservationsView.service', { defaultValue: 'Service' })}
                        </span>
                        {appointment.staffName && (
                          <span className="flex items-center gap-1">
                            <Users className="w-4 h-4" />
                            {appointment.staffName}
                          </span>
                        )}
                        {appointment.customerPhone && (
                          <span className="flex items-center gap-1">
                            <Phone className="w-4 h-4" />
                            {appointment.customerPhone}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {getAppointmentQuickActions(appointment).map((action) => (
                        <button
                          key={action.status}
                          onClick={() => void updateAppointmentStatus(appointment.id, action.status)}
                          className={`inline-flex items-center justify-center text-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium transition-transform active:scale-95 ${
                            action.variant === 'primary' ? 'bg-yellow-400 text-black' :
                            action.variant === 'success' ? 'bg-green-600 text-white' :
                            action.variant === 'danger' ? 'bg-red-600 text-white' :
                            isDark ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : viewMode === 'list' ? (
            /* List View */
            <motion.div variants={pageMotionContainer} className="space-y-2">
              {filteredReservations.map(res => (
                <motion.div
                  variants={pageMotionItem}
                  key={res.id}
                  className={`p-4 rounded-2xl cursor-pointer transition-transform active:scale-[0.99] ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'}`}
                  style={{ borderLeft: `4px solid var(--${statusColors[res.status]}-500, #6b7280)` }}
                  onClick={() => openReservationDetails(res.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className={`font-medium text-lg ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {res.customerName}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium bg-${statusColors[res.status]}-500/10 text-${statusColors[res.status]}-500`}>
                          {statusLabels[res.status]}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          {formatTime(res.reservationDatetime, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Users className="w-4 h-4" />
                          {res.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Phone className="w-4 h-4" />
                          {res.customerPhone}
                        </span>
                        {res.tableId && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {t('reservationsView.table', { defaultValue: 'Table' })} {resolveTableLabel(res.tableId, res.tableNumber)}
                          </span>
                        )}
                        {res.roomId && (
                          <span className="flex items-center gap-1">
                            <BedDouble className="w-4 h-4" />
                            {t('reservationsView.room', { defaultValue: 'Room' })} {res.roomNumber || res.roomId.slice(-4)}
                          </span>
                        )}
                        {res.checkInDate && res.checkOutDate && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {formatDate(res.checkInDate)} - {formatDate(res.checkOutDate)}
                          </span>
                        )}
                      </div>
                      {res.specialRequests && (
                        <div className={`mt-2 text-sm ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          {res.specialRequests}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {getQuickActions(res).map(action => (
                        <button
                          key={action.status}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleStatusChange(res.id, action.status);
                          }}
                          className={`inline-flex items-center justify-center text-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium transition-transform active:scale-95 ${
                            action.variant === 'primary' ? 'bg-yellow-400 text-black' :
                            action.variant === 'success' ? 'bg-green-600 text-white' :
                            action.variant === 'danger' ? 'bg-red-600 text-white' :
                            isDark ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          ) : (
            /* Timeline View */
            <motion.div variants={pageMotionContainer} className="grid grid-cols-[60px_1fr] gap-2">
              {timeSlots.map(hour => {
                const hourReservations = reservationsByHour[hour] || [];
                return (
                  <React.Fragment key={hour}>
                    <div className={`text-sm font-medium py-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {hour}:00
                    </div>
                    <div className={`min-h-[60px] p-2 rounded-2xl ${isDark ? 'bg-gray-800/50' : 'bg-gray-50'}`}>
                      <div className="flex flex-wrap gap-2">
                        {hourReservations.map(res => (
                        <motion.div
                          variants={pageMotionItem}
                          key={res.id}
                          className={`px-3 py-2 rounded-xl cursor-pointer transition-transform active:scale-[0.98] ${isDark ? 'bg-gray-700' : 'bg-white shadow-sm'}`}
                          style={{ borderLeft: `4px solid var(--${statusColors[res.status]}-500, #6b7280)` }}
                          onClick={() => openReservationDetails(res.id)}
                        >
                            <div className="flex items-center gap-2">
                              <span className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                {res.customerName}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded bg-${statusColors[res.status]}-500/10 text-${statusColors[res.status]}-500`}>
                                {statusLabels[res.status]}
                              </span>
                            </div>
                            <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                              {res.tableId
                                ? `${t('reservationsView.table', { defaultValue: 'Table' })} ${resolveTableLabel(res.tableId, res.tableNumber)}`
                                : res.roomId
                                  ? `${t('reservationsView.room', { defaultValue: 'Room' })} ${res.roomNumber || res.roomId.slice(-4)}`
                                  : t('reservationsView.noTable', { defaultValue: 'No table' })
                              } • {res.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                            </div>
                            <div className="flex gap-1 mt-2">
                              {getQuickActions(res).slice(0, 2).map(action => (
                                <button
                                  key={action.status}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleStatusChange(res.id, action.status);
                                  }}
                                  className={`inline-flex items-center justify-center text-center px-2 py-1 rounded-2xl text-xs font-medium transition-transform active:scale-95 ${
                                    action.variant === 'primary' ? 'bg-yellow-400 text-black' :
                                    action.variant === 'success' ? 'bg-green-600 text-white' :
                                    action.variant === 'danger' ? 'bg-red-600 text-white' :
                                    isDark ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-800'
                                  }`}
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </motion.div>
          )}

          {(activeTab === 'services' ? appointments.length === 0 : filteredReservations.length === 0) && !isActiveLoading && (
            <motion.div variants={pageMotionItem} className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {activeTab === 'services'
                ? <Scissors className="w-12 h-12 mx-auto mb-4 opacity-50" />
                : <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />}
              <p className="text-lg font-medium mb-2">
                {t('reservationsView.noReservations', { defaultValue: 'No reservations found' })}
              </p>
              <p className="text-sm">
                {t('reservationsView.noReservationsHint', { defaultValue: 'Try selecting a different date or adjusting your search' })}
              </p>
            </motion.div>
          )}
        </motion.div>
      )}

      {showCreateModal && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center">
          <div className={modalScrimClass} onClick={() => setShowCreateModal(false)} />
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={createTitleId}
            className={modalPanelClass}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id={createTitleId} className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('reservationsView.createTitle', { defaultValue: 'Create Reservation' })}
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className={`inline-flex items-center justify-center shrink-0 p-1.5 rounded-full transition-transform active:scale-95 ${isDark ? 'bg-white/5 text-gray-300' : 'bg-black/5 text-gray-600'}`}
              >
                <X className="w-4 h-4 shrink-0" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.customerName', { defaultValue: 'Customer name' })}</span>
                <input
                  value={createForm.customerName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, customerName: event.target.value }))}
                  placeholder={t('reservationsView.form.customerName', { defaultValue: 'Customer name' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.customerPhone', { defaultValue: 'Customer phone' })}</span>
                <input
                  value={createForm.customerPhone}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, customerPhone: event.target.value }))}
                  placeholder={t('reservationsView.form.customerPhone', { defaultValue: 'Customer phone' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.customerEmail', { defaultValue: 'Customer email (optional)' })}</span>
                <input
                  value={createForm.customerEmail}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, customerEmail: event.target.value }))}
                  placeholder={t('reservationsView.form.customerEmail', { defaultValue: 'Customer email (optional)' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.partySize', { defaultValue: 'Party size' })}</span>
                <input
                  value={createForm.partySize}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, partySize: event.target.value }))}
                  placeholder={t('reservationsView.form.partySize', { defaultValue: 'Party size' })}
                  type="number"
                  min={1}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationDate', { defaultValue: 'Reservation date' })}</span>
                <input
                  value={createForm.reservationDate}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, reservationDate: event.target.value }))}
                  type="date"
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationTime', { defaultValue: 'Reservation time' })}</span>
                <input
                  value={createForm.reservationTime}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, reservationTime: event.target.value }))}
                  type="time"
                  className={modalInputClass}
                />
              </label>
              {activeTab === 'tables' && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.duration', { defaultValue: 'Duration (minutes)' })}</span>
                    <input
                      value={createForm.durationMinutes}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, durationMinutes: event.target.value }))}
                      placeholder={t('reservationsView.form.duration', { defaultValue: 'Duration (minutes)' })}
                      type="number"
                      min={15}
                      className={modalInputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.tableOptional', { defaultValue: 'Select a table (optional)' })}</span>
                    <select
                      value={createForm.tableId}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, tableId: event.target.value }))}
                      aria-label={t('reservationsView.form.tableOptional', { defaultValue: 'Select a table (optional)' })}
                      className={modalInputClass}
                    >
                      <option value="">{t('reservationsView.form.tableOptional', { defaultValue: 'Select a table (optional)' })}</option>
                      {tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {formatTableDisplayNumber(table.tableNumber)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {activeTab === 'rooms' && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.room', { defaultValue: 'Room' })}</span>
                    <select
                      value={createForm.roomId}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, roomId: event.target.value }))}
                      aria-label={t('reservationsView.form.room', { defaultValue: 'Room' })}
                      className={modalInputClass}
                    >
                      <option value="">{t('reservationsView.form.selectRoom', { defaultValue: 'Select a room' })}</option>
                      {rooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {roomOptionLabel(room)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.checkInDate', { defaultValue: 'Check-in date' })}</span>
                    <input
                      value={createForm.checkInDate}
                      onChange={(event) => setCreateForm((prev) => ({
                        ...prev,
                        checkInDate: event.target.value,
                        reservationDate: event.target.value,
                      }))}
                      type="date"
                      aria-label={t('reservationsView.form.checkInDate', { defaultValue: 'Check-in date' })}
                      className={modalInputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.checkOutDate', { defaultValue: 'Check-out date' })}</span>
                    <input
                      value={createForm.checkOutDate}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, checkOutDate: event.target.value }))}
                      type="date"
                      aria-label={t('reservationsView.form.checkOutDate', { defaultValue: 'Check-out date' })}
                      className={modalInputClass}
                    />
                  </label>
                </>
              )}
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.specialRequests', { defaultValue: 'Special requests (optional)' })}</span>
                <input
                  value={createForm.specialRequests}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, specialRequests: event.target.value }))}
                  placeholder={t('reservationsView.form.specialRequests', { defaultValue: 'Special requests (optional)' })}
                  className={modalInputClass}
                />
              </label>
            </div>

            <label className="mt-3 flex flex-col gap-1">
              <span className={fieldLabelClass}>{t('reservationsView.form.notes', { defaultValue: 'Notes (optional)' })}</span>
              <textarea
                value={createForm.notes}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, notes: event.target.value }))}
                placeholder={t('reservationsView.form.notes', { defaultValue: 'Notes (optional)' })}
                rows={3}
                className={`w-full ${modalInputClass}`}
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowCreateModal(false)}
                className={`inline-flex items-center justify-center text-center gap-2 min-h-[44px] px-4 py-2 rounded-xl transition-transform active:scale-95 border ${isDark ? 'bg-red-500/25 text-red-200 border-red-400/40 active:bg-red-500/35' : 'bg-red-500/20 text-red-900 border-red-500/50 active:bg-red-500/30'}`}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={() => void handleCreateReservation()}
                disabled={isCreating || !isCreateReservationReady}
                className={`inline-flex items-center justify-center text-center gap-2 min-h-[44px] px-4 py-2 rounded-xl transition-transform active:scale-95 border disabled:active:scale-100 disabled:cursor-not-allowed ${isDark ? 'bg-green-500/25 text-green-200 border-green-500/45 active:bg-green-500/35 disabled:bg-white/5 disabled:text-gray-500 disabled:border-white/10' : 'bg-green-500/25 text-green-900 border-green-600/50 active:bg-green-500/35 disabled:bg-gray-200/70 disabled:text-gray-500 disabled:border-gray-300/80'}`}
              >
                {isCreating
                  ? t('common.creating', { defaultValue: 'Creating...' })
                  : t('reservationsView.create', { defaultValue: 'Create' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {showServiceModal && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex items-center justify-center">
          <div className={modalScrimClass} onClick={closeServiceModal} />
          <div
            ref={serviceDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={serviceTitleId}
            className={modalPanelClass}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id={serviceTitleId} className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('reservationsView.createServiceTitle', { defaultValue: 'Create Service Booking' })}
              </h3>
              <button
                onClick={closeServiceModal}
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className={`inline-flex items-center justify-center shrink-0 p-1.5 rounded-full transition-transform active:scale-95 ${isDark ? 'bg-white/5 text-gray-300' : 'bg-black/5 text-gray-600'}`}
              >
                <X className="w-4 h-4 shrink-0" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.customerName', { defaultValue: 'Customer name' })}</span>
                <input
                  value={serviceForm.customerName}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, customerName: event.target.value }))}
                  placeholder={t('reservationsView.form.customerName', { defaultValue: 'Customer name' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.customerPhone', { defaultValue: 'Customer phone' })}</span>
                <input
                  value={serviceForm.customerPhone}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, customerPhone: event.target.value }))}
                  placeholder={t('reservationsView.form.customerPhone', { defaultValue: 'Customer phone' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.service', { defaultValue: 'Service' })}</span>
                <select
                  value={serviceForm.serviceId}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, serviceId: event.target.value }))}
                  aria-label={t('reservationsView.form.service', { defaultValue: 'Service' })}
                  className={modalInputClass}
                >
                  <option value="">{t('reservationsView.form.selectService', { defaultValue: 'Select a service' })}</option>
                  {serviceCatalog.map((service) => (
                    <option key={service.id} value={service.id}>{service.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.staff', { defaultValue: 'Staff' })}</span>
                <select
                  value={serviceForm.staffId}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, staffId: event.target.value }))}
                  aria-label={t('reservationsView.form.staff', { defaultValue: 'Staff' })}
                  className={modalInputClass}
                >
                  <option value="">{t('reservationsView.form.selectStaff', { defaultValue: 'Select staff' })}</option>
                  {serviceStaffList.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationDate', { defaultValue: 'Reservation date' })}</span>
                <input
                  value={serviceForm.date}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, date: event.target.value }))}
                  type="date"
                  aria-label={t('reservationsView.form.reservationDate', { defaultValue: 'Reservation date' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationTime', { defaultValue: 'Reservation time' })}</span>
                <input
                  value={serviceForm.time}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, time: event.target.value }))}
                  type="time"
                  aria-label={t('reservationsView.form.reservationTime', { defaultValue: 'Reservation time' })}
                  className={modalInputClass}
                />
              </label>
            </div>

            <label className="mt-3 flex flex-col gap-1">
              <span className={fieldLabelClass}>{t('reservationsView.form.notes', { defaultValue: 'Notes (optional)' })}</span>
              <textarea
                value={serviceForm.notes}
                onChange={(event) => setServiceForm((prev) => ({ ...prev, notes: event.target.value }))}
                placeholder={t('reservationsView.form.notes', { defaultValue: 'Notes (optional)' })}
                rows={3}
                className={`w-full ${modalInputClass}`}
              />
            </label>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={closeServiceModal}
                className={`inline-flex items-center justify-center text-center gap-2 min-h-[44px] px-4 py-2 rounded-xl transition-transform active:scale-95 border ${isDark ? 'bg-red-500/25 text-red-200 border-red-400/40 active:bg-red-500/35' : 'bg-red-500/20 text-red-900 border-red-500/50 active:bg-red-500/30'}`}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={() => void handleCreateServiceBooking()}
                disabled={isCreatingService}
                className={`inline-flex items-center justify-center text-center gap-2 min-h-[44px] px-4 py-2 rounded-xl transition-transform active:scale-95 border disabled:opacity-60 ${isDark ? 'bg-green-500/25 text-green-200 border-green-500/45 active:bg-green-500/35' : 'bg-green-500/25 text-green-900 border-green-600/50 active:bg-green-500/35'}`}
              >
                {isCreatingService
                  ? t('common.creating', { defaultValue: 'Creating...' })
                  : t('reservationsView.create', { defaultValue: 'Create' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {(selectedReservation || isDetailsLoading) && renderModalPortal(
        <div className="fixed inset-0 z-[1200] flex justify-end">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setSelectedReservation(null)} />
          <div className={`relative h-full w-full max-w-xl p-4 overflow-y-auto rounded-l-[26px] backdrop-blur-2xl shadow-2xl ${isDark ? 'bg-gray-900/85 border-l border-white/10' : 'bg-white/85 border-l border-white/60'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('reservationsView.detailTitle', { defaultValue: 'Reservation Details' })}
              </h3>
              <button
                onClick={() => setSelectedReservation(null)}
                className={`inline-flex items-center justify-center shrink-0 p-1.5 rounded-full transition-transform active:scale-95 ${isDark ? 'bg-white/5 text-gray-300' : 'bg-black/5 text-gray-600'}`}
              >
                <X className="w-4 h-4 shrink-0" />
              </button>
            </div>

            {isDetailsLoading && (
              <div className={`flex items-center ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                {t('common.loading', { defaultValue: 'Loading...' })}
              </div>
            )}

            {!isDetailsLoading && selectedReservation && (
              <div className="space-y-4">
                <div className={`p-3 rounded-2xl ${isDark ? 'bg-gray-800/70' : 'bg-gray-50/80'}`}>
                  <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('reservationsView.customer', { defaultValue: 'Customer' })}
                  </div>
                  <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedReservation.customerName}</div>
                  <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{selectedReservation.customerPhone}</div>
                  {selectedReservation.customerEmail && (
                    <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{selectedReservation.customerEmail}</div>
                  )}
                </div>

                <div className={`p-3 rounded-2xl ${isDark ? 'bg-gray-800/70' : 'bg-gray-50/80'}`}>
                  <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('reservationsView.when', { defaultValue: 'Date & Time' })}
                  </div>
                  <div className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {/* Use the same normalized datetime as list/timeline so the same
                        reservation shows the same local time everywhere (the raw
                        reservationDate/reservationTime fields can be UTC/service values). */}
                    {formatDate(selectedReservation.reservationDatetime)} {formatTime(selectedReservation.reservationDatetime, { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    {selectedReservation.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                  </div>
                </div>

                {selectedReservation.specialRequests && (
                  <div className={`p-3 rounded-2xl ${isDark ? 'bg-gray-800/70' : 'bg-gray-50/80'}`}>
                    <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {t('reservationsView.specialRequests', { defaultValue: 'Special Requests' })}
                    </div>
                    <div className={`${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedReservation.specialRequests}</div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('reservationsView.quickActions', { defaultValue: 'Quick Actions' })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {getQuickActions(selectedReservation).map((action) => (
                      <button
                        key={action.status}
                        onClick={() => void handleStatusChange(selectedReservation.id, action.status)}
                        className={`inline-flex items-center justify-center text-center gap-2 px-3 py-1.5 rounded-xl text-sm font-medium transition-transform active:scale-95 ${
                          action.variant === 'primary' ? 'bg-yellow-400 text-black' :
                          action.variant === 'success' ? 'bg-green-600 text-white' :
                          action.variant === 'danger' ? 'bg-red-600 text-white' :
                          isDark ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-800'
                        }`}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>

                {!selectedReservation.roomId && (
                <div className={`p-3 rounded-2xl ${isDark ? 'bg-gray-800/70' : 'bg-gray-50/80'}`}>
                  <div className={`text-sm mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t('reservationsView.assignTable', { defaultValue: 'Assign Table' })}
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={tableAssignmentId}
                      onChange={(event) => setTableAssignmentId(event.target.value)}
                      aria-label={t('reservationsView.assignTable', { defaultValue: 'Assign Table' })}
                      className={`flex-1 ${modalInputClass}`}
                    >
                      <option value="">{t('reservationsView.selectTable', { defaultValue: 'Select a table' })}</option>
                      {tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {formatTableDisplayNumber(table.tableNumber)}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={isAssigningTable || !tableAssignmentId.trim()}
                      onClick={() => void handleAssignTable()}
                      className="inline-flex items-center justify-center text-center gap-2 min-h-[40px] px-3 py-2 rounded-xl bg-yellow-400 text-black transition-transform active:scale-95 disabled:opacity-60"
                    >
                      {isAssigningTable
                        ? t('common.saving', { defaultValue: 'Saving...' })
                        : t('common.save', { defaultValue: 'Save' })}
                    </button>
                  </div>
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
});

ReservationsView.displayName = 'ReservationsView';
export default ReservationsView;
