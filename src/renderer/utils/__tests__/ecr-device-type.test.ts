import { describe, expect, it, vi } from 'vitest';
import {
  ecrAdmissionErrorMessage,
  ecrDeviceSettingsSection,
  ecrDeviceTypeMismatch,
  ecrDeviceUpdatePatch,
  ecrSaveNeedsAdmission,
  hasFiscalCashRegisterIdentity,
  isEcrDeviceAdmitted,
  isEcrTypeAdmitted,
  loadEcrDeviceAdmission,
  parseEcrDeviceAdmission,
  resolveEcrDeviceType,
  storedEcrDeviceType,
} from '../ecr-device-type';

// Founder rule 08/10/2026. Incident: a fiscal register "Rbs Elio CR" was saved
// as an enabled `payment_terminal` and refused manual card / manual returns.
const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as any;

const admission = (card: boolean, cash: boolean) => ({
  success: true,
  cardTerminal: { admitted: card, fetchedAt: '2026-10-08T09:00:00Z' },
  cashRegister: { admitted: cash, fetchedAt: '2026-10-08T09:00:00Z', mode: 'fiscal_device', status: cash ? 'connected' : 'pending' },
});

describe('ECR device type resolution', () => {
  it('maps an RBS or ELIO brand, manufacturer, model or name to a cash register, over a stored card type', () => {
    expect(resolveEcrDeviceType({ name: 'Rbs Elio CR', deviceType: 'payment_terminal' })).toBe('cash_register');
    expect(resolveEcrDeviceType({ name: 'Front', brand: 'RBS', deviceType: 'payment_terminal' })).toBe('cash_register');
    expect(resolveEcrDeviceType({ name: 'COM4', manufacturer: 'rbs' })).toBe('cash_register');
    expect(resolveEcrDeviceType({ name: 'Counter', model: 'ELIO_CR' })).toBe('cash_register');
    expect(resolveEcrDeviceType({ name: 'elio-cr' })).toBe('cash_register');
  });

  it('matches whole words only', () => {
    for (const name of ['Herbs bar', 'Helios terminal', 'Rbsx', 'Elion']) {
      expect(hasFiscalCashRegisterIdentity({ name })).toBe(false);
    }
    expect(resolveEcrDeviceType({ name: 'Helios terminal', deviceType: 'payment_terminal' })).toBe('payment_terminal');
  });

  it('keeps an explicit stored type otherwise', () => {
    expect(resolveEcrDeviceType({ name: 'Counter', device_type: 'payment_terminal', brand: 'generic' })).toBe('payment_terminal');
    expect(resolveEcrDeviceType({ name: 'Register', deviceType: 'CASH_REGISTER' })).toBe('cash_register');
    expect(storedEcrDeviceType({ deviceType: 'printer' })).toBeNull();
  });

  it('treats fiscal-only fields as cash register evidence and never defaults the rest', () => {
    expect(resolveEcrDeviceType({ name: 'X', printMode: 'register_prints' })).toBe('cash_register');
    expect(resolveEcrDeviceType({ name: 'X', tax_rates: [{ code: 'A' }] })).toBe('cash_register');
    // A brand alone (native stores 'generic' for every card terminal) is not evidence.
    expect(resolveEcrDeviceType({ name: 'X', brand: 'generic' })).toBeNull();
    expect(resolveEcrDeviceType({ name: 'X', taxRates: [], printMode: '' })).toBeNull();
    expect(resolveEcrDeviceType(null)).toBeNull();
  });

  it('lists every stored device exactly once, by its stored type', () => {
    const incident = { id: 'ecr-1', name: 'Rbs Elio CR', deviceType: 'payment_terminal', enabled: true };
    expect(ecrDeviceSettingsSection(incident)).toBe('payment_terminal');
    expect(ecrDeviceTypeMismatch(incident)).toBe(true);
    expect(ecrDeviceSettingsSection({ name: 'Elio' })).toBe('cash_register');
    expect(ecrDeviceSettingsSection({ name: 'Unknown' })).toBe('payment_terminal');
    expect(ecrDeviceTypeMismatch({ name: 'Counter', deviceType: 'payment_terminal' })).toBe(false);
  });
});

describe('ECR device admission', () => {
  it('parses only a well-formed native answer', () => {
    expect(parseEcrDeviceAdmission(admission(true, false))).toEqual({
      cardTerminal: { admitted: true, fetchedAt: '2026-10-08T09:00:00Z' },
      cashRegister: { admitted: false, fetchedAt: '2026-10-08T09:00:00Z', mode: 'fiscal_device', status: 'pending' },
    });
    expect(parseEcrDeviceAdmission({ ...admission(true, true), success: false })).toBeNull();
    expect(parseEcrDeviceAdmission({ success: true, cardTerminal: { admitted: 'true' }, cashRegister: { admitted: true } })).toBeNull();
    expect(parseEcrDeviceAdmission(undefined)).toBeNull();
  });

  it('refreshes first and falls back to the last known answer; unreadable admits nothing', async () => {
    const getDeviceAdmission = vi.fn()
      .mockRejectedValueOnce(new Error('ipc failed'))
      .mockResolvedValueOnce(admission(false, true));
    expect(await loadEcrDeviceAdmission({ getDeviceAdmission })).toMatchObject({ cashRegister: { admitted: true } });
    expect(getDeviceAdmission.mock.calls).toEqual([[{ refresh: true }], []]);

    const failing = vi.fn().mockRejectedValue(new Error('down'));
    expect(await loadEcrDeviceAdmission({ getDeviceAdmission: failing })).toBeNull();
    expect(await loadEcrDeviceAdmission({})).toBeNull();
    expect(isEcrTypeAdmitted(null, 'payment_terminal')).toBe(false);
    expect(isEcrTypeAdmitted(parseEcrDeviceAdmission(admission(true, false)), null)).toBe(false);
  });

  it('admits a stored device by its stored type, else by native flag', () => {
    const loaded = parseEcrDeviceAdmission(admission(false, true));
    const incident = { name: 'Rbs Elio CR', deviceType: 'payment_terminal', admitted: true };
    // The stored card type decides, not the RBS identity: no payment plugin, so not admitted.
    expect(isEcrDeviceAdmitted(incident, loaded)).toBe(false);
    expect(isEcrDeviceAdmitted({ deviceType: 'cash_register' }, loaded)).toBe(true);
    expect(isEcrDeviceAdmitted({ deviceType: 'payment_terminal', admitted: true }, null)).toBe(true);
    expect(isEcrDeviceAdmitted({ deviceType: 'payment_terminal' }, null)).toBe(false);
  });

  it('needs admission only to add enabled, enable, or retype an enabled device', () => {
    expect(ecrSaveNeedsAdmission({ enabled: true, deviceType: 'payment_terminal' })).toBe(true);
    expect(ecrSaveNeedsAdmission({ enabled: false, deviceType: 'payment_terminal' })).toBe(false);
    expect(ecrSaveNeedsAdmission({ enabled: true, deviceType: 'cash_register' }, { enabled: false, deviceType: 'cash_register' })).toBe(true);
    expect(ecrSaveNeedsAdmission({ enabled: true, deviceType: 'cash_register' }, { enabled: true, deviceType: 'payment_terminal' })).toBe(true);
    // Renaming or editing an enabled device, or disabling it, stays possible.
    expect(ecrSaveNeedsAdmission({ enabled: true, deviceType: 'payment_terminal' }, { enabled: true, deviceType: 'payment_terminal' })).toBe(false);
    expect(ecrSaveNeedsAdmission({ enabled: false, deviceType: 'cash_register' }, { enabled: true, deviceType: 'payment_terminal' })).toBe(false);
  });

  it('leaves an unchanged enabled flag and device type out of an edit, so native never refuses a rename', () => {
    const next = { name: 'Renamed', deviceType: 'payment_terminal', enabled: true, protocol: 'zvt' };
    expect(ecrDeviceUpdatePatch(next, { enabled: true, deviceType: 'payment_terminal' })).toEqual({ name: 'Renamed', protocol: 'zvt' });
    expect(ecrDeviceUpdatePatch(next, { enabled: false, deviceType: 'payment_terminal' })).toEqual({ name: 'Renamed', enabled: true, protocol: 'zvt' });
    expect(ecrDeviceUpdatePatch(next, { enabled: true, deviceType: 'cash_register' })).toEqual({ name: 'Renamed', deviceType: 'payment_terminal', protocol: 'zvt' });
    // A device without a stored type gets the explicit choice sent.
    expect(ecrDeviceUpdatePatch(next, { enabled: true, deviceType: null })).toEqual({ name: 'Renamed', deviceType: 'payment_terminal', protocol: 'zvt' });
  });

  it('maps native admission refusal codes to the localized texts', () => {
    expect(ecrAdmissionErrorMessage(t, { success: false, code: 'DEVICE_NOT_ADMITTED', deviceType: 'payment_terminal', error: 'x' }))
      .toMatch(/needs an active, configured payment plugin/);
    expect(ecrAdmissionErrorMessage(t, { success: false, code: 'DEVICE_NOT_ADMITTED', error: 'x' }, 'cash_register'))
      .toMatch(/MyData plugin in fiscal device mode/);
    expect(ecrAdmissionErrorMessage(t, { success: false, code: 'DEVICE_NOT_ADMITTED' }))
      .toMatch(/until its plugin is active, configured and finished/);
    expect(ecrAdmissionErrorMessage(t, { success: false, code: 'DEVICE_TYPE_REQUIRED', error: 'x' }))
      .toMatch(/Choose the device type/);
    expect(ecrAdmissionErrorMessage(t, { success: false, error: 'Device not found' })).toBeNull();
    expect(ecrAdmissionErrorMessage(t, { success: true, device: {} })).toBeNull();
  });
});
