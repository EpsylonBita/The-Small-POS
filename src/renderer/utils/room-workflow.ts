import type { TFunction } from 'i18next';

/** Calendar dates and reservation wall time belong to the branch, not the PC timezone. */
export function reservationWallDateTime(reservation: {
  reservationDate: string; reservationTime: string; reservationDatetime: string;
}): string {
  const date = reservation.reservationDate?.slice(0, 10);
  const time = reservation.reservationTime?.slice(0, 5);
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && /^\d{2}:\d{2}$/.test(time || '')
    ? `${date}T${time}:00` : reservation.reservationDatetime;
}

export function roomStayNights(checkIn: string, checkOut: string): number {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const instant = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? instant : NaN;
  };
  const nights = (parse(checkOut) - parse(checkIn)) / 86_400_000;
  return Number.isInteger(nights) && nights > 0 ? nights : 0;
}

export function roomWorkflowError(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const key = /customerPhone|phone.*required/i.test(raw) ? 'phoneRequired'
    : /check.?out.*after|ROOM_DATES_INVALID|INVALID_DATES/i.test(raw) ? 'invalidDates'
    : /ROOM_UNAVAILABLE|ROOM_DATES_UNAVAILABLE|ROOM_NOT_AVAILABLE|room.*not available|room.*unavailable|overlap|already reserved/i.test(raw) ? 'unavailable'
    : /ROOM_CHECKOUT_REQUIRED|folio_balance_outstanding|outstanding balance/i.test(raw) ? 'checkoutRequired'
    : /ROOM_CHECKIN_REQUIRED/i.test(raw) ? 'checkinRequired'
    : /MODULE_REQUIRED/i.test(raw) ? 'moduleRequired'
    : /ROOM_RESERVATION_REQUIRED/i.test(raw) ? 'reservationRequired'
    : /TERMINAL_RESERVATION|ROOM_RESERVATION_LOCKED/i.test(raw) ? 'locked'
    : /network|fetch|offline|connect/i.test(raw) ? 'connectionError'
    : 'saveFailed';
  return t(`roomWorkflow.${key}`);
}
