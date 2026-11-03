import React from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportRestoreNotice } from '../SupportRestoreNotice';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (value: unknown) => void>() }));
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mocks.invoke }) }));
vi.mock('../../../services/support/SupportRemedyRunner', () => ({ listenSupportEvent: (name: string, receive: (value: unknown) => void) => {
  mocks.handlers.set(name, receive); return () => { mocks.handlers.delete(name); };
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockResolvedValue({ restore_lease_held: false }); });
afterEach(() => { cleanup(); mocks.handlers.clear(); vi.clearAllMocks(); vi.useRealTimers(); });
async function lease(value: unknown) { await act(async () => { mocks.handlers.get('support://restore-lease')?.(value); }); }
function Till() {
  return <SupportRestoreNotice><button type="button">Checkout</button>{createPortal(<div data-testid="payment-portal"><button type="button">Payment</button></div>, document.body)}</SupportRestoreNotice>;
}
describe.each(['light', 'dark'])('restore lease notice in %s', theme => {
  it('leaves ordinary sales enabled without a lease, regardless of ordinary support state', async () => {
    document.documentElement.className = theme; mocks.invoke.mockResolvedValue({ state: 'executing', critical_op_active: true, restore_lease_held: false });
    render(<Till />); await act(async () => {});
    expect(screen.getByText('Checkout')).toBeEnabled(); expect(screen.queryByTestId('support-restore-notice')).toBeNull();
  });
  it('covers the till and disables checkout and portal interaction while the lease is held, then releases on refusal', async () => {
    render(<Till />); await act(async () => {}); await lease({ held: true });
    const notice = screen.getByTestId('support-restore-notice'); expect(notice).toHaveTextContent('support.restore.preparing');
    expect(notice.className).toContain('fixed inset-0'); expect(notice.className).toContain('bg-(--pos-s-surface)');
    expect(screen.getByText('Checkout')).toBeDisabled(); expect(screen.getByTestId('support-business-entry')).toHaveAttribute('inert');
    expect(screen.getByTestId('payment-portal').inert).toBe(true); expect(notice.inert).toBeFalsy();
    await lease({ held: false }); expect(screen.queryByTestId('support-restore-notice')).toBeNull(); expect(screen.getByText('Checkout')).toBeEnabled();
    expect(screen.getByTestId('payment-portal').inert).toBeFalsy();
  });
  it('works without an active support session using the authoritative initial getter', async () => {
    mocks.invoke.mockResolvedValue({ state: null, session_id: null, restore_lease_held: true });
    render(<Till />); await act(async () => {}); expect(screen.getByText('Checkout')).toBeDisabled(); expect(screen.getByRole('status')).toHaveTextContent('support.restore.preparing');
  });
  it('retains the hold on missing or failed IPC and malformed events', async () => {
    render(<Till />); await act(async () => {}); await lease({ held: true }); await lease({ held: 'false' });
    mocks.invoke.mockResolvedValue({ state: 'ended' }); await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Checkout')).toBeDisabled();
    mocks.invoke.mockRejectedValue(new Error('IPC failed')); await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Checkout')).toBeDisabled();
  });
});
it('does not let an older poll reply release a newer lease event', async () => {
  let reply: ((value: { restore_lease_held: boolean }) => void) | undefined;
  mocks.invoke.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
  render(<Till />); await lease({ held: true }); await act(async () => reply?.({ restore_lease_held: false }));
  expect(screen.getByText('Checkout')).toBeDisabled();
});
it('disables new body portals while preserving their existing inert state and the one-tap End banner', async () => {
  render(<Till />); await act(async () => {});
  const preexisting = document.createElement('div'); preexisting.inert = true; document.body.append(preexisting);
  await lease({ held: true });
  const late = document.createElement('div'), banner = document.createElement('div'); banner.setAttribute('data-support-banner-host', '');
  await act(async () => { document.body.append(late, banner); });
  expect(late.inert).toBe(true); expect(banner.inert).toBeFalsy();
  await lease({ held: false }); expect(preexisting.inert).toBe(true); expect(late.inert).toBeFalsy();
  preexisting.remove(); late.remove(); banner.remove();
});
it('mounts the notice around app and on-site entry in the session shell', () => {
  expect(readFileSync('src/renderer/App.tsx', 'utf8')).toContain('<SupportRestoreNotice><AppContent /><SupportInteractionHost /></SupportRestoreNotice>');
});

it.each(['staged', 'applied', 'refused', 'expired', 'rolled_back'])('shows persistent %s guidance without holding checkout', async status => {
  mocks.invoke.mockResolvedValue({ restore_lease_held: false, restore_notice: { id: 'your_notice', status } });
  render(<Till />); await act(async () => {});
  expect(screen.getByTestId('support-restore-outcome')).toHaveTextContent(`support.restore.notices.${status}`);
  expect(screen.getByText('Checkout')).toBeEnabled();
  fireEvent.click(screen.getByText('support.restore.dismissNotice'));
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.queryByTestId('support-restore-outcome')).toBeNull();
  expect(mocks.invoke.mock.calls.every(([command]) => command === 'support_restore_notice')).toBe(true);
});

it.each(['el', 'en', 'de', 'fr', 'it', 'sq'])('ships readable preparation and startup guidance in %s', locale => {
  const value: unknown = JSON.parse(readFileSync(`src/locales/support/${locale}.json`, 'utf8'));
  expect(value).toMatchObject({ restore: { dismissNotice: expect.any(String), notices: {
    staged: expect.any(String), applied: expect.any(String), refused: expect.any(String),
    expired: expect.any(String), rolled_back: expect.any(String),
  } } });
  expect(readFileSync(`src/locales/support/${locale}.json`, 'utf8')).not.toMatch(/\?\?\?/);
});
