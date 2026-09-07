import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfig, getStatus, notices, translation } = vi.hoisted(() => ({
  getConfig: vi.fn(), getStatus: vi.fn(), notices: { success: vi.fn(), error: vi.fn() },
  translation: { t: (key: string, fallback?: string) => fallback ?? key },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
vi.mock('react-hot-toast', () => ({ toast: notices }));
vi.mock('../../../services/CallerIdService', () => ({ callerIdGetServerConfig: getConfig, callerIdGetStatus: getStatus }));
vi.mock('../CallerIdNetworkAccessCard', () => ({ default: () => null }));

import CallerIdSection from '../CallerIdSection';

describe('Caller ID status truthfulness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ enabled: true, sourceLines: [], receivingLines: [] });
    getStatus.mockResolvedValue({ status: 'listening', callsDetected: 7 });
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
