import { describe, expect, it, vi } from 'vitest';
import { submitSatelliteHandover } from '../satellite-handover';

const input = { branchId: 'branch', terminalId: 'main', satelliteShiftId: 'shift', openingCash: 20, countedCash: 45, currency: 'CHF' };

describe('satellite handover native owner', () => {
  it('uses recomputed canonical amounts instead of stale preview and requires explicit durable application', async () => {
    const recordSatelliteHandover = vi.fn().mockResolvedValue({ success: true, applied: true, handover:{currency:'CHF',expected_cash_cents:5000,counted_cash_cents:4500,cash_variance_cents:-500} });
    expect(await submitSatelliteHandover({ recordSatelliteHandover }, input)).toEqual({status:'applied',currency:'CHF',expected:50,counted:45,variance:-5});
    expect(recordSatelliteHandover).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('keeps a saved pending intent pending instead of showing shift-close success', async () => {
    expect(await submitSatelliteHandover({ recordSatelliteHandover: async () => ({ data: { success: true, pending: true } }) }, input)).toEqual({status:'pending'});
  });

  it.each([{ success: true }, { success: true, applied: true }, { success: false, error: 'DRAWER_UNAVAILABLE' }])('does not accept an ambiguous or failed response %j', async response => {
    await expect(submitSatelliteHandover({ recordSatelliteHandover: async () => response }, input)).rejects.toThrow();
  });

  it('refuses unknown source units before dispatch', async () => {
    const recordSatelliteHandover = vi.fn();
    await expect(submitSatelliteHandover({ recordSatelliteHandover }, { ...input, currency: '' })).rejects.toThrow('SHIFT_CURRENCY_UNAVAILABLE');
    expect(recordSatelliteHandover).not.toHaveBeenCalled();
  });
});
