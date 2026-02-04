/**
 * RoomsView - POS Room Status Grid (Redesigned)
 * 
 * Real-time room status management for hotel POS.
 * Features: Check-in, Reservations, Payment processing, Mobile responsive
 */

import React, { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useTheme } from '../../../contexts/theme-context';
import { useModules } from '../../../contexts/module-context';
import { useRooms } from '../../../hooks/useRooms';
import { formatDate } from '../../../utils/format';
import { reservationsService } from '../../../services/ReservationsService';
import { 
  Bed, RefreshCw, Users, Wrench, Sparkles, Calendar, X, 
  CreditCard, Receipt, Clock, User, Phone, Mail, DollarSign,
  ChevronDown, Filter, Search
} from 'lucide-react';
import type { Room, RoomStatus, RoomFilters } from '../../../services/RoomsService';
import { FloatingActionButton } from '../../../components/ui/FloatingActionButton';

const statusConfig: Record<RoomStatus, { color: string; bgClass: string; icon: typeof Bed; label: string }> = {
  available: { color: 'text-emerald-500', bgClass: 'bg-emerald-500/10 border-emerald-500/30', icon: Sparkles, label: 'Available' },
  occupied: { color: 'text-blue-500', bgClass: 'bg-blue-500/10 border-blue-500/30', icon: Users, label: 'Occupied' },
  cleaning: { color: 'text-amber-500', bgClass: 'bg-amber-500/10 border-amber-500/30', icon: Sparkles, label: 'Cleaning' },
  maintenance: { color: 'text-red-500', bgClass: 'bg-red-500/10 border-red-500/30', icon: Wrench, label: 'Maintenance' },
  reserved: { color: 'text-purple-500', bgClass: 'bg-purple-500/10 border-purple-500/30', icon: Calendar, label: 'Reserved' },
};

type ModalType = 'none' | 'checkin' | 'reservation' | 'checkout' | 'action';

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

export const RoomsView: React.FC = memo(() => {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { organizationId } = useModules();
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
    checkInDate: new Date().toISOString().split('T')[0],
    checkOutDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    notes: '',
  });

  // Load config from multiple sources
  useEffect(() => {
    const loadConfig = async () => {
      let bid = localStorage.getItem('branch_id');
      let oid = localStorage.getItem('organization_id');
      
      if ((!bid || !oid) && window.electron?.ipcRenderer) {
        try {
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
          console.warn('[RoomsView] Failed to get terminal config:', err);
        }
      }
      setBranchId(bid);
      setLocalOrgId(oid);
    };
    
    loadConfig();
    
    const handleConfigUpdate = (data: { branch_id?: string; organization_id?: string }) => {
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
    if (room) {
      setReservationData(prev => ({ ...prev, roomId: room.id }));
    }
    setModalType('reservation');
  };

  const handleCheckin = async () => {
    if (!checkinData.roomId || !checkinData.guestInfo.name) return;
    
    // Update room status to occupied
    await updateStatus(checkinData.roomId, 'occupied');
    
    // TODO: Create booking record, generate receipt
    console.log('Check-in completed:', checkinData);
    
    // Reset and close
    setCheckinData({
      guestInfo: { name: '', phone: '', email: '', idNumber: '' },
      roomId: '',
      nights: 1,
      paymentMethod: 'cash',
      totalAmount: 0,
    });
    setModalType('none');
  };

  const handleReservation = async () => {
    if (!reservationData.roomId || !reservationData.guestInfo.name) return;
    
    try {
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
      
      // Update room status to reserved
      await updateStatus(reservationData.roomId, 'reserved');
      
      toast.success('Reservation created successfully');
      
      // Reset and close
      setReservationData({
        guestInfo: { name: '', phone: '', email: '', idNumber: '' },
        roomId: '',
        checkInDate: new Date().toISOString().split('T')[0],
        checkOutDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        notes: '',
      });
      setModalType('none');
    } catch (error) {
      console.error('Failed to create reservation:', error);
      toast.error('Failed to create reservation');
    }
  };

  const handleCheckout = async () => {
    if (!actionRoom) return;
    await updateStatus(actionRoom.id, 'cleaning');
    // TODO: Generate final bill, process payment
    setModalType('none');
    setActionRoom(null);
  };

  const getStatusLabel = (status: RoomStatus) => {
    return t(`roomsView.status.${status}`, { defaultValue: statusConfig[status].label });
  };

  const availableRooms = rooms.filter(r => r.status === 'available');

  // Calculate total for check-in
  const updateCheckinTotal = useCallback((nights: number, roomId: string) => {
    const room = rooms.find(r => r.id === roomId);
    const rate = room?.ratePerNight || 0;
    setCheckinData(prev => ({ ...prev, nights, totalAmount: rate * nights }));
  }, [rooms]);

  if (!branchId || !effectiveOrgId) {
    return (
      <div className={`h-full flex flex-col items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <Bed className="w-16 h-16 mb-4 opacity-30" />
        <p className="text-lg">{t('roomsView.noBranch', { defaultValue: 'Please select a branch to view rooms' })}</p>
        <p className="text-xs mt-2 opacity-60">
          {!branchId ? 'Missing: branch_id' : ''} {!effectiveOrgId ? 'Missing: organization_id' : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-3 sm:p-4 overflow-hidden">
      {/* Stats Bar - Responsive */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 sm:gap-3 mb-3 sm:mb-4">
        <StatCard label="Total" value={stats.totalRooms} isDark={isDark} />
        <StatCard label="Available" value={stats.availableRooms} color="text-emerald-500" isDark={isDark} />
        <StatCard label="Occupied" value={stats.occupiedRooms} color="text-blue-500" isDark={isDark} />
        <StatCard label="Cleaning" value={stats.cleaningRooms} color="text-amber-500" isDark={isDark} className="hidden sm:block" />
        <StatCard label="Occupancy" value={`${stats.occupancyRate}%`} isDark={isDark} className="hidden sm:block" />
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mb-3 sm:mb-4">
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
      </div>

      {/* Mobile Filters (Collapsible) */}
      {showFilters && (
        <div className={`sm:hidden flex flex-wrap gap-2 mb-3 p-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
          <StatusFilterButtons statusFilter={statusFilter} setStatusFilter={setStatusFilter} isDark={isDark} getStatusLabel={getStatusLabel} />
          {floors.length > 1 && (
            <FloorSelect floorFilter={floorFilter} setFloorFilter={setFloorFilter} floors={floors} isDark={isDark} />
          )}
        </div>
      )}

      {/* Loading State */}
      {isLoading && rooms.length === 0 && (
        <div className={`flex-1 flex items-center justify-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <RefreshCw className="w-6 h-6 animate-spin mr-2" />
          Loading rooms...
        </div>
      )}

      {/* Rooms Grid */}
      {!isLoading && (
        <div className="flex-1 overflow-y-auto space-y-4 pb-20">
          {floors.map(floor => {
            const floorRooms = rooms.filter(r => r.floor === floor);
            if (floorRooms.length === 0) return null;
            
            return (
              <div key={floor}>
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  Floor {floor}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                  {floorRooms.map(room => (
                    <RoomCard key={room.id} room={room} isDark={isDark} onClick={() => handleRoomClick(room)} />
                  ))}
                </div>
              </div>
            );
          })}

          {rooms.length === 0 && !isLoading && (
            <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <Bed className="w-16 h-16 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium mb-2">No rooms found</p>
              <p className="text-sm">Try adjusting your filters</p>
            </div>
          )}
        </div>
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
                <span className={`font-medium ${statusConfig[actionRoom.status].color}`}>
                  {getStatusLabel(actionRoom.status)}
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
              {actionRoom.currentGuestName && (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-600">
                  <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Guest</span>
                  <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{actionRoom.currentGuestName}</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-2">
              {actionRoom.status === 'available' && (
                <>
                  <ActionButton icon={<Users className="w-5 h-5" />} label="Check-in" color="blue" onClick={() => openCheckinModal(actionRoom)} />
                  <ActionButton icon={<Calendar className="w-5 h-5" />} label="Reserve" color="purple" onClick={() => openReservationModal(actionRoom)} />
                </>
              )}
              {actionRoom.status === 'occupied' && (
                <>
                  <ActionButton icon={<Receipt className="w-5 h-5" />} label="Checkout" color="emerald" onClick={handleCheckout} />
                  <ActionButton icon={<DollarSign className="w-5 h-5" />} label="Add Charge" color="amber" onClick={() => console.log('Add charge')} />
                </>
              )}
              {actionRoom.status === 'reserved' && (
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

            {/* Payment Method */}
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

            {/* Total */}
            <div className={`p-4 rounded-xl ${isDark ? 'bg-gray-700' : 'bg-blue-50'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>Total Amount</span>
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
                  onChange={(e) => setReservationData(prev => ({ ...prev, checkInDate: e.target.value }))}
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
                  onChange={(e) => setReservationData(prev => ({ ...prev, checkOutDate: e.target.value }))}
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
    </div>
  );
});

RoomsView.displayName = 'RoomsView';
export default RoomsView;


// Helper Components
const StatCard: React.FC<{ label: string; value: string | number; color?: string; isDark: boolean; className?: string }> = 
  ({ label, value, color, isDark, className }) => (
  <div className={`px-3 py-2 sm:px-4 sm:py-3 rounded-xl ${isDark ? 'bg-gray-800' : 'bg-white shadow-sm'} ${className || ''}`}>
    <div className={`text-xs sm:text-sm ${color || (isDark ? 'text-gray-400' : 'text-gray-500')}`}>{label}</div>
    <div className={`text-lg sm:text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{value}</div>
  </div>
);

const RoomCard: React.FC<{ room: Room; isDark: boolean; onClick: () => void }> = ({ room, isDark, onClick }) => {
  const config = statusConfig[room.status];
  const Icon = config.icon;
  
  return (
    <button
      onClick={onClick}
      className={`p-3 sm:p-4 rounded-xl border-2 text-left transition-all hover:scale-[1.02] active:scale-[0.98] ${config.bgClass}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className={`font-bold text-sm sm:text-base ${isDark ? 'text-white' : 'text-gray-900'}`}>{room.roomNumber}</span>
        <Icon className={`w-4 h-4 ${config.color}`} />
      </div>
      <div className={`text-xs capitalize ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{room.roomType}</div>
      {room.currentGuestName && (
        <div className={`text-xs truncate mt-1 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <Users className="w-3 h-3 inline mr-1" />
          {room.currentGuestName}
        </div>
      )}
      {room.checkoutDate && room.status === 'occupied' && (
        <div className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <Clock className="w-3 h-3 inline mr-1" />
          {formatDate(room.checkoutDate)}
        </div>
      )}
    </button>
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
