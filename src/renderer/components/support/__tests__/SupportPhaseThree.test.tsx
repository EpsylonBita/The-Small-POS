import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportInteractionHost, SupportOnsiteSheet, TierThreeOnsiteRequestSchema } from '../SupportOnsiteSheet';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>(),
  snapshot: { session_id: 'your-session', state: 'connected', critical_op_active: false, can_connect: true, staff: null } }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
  mocks.handlers.set(name, receive); return () => { mocks.handlers.delete(name); };
}) }));
vi.mock('../../../hooks/useSupportSession', () => ({ useSupportSession: () => ({ snapshot: mocks.snapshot }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const request = TierThreeOnsiteRequestSchema.parse({ request_id: 'your-request', session_id: 'your-session', title: 'Unapproved title', description: 'Unapproved description',
  technical_details: 'Exact SQL and target', needs_staff_pin: false, remaining_ms: 300000,
  breakglass: { statement_kind: 'UPDATE', rows: [{ table: 'catalog_cache', inserted: 0, updated: 4, deleted: 0 }],
    explanation_text: '<a href="https://example.invalid">Plain explanation</a>\n**No markup**' } });
const restoreRequest = TierThreeOnsiteRequestSchema.parse({ ...request,
  breakglass: { ...request.breakglass, statement_kind: 'RESTORE', restore_target: 'snapshot' } });
beforeEach(() => {
  vi.useFakeTimers(); mocks.snapshot.state = 'connected'; mocks.snapshot.critical_op_active = false; mocks.snapshot.can_connect = true;
  mocks.invoke.mockResolvedValue({ accepted: true });
  mocks.authorize.mockImplementation(({ action }: { action(): Promise<unknown> }) => action());
});
afterEach(() => { cleanup(); mocks.handlers.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
async function receive(value: unknown) { await act(async () => { mocks.handlers.get('support://onsite-request')?.({ payload: value }); }); }
describe.each(['light', 'dark'])('Phase three on-site sheet in %s', theme => {
  it('uses native facts and approved plain text, with snapshot first and expandable exact payload', () => {
    document.documentElement.className = theme;
    render(<SupportOnsiteSheet request={request} deferred={false} canConfirm onDecision={vi.fn()} onShown={vi.fn()} />);
    expect(screen.getByText('UPDATE')).toBeVisible(); expect(screen.getByText('catalog_cache: 4')).toBeVisible();
    expect(screen.getByText('support.restore.snapshotFirst')).toBeVisible();
    expect(screen.getByText('support.onsite.aiExplanation')).toBeVisible();
    expect(screen.getByText(/Plain explanation/)).toHaveTextContent('<a href="https://example.invalid">Plain explanation</a>');
    expect(document.querySelector('a, input, textarea')).toBeNull();
    expect(screen.queryByText('Unapproved description')).toBeNull(); expect(screen.queryByText('Unapproved title')).toBeNull();
    expect(screen.queryByText('Exact SQL and target')).toBeNull();
    fireEvent.click(screen.getByText('support.onsite.technicalDetails')); expect(screen.getByText('Exact SQL and target')).toBeVisible();
    const run = screen.getByText('support.onsite.execute'); expect(run).toBeDisabled();
    act(() => vi.advanceTimersByTime(2000)); expect(run).toBeEnabled(); expect(run.className).toContain('--pos-s-sel-bg');
  });
  it('keeps a restore deferred during critical work, then requires the full two-second tap fence and states restart', () => {
    const decide = vi.fn(), props = { request: restoreRequest, canConfirm: true, onShown: vi.fn(), onDecision: decide };
    const view = render(<SupportOnsiteSheet {...props} deferred />);
    act(() => vi.advanceTimersByTime(3000)); expect(screen.queryByRole('dialog')).toBeNull(); expect(decide).not.toHaveBeenCalled();
    view.rerender(<SupportOnsiteSheet {...props} deferred={false} />);
    expect(screen.getByText('support.banner.restoreRestarting')).toBeVisible(); expect(screen.getByText('support.onsite.storePinNotice')).toBeVisible();
    expect(screen.getByText('support.onsite.execute')).toBeDisabled(); act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByText('support.onsite.execute')); expect(decide).toHaveBeenCalledWith('confirmed');
  });
  it('preserves the tier-three event fields and asks the manual app guard only after the restore tap', async () => {
    render(<SupportInteractionHost />); await receive(restoreRequest);
    expect(screen.getByText('support.onsite.aiExplanation')).toBeVisible(); expect(mocks.authorize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000)); await act(async () => fireEvent.click(screen.getByText('support.onsite.execute')));
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'system_control', subtitle: 'support.onsite.storePinNotice' }));
    expect(mocks.invoke).toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'confirmed' }));
    // Native checks the till's own right; the banner names nobody, so no staff_ref is sent.
    expect(mocks.invoke.mock.calls.every(([, payload]) => !('staff_ref' in (payload ?? {})))).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('refuses a support-connect-only restore when the manual authorization refuses it', async () => {
    mocks.authorize.mockRejectedValue(new Error('FORBIDDEN'));
    render(<SupportInteractionHost />); await receive(restoreRequest); act(() => vi.advanceTimersByTime(2000));
    await act(async () => fireEvent.click(screen.getByText('support.onsite.execute')));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(mocks.invoke).not.toHaveBeenCalledWith('support_onsite_decision', expect.objectContaining({ decision: 'confirmed' }));
  });
  it('does not ask manual authorization for decline or imply restart for quarantine-group undo', async () => {
    render(<SupportInteractionHost />); await receive({ ...restoreRequest, breakglass: { ...restoreRequest.breakglass, restore_target: 'quarantine_group' } });
    expect(screen.queryByText('support.banner.restoreRestarting')).toBeNull();
    await act(async () => fireEvent.click(screen.getByText('support.onsite.decline'))); expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
it('accepts exactly 600 approved characters and rejects longer, malformed or incomplete restore facts', () => {
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, breakglass: { ...request.breakglass, explanation_text: 'x'.repeat(600) } }).success).toBe(true);
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, breakglass: { ...request.breakglass, explanation_text: 'x'.repeat(601) } }).success).toBe(false);
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, breakglass: { ...request.breakglass, statement_kind: 'SHELL' } }).success).toBe(false);
  expect(TierThreeOnsiteRequestSchema.safeParse({ ...request, breakglass: { ...request.breakglass, statement_kind: 'RESTORE' } }).success).toBe(false);
});
