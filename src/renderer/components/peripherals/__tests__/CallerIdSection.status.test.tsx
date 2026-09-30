import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfig, getStatus, startRuntime, notices, translation } = vi.hoisted(() => ({
  getConfig: vi.fn(), getStatus: vi.fn(), startRuntime: vi.fn(), notices: { success: vi.fn(), error: vi.fn() },
  translation: { t: (key: string, fallback?: string) => fallback ?? key },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('react-hot-toast', () => ({ toast: notices }));
vi.mock('../../../services/CallerIdService', () => ({
  callerIdGetServerConfig: getConfig, callerIdGetStatus: getStatus, callerIdStart: startRuntime,
}));
vi.mock('../CallerIdNetworkAccessCard', () => ({ default: () => null }));

import CallerIdSection from '../CallerIdSection';

describe('Caller ID status truthfulness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ enabled: true, sourceLines: [], receivingLines: [] });
    getStatus.mockResolvedValue({ status: 'listening', callsDetected: 7 });
    startRuntime.mockResolvedValue({ status: 'starting' });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('clears stale listening status when only the local manual refresh fails', async () => {
    render(<CallerIdSection />);
    await screen.findByText('The local FXO listener is running and waiting for incoming calls.');
    getStatus.mockRejectedValueOnce(new Error('Local status unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('Unavailable');
    expect(screen.queryByText('The local FXO listener is running and waiting for incoming calls.')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Local status unavailable');
    expect(notices.error).toHaveBeenCalledWith('Could not refresh Caller ID status. Check the details below.');
    expect(screen.queryByText('Could not load the central Caller ID configuration.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('The local FXO listener is running and waiting for incoming calls.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('re-checks activation only when the operator presses refresh', async () => {
    vi.useFakeTimers();
    render(<CallerIdSection />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Opening the screen shows the server projection once; the periodic
    // refresh reads only the local listener status.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(startRuntime).not.toHaveBeenCalled();
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(12);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(startRuntime).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(startRuntime.mock.invocationCallOrder[0]).toBeLessThan(getConfig.mock.invocationCallOrder[1]);
  });

  it('still refreshes status when the native restart is unavailable', async () => {
    startRuntime.mockRejectedValueOnce(new Error('IPC unavailable'));
    render(<CallerIdSection />);
    await screen.findByText('The local FXO listener is running and waiting for incoming calls.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith('Caller ID status refreshed.'));
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('marks status unavailable on poll failure without changing server configuration', async () => {
    vi.useFakeTimers();
    render(<CallerIdSection />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    getStatus.mockRejectedValueOnce(new Error('Status read failed'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Status read failed');
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
  });
});
