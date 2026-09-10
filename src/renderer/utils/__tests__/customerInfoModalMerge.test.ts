import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mergeCustomerInfoModalSave } from '../customerInfoModalMerge';
import type { CustomerInfo } from '../../types/customer';

const __dirname = dirname(fileURLToPath(import.meta.url));

const storedCustomer: CustomerInfo = {
  name: 'Maria Papas',
  phone: '6912345678',
  email: 'maria@example.com',
  address: {
    street: 'Ermou 12',
    street_address: 'Ermou 12',
    city: 'Athens',
    postalCode: '10563',
    postal_code: '10563',
    floor_number: '2',
    name_on_ringer: 'Papas',
    coordinates: { lat: 37.98, lng: 23.73 },
    latitude: 37.98,
    longitude: 23.73,
    notes: 'Ring twice',
  },
  notes: 'VIP customer',
};

describe('mergeCustomerInfoModalSave', () => {
  it('applies explicit city/postal/email/notes edits, including clearing optional fields', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name, phone: storedCustomer.phone,
      city: 'Piraeus', postalCode: '', email: '', notes: '',
    });
    expect(result.address).toMatchObject({ city: 'Piraeus', postalCode: '', postal_code: '' });
    expect(result.address?.coordinates).toBeUndefined();
    expect(result.email).toBe('');
    expect(result.notes).toBe('');
  });

  it('preserves street/city/postal/coordinates/notes/email on a floor-only edit', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: storedCustomer.address!.street,
      floor_number: '3',
      name_on_ringer: storedCustomer.address!.name_on_ringer,
      coordinates: storedCustomer.address!.coordinates,
    });

    expect(result.address).toMatchObject({
      street: 'Ermou 12',
      city: 'Athens',
      postalCode: '10563',
      postal_code: '10563',
      floor_number: '3',
      name_on_ringer: 'Papas',
      coordinates: { lat: 37.98, lng: 23.73 },
      latitude: 37.98,
      longitude: 23.73,
      notes: 'Ring twice',
    });
    expect(result.email).toBe('maria@example.com');
    expect(result.notes).toBe('VIP customer');
  });

  it('preserves street/city/postal/coordinates/notes/email on a ringer-only edit', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: storedCustomer.address!.street,
      floor_number: storedCustomer.address!.floor_number,
      name_on_ringer: 'Doorbell: Papas Family',
      coordinates: storedCustomer.address!.coordinates,
    });

    expect(result.address).toMatchObject({
      street: 'Ermou 12',
      city: 'Athens',
      postalCode: '10563',
      name_on_ringer: 'Doorbell: Papas Family',
      coordinates: { lat: 37.98, lng: 23.73 },
    });
  });

  it('is a no-op on an unchanged save (cancel/reopen equivalent)', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: storedCustomer.address!.street,
      floor_number: storedCustomer.address!.floor_number,
      name_on_ringer: storedCustomer.address!.name_on_ringer,
      coordinates: storedCustomer.address!.coordinates,
    });

    expect(result).toEqual(storedCustomer);
  });

  it('applies an intentional floor clear without reviving the old value', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: storedCustomer.address!.street,
      floor_number: '',
      name_on_ringer: storedCustomer.address!.name_on_ringer,
      coordinates: storedCustomer.address!.coordinates,
    });

    expect(result.address?.floor_number).toBe('');
    expect(result.address?.city).toBe('Athens');
  });

  it('invalidates stale coordinates when the street actually changes without fresh validation', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: 'Patission 55',
      floor_number: storedCustomer.address!.floor_number,
      name_on_ringer: storedCustomer.address!.name_on_ringer,
      coordinates: undefined,
    });

    expect(result.address?.street).toBe('Patission 55');
    expect(result.address?.coordinates).toBeUndefined();
    expect(result.address?.latitude).toBeUndefined();
    expect(result.address?.longitude).toBeUndefined();
    // City/postal are not editable in this modal and stay bound to the
    // account, but they are not silently used to mask an unresolved move.
    expect(result.address?.city).toBe('Athens');
  });

  it('keeps freshly validated coordinates for the new address when supplied', () => {
    const result = mergeCustomerInfoModalSave(storedCustomer, {
      name: storedCustomer.name,
      phone: storedCustomer.phone,
      address: 'Patission 55',
      floor_number: storedCustomer.address!.floor_number,
      name_on_ringer: storedCustomer.address!.name_on_ringer,
      coordinates: { lat: 37.99, lng: 23.72 },
    });

    expect(result.address?.coordinates).toEqual({ lat: 37.99, lng: 23.72 });
    expect(result.address?.latitude).toBe(37.99);
    expect(result.address?.longitude).toBe(23.72);
    // Must not reuse the previous address's coordinates for a different address.
    expect(result.address?.coordinates).not.toEqual(storedCustomer.address!.coordinates);
  });

  it('starts from an empty previous customer without throwing and without inventing values', () => {
    const result = mergeCustomerInfoModalSave(null, {
      name: 'New Customer',
      phone: '6900000000',
      address: 'Neo Str 1',
      floor_number: '1',
      name_on_ringer: 'New',
      coordinates: { lat: 1, lng: 2 },
    });

    expect(result.address?.city).toBe('');
    expect(result.address?.postalCode).toBe('');
    expect(result.email).toBeUndefined();
    expect(result.notes).toBe('');
  });
});

describe('customer info modal save wiring (source assertions)', () => {
  const readSource = (relativePath: string) =>
    readFileSync(resolve(__dirname, relativePath), 'utf8');

  it('OrderDashboard.tsx routes the new-order-flow save handler through the merge helper', () => {
    const source = readSource('../../components/OrderDashboard.tsx');
    expect(source).toContain("import { mergeCustomerInfoModalSave } from \"../utils/customerInfoModalMerge\";");
    expect(source).toContain('const customerInfoData = mergeCustomerInfoModalSave(customerInfo, info);');
    // Guard against regressing back to the hardcoded-blank pattern this bug fix removed.
    expect(source).not.toMatch(/city:\s*"",\s*\/\/ info\.address is single string/);
  });

  it('NewOrderPage.tsx routes its customer info save handler through the merge helper', () => {
    const source = readSource('../../pages/NewOrderPage.tsx');
    expect(source).toContain("import { mergeCustomerInfoModalSave } from '../utils/customerInfoModalMerge';");
    expect(source).toContain('setCustomerInfo((prev) => mergeCustomerInfoModalSave(prev, info));');
    expect(source).not.toMatch(/city:\s*'',\s*\/\/ info\.address is single string/);
  });
});
