/**
 * Helpers for the ReservationForm "existing reservations" warning.
 *
 * The warning must only surface reservations that are still relevant when staff
 * create a new one - today or in the future - and must never warn about stale
 * past rows. Pure + framework-agnostic so the past/upcoming selection is unit
 * testable independently of the React component; locale-aware date/time rendering
 * is handled separately by the shared format helpers.
 */

export interface ExistingTableReservationLike {
  id?: string | null;
  reservationDate?: string | null;
  reservationTime?: string | null;
  reservationDatetime?: string | null;
}

/** Normalize a "HH:mm" / "HH:mm:ss" time-of-day to a zero-padded "HH:mm:ss". */
const normalizeTimeOfDay = (time: string): string => {
  const trimmed = time.trim();
  if (!trimmed) {
    return '00:00:00';
  }
  const [hours = '00', minutes = '00', seconds = '00'] = trimmed.split(':');
  const pad = (value: string) => value.padStart(2, '0').slice(0, 2);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

/**
 * Resolve a reservation's start instant. Prefers the full `reservationDatetime`
 * and falls back to `reservationDate` (+ optional `reservationTime`, defaulting to
 * start of day). Returns null when nothing parseable is available.
 */
export function resolveReservationStart(
  reservation: ExistingTableReservationLike | null | undefined,
): Date | null {
  if (!reservation) {
    return null;
  }

  const datetime = (reservation.reservationDatetime || '').trim();
  if (datetime) {
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const date = (reservation.reservationDate || '').trim();
  if (date) {
    const parsed = new Date(`${date}T${normalizeTimeOfDay(reservation.reservationTime || '')}`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

/**
 * Select the reservations relevant to the existing-reservations warning: rows that
 * start today or later, excluding the one being edited, sorted ascending by start.
 * Reservations before the start of `now`'s day are dropped so staff are not warned
 * about stale history. Rows with no parseable start are also dropped (nothing
 * meaningful to show).
 */
export function selectUpcomingTableReservations<T extends ExistingTableReservationLike>(
  reservations: T[] | null | undefined,
  options: { now: Date; excludeId?: string | null },
): T[] {
  const list = Array.isArray(reservations) ? reservations : [];
  const startOfToday = new Date(options.now);
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = startOfToday.getTime();
  const excludeId = options.excludeId ?? null;

  return list
    .map((reservation) => ({ reservation, start: resolveReservationStart(reservation) }))
    .filter(({ reservation, start }) => {
      if (excludeId && reservation.id === excludeId) {
        return false;
      }
      return start !== null && start.getTime() >= cutoff;
    })
    .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
    .map(({ reservation }) => reservation);
}
