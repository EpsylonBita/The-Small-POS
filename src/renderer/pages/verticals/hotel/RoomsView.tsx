/**
 * RoomsView - POS Room Status Grid (Redesigned)
 * 
 * Real-time room status management for hotel POS.
 * Features: Check-in, Reservations, Payment processing, Mobile responsive
 */

import React, { memo, useState, useEffect, useMemo, useRef, useId } from 'react';
import { renderModalPortal } from '../../../utils/render-modal-portal';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useRooms } from '../../../hooks/useRooms';
import { formatCurrency, formatDate } from '../../../utils/format';
import { toLocalDateString } from '../../../utils/date';
import { roomWorkflowError } from '../../../utils/room-workflow';
import { reservationsService } from '../../../services/ReservationsService';
import { RoomCheckinModal, RoomReservationModal, RoomStaySelectorModal } from '../../../components/modals/RoomStayWorkflowModals';
import { posApiFetch, posApiPost } from '../../../utils/api-helpers';
import {
  folioChargesEndpoint,
  folioPaymentsEndpoint,
  parseFolioCheckoutOutstanding,
  type FolioChargeType,
  type FolioPaymentMethod,
} from '../../../utils/guest-billing';
import { 
  Bed, RefreshCw, Users, Wrench, Sparkles, Calendar, X, 
  CreditCard, Receipt, Clock, User, Phone, Mail, DollarSign,
  ChevronDown, Filter, Search
} from 'lucide-react';
import type { Room, RoomStatus, RoomFilters } from '../../../services/RoomsService';
import { getRoomEffectiveStatus } from '../../../services/RoomsService';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
import { getBridge, offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

const statusConfig: Record<RoomStatus, { color: string; bgClass: string; icon: typeof Bed; label: string }> = {
  available: { color: 'text-emerald-500', bgClass: 'bg-emerald-500/10 border-emerald-500/30', icon: Sparkles, label: 'Available' },
  occupied: { color: 'text-orange-500', bgClass: 'bg-orange-500/10 border-orange-500/30', icon: Users, label: 'Occupied' },
  cleaning: { color: 'text-amber-500', bgClass: 'bg-amber-500/10 border-amber-500/30', icon: Sparkles, label: 'Cleaning' },
  maintenance: { color: 'text-red-500', bgClass: 'bg-red-500/10 border-red-500/30', icon: Wrench, label: 'Maintenance' },
  reserved: { color: 'text-yellow-500', bgClass: 'bg-yellow-500/10 border-yellow-500/30', icon: Calendar, label: 'Reserved' },
};

type ModalType = 'none' | 'checkin' | 'reservation' | 'checkoutPayment' | 'charge' | 'action' | 'chooseCreate';

interface CheckoutPaymentData {
  room: Room;
  folioId: string;
  amount: string;
  paymentMethod: FolioPaymentMethod;
  reference: string;
  notes: string;
}

interface FolioChargeData {
  room: Room;
  folioId: string;
  chargeType: FolioChargeType;
  description: string;
  amount: string;
  quantity: string;
  notes: string;
}

interface RoomCheckoutApiResponse {
  success: boolean;
  error?: string;
  code?: string;
  folioSkippedReason?: 'no_active_folio' | 'module_revoked' | null;
  alreadyConverged?: boolean;
  housekeepingTaskId?: string | null;
  housekeepingError?: string | null;
  completedReservationIds?: string[];
}

const getRoomGuestName = (room: Room): string | null =>
  room.activeFolio?.guestName || room.currentGuestName || null;

// Locale-aware money formatting: delegates to the shared POS currency helper so
// Greek shows "145,00 €" instead of a hardcoded "$145.00".
const formatMoney = (amount: number): string => formatCurrency(Number(amount) || 0);

// Loose translate signature so the real i18next `t` is assignable without casts.
type RoomTranslateFn = (key: string, options?: Record<string, unknown>) => unknown;

// Localize known room-type slugs (standard/deluxe/suite/penthouse/accessible) via
// roomsView.roomTypes.*; genuinely custom room-type names with no mapping are kept
// verbatim so they never get clobbered or shown as a raw lowercase slug.
const translateRoomType = (t: RoomTranslateFn, roomType?: string | null): string => {
  const raw = (roomType ?? '').trim();
  if (!raw) return raw;
  const localized = t(`roomsView.roomTypes.${raw.toLowerCase()}`, { defaultValue: '' });
  return typeof localized === 'string' && localized ? localized : raw;
};

interface RoomsViewProps {
  /** Rendered inside the Orders hub: hides the internal FAB (the hub owns New Order). */
  embedded?: boolean;
  /**
   * Hub preset applied from the New Order -> Room flow:
   * - 'checkin' shows reserved rooms first and routes a room tap to the check-in path.
   * - 'reservation' shows available rooms first and routes a room tap to the reservation path.
   */
  hubPreset?: 'checkin' | 'reservation' | null;
  /** Bump to (re)apply hubPreset even when its value is unchanged between activations. */
  hubPresetSignal?: number;
}

export const RoomsView: React.FC<RoomsViewProps> = memo(({
  embedded = false,
  hubPreset = null,
  hubPresetSignal = 0,
}) => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId, isModuleEnabled } = useModules();
  const isDark = resolvedTheme === 'dark';

  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  // Filter states
  const [statusFilter, setStatusFilter] = useState<RoomStatus | 'all'>('all');
  const [floorFilter, setFloorFilter] = useState<number | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  
  // Modal states
  const [modalType, setModalType] = useState<ModalType>('none');
  const [actionRoom, setActionRoom] = useState<Room | null>(null);
  // Round 236: when driven from the Orders hub Room flow, a room tap routes straight to the
  // check-in / reservation path instead of the generic action sheet.
  const [hubMode, setHubMode] = useState<'checkin' | 'reservation' | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  
  const [checkinData, setCheckinData] = useState({ roomId: '' });
  const [reservationData, setReservationData] = useState({ roomId: '' });
  const [checkoutPaymentData, setCheckoutPaymentData] = useState<CheckoutPaymentData | null>(null);
  const [folioChargeData, setFolioChargeData] = useState<FolioChargeData | null>(null);

  const hasGuestBilling = isModuleEnabled('guest_billing' as any);
  const hasReservations = isModuleEnabled('reservations' as any);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateNetworkState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);

    return () => {
      window.removeEventListener('online', updateNetworkState);
      window.removeEventListener('offline', updateNetworkState);
    };
  }, []);

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
  }, [organizationId]);

  const effectiveOrgId = organizationId || localOrgId;

  // Memoize filters to prevent unnecessary re-renders
  const filters: RoomFilters = useMemo(() => ({
    statusFilter,
    floorFilter,
    searchTerm,
  }), [statusFilter, floorFilter, searchTerm]);

  const { rooms, allRooms, stats, floors, isLoading, refetch, updateStatus } = useRooms({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    filters,
    enableRealtime: true,
  });

  // Handlers
  const handleRoomClick = (room: Room) => {
    // Hub presets (Round 236) route the tap directly into the requested flow, then disarm
    // (one-shot): once a room has been consumed, the next tap behaves normally again.
    if (hubMode === 'checkin') {
      setHubMode(null);
      openCheckinModal(room);
      return;
    }
    if (hubMode === 'reservation') {
      setHubMode(null);
      openReservationModal(room);
      return;
    }
    setActionRoom(room);
    setModalType('action');
  };

  // Manually changing the status filter also cancels an armed hub preset: a staff-driven filter
  // change means they are browsing the grid, not following the New Order -> Room preset. The preset
  // effect sets statusFilter directly (not through here), so it does not clear hubMode itself.
  const handleManualStatusFilterChange = (next: RoomStatus | 'all') => {
    setHubMode(null);
    setStatusFilter(next);
  };

  const handleStatusChange = async (roomId: string, newStatus: RoomStatus) => {
    const updated = await updateStatus(roomId, newStatus);
    // Only sync the open modal on success, and sync BOTH status and effectiveStatus from
    // the returned room so getRoomEffectiveStatus(actionRoom) no longer shows the old
    // status in the summary. Merge into prev to preserve folio/guest fields the status
    // response may omit.
    if (updated && actionRoom?.id === roomId) {
      setActionRoom(prev =>
        prev ? { ...prev, status: updated.status, effectiveStatus: updated.effectiveStatus } : null,
      );
    }
  };

  const openCheckinModal = (room?: Room) => {
    setCheckinData({ roomId: room?.id || '' });
    setModalType('checkin');
  };
  const openReservationModal = (room?: Room) => {
    setReservationData({ roomId: room?.id || '' });
    setModalType('reservation');
  };

  // Round 236: apply the hub preset coming from New Order -> Room. A signal bump shows the
  // relevant rooms first (reserved for check-in, available for reservation) and arms hubMode
  // so the next room tap opens the matching flow.
  useEffect(() => {
    if (!hubPresetSignal || !hubPreset) return;
    setHubMode(hubPreset);
    setStatusFilter(hubPreset === 'checkin' ? 'reserved' : 'available');
  }, [hubPresetSignal, hubPreset]);

  const completeCheckoutLocally = async (room: Room): Promise<boolean> => {
    if (hasGuestBilling && room.activeFolio) {
      toast.error(t('roomsView.toasts.folioCheckoutOffline', { defaultValue: 'Folio checkout requires an online connection' }));
      return false;
    }

    if (hasReservations) {
      reservationsService.setContext(branchId || '', effectiveOrgId || '');
      const reservation = await reservationsService.getActiveRoomReservation(room.id, toLocalDateString());
      if (reservation?.status === 'seated') {
        await reservationsService.updateStatus(reservation.id, 'completed');
        await refetch();
        return true;
      }
    }
    const updated = await updateStatus(room.id, 'cleaning');
    if (!updated) {
      throw new Error('Failed to update room status to cleaning');
    }

    setModalType('none');
    setActionRoom(null);
    await refetch();
    toast.success(t('roomsView.toasts.checkoutQueued', { defaultValue: 'Checkout queued for sync' }));
    return true;
  };

  const submitRoomCheckout = async (room: Room): Promise<boolean> => {
    if (!isOnline) {
      return completeCheckoutLocally(room);
    }

    const response = await posApiFetch<RoomCheckoutApiResponse>(
      `/pos/rooms/${encodeURIComponent(room.id)}/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({
          checkOutDate: toLocalDateString(),
          resolution: 'close_paid',
        }),
      },
    );

    if (!response.success || response.data?.success === false) {
      const rawError = response.error || response.data?.error || 'Failed to complete checkout';
      const outstanding = parseFolioCheckoutOutstanding(rawError, response.status);
      if (outstanding.outstanding && room.activeFolio) {
        const amount = outstanding.balance ?? room.activeFolio.balance;
        setCheckoutPaymentData({
          room,
          folioId: room.activeFolio.id,
          amount: amount > 0 ? amount.toFixed(2) : '',
          paymentMethod: 'cash',
          reference: '',
          notes: `Checkout payment for room ${room.roomNumber}`,
        });
        setModalType('checkoutPayment');
        return false;
      }

      throw new Error(rawError);
    }

    const body = response.data;
    setModalType('none');
    setActionRoom(null);
    setCheckoutPaymentData(null);
    await refetch();

    if (body?.housekeepingError) {
      toast.error(t('roomsView.toasts.checkoutHousekeepingFailed', { defaultValue: 'Checkout completed, but housekeeping task creation failed' }));
    }
    if (body?.folioSkippedReason === 'module_revoked') {
      toast(t('roomsView.toasts.folioSkipped', { defaultValue: 'Checkout completed; folio settlement was skipped because guest billing is not available' }));
    }
    toast.success(body?.alreadyConverged
      ? t('roomsView.toasts.checkoutAlreadyCompleted', { defaultValue: 'Checkout already completed' })
      : t('roomsView.toasts.checkoutCompleted', { defaultValue: 'Checkout completed' }));
    return true;
  };

  const handleCheckout = async () => {
    if (!actionRoom) return;

    try {
      if (!branchId || !effectiveOrgId) {
        toast.error(t('roomsView.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }));
        return;
      }

      await submitRoomCheckout(actionRoom);
    } catch (error) {
      console.error('Failed to checkout room:', error);
      toast.error(roomWorkflowError(error, t));
    }
  };

  const handleCheckoutPayment = async () => {
    if (!checkoutPaymentData) return;

    const amount = Number(checkoutPaymentData.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('roomsView.toasts.invalidPaymentAmount', { defaultValue: 'Enter a valid payment amount' }));
      return;
    }

    try {
      const response = await posApiPost<{ success?: boolean; error?: string }>(
        folioPaymentsEndpoint(checkoutPaymentData.folioId),
        {
          amount,
          paymentMethod: checkoutPaymentData.paymentMethod,
          reference: checkoutPaymentData.reference || null,
          notes: checkoutPaymentData.notes || null,
        },
      );

      if (!response.success || response.data?.success === false) {
        throw new Error(response.error || response.data?.error || 'Failed to post payment');
      }

      toast.success(t('roomsView.toasts.paymentPosted', { defaultValue: 'Payment posted' }));
      await submitRoomCheckout(checkoutPaymentData.room);
    } catch (error) {
      console.error('Failed to post checkout payment:', error);
      toast.error(error instanceof Error ? error.message : t('roomsView.toasts.paymentFailed', { defaultValue: 'Failed to post payment' }));
    }
  };

  const openFolioChargeModal = (room: Room) => {
    if (!room.activeFolio) {
      toast.error(t('roomsView.toasts.noActiveFolio', { defaultValue: 'No active folio is available for this room' }));
      return;
    }
    if (!isOnline) {
      toast.error(t('roomsView.toasts.chargeOffline', { defaultValue: 'Adding a folio charge requires an online connection' }));
      return;
    }

    setFolioChargeData({
      room,
      folioId: room.activeFolio.id,
      chargeType: 'other',
      description: `Room ${room.roomNumber} charge`,
      amount: '',
      quantity: '1',
      notes: '',
    });
    setModalType('charge');
  };

  const handleAddFolioCharge = async () => {
    if (!folioChargeData) return;

    const amount = Number(folioChargeData.amount);
    const quantity = Number(folioChargeData.quantity || '1');
    if (!folioChargeData.description.trim()) {
      toast.error(t('roomsView.toasts.chargeDescriptionRequired', { defaultValue: 'Enter a charge description' }));
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('roomsView.toasts.invalidChargeAmount', { defaultValue: 'Enter a valid charge amount' }));
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast.error(t('roomsView.toasts.invalidQuantity', { defaultValue: 'Enter a valid quantity' }));
      return;
    }

    try {
      const response = await posApiPost<{ success?: boolean; error?: string }>(
        folioChargesEndpoint(folioChargeData.folioId),
        {
          chargeType: folioChargeData.chargeType,
          description: folioChargeData.description.trim(),
          amount,
          quantity,
          notes: folioChargeData.notes.trim() || undefined,
        },
      );

      if (!response.success || response.data?.success === false) {
        throw new Error(response.error || response.data?.error || 'Failed to post charge');
      }

      toast.success(t('roomsView.toasts.chargeAdded', { defaultValue: 'Charge added' }));
      setModalType('action');
      setFolioChargeData(null);
      await refetch();
    } catch (error) {
      console.error('Failed to add folio charge:', error);
      toast.error(error instanceof Error ? error.message : t('roomsView.toasts.chargeFailed', { defaultValue: 'Failed to add charge' }));
    }
  };

  const getStatusLabel = (status: RoomStatus) => {
    return t(`roomsView.status.${status}`, { defaultValue: statusConfig[status].label });
  };

  // Create/check-in/reservation selector options: derive from the full branch room set
  // (allRooms), filtered only by effective availability — NOT from the grid-filtered rooms,
  // so a staff search/status/floor filter on the grid never hides selectable rooms.



  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-3 sm:p-4 overflow-hidden">
      {/* Stats Bar - Responsive */}
      <motion.div variants={pageMotionContainer} className="grid grid-cols-3 sm:grid-cols-5 gap-2 sm:gap-3 mb-3 sm:mb-4">
        <StatCard label={t('roomsView.stats.total', { defaultValue: 'Total' })} value={stats.totalRooms} isDark={isDark} />
        <StatCard label={t('roomsView.stats.available', { defaultValue: 'Available' })} value={stats.availableRooms} color="text-emerald-500" isDark={isDark} />
        <StatCard label={t('roomsView.stats.occupied', { defaultValue: 'Occupied' })} value={stats.occupiedRooms} color="text-orange-500" isDark={isDark} />
        <StatCard label={t('roomsView.stats.cleaning', { defaultValue: 'Cleaning' })} value={stats.cleaningRooms} color="text-amber-500" isDark={isDark} className="hidden sm:block" />
        <StatCard label={t('roomsView.stats.occupancy', { defaultValue: 'Occupancy' })} value={`${stats.occupancyRate}%`} isDark={isDark} className="hidden sm:block" />
      </motion.div>

      {/* Search & Filter Bar */}
      <motion.div variants={pageMotionItem} data-rooms-filter-bar className="flex flex-col gap-2 sm:gap-3 mb-3 sm:mb-4">
        {/* Search — its own full-width row so long localized placeholders are never clipped */}
        <div data-rooms-search className={`relative w-full ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-50" />
          <input
            type="text"
            placeholder={t('roomsView.searchPlaceholder', { defaultValue: 'Search room or guest...' })}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`w-full pl-9 pr-4 py-2.5 rounded-xl text-sm ${
              isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
            } border focus:ring-2 focus:ring-yellow-400 focus:border-transparent`}
          />
        </div>
        
        {/* Filters + refresh — wrap on their own row below the search so they never squeeze it */}
        <div data-rooms-filter-controls className="flex flex-wrap items-center gap-2">
          {/* Filter Toggle (Mobile) */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`sm:hidden flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl ${
              isDark ? 'bg-gray-800' : 'bg-white border border-gray-200'
            }`}
          >
            <Filter className="w-4 h-4" />
            <span className="text-sm">{t('roomsView.filters', { defaultValue: 'Filters' })}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>

          {/* Desktop Filters */}
          <div className="hidden sm:flex flex-wrap gap-2">
            <StatusFilterButtons statusFilter={statusFilter} setStatusFilter={handleManualStatusFilterChange} isDark={isDark} getStatusLabel={getStatusLabel} />
            {floors.length > 1 && (
              <FloorSelect floorFilter={floorFilter} setFloorFilter={setFloorFilter} floors={floors} isDark={isDark} />
            )}
          </div>

          {/* Refresh Button */}
          <button
            onClick={() => refetch()}
            className={`hidden sm:flex items-center justify-center w-10 h-10 rounded-xl ${
              isDark ? 'bg-gray-800 active:bg-gray-700' : 'bg-white border border-gray-200 active:bg-gray-50'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </motion.div>

      {/* Mobile Filters (Collapsible) */}
      {showFilters && (
        <motion.div variants={pageMotionItem} className={`sm:hidden flex flex-wrap gap-2 mb-3 p-3 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
          <StatusFilterButtons statusFilter={statusFilter} setStatusFilter={handleManualStatusFilterChange} isDark={isDark} getStatusLabel={getStatusLabel} />
          {floors.length > 1 && (
            <FloorSelect floorFilter={floorFilter} setFloorFilter={setFloorFilter} floors={floors} isDark={isDark} />
          )}
        </motion.div>
      )}

      {/* Loading State */}
      {isLoading && rooms.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('roomsView.loading', { defaultValue: 'Loading rooms...' })}
        </motion.div>
      )}

      {/* Rooms Grid */}
      {!isLoading && (
        <motion.div
          variants={pageMotionContainer}
          /* Round 236: scroll stays (overflow-y-auto); when embedded in the Orders hub the native
             scrollbar is hidden (scrollbar-hide) so the rooms grid matches the hub's chrome. */
          className={`flex-1 overflow-y-auto space-y-4 pb-20 ${embedded ? 'scrollbar-hide' : ''}`}
        >
          {floors.map(floor => {
            const floorRooms = rooms.filter(r => r.floor === floor);
            if (floorRooms.length === 0) return null;
            
            return (
              <motion.div key={floor} variants={pageMotionItem}>
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {t('roomsView.floor', { floor, defaultValue: 'Floor {{floor}}' })}
                </h3>
                <motion.div variants={pageMotionContainer} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                  {floorRooms.map(room => (
                    <RoomCard key={room.id} room={room} isDark={isDark} onClick={() => handleRoomClick(room)} />
                  ))}
                </motion.div>
              </motion.div>
            );
          })}

          {rooms.length === 0 && !isLoading && (
            <motion.div variants={pageMotionItem} className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <Bed className="w-16 h-16 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium mb-2">{t('roomsView.noRooms', { defaultValue: 'No rooms found' })}</p>
              <p className="text-sm">{t('roomsView.noRoomsHint', { defaultValue: 'Try adjusting your filters' })}</p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* Floating Action Button - offers a check-in/reservation choice when
          reservations are enabled, otherwise opens check-in directly so the
          accessible label always matches what the button actually does.
          Hidden when embedded in the Orders hub, which owns the New Order FAB. */}
      {!embedded && (
        <FloatingActionButton
          onClick={() => setModalType(hasReservations ? 'chooseCreate' : 'checkin')}
          aria-label={
            hasReservations
              ? t('roomsView.newCheckinOrReservation', { defaultValue: 'New Check-in or Reservation' })
              : t('roomsView.newCheckin', { defaultValue: 'New Check-in' })
          }
          className="!bottom-20 sm:!bottom-6"
        />
      )}

      {/* Create choice - lets staff pick between a new check-in and a new
          reservation. Rendered through the shared Modal (app-level portal,
          z-[1200], backdrop blur). Only reachable when reservations exist. */}
      {modalType === 'chooseCreate' && hasReservations && (
        <Modal
          title={t('roomsView.newCheckinOrReservation', { defaultValue: 'New Check-in or Reservation' })}
          onClose={() => setModalType('none')}
          isDark={isDark}
        >
          <div className="grid grid-cols-1 gap-3">
            <ActionButton
              icon={<Users className="w-5 h-5" />}
              label={t('roomsView.newCheckin', { defaultValue: 'New Check-in' })}
              color="emerald"
              onClick={() => openCheckinModal()}
            />
            <ActionButton
              icon={<Calendar className="w-5 h-5" />}
              label={t('roomsView.newReservation', { defaultValue: 'New Reservation' })}
              color="amber"
              onClick={() => openReservationModal()}
            />
          </div>
        </Modal>
      )}

      {/* Room Action Modal */}
      {modalType === 'action' && actionRoom && (
        <Modal title={t('roomsView.roomTitle', { number: actionRoom.roomNumber, defaultValue: 'Room {{number}}' })} onClose={() => { setModalType('none'); setActionRoom(null); }} isDark={isDark}>
          <div className="space-y-4">
            {/* Room Info */}
            <div className={`p-4 rounded-2xl ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.status', { defaultValue: 'Status' })}</span>
                <span className={`font-medium ${statusConfig[getRoomEffectiveStatus(actionRoom)].color}`}>
                  {getStatusLabel(getRoomEffectiveStatus(actionRoom))}
                </span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.type', { defaultValue: 'Type' })}</span>
                <span className={`font-medium capitalize ${isDark ? 'text-white' : 'text-gray-900'}`}>{translateRoomType(t, actionRoom.roomType)}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.capacity', { defaultValue: 'Capacity' })}</span>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('roomsView.fields.guestsCount', { count: actionRoom.capacity, defaultValue: '{{count}} guests' })}</span>
              </div>
              {actionRoom.ratePerNight && (
                <div className="flex items-center justify-between">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.ratePerNight', { defaultValue: 'Rate/Night' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatMoney(actionRoom.ratePerNight)}</span>
                </div>
              )}
              {getRoomGuestName(actionRoom) && (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-600">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.guest', { defaultValue: 'Guest' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{getRoomGuestName(actionRoom)}</span>
                </div>
              )}
              {actionRoom.activeFolio && (
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.fields.folioBalance', { defaultValue: 'Folio Balance' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {formatMoney(actionRoom.activeFolio.balanceCents / 100)}
                  </span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-2">
              {getRoomEffectiveStatus(actionRoom) === 'available' && (
                <>
                  <ActionButton icon={<Users className="w-5 h-5" />} label={t('roomsView.actions.checkin', { defaultValue: 'Check-in' })} color="emerald" onClick={() => openCheckinModal(actionRoom)} />
                  {hasReservations && (
                    <ActionButton icon={<Calendar className="w-5 h-5" />} label={t('roomsView.actions.reserve', { defaultValue: 'Reserve' })} color="amber" onClick={() => openReservationModal(actionRoom)} />
                  )}
                </>
              )}
              {getRoomEffectiveStatus(actionRoom) === 'occupied' && (
                <>
                  <ActionButton icon={<Receipt className="w-5 h-5" />} label={t('roomsView.actions.checkout', { defaultValue: 'Checkout' })} color="emerald" onClick={handleCheckout} />
                  {hasGuestBilling && actionRoom.activeFolio && (
                    <ActionButton icon={<DollarSign className="w-5 h-5" />} label={t('roomsView.actions.addCharge', { defaultValue: 'Add Charge' })} color="amber" onClick={() => openFolioChargeModal(actionRoom)} />
                  )}
                </>
              )}
              {getRoomEffectiveStatus(actionRoom) === 'reserved' && (
                <ActionButton icon={<Users className="w-5 h-5" />} label={t('roomsView.actions.checkin', { defaultValue: 'Check-in' })} color="emerald" onClick={() => openCheckinModal(actionRoom)} className="col-span-2" />
              )}
            </div>

            {/* Quick Status Change */}
            <div>
              <p className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{t('roomsView.changeStatus', { defaultValue: 'Change Status' })}</p>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(statusConfig) as RoomStatus[]).map(status => (
                  <button
                    key={status}
                    onClick={() => handleStatusChange(actionRoom.id, status)}
                    disabled={getRoomEffectiveStatus(actionRoom) === status}
                    className={`py-2 px-2 rounded-2xl text-xs font-medium transition-transform active:scale-95 ${
                      getRoomEffectiveStatus(actionRoom) === status
                        ? `${statusConfig[status].bgClass} ${statusConfig[status].color}`
                        : isDark 
                          ? 'bg-gray-700 text-gray-300 active:bg-gray-600'
                          : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                    }`}
                  >
                    {getStatusLabel(status)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {modalType === 'checkoutPayment' && checkoutPaymentData && (
        <Modal
          title={t('roomsView.settleRoomTitle', { number: checkoutPaymentData.room.roomNumber, defaultValue: 'Settle Room {{number}}' })}
          onClose={() => setModalType('action')}
          isDark={isDark}
        >
          <div className="space-y-4">
            <div className={`p-4 rounded-2xl ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>{t('roomsView.outstandingBalance', { defaultValue: 'Outstanding Balance' })}</span>
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {formatMoney(Number(checkoutPaymentData.amount || 0))}
                </span>
              </div>
            </div>

            <InputField
              icon={<DollarSign className="w-4 h-4" />}
              label={t('roomsView.paymentAmount', { defaultValue: 'Payment Amount' })}
              type="number"
              value={checkoutPaymentData.amount}
              onChange={(value) => setCheckoutPaymentData(prev => prev ? { ...prev, amount: value } : prev)}
              isDark={isDark}
              required
            />

            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {t('roomsView.paymentMethod', { defaultValue: 'Payment Method' })}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['cash', 'card', 'bank_transfer', 'other'] as FolioPaymentMethod[]).map(method => (
                  <button
                    key={method}
                    onClick={() => setCheckoutPaymentData(prev => prev ? { ...prev, paymentMethod: method } : prev)}
                    className={`py-2.5 px-3 rounded-xl text-sm font-medium capitalize transition-all ${
                      checkoutPaymentData.paymentMethod === method
                        ? 'bg-emerald-500 text-white'
                        : isDark ? 'bg-gray-700 text-gray-300 active:bg-gray-600' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                    }`}
                  >
                    {t(`roomsView.paymentMethods.${method}`, { defaultValue: method.replace('_', ' ') })}
                  </button>
                ))}
              </div>
            </div>

            <InputField
              icon={<Receipt className="w-4 h-4" />}
              label={t('roomsView.reference', { defaultValue: 'Reference' })}
              value={checkoutPaymentData.reference}
              onChange={(value) => setCheckoutPaymentData(prev => prev ? { ...prev, reference: value } : prev)}
              isDark={isDark}
            />

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('action')}
                className={`flex-1 py-3 rounded-2xl font-medium ${
                  isDark ? 'bg-red-500/15 text-red-200 active:bg-red-500/25' : 'bg-red-50 text-red-700 active:bg-red-100'
                }`}
              >
                {t('common.actions.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={handleCheckoutPayment}
                className="flex-1 py-3 rounded-xl font-medium bg-emerald-500 text-white active:bg-emerald-600"
              >
                {t('roomsView.postPaymentCheckout', { defaultValue: 'Post Payment & Checkout' })}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modalType === 'charge' && folioChargeData && (
        <Modal
          title={t('roomsView.addChargeTitle', { number: folioChargeData.room.roomNumber, defaultValue: 'Add Charge - Room {{number}}' })}
          onClose={() => setModalType('action')}
          isDark={isDark}
          size="lg"
        >
          <div className="space-y-4">
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {t('roomsView.chargeType', { defaultValue: 'Charge Type' })}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['other', 'room', 'food', 'beverage', 'service', 'tax'] as FolioChargeType[]).map(type => (
                  <button
                    key={type}
                    onClick={() => setFolioChargeData(prev => prev ? { ...prev, chargeType: type } : prev)}
                    className={`py-2.5 px-3 rounded-xl text-sm font-medium capitalize transition-all ${
                      folioChargeData.chargeType === type
                        ? 'bg-amber-500 text-white'
                        : isDark ? 'bg-gray-700 text-gray-300 active:bg-gray-600' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                    }`}
                  >
                    {t(`roomsView.chargeTypes.${type}`, { defaultValue: type })}
                  </button>
                ))}
              </div>
            </div>

            <InputField
              icon={<Receipt className="w-4 h-4" />}
              label={t('roomsView.description', { defaultValue: 'Description' })}
              value={folioChargeData.description}
              onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, description: value } : prev)}
              isDark={isDark}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InputField
                icon={<DollarSign className="w-4 h-4" />}
                label={t('roomsView.amount', { defaultValue: 'Amount' })}
                type="number"
                value={folioChargeData.amount}
                onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, amount: value } : prev)}
                isDark={isDark}
                required
              />
              <InputField
                icon={<Receipt className="w-4 h-4" />}
                label={t('roomsView.quantity', { defaultValue: 'Quantity' })}
                type="number"
                value={folioChargeData.quantity}
                onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, quantity: value } : prev)}
                isDark={isDark}
                required
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {t('roomsView.notes', { defaultValue: 'Notes' })}
              </label>
              <textarea
                value={folioChargeData.notes}
                onChange={(event) => setFolioChargeData(prev => prev ? { ...prev, notes: event.target.value } : prev)}
                rows={3}
                className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                  isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                } border focus:ring-2 focus:ring-amber-500 resize-none`}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('action')}
                className={`flex-1 py-3 rounded-xl font-medium ${
                  isDark ? 'bg-gray-700 text-gray-300 active:bg-gray-600' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                }`}
              >
                {t('common.actions.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={handleAddFolioCharge}
                className="flex-1 py-3 rounded-xl font-medium bg-amber-500 text-white active:bg-amber-600"
              >
                {t('roomsView.actions.addCharge', { defaultValue: 'Add Charge' })}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {(modalType === 'checkin' || modalType === 'reservation') && (() => {
        const selected = allRooms.find((item) => item.id === (modalType === 'checkin' ? checkinData.roomId : reservationData.roomId));
        const close = () => { setModalType('none'); setActionRoom(null); };
        const props = { branchId: branchId || '', organizationId: effectiveOrgId || '', updateRoomStatus: updateStatus, refetchRooms: refetch, onClose: close, onCompleted: close };
        return selected
          ? modalType === 'checkin' ? <RoomCheckinModal key={selected.id} room={selected} {...props} /> : <RoomReservationModal key={selected.id} room={selected} {...props} />
          : <RoomStaySelectorModal isOpen variant={modalType} rooms={allRooms} onClose={close} onSelectRoom={(selectedRoom) => modalType === 'checkin' ? openCheckinModal(selectedRoom) : openReservationModal(selectedRoom)} />;
      })()}

    </motion.div>
  );
});

RoomsView.displayName = 'RoomsView';
export default RoomsView;


// Helper Components
const StatCard: React.FC<{ label: string; value: string | number; color?: string; isDark: boolean; className?: string }> = 
  ({ label, value, color, isDark, className }) => (
  <motion.div variants={pageMotionItem} className={`px-3 py-2 sm:px-4 sm:py-3 rounded-2xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'} ${className || ''}`}>
    <div className={`text-xs sm:text-sm ${color || (isDark ? 'text-gray-400' : 'text-gray-500')}`}>{label}</div>
    <div className={`text-lg sm:text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{value}</div>
  </motion.div>
);

const RoomCard: React.FC<{ room: Room; isDark: boolean; onClick: () => void }> = ({ room, isDark, onClick }) => {
  const { t } = useTranslation();
  const effectiveStatus = getRoomEffectiveStatus(room);
  const config = statusConfig[effectiveStatus];
  const Icon = config.icon;
  const guestName = getRoomGuestName(room);
  
  return (
    <motion.button
      variants={pageMotionItem}
      onClick={onClick}
      className={`p-3 sm:p-4 rounded-2xl border-2 text-left transition-all active:scale-[0.98] ${config.bgClass}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={`font-bold text-sm sm:text-base ${isDark ? 'text-white' : 'text-gray-900'}`}>{room.roomNumber}</span>
        <Icon className={`w-4 h-4 ${config.color}`} />
      </div>
      <div className={`text-xs capitalize ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{translateRoomType(t, room.roomType)}</div>
      {effectiveStatus !== room.status && (
        <div className={`text-xs mt-1 font-medium ${config.color}`}>
          {t(`roomsView.status.${effectiveStatus}`, { defaultValue: statusConfig[effectiveStatus].label })}
        </div>
      )}
      {guestName && (
        <div className={`text-xs truncate mt-1 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <Users className="w-3 h-3 inline mr-1" />
          {guestName}
        </div>
      )}
      {room.activeFolio && (
        <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <DollarSign className="w-3 h-3 inline mr-1" />
          {formatMoney(room.activeFolio.balanceCents / 100)}
        </div>
      )}
      {room.checkoutDate && room.status === 'occupied' && (
        <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <Clock className="w-3 h-3 inline mr-1" />
          {formatDate(room.checkoutDate)}
        </div>
      )}
    </motion.button>
  );
};

const StatusFilterButtons: React.FC<{
  statusFilter: RoomStatus | 'all';
  setStatusFilter: (s: RoomStatus | 'all') => void;
  isDark: boolean;
  getStatusLabel: (s: RoomStatus) => string;
}> = ({ statusFilter, setStatusFilter, isDark, getStatusLabel }) => {
  const { t } = useTranslation();
  return (
  <div className="flex flex-wrap gap-1.5">
    {(['all', ...Object.keys(statusConfig)] as const).map(f => (
      <button
        key={f}
        onClick={() => setStatusFilter(f as RoomStatus | 'all')}
        className={`px-3 py-1.5 rounded-2xl text-xs sm:text-sm font-medium transition-transform active:scale-95 ${
          statusFilter === f 
            ? 'bg-yellow-400 text-black'
            : isDark ? 'bg-gray-700 text-gray-300 active:bg-gray-600' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
        }`}
      >
        {f === 'all' ? t('roomsView.all', { defaultValue: 'All' }) : getStatusLabel(f as RoomStatus)}
      </button>
    ))}
  </div>
  );
};

const FloorSelect: React.FC<{
  floorFilter: number | 'all';
  setFloorFilter: (f: number | 'all') => void;
  floors: number[];
  isDark: boolean;
}> = ({ floorFilter, setFloorFilter, floors, isDark }) => {
  const { t } = useTranslation();
  return (
  <select
    value={floorFilter}
    onChange={(e) => setFloorFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
    className={`px-3 py-1.5 rounded-2xl text-xs sm:text-sm ${
      isDark ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-gray-900 border-gray-200'
    } border`}
  >
    <option value="all">{t('roomsView.allFloors', { defaultValue: 'All Floors' })}</option>
    {floors.map(floor => (
      <option key={floor} value={floor}>{t('roomsView.floor', { floor, defaultValue: 'Floor {{floor}}' })}</option>
    ))}
  </select>
  );
};


const Modal: React.FC<{
  title: string;
  onClose: () => void;
  isDark: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}> = ({ title, onClose, isDark, size = 'md', children }) => {
  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
  };

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes the topmost RoomsView modal, matching the fixed table modals.
  // The Modal is only mounted while open, so no isOpen gate is needed. Only the
  // frontmost [role="dialog"] responds, so a child dialog above this one closes
  // first. Routes through onClose (which only closes) and never triggers a room
  // action/check-in/checkout - those live on buttons inside the modal body.
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

  return renderModalPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative w-full ${sizeClasses[size]} max-h-[90vh] overflow-y-auto rounded-2xl backdrop-blur-2xl border ring-1 shadow-2xl ${
          isDark ? 'bg-black/60 border-white/10 ring-white/15 shadow-black/50' : 'bg-white/60 border-white/70 ring-white/60 shadow-black/30'
        }`}
      >
        <div className={`sticky top-0 z-10 flex items-center justify-between p-4 border-b backdrop-blur-xl ${
          isDark ? 'border-white/10 bg-black/60' : 'border-white/40 bg-white/60'
        }`}>
          <h2 id={titleId} className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{title}</h2>
          <button
            onClick={onClose}
            className={`h-9 w-9 rounded-full inline-flex items-center justify-center transition-transform active:scale-95 ${isDark ? 'text-white active:bg-white/15' : 'text-gray-700 active:bg-gray-200'}`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
};

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  color: string;
  onClick: () => void;
  className?: string;
}> = ({ icon, label, color, onClick, className }) => {
  const colorClasses: Record<string, string> = {
    emerald: 'bg-emerald-500/10 text-emerald-500 active:bg-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-500 active:bg-amber-500/20',
  };
  
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 py-3 px-4 rounded-2xl font-medium transition-transform active:scale-95 ${colorClasses[color]} ${className || ''}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

const InputField: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  isDark: boolean;
  type?: string;
  required?: boolean;
}> = ({ icon, label, value, onChange, isDark, type = 'text', required }) => (
  <div>
    <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
      {label} {required && <span className="text-red-500">*</span>}
    </label>
    <div className="relative">
      <span className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
        {icon}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full pl-9 pr-3 py-2.5 rounded-xl text-sm ${
          isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
        } border focus:ring-2 focus:ring-yellow-400`}
      />
    </div>
  </div>
);
