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

import CallerIdSection, { callerIdErrorCode } from '../CallerIdSection';

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
    // Wave 7Δ2b: plain words on screen; the raw text only in the collapsed support details.
    expect(screen.getByRole('alert')).toHaveTextContent('Local Caller ID status is unavailable. Refresh to check again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Local status unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Support details' }));
    expect(screen.getByTestId('caller-id-support-details')).toHaveTextContent('Local status unavailable');
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
    expect(screen.getByRole('alert')).toHaveTextContent('Local Caller ID status is unavailable. Refresh to check again.');
    fireEvent.click(screen.getByRole('button', { name: 'Support details' }));
    expect(screen.getByTestId('caller-id-support-details')).toHaveTextContent('Status read failed');
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(notices.success).not.toHaveBeenCalled();
  });
});

describe('Caller ID without the store entitlement (wave 7Δ2b)', () => {
  const entitlementError = 'Caller ID is not active (HTTP 403): {"error":"Caller ID is not active","code":"CALLER_ID_ENTITLEMENT_REQUIRED"}';
  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue({ status: 'error', error: 'Caller ID configuration is unavailable', reason: 'auth_failed', callsDetected: 0 });
    startRuntime.mockResolvedValue({ status: 'starting' });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('reads the code only from the JSON body', () => {
    expect(callerIdErrorCode(entitlementError)).toBe('CALLER_ID_ENTITLEMENT_REQUIRED');
    expect(callerIdErrorCode('Caller ID is not active (HTTP 403): {"error":"CALLER_ID_ENTITLEMENT_REQUIRED","code":{"forged":true}}')).toBeNull();
    expect(callerIdErrorCode('CALLER_ID_ENTITLEMENT_REQUIRED')).toBeNull();
    expect(callerIdErrorCode('HTTP 500: {not json')).toBeNull();
    expect(callerIdErrorCode(null)).toBeNull();
  });

  it('shows one calm notice and a neutral status; steps and raw text stay out of sight', async () => {
    getConfig.mockRejectedValue(new Error(entitlementError));
    render(<CallerIdSection />);
    expect(await screen.findByText('Caller ID is not active for this store. It is turned on from the Admin Dashboard.')).toBeVisible();
    expect(screen.getByText('Not active').closest('.pos-status')).toHaveClass('pos-status--idle');
    expect(screen.queryByText('error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Step 2 · FXO line details')).toBeNull();
    expect(screen.queryByText('Step 3 · Verify reception')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
    expect(screen.queryByText(/HTTP 403/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Support details' }));
    const details = screen.getByTestId('caller-id-support-details');
    expect(details).toHaveTextContent('CALLER_ID_ENTITLEMENT_REQUIRED');
    expect(details).toHaveTextContent('Caller ID configuration is unavailable');
  });

  it('a real error while entitled still shows, in plain words, with the raw text in the details', async () => {
    getConfig.mockRejectedValue(new Error('Request failed (HTTP 500): {"error":"boom","code":"INTERNAL"}'));
    render(<CallerIdSection />);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent).join(' ')).toContain('The Caller ID setup could not be loaded from the Admin Dashboard.');
    expect(alerts.map((alert) => alert.textContent).join(' ')).toContain('Caller ID did not start on this till.');
    expect(alerts.map((alert) => alert.textContent).join(' ')).not.toContain('HTTP 500');
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Support details' }));
    expect(screen.getByTestId('caller-id-support-details')).toHaveTextContent('HTTP 500');
    expect(screen.getByTestId('caller-id-support-details')).toHaveTextContent('reason: auth_failed');
  });

  it('a forged code object is not the entitlement state', async () => {
    getConfig.mockRejectedValue(new Error('Caller ID is not active (HTTP 403): {"error":"CALLER_ID_ENTITLEMENT_REQUIRED","code":{"forged":true}}'));
    render(<CallerIdSection />);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Caller ID is not active for this store. It is turned on from the Admin Dashboard.')).toBeNull();
  });
});
