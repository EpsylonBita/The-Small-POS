import type { CreateReservationDto as ReservationFormData } from '../components/tables/ReservationForm';
import {
  buildChangedReservationUpdate,
  reservationsService,
  type CreateReservationDto,
  type Reservation,
} from '../services/ReservationsService';
import { toLocalDateString } from './date';

type TableReservationService = Pick<
  typeof reservationsService,
  'setContext' | 'createReservationWithTableUpdate' | 'updateReservationDetails'
>;

export interface SubmitTableReservationInput {
  /** What the cashier entered in the ReservationForm. */
  data: ReservationFormData;
  /** The booking being edited, or null to book the table anew. */
  editingReservation: Reservation | null;
  branchId: string | null | undefined;
  organizationId: string | null | undefined;
}

/** What happened. A service failure throws, so each screen words its own error. */
export type TableReservationSubmitResult = 'missing-context' | 'created' | 'updated';

/**
 * Saves the ReservationForm of a table, the same way on every desktop table
 * screen (the Orders dashboard, the order flow, the Tables page): scoped to
 * the terminal's branch and organization, the chosen date and time as local
 * values, and on an edit only the fields that changed. A new booking for today
 * also marks the table reserved (`createReservationWithTableUpdate`).
 */
export async function submitTableReservation(
  { data, editingReservation, branchId, organizationId }: SubmitTableReservationInput,
  service: TableReservationService = reservationsService,
): Promise<TableReservationSubmitResult> {
  if (!branchId || !organizationId) {
    return 'missing-context';
  }

  service.setContext(branchId, organizationId);

  const details: CreateReservationDto = {
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    partySize: data.partySize,
    reservationDate: toLocalDateString(data.reservationTime),
    reservationTime: data.reservationTime.toTimeString().slice(0, 5),
    tableId: data.tableId,
    specialRequests: data.specialRequests,
  };

  if (editingReservation) {
    const changes = buildChangedReservationUpdate(editingReservation, details);
    if (Object.keys(changes).length > 0) {
      await service.updateReservationDetails(editingReservation.id, changes);
    }
    return 'updated';
  }

  await service.createReservationWithTableUpdate(details);
  return 'created';
}
