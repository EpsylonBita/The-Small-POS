import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportInteractionHost } from '../SupportOnsiteSheet';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>(),
  snapshot: { session_id: 'your-session', state: 'connected', critical_op_active: false, can_connect: true, staff: { staff_id: 'your-staff' } } }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
  mocks.handlers.set(name, receive); return () => { mocks.handlers.delete(name); };
}) }));
vi.mock('../../../hooks/useSupportSession', () => ({ useSupportSession: () => ({ snapshot: mocks.snapshot }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const request = { request_id: 'your-request', session_id: 'your-session', title: 'Shipped action', description: 'Shipped explanation', technical_details: '{}', needs_staff_pin: false, remaining_ms: 300000 };
async function receive(next = request) { await act(async () => { mocks.handlers.get('support://onsite-request')?.({ payload: next }); }); }
beforeEach(() => {
  vi.useFakeTimers(); mocks.snapshot.state = 'connected'; mocks.snapshot.critical_op_active = false; mocks.snapshot.can_connect = true;
  mocks.invoke.mockResolvedValue({ accepted: true });
  mocks.authorize.mockImplementation(({ action }: { action(): Promise<unknown> }) => action());
});
afterEach(() => { cleanup(); mocks.handlers.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
describe.each(['light', 'dark'])('native support host in %s', theme => {
  it('shows, executes and closes a confirmed request', async () => {
    document.documentElement.className = theme; render(<SupportInteractionHost />); await receive();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'shown' }));
    act(() => vi.advanceTimersByTime(2000)); await act(async () => fireEvent.click(screen.getByText('support.onsite.execute')));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'confirmed', staff_ref: { staff_id: 'your-staff' } }));
  });
  it('closes an immediate authorized decline', async () => {
    render(<SupportInteractionHost />); await receive();
    await act(async () => fireEvent.click(screen.getByText('support.onsite.decline')));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows executing then a retryable failure when native refuses the decision', async () => {
    render(<SupportInteractionHost />); await receive();
    let reject: ((error: Error) => void) | undefined;
    mocks.invoke.mockImplementation(() => new Promise((_resolve, refuse) => { reject = refuse; }));
    act(() => vi.advanceTimersByTime(2000)); fireEvent.click(screen.getByText('support.onsite.execute'));
    expect(screen.getByText('support.banner.executing')).toBeVisible();
    await act(async () => reject?.(new Error('POLICY_REFUSED')));
    expect(screen.getByRole('alert')).toHaveTextContent('support.code.retry');
    expect(screen.getByText('support.onsite.decline')).toBeEnabled();
  });
  it('hides the sheet immediately for a checkout dialog and re-arms it afterwards', async () => {
    render(<SupportInteractionHost />); await receive(); act(() => vi.advanceTimersByTime(2000));
    const checkout = document.createElement('div'); checkout.setAttribute('role', 'dialog'); checkout.textContent = 'Checkout';
    await act(async () => { document.body.append(checkout); });
    expect(screen.queryByTestId('support-onsite-sheet')).toBeNull(); expect(screen.getByTestId('support-onsite-chip')).toBeVisible();
    await act(async () => checkout.remove()); expect(screen.getByText('support.onsite.execute')).toBeDisabled();
  });
  it('closes on timeout even when native reports its authoritative timeout as an error', async () => {
    render(<SupportInteractionHost />); await receive({ ...request, remaining_ms: 2000 });
    mocks.invoke.mockRejectedValue(new Error('ONSITE_TIMEOUT'));
    await act(async () => vi.advanceTimersByTime(2000)); expect(screen.queryByTestId('support-onsite-sheet')).toBeNull();
  });
  it('clears pending work when End terminates the session', async () => {
    const view = render(<SupportInteractionHost />); await receive(); mocks.snapshot.state = 'ended';
    view.rerender(<SupportInteractionHost />); expect(screen.queryByTestId('support-onsite-sheet')).toBeNull();
  });
  it('ignores foreign sessions and non-catalogued physical requests', async () => {
    render(<SupportInteractionHost />); await receive({ ...request, session_id: 'your-other-session' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => mocks.handlers.get('support://onsite-request')?.({ payload: { ...request, check_id: 'operator_free_text' } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

it('runs the store PIN flow for a typed device apply after the on-site tap', async () => {
  render(<SupportInteractionHost />);
  await receive({ ...request, needs_staff_pin: true, technical_details: JSON.stringify({ device_kind: 'printer', settings: { name: 'Your printer' } }) });
  expect(mocks.authorize).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(2000));
  await act(async () => fireEvent.click(screen.getByText('support.onsite.execute')));
  expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'system_control', subtitle: 'support.onsite.storePinNotice' }));
  expect(mocks.invoke).toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'confirmed' }));
});
it('keeps a device apply unsaved when support-connect staff lack the manual setting right', async () => {
  mocks.authorize.mockRejectedValue(new Error('UNAUTHORIZED'));
  render(<SupportInteractionHost />);
  await receive({ ...request, needs_staff_pin: true, technical_details: JSON.stringify({ device_kind: 'card_terminal' }) });
  act(() => vi.advanceTimersByTime(2000));
  await act(async () => fireEvent.click(screen.getByText('support.onsite.execute')));
  expect(mocks.invoke).not.toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'confirmed' }));
  expect(screen.getByRole('alert')).toHaveTextContent('support.code.retry');
});
