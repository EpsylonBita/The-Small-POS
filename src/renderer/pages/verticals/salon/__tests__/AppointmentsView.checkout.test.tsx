import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const APPOINTMENT_ID = '20000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  translate: (key: string, fallback?: any) => {
    const template = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
    return template.replace(/{{(\w+)}}/g, (_: string, name: string) => String(fallback?.[name] ?? ''));
  },
  checkIn: vi.fn(), complete: vi.fn(), update: vi.fn(), refetch: vi.fn(), toastError: vi.fn(),
  getAll: vi.fn(async (): Promise<any[]> => []), fetch: vi.fn(),
  service: { id: '10000000-0000-4000-8000-000000000001', name: 'Haircut', price: 25, priceIncludesVat: true },
  bridge: { staffSchedule: { list: vi.fn(async () => ({ success: true, data: { staff: [] } })) }, services: { list: vi.fn(async () => ({ success: true, data: { services: [] } })) } } }));
vi.mock('react-i18next', async original => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: mocks.translate, i18n: { language: 'en' } }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { error: mocks.toastError, success: vi.fn() }) }));
vi.mock('../../../../components/OrderFlow', () => ({ default: ({ salonSale, onSalonClose }: any) => <div data-testid="sale">{salonSale.items.map((line: any) => `${line.service_id}:${line.appointment_id}`)}<button onClick={onSalonClose}>Finish salon sale</button></div> }));
vi.mock('../../../../contexts/theme-context', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('../../../../contexts/module-context', () => ({ useModules: () => ({ organizationId: 'org' }) }));
vi.mock('../../../../../lib', () => ({ getBridge: () => Object.assign(mocks.bridge, { orders: { getAll: mocks.getAll } }), isBrowser: () => false, onEvent: vi.fn(), offEvent: vi.fn() }));
vi.mock('../../../../services/terminal-credentials', () => ({ getCachedTerminalCredentials: () => ({ branchId: 'branch', organizationId: 'org' }), refreshTerminalCredentialCache: async () => ({ branchId: 'branch', organizationId: 'org' }),
  getResolvedTerminalIdentity: async () => ({ organizationId: 'org', branchId: 'branch', terminalId: 'till-1' }) }));
vi.mock('../../../../utils/api-helpers', () => ({ posApiGet: async () => ({ success: true, data: { timeZone: 'Europe/Athens' } }), posApiFetch: mocks.fetch }));
vi.mock('../../../../services/ServicesService', () => ({ servicesService: { setContext: vi.fn(), fetchServices: async () => [mocks.service] } }));
vi.mock('../../../../components/modals/CustomerSearchModal', () => ({ CustomerSearchModal: () => null }));
vi.mock('../../../../hooks/useAppointments', () => ({ useAppointments: () => ({ appointments: [{
  id: '20000000-0000-4000-8000-000000000001', organizationId: 'org', branchId: 'branch', status: 'scheduled',
  startTime: '2026-10-21T07:00:00Z', endTime: '2026-10-21T07:45:00Z', serviceId: mocks.service.id, serviceName: 'Haircut',
  customerName: 'Mia', staffName: 'Ana', staffId: 'stylist', services: [], totalPrice: 25,
}], stats: { total: 1, scheduled: 1 }, staff: [], isLoading: false, refetch: mocks.refetch,
  createAppointment: vi.fn(), updateStatus: mocks.update, checkIn: mocks.checkIn, complete: mocks.complete }) }));
import { AppointmentsView } from '../AppointmentsView';
import { APPOINTMENT_CLAIM_RENEW_MS, readStoredClaim, rememberClaim, resetClaimMemoryForTests } from '../../../../services/appointment-checkout-claims';

const LEASE = '2026-10-21T07:15:00.000Z'; // 10:15 in Athens (EEST)
const granted = (claimId = 'claim-server') => ({ success: true, status: 200, data: { success: true, claim: { appointment_id: APPOINTMENT_ID, claim_id: claimId, terminal_id: 'till-1', lease_expires_at: '2999-01-01T00:00:00.000Z' } } });
const claimCalls = (method: string) => mocks.fetch.mock.calls.filter(([, init]) => init?.method === method);

async function openCheckout() {
  render(<AppointmentsView embedded />);
  fireEvent.click(await screen.findByRole('button', { name: 'List' }));
  fireEvent.click(await screen.findByRole('button', { name: 'salonSale.checkout' }));
}

beforeEach(() => {
  localStorage.clear();
  resetClaimMemoryForTests();
  mocks.getAll.mockResolvedValue([]);
  mocks.fetch.mockResolvedValue(granted());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('desktop appointment actions', () => {
  it('checks a scheduled appointment in, and checks out through the normal sale instead of completing it', async () => {
    render(<AppointmentsView embedded />);
    fireEvent.click(await screen.findByRole('button', { name: 'List' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    expect(mocks.checkIn).toHaveBeenCalledWith(APPOINTMENT_ID);
    fireEvent.click(screen.getByRole('button', { name: 'salonSale.checkout' }));
    await waitFor(() => expect(screen.getByTestId('sale').textContent).toContain(`${mocks.service.id}:${APPOINTMENT_ID}`));
    fireEvent.click(screen.getByRole('button', { name: 'Finish salon sale' }));
    expect(mocks.refetch).toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('appointment checkout claim (claim before money)', () => {
  it('claims the appointment with a fresh claim id before the cart opens', async () => {
    let answer!: (value: unknown) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    await openCheckout();
    await waitFor(() => expect(claimCalls('POST')).toHaveLength(1));
    const [path, init] = claimCalls('POST')[0];
    expect(path).toBe(`/api/pos/appointments/${APPOINTMENT_ID}/checkout-claim`);
    expect(JSON.parse(init.body).claim_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByTestId('sale')).toBeNull();
    await act(async () => { answer(granted()); });
    expect(await screen.findByTestId('sale')).toBeTruthy();
    expect(await readStoredClaim(APPOINTMENT_ID)).toMatchObject({ claimId: 'claim-server' });
  });

  it('does not open the cart while another till holds the claim, and names that till in branch time', async () => {
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_CHECKOUT_CLAIMED',
      error: `Appointment is being checked out at another terminal (HTTP 409): ${JSON.stringify({ success: false, code: 'APPOINTMENT_CHECKOUT_CLAIMED', claim: { terminal_id: 'till-2', terminal_name: 'Front desk', lease_expires_at: LEASE } })}` });
    await openCheckout();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.toastError.mock.calls[0][0]).toBe('This appointment is being checked out at another till (Front desk) until 10:15.');
    expect(screen.queryByTestId('sale')).toBeNull();
  });

  it('does not open an appointment the office reports as already paid or closed', async () => {
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 409, code: 'APPOINTMENT_ALREADY_SETTLED', error: 'settled' });
    await openCheckout();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This appointment is already paid or closed.'));
    expect(screen.queryByTestId('sale')).toBeNull();
  });

  it('blocks an offline checkout when this till holds no claim', async () => {
    mocks.fetch.mockResolvedValueOnce({ success: false, error: 'This action requires an online connection.' });
    await openCheckout();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'Checking out an appointment needs a connection. You can sell the services as a walk-in.'));
    expect(screen.queryByTestId('sale')).toBeNull();
  });

  it('continues offline with the unexpired claim this till already holds', async () => {
    await rememberClaim({ appointmentId: APPOINTMENT_ID, claimId: 'claim-held', leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() });
    mocks.fetch.mockResolvedValueOnce({ success: false, error: 'This action requires an online connection.' });
    await openCheckout();
    expect(await screen.findByTestId('sale')).toBeTruthy();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('does not use an expired claim offline', async () => {
    await rememberClaim({ appointmentId: APPOINTMENT_ID, claimId: 'claim-old', leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    mocks.fetch.mockResolvedValueOnce({ success: false, error: 'This action requires an online connection.' });
    await openCheckout();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.queryByTestId('sale')).toBeNull();
  });

  it('releases the claim when the cart closes without an order', async () => {
    await openCheckout();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish salon sale' }));
    await waitFor(() => expect(claimCalls('DELETE')).toHaveLength(1));
    expect(claimCalls('DELETE')[0][0]).toBe(`/api/pos/appointments/${APPOINTMENT_ID}/checkout-claim?claim_id=claim-server`);
    expect(await readStoredClaim(APPOINTMENT_ID)).toBeNull();
  });

  it('only forgets the claim after the order was created: the office consumes it', async () => {
    await openCheckout();
    await screen.findByTestId('sale');
    mocks.getAll.mockResolvedValue([{ organization_id: 'org', branch_id: 'branch', status: 'completed',
      items: [{ service_id: mocks.service.id, appointment_id: APPOINTMENT_ID }] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Finish salon sale' }));
    await waitFor(async () => expect(await readStoredClaim(APPOINTMENT_ID)).toBeNull());
    expect(claimCalls('DELETE')).toHaveLength(0);
  });

  it('continues as before on an older office without the claim route (404 without a code)', async () => {
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 404, error: 'Admin dashboard endpoint not found.' });
    await openCheckout();
    expect(await screen.findByTestId('sale')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish salon sale' }));
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
    expect(claimCalls('DELETE')).toHaveLength(0);
  });

  it('does not open when the office says the appointment does not exist', async () => {
    mocks.fetch.mockResolvedValueOnce({ success: false, status: 404, code: 'APPOINTMENT_NOT_FOUND', error: 'not found' });
    await openCheckout();
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('This appointment was not found. Refresh and try again.'));
    expect(screen.queryByTestId('sale')).toBeNull();
  });

  it('renews the claim every five minutes while the cart is open, with the same claim id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openCheckout();
    await screen.findByTestId('sale');
    expect(claimCalls('POST')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(APPOINTMENT_CLAIM_RENEW_MS); });
    expect(claimCalls('POST')).toHaveLength(2);
    expect(JSON.parse(claimCalls('POST')[1][1].body).claim_id).toBe('claim-server');
    fireEvent.click(screen.getByRole('button', { name: 'Finish salon sale' }));
    await waitFor(() => expect(claimCalls('DELETE')).toHaveLength(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(APPOINTMENT_CLAIM_RENEW_MS * 2); });
    expect(claimCalls('POST')).toHaveLength(2);
  });

  // Codex review of PR #379: every renewal outcome that no longer allows the
  // checkout warns, not only the three refusals; the cart's payment then
  // renews again and refuses before money moves (MenuModal).
  it('warns when a renewal finds no connection after the lease ran out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.fetch.mockResolvedValueOnce({ success: true, status: 200, data: { success: true,
      claim: { claim_id: 'short', lease_expires_at: new Date(Date.now() + 60_000).toISOString() } } });
    await openCheckout();
    await screen.findByTestId('sale');
    mocks.fetch.mockResolvedValue({ success: false, error: 'This action requires an online connection.' });
    await act(async () => { await vi.advanceTimersByTimeAsync(APPOINTMENT_CLAIM_RENEW_MS); });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'Checking out an appointment needs a connection. You can sell the services as a walk-in.'));
  });
});
