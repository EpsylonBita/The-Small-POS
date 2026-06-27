/**
 * RoomStayWorkflowModals — focused New Order -> Room check-in / reservation modules (Round 238).
 *
 * The New Order -> Room flow used to drop staff into the full `RoomsView` (stats + search + floor
 * hub + grid) embedded inside a modal. That was rejected: the order-taking flow must stay focused.
 *
 * These are purpose-built, self-contained modules — NOT `RoomsView` and NOT its `hubPreset` path:
 *   - `RoomStaySelectorModal`: a compact glass picker of just the eligible rooms (reserved for
 *     check-in, available for reservation), with a clear empty state and no hub chrome.
 *   - `RoomCheckinModal` / `RoomReservationModal`: the check-in / reservation form for the chosen
 *     room. They reuse the existing `roomsView.*` field/toast i18n keys and call the same backend
 *     services as the Rooms-tab forms, so behaviour stays at parity with `RoomsView` (the sibling
 *     implementation that still owns the standalone Rooms page).
 *
 * Glass blur, portal, Escape and focus-trap come from `LiquidGlassModal`. Controls are touch-first
 * (active:scale, generous hit targets) with no hover-only affordances.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { BedDouble, CalendarPlus, UserCheck, User, Phone, Mail, CreditCard } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { formatCurrency } from '../../utils/format';
import { toLocalDateString, addLocalDays } from '../../utils/date';
import { posApiFetch } from '../../utils/api-helpers';
import { offlineRoomCheckin } from '../../services/offline-mutations';
import { reservationsService } from '../../services/ReservationsService';
import { useModules } from '../../contexts/module-context';
import { getRoomEffectiveStatus, type Room, type RoomStatus } from '../../services/RoomsService';
import { OrderService } from '../../../services/OrderService';
import { getBridge } from '../../../lib';

type RoomStayVariant = 'checkin' | 'reservation';

type RoomTranslate = (key: string, options?: Record<string, unknown>) => unknown;

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

const mapPaymentMethod = (method: 'cash' | 'card' | 'transfer'): 'cash' | 'card' | 'digital' => {
  if (method === 'cash') return 'cash';
  if (method === 'card') return 'card';
  return 'digital';
};

// Localize known room-type slugs (standard/deluxe/suite/...), preserving genuinely custom names.
const translateRoomType = (t: RoomTranslate, roomType?: string | null): string => {
  const raw = (roomType ?? '').trim();
  if (!raw) return raw;
  const localized = t(`roomsView.roomTypes.${raw.toLowerCase()}`, { defaultValue: '' });
  return typeof localized === 'string' && localized ? localized : raw;
};

const roomGuestName = (room: Room): string | null =>
  room.activeFolio?.guestName || room.currentGuestName || null;

// Unique, ascending floor numbers present in a candidate room set (mirrors RoomsService.getFloors).
export const deriveRoomFloors = (rooms: Room[]): number[] =>
  Array.from(
    new Set(
      rooms
        .map((room) => room.floor)
        .filter((floor): floor is number => typeof floor === 'number'),
    ),
  ).sort((a, b) => a - b);

interface RoomCheckinApiResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Floor chips — compact, touch-first segmented control shared by every room picker.
// Hidden when there is nothing meaningful to filter (0-1 floors). Horizontal scroll is
// scrollbar-hidden so the chip row never shows a native rail.
// ---------------------------------------------------------------------------------------------

interface RoomFloorChipsProps {
  floors: number[];
  value: number | 'all';
  onChange: (next: number | 'all') => void;
}

export const RoomFloorChips: React.FC<RoomFloorChipsProps> = ({ floors, value, onChange }) => {
  const { t } = useTranslation();
  if (floors.length < 2) return null;

  const chipClass = (active: boolean): string =>
    `shrink-0 rounded-full px-3.5 py-2 text-sm font-medium transition-transform duration-150 active:scale-95 ${
      active ? 'bg-yellow-400 text-black' : 'bg-white/10 text-white/70'
    }`;

  return (
    <div className="mb-3 flex gap-1.5 overflow-x-auto scrollbar-hide pb-1" role="group">
      <button type="button" onClick={() => onChange('all')} className={chipClass(value === 'all')}>
        {t('roomsView.allFloors', { defaultValue: 'All Floors' })}
      </button>
      {floors.map((floor) => (
        <button
          key={floor}
          type="button"
          onClick={() => onChange(floor)}
          className={chipClass(value === floor)}
        >
          {t('roomsView.floor', { floor, defaultValue: 'Floor {{floor}}' })}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Selector — compact glass picker of the eligible rooms (reserved | available)
// ---------------------------------------------------------------------------------------------

interface RoomStaySelectorModalProps {
  isOpen: boolean;
  variant: RoomStayVariant;
  rooms: Room[];
  onClose: () => void;
  onSelectRoom: (room: Room) => void;
}

export const RoomStaySelectorModal: React.FC<RoomStaySelectorModalProps> = ({
  isOpen,
  variant,
  rooms,
  onClose,
  onSelectRoom,
}) => {
  const { t } = useTranslation();
  const isCheckin = variant === 'checkin';

  const title = isCheckin
    ? t('orderFlow.roomCheckinSelectTitle', { defaultValue: 'Select a reserved room' })
    : t('orderFlow.roomReservationSelectTitle', { defaultValue: 'Select an available room' });
  const emptyMessage = isCheckin
    ? t('orderFlow.roomCheckinEmpty', { defaultValue: 'No reserved rooms to check in' })
    : t('orderFlow.roomReservationEmpty', { defaultValue: 'No available rooms to reserve' });
  // Check-in dead-ends without a reservation, so the empty state explains the prerequisite in plain
  // cashier language and points to the next step (create a reservation first, then return to check in).
  // Mirrors the room-order empty hint; reservation variant keeps its single-line empty state.
  const emptyHelper = isCheckin
    ? t('orderFlow.roomCheckinEmptyHint', {
        defaultValue:
          'Check-in needs an existing room reservation. If no rooms appear here, create a reservation first, then come back to check the guest in.',
      })
    : null;
  const accentClass = isCheckin
    ? 'border-green-400/30 bg-gradient-to-br from-green-500/10 to-green-600/5'
    : 'border-purple-400/30 bg-gradient-to-br from-purple-500/10 to-purple-600/5';
  const EmptyIcon = isCheckin ? UserCheck : CalendarPlus;

  // Floor filter narrows the displayed room cards. Reset to "all" each time the picker reopens
  // so a stale floor from a previous visit can't hide every room.
  const floors = useMemo(() => deriveRoomFloors(rooms), [rooms]);
  const [floorFilter, setFloorFilter] = useState<number | 'all'>('all');
  useEffect(() => {
    if (isOpen) setFloorFilter('all');
  }, [isOpen]);
  const visibleRooms = useMemo(
    () => (floorFilter === 'all' ? rooms : rooms.filter((room) => room.floor === floorFilter)),
    [rooms, floorFilter],
  );

  return (
    <LiquidGlassModal isOpen={isOpen} onClose={onClose} title={title} className="!max-w-3xl">
      <div className="p-2">
        {rooms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <EmptyIcon className="h-12 w-12 text-white/30" strokeWidth={1.5} />
            <p className="text-sm text-white/60">{emptyMessage}</p>
            {emptyHelper && (
              <p className="max-w-sm text-xs leading-relaxed text-white/45">{emptyHelper}</p>
            )}
          </div>
        ) : (
          <>
            <RoomFloorChips floors={floors} value={floorFilter} onChange={setFloorFilter} />
            {visibleRooms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <EmptyIcon className="h-12 w-12 text-white/30" strokeWidth={1.5} />
                <p className="text-sm text-white/60">{t('roomsView.noRooms', { defaultValue: 'No rooms found' })}</p>
              </div>
            ) : (
              <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto scrollbar-hide pb-2 sm:grid-cols-2 lg:grid-cols-3">
                {visibleRooms.map((room) => {
                  const guest = roomGuestName(room);
                  const typeLabel = translateRoomType(t, room.roomType);
                  return (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => onSelectRoom(room)}
                      aria-label={t('orderFlow.roomOrderSelectRoom', {
                        room: room.roomNumber,
                        defaultValue: 'Room {{room}}',
                      })}
                      className={`flex flex-col gap-1 rounded-2xl border-2 px-4 py-3 text-left transition-transform duration-150 active:scale-95 ${accentClass}`}
                    >
                      <span className="text-base font-bold text-white">
                        {t('orderFlow.roomOrderSelectRoom', {
                          room: room.roomNumber,
                          defaultValue: 'Room {{room}}',
                        })}
                      </span>
                      {typeLabel && <span className="text-xs capitalize text-white/60">{typeLabel}</span>}
                      {isCheckin
                        ? guest && <span className="text-sm text-white/70">{guest}</span>
                        : room.ratePerNight != null && (
                            <span className="text-xs font-semibold text-purple-200">
                              {formatCurrency(room.ratePerNight || 0)}
                            </span>
                          )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </LiquidGlassModal>
  );
};

// ---------------------------------------------------------------------------------------------
// Shared glass field primitives (light-on-glass, touch-first, no hover)
// ---------------------------------------------------------------------------------------------

const fieldClass =
  'w-full rounded-xl border border-white/15 bg-white/10 px-3 py-3 text-base text-white placeholder-white/40 focus:border-white/40 focus:outline-none';

const GlassInput: React.FC<{
  icon?: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}> = ({ icon, label, value, onChange, type = 'text', required }) => (
  <div>
    <label className="mb-1.5 block text-sm font-medium text-white/70">
      {label} {required && <span className="text-red-400">*</span>}
    </label>
    <div className="relative">
      {icon && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40">{icon}</span>
      )}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={icon ? `${fieldClass} pl-9` : fieldClass}
      />
    </div>
  </div>
);

const RoomChip: React.FC<{ room: Room; subtitle?: string | null }> = ({ room, subtitle }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
      <BedDouble className="h-6 w-6 shrink-0 text-white/70" strokeWidth={1.6} />
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-white">
          {t('orderFlow.roomOrderSelectRoom', { room: room.roomNumber, defaultValue: 'Room {{room}}' })}
        </p>
        {subtitle && <p className="truncate text-xs text-white/60">{subtitle}</p>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Check-in form — for a pre-selected reserved room
// ---------------------------------------------------------------------------------------------

interface RoomStayFormBaseProps {
  room: Room;
  branchId: string;
  organizationId: string;
  /** From the dashboard's useRooms instance, so room status + lists stay in sync. */
  updateRoomStatus: (roomId: string, status: RoomStatus) => Promise<Room | null>;
  refetchRooms: () => Promise<void> | void;
  onClose: () => void;
  onCompleted: () => void;
}

export const RoomCheckinModal: React.FC<RoomStayFormBaseProps> = ({
  room,
  branchId,
  organizationId,
  updateRoomStatus,
  refetchRooms,
  onClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const { isModuleEnabled } = useModules();
  const hasGuestBilling = isModuleEnabled('guest_billing' as any);
  const hasOrders = isModuleEnabled('orders' as any);
  const hasReservations = isModuleEnabled('reservations' as any);

  const [name, setName] = useState(() => roomGuestName(room) || '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [nights, setNights] = useState(1);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer'>('cash');
  const [submitting, setSubmitting] = useState(false);

  const totalAmount = useMemo(
    () => (room.ratePerNight || 0) * Math.max(1, nights),
    [room.ratePerNight, nights],
  );

  const createFallbackReceiptOrder = async () => {
    if (totalAmount <= 0) return;
    const orderService = OrderService.getInstance();
    const description = `Room ${room.roomNumber} check-in (${nights} night${nights > 1 ? 's' : ''})`;
    const order = await orderService.createOrder({
      customer_name: name,
      customer_phone: phone || undefined,
      items: [
        {
          id: `hotel-${room.id}-${Date.now()}`,
          name: description,
          quantity: 1,
          price: totalAmount,
          notes: idNumber ? `Guest ID: ${idNumber}` : undefined,
        } as any,
      ],
      total_amount: totalAmount,
      subtotal: totalAmount,
      status: 'completed',
      order_type: 'pickup',
      payment_status: 'completed',
      payment_method: mapPaymentMethod(paymentMethod),
      notes: idNumber ? `Guest ID: ${idNumber}` : description,
    } as any);
    if (order?.id) {
      await getBridge().payments.printReceipt(order.id, 'customer');
    }
  };

  const handleCheckin = async () => {
    if (!name.trim() || submitting) return;
    if (!branchId || !organizationId) {
      toast.error(
        t('roomsView.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }),
      );
      return;
    }

    setSubmitting(true);
    try {
      const now = new Date();
      const checkInDate = toLocalDateString(now);
      const checkOutDate = toLocalDateString(addLocalDays(now, Math.max(1, nights)));
      const reservationTime = now.toTimeString().slice(0, 5);
      // Resolve connectivity at submit time so a mid-session change is honoured.
      const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

      if (hasGuestBilling) {
        const request = {
          guestName: name,
          guestPhone: phone || null,
          guestEmail: email || null,
          checkInDate,
          checkOutDate,
          partySize: room.capacity || 1,
          notes: idNumber ? `Guest ID: ${idNumber}` : null,
          clientRequestId: generateClientRequestId(),
        };

        if (isOnline) {
          const response = await posApiFetch<RoomCheckinApiResponse>(
            `/pos/rooms/${encodeURIComponent(room.id)}/checkin`,
            { method: 'POST', body: JSON.stringify(request) },
          );
          if (!response.success || response.data?.success === false) {
            throw new Error(response.error || response.data?.error || 'Failed to check in room');
          }
        } else {
          await offlineRoomCheckin({ roomId: room.id, organizationId, branchId, ...request });
          toast.success(t('roomsView.toasts.checkinQueued', { defaultValue: 'Check-in queued for sync' }));
        }
      } else {
        let reservationCreated = false;
        if (hasReservations) {
          reservationsService.setContext(branchId, organizationId);
          const reservation = await reservationsService.createReservation({
            customerName: name,
            customerPhone: phone || '',
            customerEmail: email || undefined,
            partySize: room.capacity || 1,
            reservationDate: checkInDate,
            reservationTime,
            roomId: room.id,
            roomNumber: room.roomNumber,
            checkInDate,
            checkOutDate,
            notes: idNumber ? `ID: ${idNumber}` : undefined,
          });
          await reservationsService.updateStatus(reservation.id, 'seated');
          reservationCreated = true;
        }

        const occupied = await updateRoomStatus(room.id, 'occupied');
        if (!occupied) {
          throw new Error('Failed to update room status to occupied');
        }

        if (hasOrders) {
          try {
            await createFallbackReceiptOrder();
          } catch (billingError) {
            console.error('Fallback check-in receipt failed:', billingError);
            toast.error(
              t('roomsView.toasts.checkinReceiptFailed', {
                defaultValue: 'Check-in completed, but receipt failed',
              }),
            );
          }
        } else if (!reservationCreated) {
          toast.success(
            t('roomsView.toasts.checkinNoReceipt', {
              defaultValue: 'Room checked in without a reservation or receipt',
            }),
          );
        }
      }

      await refetchRooms();
      toast.success(t('roomsView.toasts.checkinSuccess', { defaultValue: 'Check-in completed successfully' }));
      onCompleted();
    } catch (error) {
      console.error('Failed to complete check-in:', error);
      toast.error(
        error instanceof Error
          ? error.message
          : t('roomsView.toasts.checkinFailed', { defaultValue: 'Failed to complete check-in' }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen
      onClose={onClose}
      title={t('roomsView.newCheckin', { defaultValue: 'New Check-in' })}
      className="!max-w-lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
    >
      <div className="space-y-4 p-1">
        <RoomChip room={room} subtitle={translateRoomType(t, room.roomType)} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GlassInput
            icon={<User className="h-4 w-4" />}
            label={t('roomsView.guestName', { defaultValue: 'Guest Name' })}
            value={name}
            onChange={setName}
            required
          />
          <GlassInput
            icon={<Phone className="h-4 w-4" />}
            label={t('roomsView.phone', { defaultValue: 'Phone' })}
            value={phone}
            onChange={setPhone}
          />
          <GlassInput
            icon={<Mail className="h-4 w-4" />}
            label={t('roomsView.email', { defaultValue: 'Email' })}
            type="email"
            value={email}
            onChange={setEmail}
          />
          <GlassInput
            icon={<CreditCard className="h-4 w-4" />}
            label={t('roomsView.idNumber', { defaultValue: 'ID Number' })}
            value={idNumber}
            onChange={setIdNumber}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-white/70">
            {t('roomsView.numberOfNights', { defaultValue: 'Number of Nights' })}
          </label>
          <input
            type="number"
            min={1}
            value={nights}
            onChange={(e) => setNights(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className={fieldClass}
          />
        </div>

        {!hasGuestBilling && hasOrders && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/70">
              {t('roomsView.paymentMethod', { defaultValue: 'Payment Method' })}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['cash', 'card', 'transfer'] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setPaymentMethod(method)}
                  className={`rounded-xl px-3 py-3 text-sm font-medium capitalize transition-transform duration-150 active:scale-95 ${
                    paymentMethod === method
                      ? 'bg-yellow-400 text-black'
                      : 'bg-white/10 text-white/70'
                  }`}
                >
                  {t(`roomsView.paymentMethods.${method}`, { defaultValue: method })}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-2xl bg-white/[0.06] p-4">
          <span className="text-sm text-white/70">
            {hasGuestBilling
              ? t('roomsView.estimatedStayCharge', { defaultValue: 'Estimated Stay Charge' })
              : t('roomsView.totalAmount', { defaultValue: 'Total Amount' })}
          </span>
          <span className="text-2xl font-bold text-white">{formatCurrency(totalAmount)}</span>
        </div>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-xl border border-red-400/40 bg-red-500/15 py-3 font-medium text-red-300 transition-transform duration-150 active:scale-95 active:bg-red-500/25 disabled:opacity-50"
          >
            {t('common.actions.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleCheckin}
            disabled={!name.trim() || submitting}
            className="flex-1 rounded-xl border border-emerald-500 bg-emerald-600 py-3 font-medium text-white transition-transform duration-150 active:scale-95 disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {t('roomsView.completeCheckin', { defaultValue: 'Complete Check-in' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};

// ---------------------------------------------------------------------------------------------
// Reservation form — for a pre-selected available room
// ---------------------------------------------------------------------------------------------

export const RoomReservationModal: React.FC<RoomStayFormBaseProps> = ({
  room,
  branchId,
  organizationId,
  updateRoomStatus,
  refetchRooms,
  onClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const { isModuleEnabled } = useModules();
  const hasReservations = isModuleEnabled('reservations' as any);

  const defaults = useMemo(() => {
    const base = new Date();
    return {
      checkInDate: toLocalDateString(base),
      checkOutDate: toLocalDateString(addLocalDays(base, 1)),
    };
  }, []);

  const [name, setName] = useState(() => roomGuestName(room) || '');
  const [phone, setPhone] = useState('');
  const [checkInDate, setCheckInDate] = useState(defaults.checkInDate);
  const [checkOutDate, setCheckOutDate] = useState(defaults.checkOutDate);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleReservation = async () => {
    if (!name.trim() || submitting) return;
    if (!hasReservations) {
      toast.error(
        t('roomsView.toasts.reservationsModuleRequired', {
          defaultValue: 'Reservations module is required to create room reservations',
        }),
      );
      return;
    }

    setSubmitting(true);
    try {
      reservationsService.setContext(branchId || '', organizationId || '');
      await reservationsService.createReservation({
        customerName: name,
        customerPhone: phone || '',
        partySize: room.capacity || 2,
        reservationDate: checkInDate,
        reservationTime: '14:00',
        roomId: room.id,
        roomNumber: room.roomNumber,
        checkInDate,
        checkOutDate,
        notes: notes || undefined,
      });

      if (checkInDate === toLocalDateString()) {
        await updateRoomStatus(room.id, 'reserved');
      }

      await refetchRooms();
      toast.success(t('roomsView.toasts.reservationCreated', { defaultValue: 'Reservation created successfully' }));
      onCompleted();
    } catch (error) {
      console.error('Failed to create reservation:', error);
      toast.error(t('roomsView.toasts.reservationFailed', { defaultValue: 'Failed to create reservation' }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen
      onClose={onClose}
      title={t('roomsView.newReservation', { defaultValue: 'New Reservation' })}
      className="!max-w-lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
    >
      <div className="space-y-4 p-1">
        <RoomChip room={room} subtitle={translateRoomType(t, room.roomType)} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GlassInput
            icon={<User className="h-4 w-4" />}
            label={t('roomsView.guestName', { defaultValue: 'Guest Name' })}
            value={name}
            onChange={setName}
            required
          />
          <GlassInput
            icon={<Phone className="h-4 w-4" />}
            label={t('roomsView.phone', { defaultValue: 'Phone' })}
            value={phone}
            onChange={setPhone}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/70">
              {t('roomsView.checkInDate', { defaultValue: 'Check-in Date' })}
            </label>
            <input
              type="date"
              value={checkInDate}
              onChange={(e) => setCheckInDate(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/70">
              {t('roomsView.checkOutDate', { defaultValue: 'Check-out Date' })}
            </label>
            <input
              type="date"
              value={checkOutDate}
              onChange={(e) => setCheckOutDate(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-white/70">
            {t('roomsView.notes', { defaultValue: 'Notes' })}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className={`${fieldClass} resize-none`}
            placeholder={t('roomsView.notesPlaceholder', { defaultValue: 'Special requests, notes...' })}
          />
        </div>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-xl border border-red-400/40 bg-red-500/15 py-3 font-medium text-red-300 transition-transform duration-150 active:scale-95 active:bg-red-500/25 disabled:opacity-50"
          >
            {t('common.actions.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            onClick={handleReservation}
            disabled={!name.trim() || submitting}
            className="flex-1 rounded-xl border border-emerald-500 bg-emerald-600 py-3 font-medium text-white transition-transform duration-150 active:scale-95 disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {t('roomsView.createReservation', { defaultValue: 'Create Reservation' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
