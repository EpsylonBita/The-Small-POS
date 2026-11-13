/**
 * Availability of ONE table for the reservation form's day strip and time grid (founder,
 * 11/11/2026: «νέα κράτηση τραπεζιού δεν έχει ημερομηνία με διαθεσιμότητα και ώρα»).
 *
 * Presentation only. The overlap rule is the one `ReservationsService.checkReservationConflicts`
 * applies (a new reservation holds the table for 90 minutes; an existing one for its own
 * duration, 90 by default; only pending and confirmed reservations of the same day count), so a
 * time shown free here is not refused there. That check, and the server, stay authoritative.
 *
 * Pure and framework-free so it is unit tested without the form.
 */
import { toLocalDateString } from './date';

/** How long a new reservation holds the table (the service's default). */
export const RESERVATION_DURATION_MINUTES = 90;
export const RESERVATION_SLOT_STEP_MINUTES = 30;
/** The grid offers 08:00 to 23:30; any other time is typed in the time field. */
export const RESERVATION_FIRST_SLOT_MINUTES = 8 * 60;
export const RESERVATION_LAST_SLOT_MINUTES = 23 * 60 + 30;
/** Today and the next 13 days; any other day is picked in the date field. */
export const RESERVATION_DAY_STRIP_LENGTH = 14;

const ACTIVE_STATUSES = new Set(['pending', 'confirmed']);

export interface TableReservationLike {
  id?: string | null;
  reservationDate?: string | null;
  reservationTime?: string | null;
  durationMinutes?: number | null;
  status?: string | null;
}

export interface ReservationSlot {
  /** "HH:mm" */
  time: string;
  state: 'free' | 'taken';
}

export interface ReservationDay {
  /** "YYYY-MM-DD" */
  date: string;
  /** Active reservations of the table that day. */
  reserved: number;
  /** Times the grid still offers that day (past times of today excluded). */
  slots: number;
  /** How many of those times are free. */
  free: number;
}

interface AvailabilityInput<T extends TableReservationLike> {
  reservations: T[] | null | undefined;
  now: Date;
  /** The reservation being edited never blocks its own time. */
  excludeId?: string | null;
}

/** Minutes after midnight of "HH:mm" or "HH:mm:ss"; null when it cannot be read. */
export function minutesOfDay(time: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const pad = (value: number) => String(value).padStart(2, '0');
const toTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** The table's pending and confirmed reservations on `date`, without the one being edited. */
export function activeReservationsOn<T extends TableReservationLike>(
  reservations: T[] | null | undefined,
  date: string,
  excludeId?: string | null,
): T[] {
  if (!date || !Array.isArray(reservations)) return [];
  return reservations.filter((reservation) => {
    if (!reservation || reservation.reservationDate !== date) return false;
    if (excludeId && reservation.id === excludeId) return false;
    // A list that carries no status was already filtered by the service.
    return !reservation.status || ACTIVE_STATUSES.has(reservation.status);
  });
}

/** True when a new reservation starting at `startMinutes` would overlap one of `sameDay`. */
export function overlapsReservation(startMinutes: number, sameDay: TableReservationLike[]): boolean {
  const end = startMinutes + RESERVATION_DURATION_MINUTES;
  return sameDay.some((reservation) => {
    const existingStart = minutesOfDay(reservation.reservationTime);
    if (existingStart === null) return false;
    const existingEnd = existingStart + (Number(reservation.durationMinutes) || RESERVATION_DURATION_MINUTES);
    return startMinutes < existingEnd && end > existingStart;
  });
}

/**
 * The time grid of one day: every half hour from 08:00 to 23:30, each free or taken. Times of
 * today that have already passed are left out.
 */
export function buildReservationSlots<T extends TableReservationLike>(
  input: AvailabilityInput<T> & { date: string },
): ReservationSlot[] {
  const { date, now } = input;
  if (!date) return [];
  const today = toLocalDateString(now);
  if (date < today) return [];
  const nowMinutes = date === today ? now.getHours() * 60 + now.getMinutes() : -1;
  const sameDay = activeReservationsOn(input.reservations, date, input.excludeId);
  const slots: ReservationSlot[] = [];
  for (
    let minutes = RESERVATION_FIRST_SLOT_MINUTES;
    minutes <= RESERVATION_LAST_SLOT_MINUTES;
    minutes += RESERVATION_SLOT_STEP_MINUTES
  ) {
    if (minutes <= nowMinutes) continue;
    slots.push({ time: toTime(minutes), state: overlapsReservation(minutes, sameDay) ? 'taken' : 'free' });
  }
  return slots;
}

/** Today and the following days, each with how many reservations it has and how many times are free. */
export function buildReservationDays<T extends TableReservationLike>(
  input: AvailabilityInput<T> & { length?: number },
): ReservationDay[] {
  const length = input.length ?? RESERVATION_DAY_STRIP_LENGTH;
  const days: ReservationDay[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    const day = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() + offset);
    const date = toLocalDateString(day);
    const slots = buildReservationSlots({ ...input, date });
    days.push({
      date,
      reserved: activeReservationsOn(input.reservations, date, input.excludeId).length,
      slots: slots.length,
      free: slots.filter((slot) => slot.state === 'free').length,
    });
  }
  return days;
}
