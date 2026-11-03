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
import { useModules } from '../../../contexts/module-context';
import { useAcquiredModules } from '../../../hooks/useAcquiredModules';
import { useSystemClock } from '../../../hooks/useSystemClock';
import { useReservations } from '../../../hooks/useReservations';
import { useAppointments } from '../../../hooks/useAppointments';
import { useTables } from '../../../hooks/useTables';
import { useRooms } from '../../../hooks/useRooms';
import { formatTableDisplayNumber } from '../../../utils/table-display';
import { RoomCheckinModal, RoomReservationModal } from '../../../components/modals/RoomStayWorkflowModals';
import { reservationWallDateTime, roomStayNights } from '../../../utils/room-workflow';
import { buildReservationTimelineSlots } from '../../../utils/reservationTimeline';
import { formatCurrency, formatDate, formatTime } from '../../../utils/format';
import { addLocalDays, parseLocalDateString, startOfLocalDay, toLocalDateString } from '../../../utils/date';
import {
  Calendar,
  CheckCircle2,
  UserCheck,
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
import { KitDateField } from '../../../components/ui/KitDateField';

type QuickFilter = 'today' | 'tomorrow' | 'week' | 'custom';
type ViewMode = 'timeline' | 'list';
type ReservationTab = 'tables' | 'rooms' | 'services';

// Founder 01/11: a status is a coloured word (no pill, no coloured stripe). Waiting = warn, under way = ok,
// a problem = bad, a closed booking = muted, a confirmed one = plain words. Same mapping as the Android till.
const statusTextClass: Record<ReservationStatus, string> = {
  confirmed: 'text-(--pos-s-fg)',
  pending: 'text-(--pos-s-warn)',
  seated: 'text-(--pos-s-ok)',
  completed: 'text-(--pos-s-muted)',
  no_show: 'text-(--pos-s-bad)',
  cancelled: 'text-(--pos-s-muted)',
};

const appointmentStatusTextClass: Record<AppointmentStatus, string> = {
  scheduled: 'text-(--pos-s-warn)',
  confirmed: 'text-(--pos-s-fg)',
  in_progress: 'text-(--pos-s-ok)',
  completed: 'text-(--pos-s-muted)',
  cancelled: 'text-(--pos-s-muted)',
  no_show: 'text-(--pos-s-bad)',
};

// The forward step of a booking (Confirm / Seat / Complete / Check in) is the yellow primary of its card; No Show
// and Cancel are neutral kit buttons with red words.
const quickActionClass = (variant: string): string => {
  if (variant === 'primary' || variant === 'success') return 'pos-solid-btn pos-solid-btn--sm pos-solid-btn--primary';
  if (variant === 'danger') return 'pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger';
  return 'pos-solid-btn pos-solid-btn--sm';
};

export const ReservationsView: React.FC = memo(() => {
  const { t } = useTranslation();
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
  const [roomWorkflow, setRoomWorkflow] = useState<{ reservation: Reservation; mode: 'arrival' | 'edit' } | null>(null);
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

  // Founder 01/11: the page and its windows in the kit — a pos-card hero, kit options and buttons, the shared
  // glass shell for every window, and ONE kit field look for every input, select and KitDateField.
  // Shared class for the visible field labels in the create-reservation modal so
  // prefilled controls (party size, duration, date/time) are never left as a bare
  // value with only a placeholder for context.
  const fieldLabelClass = 'text-sm font-semibold text-(--pos-s-fg)';
  // The kit field (solid kit surface, kit border, yellow focus). The toolbar uses it at its own width.
  const kitFieldLook = 'min-h-[48px] rounded-xl border border-(--pos-s-control) bg-(--pos-s-surface) px-3 text-base font-semibold text-(--pos-s-fg) outline-hidden transition-colors placeholder:font-normal placeholder:text-zinc-400 focus:border-(--pos-s-yellow) dark:placeholder:text-zinc-500';
  // Shared input/select class for the create + service-booking modal controls.
  const modalInputClass = `w-full ${kitFieldLook}`;
  // The shared glass window: shell + backdrop, a header and a footer separated by the glass line, a scrolling body.
  const modalPanelClass = 'liquid-glass-modal-shell relative flex w-full max-w-2xl flex-col text-(--pos-s-fg)';
  const modalScrimClass = 'liquid-glass-modal-backdrop';
  const modalHeaderClass = 'flex shrink-0 items-start justify-between gap-3 border-b border-(--modal-glass-line) p-5';
  const modalBodyClass = 'min-h-0 flex-1 overflow-y-auto scrollbar-hide p-5';
  const modalFooterClass = 'flex shrink-0 items-center justify-end gap-3 border-t border-(--modal-glass-line) p-5';
  const primaryButtonClass = 'pos-solid-btn pos-solid-btn--md pos-solid-btn--primary';
  const secondaryButtonClass = 'pos-solid-btn pos-solid-btn--md';
  // Stat tiles and inner fact tiles: the neutral kit tile.
  const tileClass = 'rounded-xl border border-(--pos-s-border) bg-(--pos-s-surface-2) p-3';
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
        roomStayNights(createForm.checkInDate, createForm.checkOutDate) > 0));

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
  const { rooms, refetch: refetchRooms, updateStatus: updateRoomStatus } = useRooms({
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
    seated: activeTab === 'rooms' ? t('roomWorkflow.staying') : t('reservationsView.status.seated', { defaultValue: 'Seated' }),
    completed: activeTab === 'rooms' ? t('roomWorkflow.departed') : t('reservationsView.status.completed', { defaultValue: 'Completed' }),
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
    const target = reservations.find((item) => item.id === reservationId) || selectedReservation;
    if (target?.roomId && status === 'seated') {
      if (!rooms.some((room) => room.id === target.roomId)) {
        toast.error(t('roomsView.toasts.roomNotFound'));
        return;
      }
      setRoomWorkflow({ reservation: target, mode: 'arrival' });
      setSelectedReservation(null);
      return;
    }
    if (target?.tableId && !target.roomId && status === 'seated') {
      try {
        reservationsService.setContext(branchId || '', effectiveOrgId || '');
        const seated = await reservationsService.seatReservation(reservationId);
        reservationsService.continueSeatedReservation(seated);
        setSelectedReservation(null);
      } catch (error) {
        toast.error(t('reservationsView.toasts.updateFailed', { defaultValue: 'Failed to update reservation' }));
      }
      return;
    }
    const updated = await updateStatus(reservationId, status);
    if (!updated) return;

    if (selectedReservation?.id === reservationId) {
      reservationsService.setContext(branchId || '', effectiveOrgId || '');
      const refreshed = await reservationsService.fetchReservationById(reservationId);
      if (refreshed) {
        setSelectedReservation(refreshed);
      }
    }
  }, [updateStatus, selectedReservation, reservations, rooms, branchId, effectiveOrgId, t]);

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

    if (activeTab === 'rooms' && (!createForm.roomId.trim() || !roomStayNights(createForm.checkInDate, createForm.checkOutDate))) {
      toast.error(t('roomWorkflow.invalidDates'));
      return;
    }

    const payload: CreateReservationDto = {
      reservationType: activeTab === 'rooms' ? 'room' : 'table',
      customerName: createForm.customerName.trim(),
      customerPhone: createForm.customerPhone.trim(),
      customerEmail: createForm.customerEmail.trim() || undefined,
      partySize,
      reservationDate: activeTab === 'rooms' ? createForm.checkInDate : createForm.reservationDate,
      reservationTime: createForm.reservationTime,
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
        filteredReservations.map((res) => new Date(reservationWallDateTime(res)).getHours()),
      ),
    [filteredReservations],
  );

  // Group filtered reservations by hour for timeline view. Buckets are created on
  // demand so a reservation hour is never silently dropped from the grouping.
  const reservationsByHour = useMemo(() => {
    const grouped: Record<number, Reservation[]> = {};
    timeSlots.forEach((hour) => { grouped[hour] = []; });

    filteredReservations.forEach((res) => {
      const hour = new Date(reservationWallDateTime(res)).getHours();
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
      actions.push({ label: reservation.roomId ? t('roomWorkflow.arrival') : t('reservationsView.actions.seat', { defaultValue: 'Seat' }), status: 'seated', variant: 'success' });
    }
    if (reservation.status === 'seated') {
      actions.push({ label: reservation.roomId ? t('roomWorkflow.departure') : t('reservationsView.actions.complete', { defaultValue: 'Complete' }), status: 'completed', variant: 'primary' });
    }
    if (['pending', 'confirmed'].includes(reservation.status)) {
      actions.push({ label: t('reservationsView.actions.noShow', { defaultValue: 'No Show' }), status: 'no_show', variant: 'danger' });
      actions.push({ label: t('roomWorkflow.cancelBooking'), status: 'cancelled', variant: 'danger' });
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
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex items-center justify-center text-(--pos-s-muted)">
        {t('reservationsView.noBranch', { defaultValue: 'Please select a branch to view reservations' })}
      </motion.div>
    );
  }

  // Show message if neither module is acquired
  if (availableReservationTabs.length === 0) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col items-center justify-center text-(--pos-s-muted)">
        <Calendar className="w-16 h-16 mb-4 text-(--pos-s-muted)" aria-hidden="true" />
        <p className="text-lg font-semibold mb-2 text-(--pos-s-fg)">
          {t('reservationsView.noModules', { defaultValue: 'No reservation modules available' })}
        </p>
        <p className="text-sm text-center max-w-md">
          {t('reservationsView.noModulesHint', { defaultValue: 'Please acquire Tables, Rooms, or Services to manage reservations.' })}
        </p>
      </motion.div>
    );
  }

  // Founder 01/11: each stat tile is a neutral icon, a muted label and a big number; only a number that states
  // something is coloured (pending > 0 warn, seated/staying > 0 ok), a zero stays neutral.
  const statTiles = [
    { key: 'total', label: t('reservationsView.stats.total', { defaultValue: 'Total' }), value: visibleStats.total, icon: Calendar, toneClass: '' },
    { key: 'pending', label: t('reservationsView.stats.pending', { defaultValue: 'Pending' }), value: visibleStats.pending, icon: Clock, toneClass: visibleStats.pending > 0 ? 'text-(--pos-s-warn)' : '' },
    { key: 'confirmed', label: t('reservationsView.stats.confirmed', { defaultValue: 'Confirmed' }), value: visibleStats.confirmed, icon: CheckCircle2, toneClass: '' },
    { key: 'seated', label: activeTab === 'rooms' ? t('roomWorkflow.staying') : t('reservationsView.stats.seated', { defaultValue: 'Seated' }), value: visibleStats.seated, icon: UserCheck, toneClass: visibleStats.seated > 0 ? 'text-(--pos-s-ok)' : '' },
    { key: 'guests', label: t('reservationsView.stats.guests', { defaultValue: 'Guests' }), value: visibleStats.totalGuests, icon: Users, toneClass: '' },
  ];

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-4 text-(--pos-s-fg)">
      {/* Founder 01/11: the hero pattern — title + one muted line on the left, the actions on the right (the
          refresh icon button and the one yellow primary), the stat tiles under it, then the toolbar of kit options. */}
      <motion.section
        variants={pageMotionItem}
        data-vertical-hero="reservations"
        className="pos-card mb-4 p-4"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-bold tracking-tight text-(--pos-s-fg)">
              {t('navigation.menu.reservations', { defaultValue: 'Reservations' })}
            </h1>
            {/* The one muted line names which reservations the page shows. */}
            <p className="mt-1 flex items-center gap-2 text-sm text-(--pos-s-muted)">
              {activeTab === 'tables' ? (
                <>
                  <TableOrderIcon className="w-4 h-4 shrink-0 text-(--pos-s-muted)" />
                  <span className="truncate">{t('reservationsView.headers.tables', { defaultValue: 'Table Reservations' })}</span>
                </>
              ) : activeTab === 'rooms' ? (
                <>
                  <BedDouble className="w-4 h-4 shrink-0 text-(--pos-s-muted)" />
                  <span className="truncate">{t('reservationsView.headers.rooms', { defaultValue: 'Room Reservations' })}</span>
                </>
              ) : (
                <>
                  <Scissors className="w-4 h-4 shrink-0 text-(--pos-s-muted)" />
                  <span className="truncate">{t('reservationsView.headers.services', { defaultValue: 'Service Reservations' })}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (activeTab === 'services') {
                  void refetchAppointments();
                } else {
                  void refetch();
                }
              }}
              className="pos-icon-btn"
              aria-label={t('reservationsView.refresh', { defaultValue: 'Refresh' })}
            >
              <RefreshCw className={`w-5 h-5 shrink-0 ${isActiveLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
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
              className={primaryButtonClass}
              aria-label={activeTab === 'services' && !hasServiceReservations
                ? t('reservationsView.createServiceInAppointments', { defaultValue: 'Create service bookings from Appointments' })
                : activeTab === 'services'
                  ? t('reservationsView.createServiceTitle', { defaultValue: 'Create Service Booking' })
                  : t('reservationsView.createTitle', { defaultValue: 'Create Reservation' })}
            >
              <Plus className="w-4 h-4 shrink-0" />
              {t('reservationsView.create', { defaultValue: 'Create' })}
            </button>
          </div>
        </div>

        <motion.div variants={pageMotionContainer} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {statTiles.map((tile) => {
            const Icon = tile.icon;
            return (
              <motion.div variants={pageMotionItem} key={tile.key} className={tileClass}>
                <p className="truncate text-sm text-(--pos-s-muted)">{tile.label}</p>
                <p className={`mt-1 inline-flex items-center gap-2 text-2xl font-bold ${tile.toneClass}`}>
                  <Icon className="h-5 w-5 shrink-0 text-(--pos-s-muted)" aria-hidden="true" />
                  {tile.value}
                </p>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Toolbar: the module switch (only when more than one module is acquired) and the search field. */}
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {availableReservationTabs.length > 1 && (
            <motion.div variants={pageMotionContainer} className="pos-scroll-row gap-2">
              {availableReservationTabs.map((tab) => {
                const Icon = tab === 'rooms' ? BedDouble : tab === 'services' ? Scissors : TableOrderIcon;
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
                    type="button"
                    onClick={() => setActiveTab(tab)}
                    aria-pressed={activeTab === tab}
                    className={`pos-choice${activeTab === tab ? ' is-selected' : ''}`}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    {tab === 'rooms'
                      ? t('reservationsView.tabs.rooms', { defaultValue: 'Rooms' })
                      : tab === 'services'
                        ? t('reservationsView.tabs.services', { defaultValue: 'Services' })
                        : t('reservationsView.tabs.tables', { defaultValue: 'Tables' })}
                    {/* The count is plain words, no pill. */}
                    <span className="tabular-nums">{count}</span>
                  </motion.button>
                );
              })}
            </motion.div>
          )}
          <div className="relative min-w-0 lg:ml-auto lg:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-(--pos-s-muted)" aria-hidden="true" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('reservationsView.searchPlaceholder', { defaultValue: 'Search...' })}
              className={`w-full pl-10 ${kitFieldLook}`}
            />
          </div>
        </div>

        {/* Toolbar: the period (kit options), the day (arrows + the kit date field) and the view (kit options). */}
        <motion.div variants={pageMotionItem} className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <motion.div variants={pageMotionContainer} className="pos-scroll-row gap-2">
            {(['today', 'tomorrow', 'week'] as const).map(filter => (
              <motion.button
                variants={pageMotionItem}
                key={filter}
                type="button"
                onClick={() => handleQuickFilter(filter)}
                aria-pressed={quickFilter === filter}
                className={`pos-choice${quickFilter === filter ? ' is-selected' : ''}`}
              >
                {t(`reservationsView.filter.${filter}`, { defaultValue: filter.charAt(0).toUpperCase() + filter.slice(1) })}
              </motion.button>
            ))}
          </motion.div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateDate('prev')}
              aria-label={t('reservationsView.dateNavigation.previous', { defaultValue: 'Previous Day' })}
              className="pos-icon-btn"
            >
              <ChevronLeft className="w-5 h-5 shrink-0" />
            </button>
            <KitDateField
              type="date" required
              value={toLocalDateString(selectedDate)}
              onChange={(e) => {
                const parsed = parseLocalDateString(e.target.value);
                if (Number.isNaN(parsed.getTime())) return;
                setSelectedDate(parsed);
                setQuickFilter('custom');
              }}
              className={`w-44 ${kitFieldLook}`}
            />
            <button
              type="button"
              onClick={() => navigateDate('next')}
              aria-label={t('reservationsView.dateNavigation.next', { defaultValue: 'Next Day' })}
              className="pos-icon-btn"
            >
              <ChevronRight className="w-5 h-5 shrink-0" />
            </button>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              className={`pos-choice${viewMode === 'list' ? ' is-selected' : ''}`}
            >
              <List className="w-4 h-4 shrink-0" />
              {t('reservationsView.view.list', { defaultValue: 'List' })}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('timeline')}
              aria-pressed={viewMode === 'timeline'}
              className={`pos-choice${viewMode === 'timeline' ? ' is-selected' : ''}`}
            >
              <LayoutGrid className="w-4 h-4 shrink-0" />
              {t('reservationsView.view.timeline', { defaultValue: 'Timeline' })}
            </button>
          </div>
        </motion.div>
      </motion.section>

      {/* Pending Alert: a kit warn notice */}
      {visibleStats.pending > 0 && (
        <motion.div variants={pageMotionItem} className="pos-notice pos-notice--warn mb-4 items-center">
          <AlertTriangle className="pos-notice__icon w-5 h-5 shrink-0" aria-hidden="true" />
          <span className="font-semibold text-(--pos-s-fg)">
            {visibleStats.pending} {t('reservationsView.pendingAlert', { defaultValue: 'reservation(s) pending confirmation' })}
          </span>
        </motion.div>
      )}

      {/* Loading State */}
      {isActiveLoading && (activeTab === 'services' ? appointments.length === 0 : reservations.length === 0) && (
        <motion.div variants={pageMotionItem} className="flex-1 flex items-center justify-center text-(--pos-s-muted)">
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('reservationsView.loading', { defaultValue: 'Loading reservations...' })}
        </motion.div>
      )}

      {/* Content: kit cards in a responsive grid; the scroll column keeps room for their shadows. */}
      {!isActiveLoading && (
        <motion.div variants={pageMotionItem} className="pos-scroll-room flex-1 overflow-y-auto scrollbar-hide pb-6">
          {activeTab === 'services' ? (
            <motion.div variants={pageMotionContainer} className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {appointments.map((appointment) => (
                <motion.div
                  variants={pageMotionItem}
                  key={appointment.id}
                  className="pos-card flex flex-col gap-3 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-lg font-semibold text-(--pos-s-fg)">
                      {appointment.customerName || t('reservationsView.walkInCustomer', { defaultValue: 'Walk-in customer' })}
                    </span>
                    <span className={`shrink-0 text-sm font-semibold ${appointmentStatusTextClass[appointment.status]}`}>
                      {appointmentStatusLabels[appointment.status]}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-(--pos-s-muted)">
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
                  {getAppointmentQuickActions(appointment).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {getAppointmentQuickActions(appointment).map((action) => (
                        <button
                          key={action.status}
                          type="button"
                          onClick={() => void updateAppointmentStatus(appointment.id, action.status)}
                          className={quickActionClass(action.variant)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </motion.div>
              ))}
            </motion.div>
          ) : viewMode === 'list' ? (
            /* List View */
            <motion.div variants={pageMotionContainer} className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {filteredReservations.map(res => (
                <motion.div
                  variants={pageMotionItem}
                  key={res.id}
                  className="pos-card flex cursor-pointer flex-col gap-3 p-4 transition-transform active:scale-[0.99]"
                  onClick={() => openReservationDetails(res.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-lg font-semibold text-(--pos-s-fg)">
                      {res.customerName}
                    </span>
                    <span className={`shrink-0 text-sm font-semibold ${statusTextClass[res.status]}`}>
                      {statusLabels[res.status]}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-(--pos-s-muted)">
                    <span className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      {formatTime(reservationWallDateTime(res), { hour: '2-digit', minute: '2-digit' })}
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
                    <div className={`flex items-start gap-2 text-sm text-(--pos-s-fg) ${tileClass}`}>
                      <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0 text-(--pos-s-muted)" aria-hidden="true" />
                      <span className="min-w-0 wrap-break-word">{res.specialRequests}</span>
                    </div>
                  )}
                  {getQuickActions(res).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {getQuickActions(res).map(action => (
                        <button
                          key={action.status}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleStatusChange(res.id, action.status);
                          }}
                          className={quickActionClass(action.variant)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
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
                    <div className="text-sm font-semibold py-2 text-(--pos-s-muted)">
                      {hour}:00
                    </div>
                    <div className={`min-h-[60px] ${tileClass} p-2`}>
                      <div className="flex flex-wrap gap-2">
                        {hourReservations.map(res => (
                        <motion.div
                          variants={pageMotionItem}
                          key={res.id}
                          className="pos-card cursor-pointer px-3 py-2 transition-transform active:scale-[0.98]"
                          onClick={() => openReservationDetails(res.id)}
                        >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-(--pos-s-fg)">
                                {res.customerName}
                              </span>
                              <span className={`text-xs font-semibold ${statusTextClass[res.status]}`}>
                                {statusLabels[res.status]}
                              </span>
                            </div>
                            <div className="text-xs mt-1 text-(--pos-s-muted)">
                              {res.tableId
                                ? `${t('reservationsView.table', { defaultValue: 'Table' })} ${resolveTableLabel(res.tableId, res.tableNumber)}`
                                : res.roomId
                                  ? `${t('reservationsView.room', { defaultValue: 'Room' })} ${res.roomNumber || res.roomId.slice(-4)}`
                                  : t('reservationsView.noTable', { defaultValue: 'No table' })
                              } • {res.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                            </div>
                            {getQuickActions(res).length > 0 && (
                              <div className="flex flex-wrap gap-2 mt-2">
                                {getQuickActions(res).slice(0, 2).map(action => (
                                  <button
                                    key={action.status}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleStatusChange(res.id, action.status);
                                    }}
                                    className={quickActionClass(action.variant)}
                                  >
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </motion.div>
          )}

          {/* Empty state: a neutral icon (no wrapper box), one title, one muted line. */}
          {(activeTab === 'services' ? appointments.length === 0 : filteredReservations.length === 0) && !isActiveLoading && (
            <motion.div variants={pageMotionItem} className="text-center py-12 text-(--pos-s-muted)">
              {activeTab === 'services'
                ? <Scissors className="w-12 h-12 mx-auto mb-4 text-(--pos-s-muted)" aria-hidden="true" />
                : <Calendar className="w-12 h-12 mx-auto mb-4 text-(--pos-s-muted)" aria-hidden="true" />}
              <p className="text-lg font-semibold mb-2 text-(--pos-s-fg)">
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
        <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">
          <div className={modalScrimClass} onClick={() => setShowCreateModal(false)} aria-hidden="true" />
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={createTitleId}
            className={modalPanelClass}
          >
            <div className={modalHeaderClass}>
              <h3 id={createTitleId} className="text-2xl font-semibold text-(--pos-s-fg)">
                {t('reservationsView.createTitle', { defaultValue: 'Create Reservation' })}
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                aria-label={t('common.actions.close', 'Close')}
                className="liquid-glass-modal-close"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className={modalBodyClass}>
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
                <span className={fieldLabelClass}>{t('reservationsView.form.customerPhone', { defaultValue: 'Customer phone' })} *</span>
                <input
                  required
                  type="tel"
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
              {activeTab !== 'rooms' && <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationDate', { defaultValue: 'Reservation date' })}</span>
                <KitDateField
                  value={createForm.reservationDate}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, reservationDate: event.target.value }))}
                  type="date" required
                  className={modalInputClass}
                />
              </label>}
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationTime', { defaultValue: 'Reservation time' })}</span>
                <KitDateField
                  value={createForm.reservationTime}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, reservationTime: event.target.value }))}
                  type="time" required
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
                    <KitDateField
                      value={createForm.checkInDate}
                      onChange={(event) => setCreateForm((prev) => ({
                        ...prev,
                        checkInDate: event.target.value,
                        reservationDate: event.target.value,
                      }))}
                      type="date" required
                      aria-label={t('reservationsView.form.checkInDate', { defaultValue: 'Check-in date' })}
                      className={modalInputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={fieldLabelClass}>{t('reservationsView.form.checkOutDate', { defaultValue: 'Check-out date' })}</span>
                    <KitDateField
                      value={createForm.checkOutDate}
                      onChange={(event) => setCreateForm((prev) => ({ ...prev, checkOutDate: event.target.value }))}
                      type="date" required
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
                className={`resize-none py-2.5 ${modalInputClass}`}
              />
            </label>

            {/* The stay cost is a plain fact in a frost section (the money keeps its words). */}
            {activeTab === 'rooms' && <p className="pos-frost mt-3 rounded-xl border px-3 py-2 text-sm font-semibold text-(--pos-s-fg)" aria-live="polite">
              {roomStayNights(createForm.checkInDate, createForm.checkOutDate) > 0
                ? t('roomWorkflow.costPreview', {
                    nights: roomStayNights(createForm.checkInDate, createForm.checkOutDate),
                    rate: formatCurrency(rooms.find((room) => room.id === createForm.roomId)?.ratePerNight || 0),
                    total: formatCurrency(roomStayNights(createForm.checkInDate, createForm.checkOutDate) * (rooms.find((room) => room.id === createForm.roomId)?.ratePerNight || 0)),
                  }) : t('roomWorkflow.invalidDates')}
            </p>}
            </div>

            <div className={modalFooterClass}>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className={secondaryButtonClass}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={() => void handleCreateReservation()}
                disabled={isCreating || !isCreateReservationReady}
                className={primaryButtonClass}
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
        <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">
          <div className={modalScrimClass} onClick={closeServiceModal} aria-hidden="true" />
          <div
            ref={serviceDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={serviceTitleId}
            className={modalPanelClass}
          >
            <div className={modalHeaderClass}>
              <h3 id={serviceTitleId} className="text-2xl font-semibold text-(--pos-s-fg)">
                {t('reservationsView.createServiceTitle', { defaultValue: 'Create Service Booking' })}
              </h3>
              <button
                type="button"
                onClick={closeServiceModal}
                aria-label={t('common.close', { defaultValue: 'Close' })}
                className="liquid-glass-modal-close"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className={modalBodyClass}>
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
                <KitDateField
                  value={serviceForm.date}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, date: event.target.value }))}
                  type="date" required
                  aria-label={t('reservationsView.form.reservationDate', { defaultValue: 'Reservation date' })}
                  className={modalInputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={fieldLabelClass}>{t('reservationsView.form.reservationTime', { defaultValue: 'Reservation time' })}</span>
                <KitDateField
                  value={serviceForm.time}
                  onChange={(event) => setServiceForm((prev) => ({ ...prev, time: event.target.value }))}
                  type="time" required
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
                className={`resize-none py-2.5 ${modalInputClass}`}
              />
            </label>
            </div>

            <div className={modalFooterClass}>
              <button
                type="button"
                onClick={closeServiceModal}
                className={secondaryButtonClass}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                onClick={() => void handleCreateServiceBooking()}
                disabled={isCreatingService}
                className={primaryButtonClass}
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
        <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">
          <div className={modalScrimClass} onClick={() => setSelectedReservation(null)} aria-hidden="true" />
          <div className="liquid-glass-modal-shell relative flex w-full max-w-xl flex-col text-(--pos-s-fg)">
            <div className={modalHeaderClass}>
              <h3 className="text-2xl font-semibold text-(--pos-s-fg)">
                {t('reservationsView.detailTitle', { defaultValue: 'Reservation Details' })}
              </h3>
              <button
                type="button"
                onClick={() => setSelectedReservation(null)}
                aria-label={t('common.actions.close', 'Close')}
                className="liquid-glass-modal-close"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className={modalBodyClass}>
            {isDetailsLoading && (
              <div className="flex items-center text-(--pos-s-muted)">
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                {t('common.loading', { defaultValue: 'Loading...' })}
              </div>
            )}

            {!isDetailsLoading && selectedReservation && (
              <div className="space-y-4">
                <div className="pos-frost rounded-xl border p-3">
                  <div className="text-sm text-(--pos-s-muted)">
                    {t('reservationsView.customer', { defaultValue: 'Customer' })}
                  </div>
                  <div className="font-semibold text-(--pos-s-fg)">{selectedReservation.customerName}</div>
                  <div className="text-sm text-(--pos-s-fg)">{selectedReservation.customerPhone}</div>
                  {selectedReservation.customerEmail && (
                    <div className="text-sm text-(--pos-s-muted)">{selectedReservation.customerEmail}</div>
                  )}
                </div>

                <div className="pos-frost rounded-xl border p-3">
                  <div className="text-sm text-(--pos-s-muted)">
                    {t('reservationsView.when', { defaultValue: 'Date & Time' })}
                  </div>
                  <div className="font-semibold text-(--pos-s-fg)">
                    {/* Display the branch's recorded wall time, independently of this PC's timezone. */}
                    {formatDate(reservationWallDateTime(selectedReservation))} {formatTime(reservationWallDateTime(selectedReservation), { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div className="text-sm text-(--pos-s-fg)">
                    {selectedReservation.partySize} {t('reservationsView.guests', { defaultValue: 'guests' })}
                  </div>
                </div>

                {selectedReservation.specialRequests && (
                  <div className="pos-frost rounded-xl border p-3">
                    <div className="text-sm text-(--pos-s-muted)">
                      {t('reservationsView.specialRequests', { defaultValue: 'Special Requests' })}
                    </div>
                    <div className="text-(--pos-s-fg)">{selectedReservation.specialRequests}</div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-sm text-(--pos-s-muted)">
                    {t('reservationsView.quickActions', { defaultValue: 'Quick Actions' })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedReservation.roomId && ['pending', 'confirmed'].includes(selectedReservation.status) && <button type="button" className="pos-solid-btn pos-solid-btn--sm" onClick={() => {
                      if (!rooms.some((room) => room.id === selectedReservation.roomId)) { toast.error(t('roomsView.toasts.roomNotFound')); return; }
                      setRoomWorkflow({ reservation: selectedReservation, mode: 'edit' }); setSelectedReservation(null);
                    }}>{t('roomWorkflow.editBooking')}</button>}
                    {getQuickActions(selectedReservation).map((action) => (
                      <button
                        key={action.status}
                        type="button"
                        onClick={() => void handleStatusChange(selectedReservation.id, action.status)}
                        className={quickActionClass(action.variant)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>

                {!selectedReservation.roomId && (
                <div className="pos-frost rounded-xl border p-3">
                  <div className="text-sm mb-2 text-(--pos-s-muted)">
                    {t('reservationsView.assignTable', { defaultValue: 'Assign Table' })}
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={tableAssignmentId}
                      onChange={(event) => setTableAssignmentId(event.target.value)}
                      aria-label={t('reservationsView.assignTable', { defaultValue: 'Assign Table' })}
                      className={`min-w-0 flex-1 ${kitFieldLook}`}
                    >
                      <option value="">{t('reservationsView.selectTable', { defaultValue: 'Select a table' })}</option>
                      {tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {formatTableDisplayNumber(table.tableNumber)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={isAssigningTable || !tableAssignmentId.trim()}
                      onClick={() => void handleAssignTable()}
                      className={secondaryButtonClass}
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
        </div>
      )}
      {roomWorkflow && (() => {
        const room = rooms.find((item) => item.id === roomWorkflow.reservation.roomId);
        if (!room) return <div role="alert">{t('roomsView.toasts.roomNotFound')} <button type="button" onClick={() => setRoomWorkflow(null)}>{t('common.actions.close', { defaultValue: 'Close' })}</button></div>;
        const props = { room, reservation: roomWorkflow.reservation, branchId: branchId || '', organizationId: effectiveOrgId || '', updateRoomStatus, refetchRooms, onClose: () => setRoomWorkflow(null), onCompleted: () => { setRoomWorkflow(null); void refetch(); void refetchRooms(); } };
        return roomWorkflow.mode === 'arrival' ? <RoomCheckinModal {...props} /> : <RoomReservationModal rooms={rooms} {...props} />;
      })()}
    </motion.div>
  );
});

ReservationsView.displayName = 'ReservationsView';
export default ReservationsView;
