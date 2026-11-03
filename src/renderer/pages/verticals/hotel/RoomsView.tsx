import { HotelSettlementModal } from './HotelSettlementModal';
import { HotelVatField } from './HotelVatField';
import { hotelErrorCode, postHotelCharge, printHotelFolio } from '../../../services/HotelSettlementService';
import { canChargeFolio, recordedFolioCurrency } from '../../../utils/folio-currency';
import { getStoreCurrency } from '../../../utils/store-currency';
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
import { formatCurrency } from '../../../utils/format';
import { useHotelClock } from '../../../hooks/useHotelClock';
import { roomWorkflowError } from '../../../utils/room-workflow';
import { reservationsService } from '../../../services/ReservationsService';
import { RoomCheckinModal, RoomReservationModal, RoomStaySelectorModal } from '../../../components/modals/RoomStayWorkflowModals';
import { posApiFetch, posApiPost } from '../../../utils/api-helpers';
import {
  parseFolioCheckoutOutstanding,
  type FolioChargeType,
  type FolioPaymentMethod,
} from '../../../utils/guest-billing';
import { 
  Bed, RefreshCw, Users, Wrench, Sparkles, Calendar, X, 
  CreditCard, Receipt, User, Phone, Mail, DollarSign,
} from 'lucide-react';
import {
  RoomBedIcon, WorkspaceChips, WorkspaceGroup, WorkspaceHeader, WorkspaceIconButton, WorkspaceSearch, WorkspaceSelect,
} from '../../../components/tables/TableWorkspace';
import type { Room, RoomStatus, RoomFilters } from '../../../services/RoomsService';
import { getRoomEffectiveStatus } from '../../../services/RoomsService';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
import { CentsMoneyInput } from '../../../components/ui/CentsMoneyInput';
import { getBridge, offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

const statusConfig: Record<RoomStatus, { color: string; bgClass: string; icon: typeof Bed; label: string }> = {
  available: { color: 'text-emerald-700 dark:text-emerald-400', bgClass: 'bg-(--pos-s-surface-2) border-(--pos-s-border)', icon: Sparkles, label: 'Available' },
  occupied: { color: 'text-orange-700 dark:text-orange-400', bgClass: 'bg-(--pos-s-surface-2) border-(--pos-s-border)', icon: Users, label: 'Occupied' },
  cleaning: { color: 'text-amber-700 dark:text-amber-400', bgClass: 'bg-(--pos-s-surface-2) border-(--pos-s-border)', icon: Sparkles, label: 'Cleaning' },
  maintenance: { color: 'text-red-700 dark:text-red-400', bgClass: 'bg-(--pos-s-surface-2) border-(--pos-s-border)', icon: Wrench, label: 'Maintenance' },
  reserved: { color: 'text-yellow-700 dark:text-yellow-400', bgClass: 'bg-(--pos-s-surface-2) border-(--pos-s-border)', icon: Calendar, label: 'Reserved' },
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
  clientRequestId: string;
  vatCategoryCode: string;
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
  room.activeFolio?.guestName || null;

// Locale-aware money formatting: delegates to the shared POS currency helper so
// Greek shows "145,00 €" instead of a hardcoded "$145.00".
const formatMoney = (amount: number, currency: string | null = getStoreCurrency()): string => formatCurrency(Number(amount) || 0, currency);

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
  // Self-gate (the room views used to check only guest_billing/reservations): an
  // organization without the module gets one clear line instead of a board that 403s.
  const hasRoomsModule = isModuleEnabled('rooms' as any);

  const [branchId, setBranchId] = useState<string | null>(null);
  const [localOrgId, setLocalOrgId] = useState<string | null>(null);
  
  // Filter states
  const [statusFilter, setStatusFilter] = useState<RoomStatus | 'all'>('all');
  const [floorFilter, setFloorFilter] = useState<number | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  
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
  const { clock } = useHotelClock();
  const [settlementRequest, setSettlementRequest] = useState<{ folioId: string; amountCents: number; room: Room } | null>(null);
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

  // Each status chip counts the whole branch, not the filtered grid.
  const roomStatusCounts = useMemo(() => {
    const counts: Record<RoomStatus, number> = { available: 0, occupied: 0, cleaning: 0, maintenance: 0, reserved: 0 };
    for (const room of allRooms) counts[getRoomEffectiveStatus(room)] += 1;
    return counts;
  }, [allRooms]);

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
    if (hasGuestBilling || getRoomEffectiveStatus(room) === 'occupied') {
      toast.error(t('roomsView.toasts.folioCheckoutOffline', { defaultValue: 'Folio checkout requires an online connection' }));
      return false;
    }

    if (hasReservations) {
      reservationsService.setContext(branchId || '', effectiveOrgId || '');
      const reservation = await reservationsService.getActiveRoomReservation(room.id, clock().date);
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
          checkOutDate: clock().date,
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
    const currency = recordedFolioCurrency(checkoutPaymentData.room.activeFolio?.currency);
    if (!currency) { toast.error(t('guestBilling.errors.currencyUnavailable')); return; }

    const amount = Number(checkoutPaymentData.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('roomsView.toasts.invalidPaymentAmount', { defaultValue: 'Enter a valid payment amount' }));
      return;
    }

    setSettlementRequest({ folioId: checkoutPaymentData.folioId, amountCents: Math.round(amount * 100), room: checkoutPaymentData.room });
    setModalType('none');
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
      chargeType: 'other', clientRequestId: crypto.randomUUID(), vatCategoryCode: '',
      description: `Room ${room.roomNumber} charge`,
      amount: '',
      quantity: '1',
      notes: '',
    });
    setModalType('charge');
  };

  const handleAddFolioCharge = async () => {
    if (!folioChargeData) return;
    const currency = recordedFolioCurrency(folioChargeData.room.activeFolio?.currency);
    if (!currency) { toast.error(t('guestBilling.errors.currencyUnavailable')); return; }
    if (!canChargeFolio(currency, getStoreCurrency())) { toast.error(t('guestBilling.errors.currencyMismatch')); return; }

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
    if (!folioChargeData.vatCategoryCode) { toast.error(t('hotelMoney.chooseVat')); return; }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      toast.error(t('roomsView.toasts.invalidQuantity', { defaultValue: 'Enter a valid quantity' }));
      return;
    }

    try {
      const response = await postHotelCharge<{ success?: boolean; error?: string }>(
        folioChargeData.folioId,
        {
          chargeType: folioChargeData.chargeType,
          clientRequestId: folioChargeData.clientRequestId, vatCategoryCode: folioChargeData.vatCategoryCode,
          currency,
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
      toast.error(t(`hotelMoney.errors.${hotelErrorCode(error)}`));
    }
  };

  const getStatusLabel = (status: RoomStatus) => {
    return t(`roomsView.status.${status}`, { defaultValue: statusConfig[status].label });
  };

  // Create/check-in/reservation selector options: derive from the full branch room set
  // (allRooms), filtered only by effective availability — NOT from the grid-filtered rooms,
  // so a staff search/status/floor filter on the grid never hides selectable rooms.



  if (!hasRoomsModule) {
    return (
      <div className={`p-6 text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`} data-testid="rooms-module-required">
        {t('roomsView.moduleRequired')}
      </div>
    );
  }

  return (
    // Founder 31/10: the shared workspace -- title with plain figures, search and refresh on one row,
    // status chips with counts, the app's floor dropdown, floor groups and the same tile as a table.
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="table-workspace h-full" data-theme={isDark ? 'dark' : 'light'} data-rooms-workspace>
      <div className="table-workspace-controls">
        <WorkspaceHeader
          heading={t('dashboard.tabs.rooms', { defaultValue: 'Rooms' })}
          stats={[
            { key: 'available', label: t('roomsView.stats.available', { defaultValue: 'Available' }), value: stats.availableRooms, sub: `/${stats.totalRooms}` },
            { key: 'occupied', label: t('roomsView.stats.occupied', { defaultValue: 'Occupied' }), value: stats.occupiedRooms },
            { key: 'cleaning', label: t('roomsView.stats.cleaning', { defaultValue: 'Cleaning' }), value: stats.cleaningRooms },
            { key: 'occupancy', label: t('roomsView.stats.occupancy', { defaultValue: 'Occupancy' }), value: `${stats.occupancyRate}%` },
          ]}
        >
          <WorkspaceSearch value={searchTerm} onChange={setSearchTerm} placeholder={t('roomsView.searchPlaceholder', { defaultValue: 'Search room or guest...' })} />
          <WorkspaceIconButton label={t('common.refresh', { defaultValue: 'Refresh' })} onClick={() => refetch()}>
            <RefreshCw className={isLoading ? 'animate-spin' : undefined} />
          </WorkspaceIconButton>
        </WorkspaceHeader>
        <div className="table-workspace-toolbar" data-rooms-filter-bar>
          <WorkspaceChips<RoomStatus | 'all'>
            label={t('dashboard.tabs.rooms', { defaultValue: 'Rooms' })}
            value={statusFilter}
            onChange={handleManualStatusFilterChange}
            items={[
              { key: 'all', label: t('roomsView.all', { defaultValue: 'All' }), count: allRooms.length },
              ...(Object.keys(statusConfig) as RoomStatus[]).map((status) => ({ key: status, label: getStatusLabel(status), count: roomStatusCounts[status] })),
            ]}
          />
          <span className="table-workspace-spacer" aria-hidden="true" />
          {floors.length > 1 && (
            <WorkspaceSelect
              label={t('roomsView.allFloors', { defaultValue: 'All Floors' })}
              value={String(floorFilter)}
              onChange={(value) => setFloorFilter(value === 'all' ? 'all' : Number(value))}
              options={[
                { value: 'all', label: t('roomsView.allFloors', { defaultValue: 'All Floors' }) },
                ...floors.map((floor) => ({ value: String(floor), label: t('roomsView.floor', { floor, defaultValue: 'Floor {{floor}}' }) })),
              ]}
            />
          )}
        </div>
      </div>

      {/* Loading State */}
      {isLoading && rooms.length === 0 && (
        <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--table-muted)' }}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          {t('roomsView.loading', { defaultValue: 'Loading rooms...' })}
        </div>
      )}

      {/* Rooms Grid, one group per floor */}
      {!isLoading && (
        <div className="mt-3 min-h-0 flex-1 overflow-hidden">
          {/* Round 236: when embedded in the Orders hub the native scrollbar stays hidden. */}
          <div className={`table-workspace-scroll ${embedded ? 'scrollbar-hide' : ''}`}>
            {floors.map(floor => {
              const floorRooms = rooms.filter(r => r.floor === floor);
              if (floorRooms.length === 0) return null;
              return (
                <WorkspaceGroup key={floor} heading={t('roomsView.floor', { floor, defaultValue: 'Floor {{floor}}' })} count={floorRooms.length}>
                  <motion.div variants={pageMotionContainer} className="table-workspace-grid">
                    {floorRooms.map(room => (
                      <RoomCard key={room.id} room={room} onClick={() => handleRoomClick(room)} />
                    ))}
                  </motion.div>
                </WorkspaceGroup>
              );
            })}

            {rooms.length === 0 && (
              <div className="text-center py-12" style={{ color: 'var(--table-muted)' }}>
                <Bed className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium mb-2">{t('roomsView.noRooms', { defaultValue: 'No rooms found' })}</p>
                <p className="text-sm">{t('roomsView.noRoomsHint', { defaultValue: 'Try adjusting your filters' })}</p>
              </div>
            )}
          </div>
        </div>
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
          className="bottom-20! sm:bottom-6!"
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
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.status', { defaultValue: 'Status' })}</span>
                <span className={`font-medium ${statusConfig[getRoomEffectiveStatus(actionRoom)].color}`}>
                  {getStatusLabel(getRoomEffectiveStatus(actionRoom))}
                </span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.type', { defaultValue: 'Type' })}</span>
                <span className={`font-medium capitalize ${isDark ? 'text-white' : 'text-gray-900'}`}>{translateRoomType(t, actionRoom.roomType)}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.capacity', { defaultValue: 'Capacity' })}</span>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('roomsView.fields.guestsCount', { count: actionRoom.capacity, defaultValue: '{{count}} guests' })}</span>
              </div>
              {actionRoom.ratePerNight && (
                <div className="flex items-center justify-between">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.ratePerNight', { defaultValue: 'Rate/Night' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatMoney(actionRoom.ratePerNight)}</span>
                </div>
              )}
              {getRoomGuestName(actionRoom) && (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-600">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.guest', { defaultValue: 'Guest' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{getRoomGuestName(actionRoom)}</span>
                </div>
              )}
              {actionRoom.activeFolio && (
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.fields.folioBalance', { defaultValue: 'Folio Balance' })}</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {formatMoney(actionRoom.activeFolio.balanceCents / 100, actionRoom.activeFolio.currency ?? null)}
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
              <p className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('roomsView.changeStatus', { defaultValue: 'Change Status' })}</p>
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

      {settlementRequest && <HotelSettlementModal folioId={settlementRequest.folioId} amountCents={settlementRequest.amountCents}
        onClose={() => { setSettlementRequest(null); void refetch(); }} onCollected={async () => {
          const room = settlementRequest.room; setSettlementRequest(null);
          try {
            await getBridge().sync.force();
            await submitRoomCheckout(room);
          } catch (error) { toast.error(roomWorkflowError(error, t)); await refetch(); }
        }} />}
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
                  {formatMoney(Number(checkoutPaymentData.amount || 0), checkoutPaymentData.room.activeFolio?.currency ?? null)}
                </span>
              </div>
            </div>

            <InputField
              icon={<DollarSign className="w-4 h-4" />}
              label={t('roomsView.paymentAmount', { defaultValue: 'Payment Amount' })}
              money
              value={checkoutPaymentData.amount}
              onChange={(value) => setCheckoutPaymentData(prev => prev ? { ...prev, amount: value } : prev)}
              isDark={isDark}
              required
            />

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('action')}
                className={`flex-1 py-3 rounded-2xl font-medium ${
                  isDark ? 'bg-(--pos-s-surface-2) text-(--pos-s-fg) active:bg-(--pos-s-surface-2)' : 'bg-(--pos-s-surface-2) text-(--pos-s-fg) active:bg-(--pos-s-surface-2)'
                }`}
              >
                {t('common.actions.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={handleCheckoutPayment}
                className="pos-raised pos-raised--yellow flex-1 py-3 rounded-xl font-medium bg-(--pos-s-yellow) text-black active:bg-yellow-500"
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
                        ? 'bg-(--pos-s-yellow) text-black'
                        : isDark ? 'bg-gray-700 text-gray-300 active:bg-gray-600' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                    }`}
                  >
                    {t(`roomsView.chargeTypes.${type}`, { defaultValue: type })}
                  </button>
                ))}
              </div>
            </div>

            <HotelVatField value={folioChargeData.vatCategoryCode} onChange={vatCategoryCode => setFolioChargeData(prev => prev ? { ...prev, vatCategoryCode } : prev)} />
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
                money
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
                className="pos-raised pos-raised--yellow flex-1 py-3 rounded-xl font-medium bg-(--pos-s-yellow) text-black active:bg-yellow-500"
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
// Founder 31/10: the same tile as a table -- a double bed with sparkles glowing in the status colour,
// the number, the room type and the status word on every room (it used to show only when it differed
// from the stored status). A guest and an open folio add their line underneath.
const RoomCard: React.FC<{ room: Room; onClick: () => void }> = ({ room, onClick }) => {
  const { t } = useTranslation();
  const effectiveStatus = getRoomEffectiveStatus(room);
  const statusLabel = t(`roomsView.status.${effectiveStatus}`, { defaultValue: statusConfig[effectiveStatus].label });
  const guestName = getRoomGuestName(room);
  return (
    <motion.button
      variants={pageMotionItem}
      type="button"
      onClick={onClick}
      className="table-workspace-card"
      data-status={effectiveStatus}
      data-room-id={room.id}
      aria-label={`${room.roomNumber} · ${statusLabel}`}
    >
      <span className="table-workspace-tile">
        <RoomBedIcon />
        <span className="table-workspace-tile-info">
          <strong className="table-workspace-number">{room.roomNumber}</strong>
          <span className="table-workspace-meta">{translateRoomType(t, room.roomType)}</span>
          <span className="table-workspace-status"><i aria-hidden="true" />{statusLabel}</span>
        </span>
      </span>
      {(guestName || room.activeFolio) && (
        <span className="table-workspace-check">
          <span className="table-workspace-check-meta">
            {guestName && <span><Users aria-hidden="true" />{guestName}</span>}
            {room.activeFolio && (
              <span><DollarSign aria-hidden="true" />{formatMoney(room.activeFolio.balanceCents / 100, room.activeFolio.currency ?? null)}</span>
            )}
          </span>
        </span>
      )}
    </motion.button>
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
    <div className="fixed inset-0 z-1200 flex items-center justify-center p-4">
      {/* Founder 01/11 («φτιάξε και αυτό που δεν είναι γυαλί»): the shared glass backdrop and shell, like every
          window; the header has no fill or blur of its own (a nested blur read as a white band), and only the
          body scrolls. */}
      <div className="liquid-glass-modal-backdrop absolute inset-0" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`liquid-glass-modal-shell relative flex w-full ${sizeClasses[size]} max-h-[90vh] flex-col overflow-hidden text-(--pos-s-fg)`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-(--modal-glass-line) p-4">
          <h2 id={titleId} className="text-lg font-bold text-(--pos-s-fg)">{title}</h2>
          <button
            onClick={onClose}
            className="liquid-glass-modal-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-hide">{children}</div>
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
    emerald: 'bg-(--pos-s-surface-2) text-emerald-800 dark:text-emerald-300 active:bg-(--pos-s-surface-2)',
    amber: 'bg-(--pos-s-surface-2) text-amber-800 dark:text-amber-300 active:bg-(--pos-s-surface-2)',
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
  /** Money field: digit entry in cents, the value kept as a plain decimal string. */
  money?: boolean;
  required?: boolean;
}> = ({ icon, label, value, onChange, isDark, type = 'text', money = false, required }) => {
  const fieldClassName = `w-full pl-9 pr-3 py-2.5 rounded-xl text-sm ${
    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
  } border focus:ring-2 focus:ring-yellow-400`;
  return (
    <div>
      <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="relative">
        <span className={`absolute left-3 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          {icon}
        </span>
        {money ? (
          <CentsMoneyInput aria-label={label} value={value} onValueChange={onChange} className={fieldClassName} />
        ) : (
          <input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={fieldClassName}
          />
        )}
      </div>
    </div>
  );
};
