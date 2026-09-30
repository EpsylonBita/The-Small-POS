import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import i18next, { type TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import en from '../../../locales/en.json';
import el from '../../../locales/el.json';
import {
  CustomerAddressWriteRefusedError,
  customerAddressWriteErrorText,
  describeCustomerAddressWriteRefusal,
  expectCustomerAddressWrite,
  readCustomerAddressWrite,
} from '../customer-address-write-refusal';

// Desktop 1.4.119 (rel-desktop-rust): the native address commands answer a
// refused write with Ok({success:false, code, status, error, conflict?}),
// where `error` is the bare machine code. Before this helper, the address
// surfaces outside AddCustomerModal showed that code raw («Failed to add new
// address: INVALID_COORDINATES») or a generic «try again» that fails the
// same way every time.

let t: TFunction;
let tEl: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, el: { translation: el } },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT('en');
  tEl = instance.getFixedT('el');
});

const refusal = (code: string | null, status: number | null = 400, conflict = false) => ({
  success: false,
  code,
  errorCode: code,
  status,
  error: code,
  ...(conflict ? { conflict: true } : {}),
});

const FALLBACK = 'modals.addCustomer.addressSaveFailed';

describe('describeCustomerAddressWriteRefusal', () => {
  it.each([
    ['INVALID_COORDINATES', 400, 'update', en.modals.addCustomer.addressLocationRejected],
    ['NOT_FOUND', 404, 'update', en.modals.addCustomer.addressNotFound],
    ['NOT_FOUND', 404, 'delete', en.modals.addCustomer.addressNotFound],
    // An add is routed through the customer: a 404 there means the customer is gone.
    ['NOT_FOUND', 404, 'add', en.modals.addCustomer.customerNotFound],
    ['CUSTOMER_NOT_SYNCED', null, 'add', en.modals.addCustomer.customerNotSynced],
    ['CUSTOMER_SYNC_IN_PROGRESS', null, 'update', en.modals.addCustomer.customerSyncInProgress],
    ['VERSION_REQUIRED', null, 'update', en.modals.addCustomer.versionRequired],
  ] as const)('%s (%s) on %s names the refusal', (code, status, kind, text) => {
    const result = readCustomerAddressWrite(refusal(code, status));
    expect(describeCustomerAddressWriteRefusal(t, result, kind, FALLBACK)).toBe(text);
  });

  it('a version conflict shows the conflict message', () => {
    const result = readCustomerAddressWrite(refusal('VERSION_MISMATCH', 409, true));
    expect(describeCustomerAddressWriteRefusal(t, result, 'update', FALLBACK)).toBe(en.modals.addCustomer.conflictError);
  });

  it('an HTTP_4xx from the office is named inside the office sentence, never alone', () => {
    const result = readCustomerAddressWrite(refusal('HTTP_422', 422));
    expect(describeCustomerAddressWriteRefusal(t, result, 'update', FALLBACK)).toBe(
      'The office did not accept the change (code HTTP_422). Check the details and try again.',
    );
  });

  it('an unknown code refused by this register (no status) is not worded as the office', () => {
    const result = readCustomerAddressWrite(refusal('LOCAL_CACHE_UNAVAILABLE', null));
    const text = describeCustomerAddressWriteRefusal(t, result, 'add', FALLBACK);
    expect(text).toBe('This register could not save the change (code LOCAL_CACHE_UNAVAILABLE). Try again; if it happens again, contact support.');
    expect(text).not.toContain('office');
  });

  it('a refusal without a code, or an empty answer, gets the caller’s generic message', () => {
    expect(describeCustomerAddressWriteRefusal(t, readCustomerAddressWrite({ success: false, error: 'Customer/address not found' }), 'update', FALLBACK))
      .toBe(en.modals.addCustomer.addressSaveFailed);
    expect(describeCustomerAddressWriteRefusal(t, readCustomerAddressWrite(null), 'delete', 'users.deleteAddressError'))
      .toBe(en.users.deleteAddressError);
  });

  it('speaks the cashier’s language', () => {
    const result = readCustomerAddressWrite(refusal('INVALID_COORDINATES'));
    expect(describeCustomerAddressWriteRefusal(tEl, result, 'update', FALLBACK)).toBe(el.modals.addCustomer.addressLocationRejected);
  });
});

describe('readCustomerAddressWrite / expectCustomerAddressWrite', () => {
  it('a write the office saved is a success', () => {
    const result = expectCustomerAddressWrite(t, { success: true, data: { id: 'addr-1' } }, 'add', FALLBACK);
    expect(result).toMatchObject({ success: true, queued: false, data: { id: 'addr-1' } });
  });

  it('a write queued on this register (CUSTOMER_ADDRESS_SAVED_OFFLINE) is a queued success', () => {
    expect(readCustomerAddressWrite({ success: true, warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE', data: { id: 'addr-1' } }))
      .toMatchObject({ success: true, queued: true, offline: true });
    expect(readCustomerAddressWrite({ success: true, queued: true, offline: true, warning: 'CUSTOMER_ADDRESS_SAVED_OFFLINE' }))
      .toMatchObject({ success: true, queued: true });
  });

  it('a refusal throws with the operator text, never the raw code', () => {
    let thrown: unknown;
    try {
      expectCustomerAddressWrite(t, refusal('INVALID_COORDINATES'), 'update', FALLBACK);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CustomerAddressWriteRefusedError);
    expect((thrown as Error).message).toBe(en.modals.addCustomer.addressLocationRejected);
    expect((thrown as CustomerAddressWriteRefusedError).refusal).toMatchObject({ code: 'INVALID_COORDINATES', status: 400 });
  });

  it('an unexpected native error shows the generic message, not its raw text', () => {
    expect(customerAddressWriteErrorText(t, new Error('Missing address street'), FALLBACK)).toBe(en.modals.addCustomer.addressSaveFailed);
  });
});

describe('locale coverage', () => {
  const localesDir = path.resolve(__dirname, '../../../locales');
  const keys = [
    'modals.addCustomer.conflictError',
    'modals.addCustomer.addressLocationRejected',
    'modals.addCustomer.addressNotFound',
    'modals.addCustomer.customerNotFound',
    'modals.addCustomer.versionRequired',
    'modals.addCustomer.customerSyncInProgress',
    'modals.addCustomer.customerNotSynced',
    'modals.addCustomer.saveRejected',
    'modals.addCustomer.saveRefusedLocally',
    'modals.addCustomer.addressSaveFailed',
    'modals.editAddress.updateError',
    'modals.customerSearch.deleteAddressFailed',
    'users.updateAddressError',
    'users.deleteAddressError',
    // A write queued on this register (CUSTOMER_ADDRESS_SAVED_OFFLINE).
    'users.savedLocallyQueued',
    'users.deleteAddressQueued',
    'modals.customerSearch.deleteAddressQueued',
  ];

  it('every message the address surfaces can show exists in all six locales', () => {
    const files = readdirSync(localesDir).filter((file) => file.endsWith('.json')).sort();
    expect(files).toEqual(['de.json', 'el.json', 'en.json', 'fr.json', 'it.json', 'sq.json']);
    for (const file of files) {
      const locale = JSON.parse(readFileSync(path.join(localesDir, file), 'utf8'));
      const missing = keys.filter((key) => {
        const value = key.split('.').reduce<any>((node, part) => node?.[part], locale);
        return typeof value !== 'string' || !value.trim();
      });
      expect(missing, `${file} misses address refusal messages`).toEqual([]);
    }
  });
});
