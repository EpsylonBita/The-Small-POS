import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportDetailsPanel } from '../SupportDetailsPanel';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn(), critical: false, canConnect: true, modal: null as unknown }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('../../../hooks/useSupportSession', () => ({ useSupportSession: () => ({ snapshot: { can_connect: mocks.canConnect, critical_op_active: mocks.critical } }) }));
vi.mock('../../../hooks/usePrivilegedActionConfirmation', () => ({ usePrivilegedActionConfirmation: () => ({ runWithPrivilegedConfirmation: mocks.authorize, confirmationModal: mocks.modal }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const apply = { id: 'your-apply', session_id: 'your-session', device_id: 'your-printer', state: 'pending', undo_available: true };
beforeEach(() => {
  mocks.canConnect = true; mocks.critical = false; mocks.modal = null;
  mocks.invoke.mockImplementation(async (command, input) => {
    if (command === 'support_list_snapshots') { return { snapshots: [] }; }
    if (command === 'support_list_quarantine') { return { groups: [] }; }
    return input.action === 'list' ? { applies: [apply] } : { success: true };
  });
  mocks.authorize.mockImplementation(({ action }: { action(): Promise<unknown> }) => action());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('mounts inside the rendered Health support details instead of an unused legacy section', () => {
  const source = readFileSync('src/renderer/components/SyncStatusIndicator.tsx', 'utf8');
  const [legacy, rendered] = source.split('const renderDetailModal =');
  expect(legacy).not.toContain('<SupportDetailsPanel'); expect(rendered).toContain('<SupportDetailsPanel active={supportActionsOpen} />');
});
// Founder, 04/11/2026: «δεν καταλαβαίνω γιατί υπάρχει αυτή η μπάρα». The list shows only what can be
// undone or restored, under a title that says so, read as the support section opens.
it('shows nothing on a normal till: no bar, no toggle', async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === 'support_list_snapshots' ? { snapshots: [] }
    : command === 'support_list_quarantine' ? { groups: [] } : { applies: [{ ...apply, undo_available: false }] });
  // Hidden, it renders nothing, not even the closed confirmation modal, which needs the app's
  // i18n provider (#416 CI: the Health view's tests render without it).
  mocks.modal = <div data-testid="confirmation-modal" />;
  const { rerender } = render(<SupportDetailsPanel />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('support_list_quarantine'));
  expect(screen.queryByTestId('support-details-panel')).toBeNull();
  expect(screen.queryByText('support.onsite.technicalDetails')).toBeNull();
  expect(screen.queryByTestId('confirmation-modal')).toBeNull();
  mocks.canConnect = false; rerender(<SupportDetailsPanel />);
  expect(screen.queryByTestId('confirmation-modal')).toBeNull();
});
it('lists an undoable support change under its own title as the section opens, and waits while it is closed', async () => {
  const { rerender } = render(<SupportDetailsPanel active={false} />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  rerender(<SupportDetailsPanel active />);
  expect(await screen.findByText('support.restore.changesTitle')).toBeVisible();
  expect(screen.getByText('support.deviceApply.undo')).toBeVisible();
});
describe.each(['light', 'dark'])('device Undo in %s', theme => {
  async function open() { document.documentElement.className = theme; const result = render(<SupportDetailsPanel />); await screen.findByText('support.deviceApply.undo'); return result; }
  it('shows undo inside details and uses the existing system-control app guard and store-PIN notice', async () => {
    await open(); fireEvent.click(screen.getByText('support.deviceApply.undo'));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('support_undo_device_apply', { action: 'undo', apply_id: apply.id, session_id: apply.session_id }));
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: 'system_control', subtitle: 'support.onsite.storePinNotice' }));
  });
  it('does not use support permission to authorize Undo', async () => {
    mocks.authorize.mockRejectedValue(new Error('FORBIDDEN'));
    await open(); fireEvent.click(screen.getByText('support.deviceApply.undo')); await screen.findByRole('alert');
    expect(mocks.invoke).not.toHaveBeenCalledWith('support_undo_device_apply', expect.objectContaining({ action: 'undo' }));
  });
  it('prevents Undo while checkout is active and prevents double taps', async () => {
    mocks.critical = true; const view = await open(); expect(screen.getByText('support.deviceApply.undo')).toBeDisabled();
    mocks.critical = false; view.rerender(<SupportDetailsPanel />);
    let resolve: ((value: { success: boolean }) => void) | undefined;
    mocks.authorize.mockImplementation(() => new Promise(done => { resolve = done; }));
    const button = screen.getByText('support.deviceApply.undo'); fireEvent.click(button); fireEvent.click(button);
    expect(mocks.authorize).toHaveBeenCalledOnce(); await act(async () => { resolve?.({ success: true }); });
  });
  it('keeps native refusal visible without treating it as a successful Undo', async () => {
    mocks.authorize.mockResolvedValue({ success: false }); await open(); fireEvent.click(screen.getByText('support.deviceApply.undo')); await screen.findByRole('alert');
  });
});

it('rechecks checkout and session state when privileged confirmation completes', async () => {
  let action: (() => Promise<unknown>) | undefined;
  mocks.authorize.mockImplementation((request: { action(): Promise<unknown> }) => { action = request.action; return Promise.resolve({ success: true }); });
  const view = render(<SupportDetailsPanel />);
 
  fireEvent.click(await screen.findByText('support.deviceApply.undo'));
  mocks.critical = true; view.rerender(<SupportDetailsPanel />);
  await expect(action?.()).rejects.toThrow('Undo no longer authorized');
  expect(mocks.invoke).not.toHaveBeenCalledWith('support_undo_device_apply', expect.objectContaining({ action: 'undo' }));
});
it('ships the Undo label in every locale including Greek', () => {
  for (const locale of ['el', 'en', 'de', 'fr', 'it', 'sq']) {
    const messages = JSON.parse(readFileSync(`src/locales/support/${locale}.json`, 'utf8')) as { deviceApply: { undo: string } };
    expect(messages.deviceApply.undo.length).toBeGreaterThan(0);
    if (locale === 'el') { expect(messages.deviceApply.undo).toBe('\u0391\u03bd\u03b1\u03af\u03c1\u03b5\u03c3\u03b7'); }
  }
});
