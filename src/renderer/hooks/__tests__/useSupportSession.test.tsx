import React from 'react';
import { act, cleanup, render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportSessionProvider, useSupportSession, SupportBannerSnapshotSchema, SupportConsentResponseSchema, supportActorProblem } from '../useSupportSession';
import { SupportConnectAction } from '../../components/support/SupportConnectAction';
import elSupport from '../../../locales/support/el.json';
import issueFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-sessions.json';
import consentFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent.json';
import acceptFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-accept.json';
import declineFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-support-consent-decline.json';
import heartbeatFixture from '../../../../../shared/pos/support/__fixtures__/routes/pos-terminal-heartbeat-support.json';

const mocks = vi.hoisted(() => ({ ipc: vi.fn(), offline: false, language: 'el' as string | undefined }));
vi.mock('../../../lib/ipc-adapter', () => ({ supportIpc: mocks.ipc }));
vi.mock('../../services/server-reachability', () => ({ isTillKnownOffline: () => mocks.offline }));
// The real Greek support bundle, so screens read exactly what a Greek till shows, and the
// till's UI language at that moment, in which the consent text is fetched.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, string>) => {
  const text = key.replace(/^support\./, '').split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, elSupport);
  return typeof text === 'string' ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options?.[name] ?? '') : key;
}, i18n: { language: mocks.language } }) }));
const consent = SupportConsentResponseSchema.parse(consentFixture.cases[0].response);
// Native no longer names staff in the banner; `support_actors` does.
const snapshot = SupportBannerSnapshotSchema.parse({
  availability: heartbeatFixture.response.support, state: null, session_id: null, operator_name: null,
  remaining_ms: 600_000, current_activity_key: null, can_connect: true, staff: null,
  extend_allowed: true, critical_op_active: false, write_outcome: null,
});
const issued = issueFixture.response;
const maria = { staff_id: acceptFixture.cases[0].body.staff_id, name: 'Μαρία', base_role: 'admin' };
const nikos = { staff_id: '77777777-7777-4777-8777-777777777777', name: 'Νίκος', base_role: 'cashier' };
const onShift = (...actors: typeof maria[]) => ({ state: 'ready', actors });
type Answer = (payload?: Record<string, unknown>) => unknown;
/** Native answers by command; anything not overridden behaves like a healthy till with Μαρία on shift. */
function native(overrides: Record<string, Answer> = {}) {
  mocks.ipc.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
    if (overrides[command]) { return overrides[command](payload); }
    if (command === 'support_banner_state') { return snapshot; }
    if (command === 'support_actors') { return onShift(maria); }
    if (command === 'support_consent_fetch') { return { ...consent, state: 'valid' }; }
    if (command === 'support_request_code') { return issued; }
    return {};
  });
}
const calls = (command: string) => mocks.ipc.mock.calls.filter(([name]) => name === command);
const wrapper = ({ children }: { children: React.ReactNode }) => <SupportSessionProvider>{children}</SupportSessionProvider>;
beforeEach(() => {
  mocks.offline = false; mocks.language = 'el';
  mocks.ipc.mockReset();
  native();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mounted() {
  const hook = renderHook(useSupportSession, { wrapper });
  await waitFor(() => expect(hook.result.current?.snapshot).not.toBeNull());
  return hook;
}

describe('renderer support IPC contract', () => {
  it('normalizes native banner names and denies connecting without heartbeat/permission metadata', () => {
    const parsed = SupportBannerSnapshotSchema.parse({ state: 'paused', operator_display_name: 'Operator', remaining_ms: 1000 });
    expect(parsed.state).toBe('pausedOffline');
    expect(parsed.operator_name).toBe('Operator');
    expect(parsed.can_connect).toBe(false);
    expect(parsed.availability).toBeNull();
    expect(parsed.staff).toBeNull();
    expect(SupportBannerSnapshotSchema.parse({ state: 'code_pending' }).state).toBe('waiting');
    expect(SupportBannerSnapshotSchema.parse({ state: 'none' }).state).toBeNull();
  });
  it('reads the three actor refusals from a bare string, an Error or a code object', () => {
    expect(supportActorProblem('SUPPORT_STAFF_REQUIRED')).toBe('SUPPORT_STAFF_REQUIRED');
    expect(supportActorProblem(new Error('SUPPORT_SIGN_IN_AGAIN'))).toBe('SUPPORT_SIGN_IN_AGAIN');
    expect(supportActorProblem({ code: 'SUPPORT_STAFF_CHOICE_REQUIRED' })).toBe('SUPPORT_STAFF_CHOICE_REQUIRED');
    expect(supportActorProblem('Error: SUPPORT_STAFF_CHOICE_REQUIRED')).toBe('SUPPORT_STAFF_CHOICE_REQUIRED');
    expect(supportActorProblem('NOT_SUPPORT_STAFF_REQUIRED_X')).toBeNull();
    expect(supportActorProblem(new Error('POLICY_REFUSED'))).toBeNull();
    expect(supportActorProblem(undefined)).toBeNull();
  });
  it('accepts the exact golden code response and names the one person on shift by staff_id only', async () => {
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.code).toEqual(issued);
    expect(hook.result.current?.actor).toEqual(maria);
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: maria.staff_id }]]);
    expect(JSON.stringify(mocks.ipc.mock.calls)).not.toContain('staff_ref');
  });
  it('does not display a malformed code or ask for another code during an active session', async () => {
    native({ support_banner_state: () => ({ ...snapshot, state: 'connected' }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(calls('support_request_code')).toHaveLength(0);
    expect(hook.result.current?.view).toBe('closed');
  });
  it('fails closed on a malformed response', async () => {
    const hook = await mounted();
    mocks.ipc.mockImplementation(async (command: string) => command === 'support_consent_fetch' ? { ...consent, state: 'valid' } : {});
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('error');
    expect(hook.result.current?.code).toBeNull();
  });
  it.each([null, { ...snapshot.availability, available: false }, { ...snapshot.availability, min_protocol_version: 999 }])('rechecks real native availability before starting (%j)', async availability => {
    const hook = await mounted();
    mocks.ipc.mockImplementation(async () => ({ ...snapshot, availability }));
    await act(async () => { await hook.result.current?.start(); });
    expect(calls('support_actors')).toHaveLength(0);
    expect(calls('support_consent_fetch')).toHaveLength(0);
    expect(calls('support_request_code')).toHaveLength(0);
    expect(hook.result.current?.snapshot?.availability).toEqual(availability);
  });
  it('never infers availability from a native session or code', async () => {
    mocks.ipc.mockResolvedValue({ state: 'code_pending', can_connect: true });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.snapshot?.availability).toBeNull();
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('only calls extend IPC when native permits extension', async () => {
    native({ support_banner_state: () => ({ ...snapshot, state: 'connected', extend_allowed: false }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.extend(); });
    expect(calls('support_extend')).toHaveLength(0);
    hook.unmount();
    native({ support_banner_state: () => ({ ...snapshot, state: 'connected', extend_allowed: true }) });
    const allowed = await mounted();
    await act(async () => { await allowed.result.current?.extend(); });
    // Nobody was chosen in this flow: native picks the only person on shift.
    expect(mocks.ipc).toHaveBeenCalledWith('support_extend');
  });
  it('does not issue a code offline', async () => {
    const hook = await mounted(); mocks.offline = true;
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('offline');
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('bypasses the consent screen only for a fresh valid or exempt answer', async () => {
    native({ support_consent_fetch: () => ({ ...consent, state: 'exempt' }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('code');
    expect(hook.result.current?.consent).toBeNull();
  });
  it('sends the exact golden acceptance body for the one person on shift and continues directly to issuance', async () => {
    let accepted = false;
    native({
      support_consent_fetch: () => ({ ...consent, state: accepted ? 'valid' : 'missing' }),
      support_consent_accept: () => { accepted = true; return acceptFixture.cases[0].response; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('consent');
    expect(hook.result.current?.actor).toEqual(maria);
    const text = hook.result.current?.consent?.text;
    expect(text).toBeTruthy();
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_accept', acceptFixture.cases[0].body);
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: maria.staff_id }]]);
    expect(hook.result.current?.view).toBe('code');
  });
  it('a waiter cannot send acceptance, and declining sends the chosen person and never issues a code', async () => {
    native({
      support_actors: () => onShift({ ...maria, base_role: 'waiter' }),
      support_consent_fetch: () => ({ ...consent, text: consent.text ? { ...consent.text, text_id: declineFixture.request.text_id } : null }),
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    const text = hook.result.current?.consent?.text;
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(calls('support_consent_accept')).toHaveLength(0);
    await act(async () => { await hook.result.current?.decline(); });
    // The till stamps declined_at_till natively; the renderer sends the text it showed and who declined.
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_decline', {
      text_id: declineFixture.request.text_id,
      text_sha256: declineFixture.request.text_sha256,
      staff_id: maria.staff_id,
    });
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('re-prompts when the native consent fetch returns a new version', async () => {
    native({ support_consent_fetch: () => ({ ...consent, state: 'outdated', text: consent.text ? { ...consent.text, version: 'v2' } : null }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('consent');
    expect(hook.result.current?.consent?.text?.version).toBe('v2');
  });
  it('hides the code before offline cancellation finishes and rejects a late issuance', async () => {
    let finish: (value: unknown) => void = () => {};
    native({ support_request_code: () => new Promise(resolve => { finish = resolve; }) });
    const hook = await mounted();
    let pending: Promise<void> | undefined;
    await act(async () => { pending = hook.result.current?.start(); });
    expect(calls('support_request_code')).toHaveLength(1);
    await act(async () => { await hook.result.current?.cancel(); });
    await act(async () => { finish(issued); await pending; });
    expect(hook.result.current?.code).toBeNull();
    expect(hook.result.current?.view).toBe('closed');
    expect(mocks.ipc).toHaveBeenCalledWith('support_cancel_code');
  });
  it('End calls native immediately even while another request is unresolved', async () => {
    native({ support_consent_fetch: () => new Promise(() => {}) });
    const hook = await mounted();
    act(() => { void hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.end(); });
    expect(mocks.ipc).toHaveBeenCalledWith('support_end');
    expect(hook.result.current?.view).toBe('closed');
  });
  it('expires and removes the code using elapsed server time, independent of the wall clock', async () => {
    const hook = await mounted();
    vi.useFakeTimers();
    native({ support_request_code: () => ({ ...issued, expires_at: '2026-11-01T12:00:01.000Z' }) });
    await act(async () => { await hook.result.current?.start(); });
    vi.setSystemTime(new Date('2036-11-01T12:00:00.000Z'));
    expect(hook.result.current?.view).toBe('code');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current?.view).toBe('expired');
    expect(hook.result.current?.code).toBeNull();
  });
});

describe('who acts for support on this till', () => {
  it.each([['staff_required', 'staff_required'], ['sign_in_again', 'sign_in_again']] as const)('explains %s and asks for no consent and no code', async (state, view) => {
    native({ support_actors: () => ({ state, actors: [] }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe(view);
    expect(calls('support_consent_fetch')).toHaveLength(0);
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it.each([
    ['staff_required', 'Χρειάζεται ταμίας ή υπεύθυνος σε βάρδια σε αυτό το ταμείο. Κάντε check-in και δοκιμάστε ξανά.'],
    ['sign_in_again', 'Η σύνδεση του υπαλλήλου για την υποστήριξη έληξε. Επιβεβαιώστε με το PIN σας για να συνεχίσετε. Η βάρδιά σας μένει ανοιχτή.'],
  ] as const)('shows the Greek %s message instead of «Δεν ήταν δυνατή η λήψη κωδικού»', async (state, message) => {
    native({ support_actors: () => ({ state, actors: [] }) });
    render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
    const connect = await screen.findByRole('button', { name: 'Σύνδεση υποστήριξης' });
    await waitFor(() => expect(connect).toBeEnabled());
    await act(async () => { fireEvent.click(connect); });
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText('Δεν ήταν δυνατή η λήψη κωδικού. Δοκιμάστε ξανά.')).toBeNull();
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it.each([
    ['SUPPORT_STAFF_REQUIRED', 'staff_required', { state: 'staff_required', actors: [] }],
    ['SUPPORT_SIGN_IN_AGAIN', 'sign_in_again', { state: 'sign_in_again', actors: [] }],
  ] as const)('maps a %s rejection from the consent fetch to its view', async (code, view, roster) => {
    let asked = 0;
    native({
      support_actors: () => (asked++ === 0 ? onShift(maria) : roster),
      support_consent_fetch: () => { throw code; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe(view);
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('renews the sign-in of someone still on shift with their PIN, then carries on to the code', async () => {
    let renewed = false;
    native({
      support_actors: () => (renewed ? onShift(maria) : { state: 'sign_in_again', actors: [], renewable: [{ staff_id: maria.staff_id, name: 'Μαρία' }] }),
      support_staff_renew: () => { renewed = true; return { outcome: 'renewed' }; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('sign_in_again');
    expect(hook.result.current?.renewable).toEqual([{ staff_id: maria.staff_id, name: 'Μαρία' }]);
    let outcome: string | undefined;
    await act(async () => { outcome = await hook.result.current?.renew(maria.staff_id, '1234'); });
    expect(outcome).toBe('renewed');
    expect(calls('support_staff_renew')).toEqual([['support_staff_renew', { staff_id: maria.staff_id, pin: '1234' }]]);
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: maria.staff_id }]]);
    expect(hook.result.current?.view).toBe('code');
    // Only the server check-in: no shift, checkout or sale command.
    expect(mocks.ipc.mock.calls.map(([name]) => name).filter(name => !String(name).startsWith('support_'))).toEqual([]);
  });
  it('keeps the person on the sign-in step when the PIN is refused', async () => {
    native({
      support_actors: () => ({ state: 'sign_in_again', actors: [], renewable: [{ staff_id: maria.staff_id, name: 'Μαρία' }] }),
      support_staff_renew: () => ({ outcome: 'refused' }),
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    let outcome: string | undefined;
    await act(async () => { outcome = await hook.result.current?.renew(maria.staff_id, '0000'); });
    expect(outcome).toBe('refused');
    expect(hook.result.current?.view).toBe('sign_in_again');
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('shows «Συναίνεση από: Μαρία» on the consent screen and keeps «Συμφωνώ» as published', async () => {
    native({ support_consent_fetch: () => ({ ...consent, state: 'missing' }) });
    render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
    const connect = await screen.findByRole('button', { name: 'Σύνδεση υποστήριξης' });
    await waitFor(() => expect(connect).toBeEnabled());
    await act(async () => { fireEvent.click(connect); });
    expect(await screen.findByText('Συναίνεση από: Μαρία')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Συμφωνώ' })).toBeInTheDocument();
    // One person on shift: nothing to pick, so the line is plain text.
    expect(screen.queryByRole('button', { name: 'Συναίνεση από: Μαρία' })).toBeNull();
  });
  it('asks «Ποιος ζητά την υποστήριξη;» with valid consent and issues for the tapped person', async () => {
    native({ support_actors: () => onShift(nikos, maria) });
    render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
    const connect = await screen.findByRole('button', { name: 'Σύνδεση υποστήριξης' });
    await waitFor(() => expect(connect).toBeEnabled());
    await act(async () => { fireEvent.click(connect); });
    expect(await screen.findByRole('heading', { name: 'Ποιος ζητά την υποστήριξη;' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Νίκος/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Μαρία/ })).toBeVisible();
    expect(calls('support_request_code')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Νίκος/ })); });
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: nikos.staff_id }]]);
    expect(await screen.findByText('ABCD-EFGH')).toBeVisible();
  });
  it('asks «Ποιος αποδέχεται;» when consent is needed, then accepts and requests as the tapped person', async () => {
    let accepted = false;
    native({
      support_actors: () => onShift(nikos, maria),
      support_consent_fetch: () => ({ ...consent, state: accepted ? 'valid' : 'missing' }),
      support_consent_accept: () => { accepted = true; return acceptFixture.cases[0].response; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('pick');
    expect(hook.result.current?.actorPurpose).toBe('consent');
    expect(hook.result.current?.actors).toEqual([nikos, maria]);
    await act(async () => { await hook.result.current?.choose(maria.staff_id); });
    expect(hook.result.current?.view).toBe('consent');
    expect(hook.result.current?.actor).toEqual(maria);
    const text = hook.result.current?.consent?.text;
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_accept', acceptFixture.cases[0].body);
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: maria.staff_id }]]);
    expect(hook.result.current?.view).toBe('code');
  });
  it('lets an ineligible person hand over: guidance, no acceptance, then another person accepts', async () => {
    const waiter = { ...nikos, base_role: 'waiter' };
    native({ support_actors: () => onShift(waiter, maria), support_consent_fetch: () => ({ ...consent, state: 'missing' }) });
    render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
    const connect = await screen.findByRole('button', { name: 'Σύνδεση υποστήριξης' });
    await waitFor(() => expect(connect).toBeEnabled());
    await act(async () => { fireEvent.click(connect); });
    expect(await screen.findByRole('heading', { name: 'Ποιος αποδέχεται;' })).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Νίκος/ })); });
    expect(screen.getByText(elSupport.consent.onlyOwnerAdmin)).toBeVisible();
    expect(screen.getByText(elSupport.consent.storeAdminAlternative)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Συμφωνώ' })).toBeNull();
    expect(calls('support_consent_accept')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Συναίνεση από: Νίκος' })); });
    expect(screen.getByRole('heading', { name: 'Ποιος αποδέχεται;' })).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Μαρία/ })); });
    expect(screen.getByText('Συναίνεση από: Μαρία')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Συμφωνώ' })).toBeInTheDocument();
  });
  it('lets a waiter who also holds the cashier role accept, as the server does', async () => {
    const both = { ...nikos, base_role: 'waiter', base_roles: ['waiter', 'cashier'] };
    native({ support_actors: () => onShift(both), support_consent_fetch: () => ({ ...consent, state: 'missing' }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(hook.result.current?.view).toBe('consent');
    const text = hook.result.current?.consent?.text;
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(calls('support_consent_accept')).toEqual([['support_consent_accept', expect.objectContaining({ staff_id: nikos.staff_id })]]);
  });
  it('declining after a pick sends the chosen staff_id', async () => {
    native({ support_actors: () => onShift(nikos, maria), support_consent_fetch: () => ({ ...consent, state: 'missing' }) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.choose(nikos.staff_id); });
    await act(async () => { await hook.result.current?.decline(); });
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_decline', expect.objectContaining({ staff_id: nikos.staff_id }));
    expect(hook.result.current?.actor).toBeNull();
    expect(hook.result.current?.view).toBe('closed');
  });
  it('returns to the picker when native says a choice is required', async () => {
    let rejected = false;
    native({
      support_actors: () => onShift(nikos, maria),
      support_request_code: () => { if (!rejected) { rejected = true; throw 'SUPPORT_STAFF_CHOICE_REQUIRED'; } return issued; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.choose(nikos.staff_id); });
    expect(hook.result.current?.view).toBe('pick');
    expect(hook.result.current?.actorPurpose).toBe('request');
    expect(hook.result.current?.actor).toBeNull();
    await act(async () => { await hook.result.current?.choose(maria.staff_id); });
    expect(calls('support_request_code').at(-1)).toEqual(['support_request_code', { staff_id: maria.staff_id }]);
    expect(hook.result.current?.view).toBe('code');
  });
  it('offers the others on shift when the chosen person has checked out', async () => {
    let asked = 0;
    native({
      // Μαρία is alone when connecting, then checks out and Νίκος checks in.
      support_actors: () => (asked++ === 0 ? onShift(maria) : onShift(nikos)),
      support_request_code: () => { throw new Error('SUPPORT_STAFF_REQUIRED'); },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    expect(calls('support_request_code')).toEqual([['support_request_code', { staff_id: maria.staff_id }]]);
    expect(hook.result.current?.view).toBe('pick');
    expect(hook.result.current?.actorPurpose).toBe('request');
    expect(hook.result.current?.actors).toEqual([nikos]);
  });
  it('picks who extends when several are on shift, and passes the chosen staff_id to extend', async () => {
    let chosen = false;
    native({
      support_banner_state: () => ({ ...snapshot, state: 'connected', extend_allowed: true }),
      support_actors: () => onShift(nikos, maria),
      support_extend: payload => { if (!payload) { throw 'SUPPORT_STAFF_CHOICE_REQUIRED'; } chosen = true; return {}; },
    });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.extend(); });
    expect(hook.result.current?.view).toBe('pick');
    expect(hook.result.current?.actorPurpose).toBe('extend');
    // The poll keeps the extend picker while the session is live.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    expect(hook.result.current?.view).toBe('pick');
    await act(async () => { await hook.result.current?.choose(maria.staff_id); });
    expect(chosen).toBe(true);
    expect(calls('support_extend').at(-1)).toEqual(['support_extend', { staff_id: maria.staff_id }]);
    expect(hook.result.current?.view).toBe('closed');
    expect(hook.result.current?.actorPurpose).toBeNull();
  });
  it('passes the person chosen when connecting to a later extend', async () => {
    native({ support_actors: () => onShift(nikos, maria) });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    await act(async () => { await hook.result.current?.choose(maria.staff_id); });
    native({ support_banner_state: () => ({ ...snapshot, state: 'connected', extend_allowed: true }), support_actors: () => onShift(nikos, maria) });
    await waitFor(() => expect(hook.result.current?.snapshot?.state).toBe('connected'));
    await act(async () => { await hook.result.current?.extend(); });
    expect(calls('support_extend')).toEqual([['support_extend', { staff_id: maria.staff_id }]]);
  });
});

describe('consent language', () => {
  it.each([['fr', { locale: 'fr' }], ['de-CH', { locale: 'de' }], ['pt', undefined], [undefined, undefined]] as const)(
    'fetches the consent text in the till language %s', async (language, payload) => {
      mocks.language = language;
      const hook = await mounted();
      await act(async () => { await hook.result.current?.start(); });
      const fetches = calls('support_consent_fetch');
      expect(fetches).toHaveLength(1);
      expect(fetches[0][1]).toEqual(payload);
    });
  it('accepts the text in the language it was shown in', async () => {
    mocks.language = 'fr';
    const french = { ...consent, state: 'missing' as const, text: consent.text ? { ...consent.text, locale: 'fr' as const } : null };
    native({ support_consent_fetch: () => french });
    const hook = await mounted();
    await act(async () => { await hook.result.current?.start(); });
    const text = hook.result.current?.consent?.text;
    await act(async () => { if (text) { await hook.result.current?.accept(text); } });
    expect(mocks.ipc).toHaveBeenCalledWith('support_consent_accept', expect.objectContaining({ locale: 'fr', text_id: french.text?.text_id }));
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

// 04/11/2026, founder's dev till: a second «Σύνδεση υποστήριξης» beside the code met the
// session the first code had started (409 SESSION_LIMIT_REACHED) and the card said «Δεν ήταν
// δυνατή η λήψη κωδικού». The till now says a connection is already open and offers to end it.
describe('one code at a time', () => {
  const SESSION = '30000000-0000-4000-a000-000000000003';
  const connect = () => screen.getByRole('button', { name: elSupport.connect.action });
  const shown = () => render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
  it('explains instead of asking for another code while one is shown, and Close keeps the code', async () => {
    shown();
    await waitFor(() => expect(connect()).toBeEnabled());
    await act(async () => { fireEvent.click(connect()); });
    await waitFor(() => expect(screen.getByText(issued.code)).toBeVisible());
    await act(async () => { fireEvent.click(connect()); });
    expect(screen.getByText(elSupport.code.alreadyOpen)).toBeVisible();
    expect(calls('support_request_code')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: elSupport.restore.dismissNotice }));
    expect(screen.getByText(issued.code)).toBeVisible();
  });
  it('shows a starting session with «Τέλος» in the section and explains instead of asking for a code', async () => {
    native({ support_banner_state: () => ({ ...snapshot, state: 'pending_ack', session_id: SESSION }) });
    shown();
    const live = await screen.findByTestId('support-live-session');
    expect(within(live).getByText(elSupport.banner.waiting)).toBeVisible();
    expect(within(live).getByRole('button', { name: elSupport.banner.end })).toBeEnabled();
    await act(async () => { fireEvent.click(connect()); });
    expect(screen.getByTestId('support-open-notice')).toBeVisible();
    expect(calls('support_request_code')).toHaveLength(0);
  });
  it('says a connection is already open when the server has one for this till, never retry or offline', async () => {
    native({ support_request_code: () => { throw 'SESSION_LIMIT_REACHED'; } });
    shown();
    await waitFor(() => expect(connect()).toBeEnabled());
    const before = calls('support_banner_state').length;
    await act(async () => { fireEvent.click(connect()); });
    await waitFor(() => expect(screen.getByText(elSupport.code.alreadyOpen)).toBeVisible());
    expect(calls('support_request_code')).toHaveLength(1);
    expect(screen.queryByText(elSupport.code.retry)).toBeNull();
    expect(screen.queryByText(elSupport.code.needsInternet)).toBeNull();
    // It reads the till's state again at once rather than waiting for the next poll.
    expect(calls('support_banner_state').length).toBeGreaterThan(before + 1);
  });
  it('ends the open connection through native, then connect asks for a new code', async () => {
    let open = true;
    native({
      support_request_code: () => { if (open) { throw 'SESSION_LIMIT_REACHED'; } return issued; },
      support_end_open: () => { open = false; return { ended: true, write_outcome: null, server: 'ended' }; },
    });
    shown();
    await waitFor(() => expect(connect()).toBeEnabled());
    await act(async () => { fireEvent.click(connect()); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: elSupport.code.endExisting })); });
    expect(calls('support_end_open')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId('support-open-notice')).toBeNull());
    await act(async () => { fireEvent.click(connect()); });
    await waitFor(() => expect(screen.getByText(issued.code)).toBeVisible());
    expect(calls('support_request_code')).toHaveLength(2);
  });
});
