import { describe, expect, it } from 'vitest';
import { customerInfoEditUpdate, isSameCustomerEditDestination, orderCreateDeliveryLocation, orderCustomerEditSnapshot } from '../orderCustomerEdit';

const customerId = '81ecd4e9-1738-4835-acc4-b9c8f4bbc069';
const addressId = '9ae39e73-cfc3-40b3-b4f5-dc731a98c231';
const original = { name: 'Person', phone: '123', address: 'Street 12', city: 'City', postal_code: '12345',
  customerId, addressId, addressFingerprint: 'saved-fingerprint', latitude: null, longitude: null, expectedVersion: 3 };
const point = { lat: 40.6138032, lng: 22.9601881 };

describe('order customer edit destination ownership', () => {
  it('keeps metadata-only writes out of native destination and money fields', () => {
    const payload = customerInfoEditUpdate({ ...original, destinationChanged: false, name: 'New name', phone: '456', delivery_floor: '2', name_on_ringer: 'Bell', notes: 'Note' }, original);
    expect(payload).toEqual({ expectedVersion: 3, customerId, customerName: 'New name', customerPhone: '456', deliveryAddress: 'Street 12', deliveryFloor: '2', nameOnRinger: 'Bell', deliveryNotes: 'Note' });
  });
  // 06/10/2026 (Tomikro): a contact correction sent the linked customer's name
  // and phone without the id; the server refused to create a second customer
  // for that phone ("select it explicitly") and the queued edit held the Z.
  it('keeps the order linked to its customer and never sends a local or missing id', () => {
    expect(customerInfoEditUpdate({ ...original, destinationChanged: false, phone: '6955391363' }, original))
      .toMatchObject({ customerId, customerPhone: '6955391363' });
    expect(customerInfoEditUpdate({ ...original, destinationChanged: false }, { ...original, customerId: 'local-customer-1' }))
      .not.toHaveProperty('customerId');
    expect(customerInfoEditUpdate({ ...original, destinationChanged: false }, { ...original, customerId: null }))
      .not.toHaveProperty('customerId');
  });
  it('keeps the renderer local version independent from the known canonical revision', () => {
    const snapshot = orderCustomerEditSnapshot({ version: 1, remote_version: 5, customer_name: 'Person', delivery_address: 'Street 12' });
    expect(customerInfoEditUpdate({ ...snapshot, destinationChanged: false, delivery_floor: '2' }, snapshot))
      .toMatchObject({ expectedVersion: 5, expectedLocalVersion: 1 });
  });
  it('preserves each bulk target street instead of copying the first destination', () => {
    expect(customerInfoEditUpdate({ ...original, destinationChanged: false, delivery_floor: '2' }, { ...original, address: 'Other 50', city: 'Elsewhere', expectedVersion: 8 }))
      .toMatchObject({ expectedVersion: 8, deliveryAddress: 'Other 50', deliveryFloor: '2' });
  });
  it('treats a postal or city change as a destination change and permits explicit new location', () => {
    expect(isSameCustomerEditDestination({ ...original, postal_code: '54321' }, original)).toBe(false);
    expect(isSameCustomerEditDestination({ ...original, city: 'Other' }, original)).toBe(false);
    expect(customerInfoEditUpdate({ ...original, address: 'New 20', addressId: null, coordinates: point, destinationChanged: true }, original))
      .toMatchObject({ deliveryAddress: 'New 20', deliveryAddressId: null, deliveryLatitude: point.lat, deliveryLongitude: point.lng });
  });
  it('hydrates a nested order address without treating the object as address text', () => {
    expect(orderCustomerEditSnapshot({ customer_id: customerId, address: { street: 'Street 12', city: 'City', postal_code: '12345', coordinates: point } }))
      .toMatchObject({ address: 'Street 12', city: 'City', coordinates: point });
  });
  it('accepts only the exact linked customer address and rejects same-street different IDs or owners', () => {
    const order = { customer_id: customerId, delivery_address_id: addressId, delivery_address: original.address, delivery_city: original.city,
      delivery_postal_code: original.postal_code, customer: { id: customerId, addresses: [{ id: addressId, customer_id: customerId,
        street_address: original.address, city: original.city, postal_code: original.postal_code, coordinates: point }] } };
    expect(orderCustomerEditSnapshot(order).coordinates).toEqual(point);
    expect(orderCustomerEditSnapshot({ ...order, delivery_address_id: 'different' }).coordinates).toBeNull();
    expect(orderCustomerEditSnapshot({ ...order, customer: { ...order.customer, id: 'different' } }).coordinates).toBeNull();
    expect(orderCustomerEditSnapshot({ ...order, delivery_address: 'Other street' }).coordinates).toBeNull();
  });
  it('preserves an exact frozen legacy address point while dropping its noncanonical ID', () => {
    expect(orderCreateDeliveryLocation({ address: original.address, city: original.city, postal: original.postal_code },
      { id: `legacy:${customerId}`, street_address: original.address, city: original.city, postal_code: original.postal_code, coordinates: point,
        address_fingerprint: 'exact-fingerprint' }, { zone: { id: 'zone', name: 'Zone', estimatedTime: 15 } }))
      .toEqual({ delivery_address_id: null, delivery_latitude: point.lat, delivery_longitude: point.lng, delivery_address_fingerprint: 'exact-fingerprint', delivery_zone_id: 'zone', zone_name: 'Zone', estimated_delivery_time: 15 });
  });
  it('never borrows selected coordinates for another fallback street or special label', () => {
    const selected = { street: original.address, coordinates: point, id: addressId };
    expect(orderCreateDeliveryLocation({ address: 'Other 50', city: null, postal: null }, selected)).toEqual({});
    expect(orderCreateDeliveryLocation({ address: '#hotel', city: null, postal: null }, { ...selected, street: '#hotel' })).toEqual({});
  });
});
