/**
 * RoomStayWorkflowModals — focused New Order -> Room check-in / reservation modules (Round 238).
 *
 * The New Order -> Room flow used to drop staff into the full `RoomsView` (stats + search + floor
 * hub + grid) embedded inside a modal. That was rejected: the order-taking flow must stay focused.
 *
 * These are purpose-built, self-contained modules — NOT `RoomsView` and NOT its `hubPreset` path:
 *   - `RoomStaySelectorModal`: a compact glass picker of just the eligible rooms (reserved for
 *     check-in, available for reservation), with a clear empty state and no hub chrome.
 *   - `RoomCheckinModal` / `RoomReservationModal`: shared check-in / reservation forms for
 *     the chosen room, used by the Rooms page, Reservations and the order dashboard.
 *
 * Glass blur, portal, Escape and focus-trap come from `LiquidGlassModal`. Controls are touch-first
 * (active:scale, generous hit targets) with no hover-only affordances.
 */

import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { BedDouble, CalendarPlus, UserCheck, User, Phone, Mail, CreditCard } from 'lucide-react';
import { LiquidGlassModal } from '../ui/pos-glass-components';
import { formatCurrency } from '../../utils/format';
import { toLocalDateString, addLocalDays } from '../../utils/date';
import { posApiFetch } from '../../utils/api-helpers';
import { offlineRoomCheckin } from '../../services/offline-mutations';
import { reservationsService, type Reservation } from '../../services/ReservationsService';
import { roomStayNights, roomWorkflowError } from '../../utils/room-workflow';
import { useModules } from '../../contexts/module-context';
import { getRoomEffectiveStatus, type Room, type RoomStatus } from '../../services/RoomsService';

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
      active ? 'bg-yellow-400 text-black' : 'liquid-glass-modal-button liquid-glass-modal-text'
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
            <EmptyIcon className="h-12 w-12 liquid-glass-modal-text-muted opacity-60" strokeWidth={1.5} />
            <p className="liquid-glass-modal-text-muted text-sm">{emptyMessage}</p>
            {emptyHelper && (
              <p className="liquid-glass-modal-text-muted max-w-sm text-xs leading-relaxed">{emptyHelper}</p>
            )}
          </div>
        ) : (
          <>
            <RoomFloorChips floors={floors} value={floorFilter} onChange={setFloorFilter} />
            {visibleRooms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <EmptyIcon className="h-12 w-12 liquid-glass-modal-text-muted opacity-60" strokeWidth={1.5} />
                <p className="liquid-glass-modal-text-muted text-sm">{t('roomsView.noRooms', { defaultValue: 'No rooms found' })}</p>
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
                      <span className="liquid-glass-modal-text text-base font-bold">
                        {t('orderFlow.roomOrderSelectRoom', {
                          room: room.roomNumber,
                          defaultValue: 'Room {{room}}',
                        })}
                      </span>
                      {typeLabel && <span className="liquid-glass-modal-text-muted text-xs capitalize">{typeLabel}</span>}
                      {isCheckin
                        ? guest && <span className="liquid-glass-modal-text-muted text-sm">{guest}</span>
                        : room.ratePerNight != null && (
                            <span className="text-xs font-semibold text-purple-700 dark:text-purple-200">
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
  'liquid-glass-modal-input w-full rounded-xl px-3 py-3 text-base focus:outline-none';

const GlassInput: React.FC<{
  icon?: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  readOnly?: boolean;
}> = ({ icon, label, value, onChange, type = 'text', required, readOnly }) => (
  <div>
    <label className="liquid-glass-modal-text-muted mb-1.5 block text-sm font-medium">
      {label} {required && <span className="text-red-400">*</span>}
    </label>
    <div className="relative">
      {icon && (
        <span className="liquid-glass-modal-text-muted absolute left-3 top-1/2 -translate-y-1/2">{icon}</span>
      )}
      <input
        type={type}
        aria-label={label}
        required={required}
        readOnly={readOnly}
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
    <div className="liquid-glass-modal-inset flex items-center gap-3 rounded-2xl px-4 py-3">
      <BedDouble className="liquid-glass-modal-text-muted h-6 w-6 shrink-0" strokeWidth={1.6} />
      <div className="min-w-0">
        <p className="liquid-glass-modal-text truncate text-base font-bold">
          {t('orderFlow.roomOrderSelectRoom', { room: room.roomNumber, defaultValue: 'Room {{room}}' })}
        </p>
        {subtitle && <p className="liquid-glass-modal-text-muted truncate text-xs">{subtitle}</p>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Check-in form — for a pre-selected reserved room
// ---------------------------------------------------------------------------------------------

interface RoomStayFormBaseProps {
  room: Room;
  reservation?: Reservation;
  rooms?: Room[];
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
  reservation: initialReservation,
  branchId,
  organizationId,
  refetchRooms,
  onClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const { isModuleEnabled } = useModules();
  const hasGuestBilling = isModuleEnabled('guest_billing' as any);
  const hasReservations = isModuleEnabled('reservations' as any);

  const [name, setName] = useState(() => roomGuestName(room) || '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [nights, setNights] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [requestId] = useState(generateClientRequestId);
  const bookingRef = useRef<Reservation | null>(initialReservation || null);
  const [booking, setBooking] = useState<Reservation | null>(initialReservation || null);
  const requiresPhone = hasReservations && !booking;
  const [loadingBooking, setLoadingBooking] = useState(hasReservations);
  const [failure, setFailure] = useState('');
  const hydrateBooking = (value: Reservation | null) => {
    bookingRef.current = value;
    setBooking(value);
    if (value) {
      setName(value.customerName); setPhone(value.customerPhone); setEmail(value.customerEmail || '');
      setNights(roomStayNights(value.checkInDate || '', value.checkOutDate || '') || 1);
    }
  };
  useEffect(() => {
    let disposed = false;
    if (!hasReservations) { setLoadingBooking(false); return; }
    reservationsService.setContext(branchId, organizationId);
    setLoadingBooking(true);
    const load = initialReservation
      ? Promise.resolve(initialReservation)
      : reservationsService.getActiveRoomReservation(room.id, toLocalDateString());
    void load.then((value) => { if (!disposed) hydrateBooking(value); })
      .catch((error) => { if (!disposed) setFailure(roomWorkflowError(error, t)); })
      .finally(() => { if (!disposed) setLoadingBooking(false); });
    return () => { disposed = true; };
  }, [room.id, branchId, organizationId, hasReservations, initialReservation, t]);

  const totalAmount = useMemo(
    () => (room.ratePerNight || 0) * Math.max(1, nights),
    [room.ratePerNight, nights],
  );

  const handleCheckin = async () => {
    if (!name.trim() || submittingRef.current || loadingBooking) return;
    if (requiresPhone && !phone.trim()) { setFailure(t('roomWorkflow.phoneRequired')); return; }
    if (!hasGuestBilling && !hasReservations) { setFailure(t('roomWorkflow.reservationRequired')); return; }
    if (!branchId || !organizationId) {
      toast.error(
        t('roomsView.toasts.missingContext', { defaultValue: 'Missing branch or organization context' }),
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFailure('');
    try {
      const now = new Date();
      const checkInDate = bookingRef.current?.checkInDate || toLocalDateString(now);
      const checkOutDate = bookingRef.current?.checkOutDate || toLocalDateString(addLocalDays(now, Math.max(1, nights)));
      const reservationTime = now.toTimeString().slice(0, 5);
      // Resolve connectivity at submit time so a mid-session change is honoured.
      const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

      if (hasGuestBilling) {
        if (bookingRef.current?.status === 'pending') {
          const confirmed = await reservationsService.updateStatus(bookingRef.current.id, 'confirmed');
          hydrateBooking(confirmed);
        }
        const request = {
          guestName: name,
          guestPhone: phone || null,
          guestEmail: email || null,
          checkInDate,
          checkOutDate,
          partySize: room.capacity || 1,
          notes: idNumber ? `Guest ID: ${idNumber}` : null,
          clientRequestId: bookingRef.current?.id || requestId,
          expectedReservationId: bookingRef.current?.id || null,
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
        if (!isOnline) throw new Error('offline');
        reservationsService.setContext(branchId, organizationId);
        // A timeout after create must resume the booking that now owns the dates.
        let current = bookingRef.current || await reservationsService.getActiveRoomReservation(room.id, checkInDate);
        if (current && !bookingRef.current) {
          hydrateBooking(current);
          setFailure(t('roomWorkflow.resumeBooking', { number: current.reservationNumber }));
          return;
        }
        if (!current) {
          current = await reservationsService.createReservation({
            reservationType: 'room', customerName: name.trim(), customerPhone: phone.trim(),
            customerEmail: email || undefined, partySize: room.capacity || 1,
            reservationDate: checkInDate, reservationTime, roomId: room.id,
            roomNumber: room.roomNumber, checkInDate, checkOutDate,
            notes: idNumber ? `ID: ${idNumber}` : undefined,
          });
        }
        // Retain before the next await: failed confirmation/arrival never creates another booking.
        hydrateBooking(current);
        await reservationsService.arriveRoomReservation(current.id);
      }

      void Promise.resolve(refetchRooms()).catch(() => undefined);
      toast.success(t('roomsView.toasts.checkinSuccess', { defaultValue: 'Check-in completed successfully' }));
      onCompleted();
    } catch (error) {
      console.error('Failed to complete check-in:', error);
      setFailure(roomWorkflowError(error, t));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen
      onClose={() => { if (!submitting) onClose(); }}
      title={t('roomsView.newCheckin', { defaultValue: 'New Check-in' })}
      className="!max-w-lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
    >
      <div className="space-y-4 p-1">
        <RoomChip room={room} subtitle={translateRoomType(t, room.roomType)} />
        {loadingBooking && <p role="status">{t('roomWorkflow.loadingBooking')}</p>}
        {booking && <p className="text-sm">{t('roomWorkflow.resumeBooking', { number: booking.reservationNumber })} · {booking.checkInDate} – {booking.checkOutDate}</p>}
        {failure && <p role="alert" className="rounded-xl border border-red-500/40 p-3 text-red-500">{failure}</p>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <GlassInput
            icon={<User className="h-4 w-4" />}
            label={t('roomsView.guestName', { defaultValue: 'Guest Name' })}
            value={name}
            onChange={setName}
            readOnly={Boolean(booking)}
            required
          />
          <GlassInput
            icon={<Phone className="h-4 w-4" />}
            label={t('roomsView.phone', { defaultValue: 'Phone' })}
            value={phone}
            onChange={setPhone}
            readOnly={Boolean(booking)}
            required={requiresPhone}
          />
          <GlassInput
            icon={<Mail className="h-4 w-4" />}
            label={t('roomsView.email', { defaultValue: 'Email' })}
            type="email"
            value={email}
            onChange={setEmail}
            readOnly={Boolean(booking)}
          />
          {(hasGuestBilling || !booking) && <GlassInput
            icon={<CreditCard className="h-4 w-4" />}
            label={t('roomsView.idNumber', { defaultValue: 'ID Number' })}
            value={idNumber}
            onChange={setIdNumber}
          />}
        </div>

        <div>
          <label className="liquid-glass-modal-text-muted mb-1.5 block text-sm font-medium">
            {t('roomsView.numberOfNights', { defaultValue: 'Number of Nights' })}
          </label>
          <input
            type="number"
            disabled={Boolean(booking)}
            min={1}
            value={nights}
            onChange={(e) => setNights(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className={fieldClass}
          />
        </div>

        {!hasGuestBilling && <p className="rounded-xl border border-amber-500/40 p-3 text-sm">{t('roomWorkflow.noBillingNotice')}</p>}

        <div className="liquid-glass-modal-inset flex items-center justify-between rounded-2xl p-4">
          <span className="liquid-glass-modal-text-muted text-sm">
            {t('roomsView.estimatedStayCharge', { defaultValue: 'Estimated Stay Charge' })}
          </span>
          <span className="liquid-glass-modal-text text-2xl font-bold">{formatCurrency(totalAmount)}</span>
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
            disabled={!name.trim() || (requiresPhone && !phone.trim()) || submitting || loadingBooking}
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
  reservation,
  rooms,
  branchId,
  organizationId,
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

  const [name, setName] = useState(() => reservation?.customerName || roomGuestName(room) || '');
  const [phone, setPhone] = useState(reservation?.customerPhone || '');
  const [checkInDate, setCheckInDate] = useState(reservation?.checkInDate || defaults.checkInDate);
  const [checkOutDate, setCheckOutDate] = useState(reservation?.checkOutDate || defaults.checkOutDate);
  const [notes, setNotes] = useState(reservation?.notes || '');
  const [selectedRoomId, setSelectedRoomId] = useState(room.id);
  const selectedRoom = rooms?.find((item) => item.id === selectedRoomId) || room;
  const nights = roomStayNights(checkInDate, checkOutDate);
  const [failure, setFailure] = useState('');
  const requestPending = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const handleReservation = async () => {
    if (requestPending.current) return;
    if (!name.trim() || !phone.trim()) { setFailure(t('roomWorkflow.phoneRequired')); return; }
    if (!nights) { setFailure(t('roomWorkflow.invalidDates')); return; }
    if (!hasReservations) {
      toast.error(
        t('roomsView.toasts.reservationsModuleRequired', {
          defaultValue: 'Reservations module is required to create room reservations',
        }),
      );
      return;
    }

    requestPending.current = true;
    setSubmitting(true);
    setFailure('');
    try {
      reservationsService.setContext(branchId || '', organizationId || '');
      const input = {
        customerName: name,
        customerPhone: phone || '',
        partySize: reservation?.partySize || selectedRoom.capacity || 2,
        reservationDate: checkInDate,
        reservationTime: reservation?.reservationTime?.slice(0, 5) || '14:00',
        roomId: selectedRoom.id,
        roomNumber: selectedRoom.roomNumber,
        checkInDate,
        checkOutDate,
        notes: notes || undefined,
      };
      if (reservation) await reservationsService.updateReservationDetails(reservation.id, input);
      else await reservationsService.createReservation({ ...input, reservationType: 'room' });

      void Promise.resolve(refetchRooms()).catch(() => undefined);
      toast.success(reservation
        ? t('common.messages.changesSaved', { defaultValue: 'Changes saved successfully' })
        : t('roomsView.toasts.reservationCreated', { defaultValue: 'Reservation created successfully' }));
      onCompleted();
    } catch (error) {
      console.error('Failed to create reservation:', error);
      setFailure(roomWorkflowError(error, t));
    } finally {
      requestPending.current = false;
      setSubmitting(false);
    }
  };

  return (
    <LiquidGlassModal
      isOpen
      onClose={() => { if (!submitting) onClose(); }}
      title={reservation ? t('roomWorkflow.editBooking') : t('roomsView.newReservation', { defaultValue: 'New Reservation' })}
      className="!max-w-lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
    >
      <div className="space-y-4 p-1">
        <RoomChip room={selectedRoom} subtitle={translateRoomType(t, selectedRoom.roomType)} />
        {rooms && <label className="block text-sm">{t('roomsView.selectRoom')}<select className={fieldClass} value={selectedRoomId} onChange={(event) => setSelectedRoomId(event.target.value)}>{rooms.map((option) => <option key={option.id} value={option.id}>{option.roomNumber}</option>)}</select></label>}
        {failure && <p role="alert" className="rounded-xl border border-red-500/40 p-3 text-red-500">{failure}</p>}

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
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="liquid-glass-modal-text-muted mb-1.5 block text-sm font-medium">
              {t('roomsView.checkInDate', { defaultValue: 'Check-in Date' })}
            </label>
            <input
              type="date"
              aria-label={t('roomsView.checkInDate', { defaultValue: 'Check-in Date' })}
              value={checkInDate}
              onChange={(e) => setCheckInDate(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div>
            <label className="liquid-glass-modal-text-muted mb-1.5 block text-sm font-medium">
              {t('roomsView.checkOutDate', { defaultValue: 'Check-out Date' })}
            </label>
            <input
              type="date"
              aria-label={t('roomsView.checkOutDate', { defaultValue: 'Check-out Date' })}
              min={checkInDate}
              value={checkOutDate}
              onChange={(e) => setCheckOutDate(e.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        <div>
          <label className="liquid-glass-modal-text-muted mb-1.5 block text-sm font-medium">
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

        <div className="liquid-glass-modal-inset rounded-xl p-4" aria-live="polite">
          {nights ? t('roomWorkflow.costPreview', { nights, rate: formatCurrency(selectedRoom.ratePerNight || 0), total: formatCurrency(nights * (selectedRoom.ratePerNight || 0)) }) : t('roomWorkflow.invalidDates')}
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
            disabled={!name.trim() || !phone.trim() || !nights || submitting}
            className="flex-1 rounded-xl border border-emerald-500 bg-emerald-600 py-3 font-medium text-white transition-transform duration-150 active:scale-95 disabled:bg-zinc-400/20 disabled:text-zinc-400 disabled:border-zinc-400/30 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100"
          >
            {reservation ? t('common.actions.save', { defaultValue: 'Save' }) : t('roomsView.createReservation', { defaultValue: 'Create Reservation' })}
          </button>
        </div>
      </div>
    </LiquidGlassModal>
  );
};
