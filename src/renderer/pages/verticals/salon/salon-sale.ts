import { branchWallTime } from '../../../utils/branch-time';
import type { Appointment } from '../../../services/AppointmentsService';
import type { Service } from '../../../services/ServicesService';
import { serviceSaleGrossPrice, type ServiceSaleVatDefaults } from '../../../../../../shared/services/GreeceVatService';
import { readBranchVatSettings } from '../../../utils/branchVatSettings';

export interface SalonSale {
  items: any[];
  customer: { id: string; name: string; phone: string; email?: string };
}

/**
 * The branch VAT defaults this till holds (`tax.*` terminal settings), for net-priced services:
 * the default category, the region, the country (`tax.vat_country`) and whether the branch is
 * VAT-registered (`tax.vat_registered`, registered when unset).
 */
export function serviceVatDefaults(getSetting: <T = unknown>(category: string, key: string) => T | undefined): ServiceSaleVatDefaults {
  return readBranchVatSettings(getSetting);
}

/** A service sells VAT-inclusive; the conversion is shared with Android and pinned to the server. */
export function serviceGrossPrice(service: Service, catalogPrice = service.price, defaults?: ServiceSaleVatDefaults | null): number {
  return serviceSaleGrossPrice(catalogPrice, service, defaults);
}

/** The stylist the cashier picked for a walk-in service line (ids and names only). */
export interface WalkInStylist { id: string; name: string }

/**
 * One service line. A booked segment or appointment names its own staff; a
 * walk-in line takes the stylist the cashier picked, with the same `staff_id`
 * and `metadata.staff_name` the appointment lines carry (Android `serviceCartLine`).
 */
export function serviceSaleLine(service: Service, appointment?: Appointment, segment?: Appointment['services'][number],
  defaults?: ServiceSaleVatDefaults | null, walkInStylist?: WalkInStylist | null) {
  const price = serviceGrossPrice(service, segment?.price ?? appointment?.totalPrice ?? service.price, defaults);
  const bookedStaffId = segment?.staffId ?? appointment?.staffId ?? null;
  const walkIn = !bookedStaffId && walkInStylist?.id?.trim() ? walkInStylist : null;
  return {
    id: crypto.randomUUID(), menu_item_id: null, menuItemId: null,
    service_id: service.id, appointment_id: appointment?.id ?? null,
    staff_id: bookedStaffId ?? walkIn?.id ?? null,
    name: segment?.serviceName || service.name,
    quantity: 1, price, unitPrice: price, basePrice: price, totalPrice: price,
    originalUnitPrice: price, customizations: [],
    vat_class: service.vatClass,
    vat_category_code: service.vatCategoryCode,
    price_includes_vat: true,
    tax_exemption_reason: service.taxExemptionReason,
    fiscal_document_profile: service.fiscalDocumentProfile,
    metadata: { staff_id: bookedStaffId ?? walkIn?.id ?? null,
      staff_name: walkIn ? walkIn.name : (segment?.staffName ?? appointment?.staffName ?? null) },
  };
}

/** A walk-in service line with the stylist picked for it; `null` keeps it without one. Booked lines never change. */
export function withWalkInStylist<T extends { appointment_id?: string | null; staff_id?: string | null; metadata?: Record<string, unknown> | null }>(
  line: T, stylist: WalkInStylist | null): T {
  if (!stylist?.id?.trim() || line.appointment_id || line.staff_id) return line;
  return { ...line, staff_id: stylist.id, metadata: { ...(line.metadata ?? {}), staff_id: stylist.id, staff_name: stylist.name } };
}

export function appointmentSale(appointment: Appointment, catalog: Service[], defaults?: ServiceSaleVatDefaults | null): SalonSale {
  // The order API requires the canonical UUID. Never lose its appointment link.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appointment.id)) throw new Error('SALON_APPOINTMENT_PENDING');
  if (!['scheduled', 'confirmed', 'in_progress'].includes(appointment.status)) throw new Error('SALON_APPOINTMENT_CLOSED');
  const segments = appointment.services.filter(s => !['cancelled', 'skipped'].includes(s.status));
  if (appointment.isMultiService && segments.length === 0) throw new Error('SALON_SERVICE_UNAVAILABLE');
  const items = (segments.length ? segments : [null]).map(segment => {
    const service = catalog.find(s => s.id === (segment?.serviceId ?? appointment.serviceId));
    if (!service) throw new Error('SALON_SERVICE_UNAVAILABLE');
    return serviceSaleLine(service, appointment, segment ?? undefined, defaults);
  });
  return { items, customer: { id: appointment.customerId || '', name: appointment.customerName || '',
    phone: appointment.customerPhone || '', email: appointment.customerEmail || undefined } };
}

/** Calendar arithmetic only: no conversion through the device's timezone. */
export function appointmentWallTimes(date: string, time: string, duration: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('SALON_INVALID_TIME');
  const start = `${date}T${time}:00`;
  const calendar = new Date(`${start}Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 16) !== start.slice(0, 16)) throw new Error('SALON_INVALID_TIME');
  const end = new Date(calendar.getTime() + duration * 60000).toISOString().slice(0, 19);
  return { start, end };
}

export function branchWallClock(instant: string | Date, timeZone: string): string {
  if (typeof instant === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(instant)) return instant.slice(0, 16);
  return branchWallTime(instant, timeZone).slice(0, 16);
}

export const appointmentCanCheckIn = (status: Appointment['status']) => status === 'scheduled' || status === 'confirmed';

export function hasAppointmentTicket(orders: any[], appointment: Appointment): boolean {
  return orders.some(order => {
    if ((order.organization_id ?? order.organizationId) !== appointment.organizationId ||
      (order.branch_id ?? order.branchId) !== appointment.branchId || ['cancelled', 'canceled', 'voided', 'failed'].includes(order.status)) return false;
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
    return Array.isArray(items) && items.some(line => (line.appointment_id ?? line.appointmentId) === appointment.id);
  });
}
