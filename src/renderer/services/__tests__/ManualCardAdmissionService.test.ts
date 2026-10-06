import { beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop manual card rule (Android parity: requireNoConnectedPaymentProvider).
// A manual card is admitted only with no enabled ECR terminal on this till AND
// a fresh, exact-scope server answer that no payment provider is connected.
// Every other answer fails closed and nothing is cached between asks.

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getDefaultTerminal: vi.fn(),
  getDeviceStatus: vi.fn(),
  scope: { organizationId: 'org-a', branchId: 'branch-a', terminalId: 'terminal-a', apiKey: '' },
}));

vi.mock('../../../lib', () => ({
  getBridge: () => ({
    adminApi: { fetchFromAdmin: mocks.fetch },
    ecr: { getDefaultTerminal: mocks.getDefaultTerminal, getDeviceStatus: mocks.getDeviceStatus },
  }),
}));
// Returns the same mutable object on purpose: the service must copy the scope it asked with.
vi.mock('../terminal-credentials', () => ({ getCachedTerminalCredentials: () => mocks.scope }));

import {
  admitManualCard,
  lookupCardTerminal,
  MANUAL_CARD_ADMISSION_PATH,
} from '../ManualCardAdmissionService';

const answer = (body: Record<string, unknown> = {}, meta: Record<string, unknown> = { source: 'remote' }) => ({
  success: true,
  status: 200,
  meta,
  data: {
    success: true,
    admission_version: 1,
    organization_id: 'org-a',
    branch_id: 'branch-a',
    terminal_id: 'terminal-a',
    provider_connected: false,
    ...body,
  },
});

beforeEach(() => {
  mocks.scope.organizationId = 'org-a';
  mocks.scope.branchId = 'branch-a';
  mocks.scope.terminalId = 'terminal-a';
  mocks.fetch.mockReset();
  mocks.getDefaultTerminal.mockReset();
  mocks.getDeviceStatus.mockReset();
  // Native `ecr_get_default_terminal` with no enabled device.
  mocks.getDefaultTerminal.mockResolvedValue({ success: false, device: null });
  mocks.fetch.mockResolvedValue(answer());
});

describe('admitManualCard', () => {
  it('admits only with no enabled terminal and a fresh exact-scope "no provider" answer', async () => {
    expect(await admitManualCard()).toEqual({ admitted: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(MANUAL_CARD_ADMISSION_PATH, { method: 'GET' });
  });

  it('asks the server again on every call; nothing is cached between the offer and the record', async () => {
    expect(await admitManualCard()).toEqual({ admitted: true });
    mocks.fetch.mockResolvedValue(answer({ provider_connected: true }));
    expect(await admitManualCard()).toEqual({ admitted: false, reason: 'provider_connected' });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ready', { connected: true, ready: true, busy: false }],
    ['busy', { connected: true, ready: true, busy: true }],
    ['disconnected', { connected: false, ready: false, busy: false }],
  ])('refuses while an ECR terminal is enabled (%s) without asking the server', async (_label, status) => {
    mocks.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'EFT' } });
    mocks.getDeviceStatus.mockResolvedValue(status);
    expect(await admitManualCard()).toEqual({ admitted: false, reason: 'terminal_configured' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the server says a payment provider is connected', async () => {
    mocks.fetch.mockResolvedValue(answer({ provider_connected: true }));
    expect(await admitManualCard()).toEqual({ admitted: false, reason: 'provider_connected' });
  });

  it.each<[string, () => void]>([
    ['a cached offline answer', () => mocks.fetch.mockResolvedValue(answer({}, { source: 'cache', cachedAt: 'x', offlineFallback: true }))],
    ['a remote answer flagged as offline fallback', () => mocks.fetch.mockResolvedValue(answer({}, { source: 'remote', offlineFallback: true }))],
    ['an answer without its source', () => mocks.fetch.mockResolvedValue({ ...answer(), meta: undefined })],
    ['a refused request', () => mocks.fetch.mockResolvedValue({ success: false, error: 'PAYMENT_ADMISSION_UNAVAILABLE', status: 503 })],
    ['a failed body', () => mocks.fetch.mockResolvedValue(answer({ success: false }))],
    ['another admission version', () => mocks.fetch.mockResolvedValue(answer({ admission_version: 2 }))],
    ['another organization', () => mocks.fetch.mockResolvedValue(answer({ organization_id: 'org-b' }))],
    ['another branch', () => mocks.fetch.mockResolvedValue(answer({ branch_id: 'branch-b' }))],
    ['another terminal', () => mocks.fetch.mockResolvedValue(answer({ terminal_id: 'terminal-b' }))],
    ['a non-boolean provider flag', () => mocks.fetch.mockResolvedValue(answer({ provider_connected: 'false' }))],
    ['a network error', () => mocks.fetch.mockRejectedValue(new Error('network down'))],
    ['a failed device lookup', () => mocks.getDefaultTerminal.mockRejectedValue(new Error('db locked'))],
    ['an unreadable device lookup', () => mocks.getDefaultTerminal.mockResolvedValue({ success: false, error: 'boom' })],
    ['a missing terminal identity', () => { mocks.scope.terminalId = ''; }],
  ])('fails closed on %s', async (_label, arrange) => {
    arrange();
    expect(await admitManualCard()).toEqual({ admitted: false, reason: 'unavailable' });
  });

  it('drops an answer read across a re-pair of the terminal', async () => {
    mocks.fetch.mockImplementation(async () => {
      mocks.scope.branchId = 'branch-b';
      return answer({ branch_id: 'branch-a' });
    });
    expect(await admitManualCard()).toEqual({ admitted: false, reason: 'unavailable' });
  });

  it('fails closed while the browser reports no network', async () => {
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      expect(await admitManualCard()).toEqual({ admitted: false, reason: 'unavailable' });
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
  });
});

describe('lookupCardTerminal', () => {
  it('reports a ready enabled terminal', async () => {
    mocks.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'Front' } });
    mocks.getDeviceStatus.mockResolvedValue({ connected: true, ready: true, busy: false });
    expect(await lookupCardTerminal()).toEqual({ kind: 'ready', deviceId: 'eft-1', name: 'Front' });
  });

  it.each([
    ['busy', { connected: true, ready: true, busy: true }],
    ['not ready', { connected: true, ready: false, busy: false }],
    ['disconnected', { connected: false, ready: true, busy: false }],
  ])('reports an enabled terminal that is %s as not ready', async (_label, status) => {
    mocks.getDefaultTerminal.mockResolvedValue({ success: true, device: { id: 'eft-1', name: 'Front' } });
    mocks.getDeviceStatus.mockResolvedValue(status);
    expect(await lookupCardTerminal()).toEqual({ kind: 'not_ready', deviceId: 'eft-1', name: 'Front' });
  });

  it('reports an unreadable device status as not ready, never as no terminal', async () => {
    mocks.getDefaultTerminal.mockResolvedValue({ success: true, data: { device: { id: 'eft-1' } } });
    mocks.getDeviceStatus.mockRejectedValue(new Error('serial port gone'));
    expect(await lookupCardTerminal()).toEqual({ kind: 'not_ready', deviceId: 'eft-1', name: 'eft-1' });
  });

  it('reports none only for an explicit "no device" answer', async () => {
    expect(await lookupCardTerminal()).toEqual({ kind: 'none' });
    mocks.getDefaultTerminal.mockResolvedValue({ success: true, data: { device: null } });
    expect(await lookupCardTerminal()).toEqual({ kind: 'none' });
  });

  it.each<[string, unknown]>([
    ['an error reply', { success: false, error: 'boom' }],
    ['an empty reply', undefined],
    ['a device without an id', { success: true, device: { name: 'nameless' } }],
  ])('reports %s as unavailable', async (_label, reply) => {
    mocks.getDefaultTerminal.mockResolvedValue(reply);
    expect(await lookupCardTerminal()).toEqual({ kind: 'unavailable' });
  });
});
