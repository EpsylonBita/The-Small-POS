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
  staff: { staff_id: '50000000-0000-4000-a000-000000000005', base_role: 'admin' },
  extend_allowed: true, critical_op_active: false, write_outcome: null,
};
const issued = issueFixture.response;
function controller(next: Partial<SupportBannerSnapshot> = {}): SupportSessionController {
  return { snapshot: { ...snapshot, ...next }, view: 'closed', code: null, consent: null, busy: false, remainingMs: 0,
    start: vi.fn(), cancel: vi.fn(), accept: vi.fn(), decline: vi.fn(), end: vi.fn(), extend: vi.fn() };
}
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
  it.each(['code', 'expired', 'offline', 'error'] as const)('renders the %s code screen', view => {
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
      expect(screen.getByText(`support.code.${view === 'error' ? 'retry' : view === 'offline' ? 'needsInternet' : 'expired'}`)).toBeVisible();
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
