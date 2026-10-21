import { describe, expect, it } from 'vitest';
import { appointmentSale, appointmentWallTimes, branchWallClock, serviceSaleLine, serviceVatDefaults, appointmentCanCheckIn, hasAppointmentTicket } from '../salon-sale';
import { normalizePosOrderItem, hasValidSyncedPosMenuItemId } from '../../../../../shared/utils/pos-order-items';
import type { Service } from '../../../../services/ServicesService';
import type { Appointment } from '../../../../services/AppointmentsService';

const service = { id: '10000000-0000-4000-8000-000000000001', name: 'Haircut', price: 25,
  durationMinutes: 45, vatCategoryCode: 'gr_standard_24', priceIncludesVat: true,
  taxExemptionReason: null, fiscalDocumentProfile: 'retail_receipt' } as Service;
const appointment = { id: '20000000-0000-4000-8000-000000000001', serviceId: service.id,
  staffId: 'stylist', staffName: 'Ana', customerId: 'customer', customerName: 'Mia',
  customerPhone: '123', status: 'scheduled', totalPrice: 22, services: [], isMultiService: false } as unknown as Appointment;

describe('salon ordinary order contract', () => {
  it('sells net-priced catalog, appointment and segment lines gross with inclusive VAT', () => {
    const net = { ...service, priceIncludesVat: false };
    for (const line of [serviceSaleLine(net), appointmentSale({ ...appointment, totalPrice: 25 }, [net]).items[0],
      serviceSaleLine(net, appointment, { price: 25 } as any)]) {
      expect(line).toMatchObject({ price: 31, unitPrice: 31, totalPrice: 31, price_includes_vat: true });
      expect(normalizePosOrderItem(line)).toMatchObject({ unit_price: 31, price_includes_vat: true, vat_category_code: 'gr_standard_24' });
    }
    expect(serviceSaleLine(service)).toMatchObject({ price: 25, price_includes_vat: true });
    expect(serviceSaleLine({ ...net, price: 0.375 })).toMatchObject({ price: 0.47 });
  });
  it('converts with the branch VAT defaults the till holds, exactly as the server (round-3 re-audit)', () => {
    const settings: Record<string, string> = { 'tax.vat_default_category_code': 'gr_reduced_13', 'tax.vat_region_profile': 'mainland' };
    const defaults = serviceVatDefaults(<T,>(category: string, key: string) => settings[`${category}.${key}`] as T | undefined);
    const uncategorised = { ...service, vatCategoryCode: null, priceIncludesVat: false } as unknown as Service;
    expect(serviceSaleLine(uncategorised, undefined, undefined, defaults)).toMatchObject({ price: 28.25, price_includes_vat: true });
    expect(appointmentSale({ ...appointment, totalPrice: 25 }, [uncategorised], defaults).items[0]).toMatchObject({ price: 28.25 });
    expect(serviceSaleLine({ ...service, vatCategoryCode: 'pos_receipt_zero', priceIncludesVat: false } as Service, undefined, undefined, defaults))
      .toMatchObject({ price: 25 });
    const islands = { defaultVatCategoryCode: 'gr_standard_24', vatRegionProfile: 'islands_reduced' };
    // An unknown code takes the region default (17 % on reduced-rate islands); a known code keeps its rate.
    expect(serviceSaleLine({ ...service, vatCategoryCode: 'not_a_category', priceIncludesVat: false }, undefined, undefined, islands))
      .toMatchObject({ price: 29.25 });
    expect(serviceSaleLine({ ...service, priceIncludesVat: false }, undefined, undefined, islands)).toMatchObject({ price: 31 });
  });
  it('sells a service at its recorded price and VAT without a menu identity or duration multiplier', () => {
    const line = normalizePosOrderItem(serviceSaleLine(service));
    expect(line.service_id).toBe(service.id);
    expect(line.menu_item_id).toBeNull();
    expect(line.unit_price).toBe(25);
    expect(line.quantity).toBe(1);
    expect(line.vat_category_code).toBe('gr_standard_24');
    expect(hasValidSyncedPosMenuItemId(line)).toBe(true);
  });
  it('attaches customer, appointment and staff, preserving a zero booked price', () => {
    const sale = appointmentSale({ ...appointment, totalPrice: 0 }, [service]);
    expect(sale.customer.id).toBe('customer');
    expect(sale.items[0]).toMatchObject({ appointment_id: appointment.id, service_id: service.id,
      price: 0, staff_id: 'stylist', metadata: { staff_id: 'stylist', staff_name: 'Ana' } });
  });
  it('makes one line per non-cancelled appointment segment with each staff and price', () => {
    const sale = appointmentSale({ ...appointment, isMultiService: true, services: [
      { serviceId: service.id, price: 10, staffId: 'staff-a', status: 'completed' },
      { serviceId: service.id, price: 12, staffId: 'staff-b', status: 'pending' },
      { serviceId: service.id, price: 99, status: 'cancelled' },
    ] as Appointment['services'] }, [service]);
    expect(sale.items.map(line => line.price)).toEqual([10, 12]);
    expect(sale.items.map(line => line.staff_id)).toEqual(['staff-a', 'staff-b']);
    expect(new Set(sale.items.map(line => line.id)).size).toBe(2);
  });
  it('refuses an unresolved appointment identity and missing service fiscal details', () => {
    expect(() => appointmentSale({ ...appointment, id: 'local-appointment-1' }, [service])).toThrow('SALON_APPOINTMENT_PENDING');
    expect(() => appointmentSale(appointment, [])).toThrow('SALON_SERVICE_UNAVAILABLE');
  });
  it('recognizes an existing appointment ticket only in its organization and branch', () => {
    const scoped = { ...appointment, organizationId: 'org', branchId: 'branch' };
    const order = { organization_id: 'org', branch_id: 'branch', status: 'pending', items: JSON.stringify([{ appointment_id: appointment.id }]) };
    expect(hasAppointmentTicket([order], scoped)).toBe(true);
    expect(hasAppointmentTicket([{ ...order, organization_id: 'other' }], scoped)).toBe(false);
    expect(hasAppointmentTicket([{ ...order, branch_id: 'other' }], scoped)).toBe(false);
    expect(hasAppointmentTicket([{ ...order, status: 'cancelled' }], scoped)).toBe(false);
  });
  it('offers Check In for scheduled and confirmed, never for a terminal state', () => {
    expect(appointmentCanCheckIn('scheduled')).toBe(true);
    expect(appointmentCanCheckIn('confirmed')).toBe(true);
    expect(appointmentCanCheckIn('in_progress')).toBe(false);
    expect(appointmentCanCheckIn('completed')).toBe(false);
  });
});

describe('branch wall time contract', () => {
  it('sends the operator wall clock unchanged and rolls duration over midnight', () => {
    expect(appointmentWallTimes('2026-10-25', '23:45', 45)).toEqual({ start: '2026-10-25T23:45:00', end: '2026-10-26T00:30:00' });
    expect(() => appointmentWallTimes('2026-02-30', '10:00', 30)).toThrow();
  });
  it('maps UTC slots to the branch before comparing the selected clock, across DST', () => {
    expect(branchWallClock('2026-10-25T00:30:00Z', 'Europe/Athens')).toBe('2026-10-25T03:30');
    expect(branchWallClock('2026-10-25T01:30:00Z', 'Europe/Athens')).toBe('2026-10-25T03:30');
    expect(branchWallClock('2026-10-20T22:30:00Z', 'Europe/Athens')).toBe('2026-10-21T01:30');
    expect(branchWallClock('2026-10-21T10:00:00', 'Europe/Athens')).toBe('2026-10-21T10:00');
  });
});
