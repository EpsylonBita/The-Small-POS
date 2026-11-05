import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportBanner, SupportBannerView } from '../SupportBanner';
import { SupportCodeScreen } from '../SupportCodeScreen';
import { SupportConnectAction } from '../SupportConnectAction';
import { SUPPORT_BANNER_STATES, SupportSessionProvider, type SupportBannerSnapshot, type SupportSessionController } from '../../../hooks/useSupportSession';
import { SupportAvailabilitySchema } from '../../../../../../shared/pos/support/consent';
import issueFixture from '../../../../../../shared/pos/support/__fixtures__/routes/pos-support-sessions.json';
import heartbeatFixture from '../../../../../../shared/pos/support/__fixtures__/routes/pos-terminal-heartbeat-support.json';

const mocks = vi.hoisted(() => ({ session: null as SupportSessionController | null, ipc: vi.fn() }));
vi.mock('../../../hooks/useSupportSession', async importOriginal => ({
  ...await importOriginal<typeof import('../../../hooks/useSupportSession')>(), useSupportSession: () => mocks.session,
}));
vi.mock('../../../../lib/ipc-adapter', () => ({ supportIpc: mocks.ipc }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const snapshot: SupportBannerSnapshot = {
  availability: SupportAvailabilitySchema.parse(heartbeatFixture.response.support), state: 'connected',
  session_id: '40000000-0000-4000-a000-000000000004', operator_name: 'Operator',
  remaining_ms: 600_000, current_activity_key: 'physicalCheck.check_printer_paper', can_connect: true,
  staff: null,
  extend_allowed: true, critical_op_active: false, write_outcome: null,
};
const issued = issueFixture.response;
function controller(next: Partial<SupportBannerSnapshot> = {}, flow: Partial<SupportSessionController> = {}): SupportSessionController {
  return { snapshot: { ...snapshot, ...next }, view: 'closed', code: null, consent: null, actors: [], actor: null, renewable: [], actorPurpose: null,
    busy: false, remainingMs: 0, start: vi.fn(), cancel: vi.fn(), choose: vi.fn(), changeActor: vi.fn(), dismiss: vi.fn(),
    accept: vi.fn(), decline: vi.fn(), end: vi.fn(), extend: vi.fn(), renew: vi.fn(), ...flow };
}
const maria = { staff_id: '88888888-8888-4888-8888-888888888888', name: 'Μαρία', base_role: 'admin' };
const nikos = { staff_id: '77777777-7777-4777-8777-777777777777', name: 'Νίκος', base_role: 'cashier' };
afterEach(() => { cleanup(); vi.useRealTimers(); mocks.session = null; });

describe.each(['light', 'dark'])('support UI in %s theme', theme => {
  it.each(SUPPORT_BANNER_STATES)('shows the %s banner with a one-tap End', state => {
    document.documentElement.className = theme;
    const onEnd = vi.fn();
    render(<SupportBannerView snapshot={{ ...snapshot, state }} onEnd={onEnd} onExtend={vi.fn()} />);
    expect(screen.getByText(`support.banner.${state}`)).toBeVisible();
    const end = screen.getByRole('button', { name: 'support.banner.end' });
    expect(end).not.toBeDisabled(); fireEvent.click(end); expect(onEnd).toHaveBeenCalledOnce();
    expect(end.className).toContain('whitespace-nowrap');
    expect(end.className).toContain('shrink-0');
    expect(end.className).toContain('min-h-[48px]');
    expect(end.className).toContain('min-w-[48px]');
    expect(end.className).toContain('focus-visible:');
    expect(end.className).toContain('active:');
    expect(end.className).toContain('bg-(--pos-s-sel-bg)');
    expect(end.className).toContain('text-(--pos-s-sel-fg)');
  });
  it.each(['code', 'expired', 'offline', 'error', 'staff_required', 'sign_in_again'] as const)('renders the %s code screen', view => {
    document.documentElement.className = theme;
    const cancel = vi.fn();
    render(<SupportCodeScreen view={view} code={issued} remainingMs={view === 'expired' ? 0 : 600_000}
      busy={false} onRetry={vi.fn()} onCancel={cancel} />);
    expect(screen.getByRole('heading', { name: 'support.connect.action' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'support.code.cancel' })); expect(cancel).toHaveBeenCalledOnce();
    if (view === 'code') {
      expect(screen.getByText('ABCD-EFGH')).toBeVisible();
      expect(screen.getByRole('img', { name: 'support.code.qr' }).tagName.toLowerCase()).toBe('svg');
      expect(screen.getByRole('img').querySelector('path')?.getAttribute('d')).toMatch(/^M/);
      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByText('Counter')).toBeVisible();
      expect(screen.getByRole('timer')).toHaveTextContent('10:00');
      expect(screen.getByText('support.code.warning')).toBeVisible();
    } else {
      expect(screen.queryByText('ABCD-EFGH')).toBeNull();
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByRole('button', { name: 'support.code.newCode' })).toBeVisible();
      expect(screen.getByText(({ error: 'support.code.retry', offline: 'support.code.needsInternet', expired: 'support.code.expired',
        staff_required: 'support.staff.required', sign_in_again: 'support.staff.signInAgain' })[view])).toBeVisible();
    }
  });
});

it('offers extension at ten minutes and shows the no-PIN promise and write outcome', () => {
  const extend = vi.fn();
  render(<SupportBannerView snapshot={{ ...snapshot, write_outcome: 'rolled_back' }} onEnd={vi.fn()} onExtend={extend} />);
  fireEvent.click(screen.getByRole('button', { name: 'support.banner.extend' })); expect(extend).toHaveBeenCalledOnce();
  expect(screen.getByText('support.banner.endDuringWrite.rolledBack')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  expect(screen.getByText('support.banner.noPinPromise')).toBeVisible();
});
it.each([false, true])('uses native extend_allowed=%s and displays the native activity in the banner', extend_allowed => {
  const view = render(<SupportBannerView snapshot={{ ...snapshot, current_activity_key: 'till_printers', extend_allowed }} onEnd={vi.fn()} onExtend={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'support.banner.extend' }) !== null).toBe(extend_allowed);
  expect(screen.getByText('sync.system.printers')).toBeInTheDocument();
  expect(screen.queryByText('till_printers')).toBeNull();
  view.rerender(<SupportBannerView snapshot={{ ...snapshot, current_activity_key: 'till_sync_queue', extend_allowed }} onEnd={vi.fn()} onExtend={vi.fn()} />);
  expect(screen.getByText('support.evidence.pendingQueue')).toBeInTheDocument();
  expect(screen.queryByText('sync.system.printers')).toBeNull();
});
it('hides the ended banner after ten seconds', () => {
  vi.useFakeTimers();
  render(<SupportBannerView snapshot={{ ...snapshot, state: 'ended' }} onEnd={vi.fn()} onExtend={vi.fn()} />);
  act(() => { vi.advanceTimersByTime(9999); }); expect(screen.getByText('support.banner.ended')).toBeVisible();
  act(() => { vi.advanceTimersByTime(1); }); expect(screen.queryByTestId('support-banner')).toBeNull();
});
it('hides an unavailable or unsupported action and explains a missing permission', () => {
  mocks.session = controller({ availability: null });
  const { rerender } = render(<SupportConnectAction />);
  expect(screen.queryByTestId('support-connect-action')).toBeNull();
  mocks.session = controller({ availability: snapshot.availability ? { ...snapshot.availability, min_protocol_version: 999 } : null });
  rerender(<SupportConnectAction />); expect(screen.queryByTestId('support-connect-action')).toBeNull();
  mocks.session = controller({ can_connect: false }); rerender(<SupportConnectAction />);
  expect(screen.getByRole('button', { name: 'support.connect.action' })).toBeDisabled();
  expect(screen.getByText('support.connect.permissionDisabled')).toBeVisible();
});
it('keeps End in a body portal above checkout and reports document visibility to native', () => {
  mocks.session = controller(); mocks.ipc.mockResolvedValue({});
  render(<SupportSessionProvider><SupportBanner /></SupportSessionProvider>);
  expect(document.querySelector('[data-support-banner-host]')?.parentElement).toBe(document.body);
  expect(mocks.ipc).toHaveBeenCalledWith('support_banner_state', { visible: true });
  fireEvent.click(screen.getByRole('button', { name: 'support.banner.end' }));
  expect(mocks.session.end).toHaveBeenCalledOnce();
});
describe.each(['light', 'dark'])('support actor picker in %s theme', theme => {
  it.each([['consent', 'support.staff.pickConsent'], ['request', 'support.staff.pickRequest']] as const)('asks who acts for %s with one tap per person', (purpose, title) => {
    document.documentElement.className = theme;
    const choose = vi.fn(), cancel = vi.fn();
    mocks.session = controller({ state: null }, { view: 'pick', actorPurpose: purpose, actors: [maria, nikos], choose, cancel });
    render(<SupportConnectAction />);
    expect(screen.getByRole('heading', { name: title })).toBeVisible();
    const names = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(names).toEqual(['Μαρίαadmin', 'Νίκοςcashier']);
    for (const button of [screen.getByRole('button', { name: /Μαρία/ }), screen.getByRole('button', { name: /Νίκος/ })]) {
      expect(button.className).toContain('min-h-[48px]');
      expect(button.className).toContain('focus-visible:');
      expect(button.className).not.toContain('hover:');
    }
    fireEvent.click(screen.getByRole('button', { name: /Νίκος/ }));
    expect(choose).toHaveBeenCalledWith(nikos.staff_id);
    fireEvent.click(screen.getByRole('button', { name: 'support.code.cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});
it('shows the role for a person without a name, never a blank button', () => {
  mocks.session = controller({ state: null }, { view: 'pick', actorPurpose: 'request', actors: [{ ...nikos, name: ' ' }, maria] });
  render(<SupportConnectAction />);
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(/^cashier$/);
});
it('leaves the extend step to the banner and shows it there above End', () => {
  const choose = vi.fn(), dismiss = vi.fn();
  mocks.session = controller({}, { view: 'pick', actorPurpose: 'extend', actors: [maria, nikos], choose, dismiss });
  mocks.ipc.mockResolvedValue({});
  const health = render(<SupportConnectAction />);
  expect(screen.queryByTestId('support-actor-picker')).toBeNull();
  health.unmount();
  render(<SupportSessionProvider><SupportBanner /></SupportSessionProvider>);
  expect(screen.getByTestId('support-extend-step')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'support.staff.pickRequest' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Μαρία/ }));
  expect(choose).toHaveBeenCalledWith(maria.staff_id);
  fireEvent.click(screen.getByRole('button', { name: 'support.code.cancel' }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'support.banner.end' })).toBeEnabled();
});
it('lets someone on shift renew their sign-in from the banner with their PIN, and nothing else', async () => {
  const renew = vi.fn().mockResolvedValue('renewed');
  mocks.session = controller({}, { view: 'sign_in_again', actorPurpose: 'extend', renewable: [{ staff_id: maria.staff_id, name: 'Μαρία' }], renew });
  mocks.ipc.mockResolvedValue({});
  render(<SupportSessionProvider><SupportBanner /></SupportSessionProvider>);
  expect(screen.getByRole('heading', { name: 'support.staff.renewTitle' })).toBeVisible();
  expect(screen.getByText('support.staff.renewKeepsShift')).toBeVisible();
  await act(async () => { fireEvent.submit(screen.getByLabelText('support.staff.renewPin').closest('form')!); });
  expect(renew).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'support.staff.renew' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('support.staff.renewPin'), { target: { value: '12a34' } });
  expect(screen.getByLabelText('support.staff.renewPin')).toHaveValue('1234');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'support.staff.renew' })); });
  expect(renew).toHaveBeenCalledWith(maria.staff_id, '1234');
  expect(screen.getByLabelText('support.staff.renewPin')).toHaveValue('');
});
it.each([['refused', 'support.staff.renewRefused'], ['offline', 'support.staff.renewOffline'], ['error', 'support.code.retry']] as const)('explains a %s renewal and lets the person choose again', async (outcome, message) => {
  const renew = vi.fn().mockResolvedValue(outcome);
  mocks.session = controller({}, { view: 'sign_in_again', renewable: [{ staff_id: maria.staff_id, name: 'Μαρία' }, { staff_id: nikos.staff_id, name: '' }], renew });
  mocks.ipc.mockResolvedValue({});
  render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
  // An empty name reads as someone on shift; names are shown as given.
  fireEvent.click(screen.getByRole('button', { name: 'support.staff.onShift' }));
  fireEvent.change(screen.getByLabelText('support.staff.renewPin'), { target: { value: '9876' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'support.staff.renew' })); });
  expect(renew).toHaveBeenCalledWith(nikos.staff_id, '9876');
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  fireEvent.click(screen.getByRole('button', { name: 'support.staff.renewSomeoneElse' }));
  expect(screen.getByRole('button', { name: 'Μαρία' })).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('offers no renewal when nobody on shift here can renew', () => {
  mocks.session = controller({}, { view: 'sign_in_again' });
  mocks.ipc.mockResolvedValue({});
  render(<SupportSessionProvider><SupportConnectAction /></SupportSessionProvider>);
  expect(screen.queryByTestId('support-renew')).toBeNull();
});
it.each([['staff_required', 'support.staff.required'], ['sign_in_again', 'support.staff.signInAgain']] as const)('explains a refused extend (%s) in the banner', (view, message) => {
  const dismiss = vi.fn();
  mocks.session = controller({}, { view, actorPurpose: 'extend', dismiss });
  mocks.ipc.mockResolvedValue({});
  render(<SupportSessionProvider><SupportBanner /></SupportSessionProvider>);
  expect(screen.getByText(message)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'support.code.cancel' }));
  expect(dismiss).toHaveBeenCalledOnce();
});
