import { describe, expect, it } from 'vitest';
import { buildPickupOrderDetails, pickupCustomerIdentity, readPickupCustomerDraft } from '../pickup-customer';

describe('pickup order details', () => {
  it('keeps a completely anonymous order free of customer identity', () => {
    expect(buildPickupOrderDetails(null, { name: '', phone: '', notes: '' })).toEqual({ customer: null, notes: '' });
  });

  it('preserves identity and metadata while replacing the order copy of contact details', () => {
    const customer = Object.freeze({ id: 'real-id', customer_name: 'Before', full_name: 'Before', phone: '111', loyalty_points: 50 });
    const details = buildPickupOrderDetails(customer, { name: ' After ', phone: ' 222 ', notes: ' By door ' });
    expect(details.customer).toEqual({
      id: 'real-id', customer_name: 'After', full_name: 'After', name: 'After',
      phone: '222', phone_number: '222', notes: 'By door', loyalty_points: 50,
    });
    expect(customer.phone).toBe('111');
    expect(details.customer).not.toBe(customer);
  });

  it('merges checkout notes with pickup notes and avoids identical duplicates', () => {
    const draft = { name: '', phone: '', notes: ' Call first ' };
    expect(buildPickupOrderDetails(null, draft, ' Fragile ').notes).toBe('Fragile\nCall first');
    expect(buildPickupOrderDetails(null, draft, 'Call first').notes).toBe('Call first');
    expect(buildPickupOrderDetails(null, { ...draft, notes: '' }, 'Fragile').notes).toBe('Fragile');
  });

  it('treats intentionally empty canonical values as cleared when initializing', () => {
    expect(readPickupCustomerDraft({ name: '', full_name: 'Old name', phone_number: '', phone: 'Old phone' })).toEqual({ name: '', phone: '', notes: '' });
    expect(pickupCustomerIdentity({ id: 'one', name: 'A' })).toBe(pickupCustomerIdentity({ id: 'one', name: 'Changed' }));
    expect(pickupCustomerIdentity(null)).not.toBe(pickupCustomerIdentity({ id: 'one' }));
  });
});
