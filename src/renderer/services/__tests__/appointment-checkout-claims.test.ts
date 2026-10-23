import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  identity: { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'till-1' },
}));
vi.mock('../../utils/api-helpers', () => ({ posApiFetch: mocks.fetch }));
vi.mock('../terminal-credentials', () => ({ getResolvedTerminalIdentity: vi.fn(async () => ({ ...mocks.identity })) }));

import {
  claimAllowsCheckout,
  appointmentIdsOfLines,
  claimAppointmentCheckout,
  clearStoredAppointmentClaims,
  confirmAppointmentClaimsBeforePayment,
  forgetClaim,
  readStoredClaim,
  releaseAppointmentCheckout,
  rememberClaim,
  resetClaimMemoryForTests,
} from '../appointment-checkout-claims';

const ID = '20000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-21T07:00:00Z');
const later = (ms: number) => new Date(NOW + ms).toISOString();
const IDENTITY_A = { organizationId: 'org-1', branchId: 'branch-1', terminalId: 'till-1' };
const claimKeys = () => Object.keys(localStorage).filter(key => key.startsWith('pos.appointmentCheckoutClaims'));

beforeEach(() => {
  localStorage.clear();
  mocks.identity = { ...IDENTITY_A };
  resetClaimMemoryForTests();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('claim store (memory plus durable local storage)', () => {
  it('keeps a claim across a restart and drops it once its lease ran out', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'c1', leaseExpiresAt: later(60_000) });
    resetClaimMemoryForTests(); // a new renderer session reads local storage
    expect(await readStoredClaim(ID, NOW)).toEqual({ appointmentId: ID, claimId: 'c1', leaseExpiresAt: later(60_000) });
    expect(await readStoredClaim(ID, NOW + 60_000)).toBeNull();
    resetClaimMemoryForTests();
    expect(await readStoredClaim(ID, NOW)).toBeNull();
  });

  it('forgets a claim in memory and in storage', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'c1', leaseExpiresAt: later(60_000) });
    await forgetClaim(ID);
    resetClaimMemoryForTests();
    expect(await readStoredClaim(ID, NOW)).toBeNull();
    expect(claimKeys()).toEqual([]);
  });

  it('still works in memory when local storage throws, and ignores unreadable stored data', async () => {
    localStorage.setItem(`pos.appointmentCheckoutClaims.v2:${JSON.stringify(['org-1', 'branch-1', 'till-1'])}`, '{not json');
    expect(await readStoredClaim(ID, NOW)).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    resetClaimMemoryForTests();
    await rememberClaim({ appointmentId: ID, claimId: 'c2', leaseExpiresAt: later(60_000) });
    expect((await readStoredClaim(ID, NOW))?.claimId).toBe('c2');
  });
});

// Codex review of PR #379 (22/10/2026): a lease belongs to the organization,
// branch and terminal that took it, as on Android.
describe('claim scope (the till identity)', () => {
  it('never shows another terminal, branch or organization a stored lease', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'old-pairing', leaseExpiresAt: later(60_000) });
    for (const other of [
      { ...IDENTITY_A, terminalId: 'till-2' },
      { ...IDENTITY_A, branchId: 'branch-2' },
      { ...IDENTITY_A, organizationId: 'org-2' },
    ]) {
      mocks.identity = other;
      resetClaimMemoryForTests();
      expect(await readStoredClaim(ID, NOW)).toBeNull();
      mocks.fetch.mockRejectedValueOnce(new Error('offline'));
      expect((await claimAppointmentCheckout(ID, { renew: true, now: () => NOW })).kind).toBe('needs_connection');
    }
    // Back on the identity that took it, the lease is still this till's.
    mocks.identity = { ...IDENTITY_A };
    expect((await readStoredClaim(ID, NOW))?.claimId).toBe('old-pairing');
  });

  it('a re-pairing in the same session switches the leases without a restart', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'a', leaseExpiresAt: later(60_000) });
    mocks.identity = { ...IDENTITY_A, terminalId: 'till-2' };
    expect(await readStoredClaim(ID, NOW)).toBeNull();
  });

  it('reuses no lease while the identity is incomplete', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'a', leaseExpiresAt: later(60_000) });
    mocks.identity = { ...IDENTITY_A, terminalId: '' };
    expect(await readStoredClaim(ID, NOW)).toBeNull();
    mocks.fetch.mockResolvedValueOnce({ success: false });
    expect((await claimAppointmentCheckout(ID, { renew: true, now: () => NOW })).kind).toBe('needs_connection');
  });

  it('drops the unscoped leases of earlier versions', async () => {
    localStorage.setItem('pos.appointmentCheckoutClaims.v1', JSON.stringify({ [ID]: { appointmentId: ID, claimId: 'v1', leaseExpiresAt: later(60_000) } }));
    expect(await readStoredClaim(ID, NOW)).toBeNull();
    expect(localStorage.getItem('pos.appointmentCheckoutClaims.v1')).toBeNull();
  });

  it('does not keep a claim the office granted to the identity the till had before a re-pairing', async () => {
    mocks.fetch.mockImplementationOnce(async () => {
      mocks.identity = { ...IDENTITY_A, organizationId: 'org-2' };
      return { success: true, status: 200, data: { success: true, claim: { claim_id: 'late', lease_expires_at: '2999-01-01T00:00:00.000Z' } } };
    });
    expect(await claimAppointmentCheckout(ID)).toEqual({ kind: 'failed', error: null });
    expect(await readStoredClaim(ID, NOW)).toBeNull();
    mocks.identity = { ...IDENTITY_A };
    expect(await readStoredClaim(ID, NOW)).toBeNull();
  });

  it('a terminal reset clears every stored lease of every identity', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'a', leaseExpiresAt: later(60_000) });
    mocks.identity = { ...IDENTITY_A, terminalId: 'till-2' };
    await rememberClaim({ appointmentId: ID, claimId: 'b', leaseExpiresAt: later(60_000) });
    localStorage.setItem('pos.appointmentCheckoutClaims.v1', '{}');
    expect(claimKeys()).toHaveLength(3);
    clearStoredAppointmentClaims();
    expect(claimKeys()).toEqual([]);
    expect(await readStoredClaim(ID, NOW)).toBeNull();
  });
});

describe('claim outcomes', () => {
  const lease = '2999-01-01T00:00:00.000Z';

  it('remembers the office claim, and renews with the claim id it holds', async () => {
    mocks.fetch.mockResolvedValue({ success: true, status: 200, data: { success: true, claim: { claim_id: 'server-c', lease_expires_at: lease } } });
    const first = await claimAppointmentCheckout(ID);
    expect(first).toEqual({ kind: 'claimed', claim: { appointmentId: ID, claimId: 'server-c', leaseExpiresAt: lease } });
    const sent = JSON.parse(mocks.fetch.mock.calls[0][1].body).claim_id;
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    await claimAppointmentCheckout(ID, { renew: true });
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).claim_id).toBe('server-c');
    // A new checkout always asks with a fresh id.
    await claimAppointmentCheckout(ID);
    expect(JSON.parse(mocks.fetch.mock.calls[2][1].body).claim_id).not.toBe('server-c');
  });

  it('reads the holder from the browser body or from the native error text', async () => {
    const claim = { terminal_id: 'till-2', terminal_name: null, lease_expires_at: lease };
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_CHECKOUT_CLAIMED', error: 'x', errorBody: { claim } });
    expect(await claimAppointmentCheckout(ID)).toEqual({ kind: 'claimed_elsewhere', terminal: 'till-2', leaseExpiresAt: lease });
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_CHECKOUT_CLAIMED',
      error: `Busy (HTTP 409): ${JSON.stringify({ code: 'APPOINTMENT_CHECKOUT_CLAIMED', claim: { ...claim, terminal_name: 'Desk' } })}` });
    expect(await claimAppointmentCheckout(ID)).toEqual({ kind: 'claimed_elsewhere', terminal: 'Desk', leaseExpiresAt: lease });
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_CHECKOUT_CLAIMED', error: 'Busy' });
    expect(await claimAppointmentCheckout(ID)).toEqual({ kind: 'claimed_elsewhere', terminal: null, leaseExpiresAt: null });
  });

  it.each([
    [{ success: false, status: 409, code: 'APPOINTMENT_ALREADY_SETTLED' }, 'settled', false],
    [{ success: false, status: 404, code: 'APPOINTMENT_NOT_FOUND' }, 'not_found', false],
    [{ success: false, status: 404 }, 'legacy', true],
    [{ success: false, status: 403, error: 'MODULE_REQUIRED' }, 'failed', false],
    [{ success: false }, 'needs_connection', false],
    [{ success: false, status: 503 }, 'needs_connection', false],
  ])('classifies %j as %s', async (answer, kind, opens) => {
    mocks.fetch.mockResolvedValueOnce(answer);
    const outcome = await claimAppointmentCheckout(ID);
    expect(outcome.kind).toBe(kind);
    expect(claimAllowsCheckout(outcome)).toBe(opens);
  });

  it('continues offline only with an unexpired claim this till holds; a settled answer drops it', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'held', leaseExpiresAt: later(60_000) });
    mocks.fetch.mockResolvedValueOnce({ success: false });
    expect(await claimAppointmentCheckout(ID, { now: () => NOW })).toEqual({
      kind: 'offline', claim: { appointmentId: ID, claimId: 'held', leaseExpiresAt: later(60_000) } });
    mocks.fetch.mockRejectedValueOnce(new Error('ipc down'));
    expect((await claimAppointmentCheckout(ID, { now: () => NOW + 60_000 })).kind).toBe('needs_connection');
    await rememberClaim({ appointmentId: ID, claimId: 'held', leaseExpiresAt: later(60_000) });
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_ALREADY_SETTLED' });
    await claimAppointmentCheckout(ID, { now: () => NOW });
    expect(await readStoredClaim(ID, NOW)).toBeNull();
  });

  it('releases its own claim by id and forgets it even when the office cannot be reached', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'held', leaseExpiresAt: '2999-01-01T00:00:00.000Z' });
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await releaseAppointmentCheckout(ID);
    expect(mocks.fetch).toHaveBeenCalledWith(`/api/pos/appointments/${ID}/checkout-claim?claim_id=held`, { method: 'DELETE' });
    expect(await readStoredClaim(ID)).toBeNull();
    mocks.fetch.mockClear();
    await releaseAppointmentCheckout(ID);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

// Codex review of PR #379: the cart renews its appointments' claims right
// before money moves; every outcome that does not allow the checkout stops it.
describe('claims renewed right before payment', () => {
  const lease = '2999-01-01T00:00:00.000Z';
  const OTHER = '20000000-0000-4000-8000-000000000002';

  it('names each settled appointment once, from either spelling', () => {
    expect(appointmentIdsOfLines([{ appointment_id: ID }, { appointmentId: ID }, { appointment_id: OTHER }, { name: 'Shampoo' }, null]))
      .toEqual([ID, OTHER]);
  });

  it('goes on when every claim is renewed, and asks nothing for a cart without appointments', async () => {
    mocks.fetch.mockResolvedValue({ success: true, status: 200, data: { success: true, claim: { claim_id: 'c', lease_expires_at: lease } } });
    expect(await confirmAppointmentClaimsBeforePayment([{ appointment_id: ID }, { appointment_id: OTHER }])).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    mocks.fetch.mockClear();
    expect(await confirmAppointmentClaimsBeforePayment([{ name: 'Shampoo' }])).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['another till took it', { success: false, status: 409, code: 'APPOINTMENT_CHECKOUT_CLAIMED', error: 'x' }, 'claimed_elsewhere'],
    ['it was settled elsewhere', { success: false, status: 409, code: 'APPOINTMENT_ALREADY_SETTLED' }, 'settled'],
    ['no connection after the lease ran out', { success: false }, 'needs_connection'],
    ['any other refusal', { success: false, status: 403, error: 'MODULE_REQUIRED' }, 'failed'],
  ])('stops the payment when %s', async (_name, answer, kind) => {
    await rememberClaim({ appointmentId: ID, claimId: 'held', leaseExpiresAt: later(-1_000) });
    mocks.fetch.mockResolvedValueOnce(answer);
    const refusal = await confirmAppointmentClaimsBeforePayment([{ appointment_id: ID }]);
    expect(refusal).toMatchObject({ appointmentId: ID, outcome: { kind } });
  });

  it('goes on offline only while this till holds an unexpired claim', async () => {
    await rememberClaim({ appointmentId: ID, claimId: 'held', leaseExpiresAt: '2999-01-01T00:00:00.000Z' });
    mocks.fetch.mockResolvedValueOnce({ success: false });
    expect(await confirmAppointmentClaimsBeforePayment([{ appointment_id: ID }])).toBeNull();
  });
});
