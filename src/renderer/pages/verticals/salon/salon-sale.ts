import { branchWallTime } from '../../../utils/branch-time';
import type { Appointment } from '../../../services/AppointmentsService';
import type { Service } from '../../../services/ServicesService';
import { serviceSaleGrossPrice, type ServiceSaleVatDefaults } from '../../../../../../shared/services/GreeceVatService';

export interface SalonSale {
  items: any[];
  customer: { id: string; name: string; phone: string; email?: string };
}

/** The branch VAT defaults this till holds (`tax.*` terminal settings), for net-priced services. */
export function serviceVatDefaults(getSetting: <T = unknown>(category: string, key: string) => T | undefined): ServiceSaleVatDefaults {
  return { defaultVatCategoryCode: getSetting<string>('tax', 'vat_default_category_code') ?? null,
    vatRegionProfile: getSetting<string>('tax', 'vat_region_profile') ?? null };
}

/** A service sells VAT-inclusive; the conversion is shared with Android and pinned to the server. */
export function serviceGrossPrice(service: Service, catalogPrice = service.price, defaults?: ServiceSaleVatDefaults | null): number {
  return serviceSaleGrossPrice(catalogPrice, service, defaults);
}

export function serviceSaleLine(service: Service, appointment?: Appointment, segment?: Appointment['services'][number],
  defaults?: ServiceSaleVatDefaults | null) {
  const price = serviceGrossPrice(service, segment?.price ?? appointment?.totalPrice ?? service.price, defaults);
  return {
    id: crypto.randomUUID(), menu_item_id: null, menuItemId: null,
    service_id: service.id, appointment_id: appointment?.id ?? null,
    staff_id: segment?.staffId ?? appointment?.staffId ?? null,
    name: segment?.serviceName || service.name,
    quantity: 1, price, unitPrice: price, basePrice: price, totalPrice: price,
    originalUnitPrice: price, customizations: [],
    vat_category_code: service.vatCategoryCode,
    price_includes_vat: true,
    tax_exemption_reason: service.taxExemptionReason,
    fiscal_document_profile: service.fiscalDocumentProfile,
    metadata: { staff_id: segment?.staffId ?? appointment?.staffId ?? null,
      staff_name: segment?.staffName ?? appointment?.staffName ?? null },
  };
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
