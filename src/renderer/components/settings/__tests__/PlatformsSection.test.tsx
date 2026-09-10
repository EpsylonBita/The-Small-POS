import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { posApiGet, posApiPost } = vi.hoisted(() => ({
  posApiGet: vi.fn(),
  posApiPost: vi.fn(),
}));
vi.mock('../../../utils/api-helpers', () => ({ posApiGet, posApiPost }));

// A stable `t` reference: react-i18next's real useTranslation would also be
// stable across renders, and a mock that hands back a brand-new function each
// render can put dependent useCallback/useEffect chains into a render loop.
const translate = (key: string, defaultValueOrOptions?: string | { defaultValue?: string; [k: string]: unknown }) => {
  if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions;
  const template = defaultValueOrOptions?.defaultValue ?? key;
  if (typeof template !== 'string' || !defaultValueOrOptions) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String((defaultValueOrOptions as Record<string, unknown>)[name] ?? ''));
};
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: translate }) };
});

import { PlatformsSection, type Platform } from '../PlatformsSection';

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    plugin_id: 'efood',
    name: 'efood',
    open: true,
    controllable: true,
    accepting_orders: null,
    reason: null,
    checked_at: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => Promise.resolve());
}

describe('PlatformsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(cleanup);

  it('calls the unwrapped platforms contract and renders a real switch reflecting open state', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(posApiGet).toHaveBeenCalledWith('/pos/platforms');
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('shows an empty state when there are no connected platforms', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [] } });
    render(<PlatformsSection />);
    await screen.findByText('No delivery platforms connected');
  });

  it('shows an unsupported platform with a disabled switch and its reason', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: false, open: null, reason: 'unsupported' })] },
    });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeDisabled());
    expect(screen.getByText('This platform cannot be opened or closed from here.')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('offers explicit Open/Close actions for a controllable platform in an unknown state', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: { success: true, platforms: [makePlatform({ controllable: true, open: null, reason: 'outcome_unknown' })] },
    });
    render(<PlatformsSection />);
    await screen.findByRole('button', { name: /Open/ });
    expect(screen.getByRole('button', { name: /Close/ })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows a Wolt-style outside-hours limitation instead of implying it is receiving orders', async () => {
    posApiGet.mockResolvedValue({
      success: true,
      data: {
        success: true,
        platforms: [
          makePlatform({
            plugin_id: 'wolt',
            name: 'Wolt',
            open: true,
            accepting_orders: false,
            reason: 'outside_hours',
          }),
        ],
      },
    });
    render(<PlatformsSection />);
    await screen.findByText('Open');
    expect(screen.getByText('Not receiving orders right now')).toBeInTheDocument();
    expect(screen.getByText('Online, but outside the scheduled ordering hours — not receiving orders.')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a pending state then replaces it with the confirmed response on toggle', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    let resolvePost!: (value: unknown) => void;
    posApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeDisabled();

    await act(async () => resolvePost({
      success: true,
      data: { success: true, platform: makePlatform({ open: true }) },
    }));

    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('switch')).toBeEnabled();
    expect(posApiPost).toHaveBeenCalledWith('/pos/platforms', { plugin_id: 'efood', open: true });
  });

  it('shows Unknown (not the previous open/closed value) and flags uncertainty on a rejected toggle', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    posApiPost.mockResolvedValue({ success: false, error: 'busy' });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(/Could not confirm the result/);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Last known: Open')).toBeInTheDocument();
    expect(screen.queryByText(/^busy$/)).not.toBeInTheDocument();
  });

  it('shows Unknown and flags uncertainty when the toggle request throws, without leaking raw error text', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    posApiPost.mockRejectedValue(new Error('ECONNRESET raw provider failure'));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(/Could not confirm the result/);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Last known: Closed')).toBeInTheDocument();
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
  });

  it('ignores a second rapid click on the same platform instead of firing a duplicate POST', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    let resolvePost!: (value: unknown) => void;
    posApiPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    const switchEl = screen.getByRole('switch');
    fireEvent.click(switchEl);
    fireEvent.click(switchEl);
    fireEvent.click(switchEl);
    expect(posApiPost).toHaveBeenCalledTimes(1);

    await act(async () => resolvePost({ success: true, data: { success: true, platform: makePlatform({ open: true }) } }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows a localized load-failure message and never the raw response body on GET failure', async () => {
    posApiGet.mockResolvedValue({ success: false, error: '<!doctype html>raw upstream failure' });
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText(/raw upstream failure/)).not.toBeInTheDocument();
  });

  it('treats a rejected GET promise as a load failure, not a fake empty success', async () => {
    posApiGet.mockRejectedValue(new Error('network down'));
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText('No delivery platforms connected')).not.toBeInTheDocument();
  });

  it('treats a malformed (non-array) platforms list as a load failure, not an empty success', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: 'not-a-list' } });
    render(<PlatformsSection />);
    await screen.findByText('Could not load platforms');
    expect(screen.queryByText('No delivery platforms connected')).not.toBeInTheDocument();
  });

  it('disables the switch and does not POST while offline', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });

    await waitFor(() => expect(screen.getByRole('switch')).toBeDisabled());
    fireEvent.click(screen.getByRole('switch'));
    await flush();
    expect(posApiPost).not.toHaveBeenCalled();
  });

  it('rechecks status when the browser comes back online', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(1));

    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));
  });

  it('rechecks status on window focus', async () => {
    posApiGet.mockResolvedValue({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    render(<PlatformsSection />);
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(1));

    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));
  });

  it('never lets a slower refresh overwrite a newer, already-confirmed mutation result', async () => {
    let resolveFirstGet!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveFirstGet = resolve; }));
    render(<PlatformsSection />);

    resolveFirstGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));

    let resolveRefreshGet!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise((resolve) => { resolveRefreshGet = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    posApiPost.mockResolvedValue({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    resolveRefreshGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await flush();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps a confirmed toggle visible when an older refresh fails', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch');
    let rejectRefresh!: (error: Error) => void;
    posApiGet.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    await act(async () => { rejectRefresh(new Error('late network failure')); });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Could not load platforms')).not.toBeInTheDocument();
  });

  it('keeps a newer confirmed row omitted by a stale GET but removes it on a fresh acquisition list', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch');
    let resolveRefresh!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    await act(async () => resolveRefresh({ success: true, data: { success: true, platforms: [] } }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText('No delivery platforms connected');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('marks untouched providers unknown when a failed refresh predates another provider toggle', async () => {
    posApiGet.mockResolvedValueOnce({ success: true, data: { success: true, platforms: [
      makePlatform({ open: false }), makePlatform({ plugin_id: 'wolt', name: 'Wolt', open: true }),
    ] } });
    render(<PlatformsSection />);
    await screen.findByRole('switch', { name: 'efood' });
    let resolveRefresh!: (value: unknown) => void;
    posApiGet.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    posApiPost.mockResolvedValueOnce({ success: true, data: { success: true, platform: makePlatform({ open: true }) } });
    fireEvent.click(screen.getByRole('switch', { name: 'efood' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true'));
    await act(async () => resolveRefresh({ success: false }));
    expect(screen.getByRole('switch', { name: 'efood' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('switch', { name: 'Wolt' })).not.toBeInTheDocument();
    expect(screen.getByText('Wolt')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('discards a stale, superseded GET response instead of applying it (refresh-vs-refresh race)', async () => {
    let resolveFirstGet!: (value: unknown) => void;
    let resolveSecondGet!: (value: unknown) => void;
    posApiGet
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstGet = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecondGet = resolve; }));
    render(<PlatformsSection />);

    // Trigger a second GET (refresh) before the first has resolved.
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(posApiGet).toHaveBeenCalledTimes(2));

    // Second (newer) request resolves first, with the true current state.
    resolveSecondGet({ success: true, data: { success: true, platforms: [makePlatform({ open: true })] } });
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));

    // First (older, slower) request resolves after — it must be discarded.
    resolveFirstGet({ success: true, data: { success: true, platforms: [makePlatform({ open: false })] } });
    await flush();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('discards a stale refresh response after unmount without throwing', async () => {
    let resolveGet!: (value: unknown) => void;
    posApiGet.mockReturnValue(new Promise((resolve) => { resolveGet = resolve; }));
    const { unmount } = render(<PlatformsSection />);
    unmount();
    expect(() => resolveGet({ success: true, data: { success: true, platforms: [makePlatform()] } })).not.toThrow();
    await flush();
  });
});
