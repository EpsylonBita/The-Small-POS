import React from 'react';
import { act, cleanup, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportSessionProvider, useSupportSession, SupportBannerSnapshotSchema, SupportConsentResponseSchema } from '../useSupportSession';
import issueFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-sessions.json';
import consentFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent.json';
import acceptFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-accept.json';
import declineFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-decline.json';
import heartbeatFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-terminal-heartbeat-support.json';

const mocks = vi.hoisted(() => ({ ipc: vi.fn(), offline: false }));
vi.mock('../../../lib/ipc-adapter', () => ({ supportIpc: mocks.ipc }));
vi.mock('../../services/server-reachability', () => ({ isTillKnownOffline: () => mocks.offline }));
const consent = SupportConsentResponseSchema.parse(consentFixture.cases[0].response);
const snapshot = SupportBannerSnapshotSchema.parse({
  availability: heartbeatFixture.response.support, state: null, session_id: null, operator_name: null,
  remaining_ms: 600_000, current_activity_key: null, can_connect: true,
  staff: { staff_id: acceptFixture.cases[0].body.staff_id, base_role: 'admin' },
  extend_allowed: true, critical_op_active: false, write_outcome: null,
});
const issued = issueFixture.response;
const wrapper = ({ children }: { children: React.ReactNode }) => <SupportSessionProvider>{children}</SupportSessionProvider>;
beforeEach(() => {
  mocks.offline = false;
  mocks.ipc.mockReset().mockImplementation(async (command: string) => {
    if (command === 'support_banner_state') { return snapshot; }
    if (command === 'support_consent_fetch') { return { ...consent, state: 'valid' }; }
    if (command === 'support_request_code') { return issued; }
    return {};
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function ready() {
  const hook = renderHook(useSupportSession, { wrapper });
  await waitFor(() => expect(hook.result.current?.snapshot).not.toBeNull());
  return hook;
}

describe('renderer support IPC contract', () => {
  it('normalizes native banner names and denies connecting without heartbeat/permission metadata', () => {
    const native = SupportBannerSnapshotSchema.parse({ state: 'paused', operator_display_name: 'Operator', remaining_ms: 1000 });
    expect(native.state).toBe('pausedOffline');
    expect(native.operator_name).toBe('Operator');
    expect(native.can_connect).toBe(false);
    expect(native.availability).toBeNull();
    expect(SupportBannerSnapshotSchema.parse({ state: 'code_pending' }).state).toBe('waiting');
    expect(SupportBannerSnapshotSchema.parse({ state: 'none' }).state).toBeNull();
  });
  it('accepts the exact golden code response without native QR data and only reports the staff identity', async () => {
    const hook = await ready();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.code).toEqual(issued);
    expect(mocks.ipc).toHaveBeenCalledWith('support_request_code', { staff_ref: { staff_id: snapshot.staff?.staff_id } });
  });
  it('does not display a malformed code or ask for another code during an active session', async () => {
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_banner_state'
      ? { ...snapshot, state: 'connected' } : issued);
    const hook = await ready();
    await act(async () => { await hook.result.current?.start(); });
    expect(mocks.ipc.mock.calls.some(([command]) => command === 'support_request_code')).toBe(false);
    expect(hook.result.current?.view).toBe('closed');
  });
  it('fails closed on a malformed response', async () => {
    const hook = await ready();
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_consent_fetch' ? { ...consent, state: 'valid' } : {});
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('error');
    expect(hook.result.current?.code).toBeNull();
  });
  it.each([null, { ...snapshot.availability, available: false }, { ...snapshot.availability, min_protocol_version: 999 }])('rechecks real native availability before starting (%j)', async availability => {
    const hook = await ready();
    mocks.ipc.mockImplementation(async () => ({ ...snapshot, availability }));
    await act(async () => { await hook.result.current?.start(); });
    expect(mocks.ipc).not.toHaveBeenCalledWith('support_consent_fetch');
    expect(mocks.ipc.mock.calls.some(([command]) => command === 'support_request_code')).toBe(false);
    expect(hook.result.current?.snapshot?.availability).toEqual(availability);
  });
  it('never infers availability from a native session or code', async () => {
    mocks.ipc.mockResolvedValue({ state: 'code_pending', can_connect: true });
    const hook = await ready();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.snapshot?.availability).toBeNull();
    expect(mocks.ipc.mock.calls.some(([command]) => command === 'support_request_code')).toBe(false);
  });
  it('only calls extend IPC when native permits extension', async () => {
    mocks.ipc.mockResolvedValue({ ...snapshot, state: 'connected', extend_allowed: false });
    const hook = await ready();
    await act(async () => { await hook.result.current?.extend(); });
    expect(mocks.ipc).not.toHaveBeenCalledWith('support_extend');
    hook.unmount();
    mocks.ipc.mockResolvedValue({ ...snapshot, state: 'connected', extend_allowed: true });
    const allowed = await ready();
    await act(async () => { await allowed.result.current?.extend(); });
    expect(mocks.ipc).toHaveBeenCalledWith('support_extend');
  });
  it('does not issue a code offline', async () => {
    const hook = await ready(); mocks.offline = true;
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('offline');
    expect(mocks.ipc.mock.calls.some(([command]) => command === 'support_request_code')).toBe(false);
  });
  it('bypasses the consent screen only for a fresh valid or exempt answer', async () => {
    const hook = await ready();
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_consent_fetch'
      ? { ...consent, state: 'exempt' } : command === 'support_request_code' ? issued : snapshot);
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('code');
    expect(hook.result.current?.consent).toBeNull();
  });
  it('sends the exact golden acceptance body and continues directly to issuance', async () => {
    let accepted = false;
    mocks.ipc.mockImplementation(async (command: string) => {
      if (command === 'support_banner_state') { return snapshot; }
      if (command === 'support_consent_fetch') { return { ...consent, state: accepted ? 'valid' : 'missing' }; }
      if (command === 'support_consent_accept') { accepted = true; return acceptFixture.cases[0].response; }
      return issued;
    });
    const hook = await ready();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('consent');
    const text = hook.result.current?.consent?.text;
    expect(text).toBeTruthy();
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_accept', acceptFixture.cases[0].body);
    expect(hook.result.current?.view).toBe('code');
  });
  it('a cashier cannot send acceptance, and declining never issues a code', async () => {
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_banner_state'
      ? { ...snapshot, staff: { ...snapshot.staff, base_role: 'cashier' } }
      : { ...consent, text: consent.text ? { ...consent.text, text_id: declineFixture.request.text_id } : null });
    const hook = await ready();
    await act(async () => { await hook.result.current?.start(); });
    const text = hook.result.current?.consent?.text;
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(mocks.ipc).not.toHaveBeenCalledWith('support_consent_accept', expect.anything());
    await act(async () => { await hook.result.current?.decline(); });
    // The till stamps declined_at_till natively; the renderer sends only the text it showed.
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_decline', {
      text_id: declineFixture.request.text_id,
      text_sha256: declineFixture.request.text_sha256,
    });
    expect(mocks.ipc.mock.calls.some(([command]) => command === 'support_request_code')).toBe(false);
  });
  it('re-prompts when the native consent fetch returns a new version', async () => {
    const hook = await ready();
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_consent_fetch'
      ? { ...consent, state: 'outdated', text: consent.text ? { ...consent.text, version: 'v2' } : null } : snapshot);
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('consent');
    expect(hook.result.current?.consent?.text?.version).toBe('v2');
  });
  it('hides the code before offline cancellation finishes and rejects a late issuance', async () => {
    const hook = await ready();
    let finish: (value: unknown) => void = () => {};
    mocks.ipc.mockImplementation((command: string) => command === 'support_request_code'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(command === 'support_consent_fetch' ? { ...consent, state: 'valid' } : snapshot));
    let pending: Promise<void> | undefined;
    await act(async () => { pending = hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.cancel(); });
    await act(async () => { finish(issued); await pending; });
    expect(hook.result.current?.code).toBeNull();
    expect(hook.result.current?.view).toBe('closed');
    expect(mocks.ipc).toHaveBeenCalledWith('support_cancel_code');
  });
  it('End calls native immediately even while another request is unresolved', async () => {
    const hook = await ready();
    mocks.ipc.mockImplementation((command: string) => command === 'support_consent_fetch'
      ? new Promise(() => {}) : Promise.resolve(snapshot));
    act(() => { void hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.end(); });
    expect(mocks.ipc).toHaveBeenCalledWith('support_end');
    expect(hook.result.current?.view).toBe('closed');
  });
  it('expires and removes the code using elapsed server time, independent of the wall clock', async () => {
    const hook = await ready();
    vi.useFakeTimers();
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_banner_state' ? snapshot
      : command === 'support_consent_fetch' ? { ...consent, state: 'valid' }
        : { ...issued, expires_at: '2026-11-01T12:00:01.000Z' });
    await act(async () => { await hook.result.current?.start(); });
    vi.setSystemTime(new Date('2036-11-01T12:00:00.000Z'));
    expect(hook.result.current?.view).toBe('code');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current?.view).toBe('expired');
    expect(hook.result.current?.code).toBeNull();
  });
});

it('support unavailability leaves the selling/Health children interactive', async () => {
  mocks.ipc.mockRejectedValue(new Error('Support unavailable'));
  const checkout = vi.fn();
  render(<SupportSessionProvider><button onClick={checkout}>Checkout</button><div>Health</div></SupportSessionProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Checkout' }));
  expect(checkout).toHaveBeenCalledOnce();
  expect(screen.getByText('Health')).toBeVisible();
});
