/**
 * RoomsView - POS Room Status Grid (Redesigned)
 * 
 * Real-time room status management for hotel POS.
 * Features: Check-in, Reservations, Payment processing, Mobile responsive
 */

import React, { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useSystemClock } from '../../../hooks/useSystemClock';
import { useRooms } from '../../../hooks/useRooms';
import { formatDate } from '../../../utils/format';
import { addLocalDays, toLocalDateString } from '../../../utils/date';
import { reservationsService } from '../../../services/ReservationsService';
import { offlineRoomCheckin } from '../../../services/offline-mutations';
import { posApiFetch, posApiPost } from '../../../utils/api-helpers';
import {
  folioChargesEndpoint,
  folioPaymentsEndpoint,
  parseFolioCheckoutOutstanding,
  type FolioChargeType,
  type FolioPaymentMethod,
} from '../../../utils/guest-billing';
import { OrderService } from '../../../../services/OrderService';
import { 
  Bed, RefreshCw, Users, Wrench, Sparkles, Calendar, X, 
  CreditCard, Receipt, Clock, User, Phone, Mail, DollarSign,
  ChevronDown, Filter, Search
} from 'lucide-react';
import type { Room, RoomStatus, RoomFilters } from '../../../services/RoomsService';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';
import { getBridge, offEvent, onEvent } from '../../../../lib';
import {
  getCachedTerminalCredentials,
  refreshTerminalCredentialCache,
} from '../../../services/terminal-credentials';
import { pageMotionContainer, pageMotionItem } from '../../../components/ui/page-motion';

const statusConfig: Record<RoomStatus, { color: string; bgClass: string; icon: typeof Bed; label: string }> = {
  available: { color: 'text-emerald-500', bgClass: 'bg-emerald-500/10 border-emerald-500/30', icon: Sparkles, label: 'Available' },
  occupied: { color: 'text-blue-500', bgClass: 'bg-blue-500/10 border-blue-500/30', icon: Users, label: 'Occupied' },
  cleaning: { color: 'text-amber-500', bgClass: 'bg-amber-500/10 border-amber-500/30', icon: Sparkles, label: 'Cleaning' },
  maintenance: { color: 'text-red-500', bgClass: 'bg-red-500/10 border-red-500/30', icon: Wrench, label: 'Maintenance' },
  reserved: { color: 'text-purple-500', bgClass: 'bg-purple-500/10 border-purple-500/30', icon: Calendar, label: 'Reserved' },
};

type ModalType = 'none' | 'checkin' | 'reservation' | 'checkoutPayment' | 'charge' | 'action';

interface GuestInfo {
  name: string;
  phone: string;
  email: string;
  idNumber: string;
}

interface CheckinData {
  guestInfo: GuestInfo;
  roomId: string;
  nights: number;
  paymentMethod: 'cash' | 'card' | 'transfer';
  totalAmount: number;
}

interface ReservationData {
  guestInfo: GuestInfo;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
  notes: string;
}

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

interface RoomCheckinApiResponse {
  success: boolean;
  error?: string;
  idempotentReplay?: boolean;
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

const generateClientRequestId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

const getDefaultReservationDates = (base: Date) => ({
  checkInDate: toLocalDateString(base),
  checkOutDate: toLocalDateString(addLocalDays(base, 1)),
});

const mapPaymentMethod = (method: 'cash' | 'card' | 'transfer'): 'cash' | 'card' | 'digital' => {
  if (method === 'cash') return 'cash';
  if (method === 'card') return 'card';
  return 'digital';
};

const getRoomEffectiveStatus = (room: Room): RoomStatus => room.effectiveStatus || room.status;

const getRoomGuestName = (room: Room): string | null =>
  room.activeFolio?.guestName || room.currentGuestName || null;

const formatMoney = (amount: number): string => `$${amount.toFixed(2)}`;

export const RoomsView: React.FC = memo(() => {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId, isModuleEnabled } = useModules();
  const now = useSystemClock();
  const isDark = resolvedTheme === 'dark';
  const reservationDefaultDates = useMemo(() => getDefaultReservationDates(now), [now]);

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
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  
  // Check-in form state
  const [checkinData, setCheckinData] = useState<CheckinData>({
    guestInfo: { name: '', phone: '', email: '', idNumber: '' },
    roomId: '',
    nights: 1,
    paymentMethod: 'cash',
    totalAmount: 0,
  });
  
  // Reservation form state
  const [reservationData, setReservationData] = useState<ReservationData>({
    guestInfo: { name: '', phone: '', email: '', idNumber: '' },
    roomId: '',
    ...getDefaultReservationDates(new Date()),
    notes: '',
  });
  const [reservationDatesFollowClock, setReservationDatesFollowClock] = useState(true);
  const [checkoutPaymentData, setCheckoutPaymentData] = useState<CheckoutPaymentData | null>(null);
  const [folioChargeData, setFolioChargeData] = useState<FolioChargeData | null>(null);

  const hasGuestBilling = isModuleEnabled('guest_billing' as any);
  const hasOrders = isModuleEnabled('orders' as any);
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

  const { rooms, stats, floors, isLoading, refetch, updateStatus } = useRooms({
    branchId: branchId || '',
    organizationId: effectiveOrgId || '',
    filters,
    enableRealtime: true,
  });

  // Handlers
  const handleRoomClick = (room: Room) => {
    setActionRoom(room);
    setModalType('action');
  };

  const handleStatusChange = async (roomId: string, newStatus: RoomStatus) => {
    await updateStatus(roomId, newStatus);
    if (actionRoom?.id === roomId) {
      setActionRoom(prev => prev ? { ...prev, status: newStatus } : null);
    }
  };

  const openCheckinModal = (room?: Room) => {
    if (room) {
      setCheckinData(prev => ({
        ...prev,
        roomId: room.id,
        totalAmount: (room.ratePerNight || 0) * prev.nights,
      }));
    }
    setModalType('checkin');
  };

  const openReservationModal = (room?: Room) => {
    const defaults = getDefaultReservationDates(new Date());
    setReservationDatesFollowClock(true);
    setReservationData(prev => ({
      ...prev,
      roomId: room ? room.id : prev.roomId,
      checkInDate: defaults.checkInDate,
      checkOutDate: defaults.checkOutDate,
    }));
    setModalType('reservation');
  };

  useEffect(() => {
    if (modalType !== 'reservation' || !reservationDatesFollowClock) return;

    setReservationData((prev) => {
      if (
        prev.checkInDate === reservationDefaultDates.checkInDate &&
        prev.checkOutDate === reservationDefaultDates.checkOutDate
      ) {
        return prev;
      }

      return {
        ...prev,
        checkInDate: reservationDefaultDates.checkInDate,
        checkOutDate: reservationDefaultDates.checkOutDate,
      };
    });
  }, [modalType, reservationDatesFollowClock, reservationDefaultDates.checkInDate, reservationDefaultDates.checkOutDate]);

  const handleCheckin = async () => {
    if (!checkinData.roomId || !checkinData.guestInfo.name) return;

    try {
      if (!branchId || !effectiveOrgId) {
        toast.error('Missing branch or organization context');
        return;
      }

      const selectedRoom = rooms.find((room) => room.id === checkinData.roomId);
      if (!selectedRoom) {
        toast.error('Selected room not found');
        return;
      }

      const now = new Date();
      const checkInDate = toLocalDateString(now);
      const checkOutDate = toLocalDateString(addLocalDays(now, checkinData.nights));
      const reservationTime = now.toTimeString().slice(0, 5);

      if (hasGuestBilling) {
        const request = {
          guestName: checkinData.guestInfo.name,
          guestPhone: checkinData.guestInfo.phone || null,
          guestEmail: checkinData.guestInfo.email || null,
          checkInDate,
          checkOutDate,
          partySize: selectedRoom.capacity || 1,
          notes: checkinData.guestInfo.idNumber
            ? `Guest ID: ${checkinData.guestInfo.idNumber}`
            : null,
          clientRequestId: generateClientRequestId(),
        };

        if (isOnline) {
          const response = await posApiFetch<RoomCheckinApiResponse>(
            `/pos/rooms/${encodeURIComponent(selectedRoom.id)}/checkin`,
            {
              method: 'POST',
              body: JSON.stringify(request),
            },
          );

          if (!response.success || response.data?.success === false) {
            throw new Error(response.error || response.data?.error || 'Failed to check in room');
          }
        } else {
          await offlineRoomCheckin({
            roomId: selectedRoom.id,
            organizationId: effectiveOrgId,
            branchId,
            ...request,
          });
          toast.success('Check-in queued for sync');
        }
      } else {
        let reservationCreated = false;
        if (hasReservations) {
          reservationsService.setContext(branchId, effectiveOrgId);
          const reservation = await reservationsService.createReservation({
            customerName: checkinData.guestInfo.name,
            customerPhone: checkinData.guestInfo.phone || '',
            customerEmail: checkinData.guestInfo.email || undefined,
            partySize: selectedRoom.capacity || 1,
            reservationDate: checkInDate,
            reservationTime,
            roomId: selectedRoom.id,
            roomNumber: selectedRoom.roomNumber,
            checkInDate,
            checkOutDate,
            notes: checkinData.guestInfo.idNumber
              ? `ID: ${checkinData.guestInfo.idNumber}`
              : undefined,
          });
          await reservationsService.updateStatus(reservation.id, 'seated');
          reservationCreated = true;
        }

        const checkinStatusUpdated = await updateStatus(checkinData.roomId, 'occupied');
        if (!checkinStatusUpdated) {
          throw new Error('Failed to update room status to occupied');
        }

        if (hasOrders) {
          try {
            await createFallbackReceiptOrder({
              room: selectedRoom,
              guestName: checkinData.guestInfo.name,
              guestPhone: checkinData.guestInfo.phone || undefined,
              description: `Room ${selectedRoom.roomNumber} check-in (${checkinData.nights} night${checkinData.nights > 1 ? 's' : ''})`,
              amount: Number(checkinData.totalAmount) || 0,
              paymentMethod: checkinData.paymentMethod,
              notes: checkinData.guestInfo.idNumber ? `Guest ID: ${checkinData.guestInfo.idNumber}` : undefined,
            });
          } catch (billingError) {
            console.error('Fallback check-in receipt failed:', billingError);
            toast.error('Check-in completed, but receipt failed');
          }
        } else if (!reservationCreated) {
          toast.success('Room checked in without a reservation or receipt');
        }
      }

      await refetch();
      setCheckinData({
        guestInfo: { name: '', phone: '', email: '', idNumber: '' },
        roomId: '',
        nights: 1,
        paymentMethod: 'cash',
        totalAmount: 0,
      });
      setModalType('none');
      setActionRoom(null);
      toast.success('Check-in completed successfully');
    } catch (error) {
      console.error('Failed to complete check-in:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to complete check-in');
    }
  };

  const handleReservation = async () => {
    if (!reservationData.roomId || !reservationData.guestInfo.name) return;
    
    try {
      if (!hasReservations) {
        toast.error('Reservations module is required to create room reservations');
        return;
      }

      // Get the selected room for room number
      const selectedRoom = rooms.find(r => r.id === reservationData.roomId);
      
      // Set context for reservations service
      reservationsService.setContext(branchId || '', effectiveOrgId || '');
      
      // Create reservation record in database
      await reservationsService.createReservation({
        customerName: reservationData.guestInfo.name,
        customerPhone: reservationData.guestInfo.phone || '',
        customerEmail: reservationData.guestInfo.email || undefined,
        partySize: selectedRoom?.capacity || 2,
        reservationDate: reservationData.checkInDate,
        reservationTime: '14:00', // Default check-in time
        roomId: reservationData.roomId,
        roomNumber: selectedRoom?.roomNumber,
        checkInDate: reservationData.checkInDate,
        checkOutDate: reservationData.checkOutDate,
        notes: reservationData.notes || undefined,
      });
      
      if (reservationData.checkInDate === toLocalDateString()) {
        await updateStatus(reservationData.roomId, 'reserved');
      }
      
      toast.success('Reservation created successfully');
      
      // Reset and close
      const defaults = getDefaultReservationDates(new Date());
      setReservationDatesFollowClock(true);
      setReservationData({
        guestInfo: { name: '', phone: '', email: '', idNumber: '' },
        roomId: '',
        checkInDate: defaults.checkInDate,
        checkOutDate: defaults.checkOutDate,
        notes: '',
      });
      setModalType('none');
    } catch (error) {
      console.error('Failed to create reservation:', error);
      toast.error('Failed to create reservation');
    }
  };

  const completeCheckoutLocally = async (room: Room): Promise<boolean> => {
    if (hasGuestBilling && room.activeFolio) {
      toast.error('Folio checkout requires an online connection');
      return false;
    }

    const updated = await updateStatus(room.id, 'cleaning');
    if (!updated) {
      throw new Error('Failed to update room status to cleaning');
    }

    setModalType('none');
    setActionRoom(null);
    await refetch();
    toast.success('Checkout queued for sync');
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
      toast.error('Checkout completed, but housekeeping task creation failed');
    }
    if (body?.folioSkippedReason === 'module_revoked') {
      toast('Checkout completed; folio settlement was skipped because guest billing is not available');
    }
    toast.success(body?.alreadyConverged ? 'Checkout already completed' : 'Checkout completed');
    return true;
  };

  const handleCheckout = async () => {
    if (!actionRoom) return;

    try {
      if (!branchId || !effectiveOrgId) {
        toast.error('Missing branch or organization context');
        return;
      }

      await submitRoomCheckout(actionRoom);
    } catch (error) {
      console.error('Failed to checkout room:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to complete checkout');
    }
  };

  const handleCheckoutPayment = async () => {
    if (!checkoutPaymentData) return;

    const amount = Number(checkoutPaymentData.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid payment amount');
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

      toast.success('Payment posted');
      await submitRoomCheckout(checkoutPaymentData.room);
    } catch (error) {
      console.error('Failed to post checkout payment:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to post payment');
    }
  };

  const openFolioChargeModal = (room: Room) => {
    if (!room.activeFolio) {
      toast.error('No active folio is available for this room');
      return;
    }
    if (!isOnline) {
      toast.error('Adding a folio charge requires an online connection');
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
      toast.error('Enter a charge description');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid charge amount');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast.error('Enter a valid quantity');
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

      toast.success('Charge added');
      setModalType('action');
      setFolioChargeData(null);
      await refetch();
    } catch (error) {
      console.error('Failed to add folio charge:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to add charge');
    }
  };

  const getStatusLabel = (status: RoomStatus) => {
    return t(`roomsView.status.${status}`, { defaultValue: statusConfig[status].label });
  };

  const availableRooms = rooms.filter(r => getRoomEffectiveStatus(r) === 'available');

  const createFallbackReceiptOrder = useCallback(async (params: {
    room: Room;
    guestName: string;
    guestPhone?: string;
    description: string;
    amount: number;
    paymentMethod: 'cash' | 'card' | 'transfer';
    notes?: string;
  }) => {
    if (params.amount <= 0) {
      return null;
    }

    const orderService = OrderService.getInstance();
    const order = await orderService.createOrder({
      customer_name: params.guestName,
      customer_phone: params.guestPhone || undefined,
      items: [
        {
          id: `hotel-${params.room.id}-${Date.now()}`,
          name: params.description,
          quantity: 1,
          price: params.amount,
          notes: params.notes || undefined,
        } as any,
      ],
      total_amount: params.amount,
      subtotal: params.amount,
      status: 'completed',
      order_type: 'pickup',
      payment_status: 'completed',
      payment_method: mapPaymentMethod(params.paymentMethod),
      notes: params.notes || params.description,
    } as any);

    if (order?.id) {
      await bridge.payments.printReceipt(order.id, 'customer');
    }

    return order;
  }, [bridge]);

  // Calculate total for check-in
  const updateCheckinTotal = useCallback((nights: number, roomId: string) => {
    const room = rooms.find(r => r.id === roomId);
    const rate = room?.ratePerNight || 0;
    setCheckinData(prev => ({ ...prev, nights, totalAmount: rate * nights }));
  }, [rooms]);

  if (!branchId || !effectiveOrgId) {
    return (
      <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <Bed className="w-16 h-16 mb-4 opacity-30" />
        <p className="text-lg">{t('roomsView.noBranch', { defaultValue: 'Please select a branch to view rooms' })}</p>
        <p className="text-xs mt-2 opacity-60">
          {!branchId ? 'Missing: branch_id' : ''} {!effectiveOrgId ? 'Missing: organization_id' : ''}
        </p>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="show" variants={pageMotionContainer} className="h-full flex flex-col p-3 sm:p-4 overflow-hidden">
      {/* Stats Bar - Responsive */}
      <motion.div variants={pageMotionContainer} className="grid grid-cols-3 sm:grid-cols-5 gap-2 sm:gap-3 mb-3 sm:mb-4">
        <StatCard label="Total" value={stats.totalRooms} isDark={isDark} />
        <StatCard label="Available" value={stats.availableRooms} color="text-emerald-500" isDark={isDark} />
        <StatCard label="Occupied" value={stats.occupiedRooms} color="text-blue-500" isDark={isDark} />
        <StatCard label="Cleaning" value={stats.cleaningRooms} color="text-amber-500" isDark={isDark} className="hidden sm:block" />
        <StatCard label="Occupancy" value={`${stats.occupancyRate}%`} isDark={isDark} className="hidden sm:block" />
      </motion.div>

      {/* Search & Filter Bar */}
      <motion.div variants={pageMotionItem} className="flex flex-col sm:flex-row gap-2 sm:gap-3 mb-3 sm:mb-4">
        {/* Search */}
        <div className={`relative flex-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-50" />
          <input
            type="text"
            placeholder="Search room or guest..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`w-full pl-9 pr-4 py-2.5 rounded-xl text-sm ${
              isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
            } border focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
          />
        </div>
        
        {/* Filter Toggle (Mobile) */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`sm:hidden flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl ${
            isDark ? 'bg-gray-800' : 'bg-white border border-gray-200'
          }`}
        >
          <Filter className="w-4 h-4" />
          <span className="text-sm">Filters</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
        </button>

        {/* Desktop Filters */}
        <div className="hidden sm:flex gap-2">
          <StatusFilterButtons statusFilter={statusFilter} setStatusFilter={setStatusFilter} isDark={isDark} getStatusLabel={getStatusLabel} />
          {floors.length > 1 && (
            <FloorSelect floorFilter={floorFilter} setFloorFilter={setFloorFilter} floors={floors} isDark={isDark} />
          )}
        </div>

        {/* Refresh Button */}
        <button
          onClick={() => refetch()}
          className={`hidden sm:flex items-center justify-center w-10 h-10 rounded-xl ${
            isDark ? 'bg-gray-800 hover:bg-gray-700' : 'bg-white border border-gray-200 hover:bg-gray-50'
          }`}
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </motion.div>

      {/* Mobile Filters (Collapsible) */}
      {showFilters && (
        <motion.div variants={pageMotionItem} className={`sm:hidden flex flex-wrap gap-2 mb-3 p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
          <StatusFilterButtons statusFilter={statusFilter} setStatusFilter={setStatusFilter} isDark={isDark} getStatusLabel={getStatusLabel} />
          {floors.length > 1 && (
            <FloorSelect floorFilter={floorFilter} setFloorFilter={setFloorFilter} floors={floors} isDark={isDark} />
          )}
        </motion.div>
      )}

      {/* Loading State */}
      {isLoading && rooms.length === 0 && (
        <motion.div variants={pageMotionItem} className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          Loading rooms...
        </motion.div>
      )}

      {/* Rooms Grid */}
      {!isLoading && (
        <motion.div variants={pageMotionContainer} className="flex-1 overflow-y-auto space-y-4 pb-20">
          {floors.map(floor => {
            const floorRooms = rooms.filter(r => r.floor === floor);
            if (floorRooms.length === 0) return null;
            
            return (
              <motion.div key={floor} variants={pageMotionItem}>
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  Floor {floor}
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
              <p className="text-lg font-medium mb-2">No rooms found</p>
              <p className="text-sm">Try adjusting your filters</p>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* Floating Action Button */}
      <FloatingActionButton
        onClick={() => setModalType('checkin')}
        aria-label="New Check-in or Reservation"
        className="!bottom-20 sm:!bottom-6"
      />

      {/* Room Action Modal */}
      {modalType === 'action' && actionRoom && (
        <Modal title={`Room ${actionRoom.roomNumber}`} onClose={() => { setModalType('none'); setActionRoom(null); }} isDark={isDark}>
          <div className="space-y-4">
            {/* Room Info */}
            <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Status</span>
                <span className={`font-medium ${statusConfig[getRoomEffectiveStatus(actionRoom)].color}`}>
                  {getStatusLabel(getRoomEffectiveStatus(actionRoom))}
                </span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Type</span>
                <span className={`font-medium capitalize ${isDark ? 'text-white' : 'text-gray-900'}`}>{actionRoom.roomType}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Capacity</span>
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{actionRoom.capacity} guests</span>
              </div>
              {actionRoom.ratePerNight && (
                <div className="flex items-center justify-between">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Rate/Night</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>${actionRoom.ratePerNight}</span>
                </div>
              )}
              {getRoomGuestName(actionRoom) && (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-600">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Guest</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{getRoomGuestName(actionRoom)}</span>
                </div>
              )}
              {actionRoom.activeFolio && (
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Folio Balance</span>
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
                  <ActionButton icon={<Users className="w-5 h-5" />} label="Check-in" color="blue" onClick={() => openCheckinModal(actionRoom)} />
                  {hasReservations && (
                    <ActionButton icon={<Calendar className="w-5 h-5" />} label="Reserve" color="purple" onClick={() => openReservationModal(actionRoom)} />
                  )}
                </>
              )}
              {actionRoom.status === 'occupied' && (
                <>
                  <ActionButton icon={<Receipt className="w-5 h-5" />} label="Checkout" color="emerald" onClick={handleCheckout} />
                  {hasGuestBilling && actionRoom.activeFolio && (
                    <ActionButton icon={<DollarSign className="w-5 h-5" />} label="Add Charge" color="amber" onClick={() => openFolioChargeModal(actionRoom)} />
                  )}
                </>
              )}
              {getRoomEffectiveStatus(actionRoom) === 'reserved' && (
                <ActionButton icon={<Users className="w-5 h-5" />} label="Check-in" color="blue" onClick={() => openCheckinModal(actionRoom)} className="col-span-2" />
              )}
            </div>

            {/* Quick Status Change */}
            <div>
              <p className={`text-xs font-medium mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Change Status</p>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(statusConfig) as RoomStatus[]).map(status => (
                  <button
                    key={status}
                    onClick={() => handleStatusChange(actionRoom.id, status)}
                    disabled={actionRoom.status === status}
                    className={`py-2 px-2 rounded-lg text-xs font-medium transition-all ${
                      actionRoom.status === status
                        ? `${statusConfig[status].bgClass} ${statusConfig[status].color}`
                        : isDark 
                          ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' 
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
          title={`Settle Room ${checkoutPaymentData.room.roomNumber}`}
          onClose={() => setModalType('action')}
          isDark={isDark}
        >
          <div className="space-y-4">
            <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-blue-50'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Outstanding Balance</span>
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {formatMoney(Number(checkoutPaymentData.amount || 0))}
                </span>
              </div>
            </div>

            <InputField
              icon={<DollarSign className="w-4 h-4" />}
              label="Payment Amount"
              type="number"
              value={checkoutPaymentData.amount}
              onChange={(value) => setCheckoutPaymentData(prev => prev ? { ...prev, amount: value } : prev)}
              isDark={isDark}
              required
            />

            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Payment Method
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(['cash', 'card', 'bank_transfer', 'other'] as FolioPaymentMethod[]).map(method => (
                  <button
                    key={method}
                    onClick={() => setCheckoutPaymentData(prev => prev ? { ...prev, paymentMethod: method } : prev)}
                    className={`py-2.5 px-3 rounded-xl text-sm font-medium capitalize transition-all ${
                      checkoutPaymentData.paymentMethod === method
                        ? 'bg-emerald-500 text-white'
                        : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {method.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            <InputField
              icon={<Receipt className="w-4 h-4" />}
              label="Reference"
              value={checkoutPaymentData.reference}
              onChange={(value) => setCheckoutPaymentData(prev => prev ? { ...prev, reference: value } : prev)}
              isDark={isDark}
            />

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('action')}
                className={`flex-1 py-3 rounded-xl font-medium ${
                  isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleCheckoutPayment}
                className="flex-1 py-3 rounded-xl font-medium bg-emerald-500 text-white hover:bg-emerald-600"
              >
                Post Payment & Checkout
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modalType === 'charge' && folioChargeData && (
        <Modal
          title={`Add Charge - Room ${folioChargeData.room.roomNumber}`}
          onClose={() => setModalType('action')}
          isDark={isDark}
          size="lg"
        >
          <div className="space-y-4">
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Charge Type
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['other', 'room', 'food', 'beverage', 'service', 'tax'] as FolioChargeType[]).map(type => (
                  <button
                    key={type}
                    onClick={() => setFolioChargeData(prev => prev ? { ...prev, chargeType: type } : prev)}
                    className={`py-2.5 px-3 rounded-xl text-sm font-medium capitalize transition-all ${
                      folioChargeData.chargeType === type
                        ? 'bg-amber-500 text-white'
                        : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <InputField
              icon={<Receipt className="w-4 h-4" />}
              label="Description"
              value={folioChargeData.description}
              onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, description: value } : prev)}
              isDark={isDark}
              required
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InputField
                icon={<DollarSign className="w-4 h-4" />}
                label="Amount"
                type="number"
                value={folioChargeData.amount}
                onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, amount: value } : prev)}
                isDark={isDark}
                required
              />
              <InputField
                icon={<Receipt className="w-4 h-4" />}
                label="Quantity"
                type="number"
                value={folioChargeData.quantity}
                onChange={(value) => setFolioChargeData(prev => prev ? { ...prev, quantity: value } : prev)}
                isDark={isDark}
                required
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Notes
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
                  isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleAddFolioCharge}
                className="flex-1 py-3 rounded-xl font-medium bg-amber-500 text-white hover:bg-amber-600"
              >
                Add Charge
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Check-in Modal */}
      {modalType === 'checkin' && (
        <Modal title="New Check-in" onClose={() => setModalType('none')} isDark={isDark} size="lg">
          <div className="space-y-4">
            {/* Room Selection */}
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Select Room
              </label>
              <select
                value={checkinData.roomId}
                onChange={(e) => {
                  setCheckinData(prev => ({ ...prev, roomId: e.target.value }));
                  updateCheckinTotal(checkinData.nights, e.target.value);
                }}
                className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                  isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                } border focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">Choose a room...</option>
                {availableRooms.map(room => (
                  <option key={room.id} value={room.id}>
                    Room {room.roomNumber} - {room.roomType} (${room.ratePerNight}/night)
                  </option>
                ))}
              </select>
            </div>

            {/* Guest Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InputField
                icon={<User className="w-4 h-4" />}
                label="Guest Name"
                value={checkinData.guestInfo.name}
                onChange={(v) => setCheckinData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, name: v } }))}
                isDark={isDark}
                required
              />
              <InputField
                icon={<Phone className="w-4 h-4" />}
                label="Phone"
                value={checkinData.guestInfo.phone}
                onChange={(v) => setCheckinData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, phone: v } }))}
                isDark={isDark}
              />
              <InputField
                icon={<Mail className="w-4 h-4" />}
                label="Email"
                type="email"
                value={checkinData.guestInfo.email}
                onChange={(v) => setCheckinData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, email: v } }))}
                isDark={isDark}
              />
              <InputField
                icon={<CreditCard className="w-4 h-4" />}
                label="ID Number"
                value={checkinData.guestInfo.idNumber}
                onChange={(v) => setCheckinData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, idNumber: v } }))}
                isDark={isDark}
              />
            </div>

            {/* Stay Duration */}
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Number of Nights
              </label>
              <input
                type="number"
                min="1"
                value={checkinData.nights}
                onChange={(e) => {
                  const nights = parseInt(e.target.value) || 1;
                  updateCheckinTotal(nights, checkinData.roomId);
                }}
                className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                  isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                } border focus:ring-2 focus:ring-blue-500`}
              />
            </div>

            {!hasGuestBilling && hasOrders && (
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Payment Method
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['cash', 'card', 'transfer'] as const).map(method => (
                    <button
                      key={method}
                      onClick={() => setCheckinData(prev => ({ ...prev, paymentMethod: method }))}
                      className={`py-2.5 px-3 rounded-xl text-sm font-medium capitalize transition-all ${
                        checkinData.paymentMethod === method
                          ? 'bg-blue-500 text-white'
                          : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {method}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Total */}
            <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-blue-50'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  {hasGuestBilling ? 'Estimated Stay Charge' : 'Total Amount'}
                </span>
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  ${checkinData.totalAmount.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('none')}
                className={`flex-1 py-3 rounded-xl font-medium ${
                  isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleCheckin}
                disabled={!checkinData.roomId || !checkinData.guestInfo.name}
                className="flex-1 py-3 rounded-xl font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Complete Check-in
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reservation Modal */}
      {modalType === 'reservation' && (
        <Modal title="New Reservation" onClose={() => setModalType('none')} isDark={isDark} size="lg">
          <div className="space-y-4">
            {/* Room Selection */}
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Select Room
              </label>
              <select
                value={reservationData.roomId}
                onChange={(e) => setReservationData(prev => ({ ...prev, roomId: e.target.value }))}
                className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                  isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                } border focus:ring-2 focus:ring-blue-500`}
              >
                <option value="">Choose a room...</option>
                {availableRooms.map(room => (
                  <option key={room.id} value={room.id}>
                    Room {room.roomNumber} - {room.roomType} (${room.ratePerNight}/night)
                  </option>
                ))}
              </select>
            </div>

            {/* Guest Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InputField
                icon={<User className="w-4 h-4" />}
                label="Guest Name"
                value={reservationData.guestInfo.name}
                onChange={(v) => setReservationData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, name: v } }))}
                isDark={isDark}
                required
              />
              <InputField
                icon={<Phone className="w-4 h-4" />}
                label="Phone"
                value={reservationData.guestInfo.phone}
                onChange={(v) => setReservationData(prev => ({ ...prev, guestInfo: { ...prev.guestInfo, phone: v } }))}
                isDark={isDark}
              />
            </div>

            {/* Dates */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Check-in Date
                </label>
                <input
                  type="date"
                  value={reservationData.checkInDate}
                  onChange={(e) => {
                    setReservationDatesFollowClock(false);
                    setReservationData(prev => ({ ...prev, checkInDate: e.target.value }));
                  }}
                  className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                  } border focus:ring-2 focus:ring-blue-500`}
                />
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Check-out Date
                </label>
                <input
                  type="date"
                  value={reservationData.checkOutDate}
                  onChange={(e) => {
                    setReservationDatesFollowClock(false);
                    setReservationData(prev => ({ ...prev, checkOutDate: e.target.value }));
                  }}
                  className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                    isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                  } border focus:ring-2 focus:ring-blue-500`}
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                Notes
              </label>
              <textarea
                value={reservationData.notes}
                onChange={(e) => setReservationData(prev => ({ ...prev, notes: e.target.value }))}
                rows={3}
                className={`w-full px-3 py-2.5 rounded-xl text-sm ${
                  isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200 text-gray-900'
                } border focus:ring-2 focus:ring-blue-500 resize-none`}
                placeholder="Special requests, notes..."
              />
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setModalType('none')}
                className={`flex-1 py-3 rounded-xl font-medium ${
                  isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleReservation}
                disabled={!reservationData.roomId || !reservationData.guestInfo.name}
                className="flex-1 py-3 rounded-xl font-medium bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Reservation
              </button>
            </div>
          </div>
        </Modal>
      )}
    </motion.div>
  );
});

RoomsView.displayName = 'RoomsView';
export default RoomsView;


// Helper Components
const StatCard: React.FC<{ label: string; value: string | number; color?: string; isDark: boolean; className?: string }> = 
  ({ label, value, color, isDark, className }) => (
  <motion.div variants={pageMotionItem} className={`px-3 py-2 sm:px-4 sm:py-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'} ${className || ''}`}>
    <div className={`text-xs sm:text-sm ${color || (isDark ? 'text-gray-400' : 'text-gray-500')}`}>{label}</div>
    <div className={`text-lg sm:text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{value}</div>
  </motion.div>
);

const RoomCard: React.FC<{ room: Room; isDark: boolean; onClick: () => void }> = ({ room, isDark, onClick }) => {
  const effectiveStatus = getRoomEffectiveStatus(room);
  const config = statusConfig[effectiveStatus];
  const Icon = config.icon;
  const guestName = getRoomGuestName(room);
  
  return (
    <motion.button
      variants={pageMotionItem}
      onClick={onClick}
      className={`p-3 sm:p-4 rounded-xl border-2 text-left transition-all hover:scale-[1.02] active:scale-[0.98] ${config.bgClass}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={`font-bold text-sm sm:text-base ${isDark ? 'text-white' : 'text-gray-900'}`}>{room.roomNumber}</span>
        <Icon className={`w-4 h-4 ${config.color}`} />
      </div>
      <div className={`text-xs capitalize ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{room.roomType}</div>
      {effectiveStatus !== room.status && (
        <div className={`text-xs mt-1 font-medium ${config.color}`}>
          {statusConfig[effectiveStatus].label}
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
}> = ({ statusFilter, setStatusFilter, isDark, getStatusLabel }) => (
  <div className="flex flex-wrap gap-1.5">
    {(['all', ...Object.keys(statusConfig)] as const).map(f => (
      <button
        key={f}
        onClick={() => setStatusFilter(f as RoomStatus | 'all')}
        className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
          statusFilter === f 
            ? 'bg-blue-500 text-white' 
            : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
      >
        {f === 'all' ? 'All' : getStatusLabel(f as RoomStatus)}
      </button>
    ))}
  </div>
);

const FloorSelect: React.FC<{
  floorFilter: number | 'all';
  setFloorFilter: (f: number | 'all') => void;
  floors: number[];
  isDark: boolean;
}> = ({ floorFilter, setFloorFilter, floors, isDark }) => (
  <select
    value={floorFilter}
    onChange={(e) => setFloorFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value))}
    className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm ${
      isDark ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-gray-900 border-gray-200'
    } border`}
  >
    <option value="all">All Floors</option>
    {floors.map(floor => (
      <option key={floor} value={floor}>Floor {floor}</option>
    ))}
  </select>
);


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
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${sizeClasses[size]} max-h-[90vh] overflow-y-auto rounded-2xl ${
        isDark ? 'bg-gray-800' : 'bg-white'
      } shadow-2xl`}>
        <div className={`sticky top-0 flex items-center justify-between p-4 border-b ${
          isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-100 bg-white'
        }`}>
          <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{title}</h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
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
    blue: 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-500 hover:bg-purple-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20',
  };
  
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-medium transition-all ${colorClasses[color]} ${className || ''}`}
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
        } border focus:ring-2 focus:ring-blue-500`}
      />
    </div>
  </div>
);
