import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShiftFinancialOpeningView } from '../../../lib/ipc-contracts';

const bridge = vi.hoisted(() => ({
  shiftFinancialOpening: {
    begin: vi.fn(), authorize: vi.fn(), status: vi.fn(), clearAuthorization: vi.fn(),
  },
}));
vi.mock('../../../lib', () => ({ getBridge: () => bridge }));

import { financialOpening, FinancialOpeningInvalidatedError, isFinancialOpeningAuthorizedFor } from '../financial-opening';

const scope = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'pos-public-1', staffId: 'staff-1' };
const original: ShiftFinancialOpeningView = {
  ...scope, openingKey: 'key-1', shiftId: 'shift-1', drawerId: 'drawer-1', openingCents: 1000,
  currency: 'USD', businessDate: '2026-09-29', checkedInAt: '2026-09-29T08:00:00.000Z', isDayStart: true,
  calculationVersion: 2, state: 'confirmed_usable', usable: true,
  hostedAuthorization: { state: 'authorized', expiresAt: null }, lastPendingCode: null, drawer: null,
};

describe('financial opening renderer authority revocation', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    bridge.shiftFinancialOpening.clearAuthorization.mockResolvedValue({ success: true });
    await financialOpening.clearAuthorization();
  });
  afterEach(async () => { await financialOpening.clearAuthorization(); });

  it('explicit modal clear refuses an already issued status reply after native clearing settled', async () => {
    let deliver!: (value: unknown) => void;
    bridge.shiftFinancialOpening.status.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const oldReply = financialOpening.status(original.openingKey);
    const rejected = expect(oldReply).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    await financialOpening.clearAuthorization();
    deliver({ success: true, openings: [original] });
    await rejected;
    expect(isFinancialOpeningAuthorizedFor(scope)).toBe(false);
  });

  it.each([null, {}])('keeps issuance blocked when native clearing has no success acknowledgement: %j', async reply => {
    bridge.shiftFinancialOpening.clearAuthorization.mockResolvedValueOnce(reply);
    await financialOpening.clearAuthorization();
    await expect(financialOpening.status(original.openingKey)).rejects.toBeInstanceOf(FinancialOpeningInvalidatedError);
    expect(bridge.shiftFinancialOpening.status).not.toHaveBeenCalled();
    await financialOpening.clearAuthorization();
    bridge.shiftFinancialOpening.status.mockResolvedValueOnce({ success: true, openings: [original] });
    await expect(financialOpening.status(original.openingKey)).resolves.toMatchObject({ success: true });
  });

  it.each([
    { state: 'confirmed_unusable', usable: false, hostedAuthorization: { state: 'required', expiresAt: null } },
    { state: 'confirmed_usable', usable: true, hostedAuthorization: { state: 'required', expiresAt: null } },
  ] satisfies Partial<ShiftFinancialOpeningView>[])('revokes the earlier observation when the same original is no longer usable and authorized: %j', async patch => {
    bridge.shiftFinancialOpening.status.mockResolvedValueOnce({ success: true, openings: [original] });
    await financialOpening.status(original.openingKey);
    expect(isFinancialOpeningAuthorizedFor(scope)).toBe(true);
    bridge.shiftFinancialOpening.status.mockResolvedValueOnce({ success: true, openings: [{ ...original, ...patch }] });
    await financialOpening.status(original.openingKey);
    expect(isFinancialOpeningAuthorizedFor(scope)).toBe(false);
  });

  it('a current full status with no usable originals revokes the earlier observation', async () => {
    bridge.shiftFinancialOpening.status.mockResolvedValueOnce({ success: true, openings: [original] });
    await financialOpening.status();
    expect(isFinancialOpeningAuthorizedFor(scope)).toBe(true);
    bridge.shiftFinancialOpening.status.mockResolvedValueOnce({ success: true, openings: [] });
    await financialOpening.status();
    expect(isFinancialOpeningAuthorizedFor(scope)).toBe(false);
  });
});
